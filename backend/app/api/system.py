"""系统信息与健康检查。"""
from __future__ import annotations

from fastapi import APIRouter

from ..core.config import get_settings
from ..core.db import db

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"ok": True}


@router.get("/info")
def info() -> dict:
    s = get_settings()
    with db() as conn:
        doc_count = conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"]
        ann_count = conn.execute("SELECT COUNT(*) c FROM annotations").fetchone()["c"]
    return {
        "lib_root": str(s.lib_root),
        "db_path": str(s.db_path),
        "documents": doc_count,
        "annotations": ann_count,
        "auth_enabled": bool(s.auth_token),
    }
