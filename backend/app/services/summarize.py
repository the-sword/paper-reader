"""AI 总结服务。

支持四种总结类型，各自有独立的 prompt 模板：
  - overview       全文概览（研究问题、方法、结论、贡献）
  - method         方法细节拆解
  - contributions  主要贡献与创新点
  - limitations    局限性、可改进点
  - qa             针对文档自由提问

设计要点：
  - 输入是已解析的 segments（优先正文，跳过公式/图表/参考文献）
  - 长文按 token 预算截断，保留结构（标题优先保留）
  - 结果存 summaries 表，可多次生成并存历史版本
  - 复用 translate 模块的 AI 配置与重试逻辑
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from ..core.db import db
from ..core.http import make_client
from . import translate as ai_mod

# 每种类型的 prompt 模板
TEMPLATES: dict[str, dict[str, str]] = {
    "overview": {
        "label": "全文概览",
        "system": (
            "你是一名资深科研阅读助手。请基于给定的论文内容，输出结构化中文总结。\n"
            "严格按以下 Markdown 格式输出，不要添加额外章节：\n\n"
            "## 研究问题\n用 1-2 句说明这篇论文要解决什么问题。\n\n"
            "## 核心方法\n用 3-5 个要点概括技术路线，可用列表。\n\n"
            "## 主要结果\n列出关键实验数据与结论（有数字要保留数字）。\n\n"
            "## 贡献与意义\n2-3 句说明它的创新点和影响。\n\n"
            "要求：忠于原文，不编造；术语保持原文（如 Transformer、disparity）；"
            "总长度控制在 500 字以内。"
        ),
    },
    "method": {
        "label": "方法拆解",
        "system": (
            "你是一名技术审稿人。请深入拆解这篇论文的方法部分。\n"
            "按以下结构输出中文：\n\n"
            "## 整体架构\n说明系统的输入、输出和主要模块。\n\n"
            "## 关键模块\n逐个说明各模块的作用与实现细节，可用列表。\n\n"
            "## 关键公式\n列出最重要的 1-3 个公式，用 LaTeX 表示，并解释其含义。\n\n"
            "## 实现细节\n训练配置、超参数、数据等关键信息。\n\n"
            "要求：技术细节要准确；不确定的地方标注「原文未明确」。"
        ),
    },
    "contributions": {
        "label": "创新贡献",
        "system": (
            "请提炼这篇论文的创新点和贡献。输出中文，按重要性排序：\n\n"
            "## 核心创新\n1-3 条，每条一句话概括，并说明「相比已有方法新在哪里」。\n\n"
            "## 次要贡献\n其他值得注意的改进。\n\n"
            "## 与基线对比\n列出论文声称超越的方法和幅度。\n\n"
            "要求：区分「论文声称」与「可验证的事实」；不要拔高。"
        ),
    },
    "limitations": {
        "label": "局限分析",
        "system": (
            "请以批判性视角分析这篇论文的局限性。输出中文：\n\n"
            "## 原文承认的局限\n论文自己提到的不足。\n\n"
            "## 潜在的局限\n从方法本身推断的风险点（如泛化性、计算成本、假设条件）。\n\n"
            "## 可改进方向\n具体可行的后续研究方向。\n\n"
            "要求：客观中立，避免空话；每条局限要有依据。"
        ),
    },
}

MAX_INPUT_CHARS = 24000  # 约 6k-8k token，留足输出空间


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_corpus(doc_id: str) -> tuple[str, int]:
    """把 segments 拼成给模型的正文。

    优先保留标题和正文，公式/图表/表格转成简短标记，
    参考文献默认跳过（除非正文不足）。
    """
    with db() as conn:
        rows = conn.execute(
            """SELECT idx, kind, section, source FROM segments
               WHERE document_id=? ORDER BY idx""",
            (doc_id,),
        ).fetchall()

    if not rows:
        raise ValueError("该文献尚未解析，请先解析全文")

    parts: list[str] = []
    used = 0
    skipped_refs: list[str] = []

    for r in rows:
        kind = r["kind"]
        text = (r["source"] or "").strip()
        if not text:
            continue

        if kind == "heading":
            piece = f"\n\n# {text}\n"
        elif kind == "text":
            piece = text + "\n"
        elif kind == "formula":
            piece = f"[公式] {text[:200]}\n"
        elif kind == "table":
            piece = "[表格]\n"
        elif kind == "figure":
            try:
                meta = json.loads(text)
                piece = f"[图] {meta.get('caption', '')}\n"
            except Exception:
                piece = "[图]\n"
        elif kind == "reference":
            skipped_refs.append(text)
            continue
        else:
            piece = text + "\n"

        if used + len(piece) > MAX_INPUT_CHARS:
            break
        parts.append(piece)
        used += len(piece)

    corpus = "".join(parts).strip()
    if not corpus:
        raise ValueError("没有可用于总结的正文内容")
    return corpus, len(corpus)


def _call_ai(system: str, user: str, cancel_event: Any = None,
             on_progress: Any = None) -> dict[str, Any]:
    """调用 AI 生成总结。

    使用**流式**请求，带来两个好处：
      1. 取消能立即生效：关闭连接即可中断，不必等整个响应返回
      2. 可在生成过程中报告进度

    若服务端不支持流式（返回非 SSE），自动回退到非流式请求。
    """
    import json as _json
    import time

    cfg = ai_mod.get_ai_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("未配置 AI 接口，无法生成总结")

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": cfg.get("model") or "gpt-3.5-turbo",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.3,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    buf: list[str] = []
    deadline = time.time() + 180  # 整体上限

    try:
        with make_client(url, timeout=120) as client:
            with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = resp.read().decode("utf-8", "replace")[:300]
                    raise RuntimeError(f"AI 接口 HTTP {resp.status_code}: {body}")

                ctype = (resp.headers.get("content-type") or "").lower()
                if "text/event-stream" not in ctype and "stream" not in ctype:
                    # 服务端不支持流式，回退
                    raw = resp.read().decode("utf-8", "replace")
                    return _parse_nonstream(raw, cfg.get("model"))

                for line in resp.iter_lines():
                    if cancel_event is not None and cancel_event.is_set():
                        # 关闭连接，服务端通常也会停止生成
                        resp.close()
                        raise ai_mod.Cancelled("已取消")
                    if time.time() > deadline:
                        resp.close()
                        raise RuntimeError("生成超时（超过 180 秒）")

                    if not line:
                        continue
                    if line.startswith("data:"):
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = _json.loads(data)
                        except Exception:
                            continue
                        choices = obj.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        piece = delta.get("content")
                        if piece:
                            buf.append(piece)
                            # 每收到一个片段就回报（廉价的计数，便于前端平滑推进）
                            if on_progress is not None:
                                on_progress(sum(len(x) for x in buf))
    except ai_mod.Cancelled:
        raise
    except RuntimeError:
        raise
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"AI 接口连接失败：{type(e).__name__}: {e}") from e

    content = "".join(buf).strip()
    if not content:
        raise RuntimeError("AI 返回内容为空")
    return {"content": content, "model": cfg.get("model")}


def _parse_nonstream(raw: str, model: str | None) -> dict[str, Any]:
    """解析非流式响应。"""
    import json as _json

    try:
        body = _json.loads(raw)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"AI 返回非 JSON：{raw[:150]}") from e
    content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not content.strip():
        raise RuntimeError("AI 返回内容为空")
    return {"content": content.strip(), "model": model}


def generate(doc_id: str, kind: str, question: str | None = None,
             cancel_event: Any = None,
             on_progress: Any = None) -> dict[str, Any]:
    """生成一份总结并保存。"""
    if kind not in TEMPLATES and kind != "qa":
        raise ValueError(f"未知的总结类型：{kind}")

    if cancel_event is not None and cancel_event.is_set():
        raise ai_mod.Cancelled("已取消")

    corpus, chars = _build_corpus(doc_id)

    if kind == "qa":
        if not question or not question.strip():
            raise ValueError("提问内容不能为空")
        system = (
            "你是一名科研阅读助手。请仅根据给定的论文内容回答问题。"
            "如果论文中没有相关信息，明确说明「论文未提及」，不要编造。"
            "回答用中文，可以使用 Markdown 列表。"
        )
        user = f"论文内容：\n\n{corpus}\n\n---\n\n问题：{question.strip()}"
    else:
        tpl = TEMPLATES[kind]
        system = tpl["system"]
        user = f"以下是论文内容：\n\n{corpus}"

    res = _call_ai(system, user, cancel_event=cancel_event, on_progress=on_progress)

    if cancel_event is not None and cancel_event.is_set():
        raise ai_mod.Cancelled("已取消")

    sid = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            """INSERT INTO summaries (id, document_id, kind, content, model, created_at)
               VALUES (?,?,?,?,?,?)""",
            (sid, doc_id, kind, res["content"], res.get("model"), _now()),
        )
    return {
        "id": sid,
        "kind": kind,
        "content": res["content"],
        "model": res.get("model"),
        "input_chars": chars,
        "token_in": res.get("token_in"),
        "token_out": res.get("token_out"),
    }


def list_summaries(doc_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """SELECT * FROM summaries WHERE document_id=?
               ORDER BY created_at DESC""",
            (doc_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_summary(summary_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM summaries WHERE id=?", (summary_id,))


def available_kinds() -> list[dict[str, str]]:
    out = [{"value": k, "label": v["label"]} for k, v in TEMPLATES.items()]
    out.append({"value": "qa", "label": "针对性提问"})
    return out
