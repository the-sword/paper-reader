"""API 层测试：任务化刷新、看板元数据、四动作端点、digest 路由已移除。"""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import radar


@pytest.fixture()
def client(pipeline_mocks, topic_factory):  # noqa: ARG001
    topic_factory(keywords=["occupancy"])
    # TestClient 不用 with：不触发 lifespan，避免启动调度器线程
    return TestClient(app)


def _wait_job(client, job_id, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get(f"/api/radar/pipeline/{job_id}").json()
        if data["status"] != "running":
            return data
        time.sleep(0.05)
    raise AssertionError("job 超时未结束")


def test_refresh_returns_job_and_completes(client):
    resp = client.post("/api/radar/refresh")
    assert resp.status_code == 200
    job_id = resp.json()["job_id"]
    data = _wait_job(client, job_id)
    assert data["status"] == "done"
    assert data["progress"] == 100
    assert data["result"]["cached"] is False


def test_refresh_conflict_when_busy(client):
    assert radar._PIPELINE_LOCK.acquire(blocking=False)
    try:
        resp = client.post("/api/radar/refresh")
        assert resp.status_code == 409
    finally:
        radar._PIPELINE_LOCK.release()


def test_unknown_pipeline_job_404(client):
    assert client.get("/api/radar/pipeline/nope").status_code == 404


def test_today_payload_metadata(client):
    resp = client.post("/api/radar/refresh")
    data = _wait_job(client, resp.json()["job_id"])
    assert data["status"] == "done"

    today = client.get("/api/radar/today").json()
    assert {"date", "topics", "total", "is_posting_day", "prev_date", "usage"} <= set(today)
    assert isinstance(today["usage"]["reviewed"], int)
    papers = [p for arr in today["topics"].values() for p in arr]
    assert papers, "应至少有一篇入选论文"
    assert all("action" in p for p in papers)


def test_action_endpoints_change_visibility(client):
    resp = client.post("/api/radar/refresh")
    _wait_job(client, resp.json()["job_id"])
    today = client.get("/api/radar/today").json()
    pid = next(p["id"] for arr in today["topics"].values() for p in arr)

    # save → 仍在看板，action=saved
    assert client.post(f"/api/radar/{pid}/action",
                       json={"action": "save"}).status_code == 200
    today = client.get("/api/radar/today").json()
    p = next(p for arr in today["topics"].values() for p in arr if p["id"] == pid)
    assert p["action"] == "saved"

    # unsave → action=new
    client.post(f"/api/radar/{pid}/action", json={"action": "unsave"})
    today = client.get("/api/radar/today").json()
    p = next(p for arr in today["topics"].values() for p in arr if p["id"] == pid)
    assert p["action"] == "new"

    # dismiss → 从看板消失，但检索仍可命中（FTS 按词匹配，用完整词检索）
    client.post(f"/api/radar/{pid}/action", json={"action": "dismiss"})
    today = client.get("/api/radar/today").json()
    ids = [p["id"] for arr in today["topics"].values() for p in arr]
    assert pid not in ids
    search = client.get("/api/radar/search", params={"q": "occupancy"}).json()
    assert any(x["id"] == pid for x in search["items"])

    # restore → 回到看板
    client.post(f"/api/radar/{pid}/action", json={"action": "restore"})
    today = client.get("/api/radar/today").json()
    ids = [p["id"] for arr in today["topics"].values() for p in arr]
    assert pid in ids


def test_invalid_action_400(client):
    resp = client.post("/api/radar/refresh")
    _wait_job(client, resp.json()["job_id"])
    today = client.get("/api/radar/today").json()
    pid = next(p["id"] for arr in today["topics"].values() for p in arr)
    assert client.post(f"/api/radar/{pid}/action",
                       json={"action": "explode"}).status_code == 400


def test_config_roundtrip_and_yaml(client):
    resp = client.post("/api/radar/config", json={
        "topics": [{
            "id": "edge_ai", "name": "端侧", "categories": ["cs.CV"],
            "keywords": ["npu"], "evaluation_focus": "", "min_score_to_show": 4,
        }],
        "scheduler_enabled": False,
    })
    assert resp.status_code == 200
    assert resp.json()["scheduler_enabled"] is False

    exported = client.get("/api/radar/config/export").text
    assert "edge_ai" in exported

    imported = client.post("/api/radar/config/import",
                           json={"text": exported}).json()
    assert imported["imported"] >= 1


def test_digest_routes_removed(client):
    """digest v1 全链路删除：GET 路由必须 404（未知 POST 会被静态挂载答 405）。"""
    assert client.get("/api/digest/today").status_code == 404
    assert client.get("/api/digest/config").status_code == 404


def test_today_includes_repos(client):
    """独立开源项目：today 返回 repos，动作端点按 github: 前缀路由。"""
    resp = client.post("/api/radar/refresh")
    _wait_job(client, resp.json()["job_id"])
    today = client.get("/api/radar/today").json()
    assert today["repos_total"] >= 1
    rid = today["repos"][0]["id"]
    assert rid.startswith("github:")

    # save → 仍可见且 action=saved
    assert client.post(f"/api/radar/{rid}/action",
                       json={"action": "save"}).status_code == 200
    today = client.get("/api/radar/today").json()
    r = next(x for x in today["repos"] if x["id"] == rid)
    assert r["action"] == "saved"

    # dismiss → 从看板消失
    client.post(f"/api/radar/{rid}/action", json={"action": "dismiss"})
    today = client.get("/api/radar/today").json()
    assert all(x["id"] != rid for x in today["repos"])

    # 仓库不适用导入
    assert client.post(f"/api/radar/{rid}/action",
                       json={"action": "import"}).status_code == 400
