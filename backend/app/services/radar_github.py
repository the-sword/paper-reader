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
# 审计异常结果的重试间隔（更短，尽快纠正）
ERROR_RETRY_HOURS = 24
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
            is_error_row = row["is_valid"] is None
            max_age = timedelta(hours=ERROR_RETRY_HOURS) if is_error_row else timedelta(days=CACHE_DAYS)
            if now - checked < max_age:
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

    # 空仓判定：default branch 是否存在 commit（409 = 空仓库）
    try:
        with make_client(COMMITS_API, timeout=15) as client:
            cr = client.get(COMMITS_API.format(full_name=full_name), headers=headers)
        result["is_empty"] = cr.status_code != 200
    except Exception:  # noqa: BLE001
        result["is_empty"] = True
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
