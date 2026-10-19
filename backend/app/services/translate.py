"""翻译服务：OpenAI 兼容协议 + 段落级缓存 + 术语表注入。

设计要点：
  - 只翻译 kind 为 text/heading 的段落；formula 原样保留，figure 只译 caption
  - 翻译结果按 (segment_id, provider, target_lang) 缓存，重复阅读零成本
  - 术语表存在 settings 表，拼进 system prompt 保证全文译名一致
  - provider 统一用 "openai-compat"，换服务商只改 base_url/model
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from ..core.config import get_settings
from ..core.http import make_client
from ..core.db import db

TRANSLATABLE = {"text", "heading", "caption"}

SYSTEM_PROMPT = """你是一名专业的学术论文翻译。请把用户给出的英文段落翻译成简体中文。

要求：
1. 保持学术严谨，术语使用领域通行译法；
2. 公式、变量名、代码标识符、缩写（如 Transformer、BERT）保留原文；
3. 人名一律保留英文原名，不要音译（如 Yihan Wang 保持原样）；
4. 机构名、学校名、期刊名按通用中文译名翻译（如 Princeton University → 普林斯顿大学）；
5. 邮箱地址、URL、数字和引用标记（如 [7,11,20]）原样保留；
6. 数学符号、希腊字母保持原样；
7. 行内公式（形如 $...$）必须原样保留，包括其中的 LaTeX 命令和花括号，
   不要翻译、不要改写、不要去掉 $ 符号；
8. 中文使用全角标点（，。：；！？），不要用半角；
9. 只输出译文本身，不要添加任何解释、前缀或 Markdown 标记；
10. 如果原文是标题，译文保持简短，不加句号；
11. 如果原文已是中文或纯数字/符号，原样返回。"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# 配置读取（settings 表优先，环境变量兜底）
# ---------------------------------------------------------------------------

def get_ai_config() -> dict[str, str]:
    s = get_settings()
    cfg = {
        "base_url": s.ai_base_url.strip(),
        "api_key": s.ai_api_key.strip(),
        "model": s.ai_model.strip(),
    }
    with db() as conn:
        for key in ("base_url", "api_key", "model", "temperature"):
            row = conn.execute(
                "SELECT value FROM settings WHERE key=?", (f"ai.{key}",)
            ).fetchone()
            if row and row["value"]:
                cfg[key] = json.loads(row["value"])
    return cfg


def save_ai_config(cfg: dict[str, Any]) -> None:
    with db() as conn:
        for key, val in cfg.items():
            if val is None:
                continue
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (f"ai.{key}", json.dumps(val, ensure_ascii=False)),
            )


def get_glossary() -> dict[str, str]:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='glossary'").fetchone()
    if not row:
        return {}
    try:
        return json.loads(row["value"])
    except Exception:
        return {}


def save_glossary(gloss: dict[str, str]) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('glossary', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(gloss, ensure_ascii=False),),
        )


# ---------------------------------------------------------------------------
# 调用
# ---------------------------------------------------------------------------

def _build_messages(text: str, kind: str, glossary: dict[str, str]) -> list[dict[str, str]]:
    system = SYSTEM_PROMPT
    if kind == "heading":
        system += "\n5. 这是论文小节标题，译成简洁的名词短语。"
    if glossary:
        pairs = "；".join(f"{k} → {v}" for k, v in list(glossary.items())[:80])
        system += f"\n\n以下术语必须使用指定译名：{pairs}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": text},
    ]


def translate_text(text: str, kind: str = "text") -> dict[str, Any]:
    """翻译单段，返回 {text, model, provider}。"""
    cfg = get_ai_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("未配置 AI 接口：请在设置页填写 base_url 与 api_key")

    base = cfg["base_url"].rstrip("/")
    url = f"{base}/chat/completions"
    payload = {
        "model": cfg.get("model") or "gpt-3.5-turbo",
        "messages": _build_messages(text, kind, get_glossary()),
        "temperature": float(cfg.get("temperature", 0.3)),
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    body = _post_with_retry(url, payload, headers)

    content = (body.get("choices") or [{}])[0].get("message", {}).get("content", "")
    content = content.strip()
    if not content:
        raise RuntimeError("AI 返回内容为空")

    usage = body.get("usage") or {}
    return {
        "text": _clean(content),
        "model": cfg.get("model"),
        "provider": "openai-compat",
        "token_in": usage.get("prompt_tokens"),
        "token_out": usage.get("completion_tokens"),
    }


# 遇到这些状态码时重试（限流、服务端临时问题）
_RETRYABLE = {429, 500, 502, 503, 504}


class RateLimitError(RuntimeError):
    """接口限流（rpm/tpm 耗尽）。"""


def _post_with_retry(url: str, payload: dict[str, Any], headers: dict[str, str],
                     max_attempts: int = 5) -> dict[str, Any]:
    """带指数退避的请求。专门处理中转站的 rpm/tpm 限流。"""
    import time

    last_err = ""
    for attempt in range(max_attempts):
        try:
            with make_client(url, timeout=120) as client:
                r = client.post(url, json=payload, headers=headers)
        except Exception as e:  # noqa: BLE001  网络层异常也重试
            last_err = f"{type(e).__name__}: {e}"[:200]
            if attempt < max_attempts - 1:
                time.sleep(min(2 ** attempt, 20))
                continue
            raise RuntimeError(f"AI 接口连接失败：{last_err}") from e

        if r.status_code == 200:
            return r.json()

        last_err = f"HTTP {r.status_code}: {r.text[:200]}"
        if r.status_code not in _RETRYABLE:
            raise RuntimeError(f"AI 接口错误 {last_err}")

        if attempt == max_attempts - 1:
            break

        # 尊重服务端 Retry-After，否则指数退避
        delay = min(2 ** attempt, 20)
        ra = r.headers.get("retry-after")
        if ra:
            try:
                delay = min(float(ra), 30)
            except ValueError:
                pass
        time.sleep(delay)

    if "429" in last_err:
        raise RateLimitError(f"接口限流，重试 {max_attempts} 次仍失败：{last_err}")
    raise RuntimeError(f"AI 接口多次重试仍失败：{last_err}")


def _clean(s: str) -> str:
    """去掉模型偶尔加上的包裹标记。"""
    s = re.sub(r"^```[a-z]*\s*|\s*```$", "", s.strip())
    s = re.sub(r"^(译文|翻译)[：:]\s*", "", s)
    return s.strip()


# ---------------------------------------------------------------------------
# 缓存与批量
# ---------------------------------------------------------------------------

def translate_segment(doc_id: str, segment_id: str, force: bool = False,
                      engine: str | None = None) -> dict[str, Any]:
    """翻译单段并写缓存。

    engine 为空时按全局优先级自动选择并降级。
    """
    from . import engines as eng_mod

    with db() as conn:
        seg = conn.execute(
            "SELECT * FROM segments WHERE id=? AND document_id=?", (segment_id, doc_id)
        ).fetchone()
        if not seg:
            raise ValueError("段落不存在")

        if not force:
            # 有指定引擎时只认该引擎的缓存，否则认任意引擎的结果
            if engine:
                hit = conn.execute(
                    """SELECT * FROM translations
                       WHERE segment_id=? AND target_lang='zh-CN' AND provider=?
                       ORDER BY created_at DESC LIMIT 1""",
                    (segment_id, engine),
                ).fetchone()
            else:
                hit = conn.execute(
                    """SELECT * FROM translations
                       WHERE segment_id=? AND target_lang='zh-CN'
                       ORDER BY created_at DESC LIMIT 1""",
                    (segment_id,),
                ).fetchone()
            if hit:
                return {
                    "segment_id": segment_id, "text": hit["text"],
                    "provider": hit["provider"], "model": hit["model"], "cached": True,
                    "latency_ms": 0,
                }

    if seg["kind"] not in TRANSLATABLE:
        return {"segment_id": segment_id, "text": "", "skipped": True,
                "reason": seg["kind"]}

    res = eng_mod.translate_with_fallback(seg["source"], kind=seg["kind"], preferred=engine)

    with db() as conn:
        conn.execute(
            """INSERT INTO translations
               (segment_id, provider, model, target_lang, text, token_in, token_out, created_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(segment_id, provider, target_lang)
               DO UPDATE SET text=excluded.text, created_at=excluded.created_at""",
            (segment_id, res.engine, res.meta.get("model"), "zh-CN",
             res.text, None, None, _now()),
        )

    return {
        "segment_id": segment_id, "text": res.text,
        "provider": res.engine, "model": res.meta.get("model"),
        "cached": False, "latency_ms": res.latency_ms,
        "meta": res.meta,
    }


def cached_count(doc_id: str) -> int:
    with db() as conn:
        row = conn.execute(
            """SELECT COUNT(*) c FROM translations t
               JOIN segments s ON s.id=t.segment_id
               WHERE s.document_id=? AND t.target_lang='zh-CN'""",
            (doc_id,),
        ).fetchone()
    return row["c"] if row else 0
