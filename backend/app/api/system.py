"""系统信息与健康检查。"""
from __future__ import annotations

from typing import Any

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


@router.get("/selfcheck")
def selfcheck(quick: bool = False) -> dict[str, Any]:
    """性能自检：评估当前机器能否跑得动各功能模块。

    quick=true 时跳过磁盘测速与 ONNX 推理（约 1 秒返回），
    完整检测需 5-15 秒，视机器性能而定。
    """
    from ..services import selfcheck as sc  # noqa: 同包相对导入

    return sc.run_selfcheck(quick=quick)
