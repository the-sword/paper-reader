"""arXiv 检索与下载。

两种入口：
  1. 关键词/标题搜索 —— 直接调用 arXiv Atom API
  2. DOI 反查 —— 先用 Crossref 取标题，再用标题搜 arXiv 并做相似度挑选

注意事项（实测得出的约束）：
  - arXiv API 有严格限流，建议请求间隔 ≥3 秒；冷启动首次可能 10-15 秒
  - 返回 429 时需退避重试
  - arXiv 条目多数没有 <arxiv:doi>，因此 DOI 反查不能依赖该字段，
    必须用标题相似度匹配
  - PDF 下载较慢（几 MB 约 10 秒），需较长超时
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

from ..core.http import make_client

ARXIV_API = "https://export.arxiv.org/api/query"
ARXIV_PDF = "https://arxiv.org/pdf/{id}"
CROSSREF_API = "https://api.crossref.org/works/{doi}"

# 两次 arXiv 请求之间的最小间隔（秒），官方建议 3 秒
_MIN_INTERVAL = 3.0
_last_call = 0.0


@dataclass
class ArxivItem:
    arxiv_id: str
    title: str
    authors: list[str]
    summary: str
    published: str
    pdf_url: str
    abs_url: str
    doi: str | None
    categories: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "arxiv_id": self.arxiv_id,
            "title": self.title,
            "authors": self.authors,
            "summary": self.summary,
            "published": self.published,
            "pdf_url": self.pdf_url,
            "abs_url": self.abs_url,
            "doi": self.doi,
            "categories": self.categories,
        }


def _throttle() -> None:
    """保证 arXiv 请求间隔，避免 429。"""
    global _last_call
    wait = _MIN_INTERVAL - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()


def _get(url: str, params: dict[str, Any] | None = None,
         timeout: float = 40, retries: int = 3) -> Any:
    """带退避的 GET。arXiv 首次请求可能很慢，超时给足。"""
    last = ""
    for attempt in range(retries):
        try:
            with make_client(url, timeout=timeout) as client:
                r = client.get(url, params=params)
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            continue

        if r.status_code == 200:
            return r

        last = f"HTTP {r.status_code}"
        if r.status_code == 429:
            # 限流：退避更久
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
            continue
        if r.status_code in (500, 502, 503, 504):
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            continue
        return r

    raise RuntimeError(f"arXiv 请求失败：{last}")


def _parse_entries(xml: str) -> list[ArxivItem]:
    items: list[ArxivItem] = []
    for block in re.findall(r"<entry>(.*?)</entry>", xml, re.S):
        def g(pattern: str) -> str:
            m = re.search(pattern, block, re.S)
            return m.group(1).strip() if m else ""

        abs_url = g(r"<id>([^<]+)</id>")
        aid = abs_url.rsplit("/abs/", 1)[-1] if "/abs/" in abs_url else ""
        if not aid:
            continue

        # 标题与摘要里的换行压平
        title = re.sub(r"\s+", " ", g(r"<title>(.*?)</title>")).strip()
        summary = re.sub(r"\s+", " ", g(r"<summary>(.*?)</summary>")).strip()

        authors = [
            re.sub(r"\s+", " ", a).strip()
            for a in re.findall(r"<author>\s*<name>(.*?)</name>", block, re.S)
        ]
        categories = re.findall(r'<category[^>]*term="([^"]+)"', block)
        doi = g(r"<arxiv:doi[^>]*>([^<]+)</arxiv:doi>") or None

        items.append(ArxivItem(
            arxiv_id=aid,
            title=title,
            authors=authors,
            summary=summary,
            published=g(r"<published>([^<]+)</published>")[:10],
            pdf_url=ARXIV_PDF.format(id=aid),
            abs_url=abs_url,
            doi=doi,
            categories=categories[:3],
        ))
    return items


def search(query: str, limit: int = 10, field: str = "all") -> list[dict[str, Any]]:
    """按关键词搜索 arXiv。

    field: all | ti（标题） | au（作者） | abs（摘要）
    """
    q = query.strip()
    if not q:
        return []

    # 用户自己写了字段前缀就原样用
    search_query = q if re.match(r"^[a-z]+:", q) else f'{field}:"{q}"'

    _throttle()
    r = _get(ARXIV_API, {
        "search_query": search_query,
        "max_results": max(1, min(limit, 30)),
        "sortBy": "relevance",
        "sortOrder": "descending",
    })
    if getattr(r, "status_code", 0) != 200:
        raise RuntimeError(f"arXiv 搜索失败：HTTP {getattr(r, 'status_code', '?')}")
    return [x.to_dict() for x in _parse_entries(r.text)]


# ---------------------------------------------------------------------------
# DOI 处理
# ---------------------------------------------------------------------------

_DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$", re.I)


def normalize_doi(raw: str) -> str:
    """从各种写法中提取 DOI。

    支持：
      10.1109/CVPR.2018.00453
      https://doi.org/10.1109/CVPR.2018.00453
      doi:10.1109/CVPR.2018.00453
    """
    s = raw.strip()
    s = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", s, flags=re.I)
    return s.strip()


def crossref_meta(doi: str) -> dict[str, Any] | None:
    """用 Crossref 获取 DOI 的元数据（标题、作者、年份）。"""
    try:
        r = _get(CROSSREF_API.format(doi=doi), timeout=20, retries=2)
    except Exception:  # noqa: BLE001
        return None
    if getattr(r, "status_code", 0) != 200:
        return None
    try:
        m = r.json()["message"]
    except Exception:  # noqa: BLE001
        return None

    title = (m.get("title") or [""])[0]
    authors = []
    for a in m.get("author") or []:
        name = " ".join(x for x in [a.get("given", ""), a.get("family", "")] if x).strip()
        if name:
            authors.append(name)

    def _year(key: str) -> int | None:
        parts = (m.get(key) or {}).get("date-parts")
        if parts and parts[0] and parts[0][0]:
            return int(parts[0][0])
        return None

    return {
        "doi": doi,
        "title": title,
        "authors": authors,
        "year": _year("published-print") or _year("published") or _year("issued"),
        "container": (m.get("container-title") or [""])[0],
        "type": m.get("type"),
    }


def _norm_title(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def _similarity(a: str, b: str) -> float:
    """标题相似度（token 级 Jaccard + 前缀加分），足够区分同名字段的不同论文。"""
    ta = set(_norm_title(a).split())
    tb = set(_norm_title(b).split())
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    union = len(ta | tb)
    jac = inter / union if union else 0.0
    # 一方是另一方前缀时给加成
    na, nb = _norm_title(a), _norm_title(b)
    prefix = 0.15 if (na.startswith(nb) or nb.startswith(na)) else 0.0
    return min(1.0, jac + prefix)


def find_by_doi(doi: str, limit: int = 8) -> dict[str, Any]:
    """根据 DOI 查找 arXiv 版本。

    策略：
      1. Crossref 取标题
      2. 用标题（必要时截断）搜 arXiv
      3. 若条目自带相同 DOI，直接命中；否则用标题相似度挑选最高分
    """
    doi = normalize_doi(doi)
    if not _DOI_RE.match(doi):
        raise ValueError("DOI 格式不正确，应形如 10.xxxx/xxxxx")

    meta = crossref_meta(doi)

    candidates: list[dict[str, Any]] = []
    if meta and meta.get("title"):
        title = meta["title"]
        # 先试完整标题，再试截断（arXiv 标题可能有副标题差异）
        for q in (f'ti:"{title}"', f'ti:"{title[:60]}"'):
            try:
                candidates = search(q, limit=limit)
            except Exception:  # noqa: BLE001
                candidates = []
            if candidates:
                break

    # 先按 DOI 精确匹配
    for c in candidates:
        if c.get("doi") and c["doi"].lower() == doi.lower():
            return {"matched": c, "meta": meta, "score": 1.0, "candidates": candidates}

    # 再按标题相似度
    best = None
    best_score = 0.0
    if meta and meta.get("title"):
        for c in candidates:
            s = _similarity(meta["title"], c.get("title", ""))
            if s > best_score:
                best_score, best = s, c

    # 相似度阈值：低于 0.5 认为不是同一篇
    matched = best if best_score >= 0.5 else None
    return {
        "matched": matched,
        "meta": meta,
        "score": round(best_score, 2),
        "candidates": candidates,
    }


def download_pdf(arxiv_id: str) -> bytes:
    """下载 arXiv PDF。"""
    aid = arxiv_id.strip()
    # 去掉版本号外的前缀 URL
    if "/abs/" in aid:
        aid = aid.rsplit("/abs/", 1)[-1]
    if not aid:
        raise ValueError("arXiv ID 无效")

    url = ARXIV_PDF.format(id=aid)
    r = _get(url, timeout=120, retries=2)
    if getattr(r, "status_code", 0) != 200:
        raise RuntimeError(f"PDF 下载失败：HTTP {getattr(r, 'status_code', '?')}")

    data = r.content
    if not data.startswith(b"%PDF"):
        raise RuntimeError("下载内容不是有效 PDF")
    return data


def fetch_meta(arxiv_id: str) -> dict[str, Any] | None:
    """按 arXiv ID 查询元数据。"""
    aid = arxiv_id.strip().split("/abs/")[-1]
    _throttle()
    r = _get(ARXIV_API, {"id_list": aid, "max_results": 1})
    if getattr(r, "status_code", 0) != 200:
        return None
    items = _parse_entries(r.text)
    return items[0].to_dict() if items else None
