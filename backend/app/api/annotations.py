"""标注 API。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from ..services import notes

router = APIRouter()


class AnnotationIn(BaseModel):
    document_id: str
    page: int = 1
    kind: str = "highlight"
    rects: list[list[float]] = []
    color: str = "#ffd400"
    quote: str = ""
    comment: str = ""
    segment_id: str | None = None   # 段落流标注时为段落 id
    side: str = "source"            # source | zh


class AnnotationPatch(BaseModel):
    color: str | None = None
    comment: str | None = None


@router.get("")
def list_annotations(document_id: str = Query(...), page: int | None = Query(None)) -> list[dict]:
    return notes.list_annotations(document_id, page)


@router.post("")
def create_annotation(body: AnnotationIn) -> dict:
    try:
        return notes.create_annotation(
            body.document_id, body.page, body.kind, body.rects,
            body.color, body.quote, body.comment,
            segment_id=body.segment_id, side=body.side,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.patch("/{ann_id}")
def update_annotation(ann_id: str, body: AnnotationPatch) -> dict:
    out = notes.update_annotation(ann_id, body.color, body.comment)
    if not out:
        raise HTTPException(404, "标注不存在")
    return out


@router.delete("/{ann_id}")
def delete_annotation(ann_id: str) -> dict:
    notes.delete_annotation(ann_id)
    return {"ok": True}


@router.get("/export/{doc_id}", response_class=PlainTextResponse)
def export_markdown(doc_id: str) -> str:
    try:
        return notes.export_markdown(doc_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
