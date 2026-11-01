"""标注重锚：同论文不同版式的坐标迁移。"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pymupdf

from app.core.config import get_settings
from app.core.db import db
from app.services import reanchor

QUOTE = "We propose a multi-sensor fusion framework for occupancy prediction."


def _pdf(path: Path, pages: list[list[str]]) -> Path:
    """生成多页 PDF，每页依次插入若干行文本。"""
    doc = pymupdf.open()
    for lines in pages:
        page = doc.new_page()
        for i, line in enumerate(lines):
            page.insert_text((72, 100 + i * 20), line, fontsize=11)
    doc.save(str(path))
    doc.close()
    return path


def _insert_doc_with_ann(quote: str, page: int, rects: list[list[float]]) -> str:
    doc_id = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, title, file_hash, added_at)"
            " VALUES (?,?,?,datetime('now'))", (doc_id, "重锚测试", "hash-" + doc_id[:8]),
        )
        conn.execute(
            "INSERT INTO annotations (id, document_id, page, kind, color, rects,"
            " quote, comment, side, created_at, updated_at)"
            " VALUES (?,?,?,'highlight','#ffd400',?,?, '', 'source',"
            " datetime('now'), datetime('now'))",
            (str(uuid.uuid4()), doc_id, page, json.dumps(rects), quote),
        )
    return doc_id


def _anns(doc_id: str) -> list[dict]:
    with db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM annotations WHERE document_id=? ORDER BY id", (doc_id,)).fetchall()]


def test_reanchor_moves_to_new_layout():
    """版式变化（正文挪页 + 位置变化）→ page 与归一化 rects 更新。"""
    # 源版式：quote 在第 1 页顶部；目标版式：前置一页版权页，quote 在第 2 页中部
    target = _pdf(get_settings().lib_root / "target.pdf", [
        ["Copyright notice page"],
        [f"Intro line {i}" for i in range(1, 6)] + [QUOTE],
    ])
    doc_id = _insert_doc_with_ann(QUOTE, page=1, rects=[[0.1, 0.1, 0.5, 0.12]])
    r = reanchor.reanchor_document(doc_id, target)
    assert r == {"total": 1, "reanchored": 1, "kept": 0}
    (a,) = _anns(doc_id)
    assert a["page"] == 2  # 版权页挤后一页
    rects = json.loads(a["rects"])
    assert len(rects) == 1
    x0, y0, x1, y1 = rects[0]
    assert 0 < x0 < 1 and 0 < y0 < 1 and x1 > x0 and y1 > y0  # 合法归一化坐标


def test_reanchor_keeps_when_quote_absent():
    """quote 在目标 PDF 不存在 → 坐标保持原样，计入 kept。"""
    target = _pdf(get_settings().lib_root / "t2.pdf", [["nothing related here"]])
    orig_rects = [[0.2, 0.2, 0.6, 0.22]]
    doc_id = _insert_doc_with_ann("这句话目标版式里没有", page=3, rects=orig_rects)
    r = reanchor.reanchor_document(doc_id, target)
    assert r["kept"] == 1 and r["reanchored"] == 0
    (a,) = _anns(doc_id)
    assert a["page"] == 3
    assert json.loads(a["rects"]) == orig_rects  # 原样硬挂


def test_reanchor_prefers_nearest_page():
    """quote 出现在多页（页眉重复）→ 取离原页码最近的。"""
    target = _pdf(get_settings().lib_root / "t3.pdf", [
        [QUOTE, "page one body"],
        ["page two body"],
        [QUOTE, "page three body"],
    ])
    doc_id = _insert_doc_with_ann(QUOTE, page=3, rects=[[0.1, 0.1, 0.5, 0.12]])
    reanchor.reanchor_document(doc_id, target)
    (a,) = _anns(doc_id)
    assert a["page"] == 3  # 距离 0 胜出，而非第 1 页


def test_reanchor_long_quote_snippet_fallback():
    """超长 quote（含目标版式没有的换行差异）→ 退 60 字符片段仍命中。"""
    long_quote = (QUOTE + " " + "x" * 200).strip()
    target = _pdf(get_settings().lib_root / "t4.pdf", [[QUOTE, "tail line"]])
    doc_id = _insert_doc_with_ann(long_quote, page=1, rects=[[0.1, 0.1, 0.5, 0.12]])
    r = reanchor.reanchor_document(doc_id, target)
    # 整段必失配（尾巴不存在）；片段应命中
    assert r["reanchored"] == 1, r


def test_reanchor_no_annotations():
    target = _pdf(get_settings().lib_root / "t5.pdf", [["body"]])
    doc_id = str(uuid.uuid4())
    with db() as conn:
        conn.execute("INSERT INTO documents (id, title, file_hash, added_at)"
                     " VALUES (?,?,?,datetime('now'))", (doc_id, "无标注", "h5"))
    assert reanchor.reanchor_document(doc_id, target) == {"total": 0, "reanchored": 0, "kept": 0}
