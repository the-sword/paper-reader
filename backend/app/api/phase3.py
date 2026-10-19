"""阶段三 API：划词翻译、AI 总结、WebDAV 备份。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import backup as backup_svc
from ..services import glossary_cache as term_svc
from ..services import library
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


@router.post("/summary/{doc_id}")
def create_summary(doc_id: str, body: SummaryReq) -> dict[str, Any]:
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
        return backup_svc.backup(include_pdfs=body.include_pdfs)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e


@router.get("/backup/remote")
def remote_info() -> dict[str, Any]:
    try:
        return backup_svc.list_remote()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e


@router.post("/backup/restore")
def restore_backup() -> dict[str, Any]:
    try:
        return backup_svc.restore()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e
