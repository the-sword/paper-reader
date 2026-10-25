"""收件箱四动作模型：save / dismiss / block / restore 的展示语义。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import db
from app.services import radar


def _today_bj() -> str:
    from app.services.radar import _today_bj
    return _today_bj()


def _insert_paper(pid: str, title: str = "T", score: float = 5,
                  code: str = "no_code") -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO radar_papers (id, topic_id, title, authors, abstract,"
            " categories, published, code_status, repo_url, review_status, review,"
            " score, archived, first_seen) VALUES (?, 't1', ?, '[]', '', '[]', '',"
            " ?, '', 'reviewed', '{}', ?, 0, ?)",
            (pid, title, code, score, datetime.now(timezone.utc).isoformat()),
        )


def _actions_of(day: dict) -> dict[str, str]:
    return {p["id"]: p.get("action", "new")
            for arr in day.values() for p in arr}


def test_save_keeps_visible_with_badge(topic_factory):
    topic_factory()
    _insert_paper("arxiv:1", "Saved Paper")
    assert radar.act_on_paper("arxiv:1", "save")
    day = radar.get_day(_today_bj())
    assert _actions_of(day)["arxiv:1"] == "saved"


def test_unsave_returns_to_new(topic_factory):
    topic_factory()
    _insert_paper("arxiv:1")
    radar.act_on_paper("arxiv:1", "save")
    assert radar.act_on_paper("arxiv:1", "unsave")
    assert _actions_of(radar.get_day(_today_bj()))["arxiv:1"] == "new"


def test_dismiss_hides_but_not_permanent_block(topic_factory):
    topic_factory()
    _insert_paper("arxiv:1")
    radar.act_on_paper("arxiv:1", "dismiss")
    assert "arxiv:1" not in _actions_of(radar.get_day(_today_bj()))
    # dismissed 不是永久拉黑：_is_blocked 只认 ignored/imported（30 天后不再拦截）
    history = radar._history_map()
    far_future = datetime.now(timezone.utc) + timedelta(days=30)
    assert not radar._is_blocked("arxiv:1", history, far_future)


def test_restore_shows_dismissed_again(topic_factory):
    topic_factory()
    _insert_paper("arxiv:1")
    radar.act_on_paper("arxiv:1", "dismiss")
    radar.act_on_paper("arxiv:1", "restore")
    assert "arxiv:1" in _actions_of(radar.get_day(_today_bj()))


def test_block_is_permanent(topic_factory):
    topic_factory()
    _insert_paper("arxiv:1")
    radar.act_on_paper("arxiv:1", "block")
    assert "arxiv:1" not in _actions_of(radar.get_day(_today_bj()))
    # 30 天后依然拦截（永久）
    history = radar._history_map()
    assert radar._is_blocked("arxiv:1", history, datetime.now(timezone.utc) + timedelta(days=30))


def test_legacy_ignore_alias_still_blocks(topic_factory):
    topic_factory()
    _insert_paper("arxiv:1")
    assert radar.act_on_paper("arxiv:1", "ignore")
    assert "arxiv:1" not in _actions_of(radar.get_day(_today_bj()))


def test_imported_stays_visible_grayed(topic_factory):
    """导入不隐藏：卡片保留展示（前端灰化 + 打开阅读）。"""
    topic_factory()
    _insert_paper("arxiv:1")
    radar.act_on_paper("arxiv:1", "import")
    day = radar.get_day(_today_bj())
    assert _actions_of(day)["arxiv:1"] == "imported"


def test_invalid_action_rejected(topic_factory):
    topic_factory()
    _insert_paper("arxiv:1")
    assert not radar.act_on_paper("arxiv:1", "explode")
    assert not radar.act_on_paper("arxiv:not-exist", "save")


def test_selection_rule_code_bonus(topic_factory):
    """score 达阈值入选；code_available 且 score=阈值-1 也入选。"""
    topic_factory(min_score=4)
    _insert_paper("arxiv:plain-4", score=4)
    _insert_paper("arxiv:plain-3", score=3)          # 无代码 3 分 → 不入选
    _insert_paper("arxiv:code-3", score=3, code="code_available")  # 代码加分 → 入选
    ids = set(_actions_of(radar.get_day(_today_bj())))
    assert "arxiv:plain-4" in ids
    assert "arxiv:code-3" in ids
    assert "arxiv:plain-3" not in ids


def test_get_day_utc_window_matches_bj_date(topic_factory):
    """get_day 的 UTC 窗口预过滤：BJ 日期 D 覆盖 UTC [D-1 16:00, D+1 16:00)。"""
    topic_factory()

    def _insert_at(pid: str, ts: datetime):
        with db() as conn:
            conn.execute(
                "INSERT INTO radar_papers (id, topic_id, title, authors, abstract,"
                " categories, published, code_status, repo_url, review_status, review,"
                " score, archived, first_seen) VALUES (?, 't1', ?, '[]', '', '[]', '',"
                " 'no_code', '', 'reviewed', '{}', 5, 0, ?)",
                (pid, pid, ts.isoformat()),
            )

    d = datetime.strptime(_today_bj(), "%Y-%m-%d")
    # UTC 昨天 17:00 → 北京今天（窗口内）；UTC 昨天 15:00 → 北京昨天（窗口外）
    _insert_at("arxiv:in-window",
               datetime(d.year, d.month, d.day, 17, 0, tzinfo=timezone.utc)
               - timedelta(days=1))
    _insert_at("arxiv:out-window",
               datetime(d.year, d.month, d.day, 15, 0, tzinfo=timezone.utc)
               - timedelta(days=1))

    ids = set(_actions_of(radar.get_day(_today_bj())))
    assert "arxiv:in-window" in ids, "UTC 昨天 17:00 属于北京今天"
    assert "arxiv:out-window" not in ids, "UTC 昨天 15:00 属于北京昨天"
    # 非法日期不崩溃（回退全量路径）
    assert isinstance(radar.get_day("bad-date"), dict)


def test_day_usage_and_posting_day(topic_factory):
    topic_factory()
    _insert_paper("arxiv:1")
    usage = radar.day_usage(_today_bj())
    assert usage["reviewed"] >= 1
    # 周末必为空日：2026-10-24 是周六、2026-10-26 是周一
    import datetime as _dt
    assert _dt.date(2026, 10, 24).weekday() == 5
    assert radar.is_posting_day("2026-10-24") is False
    assert radar.is_posting_day("2026-10-26") is True
    assert radar.is_posting_day("bad-date") is True  # 解析失败按发文日处理
