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
import { useEffect, useMemo, useRef } from 'react'
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

/** 渲染含行内公式的段落 */
export default function RichText({ text }: { text: string }) {
  const parts = useMemo(() => splitInlineMath(text), [text])

  // 不含公式，直接返回纯文本（避免无谓的 DOM 开销）
  if (parts.length === 1 && parts[0].type === 'text') {
    return <>{text}</>
  }

  return (
    <>
      {parts.map((p, i) =>
        p.type === 'math'
          ? <InlineMath key={i} latex={p.value} />
          : <span key={i}>{p.value}</span>,
      )}
    </>
  )
}
