"""解析与翻译 API。"""
from __future__ import annotations

import threading
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from ..core.config import get_settings
from ..services import engines as engines_svc
from ..services import library, mineru, parser, translate

router = APIRouter()

# 后台解析任务的进度（进程内，单用户够用）
_progress: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _set_progress(doc_id: str, **kw: Any) -> None:
    with _lock:
        _progress.setdefault(doc_id, {})
        _progress[doc_id].update(kw)


class ParseReq(BaseModel):
    engine: str = "auto"  # auto | mineru | local


class RetranslateReq(BaseModel):
    """重翻请求。

    mode:
      - clear   仅清除译文缓存
      - retranslate  清除后立即重翻（同步返回，前端已支持分批）
    engine: 指定引擎，空则按优先级自动
    """
    mode: str = "clear"
    engine: str | None = None
    limit: int | None = None   # 仅重翻前 N 段，便于快速尝试验证


class TranslateReq(BaseModel):
    segment_ids: list[str]
    force: bool = False
    engine: str | None = None   # 指定引擎；空则按优先级自动降级


class AIConfigReq(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    temperature: float | None = None


class GlossaryReq(BaseModel):
    glossary: dict[str, str]


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

def _run_mineru(doc_id: str, task_id: str) -> None:
    """后台轮询 MinerU 任务直到完成，然后把结果落成 segments。"""
    import time

    try:
        for _ in range(600):  # 最多等 30 分钟
            state, progress, err = mineru.get_state(task_id)
            _set_progress(doc_id, state=state, progress=progress, error=err)
            if state == "done":
                n = parser.finalize_mineru(doc_id, task_id)
                _set_progress(doc_id, state="done", progress=100,
                              segments=n, error=None)
                return
            if state == "failed":
                parser.set_parse_status(doc_id, "failed")
                return
            time.sleep(3)
        parser.set_parse_status(doc_id, "failed")
        _set_progress(doc_id, state="failed", error="解析超时")
    except Exception as e:  # noqa: BLE001
        parser.set_parse_status(doc_id, "failed")
        _set_progress(doc_id, state="failed", error=str(e))


@router.post("/{doc_id}/parse")
def start_parse(doc_id: str, body: ParseReq, bg: BackgroundTasks) -> dict[str, Any]:
    doc = library.get_document(doc_id)
    if not doc:
        raise HTTPException(404, "文献不存在")
    pdf = library.pdf_path_of(doc_id)
    if not pdf:
        raise HTTPException(404, "PDF 文件缺失")

    has_token = bool(get_settings().mineru_token.strip())
    engine = body.engine
    if engine == "auto":
        engine = "mineru" if has_token else "local"
    if engine == "mineru" and not has_token:
        raise HTTPException(400, "未配置 MINERU_TOKEN，请改用 engine=local 或在 .env 填写")

    if engine == "local":
        _set_progress(doc_id, state="running", progress=30, error=None)
        try:
            n = parser.parse_local_and_save(doc_id, pdf)
        except Exception as e:  # noqa: BLE001
            _set_progress(doc_id, state="failed", progress=0, error=str(e))
            raise HTTPException(500, f"本地解析失败：{e}") from e
        _set_progress(doc_id, state="done", progress=100, segments=n, error=None)
        return {"engine": "local", "segments": n, "state": "done"}

    # MinerU
    try:
        info = parser.parse_with_mineru(doc_id, pdf)
    except mineru.MinerUError as e:
        parser.set_parse_status(doc_id, "failed")
        raise HTTPException(502, str(e)) from e

    _set_progress(doc_id, state="pending", progress=10, error=None, task_id=info["task_id"])
    bg.add_task(_run_mineru, doc_id, info["task_id"])
    return {"engine": "mineru", "state": "pending", "task_id": info["task_id"]}


@router.get("/{doc_id}/parse/progress")
def parse_progress(doc_id: str) -> dict[str, Any]:
    with _lock:
        p = dict(_progress.get(doc_id) or {})
    if not p:
        doc = library.get_document(doc_id)
        return {"state": doc.get("parse_status", "pending") if doc else "unknown",
                "progress": 0, "segments": 0}
    return p


@router.get("/{doc_id}/segments")
def get_segments(doc_id: str) -> dict[str, Any]:
    doc = library.get_document(doc_id)
    if not doc:
        raise HTTPException(404, "文献不存在")
    segs = parser.list_segments(doc_id)
    return {
        "document_id": doc_id,
        "count": len(segs),
        "cached_translations": translate.cached_count(doc_id),
        "segments": segs,
    }


# ---------------------------------------------------------------------------
# 翻译
# ---------------------------------------------------------------------------

@router.post("/{doc_id}/translate")
def translate_segments(doc_id: str, body: TranslateReq) -> dict[str, Any]:
    if not library.get_document(doc_id):
        raise HTTPException(404, "文献不存在")
    results, errors = [], []
    for sid in body.segment_ids:
        try:
            results.append(translate.translate_segment(
                doc_id, sid, force=body.force, engine=body.engine))
        except ValueError as e:
            errors.append({"segment_id": sid, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            errors.append({"segment_id": sid, "error": str(e)})
    return {"results": results, "errors": errors}


@router.post("/{doc_id}/retranslate")
def retranslate_document(doc_id: str, body: RetranslateReq) -> dict[str, Any]:
    """清除该文档译文缓存，可选立即重翻。

    标注完全不受影响：标注锚定在 segments 上，与 translations 无耦合。
    """
    if not library.get_document(doc_id):
        raise HTTPException(404, "文献不存在")
    if body.mode not in ("clear", "retranslate"):
        raise HTTPException(400, "mode 只能是 clear 或 retranslate")

    cleared = translate.clear_document_translations(doc_id)

    if body.mode == "clear":
        return {"ok": True, "mode": "clear", "cleared": cleared, "translated": 0}

    # 立即重翻：取需要翻译的段落
    segs = parser.list_segments(doc_id)
    targets = [x["id"] for x in segs if x["kind"] in translate.TRANSLATABLE]
    if body.limit is not None:
        targets = targets[: max(0, body.limit)]
    if not targets:
        return {"ok": True, "mode": "retranslate", "cleared": cleared,
                "translated": 0, "note": "没有可翻译的段落"}

    results, errors = [], []
    for sid in targets:
        try:
            results.append(translate.translate_segment(doc_id, sid, engine=body.engine))
        except Exception as e:  # noqa: BLE001
            errors.append({"segment_id": sid, "error": str(e)[:200]})
            # 连续失败就停，避免刷爆限流
            if len(errors) >= 3:
                break

    return {
        "ok": True,
        "mode": "retranslate",
        "cleared": cleared,
        "translated": len(results),
        "failed": len(errors),
        "errors": errors[:3],
    }


@router.post("/retranslate/all")
def clear_all_translations() -> dict[str, Any]:
    """清除全部文献的译文缓存（用于统一刷新翻译质量）。"""
    n = translate.clear_all_translations()
    return {"ok": True, "cleared": n}


# ---------------------------------------------------------------------------
# AI 配置与术语表
# ---------------------------------------------------------------------------

@router.get("/config/ai")
def read_ai_config() -> dict[str, Any]:
    cfg = translate.get_ai_config()
    key = cfg.get("api_key") or ""
    return {
        "base_url": cfg.get("base_url", ""),
        "model": cfg.get("model", ""),
        "temperature": cfg.get("temperature", 0.3),
        "api_key_set": bool(key),
        "api_key_masked": (key[:4] + "…" + key[-4:]) if len(key) >= 8 else ("已设置" if key else ""),
    }


@router.post("/config/ai")
def write_ai_config(body: AIConfigReq) -> dict[str, Any]:
    translate.save_ai_config(body.model_dump(exclude_none=True))
    return {"ok": True}


@router.get("/config/glossary")
def read_glossary() -> dict[str, Any]:
    return {"glossary": translate.get_glossary()}


@router.post("/config/glossary")
def write_glossary(body: GlossaryReq) -> dict[str, Any]:
    translate.save_glossary(body.glossary)
    return {"ok": True, "count": len(body.glossary)}


@router.get("/config/ai/probe")
def probe_ai_endpoint() -> dict[str, Any]:
    """快速探活 AI 端点（8 秒超时）。前端在长任务前调用。"""
    return translate.probe_ai(timeout=8)


@router.get("/config/engines")
def available_engines() -> dict[str, Any]:
    s = get_settings()
    cfg = translate.get_ai_config()
    return {
        "mineru_configured": bool(s.mineru_token.strip()),
        "mineru_model": s.mineru_model,
        "ai_configured": bool(cfg.get("base_url") and cfg.get("api_key")),
        "local_fallback": True,
    }


# ---------------------------------------------------------------------------
# 翻译引擎管理
# ---------------------------------------------------------------------------

class EngineConfigReq(BaseModel):
    enabled: bool | None = None
    appid: str | None = None
    appkey: str | None = None
    domain: str | None = None
    endpoint: str | None = None
    region: str | None = None


class EngineOrderReq(BaseModel):
    order: list[str]


def _mask(v: str | None) -> str:
    if not v:
        return ""
    if len(v) <= 6:
        return "已设置"
    return v[:3] + "…" + v[-3:]


@router.get("/engines")
def list_engines() -> dict[str, Any]:
    return {"engines": engines_svc.available_engines()}


@router.post("/engines/order")
def set_engine_order(body: EngineOrderReq) -> dict[str, Any]:
    known = set(engines_svc.ENGINES.keys())
    order = [x for x in body.order if x in known]
    engines_svc.set_engine_order(order)
    return {"ok": True, "order": order}


@router.post("/engines/{name}/config")
def set_engine_config(name: str, body: EngineConfigReq) -> dict[str, Any]:
    if name not in engines_svc.ENGINES:
        raise HTTPException(404, "未知引擎")
    raw = body.model_dump(exclude_none=True)
    engines_svc.save_engine_config(name, raw)
    return {"ok": True}


@router.post("/engines/{name}/test")
def test_engine(name: str) -> dict[str, Any]:
    if name not in engines_svc.ENGINES:
        raise HTTPException(404, "未知引擎")
    return engines_svc.test_engine(name)


@router.get("/engines/{name}/config")
def read_engine_config(name: str) -> dict[str, Any]:
    """读取引擎配置（密钥掩码返回）。"""
    if name not in engines_svc.ENGINES:
        raise HTTPException(404, "未知引擎")
    cfg = engines_svc.get_engine_config(name)
    safe = {k: v for k, v in cfg.items() if k in ("enabled", "domain", "endpoint", "region")}
    safe["appid_set"] = bool(cfg.get("appid"))
    safe["appkey_set"] = bool(cfg.get("appkey"))
    safe["appid_masked"] = _mask(cfg.get("appid"))
    safe["appkey_masked"] = _mask(cfg.get("appkey"))
    return safe
