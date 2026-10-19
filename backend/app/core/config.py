"""集中配置。所有路径与外部服务参数都从环境变量读取，保证本地→VPS 迁移只改 .env。"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_lib_root() -> Path:
    return Path(os.environ.get("LIB_ROOT", Path.home() / "paper-reader"))


# 项目根目录 = backend/ 的上一级
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BACKEND_DIR = Path(__file__).resolve().parents[2]


def _read_env_file(path: Path) -> dict[str, str]:
    """解析单个 .env，返回 {大写键: 值}。空值不返回。"""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if not key or not val:
            continue  # 空值跳过，避免覆盖其它来源的非空配置
        out[key] = val
    return out


def merged_env() -> dict[str, str]:
    """合并两处 .env，backend/.env 优先，但空值永远不覆盖非空值。

    背景：用户常把 .env 放在项目根目录，而程序按 backend/.env 读取，
    或者两处都放、其中一处留空。这里统一兜住所有情况。
    """
    merged: dict[str, str] = {}
    # 优先级从低到高：项目根 → backend
    for path in (_PROJECT_ROOT / ".env", _BACKEND_DIR / ".env"):
        merged.update(_read_env_file(path))
    return merged


_ENV_VALUES = merged_env()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=None,          # 不用 pydantic 的文件加载，改用上面的手动合并
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def __init__(self, **values):
        """把合并后的 .env 作为最低优先级的初值，系统环境变量仍可覆盖。"""
        base = {k.lower(): v for k, v in _ENV_VALUES.items()}
        base.update(values)
        super().__init__(**base)

    # ---- 数据 ----
    lib_root: Path = _default_lib_root()

    # ---- 服务 ----
    host: str = "127.0.0.1"
    port: int = 8787
    auth_token: str = ""  # 留空则不启用鉴权（仅本地开发）
    paper_reader_secret: str = ""  # 加密库中 API key 的主密钥

    # ---- MinerU ----
    mineru_token: str = ""
    mineru_model: str = "vlm"
    mineru_base: str = "https://mineru.net/api/v4"

    # ---- AI（UI 里配置的优先级更高）----
    ai_base_url: str = ""
    ai_api_key: str = ""
    ai_model: str = ""

    # ---- 派生路径 ----
    @property
    def db_path(self) -> Path:
        return self.lib_root / "library.db"

    @property
    def files_dir(self) -> Path:
        return self.lib_root / "files"

    @property
    def parsed_dir(self) -> Path:
        return self.lib_root / "parsed"

    @property
    def backups_dir(self) -> Path:
        return self.lib_root / "backups"

    def ensure_dirs(self) -> None:
        for d in (self.lib_root, self.files_dir, self.parsed_dir, self.backups_dir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s
