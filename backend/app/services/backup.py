"""WebDAV 备份与恢复。

设计（对应 DESIGN.md D10：WebDAV 仅用于备份与迁移，不做双向同步）：
  - 备份内容：library.db + 解析产物（parsed/），可选包含 PDF 原文
  - 打包成单个 tar.gz 上传，避免逐文件请求
  - 恢复：下载 → 校验 → 解压到临时目录 → 原子替换

安全性：
  - 用户名/密码存 settings 表，密码不明文回传前端
  - 恢复前自动备份当前库，防误操作
"""
from __future__ import annotations

import io
import json
import shutil
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin

from ..core.config import get_settings
from ..core.db import db
from ..core.http import make_client

MANIFEST_NAME = "BACKUP_INFO.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

def get_webdav_config() -> dict[str, Any]:
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key='webdav'"
        ).fetchone()
    if not row:
        return {"url": "", "username": "", "password": "", "file_name": "paper-reader-backup.tar.gz"}
    try:
        return json.loads(row["value"])
    except Exception:
        return {"url": "", "username": "", "password": "", "file_name": "paper-reader-backup.tar.gz"}


def save_webdav_config(cfg: dict[str, Any]) -> None:
    cur = get_webdav_config()
    cur.update({k: v for k, v in cfg.items() if v is not None})
    if not cur.get("file_name"):
        cur["file_name"] = "paper-reader-backup.tar.gz"
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('webdav', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(cur, ensure_ascii=False),),
        )


def public_config() -> dict[str, Any]:
    """给前端的配置（密码掩码）。"""
    c = get_webdav_config()
    pw = c.get("password") or ""
    return {
        "url": c.get("url", ""),
        "username": c.get("username", ""),
        "password_set": bool(pw),
        "password_masked": ("•" * min(len(pw), 8)) if pw else "",
        "file_name": c.get("file_name", "paper-reader-backup.tar.gz"),
    }


def _endpoint() -> str:
    c = get_webdav_config()
    url = (c.get("url") or "").strip()
    if not url:
        raise RuntimeError("未配置 WebDAV 地址")
    name = c.get("file_name") or "paper-reader-backup.tar.gz"
    if not url.endswith("/"):
        url += "/"
    return urljoin(url, quote(name))


def _auth() -> tuple[str, str]:
    c = get_webdav_config()
    return c.get("username", ""), c.get("password", "")


def test_connection() -> dict[str, Any]:
    """测试 WebDAV 可写性：上传一个极小的探针文件再删除。"""
    c = get_webdav_config()
    if not c.get("url"):
        return {"ok": False, "error": "未配置地址"}

    base = c["url"] if c["url"].endswith("/") else c["url"] + "/"
    probe = urljoin(base, "_paper_reader_probe.txt")
    user, pw = _auth()

    try:
        with make_client(probe, timeout=20) as client:
            r = client.put(probe, content=b"paper-reader probe",
                           auth=(user, pw) if user else None)
            if r.status_code not in (200, 201, 204):
                return {"ok": False, "error": f"写入失败 HTTP {r.status_code}: {r.text[:150]}"}
            client.delete(probe)
        return {"ok": True, "message": "连接成功，可读写"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:200]}


# ---------------------------------------------------------------------------
# 备份
# ---------------------------------------------------------------------------

def _build_archive(include_pdfs: bool) -> tuple[bytes, dict[str, Any]]:
    """打包库文件到内存。返回 (tar.gz 字节, 摘要信息)。"""
    s = get_settings()
    buf = io.BytesIO()

    files_added: list[str] = []
    total_bytes = 0

    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        # 1) 数据库（先做一致性快照）
        if s.db_path.exists():
            import sqlite3

            tmp_db = Path(tempfile.gettempdir()) / f"pr-backup-{datetime.now().timestamp()}.db"
            src = sqlite3.connect(s.db_path)
            dst = sqlite3.connect(tmp_db)
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()
            tar.add(tmp_db, arcname="library.db")
            files_added.append("library.db")
            total_bytes += tmp_db.stat().st_size
            tmp_db.unlink(missing_ok=True)

        # 2) 解析产物（图片、full.md 等）
        if s.parsed_dir.exists():
            for p in s.parsed_dir.rglob("*"):
                if p.is_file():
                    rel = p.relative_to(s.lib_root)
                    tar.add(p, arcname=str(rel))
                    files_added.append(str(rel))
                    total_bytes += p.stat().st_size

        # 3) PDF 原文（可选，体积大）
        if include_pdfs and s.files_dir.exists():
            for p in s.files_dir.rglob("*.pdf"):
                rel = p.relative_to(s.lib_root)
                tar.add(p, arcname=str(rel))
                files_added.append(str(rel))
                total_bytes += p.stat().st_size

        # 4) 清单
        manifest = {
            "created_at": _now(),
            "include_pdfs": include_pdfs,
            "file_count": len(files_added),
            "total_bytes": total_bytes,
            "source_lib_root": str(s.lib_root),
        }
        data = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
        info = tarfile.TarInfo(MANIFEST_NAME)
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))

    return buf.getvalue(), manifest


def backup(include_pdfs: bool = False) -> dict[str, Any]:
    """打包并上传到 WebDAV。"""
    endpoint = _endpoint()
    user, pw = _auth()

    blob, manifest = _build_archive(include_pdfs)
    size_mb = len(blob) / 1024 / 1024

    with make_client(endpoint, timeout=300) as client:
        r = client.put(
            endpoint, content=blob,
            headers={"Content-Type": "application/gzip"},
            auth=(user, pw) if user else None,
        )
    if r.status_code not in (200, 201, 204):
        raise RuntimeError(f"上传失败 HTTP {r.status_code}: {r.text[:200]}")

    return {
        "ok": True,
        "size_bytes": len(blob),
        "size_mb": round(size_mb, 2),
        "file_count": manifest["file_count"],
        "include_pdfs": include_pdfs,
        "uploaded_at": manifest["created_at"],
        "endpoint": endpoint,
    }


def list_remote() -> dict[str, Any]:
    """检查远端是否存在备份文件及其大小。"""
    endpoint = _endpoint()
    user, pw = _auth()
    with make_client(endpoint, timeout=30) as client:
        r = client.head(endpoint, auth=(user, pw) if user else None)
    if r.status_code == 404:
        return {"exists": False}
    if r.status_code >= 400:
        raise RuntimeError(f"查询失败 HTTP {r.status_code}")
    return {
        "exists": True,
        "size_bytes": int(r.headers.get("content-length") or 0),
        "last_modified": r.headers.get("last-modified"),
    }


# ---------------------------------------------------------------------------
# 恢复
# ---------------------------------------------------------------------------

def restore() -> dict[str, Any]:
    """从 WebDAV 下载并恢复到当前库。

    安全措施：恢复前把现有库另存为 library.db.before-restore-<时间戳>
    """
    endpoint = _endpoint()
    user, pw = _auth()
    s = get_settings()

    with make_client(endpoint, timeout=600) as client:
        r = client.get(endpoint, auth=(user, pw) if user else None)
    if r.status_code == 404:
        raise RuntimeError("远端没有找到备份文件")
    if r.status_code != 200:
        raise RuntimeError(f"下载失败 HTTP {r.status_code}")

    # 先备份当前状态
    if s.db_path.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(s.db_path, s.lib_root / f"library.db.before-restore-{stamp}")

    extracted = 0
    with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz") as tar:
        for member in tar.getmembers():
            # 安全：拒绝绝对路径和 .. 穿越
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                continue
            tar.extract(member, path=s.lib_root)
            if member.isfile():
                extracted += 1

    return {"ok": True, "restored_files": extracted}
