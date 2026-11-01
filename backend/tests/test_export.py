"""本地导出（可选类目）：类目过滤、依赖强制、密钥剔除、恢复安全闸。"""
from __future__ import annotations

import io
import contextlib
import itertools
import json
import sqlite3
import tarfile
import tempfile
from pathlib import Path

import pytest

from app.core.config import get_settings
from app.core.db import db
from app.services import backup as backup_svc
from app.services import export as export_svc

_db_seq = itertools.count()


@pytest.fixture()
def seeded_library():
    """一篇文献 + 标注 + 总结 + 会话 + 设置（含密钥类）的迷你库。返回 doc_id。"""
    import uuid as _uuid

    doc_id = str(_uuid.uuid4())
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, title, file_hash, added_at) "
            "VALUES (?,?,?,datetime('now'))",
            (doc_id, "OccFusion", "hash-export-1"),
        )
        conn.execute(
            "INSERT INTO annotations (id, document_id, page, kind, color, rects,"
            " quote, comment, side, created_at, updated_at)"
            " VALUES ('ann-1', ?, 3, 'highlight', '#ffd400', '[[0.1,0.1,0.2,0.2]]',"
            " 'occupancy fusion', '关键思路', 'source', datetime('now'), datetime('now'))",
            (doc_id,),
        )
        conn.execute(
            "INSERT INTO summaries (id, document_id, kind, content, created_at)"
            " VALUES ('sum-1', ?, 'overview', '总结内容', datetime('now'))",
            (doc_id,),
        )
        conn.execute(
            "INSERT INTO segments (id, document_id, idx, kind, source, page)"
            " VALUES ('seg-1', ?, 0, 'text', 'source text', 1)",
            (doc_id,),
        )
        conn.execute(
            "INSERT INTO translations (segment_id, provider, target_lang, text, created_at)"
            " VALUES ('seg-1', 'test', 'zh', '译文', datetime('now'))",
        )
        conn.execute(
            "INSERT INTO settings (key, value) VALUES "
            "('ui.view_mode', '\"pdf\"'),"
            "('ai.api_key', '\"sk-secret\"'),"
            "('github.token', '\"gh-secret\"'),"
            "('glossary', '\"{}\"')",
        )
    return doc_id


def _open_archive(blob: bytes) -> tuple[tarfile.TarFile, dict]:
    """解开导出归档，返回 (tar, EXPORT_INFO 清单)。"""
    tar = tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz")
    member = tar.getmember(export_svc.EXPORT_MANIFEST_NAME)
    manifest = json.loads(tar.extractfile(member).read().decode("utf-8"))  # type: ignore[union-attr]
    return tar, manifest


@contextlib.contextmanager
def _archive_db(tar: tarfile.TarFile):
    """把归档里的 library.db 落到临时文件，yield 连接，退出时清理。"""
    data = tar.extractfile("library.db").read()  # type: ignore[union-attr]
    tmp = Path(tempfile.gettempdir()) / f"pr-export-test-{next(_db_seq)}.db"
    tmp.write_bytes(data)
    conn = sqlite3.connect(tmp)
    try:
        yield conn
    finally:
        conn.close()
        tmp.unlink(missing_ok=True)


def _export_file(name: str) -> bytes:
    return (get_settings().backups_dir / name).read_bytes()


def test_partial_export_filters_categories(seeded_library):
    """只选标注：依赖强制带上 library；其余表清空；附 Markdown；不含文件目录。"""
    r = export_svc.build_export(["annotations"])
    assert "library" in r["categories"]
    assert r["complete"] is False

    tar, manifest = _open_archive(_export_file(r["file_name"]))
    assert manifest["complete"] is False
    assert manifest["categories"] == r["categories"]

    with _archive_db(tar) as conn:
        assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM annotations").fetchone()[0] == 1
        # 未选类目的表为空
        assert conn.execute("SELECT COUNT(*) FROM summaries").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM segments").fetchone()[0] == 0

    # 人类可读标注 Markdown 存在，且内容含文献标题
    md = tar.extractfile(
        next(m for m in tar.getnames() if m.startswith("annotations-md/"))
    ).read().decode("utf-8")  # type: ignore[union-attr]
    assert "OccFusion" in md and "occupancy fusion" in md

    # 未勾选的文件目录不入包
    assert not any(n.startswith(("files/", "parsed/")) for n in tar.getnames())
    tar.close()


def test_settings_export_redacts_secrets(seeded_library):
    """选 settings：密钥被剔，普通偏好与术语表保留。"""
    r = export_svc.build_export(["settings"])
    assert r["complete"] is False

    tar, _ = _open_archive(_export_file(r["file_name"]))
    with _archive_db(tar) as conn:
        keys = {k for (k,) in conn.execute("SELECT key FROM settings").fetchall()}
        assert "ai.api_key" not in keys
        assert "github.token" not in keys
        assert "ui.view_mode" in keys
        assert "glossary" in keys
    tar.close()


def test_complete_export_is_restorable(seeded_library):
    """全类目：complete=true，且通过恢复安全闸。"""
    r = export_svc.build_export(list(export_svc.CATEGORY_TABLES))
    assert r["complete"] is True
    # 完整导出不应被安全闸拦截
    backup_svc.validate_restore_blob(_export_file(r["file_name"]))


def test_restore_rejects_partial_export(seeded_library):
    """部分导出走恢复：安全闸在任何破坏前拒绝。"""
    r = export_svc.build_export(["annotations"])
    with pytest.raises(RuntimeError, match="部分导出"):
        backup_svc.validate_restore_blob(_export_file(r["file_name"]))


def test_restore_allows_plain_backup(seeded_library):
    """普通备份（BACKUP_INFO.json，无 EXPORT_INFO）不受影响。"""
    blob, _ = backup_svc._build_archive(include_pdfs=False)
    backup_svc.validate_restore_blob(blob)  # 不抛错即通过


def test_normalize_categories_forces_library():
    assert export_svc.normalize_categories(["annotations"]) == ["annotations", "library"]
    assert export_svc.normalize_categories(["settings"]) == ["settings"]
    # 未知类目被过滤
    assert export_svc.normalize_categories(["settings", "nope"]) == ["settings"]


def test_list_and_delete(seeded_library):
    export_svc.build_export(["settings"])
    listing = export_svc.list_exports()
    assert len(listing["exports"]) >= 1
    name = listing["exports"][0]["file_name"]
    assert name.startswith("export-")

    export_svc.delete_export(name)
    listing2 = export_svc.list_exports()
    assert all(x["file_name"] != name for x in listing2["exports"])

    # 名字校验：目录穿越被拒
    with pytest.raises(ValueError):
        export_svc.export_path("../library.db")
    with pytest.raises(ValueError):
        export_svc.export_path("library.db")


def test_meta_counts(seeded_library):
    meta = export_svc.export_meta()
    by_key = {c["key"]: c for c in meta["categories"]}
    assert by_key["library"]["count"] == 1
    assert by_key["annotations"]["count"] == 1
    assert by_key["ai"]["count"] == 1


def test_restore_from_file_complete(seeded_library):
    """全类目导出 → 从文件恢复 → 数据回到库里。"""
    r = export_svc.build_export(list(export_svc.CATEGORY_TABLES))
    result = backup_svc.restore_from_file(get_settings().backups_dir / r["file_name"])
    assert result["ok"] is True
    assert result["restored_files"] >= 1
    with db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM annotations").fetchone()[0] == 1


def test_restore_from_file_rejects_partial_before_damage(seeded_library):
    """部分导出恢复被拒，且在任何破坏性步骤之前（未新增 before-restore 备份）。"""
    # 清掉其他恢复测试留下的历史备份文件，隔离断言
    for old in get_settings().lib_root.glob("library.db.before-restore-*"):
        old.unlink()
    r = export_svc.build_export(["settings"])
    with pytest.raises(RuntimeError, match="部分导出"):
        backup_svc.restore_from_file(get_settings().backups_dir / r["file_name"])
    # 安全闸先于「另存当前库」执行：不应出现任何 before-restore 文件
    assert not list(get_settings().lib_root.glob("library.db.before-restore-*"))


def test_restore_from_file_encrypted_roundtrip(seeded_library):
    """加密导出 → 错口令报错 → 正确口令恢复成功。"""
    r = export_svc.build_export(list(export_svc.CATEGORY_TABLES), password="pw-123")
    path = get_settings().backups_dir / r["file_name"]
    with pytest.raises(RuntimeError):
        backup_svc.restore_from_file(path, "wrong-pw")
    result = backup_svc.restore_from_file(path, "pw-123")
    assert result["ok"] is True


def test_restore_from_file_rejects_garbage(seeded_library):
    """非归档文件给明确报错，而不是半路崩溃。"""
    import pytest as _pytest

    bad = get_settings().backups_dir / "export-bad.tar.gz"
    bad.write_bytes(b"not a tar at all")
    with _pytest.raises(Exception):
        backup_svc.restore_from_file(bad)
