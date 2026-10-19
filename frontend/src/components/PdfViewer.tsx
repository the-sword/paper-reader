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
import type { Annotation } from '../api/client'

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
        if (cancelled) return
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
        setLoading(false)
        try {
          const first = await pdf.getPage(1)
          const base = first.getViewport({ scale: 1 }).width
          if (!cancelled) onBaseWidth?.(base)
        } catch { /* 忽略 */ }
      })
      .catch((e) => {
        console.error('PDF 加载失败', e)
        setLoading(false)
      })

    return () => {
      cancelled = true
      void task.destroy()
      pdfRef.current = null
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

  const confirmHighlight = async () => {
    if (!bubble || !currentDoc) return
    await addAnnotation(currentDoc.id, bubble.page, bubble.rects, bubble.quote, color)
    setBubble(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div className="viewer-wrap" ref={wrapRef} onMouseUp={onMouseUp}>
      {loading && <div className="viewer-hint">正在加载 PDF…</div>}
      <div className="canvas-host" ref={hostRef} />
      {bubble && (
        <div className="sel-bubble" style={{ left: bubble.x, top: bubble.y }}>
          <div className="sel-quote">
            “{bubble.quote.slice(0, 60)}{bubble.quote.length > 60 ? '…' : ''}”
          </div>
          <div className="sel-actions">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`dot ${c === color ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`颜色 ${c}`}
              />
            ))}
            <button className="btn-primary" onClick={confirmHighlight}>高亮</button>
            <button className="btn-ghost" onClick={() => setBubble(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}
