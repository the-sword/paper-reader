/**
 * 论文问答面板（右栏「问答」页签）。
 *
 * 与 AI 总结里的「领读教练」共用后端会话底座与前端 ChatThread 组件，
 * 但语义不同：
 *   - 领读会话：goal ∈ GOALS，教练按路线带读（主动推进、追问读者）
 *   - 本面板：goal = free，读者自由提问，助手基于全文上下文实时解答
 *
 * 会话按文档懒创建：读者发出第一条问题时才建库；清空即删除会话。
 * 划词「问 AI / 解释」通过 store 的 chatQuote / chatAutoSend 送入本面板。
 */
import { useEffect, useRef, useState } from 'react'
import { api, type ReaderMessage, type ReaderSession } from '../api/client'
import { useStore } from '../stores/useStore'
import PanelFrame from './PanelFrame'
import { ChatInput, ChatThread, InlineError, QuoteCard, composeQuotedMessage } from './ChatThread'

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

export default function ChatPanel() {
  const currentDoc = useStore((s) => s.currentDoc)
  const segments = useStore((s) => s.segments)
  const parseState = useStore((s) => s.parseState)
  const syncParseState = useStore((s) => s.syncParseState)
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const parsed = segments.length > 0
  const parsing = parseState === 'running' || parseState === 'pending' || parseState === 'queued'
  const parseFailed = parseState === 'failed'

  // 挂载兜底：解析可能在上次会话已完成（轮询因刷新丢失），同步后按钮才会消失
  useEffect(() => {
    if (currentDoc && !parsed && !parsing) void syncParseState(currentDoc.id)
    // parsed/parsing 变化时不必重跑：同步动作只依赖文档
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDoc])

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
      {messages.length === 0 && !sending ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px', minHeight: 0 }}>
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
            {!parsed && !parseFailed && (
              <button
                className="btn-primary"
                style={{ marginTop: 14, fontSize: 12 }}
                disabled={parsing}
                onClick={() => void startParse('auto')}
              >{parsing ? '解析中…' : '解析全文'}</button>
            )}
            {!parsed && parseFailed && (
              <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
                上次解析未完成，问答暂不可用。
                <button
                  className="btn-primary"
                  style={{ display: 'block', marginTop: 6, fontSize: 12 }}
                  onClick={() => void startParse('auto')}
                >重新解析</button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <ChatThread
          style={{ flex: 1, minHeight: 0, padding: 12 }}
          messages={messages}
          sending={sending}
          sendingLabel="助手思考中…"
          onCiteClick={requestJump}
          footer={!sending && lastIsAssistant ? (
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
          ) : undefined}
        />
      )}

      {error && (
        <div style={{ padding: '0 12px 8px' }}>
          <InlineError>{error}</InlineError>
        </div>
      )}

      <ChatInput
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => void send()}
        sending={sending}
        placeholder="问点什么…"
        inputRef={inputRef}
        above={chatQuote ? (
          <QuoteCard
            text={chatQuote.text}
            page={chatQuote.page}
            onRemove={() => setChatQuote(null)}
          />
        ) : undefined}
      />
    </PanelFrame>
  )
}
