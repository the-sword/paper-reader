"""阶段三 API：划词翻译、AI 总结、WebDAV 备份。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import backup as backup_svc
from ..services import babeldoc as babeldoc_svc
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


# ---------------------------------------------------------------------------
# 双语 PDF（BabelDOC，ReadPaper 式体验）
# ---------------------------------------------------------------------------

class BabelDocReq(BaseModel):
    pages: str | None = None      # 如 "1-5"，空则全部


@router.post("/babeldoc/{doc_id}/start")
def start_babeldoc(doc_id: str, body: BabelDocReq) -> dict[str, Any]:
    """启动 BabelDOC 双语 PDF 翻译任务。立即返回 job_id，可轮询/取消。"""
    if not library.get_document(doc_id):
        raise HTTPException(404, "文献不存在")
    pdf = library.pdf_path_of(doc_id)
    if not pdf:
        raise HTTPException(404, "PDF 文件缺失")

    # 确认 AI 可用
    cfg = babeldoc_svc.get_ai_config_for_babeldoc()

    import threading as _th

    def _work(job: jobs_svc.Job) -> dict[str, Any]:
        job.progress = 15
        job.message = "BabelDOC 解析与翻译中（视论文长度 1-5 分钟）"

        # BabelDOC 的 overall_progress 分阶段会回跳，只取历史最大值
        _max_seen = [15.0]

        def _on_progress_only(pct: float, msg: str) -> None:
            _max_seen[0] = max(_max_seen[0], pct)
            job.progress = min(95, _max_seen[0])
            if msg:
                job.message = msg
        try:
            from app.services.babeldoc import translate_pdf_async

            # translate_pdf_async 是异步的，在线程里跑新 loop
            result_box: dict[str, Any] = {}
            error_box: dict[str, BaseException | None] = {"e": None}

            def _runner():
                import asyncio

                async def _a():
                    return await babeldoc_svc.translate_pdf_async(
                        doc_id, pdf, pages=body.pages,
                        on_progress=_on_progress_only,
                        cancel_event=job.cancel,
                    )
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    result_box["r"] = loop.run_until_complete(_a())
                except BaseException as ex:  # noqa: BLE001
                    error_box["e"] = ex
                finally:
                    loop.close()

            t = _th.Thread(target=_runner, name="babeldoc-translate", daemon=True)
            t.start()
            while t.is_alive():
                t.join(timeout=0.5)
                if job.cancel.is_set():
                    break
            if error_box["e"]:
                raise error_box["e"]

            job.progress = 100
            return result_box["r"]
        except Exception as e:  # noqa: BLE001
            from ..services.translate import Cancelled

            if isinstance(e, Cancelled) or job.cancel.is_set():
                raise
            raise RuntimeError(str(e)) from e

    job = jobs_svc.start("babeldoc", _work)
    return {"job_id": job.id, "status": job.status}


@router.get("/babeldoc/job/{job_id}")
def babeldoc_job(job_id: str) -> dict[str, Any]:
    job = jobs_svc.get(job_id)
    if not job:
        raise HTTPException(404, "任务不存在或已过期")
    d = job.to_dict()
    if d["status"] == "done" and d["result"]:
        d["result"]["doc_id"] = job.kind and None  # 占位
    return d


@router.post("/babeldoc/job/{job_id}/cancel")
def cancel_babeldoc(job_id: str) -> dict[str, Any]:
    ok = jobs_svc.cancel(job_id)
    return {"ok": ok}


@router.get("/babeldoc/{doc_id}/status")
def babeldoc_status(doc_id: str) -> dict[str, Any]:
    """查询该文档是否已生成双语 PDF（供前端决定按钮显示）。"""
    r = babeldoc_svc.get_babeldoc_pdf(doc_id)
    if not r:
        return {"generated": False}
    import os

    try:
        size = os.path.getsize(r["dual"])
    except OSError:
        size = 0
    return {"generated": True, "size": size}


@router.get("/babeldoc/{doc_id}/pdf")
def get_babeldoc_pdf(doc_id: str) -> Any:
    """返回已生成的双语 PDF。"""
    r = babeldoc_svc.get_babeldoc_pdf(doc_id)
    if not r:
        raise HTTPException(404, "尚未生成双语 PDF")
    from fastapi.responses import FileResponse

    return FileResponse(r["dual"], media_type="application/pdf",
                        filename=f"{doc_id}-bilingual.pdf")
