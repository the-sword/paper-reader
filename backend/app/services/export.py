"""本地数据导出（可选类目）。

与 WebDAV 全量备份（backup.py）同构的 tar.gz：库文件 + files/ + parsed/ +
清单。区别在于可以勾选类目——未选类目的表在快照中被清空、未选的文件目录
不入包，并写入 EXPORT_INFO.json 记录类目与 complete 标记：

  - complete = 全部类目都被勾选 → 该文件与全量备份等价，
    可走现有「从远端恢复」流程（先手动上传到 WebDAV）
  - complete = false → 部分导出，仅供留存/检视；restore() 侧有
    安全闸（backup.validate_restore_blob）在任何破坏性步骤之前拒绝

安全：settings 类目导出时剔除密钥（ai.api_key / webdav / engine.* /
github.token），比备份侧多剔 github.token——导出文件更常被随意存放。
"""
from __future__ import annotations

import io
import json
import re
import sqlite3
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..core.config import get_settings
from ..core.db import db
from . import backup as backup_svc
from . import notes as notes_svc

EXPORT_MANIFEST_NAME = "EXPORT_INFO.json"

# 导出侧的敏感键（= 备份侧 + github.token）
SENSITIVE_SETTING_PREFIXES = backup_svc.SENSITIVE_SETTING_PREFIXES + ("github.token",)

# 类目 -> 表。未勾选的类目在快照中整表清空。
CATEGORY_TABLES: dict[str, list[str]] = {
    "settings": ["settings"],
    "library": ["documents", "folders", "document_folders", "tags", "document_tags"],
    "annotations": ["annotations"],
    "ai": ["summaries", "reader_sessions", "reader_messages"],
    "translations": ["segments", "translations", "term_cache"],
    "parsed": [],   # parsed/ 目录，无表
    "pdfs": [],     # files/ 目录，无表
    # radar：雷达表 + FTS 虚表（radar_fts_data 等影子表由 DELETE FROM radar_fts 级联清理）
    "radar": [
        "radar_papers", "radar_repos", "radar_repo_items", "radar_topics",
        "digest_items", "digest_history", "github_stars", "radar_fts",
    ],
}

#: 勾选这些类目时强制带上 library（没有文献元数据，其余数据无从对应）
LIBRARY_DEPS = ("annotations", "ai", "translations", "parsed", "pdfs")

#: 供前端展示的类目顺序与文案（后端是唯一真源，前端按 key 取）
CATEGORY_LABELS: dict[str, str] = {
    "settings": "设置与偏好",
    "library": "文献库元数据",
    "annotations": "标注与笔记",
    "ai": "AI 总结与会话",
    "translations": "翻译缓存",
    "parsed": "解析产物（含双语 PDF）",
    "pdfs": "PDF 原文",
    "radar": "雷达数据",
}

_EXPORT_NAME_RE = re.compile(r"^export-[A-Za-z0-9._-]+$")


def normalize_categories(selected: list[str]) -> list[str]:
    """过滤未知类目、应用 library 依赖，返回规范化后的类目列表。"""
    cats = [c for c in selected if c in CATEGORY_TABLES]
    if any(c in cats for c in LIBRARY_DEPS) and "library" not in cats:
        cats.append("library")
    return cats


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize_filename(name: str) -> str:
    """文献标题转安全文件名（去路径分隔符与控制字符）。"""
    cleaned = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", name).strip(" ._")
    return (cleaned or "untitled")[:80]


def _dir_stats(root: Path, pattern: str = "*") -> tuple[int, int]:
    """目录内匹配文件的 (个数, 总字节)。"""
    if not root.exists():
        return 0, 0
    count = total = 0
    for p in root.rglob(pattern):
        if p.is_file():
            count += 1
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return count, total


def _table_count(conn: sqlite3.Connection, table: str) -> int:
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608
    except sqlite3.Error:
        return 0


def export_meta() -> dict[str, Any]:
    """各类目的条数/体积，供前端勾选时展示。"""
    s = get_settings()
    with db() as conn:
        c = conn.cursor()
        counts = {
            "documents": c.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
            "annotations": c.execute("SELECT COUNT(*) FROM annotations").fetchone()[0],
            "summaries": c.execute("SELECT COUNT(*) FROM summaries").fetchone()[0],
            "sessions": c.execute("SELECT COUNT(*) FROM reader_sessions").fetchone()[0],
            "settings": c.execute("SELECT COUNT(*) FROM settings").fetchone()[0],
            "segments": c.execute("SELECT COUNT(*) FROM segments").fetchone()[0],
            "translations": c.execute("SELECT COUNT(*) FROM translations").fetchone()[0],
            "radar": c.execute("SELECT COUNT(*) FROM radar_papers").fetchone()[0],
        }
    pdf_count, pdf_bytes = _dir_stats(s.files_dir, "*.pdf")
    parsed_count, parsed_bytes = _dir_stats(s.parsed_dir)
    return {
        "categories": [
            {"key": "settings", "label": CATEGORY_LABELS["settings"], "count": counts["settings"]},
            {"key": "library", "label": CATEGORY_LABELS["library"], "count": counts["documents"]},
            {"key": "annotations", "label": CATEGORY_LABELS["annotations"], "count": counts["annotations"]},
            {"key": "ai", "label": CATEGORY_LABELS["ai"],
             "count": counts["summaries"] + counts["sessions"]},
            {"key": "translations", "label": CATEGORY_LABELS["translations"],
             "count": counts["segments"] + counts["translations"]},
            {"key": "parsed", "label": CATEGORY_LABELS["parsed"],
             "count": parsed_count, "bytes": parsed_bytes},
            {"key": "pdfs", "label": CATEGORY_LABELS["pdfs"],
             "count": pdf_count, "bytes": pdf_bytes},
            {"key": "radar", "label": CATEGORY_LABELS["radar"], "count": counts["radar"]},
        ],
    }


def _snapshot_db(tmp_db: Path, categories: list[str]) -> None:
    """一致性快照 + 按类目清表 + 剔密钥。"""
    src = sqlite3.connect(get_settings().db_path)
    dst = sqlite3.connect(tmp_db)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()

    conn = sqlite3.connect(tmp_db)
    try:
        # 未选类目 → 整表清空（radar_fts 是虚表，DELETE 级联清影子表）
        for cat, tables in CATEGORY_TABLES.items():
            if cat in categories:
                continue
            for t in tables:
                try:
                    conn.execute(f"DELETE FROM {t}")  # noqa: S608
                except sqlite3.Error:
                    pass  # 表不存在（老库迁移前）时跳过
        # settings 选中时剔除密钥类键（未选中时上面已整表清空）
        if "settings" in categories:
            for (key,) in conn.execute("SELECT key FROM settings").fetchall():
                if any(key == p or key.startswith(p) for p in SENSITIVE_SETTING_PREFIXES):
                    conn.execute("DELETE FROM settings WHERE key=?", (key,))
        conn.commit()
    finally:
        conn.close()


def _add_dir(tar: tarfile.TarFile, root: Path, files_added: list[str],
             total: list[int], pattern: str = "*") -> None:
    if not root.exists():
        return
    for p in root.rglob(pattern):
        if not p.is_file():
            continue
        rel = p.relative_to(get_settings().lib_root)
        tar.add(p, arcname=str(rel))
        files_added.append(str(rel))
        total[0] += p.stat().st_size


def build_export(categories: list[str], password: str | None = None) -> dict[str, Any]:
    """按类目打包，写入 backups/ 目录。返回摘要信息。"""
    s = get_settings()
    cats = normalize_categories(categories)
    complete = set(cats) == set(CATEGORY_TABLES)

    buf = io.BytesIO()
    files_added: list[str] = []
    total = [0]

    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        # 1) 库快照（始终包含：未选类目的表为空，但 schema 完整）
        tmp_db = Path(tempfile.gettempdir()) / f"pr-export-{datetime.now().timestamp()}.db"
        try:
            _snapshot_db(tmp_db, cats)
            tar.add(tmp_db, arcname="library.db")
            files_added.append("library.db")
            total[0] += tmp_db.stat().st_size
        finally:
            tmp_db.unlink(missing_ok=True)

        # 2) 标注的 Markdown 版（人类可读，仅勾选标注时）
        if "annotations" in cats:
            with db() as conn:
                doc_ids = [r["id"] for r in conn.execute(
                    "SELECT d.id FROM documents d "
                    "WHERE EXISTS (SELECT 1 FROM annotations a WHERE a.document_id = d.id)"
                ).fetchall()]
            for doc_id in doc_ids:
                try:
                    md = notes_svc.export_markdown(doc_id).encode("utf-8")
                except Exception:  # noqa: BLE001 — 单篇失败不阻断整包
                    continue
                title = _doc_title(doc_id)
                name = f"annotations-md/{doc_id[:8]}-{_sanitize_filename(title)}.md"
                info = tarfile.TarInfo(name)
                info.size = len(md)
                tar.addfile(info, io.BytesIO(md))
                files_added.append(name)
                total[0] += len(md)

        # 3) 解析产物（含双语 PDF）
        if "parsed" in cats:
            _add_dir(tar, s.parsed_dir, files_added, total)

        # 4) PDF 原文
        if "pdfs" in cats:
            _add_dir(tar, s.files_dir, files_added, total, pattern="*.pdf")

        # 5) 导出清单（区别于备份的 BACKUP_INFO.json，恢复侧据此识别）
        manifest = {
            "created_at": _now(),
            "categories": cats,
            "complete": complete,
            "file_count": len(files_added),
            "total_bytes": total[0],
            "source_lib_root": str(s.lib_root),
        }
        data = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
        info = tarfile.TarInfo(EXPORT_MANIFEST_NAME)
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))

    blob = buf.getvalue()
    encrypted = bool(password and password.strip())
    if encrypted:
        blob = backup_svc.encrypt_archive(blob, password.strip())  # type: ignore[arg-type]

    # 毫秒级时间戳：同秒内连续导出不互相覆盖
    now = datetime.now()
    stamp = now.strftime("%Y%m%d-%H%M%S") + now.strftime("%f")[:3]
    suffix = backup_svc.ENCRYPTED_SUFFIX if encrypted else ""
    name = f"export-{stamp}.tar.gz{suffix}"
    s.backups_dir.mkdir(parents=True, exist_ok=True)
    (s.backups_dir / name).write_bytes(blob)

    return {
        "ok": True,
        "file_name": name,
        "size_bytes": len(blob),
        "size_mb": round(len(blob) / 1024 / 1024, 2),
        "file_count": manifest["file_count"],
        "categories": cats,
        "complete": complete,
        "encrypted": encrypted,
        "created_at": manifest["created_at"],
    }


def _doc_title(doc_id: str) -> str:
    with db() as conn:
        row = conn.execute("SELECT title FROM documents WHERE id=?", (doc_id,)).fetchone()
    return row["title"] if row else "untitled"


def list_exports() -> dict[str, Any]:
    """backups/ 下的导出文件（新→旧）。"""
    s = get_settings()
    items: list[dict[str, Any]] = []
    if s.backups_dir.exists():
        for p in s.backups_dir.iterdir():
            if not _EXPORT_NAME_RE.match(p.name):
                continue
            st = p.stat()
            items.append({
                "file_name": p.name,
                "size_bytes": st.st_size,
                "size_mb": round(st.st_size / 1024 / 1024, 2),
                "created_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                "encrypted": p.name.endswith(backup_svc.ENCRYPTED_SUFFIX),
            })
    items.sort(key=lambda x: x["file_name"], reverse=True)
    return {"exports": items}


def export_path(name: str) -> Path:
    """校验导出文件名并返回其路径（防目录穿越）。"""
    if not _EXPORT_NAME_RE.match(name):
        raise ValueError("非法的文件名")
    p = (get_settings().backups_dir / name).resolve()
    if p.parent != get_settings().backups_dir.resolve():
        raise ValueError("非法的文件名")
    if not p.exists():
        raise FileNotFoundError("导出文件不存在")
    return p


def delete_export(name: str) -> None:
    export_path(name).unlink(missing_ok=True)
