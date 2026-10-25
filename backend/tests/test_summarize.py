"""AI 总结：领读（PaperSocratic Reader）模板接入与生成链路。"""
from __future__ import annotations

import pytest

from app.core.db import db
from app.services import summarize


@pytest.fixture()
def parsed_doc():
    """造一篇已解析的文档（documents + segments），返回 doc_id。"""
    import uuid as _uuid

    doc_id = str(_uuid.uuid4())
    segs = [
        ("heading", "# OccFusion: Real-Time Occupancy Prediction"),
        ("text", "We propose a multi-sensor fusion framework for occupancy. "
                 "Experiments on nuScenes show mIoU 68.2, an improvement of 3.1."),
        ("figure", '{"caption": "Qualitative comparison on far-field regions"}'),
        ("table", ""),
        ("reference", "Zhang et al. 2023"),
    ]
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, title, file_hash, added_at) VALUES (?,?,?,datetime('now'))",
            (doc_id, "OccFusion", "hash-socratic-1"),
        )
        for i, (kind, source) in enumerate(segs):
            conn.execute(
                "INSERT INTO segments (id, document_id, idx, kind, source, page)"
                " VALUES (?,?,?,?,?,1)",
                (f"{doc_id}-{i}", doc_id, i, kind, source),
            )
    return doc_id


def test_available_kinds_socratic_first():
    kinds = summarize.available_kinds()
    values = [k["value"] for k in kinds]
    # 领读两类置顶：先地图后细节
    assert values[0] == "socratic_card"
    assert values[1] == "socratic_full"
    labels = {k["value"]: k["label"] for k in kinds}
    assert "速读卡" in labels["socratic_card"]
    assert "精读" in labels["socratic_full"]
    assert "qa" in values


def test_socratic_prompts_encode_quality_gates():
    """模板必须内置质量门禁：证据分级、不编造、平均vs最好、比较公平性。"""
    for key in ("socratic_card", "socratic_full"):
        system = summarize.TEMPLATES[key]["system"]
        assert "强证据" in system and "推测" in system
        assert "论文未提供" in system
        assert "平均指标" in system and "最好案例" in system
        assert "比较公平性" in system or "调参预算" in system
    # 精读模板含完整结构：论证链、图表三问、费曼复述
    full = summarize.TEMPLATES["socratic_full"]["system"]
    for token in ("论证链", "替代解释", "三分钟费曼复述", "追问"):
        assert token in full
    card = summarize.TEMPLATES["socratic_card"]["system"]
    for token in ("一句话问题", "价值判断", "三个关键点"):
        assert token in card


def test_generate_socratic_card_stores_summary(parsed_doc, monkeypatch):
    """领读类型走通用生成链路：语料构建 → AI 调用 → summaries 入库。"""
    called = {}

    def fake_call(system, user, cancel_event=None, on_progress=None):
        called["system"] = system
        called["user"] = user
        return {"content": "## 一句话问题\n occupancy 融合。", "model": "test-m"}

    monkeypatch.setattr(summarize, "_call_ai", fake_call)
    result = summarize.generate(parsed_doc, "socratic_card")

    assert result["kind"] == "socratic_card"
    assert result["input_chars"] > 0
    # 语料：跳过参考文献、公式/图表转标记、含正文
    assert "nuScenes" in called["user"]
    assert "Zhang et al. 2023" not in called["user"]
    assert "[图] Qualitative comparison" in called["user"]
    with db() as conn:
        row = conn.execute(
            "SELECT kind, content FROM summaries WHERE id=?", (result["id"],)
        ).fetchone()
    assert row is not None and row["kind"] == "socratic_card"


def test_generate_rejects_unknown_kind(parsed_doc):
    with pytest.raises(ValueError, match="未知的总结类型"):
        summarize.generate(parsed_doc, "explode")


def test_generate_requires_parsed_document(monkeypatch):
    import uuid as _uuid

    with pytest.raises(ValueError, match="尚未解析"):
        summarize.generate(str(_uuid.uuid4()), "socratic_card")
