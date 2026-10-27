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
import functools
import logging
import os
import re
import sys
import threading
import traceback
from collections import Counter
from pathlib import Path
from typing import Any, Callable

from ..core.config import get_settings
from ..core.db import db
from . import translate as ai_mod

#: 全局互斥：同一进程同时只允许一个 BabelDOC 实例。
#: ONNX 版面解析单实例峰值 ~300MB，并发实例会把 2C VPS 打满，
#: 手动触发的 job 与导入自动队列共用此锁，保证「自始至终只有一个」。
TRANSLATE_LOCK = threading.Lock()


def acquire_translate_lock(
    cancel_event: threading.Event | None = None,
    on_wait: Any = None,
) -> bool:
    """取消感知地获取全局翻译锁。

    每 0.5s 轮询一次取消标志；首次发现需要等待时回调一次 on_wait
    （供调用方更新「排队中」提示）。返回是否成功获取。
    """
    notified = False
    while not TRANSLATE_LOCK.acquire(timeout=0.5):
        if cancel_event is not None and cancel_event.is_set():
            return False
        if not notified and on_wait is not None:
            on_wait()
            notified = True
    return True

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
_patch_applied_xobj = False
_patch_applied_child = False

#: 子进程递归深度上限默认值（环境变量 PAPER_READER_BABEL_RECURSION 覆盖）
CHILD_RECURSION_LIMIT_DEFAULT = 10000
#: 子进程新建线程的栈大小默认值，单位 MB（环境变量 PAPER_READER_BABEL_STACK_MB 覆盖）
CHILD_THREAD_STACK_MB_DEFAULT = 256


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


def _make_translate_wrapper(orig: Callable[..., Any]) -> Callable[..., Any]:
    """包装翻译器 translate：入口先做参考文献区域标记，再调用原方法。

    orig 绑定在工厂参数上（而非循环变量），避免闭包晚绑定；已包装过的方法直接返回，保证幂等。
    """
    if getattr(orig, "_pr_wrapped", False):
        return orig

    def _translate_wrapper(self: Any, docs: Any, *args: Any, **kwargs: Any) -> Any:
        _mark_reference_sections(docs)
        return orig(self, docs, *args, **kwargs)

    _translate_wrapper._pr_wrapped = True  # type: ignore[attr-defined]
    return _translate_wrapper


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
                cls.translate = _make_translate_wrapper(cls.translate)
            _patch_applied = True
        except Exception as exc:  # noqa: BLE001 - 补丁失败仅告警，不阻断翻译
            logging.getLogger(__name__).warning(
                "跳过标题/参考文献补丁未生效（babeldoc 版本不兼容？）: %s", exc
            )


def _make_xobj_guard(orig: Callable[..., Any], max_depth: int) -> Callable[..., Any]:
    """包装 do_Do：按 XObject 对象身份判环 + 限制嵌套深度，超限则跳过该子树。

    调用链栈挂在 device 上（dup interpreter 间共享）。orig 绑定在工厂参数上，
    同一工厂既用于 legacy PDFPageInterpreter，也用于 PDFPageInterpreterEx。
    """
    if getattr(orig, "_pr_wrapped", False):
        return orig
    from babeldoc.pdfminer.pdftypes import stream_value
    from babeldoc.pdfminer.psparser import literal_name

    log = logging.getLogger(__name__)

    def _do_wrapper(self: Any, xobjid_arg: Any, *args: Any, **kwargs: Any) -> Any:
        dev = self.device
        stack = getattr(dev, "_pr_xobj_stack", None)
        if stack is None:
            stack = dev._pr_xobj_stack = []
        # 按对象身份判环（同名 XObject 在不同资源域下可合法复用）
        try:
            key: int | None = id(stream_value(self.xobjmap.get(literal_name(xobjid_arg))))
        except Exception:  # noqa: BLE001 - 资源缺失交给原逻辑报错
            key = None
        if (key is not None and key in stack) or len(stack) >= max_depth:
            log.warning("跳过循环/过深嵌套的 XObject: %r（深度 %d）", xobjid_arg, len(stack))
            return None
        stack.append(key)
        try:
            return orig(self, xobjid_arg, *args, **kwargs)
        finally:
            stack.pop()

    _do_wrapper._pr_wrapped = True  # type: ignore[attr-defined]
    return _do_wrapper


def _apply_xobj_recursion_guard() -> None:
    """给 babeldoc 的 do_Do 加「循环引用 + 深度」守卫（幂等、线程安全）。

    这是旧版 legacy 解析路径（PDFPageInterpreter）的兜底：pdfminer 处理
    Form XObject 走 Python 递归，XObject 自引用或超深嵌套会抛 RecursionError。
    babeldoc 0.6.x 的 new_parser 自带防环（MAX_XOBJECT_NESTING_DEPTH=64），
    实际主路径以它为准；这里同时守卫 PDFPageInterpreterEx（当前实际使用的子类）。
    pdf2zh 用 multiprocessing.Process 跑 babeldoc，Linux fork 启动方式会继承本补丁。
    """
    global _patch_applied_xobj
    with _patch_lock:
        if _patch_applied_xobj:
            return
        try:
            from babeldoc.format.pdf import pdfinterp as _ex_mod
            from babeldoc.pdfminer.pdfinterp import PDFPageInterpreter

            # 正常论文 XObject 嵌套约数层；给足余量又远低于递归上限
            max_depth = int(os.environ.get("PAPER_READER_MAX_XOBJ_DEPTH", "32"))
            PDFPageInterpreter.do_Do = _make_xobj_guard(PDFPageInterpreter.do_Do, max_depth)
            ex_cls = getattr(_ex_mod, "PDFPageInterpreterEx", None)
            if ex_cls is not None and "do_Do" in vars(ex_cls):
                ex_cls.do_Do = _make_xobj_guard(ex_cls.do_Do, max_depth)
            _patch_applied_xobj = True
        except Exception as exc:  # noqa: BLE001 - 补丁失败仅告警
            logging.getLogger(__name__).warning(
                "XObject 递归守卫补丁未生效（babeldoc 版本不兼容？）: %s", exc
            )


def _child_recursion_limit() -> int:
    """子进程递归深度上限（环境变量可覆盖）。"""
    return int(os.environ.get("PAPER_READER_BABEL_RECURSION", str(CHILD_RECURSION_LIMIT_DEFAULT)))


def _child_stack_bytes() -> int:
    """子进程新建线程的栈字节数（环境变量 MB 可覆盖）。"""
    mb = int(os.environ.get("PAPER_READER_BABEL_STACK_MB", str(CHILD_THREAD_STACK_MB_DEFAULT)))
    return mb * 1024 * 1024


def _wrap_child_entry(orig: Callable[..., Any]) -> Callable[..., Any]:
    """包装 pdf2zh 子进程入口：子进程内先放大线程栈与递归上限，再执行原入口。

    threading.stack_size 只影响之后新建的线程；子进程里 babeldoc 的执行器线程
    是在此之后才创建的，因此能生效。绝不能在父进程（uvicorn）里调用这两项。
    """
    if getattr(orig, "_pr_wrapped", False):
        return orig

    @functools.wraps(orig)
    def _child_entry(*args: Any, **kwargs: Any) -> Any:
        threading.stack_size(_child_stack_bytes())
        sys.setrecursionlimit(max(sys.getrecursionlimit(), _child_recursion_limit()))
        return orig(*args, **kwargs)

    _child_entry._pr_wrapped = True  # type: ignore[attr-defined]
    return _child_entry


def _short_path(path: str) -> str:
    """把绝对路径截成 site-packages/ 或 app/ 之后的相对路径，便于日志阅读。"""
    for marker in ("site-packages/", "/app/"):
        i = path.rfind(marker)
        if i >= 0:
            return path[i + len(marker):]
    return os.path.basename(path)


def _hotspot(exc: BaseException) -> str:
    """定位异常热点：RecursionError 取出现次数最多的帧，其他异常取最后一帧。"""
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return "未知位置"
    if isinstance(exc, RecursionError):
        counts = Counter((f.filename, f.lineno, f.name) for f in frames)
        (fn, ln, name), n = counts.most_common(1)[0]
        return f"{_short_path(fn)}:{ln} {name}（重复 {n} 次）"
    last = frames[-1]
    return f"{_short_path(last.filename)}:{last.lineno} {last.name}"


def _wrap_do_translate(orig: Callable[..., Any]) -> Callable[..., Any]:
    """包装 babeldoc.do_translate：异常时在子进程日志里打完整 traceback，并把热点位置写进异常消息。

    debug=False 时 babeldoc 不打 traceback，这里补上；消息改写失败不影响原异常抛出。
    """
    if getattr(orig, "_pr_wrapped", False):
        return orig
    log = logging.getLogger(__name__)

    @functools.wraps(orig)
    def _do_translate(*args: Any, **kwargs: Any) -> Any:
        try:
            return orig(*args, **kwargs)
        except Exception as exc:
            log.error(
                "BabelDOC do_translate 异常:\n%s",
                "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
            )
            try:
                loc = _hotspot(exc)
                if exc.args:
                    exc.args = (f"{exc.args[0]}（位置: {loc}）",) + tuple(exc.args[1:])
            except Exception:  # noqa: BLE001 - 改写失败忽略，保留原异常
                pass
            raise

    _do_translate._pr_wrapped = True  # type: ignore[attr-defined]
    return _do_translate


def _apply_child_runtime_patch() -> None:
    """给 pdf2zh 子进程入口与 babeldoc.do_translate 打补丁（幂等、线程安全）。

    必须在 translate_pdf_async 中、fork 子进程之前调用：fork 会继承替换后的模块属性。
    """
    global _patch_applied_child
    with _patch_lock:
        if _patch_applied_child:
            return
        try:
            from babeldoc.format.pdf import high_level as bd_hl
            from pdf2zh_next import high_level as p2z_hl

            p2z_hl._translate_wrapper = _wrap_child_entry(p2z_hl._translate_wrapper)
            bd_hl.do_translate = _wrap_do_translate(bd_hl.do_translate)
            _patch_applied_child = True
        except Exception as exc:  # noqa: BLE001 - 补丁失败仅告警
            logging.getLogger(__name__).warning(
                "子进程运行时补丁未生效（pdf2zh/babeldoc 版本不兼容？）: %s", exc
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

    from .library import is_valid_doc_id
    if not is_valid_doc_id(doc_id):
        raise RuntimeError("非法的文档 id")

    ok, reason = is_available()
    if not ok:
        raise RuntimeError(reason)

    # 跳过标题/参考文献（可在环境变量里关闭/自定义）
    _apply_skip_translation_patch()
    # XObject 循环引用/深嵌套守卫（防 RecursionError）
    _apply_xobj_recursion_guard()
    # 子进程递归上限/线程栈 + 异常热点定位（fork 前必须完成）
    _apply_child_runtime_patch()

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
    from .library import is_valid_doc_id
    if not is_valid_doc_id(doc_id):
        return None
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
