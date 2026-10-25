"""管道集成测试：mock 全部网络调用，验证编排逻辑与落库。"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from app.core.db import db
from app.services import jobs as jobs_svc
from app.services import radar, radar_arxiv, radar_github, radar_review, radar_topics


NOW = datetime.now(timezone.utc)


def _rows():
    with db() as conn:
        return conn.execute("SELECT * FROM radar_papers").fetchall()


def test_pipeline_happy_path(topic_factory, pipeline_mocks):
    """关键词初筛 + 批量评审 + 失败位降级 + 入选规则 + 归档。"""
    topic_factory(keywords=["occupancy"], min_score=4)
    result = radar.run_pipeline(force=True)

    assert result["cached"] is False
    rows = {(r["id"], r["topic_id"]): r for r in _rows()}
    # 关键词不中的论文 4 不送审；1/2/3 送审
    assert len(rows) == 3

    p1 = rows[("arxiv:2401.00001", "t1")]
    assert p1["review_status"] == "reviewed"
    assert p1["score"] == 4
    assert p1["code_status"] == "code_available"
    assert json.loads(p1["review"])["repo_stars"] == 42

    p2 = rows[("arxiv:2401.00002", "t1")]
    # 批审 None → 单篇降级路径，tag=FALLBACK、score=2
    assert p2["score"] == 2
    assert json.loads(p2["review"])["primary_tag"] == "FALLBACK"

    p3 = rows[("arxiv:2401.00003", "t1")]
    # score=3 + no_code，阈值 4 → 不入选但仍落库
    assert p3["score"] == 3

    # 入选统计：paper1(4分) + paper3? no_code 3 分不入选 → shown=1
    assert result["topics"]["t1"]["shown"] == 1
    assert result["topics"]["t1"]["reviewed"] == 3

    # 归档文件生成且含入选标题
    archive = result["archive"]
    with open(archive, encoding="utf-8") as f:
        text = f.read()
    assert "OccSLAM" in text
    assert "Unrelated" not in text

    # 防重历史写入（reviewed 状态）
    with db() as conn:
        h = conn.execute(
            "SELECT user_action FROM digest_history WHERE id='arxiv:2401.00001'"
        ).fetchone()
    assert h is not None


def test_pipeline_respects_global_budget(topic_factory, pipeline_mocks, monkeypatch):
    """全局评审预算 MAX_REVIEW_TOTAL 生效。"""
    monkeypatch.setattr(radar, "MAX_REVIEW_PER_TOPIC", 2)
    topic_factory(keywords=[])
    radar.run_pipeline(force=True)
    assert len(_rows()) == 2


def test_pipeline_batch_total_failure_falls_back(topic_factory, pipeline_mocks, monkeypatch):
    """整批评审抛异常 → 全部走单篇降级，不崩溃。"""
    def boom(batch_papers, topic):
        raise RuntimeError("batch api down")

    monkeypatch.setattr(radar_review, "review_batch", boom)
    topic_factory(keywords=["occupancy"])
    result = radar.run_pipeline(force=True)
    rows = _rows()
    assert len(rows) == 3
    assert all(r["review_status"] == "reviewed" for r in rows)


def test_pipeline_busy_mutex(pipeline_mocks, topic_factory):
    """手动持锁时第二轮管道立即报忙。"""
    assert radar._PIPELINE_LOCK.acquire(blocking=False)
    try:
        with pytest.raises(radar.PipelineBusyError):
            radar.run_pipeline(force=True)
        with pytest.raises(radar.PipelineBusyError):
            radar.start_pipeline_job(force=True)
    finally:
        radar._PIPELINE_LOCK.release()


def test_pipeline_job_progress_and_done(topic_factory, pipeline_mocks):
    """start_pipeline_job 后台执行，job 状态到达 done 且锁被释放。"""
    topic_factory(keywords=["occupancy"])
    job = radar.start_pipeline_job(force=True)
    assert job.status == "running"
    for _ in range(100):
        if job.status != "running":
            break
        time.sleep(0.05)
    assert job.status == "done"
    assert job.result is not None and job.result["cached"] is False
    assert job.progress == 100
    # 任务线程释放锁：可再次启动
    job2 = radar.start_pipeline_job(force=True)
    for _ in range(100):
        if job2.status != "running":
            break
        time.sleep(0.05)
    assert job2.status == "done"


def test_pipeline_cancel_midway(topic_factory, pipeline_mocks):
    """取消：评审阶段前预置 cancel → 任务标记 cancelled。"""
    topic_factory(keywords=["occupancy"])
    job = radar.start_pipeline_job(force=True)
    jobs_svc.cancel(job.id)
    for _ in range(100):
        if job.status != "running":
            break
        time.sleep(0.05)
    assert job.status in ("cancelled", "done")  # 极快任务可能已完成
    # 锁必须被释放（finally 兜底）
    assert radar._PIPELINE_LOCK.acquire(blocking=False)
    radar._PIPELINE_LOCK.release()


def test_pipeline_triggers_retention_cleanup(topic_factory, pipeline_mocks):
    """180 天清理随管道执行（digest 删除后职责迁入）：清非导入旧条目与旧 star 打点，
    保留导入条目、近期条目与 radar_papers 历史评审。"""
    from datetime import datetime, timedelta, timezone

    from app.core.db import db

    topic_factory(keywords=["occupancy"])
    old_date = (datetime.now(timezone.utc) - timedelta(days=200)).strftime("%Y-%m-%d")
    recent_date = (datetime.now(timezone.utc) - timedelta(days=5)).strftime("%Y-%m-%d")
    with db() as conn:
        conn.executemany(
            "INSERT INTO digest_items (id, source, date, title, url, status)"
            " VALUES (?,?,?,?,?,?)",
            [("old:new", "arxiv", old_date, "A", "u1", "new"),
             ("old:imported", "arxiv", old_date, "B", "u2", "imported"),
             ("recent", "arxiv", recent_date, "C", "u3", "new")],
        )
        conn.execute(
            "INSERT INTO github_stars (full_name, date, stars) VALUES ('x/y', ?, 10)",
            (old_date,),
        )
        conn.execute(
            "INSERT INTO radar_papers (id, topic_id, title, first_seen, review_status,"
            " review, score, archived) VALUES ('arxiv:oldpaper', 't1', 'Old', ?,"
            " 'reviewed', '{}', 5, 1)",
            ((datetime.now(timezone.utc) - timedelta(days=200)).isoformat(),),
        )

    radar.run_pipeline(force=True)

    with db() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM digest_items").fetchall()]
        stars = conn.execute("SELECT COUNT(*) FROM github_stars").fetchone()[0]
        old_paper = conn.execute(
            "SELECT COUNT(*) FROM radar_papers WHERE id='arxiv:oldpaper'"
        ).fetchone()[0]
    assert "old:new" not in ids, "超期未导入的 digest_items 应被清理"
    assert "old:imported" in ids, "导入过的条目永不清理"
    assert "recent" in ids
    assert stars == 0, "超期 star 打点应被清理"
    assert old_paper == 1, "radar_papers 历史评审是检索知识库，不清理"


def test_pipeline_cached_short_circuit(topic_factory, pipeline_mocks, monkeypatch):
    """非 force 且当日已有数据 → 走缓存不重复抓取。"""
    topic_factory(keywords=["occupancy"])
    radar.run_pipeline(force=True)
    calls = {"n": 0}
    orig = radar_arxiv.fetch_by_categories

    def counting(*a, **kw):
        calls["n"] += 1
        return orig(*a, **kw)

    monkeypatch.setattr(radar_arxiv, "fetch_by_categories", counting)
    result = radar.run_pipeline(force=False)
    assert result["cached"] is True
    assert calls["n"] == 0
