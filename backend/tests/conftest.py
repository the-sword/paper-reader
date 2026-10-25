"""pytest 全局夹具。

关键顺序：LIB_ROOT 环境变量与 .env 清空必须在任何 app 模块导入前完成——
Settings 的默认 lib_root 在 config 模块导入时求值，且 .env 合并值会盖过
环境变量。conftest 先于测试模块导入，这里做一次性隔离。
"""
from __future__ import annotations

import os
import sys
import tempfile
import pathlib

# 1) 隔离数据目录 + 关闭鉴权（在导入 app 之前）
_LIB_ROOT = tempfile.mkdtemp(prefix="paper-reader-test-")
os.environ["LIB_ROOT"] = _LIB_ROOT
os.environ["AUTH_TOKEN"] = ""
os.environ["PAPER_READER_SECRET"] = ""
os.environ["GITHUB_TOKEN"] = ""

# 2) backend 加入 sys.path
_BACKEND = pathlib.Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# 3) 清空已合并的 .env（防止开发机真实密钥/口令影响测试）
from app.core import config as _config  # noqa: E402

_config._ENV_VALUES = {}

import pytest  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _init_db():
    from app.core.db import init_db

    init_db()


@pytest.fixture(autouse=True)
def clean_db():
    """每个测试用例前清空雷达/文献相关表，互不污染。"""
    from app.core.db import db

    with db() as conn:
        for t in ("radar_papers", "radar_fts", "radar_repos", "radar_topics",
                  "radar_repo_items", "github_stars",
                  "digest_history", "digest_items", "documents", "segments",
                  "summaries", "settings"):
            conn.execute(f"DELETE FROM {t}")
    yield


@pytest.fixture()
def topic_factory():
    """快速写入一个合法 Topic 配置。"""
    from app.services import radar_topics

    def _make(tid="t1", name="测试主题", categories=None, keywords=None,
              min_score=4, focus=""):
        topics = [{
            "id": tid, "name": name,
            "categories": categories or ["cs.CV"],
            "keywords": keywords or [],
            "evaluation_focus": focus,
            "min_score_to_show": min_score,
        }]
        return radar_topics.set_topics(topics)

    return _make


@pytest.fixture()
def pipeline_mocks(monkeypatch):
    """mock 管道全部网络依赖：4 篇候选（3 篇关键词命中），批审 1 篇失败位降级单篇。"""
    from datetime import datetime, timedelta, timezone

    from app.services import radar_arxiv, radar_github, radar_review

    now = datetime.now(timezone.utc)

    def _paper(i: int, title: str, abstract: str) -> dict:
        return {
            "arxiv_id": f"2401.{i:05d}", "title": title, "abstract": abstract,
            "published": (now - timedelta(hours=2)).isoformat(),
            "comment": "", "authors": [f"Author {i}"],
            "categories": ["cs.CV"], "primary_category": "cs.CV", "doi": None,
            "abs_url": f"https://arxiv.org/abs/2401.{i:05d}",
            "pdf_url": f"https://arxiv.org/pdf/2401.{i:05d}",
        }

    papers = [
        _paper(1, "OccSLAM real-time", "occupancy SLAM"),
        _paper(2, "OccFusion fusion", "occupancy fusion"),
        _paper(3, "OccLight fast", "occupancy fast"),
        _paper(4, "Unrelated NLP paper", "language model translation"),  # 关键词不中
    ]
    code_map = {"arxiv:2401.00001": ("code_available", "https://github.com/a/b",
                                     {"stars": 42}),
                "arxiv:2401.00002": ("no_code", "", None),
                "arxiv:2401.00003": ("no_code", "", None)}

    def fake_fetch(cats, since, until, max_results=300, include_cross_list=False):
        return [p for p in papers if p["primary_category"] in cats]

    def fake_code_status(p, counter):
        return code_map.get(f"arxiv:{p['arxiv_id']}", ("no_code", "", None))

    def _review(score: int, tag: str = "SLAM") -> dict:
        return {
            "relevance_score": score, "primary_tag": tag,
            "one_sentence_summary": f"一句话-{score}", "problem_solved": "痛点",
            "core_innovation": "方法", "practical_value": "价值", "pass_filter": True,
        }

    def fake_batch(batch_papers, topic):
        out = []
        for p in batch_papers:
            pid = f"arxiv:{p['arxiv_id']}"
            if pid == "arxiv:2401.00002":
                out.append(None)
            else:
                out.append(_review(4 if pid == "arxiv:2401.00001" else 3))
        return out

    def fake_single(p, topic):
        return _review(2, tag="FALLBACK")  # 降级路径给低分，验证区分来源

    monkeypatch.setattr(radar_arxiv, "fetch_by_categories", fake_fetch)
    monkeypatch.setattr(radar_github, "code_status_for", fake_code_status)
    monkeypatch.setattr(radar_review, "review_batch", fake_batch)
    monkeypatch.setattr(radar_review, "review_paper", fake_single)

    # 独立开源项目发现 mock（不触网）
    def fake_search(keywords, limit=8):
        return [
            {"id": "github:a/occfusion-lib", "title": "a/occfusion-lib",
             "url": "https://github.com/a/occfusion-lib",
             "description": "OccFusion official implementation", "stars": 1200,
             "star_growth": 35, "language": "Python",
             "pushed_at": now.isoformat(), "created_at": (now - timedelta(days=20)).isoformat(),
             "score": 120.0},
            {"id": "github:b/quantvlm", "title": "b/quantvlm",
             "url": "https://github.com/b/quantvlm", "description": "INT4 quantization",
             "stars": 87, "star_growth": 6, "language": "C++",
             "pushed_at": now.isoformat(), "created_at": (now - timedelta(days=10)).isoformat(),
             "score": 45.0},
        ]

    monkeypatch.setattr(radar_github, "search_repositories", fake_search)
    return {"papers": papers}
