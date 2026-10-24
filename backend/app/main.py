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

app = FastAPI(
    title="Paper Reader", version="0.1.0",
    # 公网部署（设了 AUTH_TOKEN）时关闭交互文档与 OpenAPI schema：
    # 它们不在 /api 前缀下，鉴权中间件管不到，等于向扫描器公开全部路由面。
    docs_url="/docs" if not get_settings().auth_token else None,
    redoc_url="/redoc" if not get_settings().auth_token else None,
    openapi_url="/openapi.json" if not get_settings().auth_token else None,
)

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
    # 静态资源不鉴权：浏览器首次访问拿不到前端里的 token，
    # 若连 index.html 也拦，页面将永远无法加载（表现为“能连上但打不开”）。
    # token 的真正作用是防止搜索引擎/扫描器索引到内容，
    # 数据安全由 API 层鉴权保证。
    if (
        path.startswith("/assets")
        or path.startswith("/api/system/health")
        or not path.startswith("/api")
    ):
        return await call_next(request)

    provided = request.headers.get("x-auth-token") or request.query_params.get("token")
    if provided != token:
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.on_event("startup")
def _startup() -> None:
    init_db()
    from .services import digest, radar

    digest.start_scheduler()
    radar.start_scheduler()


app.include_router(api_router, prefix="/api")


# ---- 解析产物（MinerU 抽取的图片等）----
from fastapi import HTTPException as _HTTPException
from fastapi.responses import FileResponse as _FileResponse


@app.get("/api/reading/{doc_id}/asset/{subpath:path}")
def get_parsed_asset(doc_id: str, subpath: str):
    """提供 parsed/<doc_id>/ 下的文件（图片、full.md 等）。

    注意：doc_id 必须先通过 uuid 校验再做路径拼接——仅靠 resolve 后的
    relative_to(base) 不够，doc_id=".." 会让 base 本身越出 parsed_dir，
    包含性校验形同虚设（可读到 library.db 等全库文件）。
    """
    from .services.library import is_valid_doc_id

    s = get_settings()
    if not is_valid_doc_id(doc_id):
        raise _HTTPException(404, "资源不存在")
    base = (s.parsed_dir / doc_id).resolve()
    target = (base / subpath).resolve()
    try:
        target.relative_to(base)
        base.relative_to(s.parsed_dir.resolve())
    except ValueError:
        raise _HTTPException(403, "非法路径")
    if not target.is_file():
        raise _HTTPException(404, "资源不存在")
    return _FileResponse(target)


# ---- 前端静态资源（构建产物存在时托管）----
class _CachedStaticFiles(StaticFiles):
    """静态资源缓存头。

    - /assets/* 文件名带内容 hash：immutable 长缓存，二次访问零请求
    - manifest.json / icons：短缓存
    - sw.js / index.html 及其余：no-cache，SW 更新与发新版都依赖即时生效
    """

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code == 200:
            if path.startswith("assets/"):
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            elif path == "manifest.json" or path.startswith("icons/"):
                resp.headers["Cache-Control"] = "public, max-age=3600"
            else:
                resp.headers["Cache-Control"] = "no-cache"
        return resp


_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.exists():
    app.mount("/", _CachedStaticFiles(directory=_DIST, html=True), name="web")
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
