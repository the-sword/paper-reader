"""标注重锚：同论文不同版式 PDF 的坐标迁移。

合并导入的标注坐标来自**源机器的 PDF 版式**；当目标 PDF 与源 hash 不同
（不同源头下载的同一篇论文），分页与排版可能不同，直接搬 page + rects
会标错位置。好在每条标注都存了划选原文 quote——在目标 PDF 里全文搜索，
用命中处的 bbox 重算归一化坐标：

    命中   → 更新 page + rects（按目标版式归一化 0-1）
    未命中 → 保留原坐标硬挂（页码大概率接近，可见可手调），计入 kept

搜索策略：整段 quote → 失配时退前 60 字符片段（整段跨行/连字符易失配）。
命中多页时取离原页码最近的（版本间内容漂移通常很小）。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from ..core.db import db

logger = logging.getLogger(__name__)

#: 整段失配时的短片段长度（字符）
SNIPPET_LEN = 60


def _search_page(page: Any, text: str) -> list[list[float]]:
    """在页内搜文本，返回归一化 rects（[x0,y0,x1,y1]，相对页宽高）。"""
    W, H = page.rect.width, page.rect.height
    if W <= 0 or H <= 0:
        return []
    out: list[list[float]] = []
    try:
        for r in page.search_for(text):
            out.append([
                round(max(0.0, r.x0) / W, 4),
                round(max(0.0, r.y0) / H, 4),
                round(min(W, r.x1) / W, 4),
                round(min(H, r.y1) / H, 4),
            ])
    except Exception:  # noqa: BLE001  # 非法字符/内部错误按未命中处理
        return []
    return out


def _locate(doc: Any, texts: list[str], orig_page: int) -> tuple[int, list[list[float]]] | None:
    """按 texts 顺序逐页搜索，返回 (命中页号, 归一化 rects)。

    返回页号为 1 起（与 annotations.page 一致；pymupdf 页索引 0 起，注意换算）。
    每个 text 独立全量搜索，多页命中取离原页最近（平局取先出现的）；
    某个 text 命中即返回，不再试更短的。
    """
    best: tuple[int, list[list[float]]] | None = None
    best_dist: int | None = None
    for text in texts:
        for i in range(doc.page_count):
            rects = _search_page(doc[i], text)
            if not rects:
                continue
            page_no = i + 1
            dist = abs(page_no - orig_page)
            if best_dist is None or dist < best_dist:
                best, best_dist = (page_no, rects), dist
        if best is not None:
            break
    return best


def reanchor_document(doc_id: str, pdf_path: Path) -> dict[str, Any]:
    """把一篇文献的全部带 quote 标注重锚到 pdf_path 版式上。

    返回 {total, reanchored, kept}；kept = 未命中的条数（坐标保持原样）。
    只更新命中条目的 page/rects，其余字段（颜色/备注/时间）不动。
    """
    import pymupdf

    with db() as conn:
        anns = [dict(r) for r in conn.execute(
            "SELECT id, page, rects, quote FROM annotations"
            " WHERE document_id=? AND quote IS NOT NULL AND TRIM(quote)<>''"
            " ORDER BY page, created_at", (doc_id,)
        ).fetchall()]
    if not anns:
        return {"total": 0, "reanchored": 0, "kept": 0}

    reanchored = 0
    kept = 0
    with pymupdf.open(str(pdf_path)) as doc:
        for ann in anns:
            quote = ann["quote"].strip()
            texts = [quote]
            if len(quote) > SNIPPET_LEN:
                texts.append(quote[:SNIPPET_LEN])
            hit = _locate(doc, texts, ann["page"])
            if hit is None:
                kept += 1
                continue
            page_no, new_rects = hit
            with db() as conn:
                conn.execute(
                    "UPDATE annotations SET page=?, rects=? WHERE id=?",
                    (page_no, json.dumps(new_rects), ann["id"]),
                )
            reanchored += 1

    return {"total": len(anns), "reanchored": reanchored, "kept": kept}
