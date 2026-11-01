/**
 * 会话线程共用组件。
 *
 * 领读教练（SummaryPanel）与自由问答（ChatPanel）共用后端 reader_sessions
 * 底座，前端气泡、输入框、错误提示也统一在这里实现，不再两处平行维护：
 *   - ChatThread  消息气泡列表 + 「思考中」指示 + 自动滚底
 *   - ChatInput   统一发送键位（Enter 发送 / Shift+Enter 换行，输入法合成中不触发）
 *   - InlineError 线内错误提示条
 *   - composeQuotedMessage / parseQuotedMessage / QuoteCard  划词引用块
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { ReaderMessage } from '../api/client'
import type { ChatQuote } from '../stores/useStore'
import MarkdownView from './MarkdownView'
import { Icon, PATH_SEND } from './icons'

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
export function QuoteCard({ text, page, onRemove }: { text: string; page: number | null; onRemove?: () => void }) {
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

/** 线内错误提示条（教练 / 问答共用样式） */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--err)', background: 'var(--err-bg)',
      padding: '6px 8px', borderRadius: 6, lineHeight: 1.5, wordBreak: 'break-word',
    }}>{children}</div>
  )
}

interface ChatThreadProps {
  messages: ReaderMessage[]
  sending: boolean
  /** 发送等待文案（教练思考中… / 助手思考中…） */
  sendingLabel?: string
  /** 助手回答中 [p.N] 出处点击跳页 */
  onCiteClick?: (page: number) => void
  /** 消息列表之后、指示器之前的内容（如追问快捷词） */
  footer?: ReactNode
  /** 覆盖容器样式（问答：flex:1 撑满；教练：maxHeight 内嵌） */
  style?: React.CSSProperties
}

/** 消息气泡线程：新消息自动滚到底部 */
export function ChatThread({ messages, sending, sendingLabel = '助手思考中…', onCiteClick, footer, style }: ChatThreadProps) {
  const ref = useRef<HTMLDivElement>(null)

  // 会话有更新时滚到底部
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, sending])

  return (
    <div
      ref={ref}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', ...style }}
    >
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
              : <MarkdownView text={m.content} onCiteClick={onCiteClick} />}
          </div>
        )
      })}
      {footer}
      {sending && <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{sendingLabel}</div>}
    </div>
  )
}

interface ChatInputProps {
  draft: string
  onDraftChange: (v: string) => void
  onSend: () => void
  sending: boolean
  placeholder?: string
  /** 外部控制聚焦（如划词引用出现时聚焦输入框） */
  inputRef?: RefObject<HTMLTextAreaElement>
  /** 输入框上方的内容（如待发送的引用卡片） */
  above?: ReactNode
  /** 覆盖容器样式（教练内嵌场景去掉上边框与内边距） */
  style?: React.CSSProperties
}

/** 统一输入区：Enter 发送 / Shift+Enter 换行；输入法合成中不触发 */
export function ChatInput({ draft, onDraftChange, onSend, sending, placeholder, inputRef, above, style }: ChatInputProps) {
  const disabled = sending || !draft.trim()
  return (
    <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', flexShrink: 0, ...style }}>
      {above}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          rows={2}
          disabled={sending}
          placeholder={placeholder ?? '问点什么…'}
          style={{ flex: 1, fontSize: 12, padding: '6px 8px', resize: 'none' }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            onSend()
          }}
        />
        <button
          title="发送"
          onClick={onSend}
          disabled={disabled}
          style={{
            width: 30, height: 30, flexShrink: 0, borderRadius: '50%', padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--accent)', color: '#fff', border: 'none',
            opacity: disabled ? 0.45 : 1,
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          <Icon d={PATH_SEND} size={14} />
        </button>
      </div>
    </div>
  )
}
