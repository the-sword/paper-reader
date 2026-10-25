"""独立开源项目发现：搜索过滤、增速计算、管道集成、动作语义。"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from app.core.db import db
from app.services import radar, radar_github

NOW = datetime.now(timezone.utc)


def _gh_item(full_name: str, stars: int, pushed_days_ago: int = 1,
             created_days_ago: int = 20) -> dict:
    return {
        "full_name": full_name,
        "html_url": f"https://github.com/{full_name}",
        "description": f"Implementation of {full_name}",
        "stargazers_count": stars,
        "language": "Python",
        "pushed_at": (NOW - timedelta(days=pushed_days_ago)).isoformat(),
        "created_at": (NOW - timedelta(days=created_days_ago)).isoformat(),
    }


class _Resp:
    status_code = 200

    def __init__(self, items):
        self.text = "ok"
        self._items = items

    def json(self):
        return {"items": self._items}


class _Client:
    def __init__(self, items):
        self._items = items
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, params=None, headers=None):
        self.calls.append(params["q"])
        return _Resp(self._items)


def _patch_search(monkeypatch, items):
    client = _Client(items)
    monkeypatch.setattr(radar_github, "make_client", lambda url, timeout=30: client)
    monkeypatch.setattr(radar_github, "_get_token", lambda: "fake-token")
    return client


def test_search_filters_stale_and_scores(monkeypatch):
    """停更仓库剔除；评分排序；star 打点落 github_stars。"""
    _patch_search(monkeypatch, [
        _gh_item("active/cool", stars=600),                     # 活跃 + 较多 star
        _gh_item("stale/dead", stars=900, pushed_days_ago=90),  # 停更 → 剔除
    ])
    out = radar_github.search_repositories(["occupancy"], limit=5)
    ids = [r["id"] for r in out]
    assert "github:stale/dead" not in ids
    assert "github:active/cool" in ids
    with db() as conn:
        row = conn.execute(
            "SELECT stars FROM github_stars WHERE full_name='active/cool'"
        ).fetchone()
    assert row is not None and row["stars"] == 600


def test_search_growth_from_prev_snapshot(monkeypatch):
    """有历史打点时按差分算日增速。"""
    from app.core.db import db as _db

    yesterday = (NOW - timedelta(days=1)).strftime("%Y-%m-%d")
    with _db() as conn:
        conn.execute(
            "INSERT INTO github_stars (full_name, date, stars) VALUES ('x/grow', ?, 100)",
            (yesterday,),
        )
    _patch_search(monkeypatch, [_gh_item("x/grow", stars=150)])
    out = radar_github.search_repositories(["slam"], limit=5)
    assert out[0]["star_growth"] == 50  # (150-100)/1 天


def test_search_no_keywords_returns_empty():
    assert radar_github.search_repositories([], limit=5) == []


def test_pipeline_discovers_repos(topic_factory, pipeline_mocks):
    """管道集成：仓库条目落库 + digest_history 防重 + 归档含开源项目章节。"""
    topic_factory(keywords=["occupancy"])
    result = radar.run_pipeline(force=True)

    assert result["repos"] == 2
    with db() as conn:
        rows = conn.execute("SELECT * FROM radar_repo_items").fetchall()
        hist = conn.execute(
            "SELECT user_action FROM digest_history WHERE id='github:a/occfusion-lib'"
        ).fetchone()
    assert len(rows) == 2
    assert hist is not None and hist["user_action"] == "new"

    with open(result["archive"], encoding="utf-8") as f:
        text = f.read()
    assert "开源项目" in text
    assert "occfusion-lib" in text


def test_repo_budgets(topic_factory, pipeline_mocks, monkeypatch):
    """单 Topic 上限生效：每 Topic 至多 1 个，跨 Topic 去重（mock 只有 2 个不同仓库）。"""
    monkeypatch.setattr(radar, "MAX_REPOS_PER_TOPIC", 1)
    from app.services import radar_topics
    radar_topics.set_topics([
        {"id": "t1", "name": "A", "categories": ["cs.CV"], "keywords": ["occupancy"],
         "evaluation_focus": "", "min_score_to_show": 4},
        {"id": "t2", "name": "B", "categories": ["cs.LG"], "keywords": ["slam"],
         "evaluation_focus": "", "min_score_to_show": 4},
        {"id": "t3", "name": "C", "categories": ["cs.AI"], "keywords": ["nerf"],
         "evaluation_focus": "", "min_score_to_show": 4},
    ])
    result = radar.run_pipeline(force=True)
    assert result["repos"] == 2  # 3 个 Topic 各 1 个，但可用仓库仅 2 个（去重）
    with db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM radar_repo_items").fetchone()[0]
    assert n == 2


def test_repo_actions_visibility(topic_factory, pipeline_mocks):
    """save 保留徽章、dismiss 隐藏、restore 恢复；import 对仓库无意义返回 False。"""
    from app.services.radar import _today_bj
    topic_factory(keywords=["occupancy"])
    radar.run_pipeline(force=True)

    repos = radar.get_day_repos(_today_bj())
    assert len(repos) == 2
    rid = repos[0]["id"]
    assert rid.startswith("github:")

    assert radar.act_on_repo(rid, "save")
    assert radar.get_day_repos(_today_bj())[0]["action"] == "saved"

    assert radar.act_on_repo(rid, "dismiss")
    assert all(r["id"] != rid for r in radar.get_day_repos(_today_bj()))

    assert radar.act_on_repo(rid, "restore")
    assert any(r["id"] == rid for r in radar.get_day_repos(_today_bj()))

    # 仓库不适用导入；arxiv 前缀也不能走仓库动作
    assert not radar.act_on_repo(rid, "import")
    assert not radar.act_on_repo("arxiv:2410.00001", "save")


def test_repo_dismiss_still_searchable_in_future_runs(topic_factory, pipeline_mocks):
    """dismissed 仓库在后续管道轮次中被跳过（冷却/处置语义）。"""
    from app.services.radar import _today_bj
    topic_factory(keywords=["occupancy"])
    radar.run_pipeline(force=True)
    rid = radar.get_day_repos(_today_bj())[0]["id"]
    radar.act_on_repo(rid, "block")
    # 再跑一轮：被拉黑的仓库不再入选
    radar.run_pipeline(force=True)
    assert all(r["id"] != rid for r in radar.get_day_repos(_today_bj()))
