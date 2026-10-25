"""Paper-Code Radar API 路由（挂载于 /api/radar/*，走阅读器统一鉴权）。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from ..services import jobs as jobs_svc
from ..services import radar, radar_topics
from ..services.arxiv_taxonomy import get_cached_taxonomy, sync_taxonomy
from ..services.radar import PipelineBusyError

router = APIRouter(prefix="/radar", tags=["radar"])


class TopicsReq(BaseModel):
    topics: list[dict[str, Any]]
    scheduler_enabled: bool | None = None


class YamlImportReq(BaseModel):
    text: str


class ActionReq(BaseModel):
    action: str  # import | block | dismiss | save | unsave | restore（兼容 ignore）


def _day_payload(date_str: str, grouped: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """看板响应的公共部分：论文分组 + 独立开源项目 + 空日兜底元数据 + 当日成本。"""
    repos = radar.get_day_repos(date_str)
    return {
        "date": date_str,
        "topics": grouped,
        "total": sum(len(v) for v in grouped.values()),
        "repos": repos,
        "repos_total": len(repos),
        "is_posting_day": radar.is_posting_day(date_str),
        "prev_date": radar.latest_day_with_papers(before=date_str),
        "usage": radar.day_usage(date_str),
    }


@router.get("/today")
def get_today() -> dict[str, Any]:
    """今日各 Topic 入选条目（分组返回）。不自动触发抓取，避免看板打开即烧 LLM。"""
    try:
        from ..services.radar import _today_bj
        return _day_payload(_today_bj(), radar.get_day(_today_bj()))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"获取今日情报失败: {e}") from e


@router.post("/refresh")
def refresh() -> dict[str, Any]:
    """启动一轮完整管道（抓取→初筛→评审→归档）后台任务，立即返回 job_id。"""
    try:
        job = radar.start_pipeline_job(force=True)
    except PipelineBusyError as e:
        # 并发刷新是请求冲突，不是服务端错误
        raise HTTPException(409, str(e)) from e
    return {"job_id": job.id, "status": job.status}


@router.get("/pipeline/{job_id}")
def pipeline_job(job_id: str) -> dict[str, Any]:
    """查询管道任务进度（running/done/failed/cancelled）。"""
    job = jobs_svc.get(job_id)
    if not job:
        raise HTTPException(404, "任务不存在或已过期")
    return job.to_dict()


@router.post("/pipeline/{job_id}/cancel")
def cancel_pipeline(job_id: str) -> dict[str, Any]:
    """取消运行中的管道任务。"""
    if not jobs_svc.cancel(job_id):
        raise HTTPException(400, "取消失败（任务不存在或已结束）")
    return {"ok": True}


@router.get("/archive")
def get_archive(date: str) -> dict[str, Any]:
    """回溯查看往期入选条目（按北京日期）。"""
    try:
        return _day_payload(date, radar.get_day(date))
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


@router.get("/config/arxiv-categories")
def arxiv_categories() -> dict[str, Any]:
    """远端同步的 arXiv 分类清单（id → 英文名），供分类选择器补充新分类。

    缓存超 30 天时顺带触发一次后台同步（不阻塞响应）。
    """
    cached = get_cached_taxonomy()
    from datetime import datetime, timezone
    stale = True
    if cached["synced_at"]:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(cached["synced_at"])
            stale = age.total_seconds() >= 30 * 86400
        except ValueError:
            pass
    if stale:
        import threading
        threading.Thread(target=sync_taxonomy, kwargs={"force": False},
                         name="radar-taxonomy-sync", daemon=True).start()
    return {"synced_at": cached["synced_at"], "categories": cached["categories"]}


@router.get("/config/export", response_class=PlainTextResponse)
def export_yaml() -> str:
    """导出 YAML 格式配置。"""
    return radar_topics.export_yaml()


@router.post("/{paper_id:path}/action")
def act_on_paper(paper_id: str, body: ActionReq) -> dict[str, Any]:
    """收件箱动作：论文与开源项目共用（github: 前缀路由到仓库条目）。"""
    if paper_id.startswith("github:"):
        ok = radar.act_on_repo(paper_id, body.action)
    else:
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
