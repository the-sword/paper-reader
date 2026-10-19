"""后台任务管理：让长耗时操作（如 AI 总结）可取消。

为什么需要：
  AI 生成可能耗时数十秒到两分钟。同步 HTTP 请求期间用户只能干等，
  既无法中断，也无法看到中间进度。

设计：
  - 任务在独立线程中执行，接口立即返回 job_id
  - 前端轮询状态（running/done/failed/cancelled）
  - 取消通过 threading.Event 通知工作线程：空闲与退避期间立即生效，
    已发出的 HTTP 请求会在该请求返回后停止（无法中途切断 socket）
  - 任务保留一段时间供查询，过期自动清理
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

# 已完成任务保留时长（秒）
_RETAIN = 3600


@dataclass
class Job:
    id: str
    kind: str
    status: str = "running"          # running | done | failed | cancelled
    progress: float = 0.0
    message: str = ""
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 1),
            "message": self.message,
            "result": self.result,
            "error": self.error,
        }


_JOBS: dict[str, Job] = {}
_LOCK = threading.Lock()


def _gc() -> None:
    """清理过期任务。"""
    now = time.time()
    with _LOCK:
        stale = [
            jid for jid, j in _JOBS.items()
            if j.finished_at and now - j.finished_at > _RETAIN
        ]
        for jid in stale:
            _JOBS.pop(jid, None)


def start(kind: str, fn: Callable[[Job], dict[str, Any]]) -> Job:
    """启动一个后台任务。fn 接收 Job，可读取 job.cancel 判断是否取消。"""
    _gc()
    job = Job(id=str(uuid.uuid4()), kind=kind)
    with _LOCK:
        _JOBS[job.id] = job

    def _run() -> None:
        try:
            job.progress = 10
            job.message = "准备中"
            result = fn(job)
            if job.cancel.is_set():
                job.status = "cancelled"
                job.message = "已取消"
            else:
                job.status = "done"
                job.progress = 100
                job.message = "完成"
                job.result = result
        except Exception as e:  # noqa: BLE001
            from .translate import Cancelled

            if isinstance(e, Cancelled) or job.cancel.is_set():
                job.status = "cancelled"
                job.message = "已取消"
            else:
                job.status = "failed"
                job.error = str(e)[:500]
                job.message = "失败"
        finally:
            job.finished_at = time.time()

    threading.Thread(target=_run, name=f"job-{kind}", daemon=True).start()
    return job


def get(job_id: str) -> Job | None:
    with _LOCK:
        return _JOBS.get(job_id)


def cancel(job_id: str) -> bool:
    job = get(job_id)
    if not job:
        return False
    if job.status != "running":
        return False
    job.cancel.set()
    job.message = "正在取消…"
    # 若任务尚未真正开始，立即标记（工作线程也会看到 cancel 标志）
    return True


def active_count() -> int:
    with _LOCK:
        return sum(1 for j in _JOBS.values() if j.status == "running")
