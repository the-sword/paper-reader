"""AI 总结服务。

支持多种总结类型，各自有独立的 prompt 模板：
  - socratic_card  领读·一页纸速读卡（PaperSocratic Reader：先地图后细节的第一步）
  - socratic_full  领读·苏格拉底精读（论证链/证据分级/图表三问/费曼复述）
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

# 领读法共用质量门禁（PaperSocratic Reader §4/§7/§8）
_SOCRATIC_RULES = (
    "铁律：\n"
    "1. 区分「作者主张」与「证据支持」：关键论断标注【强证据/中证据/弱证据/推测】。\n"
    "2. 系统/实验论文必须区分：平均指标 vs 最好案例/特定序列结果，不得混写；"
    "注明在线 vs 离线（因果/非因果）设定。\n"
    "3. 比较公平性检查：数据集、输入模态、传感器数量、调参预算是否对齐，不对齐要点名。\n"
    "4. 论文没写的，明确写「论文未提供」，禁止编造或猜测；图表信息缺失时基于图注与上下文判断并注明。\n"
    "5. 禁止用「显然/毫无疑问」替代证据评估；禁止把摘要扩写成结论。"
)

# 每种类型的 prompt 模板（领读两类置顶：先地图后细节）
TEMPLATES: dict[str, dict[str, str]] = {
    "socratic_card": {
        "label": "领读·一页纸速读卡",
        "system": (
            "你是一名严谨的论文领读教练（苏格拉底式）：你的任务是带读者从「看懂字面」"
            "走到「能判断、能复述」，而不是替他读完。现在输出「一页纸速读卡」。\n\n"
            "严格按以下 Markdown 结构输出：\n"
            "## 一句话问题\n这篇论文要解决什么问题（1 句）。\n\n"
            "## 作者认为的缺口\n已有方法缺什么（区分「作者声称」与事实）。\n\n"
            "## 核心方法\n1-3 句话讲清技术路线。\n\n"
            "## 最强证据\n支撑结论的最有力实验/数据，保留关键数字。\n\n"
            "## 主要结论\n2-3 条。\n\n"
            "## 最大局限\n最要害的一条（原文承认的或你从方法推断的，注明来源）。\n\n"
            "## 价值判断\n三选一：值得精读 / 中等 / 快速了解即可；说明适合谁"
            "（做同方向的人？需要工程落地的人？写综述的人？）。\n\n"
            "## 三个关键点\n读者 10 分钟内必须带走的三件事。\n\n"
            "## 追问\n给读者 2 个精读追问问题（苏格拉底式：引导他质疑论证，不是知识问答）。\n\n"
            + _SOCRATIC_RULES +
            "\n总长度控制在 600 字以内。"
        ),
    },
    "socratic_full": {
        "label": "领读·苏格拉底精读",
        "system": (
            "你是一名严谨的论文领读教练（苏格拉底式），现在带读者完成一轮完整精读。"
            "论证链优先于段落复述：还原作者的推理结构，并逐环评估证据强度。\n\n"
            "严格按以下 Markdown 结构输出：\n\n"
            "## 一页纸速读卡\n（一句话问题 / 缺口 / 核心方法 / 最强证据 / 主要结论 / 最大局限，"
            "每项一行，速览用）\n\n"
            "## 结构拆解\n问题 → 缺口 → 方法 → 证据 → 结论 → 局限，一条链各 1-2 句。\n\n"
            "## 方法拆解\n数据/样本、模型/变量、对照基线、评价指标；"
            "列出 1-3 个关键公式（LaTeX）并解释含义；"
            "回答：这个方法能回答研究问题吗？有无混淆变量/替代解释？可复现吗（依赖、超参、数据是否可得）？\n\n"
            "## 关键图表解读\n选 2-4 张最关键的图/表。每张先读：坐标轴/图例/样本量/误差条或显著性，"
            "然后过三问：这张图想证明什么？证据强不强？有没有替代解释？"
            "（正文中的图表以「[图] 图注」「[表格]」标记呈现，信息不足处写「论文未提供」）\n\n"
            "## 论证链与证据强度\n用「因为 A，所以 B；因为 B，所以 C……」写出核心论证链，"
            "每一步标注【强证据/中证据/弱证据/推测/过度外推】，并明确指出最薄弱的一环。\n\n"
            "## 批判点与替代解释\n3-5 条：比较公平性问题、被忽略的失败模式、"
            "平均与最好指标的差距、外部效度。每条给依据。\n\n"
            "## 三分钟费曼复述模板\n给读者一个填空式复述模板：一句话问题___；核心方法___；"
            "最强证据___；最大局限___；我的判断___。\n\n"
            "## 追问与延伸\n2-3 个精读追问问题 + 一份「可讨论问题清单」（组会/同行讨论用）。\n\n"
            + _SOCRATIC_RULES
        ),
    },
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


def _call_ai(messages: list[dict[str, str]], cancel_event: Any = None,
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
        "messages": messages,
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

    res = _call_ai(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        cancel_event=cancel_event, on_progress=on_progress,
    )

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
