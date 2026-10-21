"""每日情报雷达 (Daily Intelligence) 核心编排服务。

包含：
  - 关注主题读写配置
  - 候选池抓取、漏斗过滤、多维打分与 Top 5 截取
  - 物理唯一 ID 防重 + 用户动作记忆 (ignored/imported 永不二次推荐) + 14 天冷却期
  - 180 天轻量自动清理触发
  - 后台 08:00 定时检测线程
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any

from ..core.db import cleanup_retention, db
from . import arxiv_digest, github_digest, library

logger = logging.getLogger("digest")

DEFAULT_TOPICS = ["3D reconstruction", "3D Gaussian Splatting", "Point Cloud SLAM"]
TOPICS_KEY = "digest.topics"
ENABLED_KEY = "digest.scheduler.enabled"

_SCHEDULER_THREAD: threading.Thread | None = None
_SCHEDULER_STOP = threading.Event()


def get_topics() -> list[str]:
    """读取用户配置的关注主题关键词。"""
    try:
        with db() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (TOPICS_KEY,)).fetchone()
            if row and row["value"]:
                topics = json.loads(row["value"])
                if isinstance(topics, list) and topics:
                    return [str(t).strip() for t in topics if str(t).strip()]
    except Exception:
        pass
    return DEFAULT_TOPICS.copy()


def set_topics(topics: list[str]) -> list[str]:
    """更新关注主题关键词。"""
    cleaned = [t.strip() for t in topics if t.strip()]
    if not cleaned:
        cleaned = DEFAULT_TOPICS.copy()
    payload = json.dumps(cleaned, ensure_ascii=False)
    with db() as conn:
        conn.execute(
            """
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (TOPICS_KEY, payload),
        )
    return cleaned


def is_scheduler_enabled() -> bool:
    try:
        with db() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (ENABLED_KEY,)).fetchone()
            if row:
                return json.loads(row["value"]).get("enabled", True)
    except Exception:
        pass
    return True


def set_scheduler_enabled(enabled: bool) -> None:
    payload = json.dumps({"enabled": enabled})
    with db() as conn:
        conn.execute(
            """
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (ENABLED_KEY, payload),
        )


def _get_history_map() -> dict[str, dict[str, Any]]:
    """加载所有历史推荐记录的动作与首次推荐日期。"""
    history: dict[str, dict[str, Any]] = {}
    try:
        with db() as conn:
            rows = conn.execute(
                "SELECT id, source, first_seen_date, last_seen_date, user_action FROM digest_history"
            ).fetchall()
            for r in rows:
                history[r["id"]] = {
                    "source": r["source"],
                    "first_seen": r["first_seen_date"],
                    "action": r["user_action"],
                }
    except Exception:
        pass
    return history


def generate_daily_digest(target_date: str | None = None, force: bool = False) -> dict[str, Any]:
    """生成或获取指定日期的每日情报。

    规则：
      1. 若今日已有且非 force，直接返回数据库中条目；
      2. 否则抓取候选池，经过漏斗去重，挑选各 5 条优质条目存入 digest_items；
      3. 更新 digest_history，记录防重索引；
      4. 静默执行 180 天轻量自动清理。
    """
    now_utc = datetime.now(timezone.utc)
    today_str = target_date or now_utc.strftime("%Y-%m-%d")

    # 1. 检查今日是否已生成
    if not force:
        existing = get_digest_by_date(today_str)
        if existing:
            return {
                "date": today_str,
                "items": existing,
                "counts": {
                    "arxiv": sum(1 for x in existing if x["source"] == "arxiv"),
                    "github": sum(1 for x in existing if x["source"] == "github"),
                },
                "cached": True,
            }

    topics = get_topics()
    history = _get_history_map()

    # 2. 抓取候选池
    arxiv_candidates = arxiv_digest.search_arxiv_papers(topics, limit=35)
    github_candidates = github_digest.search_github_repositories(topics, limit=35)

    def is_eligible(item: dict[str, Any], is_github: bool = False) -> bool:
        item_id = item["id"]
        # 规则 A: 用户曾明确处置过（忽略或已导入），绝不二次推荐
        if item_id in history:
            h = history[item_id]
            if h.get("action") in ("ignored", "imported"):
                return False
            # 规则 B: 14 天冷却期（若在 14 天内推荐过，跳过给新条目让位）
            try:
                f_dt = datetime.strptime(h.get("first_seen", ""), "%Y-%m-%d").replace(tzinfo=timezone.utc)
                if (now_utc - f_dt).days < 14:
                    return False
            except Exception:
                pass

        # 规则 C: 若本地已有该论文，跳过
        if not is_github and item.get("meta", {}).get("already_in_library"):
            return False

        return True

    selected_arxiv: list[dict[str, Any]] = []
    for a in arxiv_candidates:
        if is_eligible(a, is_github=False):
            selected_arxiv.append(a)
        if len(selected_arxiv) >= 5:
            break

    # 兜底：若全都被过滤导致不够 5 篇，用最高分候选补齐（即便本地已有）
    if len(selected_arxiv) < 5:
        for a in arxiv_candidates:
            if a not in selected_arxiv and a["id"] not in [x["id"] for x in selected_arxiv]:
                selected_arxiv.append(a)
            if len(selected_arxiv) >= 5:
                break

    selected_github: list[dict[str, Any]] = []
    for g in github_candidates:
        if is_eligible(g, is_github=True):
            selected_github.append(g)
        if len(selected_github) >= 5:
            break

    if len(selected_github) < 5:
        for g in github_candidates:
            if g not in selected_github and g["id"] not in [x["id"] for x in selected_github]:
                selected_github.append(g)
            if len(selected_github) >= 5:
                break

    all_selected = selected_arxiv + selected_github

    # 3. 写入数据库
    with db() as conn:
        # 若是强制刷新，先清空今日已有条目
        if force:
            conn.execute("DELETE FROM digest_items WHERE date = ?", (today_str,))

        for it in all_selected:
            meta_json = json.dumps(it.get("meta", {}), ensure_ascii=False)
            conn.execute(
                """
                INSERT INTO digest_items (id, source, date, title, url, summary, score, meta, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
                ON CONFLICT(id) DO UPDATE SET
                  date=excluded.date,
                  title=excluded.title,
                  url=excluded.url,
                  summary=excluded.summary,
                  score=excluded.score,
                  meta=excluded.meta
                """,
                (it["id"], it["source"], today_str, it["title"], it["url"], it.get("summary", ""), it["score"], meta_json),
            )

            # 更新 history 防重表
            conn.execute(
                """
                INSERT INTO digest_history (id, source, first_seen_date, last_seen_date, user_action)
                VALUES (?, ?, ?, ?, 'new')
                ON CONFLICT(id) DO UPDATE SET
                  last_seen_date=excluded.last_seen_date
                """,
                (it["id"], it["source"], today_str, today_str),
            )

    # 4. 执行 180 天轻量自动清理（零感知维护）
    try:
        cleanup_retention(180)
    except Exception as e:
        logger.warning("180 天定时清理异常: %s", e)

    return {
        "date": today_str,
        "items": get_digest_by_date(today_str),
        "counts": {
            "arxiv": len(selected_arxiv),
            "github": len(selected_github),
        },
        "cached": False,
    }


def get_digest_by_date(date_str: str) -> list[dict[str, Any]]:
    """查询指定日期的每日情报条目（过滤掉已忽略条目）。"""
    results: list[dict[str, Any]] = []
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, source, date, title, url, summary, score, meta, status
            FROM digest_items
            WHERE date = ? AND status != 'ignored'
            ORDER BY source ASC, score DESC
            """,
            (date_str,),
        ).fetchall()
        for r in rows:
            meta = {}
            if r["meta"]:
                try:
                    meta = json.loads(r["meta"])
                except Exception:
                    meta = {}
            results.append({
                "id": r["id"],
                "source": r["source"],
                "date": r["date"],
                "title": r["title"],
                "url": r["url"],
                "summary": r["summary"],
                "score": r["score"],
                "meta": meta,
                "status": r["status"],
            })
    return results


def act_on_digest_item(item_id: str, action: str) -> bool:
    """更新推荐条目的状态（ignore: 忽略拉黑, import: 标记已导入）。"""
    valid_actions = {"ignore": "ignored", "import": "imported"}
    status = valid_actions.get(action)
    if not status:
        return False

    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with db() as conn:
        # 1. 更新卡片表
        conn.execute("UPDATE digest_items SET status = ? WHERE id = ?", (status, item_id))
        # 2. 写入或更新历史防重表
        conn.execute(
            """
            INSERT INTO digest_history (id, source, first_seen_date, last_seen_date, user_action)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_action=excluded.user_action,
              last_seen_date=excluded.last_seen_date
            """,
            (item_id, item_id.split(":")[0], today_str, today_str, status),
        )
    return True


def import_arxiv_item(item_id: str) -> dict[str, Any]:
    """直接将 arXiv 推荐条目一键导入本地文献库。"""
    with db() as conn:
        row = conn.execute("SELECT id, title, meta FROM digest_items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        raise RuntimeError("未找到该推荐条目")

    meta = json.loads(row["meta"] or "{}")
    arxiv_id = meta.get("arxiv_id")
    if not arxiv_id:
        # 从 id: "arxiv:2401.12345" 提取
        arxiv_id = item_id.replace("arxiv:", "").strip()

    from . import arxiv as arxiv_svc

    pdf_bytes = arxiv_svc.download_pdf(arxiv_id)
    filename = f"{arxiv_id}.pdf"
    doc = library.import_bytes(pdf_bytes, filename)

    # 标记状态为已入库
    act_on_digest_item(item_id, "import")

    # 触发后台双语排版队列
    try:
        from . import toqueue
        if toqueue.is_enabled() and not doc.get("duplicated"):
            toqueue.enqueue(doc["id"], doc.get("title") or filename)
    except Exception:
        pass

    return doc


def _scheduler_loop() -> None:
    """后台轻量调度：每天检查一次是否已到达 08:00 (Asia/Shanghai)，触发抓取。"""
    while not _SCHEDULER_STOP.is_set():
        try:
            if is_scheduler_enabled():
                # 判断当前北京时间（Asia/Shanghai 相当于 UTC+8）
                # 简单计算：utc hour + 8
                now_utc = datetime.now(timezone.utc)
                bj_hour = (now_utc.hour + 8) % 24
                today_bj = (now_utc.strftime("%Y-%m-%d") if (now_utc.hour + 8) < 24
                            else datetime.fromtimestamp(now_utc.timestamp() + 86400, tz=timezone.utc).strftime("%Y-%m-%d"))

                # 达到或超过 8 点时，检查今日是否抓取过
                if bj_hour >= 8:
                    with db() as conn:
                        row = conn.execute("SELECT COUNT(*) FROM digest_items WHERE date = ?", (today_bj,)).fetchone()
                        has_today = bool(row and row[0] > 0)
                    if not has_today:
                        logger.info("每日情报调度器触发：开始抓取 %s 的精选内容...", today_bj)
                        generate_daily_digest(today_bj, force=False)
        except Exception as e:
            logger.warning("每日情报调度器异常: %s", e)

        # 每 10 分钟检测一次，开销忽略不计
        for _ in range(20):
            if _SCHEDULER_STOP.is_set():
                break
            time.sleep(30)


def start_scheduler() -> None:
    global _SCHEDULER_THREAD
    if _SCHEDULER_THREAD is None or not _SCHEDULER_THREAD.is_alive():
        _SCHEDULER_STOP.clear()
        _SCHEDULER_THREAD = threading.Thread(target=_scheduler_loop, name="digest-scheduler", daemon=True)
        _SCHEDULER_THREAD.start()
        logger.info("每日情报定时调度器已启动")


def stop_scheduler() -> None:
    _SCHEDULER_STOP.set()
