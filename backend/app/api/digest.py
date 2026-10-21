"""每日情报雷达 (Daily Intelligence) API 路由。"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import digest

router = APIRouter(prefix="/digest", tags=["digest"])


class ActionReq(BaseModel):
    action: str  # 'ignore' | 'import'


class ConfigReq(BaseModel):
    topics: list[str]
    scheduler_enabled: bool | None = None


@router.get("/today")
def get_today_digest() -> dict[str, Any]:
    """获取今日情报。若今日尚未生成，则触发一次抓取。"""
    try:
        return digest.generate_daily_digest(force=False)
    except Exception as e:
        raise HTTPException(500, f"获取今日情报失败: {e}") from e


@router.get("/archive")
def get_archive_digest(date: str) -> dict[str, Any]:
    """回溯查看往期历史情报。"""
    items = digest.get_digest_by_date(date)
    return {
        "date": date,
        "items": items,
        "counts": {
            "arxiv": sum(1 for x in items if x["source"] == "arxiv"),
            "github": sum(1 for x in items if x["source"] == "github"),
        },
    }


@router.post("/refresh")
def refresh_today_digest() -> dict[str, Any]:
    """手动强制重新抓取并更新今日情报。"""
    try:
        return digest.generate_daily_digest(force=True)
    except Exception as e:
        raise HTTPException(500, f"刷新今日情报失败: {e}") from e


@router.post("/{item_id:path}/action")
def act_on_item(item_id: str, body: ActionReq) -> dict[str, Any]:
    """对推荐卡片进行操作（ignore 忽略拉黑，import 标记已入库）。"""
    ok = digest.act_on_digest_item(item_id, body.action)
    if not ok:
        raise HTTPException(400, "操作失败或无效的 action 类型")
    return {"ok": True, "id": item_id, "action": body.action}


@router.post("/{item_id:path}/import-paper")
def import_paper(item_id: str) -> dict[str, Any]:
    """直接将 arXiv 推荐条目一键导入本地文献库并触发双语排版队列。"""
    try:
        doc = digest.import_arxiv_item(item_id)
        return {"ok": True, "document": doc}
    except Exception as e:
        raise HTTPException(500, f"导入文献失败: {e}") from e


@router.get("/config")
def get_config() -> dict[str, Any]:
    """获取当前关注的主题列表与定时调度状态。"""
    return {
        "topics": digest.get_topics(),
        "scheduler_enabled": digest.is_scheduler_enabled(),
    }


@router.post("/config")
def update_config(body: ConfigReq) -> dict[str, Any]:
    """更新关注主题列表与定时调度状态。"""
    topics = digest.set_topics(body.topics)
    if body.scheduler_enabled is not None:
        digest.set_scheduler_enabled(body.scheduler_enabled)
    return {
        "ok": True,
        "topics": topics,
        "scheduler_enabled": digest.is_scheduler_enabled(),
    }
