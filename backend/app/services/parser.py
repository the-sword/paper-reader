"""解析服务：把 PDF 变成结构化的 segments（段落流）。

两条路径：
  A. MinerU 云 API —— 质量最好，需要 token
  B. 本地兜底解析 —— 用 pdf.js 文本抽取思路在 Python 侧做简易分栏拼接，
     无需任何密钥即可跑通段落流。质量明显低于 MinerU，但足够验证整条链路。

产出的 segments 是「双语的唯一载体」：翻译只针对 segment，
标注只针对 page+rects，二者在数据层完全解耦。
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..core.config import get_settings
from ..core.db import db
from . import mineru


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# 章节识别
# ---------------------------------------------------------------------------

# 常见论文一级标题
SECTION_PATTERNS = [
    (r"^abstract$", "Abstract"),
    (r"^(\d+\.?\s*)?introduction$", "Introduction"),
    (r"^(\d+\.?\s*)?(related\s+work|background)$", "Related Work"),
    (r"^(\d+\.?\s*)?(method|methods|methodology|approach)$", "Method"),
    (r"^(\d+\.?\s*)?(experiment|experiments|evaluation|results)$", "Experiments"),
    (r"^(\d+\.?\s*)?(discussion)$", "Discussion"),
    (r"^(\d+\.?\s*)?(conclusion|conclusions)$", "Conclusion"),
    (r"^(\d+\.?\s*)?(references|bibliography)$", "References"),
]


def _detect_section(text: str) -> str | None:
    t = re.sub(r"\s+", " ", text.strip().lower())
    for pattern, name in SECTION_PATTERNS:
        if re.match(pattern, t):
            return name
    # 形如 "1 Introduction" / "2.1 Model Architecture" 的小节也归入上级
    m = re.match(r"^(\d+)\.?\s+([a-z][a-z\s\-]{2,40})$", t)
    if m:
        return m.group(2).title()
    return None


# ---------------------------------------------------------------------------
# MinerU content_list → segments
# ---------------------------------------------------------------------------

def _segments_from_content_list(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把 MinerU 的 content_list 转成扁平的段落序列。

    content_list 的元素形如：
      {"type": "text", "text": "...", "page_idx": 0, "bbox": [...]}
      {"type": "equation", "text": "$$...$$" | "latex", "page_idx": 1}
      {"type": "image", "img_path": "xxx.jpg", "page_idx": 2}
      {"type": "table", "table_body": "<html>...", "page_idx": 3}
    """
    segs: list[dict[str, Any]] = []
    current_section: str | None = None
    idx = 0

    for item in items:
        if not isinstance(item, dict):
            continue
        typ = item.get("type", "text")
        page = int(item.get("page_idx", 0)) + 1  # 统一成 1-based

        if typ == "text":
            text_level = item.get("text_level")
            text = (item.get("text") or "").strip()
            if not text:
                continue
            if text_level:  # 标题
                sec = _detect_section(text) or text[:40]
                current_section = sec
                segs.append({
                    "idx": idx, "kind": "heading", "section": sec,
                    "source": text, "page": page,
                    "bbox": json.dumps(item.get("bbox")) if item.get("bbox") else None,
                })
                idx += 1
            else:
                # 长段落按自然段再切一次，便于逐段翻译与缓存
                for para in re.split(r"\n{2,}", text):
                    para = para.strip()
                    if len(para) < 2:
                        continue
                    segs.append({
                        "idx": idx, "kind": "text", "section": current_section,
                        "source": para, "page": page,
                        "bbox": json.dumps(item.get("bbox")) if item.get("bbox") else None,
                    })
                    idx += 1

        elif typ in ("equation", "interline_equation"):
            latex = (item.get("text") or item.get("latex") or "").strip()
            if not latex:
                continue
            segs.append({
                "idx": idx, "kind": "formula", "section": current_section,
                "source": latex, "page": page,
                "bbox": json.dumps(item.get("bbox")) if item.get("bbox") else None,
            })
            idx += 1

        elif typ == "table":
            body = item.get("table_body") or item.get("html") or ""
            caption = " ".join(item.get("table_caption") or [])
            segs.append({
                "idx": idx, "kind": "table", "section": current_section,
                "source": body or caption, "page": page,
                "bbox": json.dumps(item.get("bbox")) if item.get("bbox") else None,
            })
            idx += 1

        elif typ == "image":
            caption = " ".join(item.get("img_caption") or [])
            segs.append({
                "idx": idx, "kind": "figure", "section": current_section,
                "source": json.dumps({
                    "img_path": item.get("img_path"),
                    "caption": caption,
                }, ensure_ascii=False),
                "page": page,
                "bbox": json.dumps(item.get("bbox")) if item.get("bbox") else None,
            })
            idx += 1

    return segs


# ---------------------------------------------------------------------------
# 本地兜底解析（无密钥可用）
# ---------------------------------------------------------------------------

NOISE_PATTERNS = [
    r"^arxiv:\d",                       # arXiv 水印
    r"^\s*\d+\s*$",                     # 纯页码
    r"^(preprint|under review|published as)",  # 预印本声明
]


def _is_noise(text: str) -> bool:
    low = text.strip().lower()
    for pat in NOISE_PATTERNS:
        if re.search(pat, low):
            return True
    # 极短的纯符号/数字
    if len(text.strip()) <= 2 and not re.search(r"[a-zA-Z\u4e00-\u9fa5]", text):
        return True
    return False


def parse_local(pdf_path: Path) -> list[dict[str, Any]]:
    """本地兜底：用 PyMuPDF 抽文本，靠「字号 + 粗体」识别标题。

    策略：
      1. 全文统计正文字号（按字符数加权取众数）
      2. 逐 block 拼接文本，取该 block 的主字号与是否粗体
      3. 主字号 > 正文 * 1.15 或（粗体 且 字号 >= 正文且像标题）→ 判定为标题
      4. 标题跨多个 block 时合并（如主标题折行）
      5. 正文按句末标点 + 空行切分为段落候选

    质量说明：不做双栏重排、公式还原与图表抽取，仅用于无密钥时跑通链路。
    """
    try:
        import fitz  # PyMuPDF
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("本地解析需要 PyMuPDF：pip3 install pymupdf") from e

    doc = fitz.open(str(pdf_path))

    # ---- 第一遍：统计正文字号 ----
    size_weight: dict[float, int] = {}
    for page in doc:
        for b in page.get_text("dict")["blocks"]:
            for l in b.get("lines", []):
                for sp in l.get("spans", []):
                    txt = (sp.get("text") or "").strip()
                    if not txt:
                        continue
                    key = round(sp.get("size", 0), 1)
                    size_weight[key] = size_weight.get(key, 0) + len(txt)
    body_size = max(size_weight.items(), key=lambda kv: kv[1])[0] if size_weight else 10.0

    segs: list[dict[str, Any]] = []
    idx = 0
    current_section: str | None = None
    pending_heading: dict[str, Any] | None = None

    def flush_heading() -> None:
        """把攒着的标题块落成一个 segment。"""
        nonlocal idx, current_section, pending_heading
        if not pending_heading:
            return
        text = pending_heading["text"].strip()
        pending_heading = None
        if not text or _is_noise(text):
            return
        sec = _detect_section(text)
        if sec:
            current_section = sec
        segs.append({
            "idx": idx, "kind": "heading",
            "section": sec or current_section,
            "source": text, "page": pending_heading_page,
            "bbox": None,
        })
        idx += 1

    pending_heading_page = 1

    # ---- 第二遍：逐页逐块 ----
    for pno, page in enumerate(doc, start=1):
        for b in page.get_text("dict")["blocks"]:
            if b.get("type") != 0:
                continue

            line_texts: list[str] = []
            weights: dict[float, int] = {}
            bold_chars = 0
            total_chars = 0

            for line in b.get("lines", []):
                parts: list[str] = []
                for sp in line.get("spans", []):
                    t = sp.get("text") or ""
                    if not t:
                        continue
                    parts.append(t)
                    n = len(t.strip())
                    if n:
                        key = round(sp.get("size", 0), 1)
                        weights[key] = weights.get(key, 0) + n
                        total_chars += n
                        if sp.get("flags", 0) & 16:  # bit4 = bold
                            bold_chars += n
                lt = "".join(parts).strip()
                if lt:
                    line_texts.append(lt)

            text = " ".join(line_texts).strip()
            if not text:
                continue

            # 该 block 的主字号
            dominant = max(weights.items(), key=lambda kv: kv[1])[0] if weights else body_size
            is_bold = total_chars > 0 and bold_chars / total_chars > 0.6

            bigger = dominant > body_size * 1.15
            # 短粗体行且非正文长度 → 二级标题
            short_bold = is_bold and len(text) <= 90 and dominant >= body_size * 0.95

            if bigger or (short_bold and not text.rstrip().endswith(".")):
                if _is_noise(text):
                    continue
                if pending_heading and pending_heading["page"] == pno \
                        and pending_heading["size"] == dominant:
                    # 同一字号的标题续行，合并
                    pending_heading["text"] += " " + text
                else:
                    flush_heading()
                    pending_heading = {"text": text, "page": pno, "size": dominant}
                    pending_heading_page = pno
                continue

            # 正文：先 flush 掉未落盘的标题
            flush_heading()

            if _is_noise(text):
                continue

            # 长文本按句末切段
            chunks = re.split(r"(?<=[.!?。！？])\s{2,}", text)
            for chunk in chunks:
                chunk = chunk.strip()
                if len(chunk) < 3:
                    continue
                segs.append({
                    "idx": idx, "kind": "text", "section": current_section,
                    "source": chunk, "page": pno, "bbox": None,
                })
                idx += 1

    flush_heading()
    doc.close()
    return segs


# ---------------------------------------------------------------------------
# 落库
# ---------------------------------------------------------------------------

def save_segments(doc_id: str, segs: list[dict[str, Any]]) -> int:
    with db() as conn:
        conn.execute("DELETE FROM segments WHERE document_id=?", (doc_id,))
        for s in segs:
            conn.execute(
                """INSERT INTO segments (id, document_id, idx, section, kind, source, page, bbox)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (str(uuid.uuid4()), doc_id, s["idx"], s.get("section"),
                 s["kind"], s["source"], s.get("page", 1), s.get("bbox")),
            )
        conn.execute(
            "UPDATE documents SET parse_status='done' WHERE id=?", (doc_id,)
        )
    return len(segs)


def set_parse_status(doc_id: str, status: str) -> None:
    with db() as conn:
        conn.execute("UPDATE documents SET parse_status=? WHERE id=?", (status, doc_id))


def list_segments(doc_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """SELECT s.*, t.text AS zh, t.provider AS zh_provider
               FROM segments s
               LEFT JOIN translations t
                 ON t.segment_id = s.id AND t.target_lang='zh-CN'
               WHERE s.document_id=?
               ORDER BY s.idx""",
            (doc_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # figure 的 source 是 JSON，展开成字段
        if d["kind"] == "figure":
            try:
                meta = json.loads(d["source"])
                d["img_path"] = meta.get("img_path")
                d["caption"] = meta.get("caption", "")
                d["source"] = d["caption"]
            except Exception:
                pass
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# 统一入口
# ---------------------------------------------------------------------------

def parse_with_mineru(doc_id: str, pdf_path: Path) -> dict[str, Any]:
    """提交解析任务，返回 task_id 供前端轮询。"""
    set_parse_status(doc_id, "running")
    task_id = mineru.submit_file(pdf_path, data_id=doc_id)
    return {"task_id": task_id}


def finalize_mineru(doc_id: str, task_id: str) -> int:
    """任务完成后拉结果、转 segments、存图片。"""
    result = mineru.fetch_result(task_id)
    segs = _segments_from_content_list(result.content_list)
    if not segs:
        raise mineru.MinerUError("解析结果没有可用段落")

    # 存图片
    s = get_settings()
    img_dir = s.parsed_dir / doc_id / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    for name, data in result.images.items():
        (img_dir / name).write_bytes(data)

    # 存原始 markdown 备查
    (s.parsed_dir / doc_id / "full.md").write_text(result.full_md, encoding="utf-8")

    return save_segments(doc_id, segs)


def parse_local_and_save(doc_id: str, pdf_path: Path) -> int:
    set_parse_status(doc_id, "running")
    segs = parse_local(pdf_path)
    if not segs:
        set_parse_status(doc_id, "failed")
        raise RuntimeError("本地解析未提取到任何段落（可能是扫描件，需 OCR）")
    n = save_segments(doc_id, segs)
    return n
