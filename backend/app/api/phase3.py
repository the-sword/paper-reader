"""阶段三 API：划词翻译、AI 总结、WebDAV 备份。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import backup as backup_svc
from ..services import jobs as jobs_svc
from ..services import glossary_cache as term_svc
from ..services import library
from ..services import prefs as prefs_svc
from ..services import summarize as sum_svc

router = APIRouter()


# ---------------------------------------------------------------------------
# 划词翻译
# ---------------------------------------------------------------------------

class TermReq(BaseModel):
    text: str
    engine: str | None = None


@router.post("/term")
def translate_term(body: TermReq) -> dict[str, Any]:
    try:
        r = term_svc.translate_term(body.text, body.engine)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e
    return {
        "source": r.source,
        "text": r.text,
        "engine": r.engine,
        "latency_ms": r.latency_ms,
        "cached": r.cached,
        "meta": r.meta,
    }


@router.get("/term/stats")
def term_stats() -> dict[str, Any]:
    return term_svc.cache_stats()


@router.post("/term/cache/clear")
def clear_term_cache() -> dict[str, Any]:
    n = term_svc.clear_cache()
    return {"ok": True, "cleared": n}


# ---------------------------------------------------------------------------
# AI 总结
# ---------------------------------------------------------------------------

class SummaryReq(BaseModel):
    kind: str
    question: str | None = None


@router.get("/summary/kinds")
def summary_kinds() -> dict[str, Any]:
    return {"kinds": sum_svc.available_kinds()}


@router.post("/summary/{doc_id}/start")
def start_summary(doc_id: str, body: SummaryReq) -> dict[str, Any]:
    """启动总结任务，立即返回 job_id。前端轮询进度，可随时取消。"""
    if not library.get_document(doc_id):
        raise HTTPException(404, "文献不存在")
    if body.kind not in sum_svc.TEMPLATES and body.kind != "qa":
        raise HTTPException(400, f"未知的总结类型：{body.kind}")
    if body.kind == "qa" and not (body.question or "").strip():
        raise HTTPException(400, "提问内容不能为空")

    def _work(job: jobs_svc.Job) -> dict[str, Any]:
        job.progress = 20
        job.message = "读取正文"
        if job.cancel.is_set():
            from ..services.translate import Cancelled

            raise Cancelled("已取消")
        job.progress = 35
        job.message = "等待 AI 响应（首次较慢，通常 10-30 秒）"

        def _on_chars(n: int) -> None:
            # 35% 起步：收到首字后跳到 45%，再按字符数平滑推进到 95%
            job.progress = min(95, 45 + n / 60)
            job.message = f"AI 生成中（已生成 {n} 字）"

        return sum_svc.generate(
            doc_id, body.kind, body.question,
            cancel_event=job.cancel, on_progress=_on_chars,
        )

    job = jobs_svc.start("summary", _work)
    return {"job_id": job.id, "status": job.status}


@router.get("/summary/job/{job_id}")
def summary_job_status(job_id: str) -> dict[str, Any]:
    job = jobs_svc.get(job_id)
    if not job:
        raise HTTPException(404, "任务不存在或已过期")
    return job.to_dict()


@router.post("/summary/job/{job_id}/cancel")
def cancel_summary_job(job_id: str) -> dict[str, Any]:
    ok = jobs_svc.cancel(job_id)
    job = jobs_svc.get(job_id)
    return {"ok": ok, "status": job.status if job else "not_found"}


@router.post("/summary/{doc_id}")
def create_summary_sync(doc_id: str, body: SummaryReq) -> dict[str, Any]:
    """同步生成（保留兼容，前端已改用任务式）。"""
    if not library.get_document(doc_id):
        raise HTTPException(404, "文献不存在")
    try:
        return sum_svc.generate(doc_id, body.kind, body.question)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e


@router.get("/summary/{doc_id}")
def list_summaries(doc_id: str) -> dict[str, Any]:
    return {"summaries": sum_svc.list_summaries(doc_id)}


@router.delete("/summary/item/{summary_id}")
def delete_summary(summary_id: str) -> dict[str, Any]:
    sum_svc.delete_summary(summary_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# WebDAV 备份
# ---------------------------------------------------------------------------

class WebDAVReq(BaseModel):
    url: str | None = None
    username: str | None = None
    password: str | None = None
    file_name: str | None = None


class BackupReq(BaseModel):
    include_pdfs: bool = False
    password: str | None = None   # 非空则加密归档


class RestoreReq(BaseModel):
    password: str | None = None


@router.get("/backup/config")
def read_backup_config() -> dict[str, Any]:
    return backup_svc.public_config()


@router.post("/backup/config")
def write_backup_config(body: WebDAVReq) -> dict[str, Any]:
    backup_svc.save_webdav_config(body.model_dump(exclude_none=True))
    return {"ok": True}


@router.post("/backup/test")
def test_backup() -> dict[str, Any]:
    return backup_svc.test_connection()


@router.post("/backup/run")
def run_backup(body: BackupReq) -> dict[str, Any]:
    try:
        return backup_svc.backup(include_pdfs=body.include_pdfs, password=body.password)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e


@router.get("/backup/remote")
def remote_info() -> dict[str, Any]:
    try:
        return backup_svc.list_remote()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e


@router.post("/backup/restore")
def restore_backup(body: RestoreReq | None = None) -> dict[str, Any]:
    try:
        return backup_svc.restore(password=body.password if body else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e


# ---------------------------------------------------------------------------
# 界面偏好（翻译模式等）
# ---------------------------------------------------------------------------

class PrefsReq(BaseModel):
    values: dict[str, Any]



@router.get("/prefs")
def read_prefs() -> dict[str, Any]:
    return {"values": prefs_svc.get_all()}



@router.post("/prefs")
def write_prefs(body: PrefsReq) -> dict[str, Any]:
    return {"ok": True, "values": prefs_svc.set_many(body.values)}
