"""radar_review：JSON 解析容错、字段校验、批量评审的失败隔离。"""
from __future__ import annotations

import json

import pytest

from app.services import radar_review


# ---------------------------------------------------------------------------
# 解析与校验
# ---------------------------------------------------------------------------

def test_extract_json_plain():
    obj = radar_review._extract_json('{"relevance_score": 4}')
    assert obj["relevance_score"] == 4


def test_extract_json_tolerates_fence_and_noise():
    text = '好的，以下是评审：\n```json\n{"a": 1}\n```\n希望有帮助'
    assert radar_review._extract_json(text) == {"a": 1}


def test_extract_json_array_variants():
    text = '```json\n[{"index": 1}, {"index": 2}]\n```'
    arr = radar_review._extract_json_array(text)
    assert [x["index"] for x in arr] == [1, 2]


def test_extract_json_array_rejects_plain_object():
    with pytest.raises(ValueError):
        radar_review._extract_json_array('{"index": 1}')


def test_validate_review_happy_path():
    review = radar_review._validate_review({
        "relevance_score": 5, "primary_tag": "SLAM",
        "one_sentence_summary": "一句话", "problem_solved": "痛点",
        "core_innovation": "方法", "practical_value": "价值",
        "pass_filter": "true",
    })
    assert review["pass_filter"] is True
    assert review["relevance_score"] == 5


def test_validate_review_rejects_bad_payload():
    base = {
        "relevance_score": 4, "primary_tag": "t", "one_sentence_summary": "s",
        "problem_solved": "p", "core_innovation": "c", "practical_value": "v",
        "pass_filter": True,
    }
    with pytest.raises(ValueError):
        radar_review._validate_review({**base, "relevance_score": 9})
    with pytest.raises(ValueError):
        radar_review._validate_review({**base, "one_sentence_summary": "  "})
    missing = {k: v for k, v in base.items() if k != "core_innovation"}
    with pytest.raises(ValueError):
        radar_review._validate_review(missing)


# ---------------------------------------------------------------------------
# 批量评审（mock AI 接口）
# ---------------------------------------------------------------------------

def _valid_review(index: int, score: int = 4) -> dict:
    return {
        "index": index, "relevance_score": score, "primary_tag": "SLAM",
        "one_sentence_summary": "一句话", "problem_solved": "痛点",
        "core_innovation": "方法", "practical_value": "价值",
        "pass_filter": True,
    }


def _papers(n: int) -> list[dict]:
    return [{"id": f"arxiv:2401.{i:05d}", "title": f"Paper {i}",
             "abstract": "abs", "categories": ["cs.CV"],
             "code_status": "no_code"} for i in range(1, n + 1)]


def _patch_ai(monkeypatch, content_fn):
    from app.services import translate

    monkeypatch.setattr(translate, "get_ai_config",
                        lambda: {"base_url": "http://fake", "api_key": "k", "model": "m"})

    class _Resp:
        status_code = 200

        def __init__(self, content):
            self.text = content
            self._body = {"usage": {"prompt_tokens": 10, "completion_tokens": 5},
                          "choices": [{"message": {"content": content}}]}

        def json(self):
            return self._body

    class _Client:
        calls = 0

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None, headers=None):
            _Client.calls += 1
            return _Resp(content_fn(_Client.calls))

    monkeypatch.setattr(radar_review, "make_client",
                        lambda url, timeout=120: _Client())


def test_review_batch_maps_by_index_with_holes(monkeypatch):
    """个别条目缺 index / 字段非法 → 对应位为 None，其余正常返回。"""
    payload = json.dumps([
        _valid_review(1), _valid_review(2, score=5),
        # index 3 缺失（LLM 漏了一篇）
        {**_valid_review(4), "relevance_score": "high"},  # 类型非法
        _valid_review(5),
    ], ensure_ascii=False)
    _patch_ai(monkeypatch, lambda call: f"```json\n{payload}\n```")

    out = radar_review.review_batch(_papers(5), {"name": "t"})

    assert len(out) == 5
    assert out[0]["relevance_score"] == 4
    assert out[1]["relevance_score"] == 5
    assert out[2] is None, "LLM 漏评的条目应为 None（由调用方降级）"
    assert out[3] is None, "字段类型非法的条目应为 None"
    assert out[4]["relevance_score"] == 4


def test_review_batch_retries_then_raises(monkeypatch):
    """连续两次非法输出 → 抛 RuntimeError（调用方整批降级单篇）。"""
    _patch_ai(monkeypatch, lambda call: "not a json at all")
    with pytest.raises(RuntimeError):
        radar_review.review_batch(_papers(2), {"name": "t"})


def test_review_batch_retries_once_then_succeeds(monkeypatch):
    """第一次输出非法、纠偏后成功 → 只重试一次即返回。"""
    payload = json.dumps([_valid_review(1), _valid_review(2)], ensure_ascii=False)
    calls = {"n": 0}

    def content(_call):
        calls["n"] += 1
        return "垃圾输出" if calls["n"] == 1 else f"```json\n{payload}\n```"

    _patch_ai(monkeypatch, content)
    out = radar_review.review_batch(_papers(2), {"name": "t"})
    assert all(r is not None for r in out)
    assert calls["n"] == 2


def test_review_paper_single_still_works(monkeypatch):
    payload = json.dumps(_valid_review(1), ensure_ascii=False)
    _patch_ai(monkeypatch, lambda call: payload)
    review = radar_review.review_paper(_papers(1)[0], {"name": "t"})
    assert review["relevance_score"] == 4
