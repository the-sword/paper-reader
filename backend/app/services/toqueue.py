"""后台翻译队列：导入后自动排队生成双语 PDF。

设计要点（对应 2C2G VPS 的内存约束）：
  - **严格串行**：同时只跑 1 个 BabelDOC 任务（单任务峰值约 258MB），
    串行可把内存稳定控制在 300MB 以内，避免批量导入时 OOM
  - 失败不阻塞：某篇失败只记录状态，队列继续下一篇
  - 可取消：支持取消单个任务或清空队列
  - 状态持久化：队列状态存内存，单文档状态存 settings（重启后可知哪些已完成）

队列模型：
  pending  等待中（导入时自动加入）
  running  正在翻译
  done     已完成
  failed   失败（记录错误，可重试）
  skipped  已存在或无需处理
"""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from ..core.db import db


@dataclass
class QueueItem:
    doc_id: str
    title: str
    status: str = "pending"      # pending | running | done | failed | skipped
    error: str | None = None
    progress: float = 0.0
    added_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            "title": self.title,
            "status": self.status,
            "error": self.error,
            "progress": round(self.progress, 1),
            "added_at": self.added_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


_QUEUE: queue.Queue[str] = queue.Queue()
_ITEMS: dict[str, QueueItem] = {}
_LOCK = threading.Lock()
_WORKER: threading.Thread | None = None
_STOP = threading.Event()
_CANCEL_CURRENT = threading.Event()

# 是否启用自动入队（默认开启）
_ENABLED_KEY = "babeldoc.auto_queue.enabled"


def is_enabled() -> bool:
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?", (_ENABLED_KEY,)
        ).fetchone()
    if not row:
        return True  # 默认开启
    try:
        import json

        return bool(json.loads(row["value"]).get("enabled", True))
    except Exception:
        return True


def set_enabled(enabled: bool) -> None:
    import json

    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (_ENABLED_KEY, json.dumps({"enabled": enabled})),
        )


def enqueue(doc_id: str, title: str) -> bool:
    """加入队列。已存在或已完成则不重复入队。"""
    with _LOCK:
        existing = _ITEMS.get(doc_id)
        if existing and existing.status in ("pending", "running", "done"):
            return False
        item = QueueItem(doc_id=doc_id, title=title)
        _ITEMS[doc_id] = item
    _QUEUE.put(doc_id)
    _ensure_worker()
    return True


def _ensure_worker() -> None:
    global _WORKER
    with _LOCK:
        if _WORKER is None or not _WORKER.is_alive():
            _STOP.clear()
            _WORKER = threading.Thread(target=_worker_loop, name="babeldoc-queue", daemon=True)
            _WORKER.start()


def _worker_loop() -> None:
    """单线程串行消费队列。"""
    while not _STOP.is_set():
        try:
            doc_id = _QUEUE.get(timeout=1.0)
        except queue.Empty:
            continue

        with _LOCK:
            item = _ITEMS.get(doc_id)
        if not item or item.status != "pending":
            continue

        item.status = "running"
        item.started_at = time.time()
        _CANCEL_CURRENT.clear()

        try:
            _run_one(item)
            if _CANCEL_CURRENT.is_set():
                item.status = "skipped"
                item.error = "已取消"
            else:
                item.status = "done"
                item.progress = 100
        except Exception as e:  # noqa: BLE001
            # 失败不阻塞队列
            item.status = "failed"
            item.error = str(e)[:300]
        finally:
            item.finished_at = time.time()


def _run_one(item: QueueItem) -> None:
    """实际执行一篇的双语 PDF 生成。"""
    from pathlib import Path

    from . import babeldoc as bd
    from . import library

    # 文档可能已被删除，直接跳过，避免白跑一次翻译（浪费 API 费用）
    if not library.get_document(item.doc_id):
        item.status = "skipped"
        item.error = "文档已删除"
        return

    pdf = library.pdf_path_of(item.doc_id)
    if not pdf:
        raise RuntimeError("PDF 文件缺失")

    # 已存在则跳过
    if bd.get_babeldoc_pdf(item.doc_id):
        item.status = "skipped"
        item.error = "已存在"
        return

    def on_progress(pct: float, msg: str) -> None:
        if pct > 0:
            item.progress = max(item.progress, pct)

    import asyncio

    async def _a():
        return await bd.translate_pdf_async(
            item.doc_id, Path(pdf), pages=None,
            on_progress=on_progress, cancel_event=_CANCEL_CURRENT,
        )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_a())
    finally:
        loop.close()


def cancel_current() -> bool:
    _CANCEL_CURRENT.set()
    return True


def cancel(doc_id: str) -> bool:
    """取消某篇（排队中的直接标记，运行中的发取消信号）。"""
    with _LOCK:
        item = _ITEMS.get(doc_id)
        if not item:
            return False
        if item.status == "pending":
            item.status = "skipped"
            item.error = "已取消"
            return True
        if item.status == "running":
            _CANCEL_CURRENT.set()
            return True
    return False


def retry(doc_id: str, title: str) -> bool:
    with _LOCK:
        item = _ITEMS.get(doc_id)
        if item and item.status == "running":
            return False
    return enqueue(doc_id, title)


def snapshot() -> dict[str, Any]:
    """返回队列全貌，供前端展示。"""
    with _LOCK:
        items = [i.to_dict() for i in _ITEMS.values()]
    # 排序：运行中 → 等待中 → 已完成
    order = {"running": 0, "pending": 1, "failed": 2, "skipped": 3, "done": 4}
    items.sort(key=lambda x: (order.get(x["status"], 9), x["added_at"]))
    counts: dict[str, int] = {}
    for i in items:
        counts[i["status"]] = counts.get(i["status"], 0) + 1
    return {
        "enabled": is_enabled(),
        "counts": counts,
        "queue_size": _QUEUE.qsize(),
        "items": items[:50],
    }


def clear_finished() -> int:
    """清理已完成/跳过的记录。"""
    n = 0
    with _LOCK:
        for k in [k for k, v in _ITEMS.items() if v.status in ("done", "skipped")]:
            _ITEMS.pop(k, None)
            n += 1
    return n
