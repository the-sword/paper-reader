"""文献条目 API：导入、列表、详情、PDF 流、删除。"""
from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel
from fastapi.responses import FileResponse

from ..services import babeldoc as babeldoc_svc
from ..services import library

router = APIRouter()


def _with_bilingual_flag(rows: list[dict]) -> list[dict]:
    """为每条文献补充 bilingual_ready（双语 PDF 是否已生成）。"""
    for r in rows:
        r["bilingual_ready"] = babeldoc_svc.get_babeldoc_pdf(r["id"]) is not None
    return rows


@router.get("")
def list_documents(folder_id: str | None = Query(None),
                   tag_id: str | None = Query(None),
                   q: str | None = Query(None)) -> list[dict]:
    rows = library.list_documents(folder_id=folder_id, tag_id=tag_id, q=q)
    return _with_bilingual_flag(rows)


@router.post("/upload")
async def upload(file: UploadFile = File(...),
                 folder_id: str | None = Form(None)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "只支持 PDF 文件")
    data = await file.read()
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(400, "文件超过 200MB")
    folder_ids = [folder_id] if folder_id else None
    doc = library.import_bytes(data, file.filename, folder_ids=folder_ids)

    # 新文献自动进入双语 PDF 队列（已存在的不重复入队）
    if not doc.get("duplicated"):
        try:
            from ..services import toqueue

            if toqueue.is_enabled():
                toqueue.enqueue(doc["id"], doc.get("title") or file.filename)
        except Exception:  # noqa: BLE001
            pass  # 入队失败不影响导入

    return doc


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
    # 联动清理双语 PDF 队列条目，否则界面上会残留指向已删文献的失败/排队记录
    try:
        from ..services import toqueue
        toqueue.remove(doc_id)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


class FolderSetReq(BaseModel):
    folder_ids: list[str]


@router.put("/{doc_id}/folders")
def set_document_folders(doc_id: str, body: FolderSetReq) -> dict:
    """设置文献所属文件夹（拖拽移动用）。空列表表示移出所有文件夹。"""
    if not library.get_document(doc_id):
        raise HTTPException(404, "文献不存在")
    library.set_document_folders(doc_id, body.folder_ids)
    return {"ok": True, "folder_ids": body.folder_ids}


@router.post("/{doc_id}/folders/{folder_id}")
def move_document(doc_id: str, folder_id: str, add: bool = True) -> dict:
    library.move_document(doc_id, folder_id, add)
    return {"ok": True}
