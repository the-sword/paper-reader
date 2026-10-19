"""划词翻译：面向短文本的低延迟翻译。

与全文翻译的区别：
  - 输入更短（单词/短语/单句），追求毫秒级返回
  - 结果按 (text, engine, target) 缓存到内存和数据库，重复选词零成本
  - 引擎选择：优先机翻（快），AI 兜底
  - 支持词典式补充：词性、音标等（若引擎返回）

缓存策略：
  - 内存 LRU（进程内，重启丢失）
  - SQLite 表 term_cache（持久化）
"""
from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ..core.db import db
from . import engines as eng_mod

# 内存缓存：最多保留 2000 条
_MEM: OrderedDict[str, dict[str, Any]] = OrderedDict()
_MEM_LIMIT = 2000

# 超过这个长度就不算「划词」了，走全文逻辑更合适
MAX_WORD_LEN = 800


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _key(text: str, engine: str | None) -> str:
    raw = f"{text.strip()}|{engine or 'auto'}|zh-CN"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _mem_get(key: str) -> dict[str, Any] | None:
    if key in _MEM:
        _MEM.move_to_end(key)
        return _MEM[key]
    return None


def _mem_put(key: str, val: dict[str, Any]) -> None:
    _MEM[key] = val
    _MEM.move_to_end(key)
    while len(_MEM) > _MEM_LIMIT:
        _MEM.popitem(last=False)


def _db_get(key: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            "SELECT payload FROM term_cache WHERE key=?", (key,)
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["payload"])
    except Exception:
        return None


def _db_put(key: str, val: dict[str, Any]) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO term_cache (key, payload, created_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, "
            "created_at=excluded.created_at",
            (key, json.dumps(val, ensure_ascii=False), _now()),
        )


@dataclass
class TermResult:
    source: str
    text: str
    engine: str
    latency_ms: int
    cached: bool
    meta: dict[str, Any]


def translate_term(text: str, engine: str | None = None) -> TermResult:
    """翻译选中的词/短语。优先内存 → 数据库 → 在线。"""
    src = (text or "").strip()
    if not src:
        raise ValueError("选中内容为空")
    if len(src) > MAX_WORD_LEN:
        # 太长，截断处理并提示
        src = src[:MAX_WORD_LEN]

    key = _key(src, engine)

    hit = _mem_get(key)
    if hit:
        return TermResult(
            source=src, text=hit["text"], engine=hit["engine"],
            latency_ms=0, cached=True, meta=hit.get("meta") or {},
        )

    hit = _db_get(key)
    if hit:
        _mem_put(key, hit)
        return TermResult(
            source=src, text=hit["text"], engine=hit["engine"],
            latency_ms=0, cached=True, meta=hit.get("meta") or {},
        )

    t0 = time.time()
    res = eng_mod.translate_with_fallback(src, kind="text", preferred=engine)

    payload = {
        "text": res.text,
        "engine": res.engine,
        "meta": res.meta,
    }
    _mem_put(key, payload)
    _db_put(key, payload)

    return TermResult(
        source=src, text=res.text, engine=res.engine,
        latency_ms=int((time.time() - t0) * 1000), cached=False, meta=res.meta,
    )


def clear_cache() -> int:
    """清空词库缓存。"""
    n = len(_MEM)
    _MEM.clear()
    with db() as conn:
        row = conn.execute("SELECT COUNT(*) c FROM term_cache").fetchone()
        total = row["c"] if row else 0
        conn.execute("DELETE FROM term_cache")
    return max(n, total)


def cache_stats() -> dict[str, int]:
    with db() as conn:
        row = conn.execute("SELECT COUNT(*) c FROM term_cache").fetchone()
    return {"memory": len(_MEM), "database": row["c"] if row else 0}
