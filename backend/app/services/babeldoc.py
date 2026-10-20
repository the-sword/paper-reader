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
import os
import re
import threading
from pathlib import Path
from typing import Any

from ..core.config import get_settings
from ..core.db import db
from . import translate as ai_mod

# ---------------------------------------------------------------------------
# 跳过翻译：标题 + 参考文献 + 致谢
#
# babeldoc 0.6.x（pdf2zh-next 2.9.0 锁定 <0.7.0）没有官方的「不译标题/参考
# 文献」选项；官方在新版才加入按布局跳过的能力。这里对翻译器打运行时补丁：
#   1. 段落 layout_label 命中跳过集合（标题类 + reference 类）→ 不翻译
#   2. 翻译开始前对全文档按顺序扫描，遇到 References/Bibliography/
#      Acknowledgements/致谢 等独立标题行后，其后段落统一标记为 reference
#      跳过（覆盖 DocLayout 模型把参考文献误分类为 text/paragraph 的情况）
#
# 关键：pdf2zh-next 对支持 LLM 的引擎走 ILTranslatorLLMOnly（独立类，
# 自带 translate/process_page），两条路径仅在 pre_translate_paragraph
# 上汇合；因此跳过判定放 pre_translate_paragraph，区域标记放两条路径
# 各自的 translate() 入口。pre_translate_paragraph 返回 (None, None) 时
# BabelDOC 原样保留段落，不调 LLM、不改排版。
# ---------------------------------------------------------------------------

#: 默认跳过翻译的布局标签（逗号分隔，可用 PAPER_READER_SKIP_LAYOUTS 覆盖）
_SKIP_LAYOUTS_DEFAULT = (
    "doc_title,title,paragraph_title,"
    "reference,reference_content,reference_hybrid"
)

#: References / 致谢 区起始标题（独立短行才算，避免误伤正文句子）
_REF_HEADING_RE = re.compile(
    r"^\s*(references?|bibliography|literature\s+cited|works\s+cited"
    r"|acknowledgements?|acknowledgments?"
    r"|参考文献|引用文献|参考资料|致谢)\s*:?\s*$",
    re.IGNORECASE,
)

#: 附录关键词（行首）
_APPENDIX_KW_RE = re.compile(r"^(appendix|appendices|annex|附录)", re.IGNORECASE)

#: 附录标题里的编号（A / A.1 / B2 等）
_APPENDIX_DESIG_RE = re.compile(r"([A-Za-z0-9]{1,3}(?:\.\d+)*)\s*([:：.．\-–—]?)\s*(.*)")

_patch_lock = threading.Lock()
_patch_applied = False


def _skip_layout_set() -> frozenset[str]:
    """解析环境变量得到本次要跳过的布局标签集合。"""
    raw = os.environ.get("PAPER_READER_SKIP_LAYOUTS", _SKIP_LAYOUTS_DEFAULT)
    return frozenset(s.strip() for s in raw.split(",") if s.strip())


def _ref_section_enabled() -> bool:
    """References/致谢 区域检测开关（默认开，0 关闭）。"""
    return os.environ.get("PAPER_READER_SKIP_REF_SECTION", "1") == "1"


def _appendix_resume_enabled() -> bool:
    """附录边界恢复翻译开关（默认开，0 关闭）。"""
    return os.environ.get("PAPER_READER_RESUME_APPENDIX", "1") == "1"


def _is_appendix_heading(text: str) -> bool:
    """判断一行文本是否为附录标题。

    接受形态：Appendix / Appendix A / Appendix A: Proofs / Appendix: Proofs
    / 附录 / 附录A / 附录A：证明。
    拒绝正文句子（如 "Appendix A contains the details"）：带标题文字时
    必须有分隔符（冒号/破折号等），避免误恢复已跳过区域。
    """
    m = _APPENDIX_KW_RE.match(text)
    if not m:
        return False
    rest = text[m.end():].strip()
    if not rest:
        return True
    # 「Appendix: Proofs」「附录：证明」：分隔符直接跟在关键词后
    if rest[:1] in ":：.．-–—" and len(rest) > 1:
        return True
    # 「Appendix A」「附录A1」「Appendix A: Proofs」：编号（可带分隔符+标题）
    dm = _APPENDIX_DESIG_RE.match(rest)
    if dm:
        sep, title = dm.group(2).strip(), dm.group(3).strip()
        if not title or sep:
            return True
    return False


def _mark_reference_sections(docs: Any) -> None:
    """按文档顺序扫描段落，把 References/致谢 区之后的段落标记为 reference。

    遇到附录标题即恢复翻译（后续段落保持原布局标签，正常送翻）。
    必须在 ILTranslator / ILTranslatorLLMOnly 的 translate() 入口、任何
    段落处理开始之前执行，才能覆盖跨页段落与批量分组。
    """
    if not _ref_section_enabled():
        return
    resume = _appendix_resume_enabled()
    in_refs = False
    for page in getattr(docs, "page", None) or []:
        for para in getattr(page, "pdf_paragraph", None) or []:
            text = (getattr(para, "unicode", "") or "").strip()
            if in_refs:
                # 附录标题 → 恢复该段落及其后段落的翻译
                if resume and len(text) <= 100 and _is_appendix_heading(text):
                    in_refs = False
                else:
                    para.layout_label = "reference"
            elif len(text) <= 40 and _REF_HEADING_RE.match(text):
                # 区域标题行本身也不翻译，其后段落一并跳过
                para.layout_label = "reference"
                in_refs = True


def _apply_skip_translation_patch() -> None:
    """给 babeldoc 翻译器打「跳过标题/参考文献/致谢」补丁（幂等、线程安全）。

    只包装方法、命中条件时提前返回，不改变原调用签名；
    babeldoc 内部结构变化时对应包装自动不生效（getattr 防御），
    不影响正常翻译。
    """
    global _patch_applied
    with _patch_lock:
        if _patch_applied:
            return
        try:
            import logging

            from babeldoc.format.pdf.document_il.midend import (
                il_translator as _it,
            )
            from babeldoc.format.pdf.document_il.midend import (
                il_translator_llm_only as _it_llm,
            )

            skip_set = _skip_layout_set()
            orig_pre = _it.ILTranslator.pre_translate_paragraph

            def _pre_wrapper(self, paragraph, *args, **kwargs):
                if getattr(paragraph, "layout_label", None) in skip_set:
                    return None, None
                return orig_pre(self, paragraph, *args, **kwargs)

            _it.ILTranslator.pre_translate_paragraph = _pre_wrapper

            # 两条翻译路径的 translate() 入口都做区域标记
            # - ILTranslator：非 LLM 引擎 / fallback 路径
            # - ILTranslatorLLMOnly：pdf2zh-next 对支持 LLM 的引擎的默认路径
            #   （它内部持有 ILTranslator 实例并复用其 pre_translate_paragraph）
            for cls in (_it.ILTranslator, getattr(_it_llm, "ILTranslatorLLMOnly", None)):
                if cls is None:
                    continue
                orig_translate = cls.translate

                def _translate_wrapper(self, docs, *args, **kwargs):
                    _mark_reference_sections(docs)
                    return orig_translate(self, docs, *args, **kwargs)

                cls.translate = _translate_wrapper
            _patch_applied = True
        except Exception as exc:  # noqa: BLE001 - 补丁失败仅告警，不阻断翻译
            logging.getLogger(__name__).warning(
                "跳过标题/参考文献补丁未生效（babeldoc 版本不兼容？）: %s", exc
            )


def is_available() -> tuple[bool, str]:
    """检查 BabelDOC 是否已安装。返回 (可用, 原因)。

    双语 PDF 属于可选功能，依赖体积约 1.1GB，默认不随基础部署安装。
    """
    try:
        import pdf2zh_next  # noqa: F401

        return True, ""
    except ImportError:
        return False, (
            "未安装双语 PDF 依赖。"
            "在 VPS 上执行：cd backend && "
            "pip install -r requirements-babeldoc.txt"
        )


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

    ok, reason = is_available()
    if not ok:
        raise RuntimeError(reason)

    # 跳过标题/参考文献（可在环境变量里关闭/自定义）
    _apply_skip_translation_patch()

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

    # 心跳与阶段提示：BabelDOC 版面解析阶段（CPU 密集，可达数分钟）不发任何
    # 进度事件，调用方若只靠事件更新进度会长时间停留在初始值，看起来像卡死。
    # 这里线程存活期间持续回调：有事件走事件进度，无事件给心跳 + 阶段文案。
    import time as _time

    _start = _time.monotonic()
    _last_event = [_start]  # 最近一次收到进度事件的单调时间

    def _progress_capture(pct: float, msg: str) -> None:
        if pct > 0:
            _last_event[0] = _time.monotonic()
        if on_progress:
            on_progress(pct, msg)

    # 用 _progress_capture 替换后续实际转发（_run 里引用的是 on_progress 参数，
    # Python 闭包按名字查找，直接重绑局部名即可）
    on_progress = _progress_capture

    while t.is_alive():
        t.join(timeout=0.5)
        if cancel_event is not None and cancel_event.is_set():
            break
        if on_progress:
            idle = _time.monotonic() - _last_event[0]
            if idle >= 5:
                mins = int(idle // 60)
                hint = f"版面解析中（已 {mins} 分钟，大文档/CPU 较慢属正常）" if idle >= 60 \
                    else "版面解析中…"
                on_progress(-1, hint)  # 心跳，让调用方维持轮询

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
