"""文献级合并导入：匹配链、占位、重锚、幂等、归档 PDF。"""
from __future__ import annotations

import uuid
from pathlib import Path

import pymupdf

from app.core.config import get_settings
from app.core.db import db
from app.services import export as export_svc
from app.services import merge as merge_svc


def _wipe_library() -> None:
    with db() as conn:
        for t in ("annotations", "summaries", "reader_messages", "reader_sessions",
                  "document_folders", "document_tags", "documents", "folders", "tags"):
            conn.execute(f"DELETE FROM {t}")  # noqa: S608


def _seed_source(n: int = 2) -> list[dict]:
    """造 n 篇文献（含标注/总结/会话/文件夹/标签），返回行摘要。"""
    out = []
    with db() as conn:
        conn.execute("INSERT INTO folders (id, name, created_at) VALUES ('f1', 'SLAM', datetime('now'))")
        conn.execute("INSERT INTO tags (id, name, color, created_at) VALUES ('t1', '重点', '#ff0000', datetime('now'))")
        for i in range(n):
            did = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO documents (id, title, authors, year, file_hash, arxiv_id,"
                " file_name, file_size, page_count, added_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
                (did, f"论文{i}", "Author", 2024, f"hash{i}" + "0" * 59,
                 f"2401.0000{i}", f"p{i}.pdf", 1000, 10),
            )
            conn.execute(
                "INSERT INTO annotations (id, document_id, page, kind, color, rects, quote,"
                " comment, side, created_at, updated_at)"
                " VALUES (?,?,1,'highlight','#ffd400','[[0.1,0.1,0.5,0.12]]','key sentence',"
                " '', 'source', datetime('now'), datetime('now'))",
                (str(uuid.uuid4()), did),
            )
            conn.execute(
                "INSERT INTO summaries (id, document_id, kind, content, created_at)"
                " VALUES (?,?,'overview','总结',datetime('now'))", (str(uuid.uuid4()), did),
            )
            conn.execute(
                "INSERT INTO reader_sessions (id, document_id, goal, created_at)"
                " VALUES (?,?,'quick',datetime('now'))", (str(uuid.uuid4()), did),
            )
            sid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO reader_messages (session_id, role, content, created_at)"
                " SELECT id, 'user', '读后感', datetime('now') FROM reader_sessions"
                " WHERE document_id=?", (did,))
            conn.execute(
                "INSERT INTO document_folders (document_id, folder_id) VALUES (?,'f1')", (did,))
            conn.execute(
                "INSERT INTO document_tags (document_id, tag_id) VALUES (?,'t1')", (did,))
            out.append({"id": did, "title": f"论文{i}", "hash": f"hash{i}" + "0" * 59,
                        "arxiv": f"2401.0000{i}"})
    return out


def _archive(categories: list[str], password: str | None = None) -> Path:
    r = export_svc.build_export(categories, password)
    return get_settings().backups_dir / r["file_name"]


def test_merge_into_empty_library_creates_placeholders():
    docs = _seed_source(2)
    path = _archive(["library", "annotations", "ai"])
    _wipe_library()

    report = merge_svc.merge_from_file(path)
    assert report["ok"] is True
    assert report["documents"]["placeholder"] == 2
    assert report["documents"]["by_hash"] == report["documents"]["by_identity"] == 0
    assert report["annotations"]["imported"] == 2
    assert report["summaries"]["imported"] == 2
    assert report["sessions"]["imported"] == 2

    with db() as conn:
        rows = conn.execute("SELECT title, file_hash FROM documents ORDER BY title").fetchall()
        assert len(rows) == 2
        # 占位保留源 hash：后补上传同文件按 hash 挂接
        assert {r["file_hash"] for r in rows} == {d["hash"] for d in docs}
        # 会话消息只挂本次新插入的会话，随迁移过来
        assert conn.execute("SELECT COUNT(*) FROM reader_messages").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM reader_sessions").fetchone()[0] == 2
        # 文件夹/标签按名字保留（合并进空库即新建）
        assert conn.execute("SELECT COUNT(*) FROM folders WHERE name='SLAM'").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM tags WHERE name='重点'").fetchone()[0] == 1


def test_merge_idempotent():
    _seed_source(1)
    path = _archive(["library", "annotations", "ai"])
    _wipe_library()
    first = merge_svc.merge_from_file(path)
    assert first["annotations"]["imported"] == 1
    second = merge_svc.merge_from_file(path)
    # 第二次：文档按 hash 命中占位，数据 id 全部已存在 → 全跳过
    assert second["documents"]["by_hash"] == 1
    assert second["annotations"]["imported"] == 0
    assert second["annotations"]["skipped_existing"] == 1
    with db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM annotations").fetchone()[0] == 1


def test_merge_matches_by_hash_into_existing_doc():
    """本地已有同 hash 文献 → 标注直接挂到本地 id，不建占位。"""
    docs = _seed_source(1)
    path = _archive(["library", "annotations", "ai"])  # 先打包（含标注）
    with db() as conn:  # 打包后模拟目标机：只留文献行，删标注/AI
        conn.execute("DELETE FROM annotations")
        conn.execute("DELETE FROM summaries")
        conn.execute("DELETE FROM reader_sessions")
        conn.execute("DELETE FROM folders"); conn.execute("DELETE FROM tags")

    report = merge_svc.merge_from_file(path)
    assert report["documents"]["by_hash"] == 1
    assert report["documents"]["placeholder"] == 0
    with db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        assert n == 1  # 没有重复条目
        assert conn.execute("SELECT COUNT(*) FROM annotations").fetchone()[0] == 1


def test_merge_identity_match_reanchors():
    """同 arXiv 号、不同 hash、本地有 PDF → 重锚标注。"""
    docs = _seed_source(1)
    path = _archive(["library", "annotations"])

    # 目标机：同论文不同版式（不同 hash + 真实 PDF 文件）
    quote = "key sentence"
    pdf = get_settings().lib_root / "local-version.pdf"
    doc = pymupdf.open(); page = doc.new_page()
    page.insert_text((72, 300), quote, fontsize=11)
    doc.save(str(pdf)); doc.close()
    _wipe_library()
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, title, file_hash, arxiv_id, added_at)"
            " VALUES (?,?,?,?,'2024-01-01')",
            ("local-1", "本地版式", "localhash" + "0" * 60, docs[0]["arxiv"]),
        )
    # 把 PDF 放到 localhash 的 blob 位
    import shutil
    blob = get_settings().files_dir / "lo" / ("localhash" + "0" * 60 + ".pdf")
    blob.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pdf, blob)

    report = merge_svc.merge_from_file(path)
    assert report["documents"]["by_identity"] == 1
    assert report["documents"]["placeholder"] == 0
    assert report["reanchor"]["docs"] == 1
    assert report["reanchor"]["reanchored"] == 1
    with db() as conn:
        ann = conn.execute("SELECT document_id, page FROM annotations").fetchone()
        assert ann["document_id"] == "local-1"
        assert ann["page"] == 1


def test_merge_attaches_archive_pdfs():
    """归档带 files/ → PDF 落盘，占位的 file_missing 变 False。"""
    from app.services import library as lib
    docs = _seed_source(1)
    # 给源 hash 造真实 blob（导出时随之入包）
    src_blob = lib._blob_path(docs[0]["hash"])
    src_blob.parent.mkdir(parents=True, exist_ok=True)
    d = pymupdf.open(); d.new_page(); d.save(str(src_blob)); d.close()
    path = _archive(["library", "annotations", "pdfs"])
    _wipe_library()
    # 清 files/ 模拟目标机没有该文件
    import shutil
    shutil.rmtree(get_settings().files_dir)
    get_settings().files_dir.mkdir(parents=True)

    report = merge_svc.merge_from_file(path)
    # 其他测试可能在 files/ 留有 blob 并随归档打包，按本测试的目标 blob 断言
    assert report["pdfs_attached_from_archive"] >= 1
    assert src_blob.exists()
    with db() as conn:
        row = conn.execute("SELECT file_hash FROM documents").fetchone()
        assert row["file_hash"] == docs[0]["hash"]
    assert lib._blob_path(docs[0]["hash"]).exists()


def test_merge_encrypted_archive():
    docs = _seed_source(1)
    path = _archive(["library", "annotations", "ai"], password="pw-7")
    _wipe_library()
    import pytest
    with pytest.raises(RuntimeError):
        merge_svc.merge_from_file(path, "wrong")
    report = merge_svc.merge_from_file(path, "pw-7")
    assert report["documents"]["placeholder"] == 1
