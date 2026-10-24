"""Paper-Code Radar 编排服务。

完整管道（SRS §2/§3）：
  1. arXiv 分类订阅拉取（24h 窗口）
  2. Stage 1 规则初筛（关键词，零 LLM 成本）+ 防重（digest_history 复用）
  3. Stage 2 LLM 结构化评审（失败隔离，单条失败不阻断）
  4. GitHub 代码活性审计（7 天缓存）
  5. 入选条目写 radar_papers + 每日 Markdown 归档（LIB_ROOT/radar/）

产出只有两种：站内看板 + Markdown 归档，无外部推送（SRS C6）。
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from ..core.config import get_settings
from ..core.db import db
from . import arxiv as arxiv_svc
from . import arxiv_digest, library
from . import radar_arxiv, radar_github, radar_review, radar_topics

logger = logging.getLogger("radar")

# 单轮管道的预算上限（控制 LLM 与 GitHub 配额消耗）
MAX_REVIEW_PER_TOPIC = 8
MAX_REVIEW_TOTAL = 15
MAX_FETCH = 300
BJ_OFFSET_HOURS = 8


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _bj_date(utc_iso: str) -> str:
    """UTC ISO 时间 → 北京日期（YYYY-MM-DD）。解析失败返回空串。"""
    try:
        dt = datetime.fromisoformat(utc_iso)
        return (dt + timedelta(hours=BJ_OFFSET_HOURS)).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return ""


def _today_bj() -> str:
    return (_now() + timedelta(hours=BJ_OFFSET_HOURS)).strftime("%Y-%m-%d")


def _paper_key(arxiv_id: str) -> str:
    clean = re.sub(r"v\d+$", "", arxiv_id.strip())
    return f"arxiv:{clean}"


def _history_map() -> dict[str, dict[str, Any]]:
    """复用 digest_history：{id: {action, first_seen}}。"""
    out: dict[str, dict[str, Any]] = {}
    with db() as conn:
        rows = conn.execute(
            "SELECT id, user_action, first_seen_date FROM digest_history"
        ).fetchall()
    for r in rows:
        out[r["id"]] = {"action": r["user_action"], "first_seen": r["first_seen_date"]}
    return out


def _is_blocked(pid: str, history: dict[str, dict[str, Any]], now: datetime) -> bool:
    """防重：处置过永不再现；14 天内评审过的不重复评审（SRS 复用 v1 语义）。"""
    h = history.get(pid)
    if not h:
        return False
    if h.get("action") in ("ignored", "imported"):
        return True
    try:
        f = datetime.strptime(str(h.get("first_seen")), "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if (now - f).days < 14:
            return True
    except (ValueError, TypeError):
        pass
    return False


def _stage1_filter(paper: dict[str, Any], topic: dict[str, Any]) -> bool:
    """规则初筛：关键词任意命中即通过；Topic 未配关键词则全量通过。"""
    kws = topic.get("keywords") or []
    if not kws:
        return True
    text = " ".join([
        paper.get("title", ""), paper.get("abstract", ""), paper.get("comment", ""),
    ]).lower()
    return any(k.lower() in text for k in kws)


def _is_selected(score: int, threshold: int, code_status: str) -> bool:
    """入选规则（SRS FR-4.1）：达标分，或带可用代码的近似达标分。"""
    if score >= threshold:
        return True
    return code_status == "code_available" and score >= threshold - 1


def _insert_paper(conn: Any, paper: dict[str, Any], topic: dict[str, Any],
                  code_status: str, repo_url: str, review: dict[str, Any] | None,
                  status: str) -> None:
    conn.execute(
        "INSERT INTO radar_papers (id, topic_id, title, authors, abstract, categories,"
        " published, code_status, repo_url, review_status, review, score, archived,"
        " first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) "
        "ON CONFLICT(id, topic_id) DO UPDATE SET title=excluded.title,"
        " abstract=excluded.abstract, code_status=excluded.code_status,"
        " repo_url=excluded.repo_url, review_status=excluded.review_status,"
        " review=excluded.review, score=excluded.score",
        (
            _paper_key(paper["arxiv_id"]), topic["id"], paper.get("title", ""),
            json.dumps(paper.get("authors") or [], ensure_ascii=False),
            paper.get("abstract", ""),
            json.dumps(paper.get("categories") or [], ensure_ascii=False),
            paper.get("published", ""), code_status, repo_url, status,
            json.dumps(review, ensure_ascii=False) if review else None,
            (review or {}).get("relevance_score"), _now().isoformat(),
        ),
    )


def _commit_paper(paper: dict[str, Any], topic: dict[str, Any], code_status: str,
                  repo_url: str, review: dict[str, Any] | None, status: str,
                  date_str: str) -> None:
    """单篇落库（短事务）：radar_papers + FTS 索引 + digest_history。

    必须在所有网络调用（GitHub 审计 / LLM 评审）完成之后调用，
    事务里不做任何 IO，避免长时间持有 SQLite 写锁把并发写饿死。
    """
    pid = _paper_key(paper["arxiv_id"])
    with db() as conn:
        _insert_paper(conn, paper, topic, code_status, repo_url, review, status)
        # 同步全文索引（先删后插实现 upsert；同一论文多 Topic 共享一份索引）
        conn.execute("DELETE FROM radar_fts WHERE paper_id=?", (pid,))
        conn.execute(
            "INSERT INTO radar_fts (paper_id, title, abstract, summary_zh, innovation_zh)"
            " VALUES (?, ?, ?, ?, ?)",
            (pid, paper.get("title", ""), paper.get("abstract", ""),
             (review or {}).get("one_sentence_summary", ""),
             (review or {}).get("core_innovation", "")),
        )
        if status == "reviewed":
            # 写入防重历史（14 天内不再重复评审）
            conn.execute(
                "INSERT INTO digest_history (id, source, first_seen_date,"
                " last_seen_date, user_action) VALUES (?, 'arxiv', ?, ?, 'new') "
                "ON CONFLICT(id) DO UPDATE SET last_seen_date=excluded.last_seen_date",
                (pid, date_str, date_str),
            )


class PipelineBusyError(RuntimeError):
    """同一时刻仅允许一轮管道（手动刷新与定时调度互斥）。"""


_PIPELINE_LOCK = threading.Lock()


def run_pipeline(target_date: str | None = None, force: bool = False) -> dict[str, Any]:
    """执行一轮完整管道。同一时刻仅允许一轮：手动刷新与定时调度互斥。"""
    if not _PIPELINE_LOCK.acquire(blocking=False):
        raise PipelineBusyError("已有管道在运行中，请稍后再试")
    try:
        return _run_pipeline_locked(target_date, force)
    finally:
        _PIPELINE_LOCK.release()


def _run_pipeline_locked(target_date: str | None = None, force: bool = False) -> dict[str, Any]:
    now = _now()
    date_str = target_date or _today_bj()

    if not force:
        cached = get_day(date_str)
        if any(cached.values()):
            return {"date": date_str, "cached": True, "topics": cached}

    topics = radar_topics.get_topics()
    if not topics:
        return {"date": date_str, "cached": False, "topics": {},
                "message": "未配置任何 Topic，请先在看板中添加"}

    # 1. 拉取 24h 窗口内全部分类的新提交
    all_cats: list[str] = []
    for t in topics:
        for c in t.get("categories") or []:
            if c not in all_cats:
                all_cats.append(c)
    since, until = radar_arxiv.build_daily_window(now)
    try:
        papers = radar_arxiv.fetch_by_categories(all_cats, since, until, max_results=MAX_FETCH)
    except Exception as e:  # noqa: BLE001
        logger.warning("arXiv 拉取失败: %s", e)
        papers = []

    history = _history_map()
    local_sigs = arxiv_digest._get_local_document_signatures()

    audits_used = [0]
    review_total = [0]
    stats: dict[str, Any] = {}

    for topic in topics:
        stage1 = []
        for p in papers:
            pid = _paper_key(p["arxiv_id"])
            if _is_blocked(pid, history, now):
                continue
            # 本地文献库已有（标题/DOI 命中）则跳过
            norm_title = re.sub(r"\W+", "", p.get("title", "").lower())
            doi = (p.get("doi") or "").strip().lower()
            if (doi and doi in local_sigs) or (len(norm_title) > 6 and norm_title in local_sigs):
                continue
            if _stage1_filter(p, topic):
                stage1.append(p)

        reviewed = shown = failed = 0
        for p in stage1:
            if reviewed >= MAX_REVIEW_PER_TOPIC or review_total[0] >= MAX_REVIEW_TOTAL:
                break
            reviewed += 1
            review_total[0] += 1
            pid = _paper_key(p["arxiv_id"])

            code_status, repo_url, repo_info = radar_github.code_status_for(p, audits_used)
            if repo_info:
                p = {**p, "stars": repo_info.get("stars") or 0}
            try:
                review = radar_review.review_paper({**p, "code_status": code_status}, topic)
            except Exception as e:  # noqa: BLE001
                logger.warning("评审失败 %s(%s): %s", pid, topic["id"], e)
                _commit_paper(p, topic, code_status, repo_url, None, "review_failed", date_str)
                failed += 1
                continue

            # Star 数随评审卡片一起落库，供卡片与归档展示
            if repo_info:
                review = {**review, "repo_stars": repo_info.get("stars") or 0}
            _commit_paper(p, topic, code_status, repo_url, review, "reviewed", date_str)
            if _is_selected(review["relevance_score"], topic["min_score_to_show"], code_status):
                shown += 1
        stats[topic["id"]] = {"name": topic["name"], "stage1": len(stage1),
                              "reviewed": reviewed, "shown": shown, "failed": failed}

    # 2. 每日 Markdown 归档（对本日全部入选条目重新生成，幂等）
    archived_path = write_daily_archive(date_str)

    return {"date": date_str, "cached": False, "topics": stats,
            "archive": archived_path}


# ---------------------------------------------------------------------------
# 查询与看板
# ---------------------------------------------------------------------------

def _row_to_paper(row: Any) -> dict[str, Any]:
    review: dict[str, Any] = {}
    if row["review"]:
        try:
            review = json.loads(row["review"])
        except Exception:  # noqa: BLE001
            review = {}
    return {
        "id": row["id"],
        "topic_id": row["topic_id"],
        "title": row["title"],
        "authors": json.loads(row["authors"]) if row["authors"] else [],
        "abstract": row["abstract"] or "",
        "categories": json.loads(row["categories"]) if row["categories"] else [],
        "published": row["published"] or "",
        "code_status": row["code_status"],
        "repo_url": row["repo_url"] or "",
        "repo_stars": (review.get("repo_stars") or 0) if isinstance(review, dict) else 0,
        "review_status": row["review_status"],
        "review": review,
        "score": row["score"],
        "first_seen": row["first_seen"],
    }


def get_day(date_str: str, topic_id: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """按北京日期返回看板入选条目，按 Topic 分组。"""
    topics = {t["id"]: t for t in radar_topics.get_topics()}
    history = _history_map()
    grouped: dict[str, list[dict[str, Any]]] = {}
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM radar_papers WHERE review_status='reviewed' ORDER BY score DESC"
        ).fetchall()
    for row in rows:
        if _bj_date(row["first_seen"]) != date_str:
            continue
        if topic_id and row["topic_id"] != topic_id:
            continue
        if history.get(row["id"], {}).get("action") in ("ignored", "imported"):
            continue
        p = _row_to_paper(row)
        threshold = topics.get(row["topic_id"], {}).get("min_score_to_show", 4)
        if not _is_selected(int(p["score"] or 0), threshold, p["code_status"]):
            continue
        grouped.setdefault(row["topic_id"], []).append(p)
    return grouped


def search_papers(
    q: str = "",
    topic_id: str | None = None,
    code_status: str | None = None,
    min_score: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """混合筛选：FTS5 关键词（可选）+ Topic/代码状态/分数/日期范围过滤器。

    注意：unicode61 分词下，连续中文会作为整串 token，中文检索命中
    「与查询完全连续的子串」；英文按词命中。语义向量检索明确列为二期。
    """
    ids_via_fts: set[str] | None = None
    q = q.strip()
    if q:
        tokens = re.findall(r"\w+", q, re.U)
        if tokens:
            match_expr = " AND ".join(f'"{t}"' for t in tokens)
            with db() as conn:
                try:
                    fts_rows = conn.execute(
                        "SELECT paper_id FROM radar_fts WHERE radar_fts MATCH ?",
                        (match_expr,),
                    ).fetchall()
                except Exception:  # noqa: BLE001
                    fts_rows = []
            ids_via_fts = {r["paper_id"] for r in fts_rows}
            if not ids_via_fts:
                return []

    sql = "SELECT * FROM radar_papers WHERE review_status='reviewed'"
    args: list[Any] = []
    if topic_id:
        sql += " AND topic_id=?"
        args.append(topic_id)
    if code_status:
        sql += " AND code_status=?"
        args.append(code_status)
    if min_score is not None:
        sql += " AND score>=?"
        args.append(min_score)
    if date_from:
        sql += " AND substr(first_seen,1,10)>=?"
        args.append(date_from)
    if date_to:
        sql += " AND substr(first_seen,1,10)<=?"
        args.append(date_to)
    if ids_via_fts is not None:
        sql += f" AND id IN ({','.join('?' * len(ids_via_fts))})"
        args.extend(sorted(ids_via_fts))
    sql += " ORDER BY first_seen DESC, score DESC LIMIT ?"
    args.append(max(1, min(limit, 200)))

    with db() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [_row_to_paper(r) for r in rows]


def act_on_paper(paper_id: str, action: str) -> bool:
    """ignore / import 用户动作，写 digest_history 永久防重（复用 v1 语义）。"""
    if action not in ("ignore", "import"):
        return False
    status = "ignored" if action == "ignore" else "imported"
    with db() as conn:
        row = conn.execute(
            "SELECT topic_id FROM radar_papers WHERE id=? LIMIT 1", (paper_id,)
        ).fetchone()
        if not row:
            return False
        conn.execute(
            "INSERT INTO digest_history (id, source, first_seen_date, last_seen_date,"
            " user_action) VALUES (?, 'arxiv', ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET user_action=excluded.user_action,"
            " last_seen_date=excluded.last_seen_date",
            (paper_id, _today_bj(), _today_bj(), status),
        )
    return True


def import_paper(paper_id: str) -> dict[str, Any]:
    """将雷达论文导入本地文献库并进入双语排版队列（复用 v1 通路）。"""
    with db() as conn:
        row = conn.execute(
            "SELECT id, title FROM radar_papers WHERE id=? LIMIT 1", (paper_id,)
        ).fetchone()
    if not row:
        raise RuntimeError("未找到该论文条目")
    arxiv_id = paper_id.removeprefix("arxiv:").strip()
    pdf_bytes = arxiv_svc.download_pdf(arxiv_id)
    doc = library.import_bytes(pdf_bytes, f"{arxiv_id}.pdf")
    act_on_paper(paper_id, "import")
    try:
        from . import toqueue
        if toqueue.is_enabled() and not doc.get("duplicated"):
            toqueue.enqueue(doc["id"], doc.get("title") or row["title"])
    except Exception:  # noqa: BLE001
        pass
    return doc


def bibtex_for(paper_id: str) -> str:
    """生成标准 BibTeX。"""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM radar_papers WHERE id=? LIMIT 1", (paper_id,)
        ).fetchone()
    if not row:
        raise RuntimeError("未找到该论文条目")
    p = _row_to_paper(row)
    year = (p["published"] or "")[:4] or "n.d."
    first_author = (p["authors"] or ["unknown"])[0].split()[-1].lower()
    key = re.sub(r"[^a-z0-9]", "", f"{first_author}{year}{p['id'].removeprefix('arxiv:')}")
    authors = " and ".join(p["authors"] or [])
    lines = [
        "@article{" + key + ",",
        f"  title = {{{p['title']}}}",
        f"  author = {{{authors}}}",
        f"  year = {{{year}}}",
        f"  eprint = {{{p['id'].removeprefix('arxiv:')}}}",
        "  archivePrefix = {arXiv}",
        "}",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 每日 Markdown 归档
# ---------------------------------------------------------------------------

def write_daily_archive(date_str: str | None = None) -> str:
    """生成/重写每日归档 Markdown，返回文件路径。

    按当天入选条目全量重新生成（幂等），成功后把条目标记 archived=1。
    """
    date_str = date_str or _today_bj()
    topics = {t["id"]: t for t in radar_topics.get_topics()}
    grouped = get_day(date_str)

    lines: list[str] = [f"# Paper-Code Radar 情报 · {date_str}", ""]
    count = 0
    for tid, papers in grouped.items():
        tname = topics.get(tid, {}).get("name", tid)
        lines.append(f"## {tname}")
        lines.append("")
        for i, p in enumerate(papers, 1):
            count += 1
            stars = p.get("repo_stars") or 0
            code = f" · [代码]({p['repo_url']}) 🌟{stars}" if p["code_status"] == "code_available" else ""
            rv = p.get("review") or {}
            lines.append(f"### {i}. [⭐{p['score']:.0f}] {p['title']}")
            lines.append(f"- 链接: https://arxiv.org/abs/{p['id'].removeprefix('arxiv:')}{code}")
            if rv.get("one_sentence_summary"):
                lines.append(f"- 一句话: {rv['one_sentence_summary']}")
            if rv.get("problem_solved"):
                lines.append(f"- 痛点: {rv['problem_solved']}")
            if rv.get("core_innovation"):
                lines.append(f"- 方法: {rv['core_innovation']}")
            if rv.get("practical_value"):
                lines.append(f"- 价值: {rv['practical_value']}")
            if rv.get("primary_tag"):
                lines.append(f"- 标签: {rv['primary_tag']}")
            lines.append("")
        lines.append("")

    archive_dir = get_settings().lib_root / "radar"
    archive_dir.mkdir(parents=True, exist_ok=True)
    path = archive_dir / f"radar-{date_str}.md"
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    with db() as conn:
        for tid, papers in grouped.items():
            for p in papers:
                conn.execute(
                    "UPDATE radar_papers SET archived=1 WHERE id=? AND topic_id=?",
                    (p["id"], tid),
                )
    logger.info("每日归档已写入 %s（%s 条）", path, count)
    return str(path)


# ---------------------------------------------------------------------------
# 统计与调度
# ---------------------------------------------------------------------------

def stats() -> dict[str, Any]:
    """Topic 维度统计 + LLM 用量。"""
    out: dict[str, Any] = {"topics": [], "llm_usage": {}}
    with db() as conn:
        rows = conn.execute(
            "SELECT topic_id, COUNT(*) AS n, AVG(score) AS avg_score,"
            " SUM(code_status='code_available') AS with_code"
            " FROM radar_papers WHERE review_status='reviewed' GROUP BY topic_id"
        ).fetchall()
        usage_row = conn.execute(
            "SELECT value FROM settings WHERE key=?", ("radar.llm.usage",)
        ).fetchone()
    names = {t["id"]: t["name"] for t in radar_topics.get_topics()}
    for r in rows:
        out["topics"].append({
            "topic_id": r["topic_id"],
            "name": names.get(r["topic_id"], r["topic_id"]),
            "total": r["n"],
            "avg_score": round(r["avg_score"] or 0, 2),
            "with_code": r["with_code"] or 0,
        })
    if usage_row and usage_row["value"]:
        try:
            out["llm_usage"] = json.loads(usage_row["value"])
        except Exception:  # noqa: BLE001
            out["llm_usage"] = {}
    return out


_SCHED_THREAD: threading.Thread | None = None
_SCHED_STOP = threading.Event()


def _next_bj_8_delay(now: datetime) -> float:
    """距下一个北京时间 08:00 的秒数。"""
    bj = now + timedelta(hours=BJ_OFFSET_HOURS)
    target = bj.replace(hour=8, minute=0, second=0, microsecond=0)
    if bj >= target:
        target += timedelta(days=1)
    return (target - bj).total_seconds()


def _scheduler_loop() -> None:
    """每日 08:00（北京）触发当日管道；检查时已过 08:00 且当日未跑则立即补跑。

    触发时刻靠「睡到点」保证（误差 < 30s）；平时单次至多睡 10 分钟，
    及时响应调度开关变化。补跑语义与旧 30s 轮询一致，并非新增行为。
    """
    while not _SCHED_STOP.is_set():
        try:
            if radar_topics.is_scheduler_enabled():
                now = _now()
                bj = now + timedelta(hours=BJ_OFFSET_HOURS)
                today = bj.strftime("%Y-%m-%d")
                if bj.hour >= 8 and not _has_run(today):
                    logger.info("雷达调度器触发：开始 %s 管道", today)
                    run_pipeline(target_date=today, force=False)
                    _mark_run(today)
        except Exception as e:  # noqa: BLE001
            logger.warning("雷达调度器异常: %s", e)
        # 单次至多睡 10 分钟（及时响应开关变化）；临近 08:00 时精确睡到点
        delay = min(_next_bj_8_delay(_now()), 600.0)
        deadline = time.monotonic() + delay
        while not _SCHED_STOP.is_set():
            remain = deadline - time.monotonic()
            if remain <= 0:
                break
            time.sleep(min(30, remain))


def _has_run(date_str: str) -> bool:
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key='radar.last_run'"
        ).fetchone()
    return bool(row and row["value"] == date_str)


def _mark_run(date_str: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('radar.last_run', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (date_str,),
        )


def _backfill_fts() -> None:
    """把历史评审行补进 radar_fts（幂等）。

    FTS 同步是后来才加的：存量 radar_papers 行没有索引，检索时永远搜不到。
    先删后插的 upsert 语义与 _commit_paper 一致，重跑无副作用。
    """
    with db() as conn:
        rows = conn.execute(
            "SELECT id, title, abstract, review FROM radar_papers"
        ).fetchall()
        for r in rows:
            review: dict[str, Any] = {}
            if r["review"]:
                try:
                    review = json.loads(r["review"])
                except Exception:  # noqa: BLE001
                    review = {}
            conn.execute("DELETE FROM radar_fts WHERE paper_id=?", (r["id"],))
            conn.execute(
                "INSERT INTO radar_fts (paper_id, title, abstract, summary_zh, innovation_zh)"
                " VALUES (?, ?, ?, ?, ?)",
                (r["id"], r["title"], r["abstract"] or "",
                 review.get("one_sentence_summary", ""),
                 review.get("core_innovation", "")),
            )
    if rows:
        logger.info("radar_fts 回填完成：%s 行", len(rows))


def start_scheduler() -> None:
    try:
        _backfill_fts()
    except Exception as e:  # noqa: BLE001
        logger.warning("radar_fts 回填失败（不影响启动）: %s", e)
    global _SCHED_THREAD
    if _SCHED_THREAD is None or not _SCHED_THREAD.is_alive():
        _SCHED_STOP.clear()
        _SCHED_THREAD = threading.Thread(target=_scheduler_loop, name="radar-scheduler", daemon=True)
        _SCHED_THREAD.start()
        logger.info("雷达定时调度器已启动")


def stop_scheduler() -> None:
    _SCHED_STOP.set()
