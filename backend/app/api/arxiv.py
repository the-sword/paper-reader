"""arXiv 检索与下载导入 API。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.db import db
from ..services import arxiv as arxiv_svc
from ..services import library

router = APIRouter()


class SearchReq(BaseModel):
    query: str
    field: str = "all"      # all | ti | au | abs
    limit: int = 10


class DoiReq(BaseModel):
    doi: str


class ImportReq(BaseModel):
    arxiv_id: str
    title: str | None = None
    authors: list[str] | None = None
    folder_id: str | None = None


@router.post("/search")
def search_arxiv(body: SearchReq) -> dict[str, Any]:
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(400, "搜索关键词不能为空")
    if body.field not in ("all", "ti", "au", "abs"):
        raise HTTPException(400, "field 只能是 all / ti / au / abs")
    try:
        items = arxiv_svc.search(q, limit=body.limit, field=body.field)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"arXiv 搜索失败：{e}") from e
    return {"count": len(items), "results": items}


@router.post("/by-doi")
def lookup_doi(body: DoiReq) -> dict[str, Any]:
    """根据 DOI 查找 arXiv 版本。"""
    doi = (body.doi or "").strip()
    if not doi:
        raise HTTPException(400, "DOI 不能为空")
    try:
        res = arxiv_svc.find_by_doi(doi)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"DOI 查询失败：{e}") from e
    return res


@router.post("/import")
def import_from_arxiv(body: ImportReq) -> dict[str, Any]:
    """下载 arXiv PDF 并导入文献库。已存在则直接返回既有条目。"""
    aid = (body.arxiv_id or "").strip()
    if not aid:
        raise HTTPException(400, "arXiv ID 不能为空")

    try:
        pdf = arxiv_svc.download_pdf(aid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"下载失败：{e}") from e

    # 元数据：优先用前端传入，否则现查
    title = (body.title or "").strip()
    authors = body.authors
    if not title:
        try:
            meta = arxiv_svc.fetch_meta(aid)
            if meta:
                title = meta.get("title") or ""
                authors = authors or meta.get("authors")
        except Exception:  # noqa: BLE001
            pass

    clean_id = aid.split("/abs/")[-1]
    filename = f"arXiv-{clean_id.replace('/', '_')}.pdf"
    folder_ids = [body.folder_id] if body.folder_id else None

    try:
        doc = library.import_bytes(
            pdf, filename, title=title or filename, folder_ids=folder_ids,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"导入失败：{e}") from e

    # 补充作者信息
    if authors:
        try:
            with db() as conn:
                conn.execute(
                    "UPDATE documents SET authors=? WHERE id=?",
                    (", ".join(authors[:10]), doc["id"]),
                )
            doc["authors"] = ", ".join(authors[:10])
        except Exception:  # noqa: BLE001
            pass

    return {
        "ok": True,
        "duplicated": bool(doc.get("duplicated")),
        "document": {
            "id": doc["id"],
            "title": doc["title"],
            "page_count": doc.get("page_count"),
            "authors": doc.get("authors"),
        },
    }


@router.get("/meta/{arxiv_id:path}")
def arxiv_meta(arxiv_id: str) -> dict[str, Any]:
    try:
        meta = arxiv_svc.fetch_meta(arxiv_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"元数据查询失败：{e}") from e
    if not meta:
        raise HTTPException(404, "未找到该 arXiv 条目")
    return meta
