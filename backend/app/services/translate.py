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
3. 只输出译文本身，不要添加任何解释、前缀或 Markdown 标记；
4. 如果原文是标题，译文保持简短，不加句号。"""


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

    with make_client(url, timeout=120) as client:
        r = client.post(url, json=payload, headers=headers)
        if r.status_code != 200:
            raise RuntimeError(f"AI 接口错误 HTTP {r.status_code}: {r.text[:300]}")
        body = r.json()

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


def _clean(s: str) -> str:
    """去掉模型偶尔加上的包裹标记。"""
    s = re.sub(r"^```[a-z]*\s*|\s*```$", "", s.strip())
    s = re.sub(r"^(译文|翻译)[：:]\s*", "", s)
    return s.strip()


# ---------------------------------------------------------------------------
# 缓存与批量
# ---------------------------------------------------------------------------

def translate_segment(doc_id: str, segment_id: str, force: bool = False) -> dict[str, Any]:
    """翻译单段并写缓存。命中缓存直接返回。"""
    with db() as conn:
        seg = conn.execute(
            "SELECT * FROM segments WHERE id=? AND document_id=?", (segment_id, doc_id)
        ).fetchone()
        if not seg:
            raise ValueError("段落不存在")

        if not force:
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
                }

    if seg["kind"] not in TRANSLATABLE:
        return {"segment_id": segment_id, "text": "", "skipped": True, "reason": seg["kind"]}

    res = translate_text(seg["source"], seg["kind"])

    with db() as conn:
        conn.execute(
            """INSERT INTO translations
               (segment_id, provider, model, target_lang, text, token_in, token_out, created_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(segment_id, provider, target_lang)
               DO UPDATE SET text=excluded.text, created_at=excluded.created_at""",
            (segment_id, res["provider"], res.get("model"), "zh-CN",
             res["text"], res.get("token_in"), res.get("token_out"), _now()),
        )

    return {
        "segment_id": segment_id, "text": res["text"],
        "provider": res["provider"], "model": res.get("model"), "cached": False,
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
