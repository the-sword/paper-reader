"""文献库服务：导入、去重、文件夹、标签。"""
from __future__ import annotations

import hashlib
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..core.config import get_settings
from ..core.db import db


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _blob_path(file_hash: str) -> Path:
    """按哈希前两位分桶，避免单目录文件过多。"""
    s = get_settings()
    return s.files_dir / file_hash[:2] / f"{file_hash}.pdf"


def extract_pdf_meta(path: Path) -> dict[str, Any]:
    """轻量提取页数。pypdf 缺失时降级为 0，不阻塞导入。"""
    page_count = 0
    try:
        from pypdf import PdfReader  # type: ignore

        page_count = len(PdfReader(str(path)).pages)
    except Exception:
        page_count = 0
    return {"page_count": page_count}


def import_pdf(src: Path, title: str | None = None, folder_ids: list[str] | None = None) -> dict[str, Any]:
    """导入一篇 PDF。已存在（同哈希）则直接返回既有条目。"""
    src = Path(src)
    if not src.exists():
        raise FileNotFoundError(src)

    file_hash = _sha256_of(src)

    with db() as conn:
        row = conn.execute("SELECT * FROM documents WHERE file_hash=?", (file_hash,)).fetchone()
        if row:
            doc = dict(row)
            if folder_ids:
                _attach_folders(conn, doc["id"], folder_ids)
            return {**doc, "duplicated": True}

        doc_id = str(uuid.uuid4())
        dest = _blob_path(file_hash)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(src, dest)

        meta = extract_pdf_meta(dest)
        resolved_title = title or src.stem

        conn.execute(
            """INSERT INTO documents
               (id, title, file_hash, file_name, file_size, page_count, added_at)
               VALUES (?,?,?,?,?,?,?)""",
            (doc_id, resolved_title, file_hash, src.name, src.stat().st_size,
             meta["page_count"], _now()),
        )
        if folder_ids:
            _attach_folders(conn, doc_id, folder_ids)

        row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        return {**dict(row), "duplicated": False}


def import_bytes(data: bytes, file_name: str, title: str | None = None,
                 folder_ids: list[str] | None = None) -> dict[str, Any]:
    """从浏览器上传的字节流导入。"""
    tmp = get_settings().lib_root / f".upload-{uuid.uuid4().hex}.pdf"
    tmp.write_bytes(data)
    try:
        return import_pdf(tmp, title or Path(file_name).stem, folder_ids)
    finally:
        tmp.unlink(missing_ok=True)


def list_documents(folder_id: str | None = None, tag_id: str | None = None,
                   q: str | None = None) -> list[dict[str, Any]]:
    sql = [
        "SELECT DISTINCT d.* FROM documents d",
    ]
    joins: list[str] = []
    where: list[str] = []
    params: list[Any] = []

    if folder_id:
        joins.append("JOIN document_folders df ON df.document_id=d.id")
        where.append("df.folder_id=?")
        params.append(folder_id)
    if tag_id:
        joins.append("JOIN document_tags dt ON dt.document_id=d.id")
        where.append("dt.tag_id=?")
        params.append(tag_id)
    if q:
        where.append("d.title LIKE ?")
        params.append(f"%{q}%")

    stmt = " ".join(sql + joins)
    if where:
        stmt += " WHERE " + " AND ".join(where)
    stmt += " ORDER BY d.added_at DESC"

    with db() as conn:
        rows = [dict(r) for r in conn.execute(stmt, params).fetchall()]
        for r in rows:
            r["folders"] = _folders_of(conn, r["id"])
            r["tags"] = _tags_of(conn, r["id"])
        return rows


def get_document(doc_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return None
        doc = dict(row)
        doc["folders"] = _folders_of(conn, doc_id)
        doc["tags"] = _tags_of(conn, doc_id)
        return doc


def delete_document(doc_id: str) -> None:
    with db() as conn:
        row = conn.execute("SELECT file_hash FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return
        # 仅在没有任何文档再引用该哈希时才删物理文件
        others = conn.execute(
            "SELECT COUNT(*) c FROM documents WHERE file_hash=? AND id<>?", (row["file_hash"], doc_id)
        ).fetchone()["c"]
        conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
        if others == 0:
            _blob_path(row["file_hash"]).unlink(missing_ok=True)


def pdf_path_of(doc_id: str) -> Path | None:
    with db() as conn:
        row = conn.execute("SELECT file_hash FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return None
    p = _blob_path(row["file_hash"])
    return p if p.exists() else None


def touch_opened(doc_id: str) -> None:
    with db() as conn:
        conn.execute("UPDATE documents SET opened_at=? WHERE id=?", (_now(), doc_id))


# ---------------- 文件夹 ----------------

def _attach_folders(conn, doc_id: str, folder_ids: list[str]) -> None:
    for fid in folder_ids:
        conn.execute(
            "INSERT OR IGNORE INTO document_folders (document_id, folder_id) VALUES (?,?)",
            (doc_id, fid),
        )


def _folders_of(conn, doc_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """SELECT f.* FROM folders f
           JOIN document_folders df ON df.folder_id=f.id
           WHERE df.document_id=? ORDER BY f.sort_order""", (doc_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def list_folders() -> list[dict[str, Any]]:
    with db() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM folders ORDER BY parent_id IS NOT NULL, sort_order, name"
        ).fetchall()]
        for r in rows:
            r["count"] = conn.execute(
                "SELECT COUNT(*) c FROM document_folders WHERE folder_id=?", (r["id"],)
            ).fetchone()["c"]
        return rows


def create_folder(name: str, parent_id: str | None = None) -> dict[str, Any]:
    fid = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            "INSERT INTO folders (id, name, parent_id, created_at) VALUES (?,?,?,?)",
            (fid, name, parent_id, _now()),
        )
        return dict(conn.execute("SELECT * FROM folders WHERE id=?", (fid,)).fetchone())


def rename_folder(folder_id: str, name: str) -> None:
    with db() as conn:
        conn.execute("UPDATE folders SET name=? WHERE id=?", (name, folder_id))


def delete_folder(folder_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM folders WHERE id=?", (folder_id,))


def set_document_folders(doc_id: str, folder_ids: list[str]) -> None:
    """原子地替换一篇文献的文件夹归属。

    拖拽移动用这个：一次事务完成「从原文件夹移除 + 加入目标文件夹」，
    避免中间态。传空列表表示移出所有文件夹（未分类）。
    """
    with db() as conn:
        conn.execute("DELETE FROM document_folders WHERE document_id=?", (doc_id,))
        for fid in dict.fromkeys(folder_ids):  # 去重且保序
            conn.execute(
                "INSERT OR IGNORE INTO document_folders (document_id, folder_id) VALUES (?,?)",
                (doc_id, fid),
            )


def move_document(doc_id: str, folder_id: str, add: bool = True) -> None:
    with db() as conn:
        if add:
            conn.execute(
                "INSERT OR IGNORE INTO document_folders (document_id, folder_id) VALUES (?,?)",
                (doc_id, folder_id),
            )
        else:
            conn.execute(
                "DELETE FROM document_folders WHERE document_id=? AND folder_id=?",
                (doc_id, folder_id),
            )


# ---------------- 标签 ----------------

def _tags_of(conn, doc_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """SELECT t.* FROM tags t JOIN document_tags dt ON dt.tag_id=t.id
           WHERE dt.document_id=? ORDER BY t.name""", (doc_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def list_tags() -> list[dict[str, Any]]:
    with db() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM tags ORDER BY name").fetchall()]
        for r in rows:
            r["count"] = conn.execute(
                "SELECT COUNT(*) c FROM document_tags WHERE tag_id=?", (r["id"],)
            ).fetchone()["c"]
        return rows


def create_tag(name: str, color: str = "#888888") -> dict[str, Any]:
    with db() as conn:
        existing = conn.execute("SELECT * FROM tags WHERE name=?", (name,)).fetchone()
        if existing:
            return dict(existing)
        tid = str(uuid.uuid4())
        conn.execute("INSERT INTO tags (id, name, color, created_at) VALUES (?,?,?,?)",
                     (tid, name, color, _now()))
        return dict(conn.execute("SELECT * FROM tags WHERE id=?", (tid,)).fetchone())


def delete_tag(tag_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM tags WHERE id=?", (tag_id,))


def tag_document(doc_id: str, tag_id: str, add: bool = True) -> None:
    with db() as conn:
        if add:
            conn.execute("INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?,?)",
                         (doc_id, tag_id))
        else:
            conn.execute("DELETE FROM document_tags WHERE document_id=? AND tag_id=?",
                         (doc_id, tag_id))
