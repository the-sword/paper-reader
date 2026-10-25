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
import { clearStaleShellFlag, selfHealStaleShell } from '../lib/staleShell'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useStore } from '../stores/useStore'
import { api, type Annotation, type Reference } from '../api/client'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const COLORS = ['#ffd400', '#22c55e', '#3b82f6', '#ef4444', '#a855f7']

interface Props {
  url: string
  scale: number
  /** 文档加载后回调原始页面宽度（PDF pt，scale=1 时的宽度），用于「适应宽度」 */
  onBaseWidth?: (w: number) => void
  /** 双语页（左原文|右译文并排，页宽为原文 2 倍）。
   *  标注只允许落在原文列、统一存「原文页坐标系」：创建时把选区裁到
   *  左半 [0,0.5] 后 x*2 折回原页，渲染时 /2 画在原文半页，
   *  保证与 PDF 视图共用同一坐标系、互切不漂移。 */
  dualPage?: boolean
}

interface Bubble {
  x: number
  y: number
  page: number
  rects: number[][]
  /** 双语页选区锚定的半侧：source=原文列 / zh=译文列 */
  side?: 'source' | 'zh'
  quote: string
  /** 划词翻译结果（点「翻译」后填充） */
  translated?: string
  engine?: string
  latency?: number
  translating?: boolean
  transError?: string
}

// ---------------------------------------------------------------------------
// 引用标检测（参考文献气泡）
// 与 RichText.splitCitations 同一套规则：[1]、[1,2]、[3-6]，排除纯文字方括号
// ---------------------------------------------------------------------------
const CITE_RE = /\[(\d{1,3}(?:\s*[,\-–]\s*\d{1,3})*)\]/g

/** 把 "1,2"、"3-6" 展开成编号数组 */
function parseCiteNumbers(inner: string): number[] {
  const numbers: number[] = []
  for (const part of inner.split(',')) {
    const seg = part.trim()
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(seg)
    if (range) {
      const a = parseInt(range[1], 10)
      const b = parseInt(range[2], 10)
      if (b >= a && b - a < 30) {
        for (let i = a; i <= b; i++) numbers.push(i)
        continue
      }
    }
    const n = parseInt(seg, 10)
    if (!Number.isNaN(n)) numbers.push(n)
  }
  return numbers
}

/**
 * 判断 PDF 文本层点击位置是否落在引用标上。
 *
 * pdf.js 常把 "[12]" 拆进多个相邻 span，只看命中的那个 span 会漏，
 * 因此以命中节点为中心向前后兄弟 span 各扩展约 40 字符拼出上下文，
 * 再检查点击偏移是否落在某个 [n] 匹配内部。
 */
function citeNumbersAtPoint(clientX: number, clientY: number): number[] | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(clientX, clientY)
    if (r) { node = r.startContainer; offset = r.startOffset }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(clientX, clientY)
    if (p) { node = p.offsetNode; offset = p.offset }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null
  const span = (node as Text).parentElement
  if (!span?.closest('.textLayer')) return null

  const pieces: string[] = [span.textContent ?? '']
  let clickIdx = offset
  let prev = span.previousElementSibling
  let added = 0
  while (prev && added < 40) {
    const t = prev.textContent ?? ''
    pieces.unshift(t)
    clickIdx += t.length
    added += t.length
    prev = prev.previousElementSibling
  }
  let next = span.nextElementSibling
  added = 0
  while (next && added < 40) {
    const t = next.textContent ?? ''
    pieces.push(t)
    added += t.length
    next = next.nextElementSibling
  }
  const ctx = pieces.join('')

  CITE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CITE_RE.exec(ctx)) !== null) {
    if (m.index > clickIdx) break
    if (clickIdx <= m.index + m[0].length) {
      return parseCiteNumbers(m[1])
    }
  }
  return null
}

/**
 * 兜底：从 PDF 文本层自行提取参考文献。
 *
 * 后端参考文献表依赖 MinerU 解析（ref_text 段）。未解析/本地兜底解析的
 * 文献该表为空，这时直接从 PDF 末尾几页文本里找 References 区，
 * 按 [n] 标号切分出条目，功能不依赖解析管线。
 */
async function extractRefsFromPdf(pdf: PDFDocumentProxy): Promise<Record<number, Reference>> {
  const out: Record<number, Reference> = {}
  // 参考文献几乎总在末尾；多取几页覆盖长文献列表
  const start = Math.max(1, pdf.numPages - 7)
  let tail = ''
  for (let p = start; p <= pdf.numPages; p++) {
    try {
      const page = await pdf.getPage(p)
      const tc = await page.getTextContent()
      for (const it of tc.items as Array<{ str: string }>) tail += it.str + ' '
    } catch { /* 单页失败不阻断 */ }
  }
  const m = /\b(references|bibliography)\b/i.exec(tail)
  if (!m) return out

  const body = tail.slice(m.index + m[0].length)
  // 按 [n] 标号切分条目；兼容 "n." 形式留给以后再扩
  const marks: Array<{ n: number; i: number }> = []
  const re = /\[(\d{1,3})\]/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(body)) !== null && marks.length < 300) {
    marks.push({ n: parseInt(mm[1], 10), i: mm.index })
  }
  for (let k = 0; k < marks.length; k++) {
    const { n, i } = marks[k]
    const end = k + 1 < marks.length ? marks[k + 1].i : Math.min(body.length, i + 1200)
    const text = body.slice(i + body.slice(i).indexOf(']') + 1, end)
      .replace(/\s+/g, ' ').trim()
    // 序号应按 1,2,3… 递增才可信；过滤正文里偶然的 [n]（如公式编号）
    if (text.length < 15 || n in out) continue
    if (marks.length > 2 && k > 0 && n !== marks[k - 1].n + 1 && !(n in out)) continue
    const yearM = /\b(19|20)\d{2}\b/.exec(text)
    out[n] = {
      no: n, idx: 0, text, authors: '',
      title: text.slice(0, 180),
      year: yearM ? parseInt(yearM[0], 10) : null,
      venue: '',
    }
  }
  return out
}

export default function PdfViewer({ url, scale, onBaseWidth, dualPage = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)

  const currentDoc = useStore((s) => s.currentDoc)
  const annotations = useStore((s) => s.annotations)
  const addAnnotation = useStore((s) => s.addAnnotation)
  const removeAnnotation = useStore((s) => s.removeAnnotation)

  const [numPages, setNumPages] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [color, setColor] = useState(COLORS[0])

  // 虚拟化渲染：页面渲染完成时才创建标注层，
  // 渲染回调里需要拿到最新 annotations（不能闭包捕获旧值）
  const annotationsRef = useRef<Annotation[]>(annotations)
  annotationsRef.current = annotations

  // ---- 参考文献气泡（点击正文 [n] 引用标）----
  const [refs, setRefs] = useState<Record<number, Reference>>({})
  // refsStatus 区分三种情况：加载中 / 加载失败（可重试）/ 已加载（可能为空表）
  const [refsStatus, setRefsStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [citePopup, setCitePopup] = useState<{
    x: number; y: number; numbers: number[]
  } | null>(null)

  /** 拉取该文献的参考文献表；失败标记 error，点击引用标时可重试 */
  const loadRefs = useCallback(() => {
    const docId = useStore.getState().currentDoc?.id
    if (!docId) return
    setRefsStatus('loading')
    void api.getReferences(docId).then(async (r) => {
      const map: Record<number, Reference> = {}
      for (const x of r.references) map[x.no] = x
      // 后端没有（未走 MinerU 解析）→ 从 PDF 自身文本兜底提取
      if (!Object.keys(map).length && pdfRef.current) {
        const fb = await extractRefsFromPdf(pdfRef.current).catch(() => ({}))
        Object.assign(map, fb)
      }
      setRefs(map)
      setRefsStatus('ok')
    }).catch(() => setRefsStatus('error'))
  }, [])

  // 参考文献表来自 MinerU 解析出的 segments，切换文档时预取；
  // 等 numPages 就绪才跑（兜底提取需要 pdfRef.current 已加载）
  useEffect(() => {
    setCitePopup(null)
    setRefs({})
    if (!currentDoc) { setRefsStatus('idle'); return }
    loadRefs()
  }, [currentDoc?.id, numPages, loadRefs])

  // ---- 加载文档 ----
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setNumPages(0)
    if (hostRef.current) hostRef.current.innerHTML = ''

    const task = pdfjsLib.getDocument(url)
    task.promise
      .then(async (pdf) => {
        if (cancelled) { void pdf.destroy(); return }
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
        setLoading(false)
        clearStaleShellFlag()
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
        // 旧外壳自愈：发新版后长驻标签页请求已删除的 hash 资产（pdf.js worker
        // 404 → "Setting up fake worker failed"），刷新一次拿新外壳即恢复
        if (selfHealStaleShell(e)) return
        setLoadError(String(e).replace(/^Error:\s*/, ''))
      })

    return () => {
      cancelled = true
      const pdf = pdfRef.current
      pdfRef.current = null
      if (pdf) void pdf.destroy()
      void task.destroy().catch(() => { /* 忽略重复销毁 */ })
    }
  }, [url, onBaseWidth])

  // ---- 优先级渲染队列 ----
  // 同步建好全部页面占位（正确的宽高 → 滚动条立即稳定、首屏立即可交互），
  // 所有页按文档顺序进队列后台渲染（最多 2 页并行）；
  // 进入视口附近（前后 2 屏）的页插队到队首优先渲染。
  // 效果：首屏快 + 滚动到任何位置内容都大概率已就绪，不再顿挫。
  useEffect(() => {
    if (!numPages || !hostRef.current) return
    const pdf = pdfRef.current
    if (!pdf) return

    const host = hostRef.current
    let cancelled = false
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    // pdf.js 文本层 span 用 calc(var(--scale-factor) * N px) 定位，
    // 必须在页面容器上声明该变量，否则定位整体漂移（框选错位）
    host.style.setProperty('--scale-factor', String(scale))

    // --- 渲染队列：全部页按文档顺序后台渲染，进入视口的页插队到队首；
    //     最多 2 页并行（pdf.js worker 本就串行，再开多只会互相争抢）。
    //     对比旧实现：占位页让滚动高度立即可用 + 可视区永远优先渲染 ---
    const pending: HTMLElement[] = []
    const inFlight = new Set<number>()

    const queuePage = (el: HTMLElement, urgent = false) => {
      if (el.dataset.rendered || inFlight.has(Number(el.dataset.page))) return
      const idx = pending.indexOf(el)
      if (urgent) {
        if (idx >= 0) pending.splice(idx, 1)
        pending.unshift(el)
      } else if (idx < 0) {
        pending.push(el)
      }
      scheduleDrain()
    }

    const scheduleDrain = () => {
      if (cancelled) return
      while (inFlight.size < 2 && pending.length) {
        const el = pending.shift()!
        const pageNum = Number(el.dataset.page)
        if (el.dataset.rendered) continue
        inFlight.add(pageNum)
        void renderPage(el, pageNum).finally(() => {
          inFlight.delete(pageNum)
          scheduleDrain()
        })
      }
    }

    /** 单页完整渲染（canvas + 文本层 + 选区哨兵）；幂等，渲染过即跳过 */
    const renderPage = async (pageEl: HTMLElement, pageNum: number) => {
      if (pageEl.dataset.rendered) return
      pageEl.dataset.rendered = '1'
      try {
        const page = await pdf.getPage(pageNum)
        if (cancelled) return
        const vp = page.getViewport({ scale })

        // 用本页真实视口回写占位盒尺寸：占位值按首页近似尺寸建立，
        // 页面尺寸不一致（混合尺寸/扫描件）或比例变化时，不回写会
        // 造成内容比白纸盒宽/窄的错位
        pageEl.style.width = `${vp.width}px`
        pageEl.style.height = `${vp.height}px`
        delete pageEl.dataset.needSize

        // 1) canvas
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(vp.width * ratio)
        canvas.height = Math.floor(vp.height * ratio)
        canvas.style.width = `${vp.width}px`
        canvas.style.height = `${vp.height}px`
        pageEl.appendChild(canvas)

        // 2) 透明文本层（可选中）
        const textLayerEl = document.createElement('div')
        textLayerEl.className = 'textLayer'
        pageEl.appendChild(textLayerEl)

        // 3) 标注层
        const annLayer = document.createElement('div')
        annLayer.className = 'ann-layer'
        annLayer.dataset.page = String(pageNum)
        pageEl.appendChild(annLayer)

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

        // 官方 viewer 的选区哨兵：框选下移越过页面底边时不跳回页首
        const eoc = document.createElement('div')
        eoc.className = 'endOfContent'
        textLayerEl.appendChild(eoc)

        // 标注要在该页渲染完成后补上（虚拟化后标注层随渲染创建）
        drawPageAnnotations(annLayer, pageNum)
      } catch (e) {
        // 渲染中断（组件卸载/快速缩放）时撤销标记，下次进入视口可重试
        pageEl.dataset.rendered = ''
        if (!cancelled) console.error(`第 ${pageNum} 页渲染失败`, e)
      }
    }

    /** 绘制指定页的标注（虚拟化后标注层随渲染才存在）。
     *  双语页按 side 画到对应半页：source 折半画左半原文列，
     *  zh 折半偏移画右半译文列；单页视图都画原文位置 */
    const annX = (x: number, side?: string) =>
      (dualPage ? (side === 'zh' ? 0.5 + x / 2 : x / 2) : x) * 100
    const drawPageAnnotations = (layer: HTMLElement, pageNum: number) => {
      const anns = annotationsRef.current.filter((a) => a.page === pageNum)
      for (const a of anns) {
        for (const r of a.rects) {
          const el = document.createElement('div')
          el.className = 'ann-rect'
          el.title = `${a.quote ?? ''}${a.comment ? `\n\n${a.comment}` : ''}`
          el.style.left = `${annX(r[0], a.side)}%`
          el.style.top = `${r[1] * 100}%`
          el.style.width = `${annX(r[2], a.side) - annX(r[0], a.side)}%`
          el.style.height = `${(r[3] - r[1]) * 100}%`
          el.style.borderBottom = `2px solid ${a.color}`
          el.dataset.annId = a.id
          el.addEventListener('dblclick', () => { void removeAnnotation(a.id) })
          layer.appendChild(el)
        }
      }
    }

    const setup = async () => {
      host.innerHTML = ''
      // 第一遍：同步建占位页。首页尺寸先渲染出来再定其余页的占位高度，
      // 避免逐页 await getPage 造成长文档首屏白屏数秒。
      let firstVpW = 612
      let firstVpH = 792
      try {
        const p1 = await pdf.getPage(1)
        const v1 = p1.getViewport({ scale: 1 })
        firstVpW = v1.width
        firstVpH = v1.height
      } catch { /* 用默认尺寸兜底 */ }
      if (cancelled) return

      const pageEls: HTMLElement[] = []
      for (let i = 1; i <= numPages; i++) {
        const pageEl = document.createElement('div')
        pageEl.className = 'pdf-page pdf-page-placeholder'
        pageEl.dataset.page = String(i)
        // 近似尺寸：同文档页面绝大多数一致（双语 PDF 尤其如此）。
        // 真实视口在渲染该页时以实际尺寸为准替换占位样式。
        pageEl.style.width = `${firstVpW * scale}px`
        pageEl.style.height = `${firstVpH * scale}px`
        pageEl.dataset.needSize = '1'
        host.appendChild(pageEl)
        pageEls.push(pageEl)
      }

      // IntersectionObserver：进入视口前后 2 屏即渲染（可见区优先出队）
      const io = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue
            const el = en.target as HTMLElement
            io.unobserve(el)
            queuePage(el, true)
          }
        },
        { root: null, rootMargin: '200% 0px' },
      )
      pageEls.forEach((el) => io.observe(el))
      ;(host as HTMLElement & { __pageIO?: IntersectionObserver }).__pageIO = io

      // 全部页按文档顺序进队后台渲染；IO 命中的可见页会插队到队首优先出队
      pageEls.forEach((el) => queuePage(el))
    }

    void setup()
    return () => {
      cancelled = true
      ;(host as HTMLElement & { __pageIO?: IntersectionObserver }).__pageIO?.disconnect()
    }
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
      const annX = (x: number, side?: string) =>
        (dualPage ? (side === 'zh' ? 0.5 + x / 2 : x / 2) : x) * 100
      for (const a of anns) {
        for (const r of a.rects) {
          const el = document.createElement('div')
          el.className = 'ann-rect'
          el.title = `${a.quote ?? ''}${a.comment ? `\n\n${a.comment}` : ''}`
          el.style.left = `${annX(r[0], a.side)}%`
          el.style.top = `${r[1] * 100}%`
          el.style.width = `${annX(r[2], a.side) - annX(r[0], a.side)}%`
          el.style.height = `${(r[3] - r[1]) * 100}%`
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
      // 裁掉超出页面的部分（先保留页内 x，半侧归类在后面统一做）
      const x1 = Math.max(0, Math.min(1, (r.left - pr.left) / pr.width))
      const x2 = Math.max(0, Math.min(1, (r.right - pr.left) / pr.width))
      const y1 = Math.max(0, Math.min(1, (r.top - pr.top) / pr.height))
      const y2 = Math.max(0, Math.min(1, (r.bottom - pr.top) / pr.height))
      if (x2 - x1 < 0.001 || y2 - y1 < 0.001) continue
      rects.push([x1, y1, x2, y2])
    }

    if (!rects.length || !anchorPage) { setBubble(null); return }

    // 双语页：按选区锚定半侧（第一个矩形中心）归到 source/zh；
    // 坐标统一折回原文页空间——原文列 x*2，译文列 (x-0.5)*2（版式镜像）；
    // 横跨中缝混入另一侧的矩形丢弃，保证一条标注只含一种半侧
    let side: 'source' | 'zh' = 'source'
    if (dualPage) {
      const f = rects[0]
      side = (f[0] + f[2]) / 2 > 0.5 ? 'zh' : 'source'
      const lx = (x: number) =>
        Math.max(0, Math.min(1, side === 'zh' ? (x - 0.5) * 2 : x * 2))
      const mapped = rects
        .filter((r) => ((r[0] + r[2]) / 2 > 0.5) === (side === 'zh'))
        .map((r) => [lx(r[0]), r[1], lx(r[2]), r[3]] as number[])
        .filter((r) => r[2] - r[0] > 0.001)
      if (!mapped.length) { setBubble(null); return }
      rects.splice(0, rects.length, ...mapped)
    }

    // 同一视觉行常被 getClientRects 拆成多个内联片段矩形（粗体/引用/行高
    // 不同的 span 边界），各自画线会出现「一行两条下划线」；垂直重叠过半
    // 的矩形属于同一行，合并为并集只画一条。放在半侧过滤之后，避免双语页
    // 左右两列的同行矩形被并成跨中缝的大矩形
    rects.sort((a, b) => a[1] - b[1])
    const merged: number[][] = []
    for (const r of rects) {
      const last = merged[merged.length - 1]
      const ov = last
        ? Math.min(last[3], r[3]) - Math.max(last[1], r[1])
        : -1
      if (last && ov > Math.min(last[3] - last[1], r[3] - r[1]) * 0.5) {
        last[0] = Math.min(last[0], r[0]); last[1] = Math.min(last[1], r[1])
        last[2] = Math.max(last[2], r[2]); last[3] = Math.max(last[3], r[3])
      } else {
        merged.push([...r])
      }
    }
    rects.splice(0, rects.length, ...merged)

    const first = range.getClientRects()[0]
    setBubble({
      x: first.left + first.width / 2,
      y: first.top - 12,
      page: anchorPage,
      rects,
      side,
      quote: sel.toString().trim().slice(0, 2000),
    })
  }, [dualPage])

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
    await addAnnotation(currentDoc.id, bubble.page, bubble.rects, bubble.quote, color,
      { side: bubble.side ?? 'source' })
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
      onClick={(e) => {
        // 弹层内部点击不处理（自行 stopPropagation，这里兜底）
        if ((e.target as HTMLElement).closest('.cite-popup')) return
        // 刚框选完（选区未折叠）不触发引用查询，等下一次单击
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed) return
        const numbers = citeNumbersAtPoint(e.clientX, e.clientY)
        if (numbers?.length) {
          setBubble(null)
          // 表为空（首次加载失败/尚未触发）时点击即重试，不等下一次切文档
          if (!Object.keys(refs).length && refsStatus !== 'loading') loadRefs()
          setCitePopup({
            // 稍微右移避开弹层水平居中后的遮挡，并防止贴右边缘溢出
            x: Math.min(e.clientX, window.innerWidth - 230),
            y: e.clientY + 8,
            numbers,
          })
        } else {
          setCitePopup(null)
        }
      }}
    >
      {loading && <div className="viewer-hint">正在加载 PDF…</div>}
      {loadError && (
        <div className="viewer-hint" style={{ padding: '48px 24px', textAlign: 'center', lineHeight: 2 }}>
          <div style={{ color: 'var(--fg-strong)', fontWeight: 600, marginBottom: 6 }}>无法加载 PDF</div>
          <div style={{ fontSize: 12, wordBreak: 'break-all', maxWidth: 520, margin: '0 auto' }}>{loadError}</div>
          <button
            className="btn-primary" style={{ marginTop: 14, fontSize: 12, padding: '6px 16px' }}
            onClick={() => { setLoadError(null); window.location.reload() }}
          >
            刷新重试
          </button>
        </div>
      )}
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

      {/* 参考文献弹层：点击正文 [n] 引用标弹出（与原双语阅读页同款） */}
      {citePopup && (
        <div
          className="cite-popup"
          style={{ position: 'fixed', left: citePopup.x, top: citePopup.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {refsStatus === 'loading' && (
            <div className="hint">正在加载参考文献…</div>
          )}
          {refsStatus === 'error' && (
            <div className="hint">参考文献加载失败，点击引用标重试</div>
          )}
          {refsStatus === 'ok' && !Object.keys(refs).length && (
            <div className="hint">该文献未识别到参考文献列表</div>
          )}
          {citePopup.numbers.map((n) => {
            const ref = refs[n]
            return (
              <div key={n} className="cite-item">
                {ref ? (
                  <>
                    <div className="cite-no">[{n}]</div>
                    <div className="cite-body">
                      <div className="cite-title">{ref.title || ref.text.slice(0, 120)}</div>
                      {ref.authors && <div className="cite-authors">{ref.authors}</div>}
                      <div className="cite-meta">
                        {ref.year ?? ''}{ref.venue ? ` · ${ref.venue}` : ''}
                      </div>
                    </div>
                  </>
                ) : (
                  refsStatus === 'ok' && Object.keys(refs).length > 0 && (
                    <div className="cite-body">
                      <div className="cite-title">[{n}] 未在该文献的参考文献列表中找到</div>
                    </div>
                  )
                )}
              </div>
            )
          })}
          <button className="btn-ghost cite-close" onClick={() => setCitePopup(null)}>✕</button>
        </div>
      )}
    </div>
  )
}
