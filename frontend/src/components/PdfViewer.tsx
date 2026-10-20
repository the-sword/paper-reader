/**
 * PDF 阅读器：canvas 渲染 + 透明文本层（可选中）+ 标注层 + 选区气泡。
 *
 * 坐标约定（解决 R3 缩放漂移）：
 *   存储的 rect 一律是「归一化到页面宽高 0-1」，渲染时乘以页面元素尺寸。
 *   缩放 / DPI / 窗口变化都不会让标注漂移。
 *
 * 为什么必须有 TextLayer：
 *   canvas 画出来的文字不是 DOM，鼠标选不中。pdf.js 的 TextLayer 把文字以
 *   透明 DOM 叠在 canvas 上，才能实现「选中原文 → 高亮」和后续的划词翻译。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useStore } from '../stores/useStore'
import { api, type Annotation } from '../api/client'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const COLORS = ['#ffd400', '#22c55e', '#3b82f6', '#ef4444', '#a855f7']

interface Props {
  url: string
  scale: number
  /** 文档加载后回调原始页面宽度（PDF pt，scale=1 时的宽度），用于「适应宽度」 */
  onBaseWidth?: (w: number) => void
}

interface Bubble {
  x: number
  y: number
  page: number
  rects: number[][]
  quote: string
  /** 划词翻译结果（点「翻译」后填充） */
  translated?: string
  engine?: string
  latency?: number
  translating?: boolean
  transError?: string
}

export default function PdfViewer({ url, scale, onBaseWidth }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)

  const currentDoc = useStore((s) => s.currentDoc)
  const annotations = useStore((s) => s.annotations)
  const addAnnotation = useStore((s) => s.addAnnotation)
  const removeAnnotation = useStore((s) => s.removeAnnotation)

  const [numPages, setNumPages] = useState(0)
  const [loading, setLoading] = useState(false)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [color, setColor] = useState(COLORS[0])

  // ---- 加载文档 ----
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setNumPages(0)
    if (hostRef.current) hostRef.current.innerHTML = ''

    const task = pdfjsLib.getDocument(url)
    task.promise
      .then(async (pdf) => {
        if (cancelled) { void pdf.destroy(); return }
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
        setLoading(false)
        try {
          const first = await pdf.getPage(1)
          const base = first.getViewport({ scale: 1 }).width
          if (!cancelled) onBaseWidth?.(base)
        } catch { /* 忽略 */ }
      })
      .catch((e: unknown) => {
        // 卸载时主动 destroy 会抛出 "Worker was destroyed"，属于预期行为，不当作错误
        if (cancelled) return
        console.error('PDF 加载失败', e)
        setLoading(false)
      })

    return () => {
      cancelled = true
      const pdf = pdfRef.current
      pdfRef.current = null
      if (pdf) void pdf.destroy()
      void task.destroy().catch(() => { /* 忽略重复销毁 */ })
    }
  }, [url, onBaseWidth])

  // ---- 逐页渲染 ----
  useEffect(() => {
    if (!numPages || !hostRef.current) return
    const pdf = pdfRef.current
    if (!pdf) return

    const host = hostRef.current
    let cancelled = false

    const run = async () => {
      host.innerHTML = ''
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      // pdf.js 文本层 span 用 calc(var(--scale-factor) * N px) 定位，
      // 必须在每个页面容器上声明该变量，否则定位整体漂移（框选错位）
      host.style.setProperty('--scale-factor', String(scale))

      for (let i = 1; i <= numPages; i++) {
        if (cancelled) return
        const page = await pdf.getPage(i)
        const vp = page.getViewport({ scale })

        const pageEl = document.createElement('div')
        pageEl.className = 'pdf-page'
        pageEl.dataset.page = String(i)
        pageEl.style.width = `${vp.width}px`
        pageEl.style.height = `${vp.height}px`

        // 1) canvas 渲染
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(vp.width * ratio)
        canvas.height = Math.floor(vp.height * ratio)
        canvas.style.width = `${vp.width}px`
        canvas.style.height = `${vp.height}px`
        pageEl.appendChild(canvas)

        // 2) 透明文本层（可选中）
        const textLayerEl = document.createElement('div')
        textLayerEl.className = 'textLayer'
        textLayerEl.style.width = `${vp.width}px`
        textLayerEl.style.height = `${vp.height}px`
        pageEl.appendChild(textLayerEl)

        // 3) 标注层
        const annLayer = document.createElement('div')
        annLayer.className = 'ann-layer'
        annLayer.dataset.page = String(i)
        pageEl.appendChild(annLayer)

        host.appendChild(pageEl)

        await page.render({
          canvasContext: canvas.getContext('2d')!,
          viewport: vp,
          canvas,
        } as never).promise

        if (cancelled) return

        const textContent = await page.getTextContent()
        const textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerEl,
          viewport: vp,
        })
        await textLayer.render()

        // 官方 viewer 的选区哨兵：位于页面底部下方的不可选元素。
        // 框选下移越过页面底边时先命中它，浏览器就不会把选区锚点跳回页首
        const eoc = document.createElement('div')
        eoc.className = 'endOfContent'
        textLayerEl.appendChild(eoc)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [numPages, scale])

  // ---- 标注绘制 ----
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.querySelectorAll<HTMLElement>('.ann-layer').forEach((l) => (l.innerHTML = ''))

    const byPage: Record<number, Annotation[]> = {}
    for (const a of annotations) (byPage[a.page] ||= []).push(a)

    for (const [pageStr, anns] of Object.entries(byPage)) {
      const layer = host.querySelector<HTMLElement>(`.ann-layer[data-page="${pageStr}"]`)
      if (!layer) continue
      for (const a of anns) {
        for (const r of a.rects) {
          const el = document.createElement('div')
          el.className = 'ann-rect'
          el.title = `${a.quote ?? ''}${a.comment ? `\n\n${a.comment}` : ''}`
          el.style.left = `${r[0] * 100}%`
          el.style.top = `${r[1] * 100}%`
          el.style.width = `${(r[2] - r[0]) * 100}%`
          el.style.height = `${(r[3] - r[1]) * 100}%`
          el.style.background = `${a.color}59`
          el.style.borderBottom = `2px solid ${a.color}`
          el.dataset.annId = a.id
          el.addEventListener('dblclick', () => { void removeAnnotation(a.id) })
          layer.appendChild(el)
        }
      }
    }
  }, [annotations, numPages, scale, removeAnnotation])

  // ---- 文本选区 → 气泡 ----
  /** 选区结束/取消后移除所有文本层的 .selecting，恢复 endOfContent 哨兵位置 */
  const clearSelecting = (root: HTMLElement | null) => {
    if (!root) return
    root.querySelectorAll<HTMLElement>('.textLayer.selecting').forEach((l) => l.classList.remove('selecting'))
  }

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) { setBubble(null); return }

    const range = sel.getRangeAt(0)
    const rects: number[][] = []
    let anchorPage = 0

    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue

      // 找最近的 .pdf-page 祖先
      let node: Node | null = range.commonAncestorContainer
      if (node.nodeType === 3) node = node.parentNode
      let pageEl: HTMLElement | null = null
      while (node && node !== document.body) {
        if (node.nodeType === 1 && (node as HTMLElement).classList?.contains('pdf-page')) {
          pageEl = node as HTMLElement
          break
        }
        node = node.parentNode
      }
      if (!pageEl) continue

      const pageNum = Number(pageEl.dataset.page)
      if (anchorPage && pageNum !== anchorPage) continue // 暂不支持跨页选区
      anchorPage = pageNum

      const pr = pageEl.getBoundingClientRect()
      // 裁掉超出页面的部分
      const x1 = Math.max(0, Math.min(1, (r.left - pr.left) / pr.width))
      const x2 = Math.max(0, Math.min(1, (r.right - pr.left) / pr.width))
      const y1 = Math.max(0, Math.min(1, (r.top - pr.top) / pr.height))
      const y2 = Math.max(0, Math.min(1, (r.bottom - pr.top) / pr.height))
      if (x2 - x1 < 0.001 || y2 - y1 < 0.001) continue
      rects.push([x1, y1, x2, y2])
    }

    if (!rects.length || !anchorPage) { setBubble(null); return }

    const first = range.getClientRects()[0]
    setBubble({
      x: first.left + first.width / 2,
      y: first.top - 12,
      page: anchorPage,
      rects,
      quote: sel.toString().trim().slice(0, 2000),
    })
  }, [])

  /** 划词翻译（手动触发） */
  const translateSelection = async () => {
    const b = bubble
    if (!b || b.translated || b.translating) return
    setBubble({ ...b, translating: true, transError: undefined })
    try {
      const engine = useStore.getState().selectedEngine
      const r = await api.translateTerm(b.quote, engine)
      setBubble((cur) =>
        cur && cur.quote === b.quote
          ? { ...cur, translated: r.text, engine: r.engine,
              latency: r.latency_ms, translating: false }
          : cur,
      )
    } catch (e) {
      setBubble((cur) =>
        cur && cur.quote === b.quote
          ? { ...cur, translating: false, transError: String(e).replace(/^Error:\s*/, '') }
          : cur,
      )
    }
  }

  const confirmHighlight = async () => {
    if (!bubble || !currentDoc) return
    await addAnnotation(currentDoc.id, bubble.page, bubble.rects, bubble.quote, color)
    setBubble(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      className="viewer-wrap"
      ref={wrapRef}
      onMouseUp={(e) => { clearSelecting(e.currentTarget); onMouseUp() }}
      onMouseDown={(e) => {
        // 框选期间给文本层加 .selecting（官方 viewer 同款）：
        // 让 endOfContent 哨兵覆盖整页，向下框选时选区不跳回页首
        e.currentTarget.querySelectorAll<HTMLElement>('.textLayer.selecting').forEach((l) => l.classList.remove('selecting'))
        const layer = (e.target as HTMLElement).closest('.textLayer')
        layer?.classList.add('selecting')
      }}
    >
      {loading && <div className="viewer-hint">正在加载 PDF…</div>}
      <div className="canvas-host" ref={hostRef} />
      {bubble && (
        <div className="sel-bubble" style={{ left: bubble.x, top: bubble.y }}>
          <div className="sel-quote">
            “{bubble.quote.slice(0, 60)}{bubble.quote.length > 60 ? '…' : ''}”
          </div>
          {/* 划词翻译结果 */}
          {bubble.translating && (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>翻译中…</div>
          )}
          {bubble.translated && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fg-strong)' }}>
                {bubble.translated}
              </div>
              <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 3 }}>
                {bubble.engine}
                {bubble.latency ? ` · ${bubble.latency}ms` : ''}
              </div>
            </div>
          )}
          {bubble.transError && (
            <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 6 }}>
              {bubble.transError}
            </div>
          )}

          <div className="sel-actions">
            {!bubble.translated && !bubble.translating && (
              <button className="btn-primary" style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={() => void translateSelection()}>翻译</button>
            )}
            {COLORS.map((c) => (
              <button
                key={c}
                className={`dot ${c === color ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`颜色 ${c}`}
              />
            ))}
            <button className="btn-ghost" onClick={confirmHighlight}>高亮</button>
            <button className="btn-ghost" onClick={() => setBubble(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}
