"""MinerU 云 API 适配器。

接口要点（见 DESIGN.md 第 8.1 节）：
  - 本地文件不能直接提交，必须走 /file-urls/batch 拿签名上传链接
  - 上传后系统自动提交解析任务，无需再调提交接口
  - 任务状态：waiting-file → pending → running → done/failed
  - 结果是一个 zip，含 full.md / content_list.json / 图片

设计上把「提交」和「轮询」拆开，便于：
  a) 前端拿 task_id 后自行轮询进度
  b) 未来换自建 MinerU 服务时只替换本文件
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..core.config import get_settings
from ..core.http import make_client

BASE = "https://mineru.net/api/v4"

# 各状态的语义化进度（前端据此显示）
STATE_PROGRESS = {
    "waiting-file": 5,
    "pending": 15,
    "running": 55,
    "converting": 80,
    "done": 100,
    "failed": 0,
}


class MinerUError(RuntimeError):
    pass


_IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".jp2")


def _is_image_entry(name: str) -> bool:
    """判断 zip 内条目是否为图片。兼容 "images/x.jpg" 与 "a/images/x.jpg"。"""
    if name.endswith("/"):
        return False
    low = name.lower()
    if not low.endswith(_IMG_EXTS):
        return False
    return "images/" in low or "/images/" in low


@dataclass
class ParseResult:
    full_md: str
    content_list: list[dict[str, Any]]
    images: dict[str, bytes]  # 文件名 -> 二进制


def _token() -> str:
    tok = get_settings().mineru_token.strip()
    if not tok:
        raise MinerUError("未配置 MINERU_TOKEN，请在 backend/.env 中填写")
    return tok


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_token()}",
        "Content-Type": "application/json",
        "Accept": "*/*",
    }


def submit_file(pdf_path: Path, data_id: str | None = None) -> str:
    """上传本地 PDF 并自动提交解析任务，返回 task_id。

    流程：
      1) POST /file-urls/batch 申请上传链接（同时创建解析任务）
      2) PUT 把文件二进制传到签名 URL
      3) 系统自动扫描并开始解析
    """
    s = get_settings()
    payload = {
        "files": [{"name": pdf_path.name, "data_id": data_id or pdf_path.stem}],
        "model_version": s.mineru_model,
    }
    with make_client(BASE, timeout=120) as client:
        r = client.post(f"{BASE}/file-urls/batch", headers=_headers(), json=payload)
        if r.status_code != 200:
            raise MinerUError(f"申请上传链接失败 HTTP {r.status_code}: {r.text[:300]}")
        body = r.json()
        if body.get("code") != 0:
            raise MinerUError(f"申请上传链接失败: {body.get('msg')}")

        data = body["data"]
        batch_id = data["batch_id"]
        upload_url = data["file_urls"][0]

        # 上传时不能带 Content-Type
        with pdf_path.open("rb") as f:
            up = client.put(upload_url, content=f.read(), timeout=300)
        if up.status_code not in (200, 201):
            raise MinerUError(f"文件上传失败 HTTP {up.status_code}")

    # 批量接口返回 batch_id，单文件任务需用 batch 查询；
    # 这里统一记成 "batch:<id>"，由 get_result 分派。
    return f"batch:{batch_id}"


def get_state(task_id: str) -> tuple[str, float, str | None]:
    """查询任务状态，返回 (state, progress, err_msg)。

    task_id 支持两种形式：
      - "batch:<batch_id>" —— 批量/上传接口发起
      - 纯 uuid —— 单文件 /extract/task 发起
    """
    with make_client(BASE, timeout=60) as client:
        if task_id.startswith("batch:"):
            bid = task_id.split(":", 1)[1]
            r = client.get(f"{BASE}/extract-results/batch/{bid}", headers=_headers())
            if r.status_code != 200:
                raise MinerUError(f"查询失败 HTTP {r.status_code}: {r.text[:200]}")
            body = r.json()
            if body.get("code") != 0:
                raise MinerUError(f"查询失败: {body.get('msg')}")
            results = body["data"].get("extract_result") or []
            if not results:
                return "pending", STATE_PROGRESS["pending"], None
            item = results[0]
            state = item.get("state", "pending")
            err = item.get("err_msg") or None
        else:
            r = client.get(f"{BASE}/extract/task/{task_id}", headers=_headers())
            if r.status_code != 200:
                raise MinerUError(f"查询失败 HTTP {r.status_code}: {r.text[:200]}")
            body = r.json()
            if body.get("code") != 0:
                raise MinerUError(f"查询失败: {body.get('msg')}")
            item = body["data"]
            state = item.get("state", "pending")
            err = item.get("err_msg") or None

    # running 状态下用页数估算更细的进度
    progress = STATE_PROGRESS.get(state, 30)
    ep = (item.get("extract_progress") or {}) if isinstance(item, dict) else {}
    if state == "running" and ep.get("total_pages"):
        done_pages = ep.get("extracted_pages", 0)
        progress = 15 + 65 * (done_pages / max(1, ep["total_pages"]))
    return state, progress, err


def fetch_result(task_id: str) -> ParseResult:
    """下载并解压解析结果。"""
    with make_client(BASE, timeout=300) as client:
        zip_url = _locate_zip_url(client, task_id)
        r = client.get(zip_url)
        if r.status_code != 200:
            raise MinerUError(f"下载结果失败 HTTP {r.status_code}")

    full_md = ""
    content_list: list[dict[str, Any]] = []
    images: dict[str, bytes] = {}

    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        for name in zf.namelist():
            if name.endswith("full.md"):
                full_md = zf.read(name).decode("utf-8", errors="replace")
            elif name.endswith("content_list.json"):
                import json

                content_list = json.loads(zf.read(name).decode("utf-8", errors="replace"))
            elif _is_image_entry(name):
                # zip 内路径形如 "images/xxx.jpg"（开头无斜杠），
                # 早期用 "/images/" 判断会漏掉全部图片。
                images[name.rsplit("/", 1)[-1]] = zf.read(name)

    if not full_md and not content_list:
        raise MinerUError("解析结果为空：未找到 full.md / content_list.json")

    return ParseResult(full_md=full_md, content_list=content_list, images=images)


def _locate_zip_url(client, task_id: str) -> str:
    if task_id.startswith("batch:"):
        bid = task_id.split(":", 1)[1]
        r = client.get(f"{BASE}/extract-results/batch/{bid}", headers=_headers())
        body = r.json()
        results = body["data"].get("extract_result") or []
        if not results:
            raise MinerUError("批量任务无结果")
        url = results[0].get("full_zip_url")
    else:
        r = client.get(f"{BASE}/extract/task/{task_id}", headers=_headers())
        url = r.json()["data"].get("full_zip_url")

    if not url:
        raise MinerUError("任务已完成但没有 download url")
    return url
