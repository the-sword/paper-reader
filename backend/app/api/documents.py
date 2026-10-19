"""文献条目 API：导入、列表、详情、PDF 流、删除。"""
from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from ..services import library

router = APIRouter()


@router.get("")
def list_documents(folder_id: str | None = Query(None),
                   tag_id: str | None = Query(None),
                   q: str | None = Query(None)) -> list[dict]:
    return library.list_documents(folder_id=folder_id, tag_id=tag_id, q=q)


@router.post("/upload")
async def upload(file: UploadFile = File(...),
                 folder_id: str | None = Form(None)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "只支持 PDF 文件")
    data = await file.read()
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(400, "文件超过 200MB")
    folder_ids = [folder_id] if folder_id else None
    return library.import_bytes(data, file.filename, folder_ids=folder_ids)


@router.get("/{doc_id}")
def get_document(doc_id: str) -> dict:
    doc = library.get_document(doc_id)
    if not doc:
        raise HTTPException(404, "文献不存在")
    return doc


@router.get("/{doc_id}/file")
def get_pdf(doc_id: str) -> FileResponse:
    path = library.pdf_path_of(doc_id)
    if not path:
        raise HTTPException(404, "PDF 文件不存在")
    library.touch_opened(doc_id)
    return FileResponse(path, media_type="application/pdf", filename=f"{doc_id}.pdf")


@router.delete("/{doc_id}")
def delete_document(doc_id: str) -> dict:
    library.delete_document(doc_id)
    return {"ok": True}


@router.post("/{doc_id}/folders/{folder_id}")
def move_document(doc_id: str, folder_id: str, add: bool = True) -> dict:
    library.move_document(doc_id, folder_id, add)
    return {"ok": True}
