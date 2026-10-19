"""文件夹 API。"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..services import library

router = APIRouter()


class FolderIn(BaseModel):
    name: str
    parent_id: str | None = None


@router.get("")
def list_folders() -> list[dict]:
    return library.list_folders()


@router.post("")
def create_folder(body: FolderIn) -> dict:
    return library.create_folder(body.name, body.parent_id)


@router.patch("/{folder_id}")
def rename_folder(folder_id: str, body: FolderIn) -> dict:
    library.rename_folder(folder_id, body.name)
    return {"ok": True}


@router.delete("/{folder_id}")
def delete_folder(folder_id: str) -> dict:
    library.delete_folder(folder_id)
    return {"ok": True}
