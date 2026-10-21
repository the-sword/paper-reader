"""GitHub 热门开源代码抓取与日增速计算服务。"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from ..core.db import db
from ..core.http import make_client

GITHUB_SEARCH_API = "https://api.github.com/search/repositories"


def _get_github_token() -> str:
    """优先取环境变量，其次查 settings 表中的 github.token。"""
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        return token
    try:
        with db() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='github.token'").fetchone()
            if row and row["value"]:
                return row["value"].strip()
    except Exception:
        pass
    return ""


def search_github_repositories(topics: list[str], limit: int = 25) -> list[dict[str, Any]]:
    """根据主题关键词搜索 GitHub 仓库，并计算 Star 增速。"""
    if not topics:
        topics = ["3D reconstruction", "3D Gaussian Splatting", "Point Cloud SLAM"]

    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "PaperReader-Digest/1.0",
    }
    token = _get_github_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    client = make_client(GITHUB_SEARCH_API, timeout=30)
    raw_items: list[dict[str, Any]] = []
    seen_names: set[str] = set()

    try:
        # 对前 3 个主题分别查询，合并候选池 (GitHub 语法不支持括号 OR 组合)
        for t in topics[:3]:
            term = t.strip()
            if not term:
                continue
            query = f'"{term}" stars:>20' if " " in term else f"{term} stars:>20"
            try:
                resp = client.get(
                    GITHUB_SEARCH_API,
                    params={
                        "q": query,
                        "sort": "stars",
                        "order": "desc",
                        "per_page": min(15, limit),
                    },
                    headers=headers,
                )
                if resp.status_code == 200:
                    for it in resp.json().get("items", []):
                        fn = it.get("full_name", "").strip().lower()
                        if fn and fn not in seen_names:
                            seen_names.add(fn)
                            raw_items.append(it)
            except Exception:
                continue
    finally:
        client.close()

    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_dt = datetime.now(timezone.utc)

    results: list[dict[str, Any]] = []

    with db() as conn:
        for item in raw_items:
            full_name = item.get("full_name", "").strip()
            if not full_name:
                continue

            current_stars = item.get("stargazers_count", 0)

            # 1. 记入/更新今天的打点
            conn.execute(
                """
                INSERT INTO github_stars (full_name, date, stars)
                VALUES (?, ?, ?)
                ON CONFLICT(full_name, date) DO UPDATE SET stars=excluded.stars
                """,
                (full_name, today_str, current_stars),
            )

            # 2. 查询该仓库之前最近的打点 (至少1天前)
            prev_row = conn.execute(
                """
                SELECT date, stars FROM github_stars
                WHERE full_name = ? AND date < ?
                ORDER BY date DESC LIMIT 1
                """,
                (full_name, today_str),
            ).fetchone()

            growth_per_day = 0
            if prev_row:
                try:
                    prev_dt = datetime.strptime(prev_row["date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
                    diff_days = max(1, (today_dt - prev_dt).days)
                    diff_stars = current_stars - prev_row["stars"]
                    growth_per_day = max(0, round(diff_stars / diff_days))
                except Exception:
                    growth_per_day = 0
            else:
                # 首次遇到该仓库，无历史打点：根据创建时间估算日平均增速
                created_str = item.get("created_at")
                if created_str:
                    try:
                        c_dt = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
                        age_days = max(1, (today_dt - c_dt).days)
                        if age_days < 180:
                            growth_per_day = max(1, round(current_stars / age_days))
                        else:
                            # 较老的成熟仓库，保守估算近期日增
                            growth_per_day = max(0, round(current_stars / (age_days * 2)))
                    except Exception:
                        growth_per_day = 0

            # 评分：主要以日增速为核心，兼顾总 star 权重
            score = round(growth_per_day * 2.0 + min(100.0, current_stars / 40.0), 2)

            results.append({
                "id": f"github:{full_name.lower()}",
                "source": "github",
                "title": full_name,
                "url": item.get("html_url", f"https://github.com/{full_name}"),
                "summary": (item.get("description") or "").strip(),
                "score": score,
                "meta": {
                    "stars": current_stars,
                    "forks": item.get("forks_count", 0),
                    "star_growth": growth_per_day,
                    "language": item.get("language") or "Other",
                    "updated_at": item.get("updated_at", ""),
                    "created_at": item.get("created_at", ""),
                },
            })

    # 按增速评分排序
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]
