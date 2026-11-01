"""文献级合并导入（ReadPaper 式轻迁移）。

从部分导出归档（文献库 + 标注 + AI 数据）合并到当前库：

  文献匹配    ① file_hash（同一文件）→ 重映射 id，坐标原样
              ② arXiv ID / DOI（同论文不同版式）→ 重映射 + 重锚标注
              ③ 都不中 → 占位文献（元数据齐全、file_hash 指向源文件，
                PDF 后补上传时由 import_pdf 挂接并触发重锚）
  标注/AI     id 重映射后插入；id 已存在跳过（幂等，重复导入无副作用）
  文件夹/标签 按名字合并：同名复用、缺的创建
  归档内 PDF  归档带 files/ 时顺带落盘（占位等到了它的源文件）

不做：settings（走「仅导入设置」）、segments/翻译缓存（目标机重解析，
标注是页坐标不受影响）、parsed/（按源机 doc_id 寻址，不可迁移）。
"""
from __future__ import annotations

import io
import json
import sqlite3
import tarfile
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from ..core.config import get_settings
from ..core.db import db
from . import backup as backup_svc
from . import library as library_svc
from . import reanchor as reanchor_svc

#: 归档里的这些表参与合并
_DOC_TABLES = {
    "documents": ("id", "title", "authors", "year", "journal", "doi", "arxiv_id",
                  "file_hash", "file_name", "file_size", "page_count",
                  "added_at", "opened_at"),
    "annotations": None,      # None = 全列（SELECT * 后按需插入）
    "summaries": None,
    "reader_sessions": None,
    "reader_messages": None,
    "folders": ("id", "name", "parent_id"),
    "document_folders": ("document_id", "folder_id"),
    "tags": ("id", "name", "color"),
    "document_tags": ("document_id", "tag_id"),
}


def _open_archive(path: Path, password: str | None):
    """解密（若加密）并打开归档。返回 tarfile 句柄。"""
    with open(path, "rb") as f:
        magic = f.read(8)
    if magic == b"PRBAK001":
        if not (password and password.strip()):
            raise RuntimeError("该文件已加密，请输入密码")
        blob = backup_svc.decrypt_archive(path.read_bytes(), password.strip())
        return tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz")
    return tarfile.open(name=path, mode="r:gz")


def _read_source_db(tar: tarfile.TarFile) -> dict[str, list[dict[str, Any]]]:
    """把归档里的 library.db 各相关表读成行列表。"""
    member = tar.getmember("library.db")
    tmp = Path(tempfile.gettempdir()) / f"pr-merge-src-{datetime.now().timestamp()}.db"
    try:
        with open(tmp, "wb") as out:
            out.write(tar.extractfile(member).read())  # type: ignore[arg-type]
        conn = sqlite3.connect(tmp)
        conn.row_factory = sqlite3.Row
        try:
            out_tables: dict[str, list[dict[str, Any]]] = {}
            for table in _DOC_TABLES:
                try:
                    out_tables[table] = [dict(r) for r in conn.execute(
                        f"SELECT * FROM {table}").fetchall()]  # noqa: S608
                except sqlite3.Error:
                    out_tables[table] = []  # 老归档缺表
            return out_tables
        finally:
            conn.close()
    finally:
        tmp.unlink(missing_ok=True)


def merge_from_file(path: Path, password: str | None = None) -> dict[str, Any]:
    """合并归档到当前库，返回导入报告。"""
    s = get_settings()
    with _open_archive(path, password) as tar:
        src = _read_source_db(tar)
        # 归档自带的 PDF（勾了「PDF 原文」类目的导出）：落到 files/，
        # 占位文献等到了它的源文件（同 hash，坐标无需重锚）
        pdfs_attached = _extract_pdf_members(tar)

    docs = src["documents"]
    report: dict[str, Any] = {
        "ok": True,
        "documents": {"total": len(docs), "by_hash": 0, "by_identity": 0, "placeholder": 0},
        "annotations": {"imported": 0, "skipped_existing": 0},
        "summaries": {"imported": 0, "skipped_existing": 0},
        "sessions": {"imported": 0},
        "folders_created": 0,
        "tags_created": 0,
        "reanchor": {"docs": 0, "reanchored": 0, "kept": 0},
        "pdfs_attached_from_archive": pdfs_attached,
        "details": [],
    }
    if not docs:
        report["details"].append("归档里没有文献数据")
        return report

    # ---- 匹配 / 占位 ----
    id_map: dict[str, str] = {}          # 源 doc id -> 本地 doc id
    need_reanchor: list[str] = []        # 本地 doc id（身份匹配、版式可能不同）
    with db() as conn:
        by_hash = {r["file_hash"]: r["id"] for r in conn.execute(
            "SELECT id, file_hash FROM documents WHERE file_hash IS NOT NULL").fetchall()}
        local_doc_ids = {r["id"] for r in conn.execute("SELECT id FROM documents").fetchall()}
        by_arxiv = {r["arxiv_id"]: r["id"] for r in conn.execute(
            "SELECT id, arxiv_id FROM documents WHERE arxiv_id IS NOT NULL").fetchall()}
        by_doi = {r["doi"]: r["id"] for r in conn.execute(
            "SELECT id, doi FROM documents WHERE documents.doi IS NOT NULL").fetchall()}

        for d in docs:
            sid, fh = d["id"], d.get("file_hash")
            if fh and fh in by_hash:
                id_map[sid] = by_hash[fh]
                report["documents"]["by_hash"] += 1
                continue
            local = None
            if d.get("arxiv_id") and d["arxiv_id"] in by_arxiv:
                local = by_arxiv[d["arxiv_id"]]
            elif d.get("doi") and d["doi"] in by_doi:
                local = by_doi[d["doi"]]
            if local:
                id_map[sid] = local
                need_reanchor.append(local)
                report["documents"]["by_identity"] += 1
                continue
            # 占位：file_hash 保留源值（后补上传按 hash 挂接且无需重锚）。
            # id 保留源 id（uuid 跨机撞库可忽略；真撞说明是同一行），幂等靠它
            nid = sid if sid not in local_doc_ids else str(uuid.uuid4())
            local_doc_ids.add(nid)
            conn.execute(
                """INSERT INTO documents (id, title, authors, year, journal, doi,
                     arxiv_id, file_hash, file_name, file_size, page_count,
                     parse_status, added_at, opened_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,'idle',?,?)""",
                (nid, d.get("title") or "未命名", d.get("authors"), d.get("year"),
                 d.get("journal"), d.get("doi"), d.get("arxiv_id"), fh,
                 d.get("file_name"), d.get("file_size"), d.get("page_count"),
                 d.get("added_at") or datetime.now().isoformat(), d.get("opened_at")),
            )
            id_map[sid] = nid
            report["documents"]["placeholder"] += 1
            report["details"].append(f"占位：{(d.get('title') or sid)[:40]}（PDF 可后补上传）")

        # ---- 文件夹 / 标签（按名字合并）----
        folder_map = _merge_folders(conn, src["folders"], report)
        tag_map = _merge_tags(conn, src["tags"], report)

        # ---- 关联表 ----
        for df in src["document_folders"]:
            did, fid = id_map.get(df["document_id"]), folder_map.get(df["folder_id"])
            if did and fid:
                conn.execute(
                    "INSERT OR IGNORE INTO document_folders (document_id, folder_id)"
                    " VALUES (?,?)", (did, fid))
        for dt in src["document_tags"]:
            did, tid = id_map.get(dt["document_id"]), tag_map.get(dt["tag_id"])
            if did and tid:
                conn.execute(
                    "INSERT OR IGNORE INTO document_tags (document_id, tag_id)"
                    " VALUES (?,?)", (did, tid))

        # ---- 标注 / 总结 / 会话（id 幂等跳过）----
        report["annotations"] = _merge_table(
            conn, src["annotations"], "annotations", id_map, "document_id")
        report["summaries"] = _merge_table(
            conn, src["summaries"], "summaries", id_map, "document_id")
        sessions = _merge_table(
            conn, src["reader_sessions"], "reader_sessions", id_map, "document_id")
        report["sessions"] = sessions

        # 会话消息只挂「本次新插入」的 session（自增 id 无法保持）
        for sid_src in sessions.get("inserted_ids", []):  # type: ignore[union-attr]
            lid = sessions["id_map"][sid_src]  # type: ignore[index]
            for m in src["reader_messages"]:
                if m["session_id"] == sid_src:
                    conn.execute(
                        "INSERT INTO reader_messages (session_id, role, content, created_at)"
                        " VALUES (?,?,?,?)",
                        (lid, m["role"], m["content"], m["created_at"]))

    # ---- 重锚：身份匹配且本地已有文件的文献 ----
    for local_id in need_reanchor:
        pdf = library_svc.pdf_path_of(local_id)
        if not pdf:
            report["details"].append("身份匹配但本地无 PDF，坐标保持原样待后补")
            continue
        r = reanchor_svc.reanchor_document(local_id, pdf)
        report["reanchor"]["docs"] += 1
        report["reanchor"]["reanchored"] += r["reanchored"]
        report["reanchor"]["kept"] += r["kept"]

    return report


def _extract_pdf_members(tar: tarfile.TarFile) -> int:
    """把归档 files/ 成员落到本地 files/（占位的源 PDF）。返回数量。"""
    s = get_settings()
    n = 0
    for member in tar.getmembers():
        if not (member.isfile() and member.name.startswith("files/")
                and member.name.endswith(".pdf")):
            continue
        rel = member.name[len("files/"):]
        if ".." in Path(rel).parts or not rel:
            continue
        dest = s.files_dir / rel
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as out:
            out.write(tar.extractfile(member).read())  # type: ignore[arg-type]
        n += 1
    return n


def _merge_folders(conn: sqlite3.Connection, rows: list[dict[str, Any]],
                   report: dict[str, Any]) -> dict[str, str]:
    """按名字合并文件夹树，返回 源id -> 本地id。"""
    local = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM folders").fetchall()}
    mapping: dict[str, str] = {}
    # 两轮：先顶层（源 parent 为空或不在本次导入中），再挂子层
    pending = [f for f in rows]
    for _ in range(3):  # 树最深三层即可覆盖现有 UI（多层级文件夹）
        progress = False
        for f in list(pending):
            parent_local = None
            if f.get("parent_id"):
                parent_local = mapping.get(f["parent_id"])
                if parent_local is None and f["parent_id"] not in mapping \
                        and any(p["id"] == f["parent_id"] for p in rows):
                    continue  # 父还没落地，下一轮
            lid = local.get(f["name"])
            if not lid:
                lid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO folders (id, name, parent_id, created_at) VALUES (?,?,?,?)",
                    (lid, f["name"], parent_local, datetime.now().isoformat()))
                local[f["name"]] = lid
                report["folders_created"] += 1
            mapping[f["id"]] = lid
            pending.remove(f)
            progress = True
        if not pending or not progress:
            break
    return mapping


def _merge_tags(conn: sqlite3.Connection, rows: list[dict[str, Any]],
                report: dict[str, Any]) -> dict[str, str]:
    local = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM tags").fetchall()}
    mapping: dict[str, str] = {}
    for t in rows:
        lid = local.get(t["name"])
        if not lid:
            lid = str(uuid.uuid4())
            conn.execute("INSERT INTO tags (id, name, color, created_at) VALUES (?,?,?,?)",
                         (lid, t["name"], t.get("color"), datetime.now().isoformat()))
            local[t["name"]] = lid
            report["tags_created"] += 1
        mapping[t["id"]] = lid
    return mapping


def _merge_table(conn: sqlite3.Connection, rows: list[dict[str, Any]], table: str,
                 id_map: dict[str, str], doc_key: str) -> dict[str, Any]:
    """按 id 幂等插入（document_id 重映射），返回统计与 id 映射。"""
    existing = {r["id"] for r in conn.execute(f"SELECT id FROM {table}").fetchall()}  # noqa: S608
    imported = skipped = 0
    inserted_ids: list[str] = []
    new_id_map: dict[str, str] = {}
    for r in rows:
        sid = r["id"]
        did = id_map.get(r.get(doc_key))  # type: ignore[arg-type]
        if not did:
            continue  # 源数据悬空（文档行缺失），丢弃
        if sid in existing:
            skipped += 1
            new_id_map[sid] = sid
            continue
        cols = [c for c in r.keys() if c != "id"]
        values = [sid] + [did if c == doc_key else r[c] for c in cols]
        conn.execute(
            f"INSERT INTO {table} (id, {', '.join(cols)})"  # noqa: S608
            f" VALUES ({','.join('?' * (len(cols) + 1))})", values)
        imported += 1
        inserted_ids.append(sid)
        new_id_map[sid] = sid
    return {"imported": imported, "skipped_existing": skipped,
            "inserted_ids": inserted_ids, "id_map": new_id_map}
