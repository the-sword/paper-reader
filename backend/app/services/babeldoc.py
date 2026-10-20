"""BabelDOC 双语 PDF 翻译服务（ReadPaper 式体验）。

与段落流翻译的区别：
  - 段落流：解析成 Markdown 重排，适合流畅阅读，但丢排版
  - BabelDOC：保留原 PDF 版式，把译文锚回原位置，生成双语 PDF

实现基于 pdf2zh-next（BabelDOC 官方参考实现），使用
do_translate_async_stream 获取实时进度事件。

翻译引擎复用全局 AI 配置（OpenAI 兼容协议）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from ..core.config import get_settings
from ..core.db import db
from . import translate as ai_mod


def get_ai_config_for_babeldoc() -> dict[str, Any]:
    """从全局 AI 配置构造 pdf2zh 的引擎参数。"""
    cfg = ai_mod.get_ai_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("未配置 AI 接口，无法生成双语 PDF")

    base = cfg["base_url"].rstrip("/")
    # pdf2zh 的 OpenAICompatible 需要完整 base_url（含 /v1）
    return {
        "base_url": base,
        "api_key": cfg["api_key"],
        "model": cfg.get("model") or "gpt-4o-mini",
    }


def _find_output(files_dir: Path, stem: str) -> dict[str, str]:
    """在输出目录里找到生成的 mono / dual PDF。"""
    mono = dual = None
    for p in files_dir.rglob("*.pdf"):
        if stem in p.name:
            if "dual" in p.name.lower():
                dual = str(p)
            elif "mono" in p.name.lower():
                mono = str(p)
    return {"mono": mono, "dual": dual}


async def translate_pdf_async(
    doc_id: str,
    pdf_path: Path,
    pages: str | None = None,
    on_progress: Any = None,
    cancel_event: Any = None,
) -> dict[str, Any]:
    """翻译 PDF 并生成双语版，返回输出文件路径。

    on_progress(percent, message) 用于实时进度回调。
    输出写入 parsed/<doc_id>/babeldoc/。
    """
    import asyncio as _asyncio
    import os as _os
    from pathlib import Path as _Path

    from pdf2zh_next import high_level

    # pdf2zh 内部自建 httpx.Client 并读取环境代理；
    # 本机 all_proxy=socks5://... + no_proxy 含 [::1] 会让 httpx 报
    # Invalid port，导致翻译失败。这里临时清掉代理变量。
    saved_proxy = {}
    for k in ("HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY",
              "http_proxy","https_proxy","all_proxy","no_proxy"):
        if k in _os.environ:
            saved_proxy[k] = _os.environ.pop(k)
    from pdf2zh_next.config.model import PDFSettings, SettingsModel
    from pdf2zh_next.config.translate_engine_model import OpenAICompatibleSettings

    s = get_settings()
    engine = get_ai_config_for_babeldoc()

    out_dir = s.parsed_dir / doc_id / "babeldoc"
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- VPS 优化：按 CPU 核数自适应并发 ---
    # 翻译是 IO 密集型（等 API），但排版/字体处理是 CPU 密集型。
    # 2 核机器上 qps 开太高会导致线程争抢，反而变慢。
    import os as _os2

    cpu = _os2.cpu_count() or 2
    qps = max(2, min(8, cpu * 2))
    # 关闭自动术语提取：省一轮 LLM 调用（成本和时间都省），
    # 个人阅读场景术语表收益有限。
    auto_glossary = _os2.environ.get("PAPER_READER_BABEL_GLOSSARY", "0") == "1"

    settings = SettingsModel(
        basic={
            "input_files": {str(pdf_path)},
            "debug": False,
        },
        translation={
            "lang_in": "en",
            "lang_out": "zh",
            "output": str(out_dir),
            "qps": qps,
            "no_auto_extract_glossary": not auto_glossary,
            "pool_max_workers": max(2, cpu),
        },
        pdf=PDFSettings(
            pages=pages,
            no_dual=False,     # 需要双语版
            no_mono=True,      # 单语版不需要
            translate_table_text=True,
            only_include_translated_page=True,
        ),
        translate_engine_settings=OpenAICompatibleSettings(
            openai_compatible_base_url=engine["base_url"],
            openai_compatible_api_key=engine["api_key"],
            openai_compatible_model=engine["model"],
            openai_compatible_temperature="0.3",
        ),
    )

    # 在独立事件循环中跑异步流，把事件转发给回调
    result: dict[str, Any] = {"state": "running", "pages_done": 0, "total": 0}

    async def _run():
        translate_result = None
        async for event in high_level.do_translate_async_stream(settings, str(pdf_path)):
            if cancel_event is not None and cancel_event.is_set():
                raise ai_mod.Cancelled("已取消")

            if not isinstance(event, dict):
                continue

            etype = event.get("type")

            # BabelDOC 实际事件结构：
            #   progress_start/update/end: stage, stage_progress, overall_progress
            #   finish: translate_result
            if etype in ("progress_start", "progress_update", "progress_end"):
                overall = event.get("overall_progress") or 0
                stage = event.get("stage") or ""
                if on_progress:
                    # 映射到 20-95 区间
                    pct = 20 + 75 * (overall / 100)
                    on_progress(pct, f"{stage or '处理中'}")

            elif etype == "finish":
                translate_result = event.get("translate_result")
                result["state"] = "done"

    # 执行完毕后从 translate_result 拿输出路径

    # uvicorn 已有运行中的 loop，用线程跑新 loop 避免冲突
    import threading

    def _thread_main():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(_run())
        finally:
            loop.close()

    t = threading.Thread(target=_thread_main, name="babeldoc", daemon=True)
    t.start()
    while t.is_alive():
        t.join(timeout=0.5)
        if on_progress:
            on_progress(-1, "")  # 心跳，让调用方维持轮询

    # 恢复环境变量
    for k, v in saved_proxy.items():
        _os.environ[k] = v

    # 找输出文件
    outs = _find_output(out_dir, Path(pdf_path).stem)
    if not outs["dual"]:
        raise RuntimeError("BabelDOC 未生成双语 PDF")

    return {
        "dual_pdf": outs["dual"],
        "mono_pdf": outs["mono"],
        "output_dir": str(out_dir),
    }


def get_babeldoc_pdf(doc_id: str) -> dict[str, str] | None:
    """返回该文档已生成的双语 PDF 路径（若无则 None）。"""
    s = get_settings()
    d = s.parsed_dir / doc_id / "babeldoc"
    if not d.exists():
        return None
    dual = mono = None
    for p in d.rglob("*.pdf"):
        if "dual" in p.name.lower():
            dual = str(p)
        elif "mono" in p.name.lower():
            mono = str(p)
    if not dual:
        return None
    return {"dual": dual, "mono": mono}


def save_babeldoc_status(doc_id: str, status: str) -> None:
    import json

    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (f"babeldoc.{doc_id}", json.dumps({"status": status}, ensure_ascii=False)),
        )
