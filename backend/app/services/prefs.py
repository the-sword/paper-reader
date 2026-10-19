"""界面偏好设置。

与「AI 配置」「引擎配置」不同，这里存的是纯前端行为偏好，
例如翻译模式（自动/手动）、显示模式等。

统一放在 settings 表的 `ui.` 前缀下，值为 JSON。
"""
from __future__ import annotations

import json
from typing import Any

from ..core.db import db

PREFIX = "ui."

# 允许的偏好键与默认值。白名单避免任意写入。
DEFAULTS: dict[str, Any] = {
    "translate_mode": "auto",     # auto | manual
    "reading_mode": "bilingual",  # source | bilingual | zh
    "selected_engine": "",        # 空表示自动
}


def _key(name: str) -> str:
    return PREFIX + name


def get_all() -> dict[str, Any]:
    """返回全部偏好（缺失项用默认值补齐）。"""
    out = dict(DEFAULTS)
    with db() as conn:
        rows = conn.execute(
            "SELECT key, value FROM settings WHERE key LIKE ?", (PREFIX + "%",)
        ).fetchall()
    for r in rows:
        name = r["key"][len(PREFIX):]
        if name not in DEFAULTS:
            continue
        try:
            out[name] = json.loads(r["value"])
        except Exception:
            pass
    return out


def set_many(values: dict[str, Any]) -> dict[str, Any]:
    """批量更新。只接受白名单内的键，未知键忽略。"""
    with db() as conn:
        for name, val in values.items():
            if name not in DEFAULTS:
                continue
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (_key(name), json.dumps(val, ensure_ascii=False)),
            )
    return get_all()
