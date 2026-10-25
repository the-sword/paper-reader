"""radar_arxiv：Atom 解析 + cross-list 主分类过滤 + 24h 窗口过滤。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services import radar_arxiv

_ATOM_NS = "http://www.w3.org/2005/Atom"
_ARXIV_NS = "http://arxiv.org/schemas/atom"

NOW = datetime.now(timezone.utc)


def _entry(arxiv_id: str, title: str, primary: str, cats: list[str],
           published: datetime) -> str:
    cat_xml = "".join(f'<category term="{c}"/>' for c in cats)
    return f"""<entry>
  <id>http://arxiv.org/abs/{arxiv_id}</id>
  <title>{title}</title>
  <summary>Abstract of {title}.</summary>
  <published>{published.strftime('%Y-%m-%dT%H:%M:%SZ')}</published>
  <author><name>A. Author</name></author>
  {cat_xml}
  <arxiv:primary_category xmlns:arxiv="{_ARXIV_NS}" term="{primary}"/>
</entry>"""


def _feed(entries: list[str]) -> str:
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="{_ATOM_NS}">
{''.join(entries)}
</feed>'''


def test_parse_feed_extracts_primary_category():
    xml = _feed([_entry("2401.00001", "Paper A", "cs.CV", ["cs.CV", "cs.RO"], NOW)])
    items = radar_arxiv._parse_feed(xml)
    assert len(items) == 1
    assert items[0]["primary_category"] == "cs.CV"
    assert items[0]["categories"] == ["cs.CV", "cs.RO"]


def test_parse_feed_primary_fallback_to_first_category():
    """无 primary_category 元素时退化为分类列表首项。"""
    xml = f'''<feed xmlns="{_ATOM_NS}">
<entry><id>http://arxiv.org/abs/2401.00002</id><title>B</title>
<summary>s</summary><published>{NOW.strftime('%Y-%m-%dT%H:%M:%SZ')}</published>
<category term="cs.RO"/><category term="cs.CV"/></entry></feed>'''
    items = radar_arxiv._parse_feed(xml)
    assert items[0]["primary_category"] == "cs.RO"


class _FakeResp:
    def __init__(self, text: str):
        self.status_code = 200
        self.text = text


class _FakeClient:
    def __init__(self, text: str):
        self._text = text

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, params=None):
        return _FakeResp(self._text)


def _patch_http(monkeypatch, xml: str):
    monkeypatch.setattr(radar_arxiv, "make_client", lambda url, timeout=30: _FakeClient(xml))


def test_fetch_filters_cross_list_by_default(monkeypatch):
    """默认仅保留主分类命中订阅集的论文（cross-list 丢弃）。"""
    entries = [
        _entry("2401.00001", "Primary CV", "cs.CV", ["cs.CV"], NOW - timedelta(hours=2)),
        # 主分类 math.AG，cs.CV 只是次分类 → cross-list，应被过滤
        _entry("2401.00002", "CrossListed", "math.AG", ["math.AG", "cs.CV"],
               NOW - timedelta(hours=3)),
    ]
    _patch_http(monkeypatch, _feed(entries))
    out = radar_arxiv.fetch_by_categories(
        ["cs.CV"], NOW - timedelta(hours=24), NOW, max_results=50,
    )
    assert [p["arxiv_id"] for p in out] == ["2401.00001"]


def test_fetch_include_cross_list_keeps_secondary(monkeypatch):
    entries = [
        _entry("2401.00001", "Primary CV", "cs.CV", ["cs.CV"], NOW - timedelta(hours=2)),
        _entry("2401.00002", "CrossListed", "math.AG", ["math.AG", "cs.CV"],
               NOW - timedelta(hours=3)),
    ]
    _patch_http(monkeypatch, _feed(entries))
    out = radar_arxiv.fetch_by_categories(
        ["cs.CV"], NOW - timedelta(hours=24), NOW, max_results=50,
        include_cross_list=True,
    )
    assert {p["arxiv_id"] for p in out} == {"2401.00001", "2401.00002"}


def test_fetch_window_filters_old_and_future(monkeypatch):
    entries = [
        _entry("2401.00001", "InWindow", "cs.CV", ["cs.CV"], NOW - timedelta(hours=2)),
        _entry("2401.00002", "TooOld", "cs.CV", ["cs.CV"], NOW - timedelta(days=3)),
        _entry("2401.00003", "Future", "cs.CV", ["cs.CV"], NOW + timedelta(hours=2)),
    ]
    _patch_http(monkeypatch, _feed(entries))
    out = radar_arxiv.fetch_by_categories(
        ["cs.CV"], NOW - timedelta(hours=24), NOW, max_results=50,
    )
    assert [p["arxiv_id"] for p in out] == ["2401.00001"]


def test_fetch_stops_paging_when_older_than_window(monkeypatch):
    """倒序翻页：本页最旧一条早于窗口起点即停止，不再请求下一页。"""
    entries = [
        _entry("2401.00001", "InWindow", "cs.CV", ["cs.CV"], NOW - timedelta(hours=2)),
        _entry("2401.00002", "Old", "cs.CV", ["cs.CV"], NOW - timedelta(days=3)),
    ]
    calls = []

    class _CountingClient(_FakeClient):
        def get(self, url, params=None):
            calls.append(params)
            return super().get(url, params)

    monkeypatch.setattr(
        radar_arxiv, "make_client",
        lambda url, timeout=30: _CountingClient(_feed(entries)),
    )
    radar_arxiv.fetch_by_categories(["cs.CV"], NOW - timedelta(hours=24), NOW,
                                    max_results=100)
    assert len(calls) == 1, "最旧条目已早于窗口起点时不应继续翻页"
