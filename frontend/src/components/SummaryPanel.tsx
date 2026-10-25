/**
 * AI 总结面板。
 *
 * 交互原则：**完全手动触发**
 *   - 打开标签页只读取类型列表与历史记录，不发起任何 AI 调用
 *   - 只有点击「生成总结」才启动任务
 *   - 任务在后端独立线程执行，可随时「取消」
 *
 * 流程：
 *   startSummary → 轮询 job 状态 → done 后写入当前视图并刷新历史
 */
import { useEffect, useRef, useState } from 'react'
import { api, type ReaderGoal, type ReaderSession, type SummaryItem, type SummaryKind } from '../api/client'
import { useStore } from '../stores/useStore'
import MarkdownView from './MarkdownView'

const POLL_MS = 900

export default function SummaryPanel() {
  const currentDoc = useStore((s) => s.currentDoc)
  const [kinds, setKinds] = useState<SummaryKind[]>([])
  const [activeKind, setActiveKind] = useState('overview')
  const [question, setQuestion] = useState('')

  const [jobId, setJobId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [history, setHistory] = useState<SummaryItem[]>([])
  const [current, setCurrent] = useState<SummaryItem | null>(null)
  const [showMoreKinds, setShowMoreKinds] = useState(false)

  // ---- 领读教练会话（方案 C：速读卡下方的按目标精读） ----
  const [goals, setGoals] = useState<ReaderGoal[]>([])
  const [sessions, setSessions] = useState<ReaderSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [coachError, setCoachError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  const timerRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    void api.summaryKinds().then((r) => setKinds(r.kinds)).catch(() => {})
    void api.readerGoals().then((r) => setGoals(r.goals)).catch(() => {})
  }, [])

  useEffect(() => {
    setCurrent(null)
    setError(null)
    stopPolling()
    setRunning(false)
    setJobId(null)
    setSessions([])
    setActiveSessionId(null)
    setCoachError(null)
    setShowMoreKinds(false)
    if (!currentDoc) { setHistory([]); return }
    void api.listSummaries(currentDoc.id)
      .then((r) => {
        setHistory(r.summaries)
        // 方案 C 动线：有缓存速读卡则直接展示，紧接着就是目标分流
        const card = r.summaries.find((h) => h.kind === 'socratic_card')
        if (card) setCurrent(card)
      })
      .catch(() => setHistory([]))
    void api.readerSessions(currentDoc.id)
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]))
  }, [currentDoc])

  // 组件卸载时停止轮询
  useEffect(() => () => stopPolling(), [])

  const stopPolling = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const refreshHistory = async () => {
    if (!currentDoc) return
    try {
      const list = await api.listSummaries(currentDoc.id)
      setHistory(list.summaries)
    } catch { /* 忽略 */ }
  }

  const generate = async (kind: string) => {
    if (!currentDoc) return
    setError(null)
    setCurrent(null)
    setProgress(5)
    setMessage('启动任务')
    setRunning(true)
    setCancelling(false)
    cancelledRef.current = false

    try {
      const { job_id } = await api.startSummary(
        currentDoc.id, kind,
        kind === 'qa' ? question : undefined,
      )
      setJobId(job_id)

      timerRef.current = window.setInterval(async () => {
        try {
          const st = await api.summaryJob(job_id)
          setProgress(st.progress)
          setMessage(st.message || '')

          if (st.status === 'running') return

          stopPolling()
          setRunning(false)
          setJobId(null)

          if (st.status === 'done' && st.result) {
            const r = st.result
            setCurrent({
              id: r.id,
              document_id: currentDoc.id,
              kind: st.kind,
              content: r.content,
              model: r.model ?? null,
              created_at: new Date().toISOString(),
            })
            await refreshHistory()
          } else if (st.status === 'cancelled') {
            setMessage('已取消')
          } else {
            setError(st.error || '生成失败')
          }
        } catch (e) {
          stopPolling()
          setRunning(false)
          setJobId(null)
          setError(String(e).replace(/^Error:\s*/, ''))
        }
      }, POLL_MS)
    } catch (e) {
      setRunning(false)
      setJobId(null)
      setError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const cancel = async () => {
    if (!jobId) return
    setCancelling(true)
    setMessage('正在取消…')
    try {
      await api.cancelSummary(jobId)
      cancelledRef.current = true
      // 轮询会捕获 cancelled 状态并复位 UI
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
      setCancelling(false)
    }
  }

  if (!currentDoc) {
    return <div className="hint" style={{ padding: 20 }}>选择一篇文献后可生成 AI 总结</div>
  }

  const del = async (id: string) => {
    await api.deleteSummary(id)
    if (current?.id === id) setCurrent(null)
    await refreshHistory()
  }

  const labelOf = (k: string) => kinds.find((x) => x.value === k)?.label ?? k

  // 速读卡是主流程；其余总结类型收进「更多总结方式」
  const otherKinds = kinds.filter((k) => k.value !== 'socratic_card')
  const card = history.find((h) => h.kind === 'socratic_card') ?? null
  const cardShown = current?.kind === 'socratic_card'
    || (!current && card !== null)

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null

  const goalLabelOf = (g: string) => goals.find((x) => x.value === g)?.label ?? g

  const reloadSessions = async () => {
    if (!currentDoc) return
    try {
      const r = await api.readerSessions(currentDoc.id)
      setSessions(r.sessions)
    } catch { /* 忽略 */ }
  }

  /** 点目标 chip：已有同目标会话则切过去，否则建会话（教练自动开场） */
  const pickGoal = async (goal: string) => {
    if (!currentDoc || sending) return
    const existing = sessions.find((s) => s.goal === goal)
    if (existing) { setActiveSessionId(existing.id); return }
    setCoachError(null)
    setSending(true)
    try {
      const r = await api.readerChat(currentDoc.id, { goal })
      await reloadSessions()
      setActiveSessionId(r.session_id)
    } catch (e) {
      setCoachError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setSending(false)
    }
  }

  const sendMessage = async () => {
    const text = draft.trim()
    if (!currentDoc || !activeSessionId || !text || sending) return
    setDraft('')
    setSending(true)
    setCoachError(null)
    // 先本地回显用户消息，回复到达后再整表重载（落库内容为准）
    setSessions((prev) => prev.map((s) => s.id === activeSessionId
      ? { ...s, messages: [...s.messages, { role: 'user' as const, content: text, created_at: new Date().toISOString() }] }
      : s))
    try {
      const r = await api.readerChat(currentDoc.id, { session_id: activeSessionId, message: text })
      setSessions((prev) => prev.map((s) => s.id === activeSessionId
        ? { ...s, messages: [...s.messages, { role: 'assistant' as const, content: r.reply, created_at: new Date().toISOString() }] }
        : s))
    } catch (e) {
      setCoachError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setSending(false)
    }
  }

  const removeSession = async (id: string) => {
    await api.deleteReaderSession(id)
    if (activeSessionId === id) setActiveSessionId(null)
    await reloadSessions()
  }

  // 会话有更新时滚到底部
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeSession?.messages.length, sending])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 控制区：主流程是速读卡，其余总结方式折叠 */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {!running ? (
            <>
              <button
                className="btn-primary"
                style={{ fontSize: 12 }}
                onClick={() => void generate('socratic_card')}
              >{card ? '重新生成速读卡' : '生成一页纸速读卡'}</button>
              <button
                className="btn-ghost"
                style={{ fontSize: 11, color: 'var(--fg-muted)' }}
                onClick={() => setShowMoreKinds((v) => !v)}
              >{showMoreKinds ? '收起更多 ▴' : '更多总结方式 ▾'}</button>
            </>
          ) : (
            <>
              <button
                className="btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => void cancel()}
                disabled={cancelling}
              >{cancelling ? '取消中…' : '取消'}</button>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                {message}{progress > 0 && ` ${Math.round(progress)}%`}
              </span>
            </>
          )}
        </div>

        {showMoreKinds && !running && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {otherKinds.map((k) => (
                <button
                  key={k.value}
                  onClick={() => setActiveKind(k.value)}
                  style={{
                    fontSize: 11, padding: '4px 9px', borderRadius: 12, cursor: 'pointer',
                    border: `1px solid ${activeKind === k.value ? 'var(--accent)' : 'var(--border)'}`,
                    background: activeKind === k.value ? 'var(--accent)' : 'transparent',
                    color: activeKind === k.value ? '#fff' : 'var(--fg)',
                  }}
                >{k.label}</button>
              ))}
            </div>
            {activeKind === 'qa' && (
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={2}
                placeholder="针对这篇论文提问，例如：训练用了什么数据和超参数？"
                style={{ width: '100%', fontSize: 12, padding: '6px 8px', marginBottom: 6, resize: 'vertical' }}
              />
            )}
            <button
              className="btn-ghost"
              style={{ fontSize: 11 }}
              onClick={() => void generate(activeKind)}
              disabled={activeKind === 'qa' && !question.trim()}
            >生成「{labelOf(activeKind)}」</button>
          </div>
        )}

        {running && (
          <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginTop: 8 }}>
            <div style={{
              height: '100%', width: `${progress}%`, background: 'var(--accent)',
              borderRadius: 2, transition: 'width 0.4s',
            }} />
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 8, fontSize: 11, color: '#b91c1c', background: '#ef44441a',
            padding: '6px 8px', borderRadius: 6, lineHeight: 1.5, wordBreak: 'break-word',
          }}>{error}</div>
        )}
      </div>

      {/* 结果区 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
        {current ? (
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
              fontSize: 11, color: 'var(--fg-muted)',
            }}>
              <span>{labelOf(current.kind)}</span>
              {current.model && <span>· {current.model}</span>}
              <button
                className="btn-ghost"
                style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 6px' }}
                onClick={() => void navigator.clipboard?.writeText(current.content)}
              >复制</button>
            </div>
            <MarkdownView text={current.content} />
          </div>
        ) : (
          !running && (
            <div className="hint" style={{ padding: '20px 4px', lineHeight: 1.7 }}>
              点击「生成一页纸速读卡」，先快速定位这篇论文值不值得精读。
              <br />卡片生成后可按目标（组会/复现/综述…）继续领读。
            </div>
          )
        )}

        {/* 领读教练：速读卡之后的目标分流，视觉上与卡片同一条流 */}
        {cardShown && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8,
            border: '1px dashed var(--border)', background: 'var(--bg-card, transparent)',
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>继续精读 · 选一个目标</div>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8 }}>
              教练按对应路线带读，可追问（多轮对话，历史保留）
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {goals.map((g) => {
                const sess = sessions.find((s) => s.goal === g.value)
                const active = sess && sess.id === activeSessionId
                return (
                  <button
                    key={g.value}
                    onClick={() => void pickGoal(g.value)}
                    disabled={sending}
                    style={{
                      fontSize: 11.5, padding: '4px 12px', borderRadius: 14,
                      cursor: sending ? 'not-allowed' : 'pointer',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active ? 'var(--accent)' : sess ? 'var(--bg-active)' : 'transparent',
                      color: active ? '#fff' : 'var(--fg)',
                    }}
                  >{sess ? '↩ ' : ''}{g.label}</button>
                )
              })}
            </div>

            {coachError && (
              <div style={{
                marginBottom: 8, fontSize: 11, color: '#b91c1c', background: '#ef44441a',
                padding: '6px 8px', borderRadius: 6, lineHeight: 1.5, wordBreak: 'break-word',
              }}>{coachError}</div>
            )}

            {activeSession && (
              <div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
                  fontSize: 11, color: 'var(--fg-muted)',
                }}>
                  <span>领读会话 · {goalLabelOf(activeSession.goal)}</span>
                  <button
                    className="btn-ghost"
                    style={{ marginLeft: 'auto', fontSize: 10, padding: '0 4px' }}
                    onClick={() => void removeSession(activeSession.id)}
                  >删除会话</button>
                </div>
                <div
                  ref={threadRef}
                  style={{
                    maxHeight: 320, overflowY: 'auto', display: 'flex',
                    flexDirection: 'column', gap: 8, marginBottom: 8,
                  }}
                >
                  {activeSession.messages.map((m, i) => (
                    <div
                      key={i}
                      style={{
                        alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '92%',
                        padding: '6px 10px',
                        borderRadius: 8,
                        fontSize: 12,
                        lineHeight: 1.6,
                        background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-card, #fff)',
                        color: m.role === 'user' ? '#fff' : 'var(--fg)',
                        border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                      }}
                    >
                      {m.role === 'user' ? m.content : <MarkdownView text={m.content} />}
                    </div>
                  ))}
                  {sending && (
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>教练思考中…</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={2}
                    disabled={sending}
                    placeholder="回答教练的问题 / 追问论文细节…"
                    style={{ flex: 1, fontSize: 12, padding: '6px 8px', resize: 'vertical' }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendMessage()
                    }}
                  />
                  <button
                    className="btn-primary"
                    style={{ fontSize: 12, alignSelf: 'flex-end' }}
                    onClick={() => void sendMessage()}
                    disabled={sending || !draft.trim()}
                  >发送</button>
                </div>
              </div>
            )}
          </div>
        )}

        {history.length > 0 && (
          <div style={{ marginTop: 22, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>
              历史记录（{history.length}）
            </div>
            {history.map((h) => (
              <div
                key={h.id}
                onClick={() => setCurrent(h)}
                style={{
                  fontSize: 11, padding: '5px 7px', borderRadius: 5, cursor: 'pointer',
                  display: 'flex', gap: 6, alignItems: 'center',
                  background: current?.id === h.id ? 'var(--bg-active)' : 'transparent',
                }}
              >
                <span>{labelOf(h.kind)}</span>
                <span style={{ color: 'var(--fg-muted)' }}>
                  {new Date(h.created_at).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
                <button
                  className="btn-ghost"
                  style={{ marginLeft: 'auto', fontSize: 10, padding: '0 4px' }}
                  onClick={(e) => { e.stopPropagation(); void del(h.id) }}
                >删除</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
