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

import base64
import io
import json
import os
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

# 归档加密后的文件扩展名
ENCRYPTED_SUFFIX = ".enc"

# 备份中需要排除的敏感键（AI key、各类 token、密码）
SENSITIVE_SETTING_PREFIXES = (
    "ai.api_key",
    "webdav",
    "engine.",
)

PBKDF2_ITERATIONS = 200_000


def _derive_key(password: str, salt: bytes) -> bytes:
    """用 PBKDF2-HMAC-SHA256 从口令派生 Fernet 密钥。"""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return base64.urlsafe_b64encode(kdf.derive(password.encode("utf-8")))


def encrypt_archive(blob: bytes, password: str) -> bytes:
    """加密归档。输出格式：MAGIC(8) + salt(16) + Fernet 密文。"""
    from cryptography.fernet import Fernet

    salt = os.urandom(16)
    f = Fernet(_derive_key(password, salt))
    return b"PRBAK001" + salt + f.encrypt(blob)


def decrypt_archive(blob: bytes, password: str) -> bytes:
    """解密归档。校验魔数与口令。"""
    from cryptography.fernet import Fernet, InvalidToken

    if not blob.startswith(b"PRBAK001"):
        raise RuntimeError("不是加密的备份文件")
    salt = blob[8:24]
    cipher = blob[24:]
    f = Fernet(_derive_key(password, salt))
    try:
        return f.decrypt(cipher)
    except InvalidToken as e:
        raise RuntimeError("密码错误或文件已损坏") from e


def _redact_sensitive(db_snapshot: Path) -> str:
    """从数据库快照中删除敏感配置，返回删除的键数。

    备份可能被放到不受控的 WebDAV 或公开仓库，密钥不应随备份流动。
    恢复后由用户在设置里重新填写。
    """
    import sqlite3

    deleted = 0
    conn = sqlite3.connect(db_snapshot)
    try:
        rows = conn.execute("SELECT key FROM settings").fetchall()
        for (key,) in rows:
            if any(key == p or key.startswith(p) for p in SENSITIVE_SETTING_PREFIXES):
                conn.execute("DELETE FROM settings WHERE key=?", (key,))
                deleted += 1
        conn.commit()
    finally:
        conn.close()
    return deleted


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
            # 剔除密钥类配置，避免随备份外流
            _redact_sensitive(tmp_db)
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


def backup(include_pdfs: bool = False, password: str | None = None) -> dict[str, Any]:
    """打包并上传到 WebDAV。password 非空时加密后再上传。"""
    endpoint = _endpoint()
    user, pw = _auth()

    blob, manifest = _build_archive(include_pdfs)
    encrypted = bool(password and password.strip())
    if encrypted:
        blob = encrypt_archive(blob, password.strip())

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
        "encrypted": encrypted,
        "settings_redacted": True,
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

def restore(password: str | None = None) -> dict[str, Any]:
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

    # 加密归档需先解密
    payload = r.content
    if payload.startswith(b"PRBAK001"):
        if not (password and password.strip()):
            raise RuntimeError("该备份已加密，请输入密码")
        payload = decrypt_archive(payload, password.strip())

    # 先备份当前状态
    if s.db_path.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(s.db_path, s.lib_root / f"library.db.before-restore-{stamp}")

    extracted = 0
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
        for member in tar.getmembers():
            # 安全：拒绝绝对路径和 .. 穿越
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                continue
            # 拒绝符号链接/硬链接/设备成员：恶意归档可先放一个指向
            # lib_root 之外的链接成员，再经该链接把文件写出数据目录
            # （自产备份只含普通文件，跳过链接不影响正常恢复）
            if member.issym() or member.islnk() or member.isdev():
                continue
            try:
                # Python 3.12+（及旧版安全补丁）自带 data 过滤器，
                # 再兜一层目录穿越/权限剥离；无该参数的旧版本走上面的手动检查
                tar.extract(member, path=s.lib_root, filter="data")
            except TypeError:
                tar.extract(member, path=s.lib_root)
            if member.isfile():
                extracted += 1

    # 清掉旧库的 WAL/SHM 残留：它们属于被覆盖前的旧库文件，
    # 留着会被 SQLite 套用到恢复后的新库上，导致数据错乱/损坏
    for suffix in ("-wal", "-shm"):
        stale = s.db_path.with_name(s.db_path.name + suffix)
        stale.unlink(missing_ok=True)

    return {"ok": True, "restored_files": extracted,
            "message": "恢复完成。建议重启服务使新库完全生效"}
