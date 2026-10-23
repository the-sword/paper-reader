"""API 路由汇总。

注意：这里刻意使用 `from .xxx import router as ...` 而不是
`from . import xxx`。后者在包命名空间里可能命中 FastAPI 模块的
模块级 `annotations` 字符串（来自 `from __future__ import annotations`），
导致拿到 `_Feature` 而不是子模块。
"""
from __future__ import annotations

from fastapi import APIRouter

from .annotations import router as annotations_router
from .arxiv import router as arxiv_router
from .digest import router as digest_router
from .documents import router as documents_router
from .folders import router as folders_router
from .parse import router as parse_router
from .phase3 import router as phase3_router
from .radar import router as radar_router
from .system import router as system_router
from .tags import router as tags_router

api = APIRouter()
api.include_router(system_router, prefix="/system", tags=["system"])
api.include_router(documents_router, prefix="/documents", tags=["documents"])
api.include_router(folders_router, prefix="/folders", tags=["folders"])
api.include_router(tags_router, prefix="/tags", tags=["tags"])
api.include_router(annotations_router, prefix="/annotations", tags=["annotations"])
api.include_router(parse_router, prefix="/reading", tags=["reading"])
api.include_router(phase3_router, prefix="/reading", tags=["phase3"])
api.include_router(arxiv_router, prefix="/arxiv", tags=["arxiv"])
api.include_router(digest_router)
api.include_router(radar_router)
