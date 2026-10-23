"""arXiv 分类订阅拉取（Paper-Code Radar 专用）。

与 arxiv.py（关键词搜索）的区别：
  - 按 cs.* 分类订阅（search_query=cat:cs.RO+OR+cat:cs.CV），而非关键词 OR；
  - 保留完整 ISO 时间戳（HH:MM），供 24 小时窗口过滤；
  - 解析 Comment 字段（GitHub 链接常埋在这里）；
  - max_results>30 需分页轮询（每页 ≤200，本模块取 100/页）。
"""
from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Any

from ..core.http import make_client

ARXIV_API = "https://export.arxiv.org/api/query"
_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV_NS = "{http://arxiv.org/schemas/atom}"

# 与 arxiv.py 保持一致的最小请求间隔
_MIN_INTERVAL = 3.0
_last_call = 0.0


def _throttle() -> None:
    global _last_call
    wait = _MIN_INTERVAL - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()


def _parse_ts(raw: str) -> datetime | None:
    """解析 arXiv 时间戳（2026-10-21T08:00:00Z / 带偏移两种格式）。"""
    try:
        return datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def fetch_by_categories(
    categories: list[str],
    since: datetime,
    until: datetime,
    max_results: int = 300,
) -> list[dict[str, Any]]:
    """拉取多个分类在 [since, until] 时间窗内的新提交。

    返回按提交时间倒序的条目列表；单条时间戳解析失败直接丢弃（SRS FR-2.1）。
    """
    cats = [c.strip() for c in categories if c.strip()]
    if not cats:
        return []
    query = "+OR+".join(f"cat:{c}" for c in cats)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    page_size = 100
    remaining = max_results

    while remaining > 0:
        _throttle()
        n = min(page_size, remaining)
        try:
            with make_client(ARXIV_API, timeout=40) as client:
                resp = client.get(ARXIV_API, params={
                    "search_query": query,
                    "start": len(out),
                    "max_results": n,
                    "sortBy": "submittedDate",
                    "sortOrder": "descending",
                })
        except Exception:  # noqa: BLE001
            break
        if resp.status_code != 200:
            break

        entries = _parse_feed(resp.text)
        if not entries:
            break
        older_than_window = False
        for item in entries:
            aid_raw = item["arxiv_id"]
            clean_id = re.sub(r"v\d+$", "", aid_raw.strip())
            key = f"arxiv:{clean_id}"
            if key in seen:
                continue
            seen.add(key)
            ts = _parse_ts(item["published"])
            if ts is None:
                continue
            if ts > until:
                continue
            if ts < since:
                older_than_window = True
                continue
            item["arxiv_id"] = clean_id
            item["published"] = ts.isoformat()
            out.append(item)
        # 倒序翻页：本页最旧一条已早于窗口起点，无需再翻
        last_ts = _parse_ts(entries[-1]["published"])
        if older_than_window or (last_ts and last_ts < since):
            break
        remaining -= n

    out.sort(key=lambda x: x["published"], reverse=True)
    return out


def _parse_feed(xml: str) -> list[dict[str, Any]]:
    """解析 Atom feed，保留完整时间戳与 Comment 字段。"""
    items: list[dict[str, Any]] = []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return items
    for entry in root.findall(f"{_ATOM}entry"):
        eid = (entry.findtext(f"{_ATOM}id") or "").strip()
        aid = eid.rsplit("/abs/", 1)[-1] if "/abs/" in eid else ""
        if not aid:
            continue
        title = re.sub(r"\s+", " ", entry.findtext(f"{_ATOM}title") or "").strip()
        abstract = re.sub(r"\s+", " ", entry.findtext(f"{_ATOM}summary") or "").strip()
        published = (entry.findtext(f"{_ATOM}published") or "").strip()
        comment = re.sub(
            r"\s+", " ",
            (entry.findtext(f"{_ARXIV_NS}comment") or "").strip(),
        )
        authors = [
            re.sub(r"\s+", " ", (a.findtext(f"{_ATOM}name") or "")).strip()
            for a in entry.findall(f"{_ATOM}author")
        ]
        authors = [a for a in authors if a]
        cats = [
            c.get("term") for c in entry.findall(f"{_ATOM}category") if c.get("term")
        ]
        doi = (entry.findtext(f"{_ARXIV_NS}doi") or "").strip() or None
        items.append({
            "arxiv_id": aid,
            "title": title,
            "abstract": abstract,
            "published": published,
            "comment": comment,
            "authors": authors,
            "categories": cats,
            "doi": doi,
            "abs_url": f"https://arxiv.org/abs/{aid}",
            "pdf_url": f"https://arxiv.org/pdf/{aid}",
        })
    return items


def build_daily_window(now_utc: datetime | None = None) -> tuple[datetime, datetime]:
    """构造 24 小时抓取窗口 [now-24h, now]。"""
    now = now_utc or datetime.now(timezone.utc)
    return now - timedelta(hours=24), now
