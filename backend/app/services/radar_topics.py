"""Paper-Code Radar Topic 配置服务。

Topic 真源为 settings 表（键 radar.topics），radar_topics 表为归档回溯的冗余镜像。
支持 YAML 批量导入/导出；导入时逐条校验，拒绝非法条目并保留合法条目。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from ..core.db import db

logger = logging.getLogger("radar.topics")

TOPICS_KEY = "radar.topics"
ENABLED_KEY = "radar.scheduler.enabled"

# Topic id 允许的字符（snake_case）
_ID_RE = re.compile(r"^[a-z0-9_]+$")
_MAX_TOPICS = 20


class TopicConfigError(ValueError):
    """Topic 配置非法（字段缺失、格式错误等）。"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_topic(raw: dict[str, Any], source: str) -> dict[str, Any]:
    """校验单个 Topic 定义，返回规整化后的副本。不合法时抛 TopicConfigError。

    source 用于报错提示（如 "YAML 第 3 条"）。
    """
    if not isinstance(raw, dict):
        raise TopicConfigError(f"{source}：必须是键值映射")
    tid = str(raw.get("id") or "").strip()
    name = str(raw.get("name") or "").strip()
    if not tid or not _ID_RE.match(tid):
        raise TopicConfigError(f"{source}（{tid or '无 id'}）：id 必须是非空 snake_case")
    if not name:
        raise TopicConfigError(f"{source}（{tid}）：缺少 name")

    def _str_list(v: Any, field: str) -> list[str]:
        if v is None:
            return []
        if not isinstance(v, list):
            raise TopicConfigError(f"{source}（{tid}）：{field} 必须是字符串数组")
        return [str(x).strip() for x in v if str(x).strip()]

    cats = _str_list(raw.get("categories"), "categories")
    kws = _str_list(raw.get("keywords"), "keywords")
    if not cats and not kws:
        raise TopicConfigError(f"{source}（{tid}）：categories 与 keywords 至少填一项")

    try:
        threshold = int(raw.get("min_score_to_show", 4))
    except (TypeError, ValueError):
        raise TopicConfigError(f"{source}（{tid}）：min_score_to_show 必须是 1~5 的整数")
    threshold = max(1, min(5, threshold))

    focus = str(raw.get("evaluation_focus") or "").strip()
    return {
        "id": tid,
        "name": name,
        "categories": cats,
        "keywords": [k.lower() for k in kws],
        "evaluation_focus": focus,
        "min_score_to_show": threshold,
    }


def _load_yaml(text: str) -> dict[str, Any]:
    """解析 YAML 文本。优先用 PyYAML，未安装时回退到内置极简解析器。"""
    try:
        import yaml  # type: ignore
    except ImportError:
        return _parse_simple_yaml(text)
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise TopicConfigError(f"YAML 语法错误：{e}") from e
    if not isinstance(data, dict):
        raise TopicConfigError("YAML 顶层必须是键值映射")
    return data


def _parse_simple_yaml(text: str) -> dict[str, Any]:
    """内置极简 YAML 解析器：仅覆盖本模块导出格式（topics 列表 + 标量/字符串数组）。

    支持 flow 风格（keywords: ["a", "b"]）与块风格（keywords: 换行 - a）；
    块数组项靠「缩进深于所属 topic 条目」识别，不会误判为新 Topic。
    依赖项说明：PyYAML 非 requirements 必选依赖，这里保证零依赖也能导入/导出。
    """
    topics: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    cur_indent = 0          # 当前 topic 条目（"- " 行）的缩进
    pending_key = ""
    pending_val: list[str] = []

    def flush_list() -> None:
        nonlocal pending_key, pending_val
        if cur is not None and pending_key:
            cur[pending_key] = pending_val
        pending_key, pending_val = "", []

    for raw_line in text.splitlines():
        stripped = raw_line.split("#", 1)[0].rstrip()
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip())
        line = stripped.strip()

        if indent == 0:
            # 顶层键：topics: —— 直接忽略（其余顶层键不支持）
            flush_list()
            cur = None
            continue
        if line.startswith("- "):
            if cur is not None and pending_key and indent > cur_indent:
                # 块数组项（如 keywords: 下的 "- item"），不是新 Topic
                pending_val.append(line[2:].strip().strip('"\''))
                continue
            flush_list()
            cur = {}
            cur_indent = indent
            topics.append(cur)
            line = line[2:].strip()
            if not line:
                continue
            # "- id: xxx" 形式：第一个键值对直接落在当前条目上
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if not val:
            # 块数组的开始（如 keywords: 换行后跟 - item）
            flush_list()
            if cur is not None:
                pending_key = key
            continue
        flush_list()
        if cur is None:
            continue
        if val.startswith("[") and val.endswith("]"):
            items = [x.strip().strip('"\'') for x in val[1:-1].split(",") if x.strip()]
            cur[key] = items
        else:
            cur[key] = val.strip('"\'')
    flush_list()
    return {"topics": topics}


def get_topics() -> list[dict[str, Any]]:
    """读取全部 Topic 配置（已规整化）。"""
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (TOPICS_KEY,)).fetchone()
    if not row or not row["value"]:
        return []
    try:
        data = json.loads(row["value"])
    except Exception:  # noqa: BLE001
        logger.warning("radar.topics 配置损坏，已重置为空")
        return []
    result: list[dict[str, Any]] = []
    for i, raw in enumerate(data if isinstance(data, list) else []):
        try:
            result.append(_validate_topic(raw, f"已存配置第 {i + 1} 条"))
        except TopicConfigError as e:
            logger.warning("跳过非法 Topic： %s", e)
    return result


def set_topics(topics: list[dict[str, Any]], sync_mirror: bool = True) -> list[dict[str, Any]]:
    """整体替换 Topic 配置，返回规整化后的列表。"""
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, raw in enumerate(topics):
        t = _validate_topic(raw, f"第 {i + 1} 条")
        if t["id"] in seen:
            raise TopicConfigError(f"第 {i + 1} 条：id 重复（{t['id']}）")
        seen.add(t["id"])
        cleaned.append(t)
    if len(cleaned) > _MAX_TOPICS:
        raise TopicConfigError(f"Topic 数量超过上限 {_MAX_TOPICS}")

    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (TOPICS_KEY, json.dumps(cleaned, ensure_ascii=False)),
        )
        if sync_mirror:
            _sync_mirror(conn, cleaned)
    return cleaned


def _sync_mirror(conn: Any, cleaned: list[dict[str, Any]]) -> None:
    """把规整化后的 Topic 同步到 radar_topics 镜像表（归档回溯用）。"""
    now = _now_iso()
    keep = {t["id"] for t in cleaned}
    for t in cleaned:
        conn.execute(
            "INSERT INTO radar_topics (id, name, config, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, config=excluded.config,"
            " updated_at=excluded.updated_at",
            (t["id"], t["name"], json.dumps(t, ensure_ascii=False), now),
        )
    for row in conn.execute("SELECT id FROM radar_topics").fetchall():
        if row["id"] not in keep:
            # 删除 Topic 只摘镜像，历史 radar_papers 保留（SRS §3.1）
            conn.execute("DELETE FROM radar_topics WHERE id=?", (row["id"],))


def import_yaml(text: str) -> dict[str, int]:
    """YAML 批量导入。逐条校验：非法条目拒绝并计数，合法条目合并保存。

    返回 {imported, rejected, total}。id 相同的条目视为更新。
    """
    data = _load_yaml(text)
    raw_topics = data.get("topics")
    if raw_topics is None:
        raise TopicConfigError("YAML 中缺少 topics 列表")
    if not isinstance(raw_topics, list):
        raise TopicConfigError("topics 必须是列表")

    existing = {t["id"]: t for t in get_topics()}
    errors: list[str] = []
    merged: dict[str, dict[str, Any]] = dict(existing)
    total = len(raw_topics)

    for i, raw in enumerate(raw_topics):
        try:
            t = _validate_topic(raw, f"YAML 第 {i + 1} 条")
            merged[t["id"]] = t
        except TopicConfigError as e:
            errors.append(str(e))

    # 合并后超上限时整体拒绝，避免部分写入造成不可预期状态
    if len(merged) > _MAX_TOPICS:
        raise TopicConfigError(f"导入后 Topic 总数（{len(merged)}）超过上限 {_MAX_TOPICS}，本次导入未生效")

    set_topics(list(merged.values()), sync_mirror=bool(merged))
    return {"imported": total - len(errors), "rejected": len(errors), "total": total}


def export_yaml() -> str:
    """导出 YAML 格式配置（与导入格式对称）。"""
    topics = get_topics()
    lines: list[str] = ["topics:"]
    for t in topics:
        lines.append(f"  - id: \"{t['id']}\"")
        lines.append(f"    name: \"{t['name']}\"")
        cats = ", ".join(f'"{c}"' for c in t["categories"])
        lines.append(f"    categories: [{cats}]")
        kws = ", ".join(f'"{k}"' for k in t["keywords"])
        lines.append(f"    keywords: [{kws}]")
        focus = t["evaluation_focus"].replace('"', "'")
        lines.append(f"    evaluation_focus: \"{focus}\"")
        lines.append(f"    min_score_to_show: {t['min_score_to_show']}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def is_scheduler_enabled() -> bool:
    """雷达调度开关（与 digest v1 调度相互独立）。"""
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (ENABLED_KEY,)).fetchone()
    if not row or not row["value"]:
        return True
    try:
        return bool(json.loads(row["value"]).get("enabled", True))
    except Exception:  # noqa: BLE001
        return True


def set_scheduler_enabled(enabled: bool) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (ENABLED_KEY, json.dumps({"enabled": bool(enabled)})),
        )
