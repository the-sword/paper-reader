"""arXiv 前沿论文抓取与打分服务。"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from ..core.db import db
from . import arxiv


def _clean_arxiv_id(raw_id: str) -> str:
    """去除版本号（如 2401.12345v2 -> arxiv:2401.12345）。"""
    s = raw_id.strip()
    s = re.sub(r"^arxiv:\s*", "", s, flags=re.I)
    s = re.sub(r"v\d+$", "", s, flags=re.I)
    return f"arxiv:{s}"


def _get_local_document_signatures() -> set[str]:
    """获取本地所有已存在文献的标识集合（DOI、标题指纹等）。"""
    sigs: set[str] = set()
    try:
        with db() as conn:
            rows = conn.execute("SELECT title, doi FROM documents").fetchall()
            for r in rows:
                if r["doi"]:
                    sigs.add(r["doi"].strip().lower())
                if r["title"]:
                    # 标题简单规整
                    norm_t = re.sub(r"\W+", "", r["title"].lower())
                    if len(norm_t) > 6:
                        sigs.add(norm_t)
    except Exception:
        pass
    return sigs


def search_arxiv_papers(topics: list[str], limit: int = 25) -> list[dict[str, Any]]:
    """根据关注主题在 arXiv 搜索最新高价值论文。"""
    if not topics:
        topics = ["3D reconstruction", "3D Gaussian Splatting", "Point Cloud SLAM"]

    # 构造 search query：("3D reconstruction" OR "3D Gaussian Splatting")
    query_parts = [f'"{t.strip()}"' if " " in t.strip() else t.strip() for t in topics if t.strip()]
    if not query_parts:
        query_parts = ['"3D reconstruction"']
    full_query = " OR ".join(query_parts)

    try:
        raw_items = arxiv.search(full_query, limit=max(30, limit), field="all")
    except Exception:
        return []

    local_sigs = _get_local_document_signatures()
    today_dt = datetime.now(timezone.utc)

    results: list[dict[str, Any]] = []

    for item in raw_items:
        clean_id = _clean_arxiv_id(item["arxiv_id"])
        title = item.get("title", "").strip()
        doi = (item.get("doi") or "").strip().lower()
        norm_title = re.sub(r"\W+", "", title.lower())

        # 检查是否已在本地文献库中
        in_local = False
        if doi and doi in local_sigs:
            in_local = True
        elif norm_title and norm_title in local_sigs:
            in_local = True

        # 打分计算：
        # 1. 新鲜度（7天内得分极高）
        recency_score = 50.0
        published_str = item.get("published", "")
        if published_str:
            try:
                # 示例: 2026-10-18T12:00:00Z
                p_dt = datetime.fromisoformat(published_str.replace("Z", "+00:00"))
                days = (today_dt - p_dt).days
                if days <= 2:
                    recency_score = 100.0
                elif days <= 7:
                    recency_score = 80.0
                elif days <= 30:
                    recency_score = 60.0
                else:
                    recency_score = max(10.0, 50.0 - days)
            except Exception:
                pass

        # 2. 摘要质量与长度
        summary = item.get("summary", "").strip()
        summary_score = min(30.0, len(summary) / 30.0)

        # 3. 分类权重 (cs.CV / cs.RO / cs.GR 等计算机视觉与图形学领域加分)
        cats = [c.lower() for c in item.get("categories", [])]
        cat_bonus = 20.0 if any(c.startswith(("cs.cv", "cs.ro", "cs.gr", "cs.ai")) for c in cats) else 5.0

        total_score = round(recency_score * 0.5 + summary_score + cat_bonus, 2)

        results.append({
            "id": clean_id,
            "source": "arxiv",
            "title": title,
            "url": item.get("abs_url", f"https://arxiv.org/abs/{item['arxiv_id']}"),
            "summary": summary,
            "score": total_score,
            "meta": {
                "arxiv_id": item["arxiv_id"],
                "authors": item.get("authors", []),
                "published": published_str,
                "categories": item.get("categories", []),
                "doi": item.get("doi"),
                "pdf_url": item.get("pdf_url"),
                "already_in_library": in_local,
            },
        })

    # 按综合热度得分排序
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]
