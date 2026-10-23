"""Paper-Code Radar API 路由（挂载于 /api/radar/*，走阅读器统一鉴权）。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from ..services import radar, radar_topics

router = APIRouter(prefix="/radar", tags=["radar"])


class TopicsReq(BaseModel):
    topics: list[dict[str, Any]]
    scheduler_enabled: bool | None = None


class YamlImportReq(BaseModel):
    text: str


class ActionReq(BaseModel):
    action: str  # 'ignore' | 'import'


@router.get("/today")
def get_today() -> dict[str, Any]:
    """今日各 Topic 入选条目（分组返回）。不自动触发抓取，避免看板打开即烧 LLM。"""
    try:
        from ..services.radar import _today_bj
        grouped = radar.get_day(_today_bj())
        return {"date": _today_bj(), "topics": grouped,
                "total": sum(len(v) for v in grouped.values())}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"获取今日情报失败: {e}") from e


@router.post("/refresh")
def refresh() -> dict[str, Any]:
    """立即执行一轮完整管道（抓取→初筛→评审→归档）。耗时较长（含 LLM 调用）。"""
    try:
        return radar.run_pipeline(force=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"刷新失败: {e}") from e


@router.get("/archive")
def get_archive(date: str) -> dict[str, Any]:
    """回溯查看往期入选条目（按北京日期）。"""
    try:
        grouped = radar.get_day(date)
        return {"date": date, "topics": grouped,
                "total": sum(len(v) for v in grouped.values())}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"查询归档失败: {e}") from e


@router.get("/search")
def search(
    q: str = "",
    topic_id: str | None = None,
    code_status: str | None = None,
    min_score: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """FTS5 关键词 + 多维筛选检索（语义向量检索为二期）。"""
    try:
        items = radar.search_papers(
            q=q, topic_id=topic_id, code_status=code_status,
            min_score=min_score, date_from=date_from, date_to=date_to, limit=limit,
        )
        return {"total": len(items), "items": items}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"检索失败: {e}") from e


@router.get("/config")
def get_config() -> dict[str, Any]:
    """读取 Topics + 调度状态。"""
    return {
        "topics": radar_topics.get_topics(),
        "scheduler_enabled": radar_topics.is_scheduler_enabled(),
    }


@router.post("/config")
def update_config(body: TopicsReq) -> dict[str, Any]:
    """整体替换 Topics（UI 编辑器提交）。"""
    try:
        topics = radar_topics.set_topics(body.topics)
    except radar_topics.TopicConfigError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"保存配置失败: {e}") from e
    if body.scheduler_enabled is not None:
        radar_topics.set_scheduler_enabled(body.scheduler_enabled)
    return {"ok": True, "topics": topics,
            "scheduler_enabled": radar_topics.is_scheduler_enabled()}


@router.post("/config/import")
def import_yaml(body: YamlImportReq) -> dict[str, Any]:
    """YAML 批量导入（非法条目拒绝，合法条目合并保存）。"""
    try:
        result = radar_topics.import_yaml(body.text)
    except radar_topics.TopicConfigError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"导入失败: {e}") from e
    return {"ok": True, **result, "topics": radar_topics.get_topics()}


@router.get("/config/export", response_class=PlainTextResponse)
def export_yaml() -> str:
    """导出 YAML 格式配置。"""
    return radar_topics.export_yaml()


@router.post("/{paper_id:path}/action")
def act_on_paper(paper_id: str, body: ActionReq) -> dict[str, Any]:
    """ignore / import 用户动作（永久防重）。"""
    ok = radar.act_on_paper(paper_id, body.action)
    if not ok:
        raise HTTPException(400, "操作失败或无效的 action 类型")
    return {"ok": True, "id": paper_id, "action": body.action}


@router.post("/{paper_id:path}/import-paper")
def import_paper(paper_id: str) -> dict[str, Any]:
    """导入阅读器文献库并触发双语排版队列。"""
    try:
        doc = radar.import_paper(paper_id)
        return {"ok": True, "document": doc}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"导入文献失败: {e}") from e


@router.get("/{paper_id:path}/bibtex", response_class=PlainTextResponse)
def get_bibtex(paper_id: str) -> str:
    """生成标准 BibTeX。"""
    try:
        return radar.bibtex_for(paper_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"生成 BibTeX 失败: {e}") from e


@router.get("/stats")
def get_stats() -> dict[str, Any]:
    """Topic 维度统计 + LLM 用量。"""
    try:
        return radar.stats()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"统计失败: {e}") from e
