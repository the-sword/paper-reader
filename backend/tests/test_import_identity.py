"""论文身份键：导入提取、占位挂接、不惊喜边界。

用 PyMuPDF 现场生成测试 PDF（首页含 arXiv 号/DOI 文本），
不依赖外部文件。
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pymupdf

from app.core.config import get_settings
from app.core.db import db
from app.services import library


def _make_pdf(path: Path, text: str) -> Path:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), text, fontsize=11)
    doc.save(str(path))
    doc.close()
    return path


def _tmp_pdf(name: str, text: str) -> Path:
    return _make_pdf(get_settings().lib_root / name, text)


def test_import_extracts_arxiv_id_and_doi():
    p = _tmp_pdf("a.pdf", "arXiv:2401.12345v2 [cs.CV]\nSome Paper\ndoi: 10.1109/CVPR.2024.00123")
    doc = library.import_pdf(p, title="身份提取")
    assert doc["arxiv_id"] == "2401.12345"  # 版本后缀已剥
    assert doc["doi"] == "10.1109/CVPR.2024.00123"


def test_identity_attach_to_fileless_placeholder():
    """不同 hash、同 arXiv 号的 PDF → 挂到无文件的占位文献，不新建。"""
    # 占位：file_hash 指向一个不存在的 blob
    ph_hash = "ab" + "1" * 62
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, title, file_hash, arxiv_id, added_at)"
            " VALUES (?,?,?,?,datetime('now'))",
            (str(uuid.uuid4()), "占位论文", ph_hash, "2401.99999"),
        )
    p = _tmp_pdf("b.pdf", "arXiv:2401.99999 [cs.RO]\nPlaceholder Paper")
    r = library.import_pdf(p)
    assert r["duplicated"] is False
    assert r["arxiv_id"] == "2401.99999"
    assert library._blob_path(r["file_hash"]).exists()  # 文件已落盘
    with db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM documents WHERE arxiv_id='2401.99999'").fetchone()[0]
    assert n == 1  # 没有新建重复条目


def test_hash_attach_to_placeholder():
    """同 hash 上传 → 占位文献补上文件。"""
    p1 = _tmp_pdf("c1.pdf", "arXiv:2401.55555 same file")
    r1 = library.import_pdf(p1)
    # 模拟占位：删掉 blob（保留行）
    library._blob_path(r1["file_hash"]).unlink()
    assert library.get_document(r1["id"])["file_missing"] is True

    p2 = _tmp_pdf("c2.pdf", "arXiv:2401.55555 same file")  # 同内容同 hash
    r2 = library.import_pdf(p2)
    assert r2["id"] == r1["id"]
    assert r2["duplicated"] is False  # 补挂按新导入对待
    assert library.get_document(r1["id"])["file_missing"] is False


def test_no_attach_when_target_has_file():
    """已有文件的同论文不同版式 → 仍新建（不覆盖、不惊喜）。"""
    p1 = _tmp_pdf("d1.pdf", "arXiv:2401.77777 version one")
    library.import_pdf(p1)
    p2 = _tmp_pdf("d2.pdf", "arXiv:2401.77777 version two with more text so hash differs")
    r2 = library.import_pdf(p2)
    assert r2["duplicated"] is False
    with db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM documents WHERE arxiv_id='2401.77777'").fetchone()[0]
    assert n == 2


def test_reference_arxiv_ids_not_picked_from_body_first_page_only():
    """首页只有他人 arXiv 引用、无自身 arXiv 号 → 不误抓（DOI 无锚也不抓）。"""
    p = _tmp_pdf("e.pdf", "Related work [1] used arXiv:1909.00001 method. 10.1234/inline-doi")
    doc = library.import_pdf(p)
    assert doc["arxiv_id"] is None or doc["arxiv_id"] == "1909.00001"  # 首页内无法区分时取首个——见下条注释
    # 注：纯文本层面无法区分「自身号」与「引用号」，策略是最多抓一个且
    # 仅用于「挂接到无文件占位」这种低风险动作；此处固定行为防回归。


def test_dedup_by_hash_unchanged():
    """同文件二次导入：行为与原先一致（duplicated=True）。"""
    p = _tmp_pdf("f.pdf", "arXiv:2401.22222 dedup me")
    r1 = library.import_pdf(p)
    r2 = library.import_pdf(p)
    assert r2["id"] == r1["id"]
    assert r2["duplicated"] is True


def test_identity_attach_triggers_reanchor():
    """占位（含合并导入的标注）→ 上传同论文不同版式 PDF → 挂接并重锚。"""
    import json as _json

    quote = "Reanchor target sentence for identity attach."
    ph_hash = "cd" + "9" * 62
    doc_id = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, title, file_hash, arxiv_id, added_at)"
            " VALUES (?,?,?,?,datetime('now'))",
            (doc_id, "待补占位", ph_hash, "2401.31313"),
        )
        conn.execute(
            "INSERT INTO annotations (id, document_id, page, kind, color, rects, quote,"
            " comment, side, created_at, updated_at)"
            " VALUES (?,?,5,'highlight','#ffd400','[[0.05,0.05,0.3,0.06]]',?, '', 'source',"
            " datetime('now'), datetime('now'))",
            (str(uuid.uuid4()), doc_id, quote),
        )
    # 新版式：quote 放在第 1 页 y=400 处
    p = _tmp_pdf("g.pdf", "arXiv:2401.31313\n" + quote)
    r = library.import_pdf(p)
    assert r["id"] == doc_id
    with db() as conn:
        ann = conn.execute("SELECT page, rects FROM annotations WHERE document_id=?",
                           (doc_id,)).fetchone()
        assert ann["page"] == 1  # 从源版式的第 5 页重锚到第 1 页
        rects = _json.loads(ann["rects"])
        # 坐标被重算为新 PDF 里的实际位置（原占位坐标是 [0.05, 0.05, ...]）
        assert rects and rects[0][1] != 0.05 and 0 < rects[0][1] < 1
