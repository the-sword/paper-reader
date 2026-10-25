"""GitHub 仓库活性审计（Paper-Code Radar）。

从论文摘要/评论中正则提取 GitHub 链接，调 GitHub REST API 校验真实性：
  - is_valid：仓库是否存在（非 404）
  - is_empty：default branch 是否有 commit（占位仓库判定）
  - stars / language / pushed_at：活性佐证

结果缓存到 radar_repos 表，7 天内同一仓库不重复请求（SRS FR-2.2）。
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from ..core.db import db
from ..core.http import make_client

logger = logging.getLogger("radar.github")

REPO_API = "https://api.github.com/repos/{full_name}"
COMMITS_API = "https://api.github.com/repos/{full_name}/commits?per_page=1"

# 链接正则：owner/repo 两段；子路径（tree/ issues/ blob/ 等）在归一化时截断
GH_RE = re.compile(
    r"https?://github\.com/"
    r"(?P<owner>[A-Za-z0-9_.\-]+)/(?P<repo>[A-Za-z0-9_.\-]+)"
)

# GitHub 站内功能路径，不是仓库，直接排除
_EXCLUDE_OWNERS = {
    "topics", "assets", "features", "orgs", "sponsors",
    "marketplace", "collections", "trending", "settings", "notifications",
}

# 审计结果缓存有效期
CACHE_DAYS = 7
# 无 token 时 GitHub API 限流 60 次/小时，单轮管道给其余请求留余量
_MAX_AUDITS_PER_RUN = 40


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def extract_repo(text: str) -> str | None:
    """从文本中提取第一个合法 GitHub 仓库（owner/repo，小写）。

    排除 topics/assets 等站内伪路径；tree/、issues/、blob/ 等子路径
    依靠正则的 repo 段定义自然截断（repo 段不含 /）。
    """
    if not text:
        return None
    for m in GH_RE.finditer(text):
        owner = m.group("owner").lower()
        repo = m.group("repo").lower()
        if owner in _EXCLUDE_OWNERS:
            continue
        # 仓库段不应是纯版本号/数字（如 /compare/v1...v2 误匹配）
        if not re.search(r"[a-z]", repo):
            continue
        if repo.endswith("."):
            repo = repo.rstrip(".")
        if not repo:
            continue
        return f"{owner}/{repo}"
    return None


def extract_repo_from_paper(paper: dict[str, Any]) -> str | None:
    """从摘要与 Comment 字段提取仓库。优先 Comment（作者常在此放代码链接）。"""
    for field in ("comment", "abstract"):
        repo = extract_repo(str(paper.get(field) or ""))
        if repo:
            return repo
    return None


def _get_token() -> str:
    """优先环境变量 GITHUB_TOKEN，其次 settings 表 github.token（复用 v1 读取链）。"""
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        return token
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key='github.token'"
            ).fetchone()
            if row and row["value"]:
                return str(row["value"]).strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


def _headers(token: str) -> dict[str, str]:
    h = {"Accept": "application/vnd.github+json", "User-Agent": "PaperReader-Radar/1.0"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _row_to_result(row: Any) -> dict[str, Any]:
    return {
        "is_valid": bool(row["is_valid"]),
        "is_empty": bool(row["is_empty"]),
        "stars": int(row["stars"] or 0),
        "language": row["language"] or "",
        "pushed_at": row["pushed_at"] or "",
        "cached": True,
    }


def audit_repo(full_name: str, audits_used: list[int] | None = None) -> dict[str, Any] | None:
    """审计单个仓库（带缓存）。返回结果字典；网络/限流异常时返回 None。

    audits_used 是共享计数器（列表首元素），用于单轮管道限流：
    无 token 时 GitHub 限流 60 次/小时，超限时直接走缓存或放弃。
    """
    full_name = full_name.strip("/").lower()
    now = _now()

    with db() as conn:
        row = conn.execute(
            "SELECT * FROM radar_repos WHERE full_name=?", (full_name,)
        ).fetchone()
    if row:
        try:
            checked = datetime.fromisoformat(row["checked_at"])
            if now - checked < timedelta(days=CACHE_DAYS):
                return _row_to_result(row)
        except (ValueError, TypeError):
            pass

    if audits_used is not None:
        if audits_used[0] >= _MAX_AUDITS_PER_RUN:
            logger.info("本轮 GitHub 审计已达上限 %s，%s 按未知处理", _MAX_AUDITS_PER_RUN, full_name)
            return None
        audits_used[0] += 1

    result = _fetch_repo(full_name, _get_token())
    if result is None:
        return None

    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO radar_repos (full_name, is_valid, is_empty, stars, language,"
                " pushed_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(full_name) DO UPDATE SET is_valid=excluded.is_valid,"
                " is_empty=excluded.is_empty, stars=excluded.stars,"
                " language=excluded.language, pushed_at=excluded.pushed_at,"
                " checked_at=excluded.checked_at",
                (full_name, result["is_valid"], result["is_empty"], result["stars"],
                 result["language"], result["pushed_at"], _now_iso()),
            )
    except Exception as e:  # noqa: BLE001
        # 缓存写失败不影响本轮结论（如极端并发下的写锁竞争）
        logger.warning("审计缓存写入失败 %s: %s", full_name, e)
    return {**result, "cached": False}


def _fetch_repo(full_name: str, token: str) -> dict[str, Any] | None:
    """调 GitHub API 审计。404 → 「不存在」合法结果；网络异常/限流 → None。"""
    headers = _headers(token)
    try:
        with make_client(REPO_API, timeout=15) as client:
            r = client.get(REPO_API.format(full_name=full_name), headers=headers)
    except Exception as e:  # noqa: BLE001
        logger.warning("GitHub 仓库查询失败 %s: %s", full_name, e)
        return None

    if r.status_code == 404:
        # 仓库不存在是合法审计结论（占位/错误链接），不是异常
        return {"is_valid": False, "is_empty": False, "stars": 0,
                "language": "", "pushed_at": ""}
    if r.status_code == 403 and "rate limit" in r.text.lower():
        logger.warning("GitHub API 限流，%s 本轮跳过", full_name)
        return None
    if r.status_code != 200:
        logger.warning("GitHub HTTP %s: %s", r.status_code, full_name)
        return None

    try:
        data = r.json()
    except ValueError:
        return None

    result: dict[str, Any] = {
        "is_valid": True,
        "is_empty": False,
        "stars": int(data.get("stargazers_count") or 0),
        "language": data.get("language") or "",
        "pushed_at": data.get("pushed_at") or "",
    }

    # 空仓判定：default branch 无 commit（GitHub 对空仓库返回 409）。
    # 其余非 200 / 网络异常都无法判定，返回 None 本轮跳过——
    # 否则一次瞬时抖动会被误判为「空仓」并污染 7 天缓存。
    try:
        with make_client(COMMITS_API, timeout=15) as client:
            cr = client.get(COMMITS_API.format(full_name=full_name), headers=headers)
    except Exception:  # noqa: BLE001
        return None
    if cr.status_code == 409:
        result["is_empty"] = True
    elif cr.status_code != 200:
        return None
    return result


def code_status_for(paper: dict[str, Any], audits_used: list[int] | None = None) -> tuple[str, str, dict[str, Any] | None]:
    """论文条目 → (code_status, repo_url, repo_info)。

    三态：code_available / placeholder（存在但空仓或已删除）/ no_code。
    """
    repo = extract_repo_from_paper(paper)
    if not repo:
        return "no_code", "", None
    info = audit_repo(repo, audits_used)
    if info is None:
        # 审计异常：保守给 placeholder，链接仍保留展示
        return "placeholder", f"https://github.com/{repo}", None
    if not info["is_valid"]:
        return "placeholder", f"https://github.com/{repo}", info
    if info["is_empty"]:
        return "placeholder", f"https://github.com/{repo}", info
    return "code_available", f"https://github.com/{repo}", info


# ---------------------------------------------------------------------------
# 独立开源项目发现（不依附于论文）：关键词搜索 + 活跃/黑马过滤 + Star 增速排序
# 改造自 v1 github_digest（git 历史），网络调用全部在 SQLite 事务外完成。
# ---------------------------------------------------------------------------

SEARCH_API = "https://api.github.com/search/repositories"

# 只关注近期活跃的仓库：14 天内有提交，或 60 天内新建的黑马
_ACTIVE_PUSHED_DAYS = 14
_NEW_CREATED_DAYS = 60
# 最后提交超过该天数视为停更，坚决剔除
_STALE_PUSHED_DAYS = 30


def search_repositories(keywords: list[str], limit: int = 8) -> list[dict[str, Any]]:
    """按关键词发现独立开源项目，按增速评分倒序返回。

    两种查询（GitHub Search API）：
      1) 近 60 天新建且 star>5 的新星库（黑马）
      2) 近 14 天有活跃提交且 star>30 的热门库
    Star 增速：github_stars 表每日打点差分；首次见到的仓库按「star/库龄」估日均增速。
    """
    kws = [k.strip() for k in keywords if k.strip()]
    if not kws:
        return []

    now = _now()
    today = now.strftime("%Y-%m-%d")
    recent_pushed = (now - timedelta(days=_ACTIVE_PUSHED_DAYS)).strftime("%Y-%m-%d")
    recent_created = (now - timedelta(days=_NEW_CREATED_DAYS)).strftime("%Y-%m-%d")
    headers = _headers(_get_token())

    raw: dict[str, dict[str, Any]] = {}

    def _fetch(q: str) -> None:
        try:
            with make_client(SEARCH_API, timeout=30) as client:
                r = client.get(SEARCH_API, params={
                    "q": q, "sort": "stars", "order": "desc",
                    "per_page": min(10, limit),
                }, headers=headers)
        except Exception as e:  # noqa: BLE001
            logger.warning("GitHub 搜索失败（%s）: %s", q, e)
            return
        if r.status_code != 200:
            logger.warning("GitHub 搜索 HTTP %s（%s）", r.status_code, q)
            return
        try:
            for it in r.json().get("items", []):
                fn = (it.get("full_name") or "").strip()
                if fn and fn.lower() not in raw:
                    raw[fn.lower()] = it
        except ValueError:
            return

    # 每 Topic 至多取前 4 个关键词，避免搜索配额浪费（无 token 限流 10 次/分钟）
    for kw in kws[:4]:
        quoted = f'"{kw}"' if " " in kw else kw
        _fetch(f"{quoted} created:>{recent_created} stars:>5")
        _fetch(f"{quoted} pushed:>{recent_pushed} stars:>30")

    if not raw:
        return []

    results: list[dict[str, Any]] = []
    with db() as conn:
        for full_name, item in raw.items():
            pushed_str = item.get("pushed_at") or ""
            try:
                pushed_dt = datetime.fromisoformat(pushed_str.replace("Z", "+00:00"))
                if (now - pushed_dt).days > _STALE_PUSHED_DAYS:
                    continue
            except (ValueError, TypeError):
                pass

            stars = int(item.get("stargazers_count") or 0)

            # Star 打点（今日快照幂等 upsert）
            conn.execute(
                "INSERT INTO github_stars (full_name, date, stars) VALUES (?, ?, ?) "
                "ON CONFLICT(full_name, date) DO UPDATE SET stars=excluded.stars",
                (full_name, today, stars),
            )
            prev = conn.execute(
                "SELECT date, stars FROM github_stars WHERE full_name=? AND date<? "
                "ORDER BY date DESC LIMIT 1",
                (full_name, today),
            ).fetchone()

            growth = 0
            created_dt: datetime | None = None
            created_str = item.get("created_at") or ""
            try:
                created_dt = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                created_dt = None

            if prev:
                try:
                    prev_dt = datetime.strptime(prev["date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
                    days = max(1, (now - prev_dt).days)
                    growth = max(0, round((stars - prev["stars"]) / days))
                except ValueError:
                    growth = 0
            elif created_dt:
                age = max(1, (now - created_dt).days)
                growth = max(0, round(stars / age))

            new_bonus = 30.0 if created_dt and (now - created_dt).days <= _NEW_CREATED_DAYS else 0.0
            score = round(growth * 2.5 + min(80.0, stars / 30.0) + new_bonus, 2)

            results.append({
                "id": f"github:{full_name}",
                "title": item.get("full_name") or full_name,
                "url": item.get("html_url") or f"https://github.com/{full_name}",
                "description": (item.get("description") or "").strip(),
                "stars": stars,
                "star_growth": growth,
                "language": item.get("language") or "Other",
                "pushed_at": pushed_str,
                "created_at": created_str,
                "score": score,
            })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]
