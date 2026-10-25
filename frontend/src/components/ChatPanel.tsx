/**
 * 论文问答面板（右栏「问答」页签）。
 *
 * 与 AI 总结里的「领读会话」共用后端会话底座，但语义不同：
 *   - 领读会话：goal ∈ GOALS，教练按路线带读（主动推进、追问读者）
 *   - 本面板：goal = free，读者自由提问，助手基于全文上下文实时解答
 *
 * 会话按文档懒创建：读者发出第一条问题时才建库；清空即删除会话。
 */
import { useEffect, useRef, useState } from 'react'
import { api, type ReaderMessage, type ReaderSession } from '../api/client'
import { useStore } from '../stores/useStore'
import MarkdownView from './MarkdownView'

const FREE_GOAL = 'free'

/** 空态给读者的提问示例，点击直接填入输入框 */
const EXAMPLE_QUESTIONS = [
  '这篇论文用了什么数据集和评测指标？',
  '核心方法一句话怎么概括？',
  '和基线比，提升主要来自哪里？',
]

export default function ChatPanel() {
  const currentDoc = useStore((s) => s.currentDoc)
  const [session, setSession] = useState<ReaderSession | null>(null)
  const [pending, setPending] = useState<ReaderMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  // 切文档：载入该文档已有的自由问答会话
  useEffect(() => {
    setSession(null)
    setPending([])
    setError(null)
    if (!currentDoc) return
    void api.readerSessions(currentDoc.id)
      .then((r) => setSession(r.sessions.find((s) => s.goal === FREE_GOAL) ?? null))
      .catch(() => setSession(null))
  }, [currentDoc])

  const messages = [...(session?.messages ?? []), ...pending]

  // 新消息到达时滚到底部
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, sending])

  if (!currentDoc) {
    return <div className="hint" style={{ padding: 20 }}>选择一篇文献后可向 AI 提问</div>
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    setError(null)
    setSending(true)
    const userMsg: ReaderMessage = {
      role: 'user', content: text, created_at: new Date().toISOString(),
    }
    setPending([userMsg])
    try {
      // 无会话则以本条问题建会话（free），否则续聊
      const body = session
        ? { session_id: session.id, message: text }
        : { goal: FREE_GOAL, message: text }
      await api.readerChat(currentDoc.id, body)
      const list = await api.readerSessions(currentDoc.id)
      setSession(list.sessions.find((s) => s.goal === FREE_GOAL) ?? null)
      setPending([])
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
      setPending([])
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

  const clear = async () => {
    if (!session) return
    await api.deleteReaderSession(session.id)
    setSession(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 头部：说明 + 清空 */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          基于全文上下文解答，论文未提供的会明说
        </span>
        {session && (
          <button
            className="btn-ghost"
            style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 6px' }}
            onClick={() => void clear()}
          >清空对话</button>
        )}
      </div>

      {/* 消息线程 */}
      <div
        ref={threadRef}
        style={{ flex: 1, overflowY: 'auto', padding: '12px', minHeight: 0 }}
      >
        {messages.length === 0 && !sending ? (
          <div className="hint" style={{ padding: '16px 4px', lineHeight: 1.8, fontSize: 12 }}>
            针对当前论文自由提问，回答会带上论文上下文：
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  className="btn-ghost"
                  style={{
                    fontSize: 11.5, textAlign: 'left', padding: '6px 10px',
                    border: '1px solid var(--border)', borderRadius: 8,
                  }}
                  onClick={() => setDraft(q)}
                >{q}</button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {messages.map((m, i) => (
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
              <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>助手思考中…</div>
            )}
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 8, fontSize: 11, color: '#b91c1c', background: '#ef44441a',
            padding: '6px 8px', borderRadius: 6, lineHeight: 1.5, wordBreak: 'break-word',
          }}>{error}</div>
        )}
      </div>

      {/* 输入区（固定底部） */}
      <div style={{
        padding: '8px 12px', borderTop: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', gap: 6, alignItems: 'flex-end',
      }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          disabled={sending}
          placeholder="问点什么…（Ctrl+Enter 发送）"
          style={{ flex: 1, fontSize: 12, padding: '6px 8px', resize: 'vertical' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
        />
        <button
          className="btn-primary"
          style={{ fontSize: 12 }}
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
        >发送</button>
      </div>
    </div>
  )
}
