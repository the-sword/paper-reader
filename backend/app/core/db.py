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
  -- 阅读视图（段落流）的标注：指向具体段落，rects 为空
  segment_id  TEXT,
  -- 译文标注时记录其归属，'source' / 'zh'
  side        TEXT DEFAULT 'source',
  -- 段落内字符偏移（部分标注用）；为空表示整段标注
  start_offset INTEGER,
  end_offset   INTEGER,
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
  page        INTEGER NOT NULL DEFAULT 1,
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

-- 划词翻译缓存（跨文献复用）
CREATE TABLE IF NOT EXISTS term_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 每日情报推荐条目表
CREATE TABLE IF NOT EXISTS digest_items (
  id        TEXT PRIMARY KEY,
  source    TEXT NOT NULL,          -- 'arxiv' | 'github'
  date      TEXT NOT NULL,          -- YYYY-MM-DD
  title     TEXT NOT NULL,
  url       TEXT NOT NULL,
  summary   TEXT,
  score     REAL DEFAULT 0.0,
  meta      TEXT,                   -- JSON 附加字段 (authors, stars, star_growth, categories, lang 等)
  status    TEXT DEFAULT 'new'      -- 'new' | 'imported' | 'ignored'
);
CREATE INDEX IF NOT EXISTS idx_digest_items_date ON digest_items(date);
CREATE INDEX IF NOT EXISTS idx_digest_items_source ON digest_items(source);

-- 每日情报去重与永久动作历史表 (仅留 ID 指纹，占用极小)
CREATE TABLE IF NOT EXISTS digest_history (
  id              TEXT PRIMARY KEY,  -- 归一化 ID: 'arxiv:2401.12345' 或 'github:owner/repo'
  source          TEXT NOT NULL,
  first_seen_date TEXT NOT NULL,
  last_seen_date  TEXT NOT NULL,
  user_action     TEXT DEFAULT 'new' -- 'new' | 'imported' | 'ignored'
);
CREATE INDEX IF NOT EXISTS idx_digest_history_action ON digest_history(user_action);

-- GitHub Star 历史打点表 (计算过去24小时/7天日增速)
CREATE TABLE IF NOT EXISTS github_stars (
  full_name TEXT NOT NULL,
  date      TEXT NOT NULL,
  stars     INTEGER NOT NULL,
  PRIMARY KEY (full_name, date)
);

-- ===== Paper-Code Radar（docs/radar_srs.md §4.1）=====

-- Topic 配置（冗余落库便于归档回溯；运行时真源为 settings 表 radar.topics JSON）
CREATE TABLE IF NOT EXISTS radar_topics (
  id         TEXT PRIMARY KEY,       -- topic id（如 embodied_perception）
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,          -- JSON：完整 Topic 定义
  updated_at TEXT NOT NULL
);

-- 论文条目（含评审结果；同一论文命中多 Topic 时按 (id, topic_id) 存多行）
CREATE TABLE IF NOT EXISTS radar_papers (
  id            TEXT NOT NULL,       -- arxiv:<id>（去版本号）
  topic_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  authors       TEXT,                -- JSON array
  abstract      TEXT,
  categories    TEXT,                -- JSON array
  published     TEXT,                -- 完整 ISO 时间戳（HH:MM 保留，用于 24h 窗口）
  code_status   TEXT DEFAULT 'no_code',   -- code_available|placeholder|no_code
  repo_url      TEXT,
  review_status TEXT DEFAULT 'pending',   -- pending|reviewed|review_failed|skipped
  review        TEXT,                -- JSON：LLM 评审卡片
  score         REAL,                -- 冗余 relevance_score，便于排序
  archived      INTEGER DEFAULT 0,   -- 已写入每日归档标记
  first_seen    TEXT NOT NULL,
  PRIMARY KEY (id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_radar_papers_date ON radar_papers(first_seen);
CREATE INDEX IF NOT EXISTS idx_radar_papers_topic ON radar_papers(topic_id, score);

-- GitHub 仓库审计缓存（7 天内不重复请求 API）
CREATE TABLE IF NOT EXISTS radar_repos (
  full_name  TEXT PRIMARY KEY,       -- owner/repo（小写）
  is_valid   INTEGER,
  is_empty   INTEGER,
  stars      INTEGER,
  language   TEXT,
  pushed_at  TEXT,
  checked_at TEXT NOT NULL
);

-- FTS5 全文索引（external content 模式，跟随 radar_papers 同步）
CREATE VIRTUAL TABLE IF NOT EXISTS radar_fts USING fts5(
  paper_id UNINDEXED, title, abstract, summary_zh, innovation_zh
);

-- 独立开源项目发现条目（不依附于论文；防重走 digest_history，id 为 github:owner/repo）
CREATE TABLE IF NOT EXISTS radar_repo_items (
  id          TEXT PRIMARY KEY,      -- github:owner/repo
  date        TEXT NOT NULL,         -- 北京日期 YYYY-MM-DD
  topic_id    TEXT NOT NULL,
  title       TEXT NOT NULL,         -- owner/repo 展示名
  url         TEXT NOT NULL,
  description TEXT,
  stars       INTEGER DEFAULT 0,
  star_growth INTEGER DEFAULT 0,
  language    TEXT,
  pushed_at   TEXT,
  created_at  TEXT,
  score       REAL DEFAULT 0,        -- 增速评分，排序用
  first_seen  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_radar_repo_items_date ON radar_repo_items(date);
"""


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")

    # --- VPS 优化：低配机器磁盘 IO 是瓶颈 ---
    # WAL 已启用（读写不互斥）。synchronous=NORMAL 在 WAL 下足够安全：
    # 断电最多丢最后一个事务，但不会损坏库；相比 FULL 大幅减少 fsync。
    conn.execute("PRAGMA synchronous=NORMAL")
    # 负值 = KB，2MB 页缓存（2C2G 机器不宜给太大）
    conn.execute("PRAGMA cache_size=-2000")
    # 临时表放内存，减少磁盘写
    conn.execute("PRAGMA temp_store=MEMORY")
    # 锁等待 30s，避免并发下立即报 database is locked
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """轻量迁移：只做加列，不动已有数据。"""
    def cols(table: str) -> set[str]:
        return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}

    if "page" not in cols("segments"):
        conn.execute("ALTER TABLE segments ADD COLUMN page INTEGER NOT NULL DEFAULT 1")

    # 阅读视图标注：段落锚点
    ann_cols = cols("annotations")
    if "segment_id" not in ann_cols:
        conn.execute("ALTER TABLE annotations ADD COLUMN segment_id TEXT")
    if "side" not in ann_cols:
        conn.execute("ALTER TABLE annotations ADD COLUMN side TEXT DEFAULT 'source'")
    if "start_offset" not in ann_cols:
        conn.execute("ALTER TABLE annotations ADD COLUMN start_offset INTEGER")
    if "end_offset" not in ann_cols:
        conn.execute("ALTER TABLE annotations ADD COLUMN end_offset INTEGER")

    # 情报雷达：导入后记录文献 doc_id，看板「打开阅读」直达
    radar_cols = cols("radar_papers")
    if "imported_doc_id" not in radar_cols:
        conn.execute("ALTER TABLE radar_papers ADD COLUMN imported_doc_id TEXT")


def init_db() -> None:
    s = get_settings()
    s.ensure_dirs()
    conn = _connect(s.db_path)
    try:
        conn.executescript(SCHEMA)
        _migrate(conn)
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


def cleanup_retention(days: int = 180) -> dict[str, int]:
    """轻量清理策略：清理超过 180 天且未入库的推荐条目，保留防重指纹。"""
    with db() as conn:
        cur1 = conn.execute(
            """
            DELETE FROM digest_items
            WHERE date < date('now', '-' || ? || ' days')
              AND status != 'imported'
            """,
            (days,),
        )
        deleted_items = cur1.rowcount

        cur2 = conn.execute(
            """
            DELETE FROM github_stars
            WHERE date < date('now', '-' || ? || ' days')
            """,
            (days,),
        )
        deleted_stars = cur2.rowcount

    return {
        "deleted_items": max(0, deleted_items),
        "deleted_stars": max(0, deleted_stars),
    }

