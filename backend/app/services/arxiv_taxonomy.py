"""arXiv 分类清单同步（Topic 配置的 CategoryPicker 数据源）。

从 arXiv 官方分类页拉取最新分类 id + 英文名，缓存到 settings 表。
用途：
  - CategoryPicker 前端搜索（与内置中文速查表合并，远端条目补充新分类）
  - 后端 topic 校验（可选，当前仅作为数据源）

arXiv 分类法数年一变，同步周期默认 30 天，失败静默用旧缓存/内置表兜底。
页面解析基于稳定特征 <h4>id <span>(Name)</span></h4>；改版则解析结果为空，
视为失败，不影响既有数据。
"""
from __future__ import annotations

import json
import re
import logging
from typing import Any

from ..core.db import db
from ..core.http import make_client

logger = logging.getLogger("radar.taxonomy")

TAXONOMY_URL = "https://arxiv.org/category_taxonomy"
TAXONOMY_KEY = "radar.arxiv_taxonomy"
SYNC_INTERVAL_DAYS = 30

# 稳定特征：<h4>id <span>(Name)</span></h4>。id 两种形态：
#   子库级带点（cs.RO / physics.comp-ph），归档级无点（gr-qc / quant-ph）；
# 页头说明行 "Category Name (Category ID)" 因含空格 + 无 <span> 不命中
_H4_RE = re.compile(
    r"<h4>\s*([a-z][a-z-]*(?:\.[a-z-]+)?)\s*<span>\s*\(([^)]+)\)</span>", re.I
)
# 归档组标题（id 在 span 里，顺序相反）：<h3>Astrophysics<br><span>(astro-ph)</span></h3>
_H3_RE = re.compile(r"<h3>\s*([A-Za-z][^<]*?)\s*<br>\s*<span>\s*\(([^)]+)\)", re.I)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _parse_taxonomy(html: str) -> dict[str, str]:
    """提取 {id: 英文名}。解析不到任何条目返回空 dict（视为改版，不覆盖缓存）。"""
    found: dict[str, str] = {}
    for m in _H4_RE.finditer(html):
        cid = m.group(1).strip().lower()
        # 排除页头说明行等非分类条目；"Category Name" 不匹配 id 形态，双保险
        if cid in ("category", "category-name"):
            continue
        # 同一 id 可能出现多次（如 cs.SY 与 eess.SY 别名说明），首个优先
        if cid not in found:
            found[cid] = m.group(2).strip()
    for m in _H3_RE.finditer(html):
        cid = m.group(2).strip().lower()
        if re.fullmatch(r"[a-z-]+", cid) and cid not in found:
            found[cid] = m.group(1).strip()
    return found


def get_cached_taxonomy() -> dict[str, Any]:
    """读取缓存的远端清单：{synced_at, categories: {id: en_name}}。无缓存返回空结构。"""
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key=?", (TAXONOMY_KEY,)
            ).fetchone()
        if row and row["value"]:
            data = json.loads(row["value"])
            if isinstance(data, dict) and isinstance(data.get("categories"), dict):
                return data
    except Exception:  # noqa: BLE001
        pass
    return {"synced_at": "", "categories": {}}


def sync_taxonomy(force: bool = False) -> dict[str, Any]:
    """拉取并缓存最新分类清单。返回本次同步结果摘要。

    - 距上次同步不足 SYNC_INTERVAL_DAYS 天且非 force：跳过网络请求
    - 拉取/解析失败：保留旧缓存，返回 synced=False
    """
    cached = get_cached_taxonomy()
    if not force and cached["synced_at"]:
        from datetime import datetime, timezone
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(cached["synced_at"])
            if age.total_seconds() < SYNC_INTERVAL_DAYS * 86400:
                return {"synced": False, "reason": "fresh",
                        "categories": len(cached["categories"])}
        except ValueError:
            pass

    try:
        with make_client(TAXONOMY_URL, timeout=20) as client:
            r = client.get(TAXONOMY_URL)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        cats = _parse_taxonomy(r.text)
        if not cats:
            raise RuntimeError("页面解析结果为空（可能改版）")
        data = {"synced_at": _now_iso(), "categories": cats}
        with db() as conn:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (TAXONOMY_KEY, json.dumps(data, ensure_ascii=False)),
            )
        logger.info("arXiv 分类清单同步完成：%s 个分类", len(cats))
        return {"synced": True, "reason": "ok", "categories": len(cats)}
    except Exception as e:  # noqa: BLE001
        logger.warning("arXiv 分类清单同步失败（使用旧数据）: %s", e)
        return {"synced": False, "reason": str(e),
                "categories": len(cached["categories"])}


def ensure_fresh() -> None:
    """启动时调用：非 force，间隔内直接跳过，失败静默。"""
    try:
        sync_taxonomy(force=False)
    except Exception:  # noqa: BLE001
        pass
