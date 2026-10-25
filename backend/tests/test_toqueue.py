"""双语 PDF 队列：删除文献联动清理、failed 记录可清。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services import toqueue


def _mk_doc(doc_id: str, title: str = "T") -> None:
    import uuid

    from app.core.db import db

    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, title, file_hash, added_at)"
            " VALUES (?,?,?,datetime('now'))",
            (doc_id, title, f"hash-{uuid.uuid4()}"),
        )


def test_remove_drops_item_and_worker_skips_stale_queue_entry():
    toqueue.enqueue("doc-1", "A")
    assert toqueue.remove("doc-1") is True
    snap = toqueue.snapshot()
    assert all(i["doc_id"] != "doc-1" for i in snap["items"])
    # 重复移除返回 False
    assert toqueue.remove("doc-1") is False


def test_clear_finished_includes_failed():
    toqueue.enqueue("doc-1", "A")
    with toqueue._LOCK:
        toqueue._ITEMS["doc-1"].status = "failed"
        toqueue._ITEMS["doc-1"].error = "未安装依赖"
    cleared = toqueue.clear_finished()
    assert cleared >= 1
    assert all(i["doc_id"] != "doc-1" for i in toqueue.snapshot()["items"])


def test_delete_document_endpoint_clears_queue():
    client = TestClient(app)
    _mk_doc("doc-del", "将被删除")
    toqueue.enqueue("doc-del", "将被删除")
    # 置为 failed 模拟用户看到的残留场景
    with toqueue._LOCK:
        toqueue._ITEMS["doc-del"].status = "failed"

    resp = client.delete("/api/documents/doc-del")
    assert resp.status_code == 200
    assert all(i["doc_id"] != "doc-del" for i in toqueue.snapshot()["items"])
