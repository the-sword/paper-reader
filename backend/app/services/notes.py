"""标注服务。坐标一律存归一化值（0-1，相对页面宽高），解决缩放漂移问题。"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from ..core.db import db

VALID_KINDS = {"highlight", "underline", "strike", "note", "screenshot"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_rects(rects: list[list[float]]) -> None:
    for r in rects:
        if len(r) != 4:
            raise ValueError("each rect must be [x1,y1,x2,y2]")
        for v in r:
            if not isinstance(v, (int, float)) or v < -0.01 or v > 1.01:
                raise ValueError(f"rect values must be normalized to 0-1, got {v}")


def create_annotation(doc_id: str, page: int, kind: str, rects: list[list[float]],
                      color: str = "#ffd400", quote: str = "",
                      comment: str = "", segment_id: str | None = None,
                      side: str = "source",
                      start_offset: int | None = None,
                      end_offset: int | None = None) -> dict[str, Any]:
    """新建标注。

    两种锚定方式：
      - PDF 坐标：传 page + rects（矩形范围）
      - 段落流：传 segment_id（rects 可为空），用于双语阅读视图

    side 区分标注的是原文还是译文，便于在侧栏分组显示。
    start_offset / end_offset 记录段落内的字符范围，
    用于「只标注选中的几个字」；为空表示整段标注。
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"invalid kind: {kind}")
    if side not in ("source", "zh"):
        raise ValueError("side must be 'source' or 'zh'")

    is_segment = bool(segment_id)
    if not is_segment:
        if page < 1:
            raise ValueError("page must be >= 1")
        _validate_rects(rects)
    else:
        # 段落标注：校验段落归属，避免跨文献引用
        with db() as conn:
            row = conn.execute(
                "SELECT 1 FROM segments WHERE id=? AND document_id=?",
                (segment_id, doc_id),
            ).fetchone()
        if not row:
            raise ValueError("段落不存在")
        if start_offset is not None or end_offset is not None:
            so = 0 if start_offset is None else start_offset
            eo = end_offset
            if eo is None or eo <= so:
                raise ValueError("字符范围无效")
            # 与段落长度校验，防止越界
            with db() as conn:
                seg_len = conn.execute(
                    "SELECT length(source) n FROM segments WHERE id=?", (segment_id,)
                ).fetchone()
            if seg_len and eo > seg_len["n"]:
                raise ValueError("字符范围超出段落长度")
            start_offset, end_offset = so, eo
        with db() as conn:
            seg = conn.execute(
                "SELECT page FROM segments WHERE id=?", (segment_id,)
            ).fetchone()
            page = (seg["page"] if seg else 1) or 1

    ann_id = str(uuid.uuid4())
    now = _now()
    with db() as conn:
        conn.execute(
            """INSERT INTO annotations
               (id, document_id, page, kind, color, rects, quote, comment,
                segment_id, side, start_offset, end_offset, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ann_id, doc_id, page, kind, color, json.dumps(rects), quote, comment,
             segment_id, side, start_offset, end_offset, now, now),
        )
        return dict(conn.execute("SELECT * FROM annotations WHERE id=?", (ann_id,)).fetchone())


def list_annotations(doc_id: str, page: int | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM annotations WHERE document_id=?"
    params: list[Any] = [doc_id]
    if page is not None:
        sql += " AND page=?"
        params.append(page)
    sql += " ORDER BY page, created_at"
    with db() as conn:
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        # 补充段落序号，供侧栏展示「第 N 段」
        for r in rows:
            if r.get("segment_id"):
                seg = conn.execute(
                    "SELECT idx FROM segments WHERE id=?", (r["segment_id"],)
                ).fetchone()
                r["segment_idx"] = seg["idx"] if seg else None
    for r in rows:
        r["rects"] = json.loads(r["rects"])
    return rows


def update_annotation(ann_id: str, color: str | None = None,
                      comment: str | None = None) -> dict[str, Any] | None:
    with db() as conn:
        sets, params = [], []
        if color is not None:
            sets.append("color=?")
            params.append(color)
        if comment is not None:
            sets.append("comment=?")
            params.append(comment)
        if not sets:
            row = conn.execute("SELECT * FROM annotations WHERE id=?", (ann_id,)).fetchone()
            return dict(row) if row else None
        sets.append("updated_at=?")
        params.append(_now())
        params.append(ann_id)
        conn.execute(f"UPDATE annotations SET {', '.join(sets)} WHERE id=?", params)
        row = conn.execute("SELECT * FROM annotations WHERE id=?", (ann_id,)).fetchone()
        if not row:
            return None
        out = dict(row)
        out["rects"] = json.loads(out["rects"])
        return out


def delete_annotation(ann_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM annotations WHERE id=?", (ann_id,))


def export_markdown(doc_id: str) -> str:
    """把一篇文献的所有标注导出为可读 Markdown。"""
    with db() as conn:
        doc = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not doc:
            raise ValueError("document not found")
        anns = [dict(r) for r in conn.execute(
            "SELECT * FROM annotations WHERE document_id=? ORDER BY page, created_at", (doc_id,)
        ).fetchall()]

    lines = [f"# {doc['title']}", ""]
    if doc["authors"]:
        lines += [f"**作者**：{doc['authors']}", ""]
    if doc["year"]:
        lines += [f"**年份**：{doc['year']}", ""]
    lines += [f"**标注数**：{len(anns)}", "", "---", ""]

    current_page = None
    for a in anns:
        if a["page"] != current_page:
            current_page = a["page"]
            lines += [f"## 第 {current_page} 页", ""]
        quote = (a["quote"] or "").strip()
        if quote:
            lines.append("> " + quote.replace("\n", "\n> "))
            lines.append("")
        if a["comment"]:
            lines.append(a["comment"])
            lines.append("")
        lines.append(f"*[{a['kind']} · {a['color']}]*")
        lines.append("")
    return "\n".join(lines)
