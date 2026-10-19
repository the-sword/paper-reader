"""标签 API。"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..services import library

router = APIRouter()


class TagIn(BaseModel):
    name: str
    color: str = "#888888"


@router.get("")
def list_tags() -> list[dict]:
    return library.list_tags()


@router.post("")
def create_tag(body: TagIn) -> dict:
    return library.create_tag(body.name, body.color)


@router.delete("/{tag_id}")
def delete_tag(tag_id: str) -> dict:
    library.delete_tag(tag_id)
    return {"ok": True}


@router.post("/{doc_id}/{tag_id}")
def tag_document(doc_id: str, tag_id: str, add: bool = True) -> dict:
    library.tag_document(doc_id, tag_id, add)
    return {"ok": True}
