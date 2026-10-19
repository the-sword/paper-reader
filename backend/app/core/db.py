"""SQLite 连接与建表。WAL 模式，单文件即真相源。"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import get_settings

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  authors       TEXT,
  year          INTEGER,
  journal       TEXT,
  doi           TEXT,
  abstract      TEXT,
  file_hash     TEXT UNIQUE NOT NULL,
  file_name     TEXT,
  file_size     INTEGER,
  page_count    INTEGER,
  parse_status  TEXT DEFAULT 'pending',
  added_at      TEXT NOT NULL,
  opened_at     TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_folders (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, folder_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT DEFAULT '#888888',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);

CREATE TABLE IF NOT EXISTS annotations (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  color       TEXT,
  rects       TEXT NOT NULL,
  quote       TEXT,
  comment     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_doc ON annotations(document_id, page);

CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  section     TEXT,
  kind        TEXT NOT NULL,
  source      TEXT NOT NULL,
  bbox        TEXT,
  UNIQUE(document_id, idx)
);

CREATE TABLE IF NOT EXISTS translations (
  segment_id  TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  model       TEXT,
  target_lang TEXT NOT NULL DEFAULT 'zh-CN',
  text        TEXT NOT NULL,
  token_in    INTEGER,
  token_out   INTEGER,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (segment_id, provider, target_lang)
);

CREATE TABLE IF NOT EXISTS summaries (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  content     TEXT NOT NULL,
  model       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    s = get_settings()
    s.ensure_dirs()
    conn = _connect(s.db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """一次请求一个连接，退出时提交；异常回滚。"""
    s = get_settings()
    conn = _connect(s.db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
