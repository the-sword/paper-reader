/**
 * 论文问答面板（右栏「问答」页签）。
 *
 * 与 AI 总结里的「领读会话」共用后端会话底座，但语义不同：
 *   - 领读会话：goal ∈ GOALS，教练按路线带读（主动推进、追问读者）
 *   - 本面板：goal = free，读者自由提问，助手基于全文上下文实时解答
 *
 * 会话按文档懒创建：读者发出第一条问题时才建库；清空即删除会话。
 * 划词「问 AI / 解释」通过 store 的 chatQuote / chatAutoSend 送入本面板。
 */
import { useEffect, useRef, useState } from 'react'
import { api, type ReaderMessage, type ReaderSession } from '../api/client'
import { useStore, type ChatQuote } from '../stores/useStore'
import MarkdownView from './MarkdownView'
import PanelFrame from './PanelFrame'
import { Icon, PATH_SEND } from './icons'

const FREE_GOAL = 'free'

/** 空态给读者的提问示例，点击直接填入输入框 */
const EXAMPLE_QUESTIONS = [
  '这篇论文用了什么数据集和评测指标？',
  '核心方法一句话怎么概括？',
  '和基线比，提升主要来自哪里？',
]

/** 最后一条助手回答下方的追问快捷词 */
const FOLLOW_UPS = [
  '再解释得通俗一点',
  '举个具体例子',
  '和相关工作比有何不同',
  '复现要注意什么',
]

/** 把引用块与问题拼成发给模型的消息：每行前加 "> "，末行标注页码 */
export function composeQuotedMessage(question: string, quote: ChatQuote): string {
  const block = quote.text.split('\n').map((l) => `> ${l}`).join('\n')
  return `${block}\n> —— p.${quote.page}\n\n${question}`
}

interface ParsedMessage {
  quote: string
  page: number | null
  body: string
}

/** 拆出用户消息开头的引用块（以 "> " 开头），返回 null 表示普通消息 */
export function parseQuotedMessage(content: string): ParsedMessage | null {
  const lines = content.split('\n')
  if (!lines[0]?.startsWith('> ')) return null
  const quoteLines: string[] = []
  let i = 0
  while (i < lines.length && lines[i].startsWith('> ')) {
    quoteLines.push(lines[i].slice(2))
    i++
  }
  let page: number | null = null
  const m = /^—— p\.(\d+)$/.exec(quoteLines[quoteLines.length - 1] ?? '')
  if (m) {
    page = Number(m[1])
    quoteLines.pop()
  }
  return { quote: quoteLines.join('\n'), page, body: lines.slice(i).join('\n').replace(/^\n+/, '') }
}

/** 引用卡片：左侧竖条 + 截断 2 行的原文 + p.N；输入框上方与消息气泡上方共用 */
function QuoteCard({ text, page, onRemove }: { text: string; page: number | null; onRemove?: () => void }) {
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', marginBottom: 6,
      borderRadius: 6, background: 'var(--bg-active)', fontSize: 11.5, color: 'var(--fg-muted)',
    }}>
      <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: 'var(--accent)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontStyle: 'italic', lineHeight: 1.5, overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>{text}</div>
        {page !== null && <div style={{ fontSize: 10, marginTop: 2 }}>p.{page}</div>}
      </div>
      {onRemove && (
        <button
          className="btn-ghost"
          title="移除引用"
          onClick={onRemove}
          style={{ border: 'none', padding: '0 4px', fontSize: 12, lineHeight: 1 }}
        >×</button>
      )}
    </div>
  )
}

export default function ChatPanel() {
  const currentDoc = useStore((s) => s.currentDoc)
  const segments = useStore((s) => s.segments)
  const parseState = useStore((s) => s.parseState)
  const startParse = useStore((s) => s.startParse)
  const requestJump = useStore((s) => s.requestJump)
  const chatQuote = useStore((s) => s.chatQuote)
  const setChatQuote = useStore((s) => s.setChatQuote)
  const chatAutoSend = useStore((s) => s.chatAutoSend)
  const [session, setSession] = useState<ReaderSession | null>(null)
  const [pending, setPending] = useState<ReaderMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const parsed = segments.length > 0
  const parsing = parseState === 'running' || parseState === 'pending' || parseState === 'queued'

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

  // 划词「问 AI」：引用块出现后直接聚焦输入框
  useEffect(() => {
    if (chatQuote) inputRef.current?.focus()
  }, [chatQuote])

  const sendRef = useRef<(override?: string) => Promise<void>>(async () => {})

  // 划词「解释」：自动发送提示语（引用块由 chatQuote 一并带上），消费后清空
  useEffect(() => {
    if (!chatAutoSend || !currentDoc) return
    useStore.setState({ chatAutoSend: null })
    void sendRef.current(chatAutoSend.text)
  }, [chatAutoSend, currentDoc])

  const send = async (override?: string): Promise<void> => {
    const question = (override ?? draft).trim()
    if (!question || sending || !currentDoc) return
    const quote = useStore.getState().chatQuote
    const content = quote ? composeQuotedMessage(question, quote) : question
    setDraft('')
    setError(null)
    setSending(true)
    if (quote) setChatQuote(null)
    const userMsg: ReaderMessage = {
      role: 'user', content, created_at: new Date().toISOString(),
    }
    setPending([userMsg])
    try {
      // 无会话则以本条问题建会话（free），否则续聊
      const body = session
        ? { session_id: session.id, message: content }
        : { goal: FREE_GOAL, message: content }
      await api.readerChat(currentDoc.id, body)
      const list = await api.readerSessions(currentDoc.id)
      setSession(list.sessions.find((s) => s.goal === FREE_GOAL) ?? null)
      setPending([])
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
      setPending([])
      setDraft(question)
    } finally {
      setSending(false)
    }
  }
  sendRef.current = send

  const clear = async () => {
    if (!session) return
    await api.deleteReaderSession(session.id)
    setSession(null)
  }

  const lastIsAssistant = messages.length > 0 && messages[messages.length - 1].role === 'assistant'

  const header = (
    <>
      <span className={`badge ${parsed ? 'ok' : ''}`} title={parsed ? '论文全文已作为上下文' : '解析全文后回答更准确'}>
        {parsed ? '已注入全文' : '未解析'}
      </span>
      {session && (
        <button
          className="btn-ghost"
          style={{ fontSize: 11, padding: '2px 8px' }}
          onClick={() => void clear()}
        >新会话</button>
      )}
    </>
  )

  if (!currentDoc) {
    return <div className="hint" style={{ padding: 20 }}>选择一篇文献后可向 AI 提问</div>
  }

  return (
    <PanelFrame title="问答" actions={header}>
      {/* 消息线程 */}
      <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: '12px', minHeight: 0 }}>
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
            {!parsed && (
              <button
                className="btn-primary"
                style={{ marginTop: 14, fontSize: 12 }}
                disabled={parsing}
                onClick={() => void startParse('auto')}
              >{parsing ? '解析中…' : '解析全文'}</button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {messages.map((m, i) => {
              const quoted = m.role === 'user' ? parseQuotedMessage(m.content) : null
              const body = quoted ? quoted.body : m.content
              return (
                <div key={i} style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '92%',
                  padding: '6px 10px',
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.6,
                  background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-card, #fff)',
                  color: m.role === 'user' ? '#fff' : 'var(--fg)',
                  border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                }}>
                  {quoted && (
                    <div style={{
                      marginBottom: 6, padding: '4px 8px', borderRadius: 5, fontSize: 11,
                      background: 'rgba(255,255,255,0.16)', color: 'inherit', opacity: 0.9,
                      fontStyle: 'italic', lineHeight: 1.5,
                    }}>
                      {quoted.quote}
                      {quoted.page !== null && <span style={{ fontStyle: 'normal' }}> · p.{quoted.page}</span>}
                    </div>
                  )}
                  {m.role === 'user'
                    ? body
                    : <MarkdownView text={m.content} onCiteClick={requestJump} />}
                </div>
              )
            })}
            {!sending && lastIsAssistant && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                {FOLLOW_UPS.map((q) => (
                  <button
                    key={q}
                    className="btn-ghost"
                    style={{ fontSize: 11, padding: '3px 9px', borderRadius: 14 }}
                    onClick={() => void send(q)}
                  >{q}</button>
                ))}
              </div>
            )}
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

      {/* 输入区（固定底部）：引用块在输入框上方 */}
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        {chatQuote && (
          <QuoteCard
            text={chatQuote.text}
            page={chatQuote.page}
            onRemove={() => setChatQuote(null)}
          />
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            disabled={sending}
            placeholder="问点什么…"
            style={{ flex: 1, fontSize: 12, padding: '6px 8px', resize: 'none' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button
            title="发送"
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            style={{
              width: 30, height: 30, flexShrink: 0, borderRadius: '50%', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent)', color: '#fff', border: 'none',
              opacity: sending || !draft.trim() ? 0.45 : 1,
              cursor: sending || !draft.trim() ? 'default' : 'pointer',
            }}
          >
            <Icon d={PATH_SEND} size={14} />
          </button>
        </div>
      </div>
    </PanelFrame>
  )
}
