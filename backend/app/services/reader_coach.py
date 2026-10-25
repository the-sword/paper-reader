"""领读教练会话服务（方案 C：静态速读卡 + 按目标精读会话）。

设计见 docs/socratic-reader-ui.svg：
  - 速读卡由 socratic_card 一次性生成、可缓存，打开即看；
  - 本模块负责卡片下方的多轮精读会话：读者选一个目标（组会/复现/
    综述/项目评估/快速了解），教练按对应路线分阶段带读——
    结构拆解 → 方法/图表三问 → 论证链评估 → 批判 → 费曼复述纠偏。
  - 每轮会话的 system 注入完整正文语料与目标路线；历史消息落库，
    关闭再开可续读。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ..core.db import db
from . import summarize as sum_svc

# 阅读目标 → 领读路线（对应 PaperSocratic Reader 阶段 2 的分流表）
GOALS: dict[str, dict[str, str]] = {
    "quick": {
        "label": "快速了解",
        "route": "速读卡要点回顾 + 3 个关键点 + 是否值得精读的判断；不展开逐阶段拆解",
    },
    "group": {
        "label": "组会汇报",
        "route": "论证链 → 「一张图讲清」挑选 → 听众最可能问的 3 个问题 → 三分钟复述演练",
    },
    "reproduce": {
        "label": "方法复现",
        "route": "方法拆解 → 关键公式逐个过 → 实现依赖（数据/超参/代码）→ 复现风险点",
    },
    "survey": {
        "label": "写综述",
        "route": "与哪些工作对话 → 贡献边界 → 可引用句 → 在本领域谱系中的位置",
    },
    "project": {
        "label": "项目评估",
        "route": "适用条件 → 失败模式 → 部署成本（算力/延迟/依赖）→ 值不值得引入",
    },
}

# 历史消息窗口：正文在 system 里常驻，对话只保留最近若干轮控制上下文体积
_HISTORY_LIMIT = 16


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _system_prompt(goal: str, corpus: str) -> str:
    g = GOALS[goal]
    return (
        "你是一名严谨的论文领读教练（PaperSocratic Reader）。"
        "你的任务不是替读者读完并总结，而是带他从「看懂字面」走到"
        "「看懂论证、能判断、能复述、能使用」。\n\n"
        "会话规则：\n"
        "1. 这是多轮短对话：每轮只推进当前阶段，不要把全文一次性倒出；"
        "每轮结尾给 1-2 个精读追问或复述任务，等读者回应后再推进。\n"
        "2. 读者可随时打断提问、跳过阶段、或切换目标；切换后按新目标路线继续。\n"
        "3. 阶段顺序：速读卡回顾 → 结构拆解（问题→缺口→方法→证据→结论→局限）"
        "→ 方法与关键图表三问（这张图想证明什么？证据强不强？有无替代解释？）"
        "→ 论证链评估（「因为A所以B」逐步标证据强度、指出最薄弱一环）"
        "→ 批判点与替代解释 → 三分钟费曼复述（请读者填空复述，你来纠偏）。\n"
        f"4. 读者目标：{g['label']}。对应路线侧重：{g['route']}。\n\n"
        + sum_svc._SOCRATIC_RULES
        + "\n\n论文内容（图表以「[图] 图注」「[表格]」标记呈现，信息不足处写「论文未提供」）：\n"
        + corpus
    )


def _load_session(session_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM reader_sessions WHERE id=?", (session_id,)
        ).fetchone()
    return dict(row) if row else None


def _history(session_id: str, limit: int = _HISTORY_LIMIT) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """SELECT role, content, created_at FROM reader_messages
               WHERE session_id=? ORDER BY id DESC LIMIT ?""",
            (session_id, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def _append_message(session_id: str, role: str, content: str) -> None:
    with db() as conn:
        conn.execute(
            """INSERT INTO reader_messages (session_id, role, content, created_at)
               VALUES (?,?,?,?)""",
            (session_id, role, content, _now()),
        )


def create_session(doc_id: str, goal: str) -> dict[str, Any]:
    """建会话并生成开场回复（教练按目标路线带第一轮）。"""
    if goal not in GOALS:
        raise ValueError(f"未知的阅读目标：{goal}")
    sid = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            """INSERT INTO reader_sessions (id, document_id, goal, created_at)
               VALUES (?,?,?,?)""",
            (sid, doc_id, goal, _now()),
        )
    kickoff = (
        f"我的阅读目标是「{GOALS[goal]['label']}」。"
        "请按对应路线带我精读这篇论文，先回顾速读卡再进入第一个阶段。"
    )
    reply = _turn(sid, doc_id, goal, kickoff)
    return {"session_id": sid, "goal": goal, "reply": reply}


def _turn(session_id: str, doc_id: str, goal: str, user_text: str) -> str:
    corpus, _chars = sum_svc._build_corpus(doc_id)
    _append_message(session_id, "user", user_text)
    history = _history(session_id)
    messages = [{"role": "system", "content": _system_prompt(goal, corpus)}]
    messages += [{"role": m["role"], "content": m["content"]} for m in history]
    res = sum_svc._call_ai(messages)
    reply = res["content"]
    _append_message(session_id, "assistant", reply)
    return reply


def chat(doc_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """会话入口：无 session_id 且带 goal → 建会话；带 session_id+message → 续聊。"""
    session_id = body.get("session_id")
    if not session_id:
        goal = body.get("goal") or "quick"
        return create_session(doc_id, goal)

    sess = _load_session(session_id)
    if not sess or sess["document_id"] != doc_id:
        raise ValueError("会话不存在")
    message = (body.get("message") or "").strip()
    if not message:
        raise ValueError("消息不能为空")
    if len(message) > 4000:
        raise ValueError("消息过长")
    reply = _turn(session_id, doc_id, sess["goal"], message)
    return {"session_id": session_id, "goal": sess["goal"], "reply": reply}


def list_sessions(doc_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """SELECT id, goal, created_at FROM reader_sessions
               WHERE document_id=? ORDER BY created_at DESC""",
            (doc_id,),
        ).fetchall()
    return [
        {**dict(r), "messages": _history(r["id"], limit=500)} for r in rows
    ]


def delete_session(session_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM reader_sessions WHERE id=?", (session_id,))
