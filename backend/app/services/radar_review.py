"""LLM 结构化评审管道（Paper-Code Radar）。

对通过规则初筛的论文调用 OpenAI 兼容接口，输出标准化评审卡片（JSON）。
工程约束（SRS §3.3）：
  - JSON 解析失败或字段缺失自动重试 1 次（附纠偏提示），再失败标记 review_failed；
  - 单条失败不阻断批处理；
  - 记录 token 用量到 settings 表，看板可见当日评审开销。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from ..core.http import make_client
from . import translate as ai_mod

logger = logging.getLogger("radar.review")

# 评审卡片必须包含的字段及其类型
_REQUIRED_FIELDS = {
    "relevance_score": int,
    "primary_tag": str,
    "one_sentence_summary": str,
    "problem_solved": str,
    "core_innovation": str,
    "practical_value": str,
    "pass_filter": bool,
}
_USAGE_KEY = "radar.llm.usage"

_SYSTEM_PROMPT = (
    "你是一位资深技术 Reviewer，负责评估学术论文与特定研究主题的相关性。"
    "请基于论文摘要给出结构化评审，relevance_score 为 1~5 的整数：\n"
    "5 = 完全命中主题且工程价值极高；4 = 高度相关有落地价值；"
    "3 = 部分相关；2 = 勉强沾边；1 = 与主题无关。\n"
    "你必须且只能输出一个 JSON 对象，不要输出任何其他文字或 Markdown 代码块标记。"
    "JSON 字段为：relevance_score(int), primary_tag(str), one_sentence_summary(str), "
    "problem_solved(str), core_innovation(str), practical_value(str), pass_filter(bool)。"
    "中文分析字段用中文填写，pass_filter 表示是否值得进入看板（score>=3 即 true）。"
)


def _extract_json(text: str) -> dict[str, Any]:
    """从模型回复中提取 JSON 对象（容忍 ```json 包裹与前后噪声）。"""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if m:
        text = m.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start:end + 1]
    obj = json.loads(text)
    if not isinstance(obj, dict):
        raise ValueError("评审结果不是 JSON 对象")
    return obj


def _validate_review(obj: dict[str, Any]) -> dict[str, Any]:
    """校验评审卡片字段完整性与类型，不合法抛 ValueError。"""
    missing = [k for k in _REQUIRED_FIELDS if k not in obj]
    if missing:
        raise ValueError(f"评审 JSON 缺少字段: {missing}")
    score = obj["relevance_score"]
    if not isinstance(score, int) or not 1 <= score <= 5:
        raise ValueError(f"relevance_score 非法: {score!r}")
    for k in ("primary_tag", "one_sentence_summary", "problem_solved",
              "core_innovation", "practical_value"):
        if not str(obj[k]).strip():
            raise ValueError(f"字段 {k} 为空")
    if isinstance(obj["pass_filter"], str):
        obj["pass_filter"] = obj["pass_filter"].lower() in ("true", "1", "yes")
    return {
        "relevance_score": int(score),
        "primary_tag": str(obj["primary_tag"]).strip(),
        "one_sentence_summary": str(obj["one_sentence_summary"]).strip(),
        "problem_solved": str(obj["problem_solved"]).strip(),
        "core_innovation": str(obj["core_innovation"]).strip(),
        "practical_value": str(obj["practical_value"]).strip(),
        "pass_filter": bool(obj["pass_filter"]),
    }


def _build_user_prompt(paper: dict[str, Any], topic: dict[str, Any]) -> str:
    code_desc = {
        "code_available": "有配套开源代码（已验证真实可用）",
        "placeholder": "附代码链接但疑似占位仓库",
        "no_code": "未发现开源代码",
    }.get(paper.get("code_status"), "未知")
    focus = topic.get("evaluation_focus") or "无额外侧重，按主题名称常规评估。"
    cats = ", ".join(paper.get("categories") or []) or "无"
    return (
        f"【研究主题】{topic.get('name', '')}\n"
        f"【评审侧重】{focus}\n\n"
        f"【论文标题】{paper.get('title', '')}\n"
        f"【分类】{cats}\n"
        f"【代码状态】{code_desc}\n"
        f"【摘要】{paper.get('abstract', '')[:3000]}\n\n"
        "请输出评审 JSON。"
    )


def _record_usage(usage: dict[str, Any]) -> None:
    """累计 token 用量到 settings 表（radar.llm.usage，按日累计）。"""
    if not usage:
        return
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        from ..core.db import db
        with db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key=?", (_USAGE_KEY,)
            ).fetchone()
            data: dict[str, Any] = {}
            if row and row["value"]:
                try:
                    data = json.loads(row["value"])
                except Exception:  # noqa: BLE001
                    data = {}
            day = data.get(today, {"calls": 0, "token_in": 0, "token_out": 0})
            day["calls"] = int(day.get("calls", 0)) + 1
            day["token_in"] = int(day.get("token_in", 0)) + int(usage.get("prompt_tokens") or 0)
            day["token_out"] = int(day.get("token_out", 0)) + int(usage.get("completion_tokens") or 0)
            data[today] = day
            # 只保留最近 30 天
            keys = sorted(data.keys())
            for k in keys[:-30]:
                data.pop(k, None)
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (_USAGE_KEY, json.dumps(data, ensure_ascii=False)),
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("记录 LLM 用量失败: %s", e)


def review_paper(paper: dict[str, Any], topic: dict[str, Any]) -> dict[str, Any]:
    """评审单篇论文。返回评审卡片 dict；失败抛 RuntimeError。

    失败重试策略：第一次失败后附加纠偏提示重试 1 次（SRS §3.3）。
    """
    cfg = ai_mod.get_ai_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("未配置 AI 接口：请在设置页填写 base_url 与 api_key")

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    user_prompt = _build_user_prompt(paper, topic)

    last_err: Exception | None = None
    for attempt in range(2):
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]
        if attempt == 1 and last_err is not None:
            messages.append({
                "role": "user",
                "content": f"上一次输出不合法（{last_err}）。请严格只输出一个合法 JSON 对象，"
                           "不要包含任何解释或代码块标记。",
            })
        payload = {
            "model": cfg.get("model") or "gpt-3.5-turbo",
            "messages": messages,
            "temperature": 0.2,
            "stream": False,
        }
        try:
            with make_client(url, timeout=120) as client:
                r = client.post(url, json=payload, headers=headers)
            if r.status_code != 200:
                raise RuntimeError(f"AI 接口 HTTP {r.status_code}: {r.text[:200]}")
            body = r.json()
            _record_usage(body.get("usage") or {})
            content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "")
            if not content.strip():
                raise ValueError("AI 返回内容为空")
            return _validate_review(_extract_json(content))
        except (ValueError, RuntimeError, json.JSONDecodeError) as e:  # noqa: PERF001
            last_err = e
            logger.info("评审重试 %s（%s）: %s", attempt + 1, paper.get("id"), e)

    raise RuntimeError(f"评审失败（已重试）: {last_err}")


# ---------------------------------------------------------------------------
# 批量评审：多篇拼包进一次调用，返回与输入等长的列表（失败位为 None，
# 由调用方降级走单篇评审）。单条缺失/非法不拖垮整批。
# ---------------------------------------------------------------------------

_BATCH_SYSTEM_PROMPT = (
    "你是一位资深技术 Reviewer，负责批量评估多篇学术论文与特定研究主题的相关性。"
    "我会给出编号的论文列表，请对每一篇输出结构化评审，relevance_score 为 1~5 的整数：\n"
    "5 = 完全命中主题且工程价值极高；4 = 高度相关有落地价值；"
    "3 = 部分相关；2 = 勉强沾边；1 = 与主题无关。\n"
    "你必须且只能输出一个 JSON 数组，不要输出任何其他文字或 Markdown 代码块标记。"
    "数组每个元素是一个 JSON 对象，字段为："
    "index(int, 对应论文编号，从 1 开始), relevance_score(int), primary_tag(str), "
    "one_sentence_summary(str), problem_solved(str), core_innovation(str), "
    "practical_value(str), pass_filter(bool)。"
    "中文分析字段用中文填写，pass_filter 表示是否值得进入看板（score>=3 即 true）。"
    "论文列表有几位就输出几个元素，顺序与编号一一对应，不得遗漏或合并。"
)


def _extract_json_array(text: str) -> list[dict[str, Any]]:
    """从模型回复中提取 JSON 数组（容忍 ```json 包裹与前后噪声）。"""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.S)
    if m:
        text = m.group(1)
    else:
        start, end = text.find("["), text.rfind("]")
        if start < 0 or end <= start:
            raise ValueError("回复中没有 JSON 数组")
        text = text[start:end + 1]
    arr = json.loads(text)
    if not isinstance(arr, list):
        raise ValueError("评审结果不是 JSON 数组")
    return [x for x in arr if isinstance(x, dict)]


def _build_batch_user_prompt(papers: list[dict[str, Any]], topic: dict[str, Any]) -> str:
    focus = topic.get("evaluation_focus") or "无额外侧重，按主题名称常规评估。"
    lines = [
        f"【研究主题】{topic.get('name', '')}",
        f"【评审侧重】{focus}",
        f"【论文数量】{len(papers)}",
        "",
    ]
    for i, p in enumerate(papers, 1):
        code_desc = {
            "code_available": "有配套开源代码（已验证真实可用）",
            "placeholder": "附代码链接但疑似占位仓库",
            "no_code": "未发现开源代码",
        }.get(p.get("code_status"), "未知")
        cats = ", ".join(p.get("categories") or []) or "无"
        lines.append(f"--- 论文 {i} ---")
        lines.append(f"标题：{p.get('title', '')}")
        lines.append(f"分类：{cats}")
        lines.append(f"代码状态：{code_desc}")
        lines.append(f"摘要：{p.get('abstract', '')[:2000]}")
        lines.append("")
    lines.append("请输出评审 JSON 数组（每篇一个元素，含 index 字段）。")
    return "\n".join(lines)


def review_batch(papers: list[dict[str, Any]], topic: dict[str, Any]) -> list[dict[str, Any] | None]:
    """批量评审。返回与 papers 等长的列表：成功位为评审卡片，失败位为 None。

    整批调用失败（网络/HTTP）直接抛异常；整批返回但个别条目缺失或非法时
    对应位为 None，由调用方决定是否单篇降级重试。
    """
    if not papers:
        return []
    cfg = ai_mod.get_ai_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("未配置 AI 接口：请在设置页填写 base_url 与 api_key")

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    user_prompt = _build_batch_user_prompt(papers, topic)

    last_err: Exception | None = None
    for attempt in range(2):
        messages: list[dict[str, str]] = [
            {"role": "system", "content": _BATCH_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]
        if attempt == 1 and last_err is not None:
            messages.append({
                "role": "user",
                "content": f"上一次输出不合法（{last_err}）。请严格只输出一个合法 JSON 数组，"
                           "每个元素含 index 字段且与论文编号一一对应，不要任何解释。",
            })
        payload = {
            "model": cfg.get("model") or "gpt-3.5-turbo",
            "messages": messages,
            "temperature": 0.2,
            "stream": False,
        }
        try:
            with make_client(url, timeout=180) as client:
                r = client.post(url, json=payload, headers=headers)
            if r.status_code != 200:
                raise RuntimeError(f"AI 接口 HTTP {r.status_code}: {r.text[:200]}")
            body = r.json()
            _record_usage(body.get("usage") or {})
            content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "")
            if not content.strip():
                raise ValueError("AI 返回内容为空")
            arr = _extract_json_array(content)
            out: list[dict[str, Any] | None] = [None] * len(papers)
            for obj in arr:
                try:
                    idx = int(obj.get("index", 0)) - 1
                except (TypeError, ValueError):
                    continue
                if not 0 <= idx < len(papers):
                    continue
                if out[idx] is not None:
                    continue
                try:
                    out[idx] = _validate_review(obj)
                except ValueError as e:
                    logger.info("批量评审第 %d 条不合法: %s", idx + 1, e)
            return out
        except (ValueError, RuntimeError, json.JSONDecodeError) as e:  # noqa: PERF001
            last_err = e
            logger.info("批量评审重试（%s）: %s", attempt + 1, e)

    raise RuntimeError(f"批量评审失败（已重试）: {last_err}")
