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
                      comment: str = "") -> dict[str, Any]:
    if kind not in VALID_KINDS:
        raise ValueError(f"invalid kind: {kind}")
    if page < 1:
        raise ValueError("page must be >= 1")
    _validate_rects(rects)

    ann_id = str(uuid.uuid4())
    now = _now()
    with db() as conn:
        conn.execute(
            """INSERT INTO annotations
               (id, document_id, page, kind, color, rects, quote, comment, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (ann_id, doc_id, page, kind, color, json.dumps(rects), quote, comment, now, now),
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
