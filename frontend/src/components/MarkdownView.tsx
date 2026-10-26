/**
 * 轻量 Markdown 渲染器。
 *
 * 为什么不用 react-markdown：
 *   - 只需要支持 AI 总结常用的语法（标题、列表、粗体、行内代码、公式）
 *   - 避免额外依赖，保证离线可用与包体积
 *
 * 支持：
 *   ## 标题   ### 标题
 *   - 无序列表   1. 有序列表
 *   **粗体**    `行内代码`
 *   $行内公式$（交给 RichText / KaTeX）
 */
import { useMemo } from 'react'
import RichText from './RichText'

interface Block {
  type: 'heading' | 'list' | 'para' | 'code'
  level?: number
  ordered?: boolean
  items?: string[]
  text?: string
}

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let listBuf: string[] = []
  let listOrdered = false
  let codeBuf: string[] = []
  let inCode = false

  const flushList = () => {
    if (listBuf.length) {
      blocks.push({ type: 'list', ordered: listOrdered, items: [...listBuf] })
      listBuf = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    // 代码块
    if (line.trim().startsWith('```')) {
      if (inCode) {
        blocks.push({ type: 'code', text: codeBuf.join('\n') })
        codeBuf = []
        inCode = false
      } else {
        flushList()
        inCode = true
      }
      continue
    }
    if (inCode) { codeBuf.push(raw); continue }

    // 空行
    if (!line.trim()) { flushList(); continue }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushList()
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] })
      continue
    }

    // 无序列表
    const ul = /^[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      if (!listBuf.length) listOrdered = false
      listBuf.push(ul[1])
      continue
    }

    // 有序列表
    const ol = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ol) {
      if (!listBuf.length) listOrdered = true
      listBuf.push(ol[1])
      continue
    }

    // 普通段落
    flushList()
    blocks.push({ type: 'para', text: line })
  }

  flushList()
  if (inCode && codeBuf.length) blocks.push({ type: 'code', text: codeBuf.join('\n') })
  return blocks
}

/** 页码引用 chip：[p.N] 渲染为可点击的「p.N ↗」，点击跳转到对应页 */
function CiteChip({ page, onCiteClick }: { page: number; onCiteClick?: (page: number) => void }) {
  return (
    <button
      type="button"
      title={`跳转到第 ${page} 页`}
      onClick={() => onCiteClick?.(page)}
      style={{
        display: 'inline-block', margin: '0 2px', padding: '0 5px', borderRadius: 4,
        border: 'none', fontSize: '0.9em', fontWeight: 600, lineHeight: 1.6,
        background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
        color: 'var(--accent)', cursor: onCiteClick ? 'pointer' : 'default',
      }}
    >p.{page} ↗</button>
  )
}

/** 处理行内标记：**粗体**、`code`、[p.N] 页码引用，其余交给 RichText（含公式） */
function Inline({ text, onCiteClick }: { text: string; onCiteClick?: (page: number) => void }) {
  const parts = useMemo(() => {
    const out: Array<{ t: 'text' | 'bold' | 'code' | 'cite'; v: string }> = []
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[p\.(\d+)\]/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
      if (m[1] !== undefined) out.push({ t: 'bold', v: m[1] })
      else if (m[2] !== undefined) out.push({ t: 'code', v: m[2] })
      else if (m[3] !== undefined) out.push({ t: 'cite', v: m[3] })
      last = m.index + m[0].length
    }
    if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
    return out
  }, [text])

  return (
    <>
      {parts.map((p, i) => {
        if (p.t === 'bold') return <strong key={i}>{p.v}</strong>
        if (p.t === 'cite') return <CiteChip key={i} page={Number(p.v)} onCiteClick={onCiteClick} />
        if (p.t === 'code') {
          return (
            <code key={i} style={{
              fontSize: '0.9em', padding: '1px 4px', borderRadius: 3,
              background: 'var(--bg-active)', fontFamily: 'monospace',
            }}>{p.v}</code>
          )
        }
        return <RichText key={i} text={p.v} />
      })}
    </>
  )
}

interface Props {
  text: string
  /** 点击 [p.N] 页码引用时回调（如跳转到原文该页） */
  onCiteClick?: (page: number) => void
}

export default function MarkdownView({ text, onCiteClick }: Props) {
  const blocks = useMemo(() => parseBlocks(text), [text])

  return (
    <div style={{ fontSize: 13, lineHeight: 1.85, color: 'var(--fg)' }}>
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const size = b.level === 1 ? 16 : b.level === 2 ? 15 : 14
          return (
            <div key={i} style={{
              fontSize: size, fontWeight: 600, color: 'var(--fg-strong)',
              margin: i === 0 ? '0 0 8px' : '16px 0 6px',
            }}>
              <Inline text={b.text ?? ''} onCiteClick={onCiteClick} />
            </div>
          )
        }
        if (b.type === 'list') {
          return (
            <ul
              key={i}
              style={{
                margin: '6px 0', paddingLeft: 20,
                listStyleType: b.ordered ? 'decimal' : 'disc',
              }}
            >
              {(b.items ?? []).map((it, j) => (
                <li key={j} style={{ marginBottom: 4 }}><Inline text={it} onCiteClick={onCiteClick} /></li>
              ))}
            </ul>
          )
        }
        if (b.type === 'code') {
          return (
            <pre key={i} style={{
              margin: '8px 0', padding: 10, borderRadius: 6, overflowX: 'auto',
              background: 'var(--bg-active)', fontSize: 12, fontFamily: 'monospace',
            }}>{b.text}</pre>
          )
        }
        return (
          <p key={i} style={{ margin: '6px 0', textAlign: 'justify' }}>
            <Inline text={b.text ?? ''} onCiteClick={onCiteClick} />
          </p>
        )
      })}
    </div>
  )
}
