/**
 * 行内公式渲染。
 *
 * MinerU 会把公式混在正文里，形如：
 *   "Let $F ( I _ { L } ) \in \mathbb { R }$ denote the feature maps."
 *
 * 直接当纯文本显示会看到一堆 LaTeX 命令，因此需要：
 *   1. 按 $...$ 切分段落
 *   2. 公式片段用 KaTeX 行内模式（displayMode: false）渲染
 *   3. 普通片段按文本渲染
 */
import React, { useEffect, useMemo, useRef } from 'react'
import katex from 'katex'

/** 把段落拆成 [文本, 公式, 文本, 公式, ...] 片段 */
export function splitInlineMath(text: string): Array<{ type: 'text' | 'math'; value: string }> {
  const out: Array<{ type: 'text' | 'math'; value: string }> = []
  // 同时支持 $...$ 与 $$...$$
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ type: 'text', value: text.slice(last, m.index) })
    }
    const math = (m[1] ?? m[2] ?? '').trim()
    if (math) out.push({ type: 'math', value: math })
    last = m.index + m[0].length
  }
  if (last < text.length) {
    out.push({ type: 'text', value: text.slice(last) })
  }
  return out
}

/**
 * 规范化 MinerU OCR 产生的「字母间空格」。
 * 例：{c l s} → {cls}，{W a r p} → {Warp}，{m a x} → {max}
 * 只合并「完全由单字母 + 空格构成」的花括号，不碰正常单词与嵌套结构。
 */
export function normalizeOcrSpacing(latex: string): string {
  return latex.replace(/\{([^{}]*)\}/g, (whole: string, body: string) => {
    const t = body.trim()
    if (/^[A-Za-z](?:\s+[A-Za-z])+$/.test(t)) {
      return '{' + t.replace(/\s+/g, '') + '}'
    }
    return whole
  })
}

/** 单个行内公式 */
function InlineMath({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const normalized = normalizeOcrSpacing(latex)
    try {
      katex.render(normalized, el, {
        throwOnError: false,
        displayMode: false,
        strict: false,
        errorColor: '#dc2626',
      })
    } catch {
      el.textContent = latex
    }
  }, [latex])

  return <span ref={ref} />
}

export interface HighlightRange {
  start: number
  end: number
  color: string
}

/**
 * 在一段纯文本上应用高亮区间，返回 React 片段。
 * 区间按字符索引切分，越界自动裁剪。
 */
function renderWithHighlights(
  text: string, ranges: HighlightRange[], keyPrefix: string,
): React.ReactNode[] {
  if (!ranges.length) return [text]

  // 合并重叠区间（保留最后一个的颜色），并按起点排序
  const sorted = [...ranges]
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)

  const out: React.ReactNode[] = []
  let cursor = 0

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]
    const s0 = Math.max(0, Math.min(r.start, text.length))
    const e0 = Math.max(0, Math.min(r.end, text.length))
    if (e0 <= s0) continue

    if (s0 > cursor) out.push(text.slice(cursor, s0))

    // 与下一个区间重叠时，先渲染到重叠点
    const next = sorted[i + 1]
    const segEnd = next ? Math.min(e0, Math.max(s0, next.start)) : e0

    out.push(
      <mark
        key={`${keyPrefix}-${i}`}
        style={{
          background: `${r.color}66`,
          color: 'inherit',
          borderRadius: 2,
          padding: '0 1px',
        }}
      >{text.slice(s0, segEnd)}</mark>,
    )
    cursor = Math.max(cursor, segEnd)
  }

  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

/** 渲染含行内公式的段落，可选高亮区间 */
export default function RichText({
  text, highlights,
}: { text: string; highlights?: HighlightRange[] }) {
  const parts = useMemo(() => splitInlineMath(text), [text])

  // 不含公式且无需高亮：直接返回纯文本（避免无谓的 DOM 开销）
  if (parts.length === 1 && parts[0].type === 'text' && !highlights?.length) {
    return <>{text}</>
  }

  // 文本片段在原文中的字符偏移，用于把 highlights 映射到片段
  let cursor = 0
  const rendered: React.ReactNode[] = []

  parts.forEach((p, i) => {
    if (p.type === 'math') {
      // 公式在原文里占 $...$ 的字符数，这里用近似长度推进游标
      rendered.push(<InlineMath key={`m${i}`} latex={p.value} />)
      cursor += p.value.length
      return
    }

    const segStart = cursor
    const segEnd = segStart + p.value.length
    cursor = segEnd

    // 取出与该文本片段相交的高亮区间
    const local: HighlightRange[] = (highlights ?? [])
      .filter((h) => h.end > segStart && h.start < segEnd)
      .map((h) => ({
        start: Math.max(0, h.start - segStart),
        end: Math.min(p.value.length, h.end - segStart),
        color: h.color,
      }))

    rendered.push(
      <span key={`t${i}`}>
        {renderWithHighlights(p.value, local, `t${i}`)}
      </span>,
    )
  })

  return <>{rendered}</>
}
