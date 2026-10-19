"""集中配置。所有路径与外部服务参数都从环境变量读取，保证本地→VPS 迁移只改 .env。"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_lib_root() -> Path:
    return Path(os.environ.get("LIB_ROOT", Path.home() / "paper-reader"))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

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
