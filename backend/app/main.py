"""应用入口。CORS + 鉴权中间件 + 静态资源托管。"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import api as api_router
from .core.config import get_settings
from .core.db import init_db

app = FastAPI(title="Paper Reader", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """本地开发 AUTH_TOKEN 留空 → 不鉴权；上 VPS 后设了 token → 全站校验。

    注意：这里从第一天就在，避免上线时改遍所有路由。
    """
    token = get_settings().auth_token
    if not token:
        return await call_next(request)

    path = request.url.path
    if path.startswith("/api/system/health") or path.startswith("/assets"):
        return await call_next(request)

    provided = request.headers.get("x-auth-token") or request.query_params.get("token")
    if provided != token:
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.on_event("startup")
def _startup() -> None:
    init_db()


app.include_router(api_router, prefix="/api")


# ---- 解析产物（MinerU 抽取的图片等）----
from fastapi import HTTPException as _HTTPException
from fastapi.responses import FileResponse as _FileResponse


@app.get("/api/reading/{doc_id}/asset/{subpath:path}")
def get_parsed_asset(doc_id: str, subpath: str):
    """提供 parsed/<doc_id>/ 下的文件（图片、full.md 等）。

    注意：这里做路径穿越校验，只允许访问该文档自己的目录。
    """
    s = get_settings()
    base = (s.parsed_dir / doc_id).resolve()
    target = (base / subpath).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise _HTTPException(403, "非法路径")
    if not target.is_file():
        raise _HTTPException(404, "资源不存在")
    return _FileResponse(target)


# ---- 前端静态资源（构建产物存在时托管）----
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="web")
else:
    @app.get("/")
    def _no_dist() -> dict:
        return {
            "message": "前端尚未构建。开发时请另开 `npm run dev`（Vite），"
                       "生产时先 `npm run build` 再启动本服务。",
            "api_docs": "/docs",
        }


def main() -> None:
    import uvicorn

    s = get_settings()
    uvicorn.run("app.main:app", host=s.host, port=s.port, reload=True)


if __name__ == "__main__":
    main()
