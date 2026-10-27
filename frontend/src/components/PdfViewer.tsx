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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearStaleShellFlag, selfHealStaleShell } from '../lib/staleShell'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useStore } from '../stores/useStore'
import { api, type Annotation, type Reference } from '../api/client'
import { ANNOTATION_COLORS } from '../lib/annotationColors'
import { setRegisteredPdf, deleteRegisteredPdf } from '../lib/pdfRegistry'
import { Icon, PATH_CHAT, PATH_SPARKLE } from './icons'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/** 划词菜单：宽 340px（与 CSS 一致），水平钳制留 8px 边距 */
const BUBBLE_HALF_W = 170
const BUBBLE_EDGE = 8
/** 选区顶部低于该视口高度时，菜单翻到选区下方 */
const BUBBLE_FLIP_TOP = 120
/** 「已复制」反馈的显示时长（毫秒） */
const COPY_FEEDBACK_MS = 1200
/** 页边批注标记：同页内 top 相差小于页高该比例的标注合并为一个标记 */
const NOTE_MERGE_RATIO = 0.01
/** 标记距页面右缘的间距与宽度估计（px），用于判断放页外还是页内 */
const NOTE_MARKER_GAP = 6
const NOTE_MARKER_W = 34
const NOTE_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${PATH_CHAT}"/></svg>`

/** 选区 selectionchange 之后等待的防抖时长（毫秒），避免拖动手柄时频繁重算 */
const SELECTION_DEBOUNCE_MS = 350

/** 是否为触屏主输入（粗指针）设备 */
function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
}

/**
 * 页面完整几何：译文视图下页元素只是右半裁剪盒（宽 P），
 * 完整页宽为 2P 且左移 P，选区换算与标注坐标都以完整页为准
 */
function fullPageRect(el: HTMLElement, half: boolean): { left: number; top: number; width: number; height: number } {
  const b = el.getBoundingClientRect()
  if (!half) return { left: b.left, top: b.top, width: b.width, height: b.height }
  return { left: b.left - b.width, top: b.top, width: b.width * 2, height: b.height }
}

/** 键盘事件是否落在可输入元素上（此时不响应单键快捷键） */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

interface NoteMarkerGroup {
  top: number
  ids: string[]
  color: string
}

/** 按纵向位置合并有批注的标注：同一位置多条合并为一个标记 */
function groupNoteMarkers(anns: Annotation[]): NoteMarkerGroup[] {
  const items = anns
    .filter((a) => a.comment && a.rects.length)
    .map((a) => ({ top: a.rects[0][1], id: a.id, color: a.color }))
    .sort((x, y) => x.top - y.top)
  const groups: NoteMarkerGroup[] = []
  for (const it of items) {
    const last = groups[groups.length - 1]
    if (last && it.top - last.top < NOTE_MERGE_RATIO) last.ids.push(it.id)
    else groups.push({ top: it.top, ids: [it.id], color: it.color })
  }
  return groups
}

/** 在标注层上画页边批注标记：优先贴页面右缘外侧，空间不足则放页内右侧 */
function appendNoteMarkers(layer: HTMLElement, anns: Annotation[], onClick: (id: string) => void): void {
  const groups = groupNoteMarkers(anns)
  if (!groups.length) return
  const pageEl = layer.parentElement
  const mainRight = layer.closest('main')?.getBoundingClientRect().right ?? Infinity
  const outside = !pageEl || pageEl.getBoundingClientRect().right + NOTE_MARKER_GAP + NOTE_MARKER_W <= mainRight
  for (const g of groups) {
    const el = document.createElement('div')
    el.className = `ann-note-marker${outside ? '' : ' inside'}`
    el.style.top = `${g.top * 100}%`
    el.style.color = g.color
    el.style.borderColor = g.color
    el.style.background = `${g.color}26`
    if (g.ids.length > 1) el.textContent = String(g.ids.length)
    else el.innerHTML = NOTE_ICON
    el.title = '查看笔记'
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(g.ids[0]) })
    layer.appendChild(el)
  }
}

interface Props {
  url: string
  /** url 对应的文档 id：共享注册表（pdfRegistry）的键，须与 url 同源传入 */
  docId?: string
  scale: number
  /** 文档加载后回调原始页面宽度（PDF pt，scale=1 时的宽度），用于「适应宽度」 */
  onBaseWidth?: (w: number) => void
  /** 双语页（左原文|右译文并排，页宽为原文 2 倍）。
   *  标注只允许落在原文列、统一存「原文页坐标系」：创建时把选区裁到
   *  左半 [0,0.5] 后 x*2 折回原页，渲染时 /2 画在原文半页，
   *  保证与 PDF 视图共用同一坐标系、互切不漂移。 */
  dualPage?: boolean
  /** 译文视图：双语 PDF 只露出右半译文列（隐含 dualPage 的坐标约定） */
  halfView?: 'zh'
}

interface Bubble {
  x: number
  y: number
  /** 菜单是否翻到选区下方 */
  below: boolean
  /** 小三角相对菜单左缘的水平位置（px） */
  arrowX: number
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
  /** 「复制」按钮的短暂反馈 */
  copied?: boolean
  /** 触屏停靠模式：固定在屏幕底部 */
  docked?: boolean
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

export default function PdfViewer({ url, docId, scale, onBaseWidth, dualPage = false, halfView }: Props) {
  /** 译文视图：页元素为半宽裁剪盒，完整几何仍按双栏页计算 */
  const halfMode = halfView === 'zh'
  /** 双栏坐标约定（双语与译文视图共用：右半列为译文） */
  const dualLike = dualPage || halfMode
  /** 触屏设备：划词菜单停靠屏幕底部，不跟随选区 */
  const coarse = useMemo(() => isCoarsePointer(), [])
  // 异步回调里读取最新的译文模式（加载 effect 不依赖它，避免切换视图时重新下载 PDF）
  const halfRef = useRef(halfMode)
  halfRef.current = halfMode
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
  // 设备像素比进 state：浏览器页面缩放 / 跨显示器拖动 / 系统缩放会让
  // devicePixelRatio 变化，旧位图被拉伸即发虚——监听后触发整页重渲染
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    const check = () => {
      const cur = window.devicePixelRatio || 1
      setDpr((prev) => (prev !== cur ? cur : prev))
    }
    let mq: MediaQueryList | null = null
    const onChange = () => { check(); watch() }
    const watch = () => {
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mq.addEventListener('change', onChange, { once: true })
    }
    watch()
    // resize 兜底：浏览器页面缩放必触发；matchMedia 的 resolution
    // 变化在部分环境（CDP 模拟/个别内核）不派发事件
    window.addEventListener('resize', check)
    return () => {
      mq?.removeEventListener('change', onChange)
      window.removeEventListener('resize', check)
    }
  }, [])

  // 虚拟化渲染：页面渲染完成时才创建标注层，
  // 渲染回调里需要拿到最新 annotations（不能闭包捕获旧值）
  const annotationsRef = useRef<Annotation[]>(annotations)
  annotationsRef.current = annotations
  // 页边批注标记的点击回调：渲染回调里拿最新 store 动作，避免闭包过期
  const markerClickRef = useRef<(id: string) => void>(() => {})
  markerClickRef.current = (id) => {
    useStore.getState().openRight('notes')
    useStore.getState().setFocusAnnotation(id)
  }
  const askAI = useStore((s) => s.askAI)
  const openRight = useStore((s) => s.openRight)
  const setFocusAnnotation = useStore((s) => s.setFocusAnnotation)

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
        // 注册到共享表：usePdfOutline 等复用同一实例，避免同一份 PDF 下载两遍。
        // 键用 props.docId（与 url 同一 effect 闭包），不用实时 currentDoc——
        // 快速切文档时后者可能已指向新文档，会把实例注册到错误的键
        if (docId) setRegisteredPdf(docId, pdf)
        setNumPages(pdf.numPages)
        setLoading(false)
        clearStaleShellFlag()
        try {
          const first = await pdf.getPage(1)
          const base = first.getViewport({ scale: 1 }).width
          if (!cancelled) onBaseWidth?.(halfRef.current ? base / 2 : base)
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
      // 先从共享表注销（通知目录 hook 等订阅者），再销毁实例
      if (docId && pdf) deleteRegisteredPdf(docId)
      if (pdf) void pdf.destroy()
      void task.destroy().catch(() => { /* 忽略重复销毁 */ })
    }
  }, [url, docId, onBaseWidth])

  // 同一文档在原文双栏 ↔ 译文之间切换：URL 不变，只补报一次与当前模式匹配的基准宽
  useEffect(() => {
    const pdf = pdfRef.current
    if (!pdf || !numPages) return
    void pdf.getPage(1)
      .then((p) => onBaseWidth?.(p.getViewport({ scale: 1 }).width / (halfMode ? 2 : 1)))
      .catch(() => { /* 忽略 */ })
  }, [halfMode, numPages, onBaseWidth])

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
        pageEl.style.width = `${halfMode ? vp.width / 2 : vp.width}px`
        pageEl.style.height = `${vp.height}px`
        delete pageEl.dataset.needSize

        // 1) canvas：像素比上限 3（覆盖 3x 手机/PWA 屏，旧上限 2 导致发虚），
        //    同时把位图宽限制在 4096px 内防显存占用失控
        const ratio = Math.min(dpr, 3, 4096 / vp.width)
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

        // pdf.js 4.x 不会按位图尺寸自动放大：位图放大 ratio 倍时必须显式传缩放矩阵，
        // 否则内容只画在位图左上角 1/ratio 区域（高 DPR 屏上页面缩成一角、大片空白）
        await page.render({
          canvasContext: canvas.getContext('2d')!,
          viewport: vp,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
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
      (dualLike ? (side === 'zh' ? 0.5 + x / 2 : x / 2) : x) * 100
    const drawPageAnnotations = (layer: HTMLElement, pageNum: number) => {
      const anns = annotationsRef.current.filter((a) => a.page === pageNum && (!halfMode || a.side === 'zh'))
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
      appendNoteMarkers(layer, anns, (id) => markerClickRef.current(id))
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
        pageEl.className = `pdf-page pdf-page-placeholder${halfMode ? ' pdf-half' : ''}`
        pageEl.dataset.page = String(i)
        // 近似尺寸：同文档页面绝大多数一致（双语 PDF 尤其如此）。
        // 真实视口在渲染该页时以实际尺寸为准替换占位样式。
        pageEl.style.width = `${(halfMode ? firstVpW / 2 : firstVpW) * scale}px`
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
  }, [numPages, scale, dpr, halfMode])

  // ---- 标注绘制 ----
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.querySelectorAll<HTMLElement>('.ann-layer').forEach((l) => (l.innerHTML = ''))

    const byPage: Record<number, Annotation[]> = {}
    for (const a of annotations) if (!halfMode || a.side === 'zh') (byPage[a.page] ||= []).push(a)

    for (const [pageStr, anns] of Object.entries(byPage)) {
      const layer = host.querySelector<HTMLElement>(`.ann-layer[data-page="${pageStr}"]`)
      if (!layer) continue
      const annX = (x: number, side?: string) =>
        (dualLike ? (side === 'zh' ? 0.5 + x / 2 : x / 2) : x) * 100
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
      appendNoteMarkers(layer, anns, (id) => markerClickRef.current(id))
    }
  }, [annotations, numPages, scale, removeAnnotation, halfMode, dualLike])

  // ---- 文本选区 → 气泡 ----
  /** 选区结束/取消后移除所有文本层的 .selecting，恢复 endOfContent 哨兵位置 */
  const clearSelecting = (root: HTMLElement | null) => {
    if (!root) return
    root.querySelectorAll<HTMLElement>('.textLayer.selecting').forEach((l) => l.classList.remove('selecting'))
  }

  /** 由当前选区计算划词菜单数据；无有效选区返回 null（鼠标与触屏共用） */
  const buildBubble = useCallback((sel: Selection | null): Bubble | null => {
    if (!sel || sel.isCollapsed) return null

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

      const pr = fullPageRect(pageEl, halfMode)
      // 裁掉超出页面的部分（先保留页内 x，半侧归类在后面统一做）
      const x1 = Math.max(0, Math.min(1, (r.left - pr.left) / pr.width))
      const x2 = Math.max(0, Math.min(1, (r.right - pr.left) / pr.width))
      const y1 = Math.max(0, Math.min(1, (r.top - pr.top) / pr.height))
      const y2 = Math.max(0, Math.min(1, (r.bottom - pr.top) / pr.height))
      if (x2 - x1 < 0.001 || y2 - y1 < 0.001) continue
      rects.push([x1, y1, x2, y2])
    }

    if (!rects.length || !anchorPage) return null

    // 双语页：按选区锚定半侧（第一个矩形中心）归到 source/zh；
    // 坐标统一折回原文页空间——原文列 x*2，译文列 (x-0.5)*2（版式镜像）；
    // 横跨中缝混入另一侧的矩形丢弃，保证一条标注只含一种半侧
    let side: 'source' | 'zh' = 'source'
    if (dualLike) {
      const f = rects[0]
      // 译文视图只有右半列可见：锚定到译文列，左半列（被裁掉）的选区矩形被丢弃
      side = halfMode || (f[0] + f[2]) / 2 > 0.5 ? 'zh' : 'source'
      const lx = (x: number) =>
        Math.max(0, Math.min(1, side === 'zh' ? (x - 0.5) * 2 : x * 2))
      const mapped = rects
        .filter((r) => ((r[0] + r[2]) / 2 > 0.5) === (side === 'zh'))
        .map((r) => [lx(r[0]), r[1], lx(r[2]), r[3]] as number[])
        .filter((r) => r[2] - r[0] > 0.001)
      if (!mapped.length) return null
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
    const whole = range.getBoundingClientRect()
    const cx = first.left + first.width / 2
    const x = Math.min(
      Math.max(cx, BUBBLE_HALF_W + BUBBLE_EDGE),
      window.innerWidth - BUBBLE_HALF_W - BUBBLE_EDGE,
    )
    const below = whole.top < BUBBLE_FLIP_TOP
    return {
      x,
      y: below ? whole.bottom + 12 : first.top - 12,
      below,
      arrowX: cx - x + BUBBLE_HALF_W,
      page: anchorPage,
      rects,
      side,
      quote: sel.toString().trim().slice(0, 2000),
    }
  }, [dualLike, halfMode])

  const onMouseUp = useCallback(() => {
    // 触屏设备的菜单由 selectionchange 生成（停靠底部），鼠标事件不再处理
    if (coarse) return
    setBubble(buildBubble(window.getSelection()))
  }, [buildBubble, coarse])

  // 触屏：长按选字后（防抖）生成停靠菜单，固定在屏幕底部居中
  useEffect(() => {
    if (!coarse) return
    let timer = 0
    const onChange = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const b = buildBubble(window.getSelection())
        if (b) setBubble({ ...b, docked: true, below: false, x: window.innerWidth / 2, y: 0, arrowX: 0 })
      }, SELECTION_DEBOUNCE_MS)
    }
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('selectionchange', onChange)
      window.clearTimeout(timer)
    }
  }, [coarse, buildBubble])

  // 停靠菜单：点击菜单外部即关闭（点菜单内部不关闭，以免清空选区后按钮失效）
  useEffect(() => {
    if (!bubble?.docked) return
    const onDown = (e: PointerEvent): void => {
      if (!(e.target as HTMLElement).closest('.sel-float')) setBubble(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [bubble?.docked])

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

  /** 关闭划词菜单并清空选区 */
  const closeBubble = (): void => {
    setBubble(null)
    window.getSelection()?.removeAllRanges()
  }

  /** 按颜色保存划线（单击色点 / 数字键 / h 键） */
  const saveHighlight = async (c: string): Promise<Annotation | null> => {
    const b = bubble
    if (!b || !currentDoc) return null
    useStore.getState().setLastColor(c)
    closeBubble()
    return addAnnotation(currentDoc.id, b.page, b.rects, b.quote, c, { side: b.side ?? 'source' })
  }

  /** 笔记：以最近颜色保存，然后在右栏标注页定位并进入编辑 */
  const noteHighlight = async (): Promise<void> => {
    const saved = await saveHighlight(useStore.getState().lastColor)
    if (saved) {
      openRight('notes')
      setFocusAnnotation(saved.id)
    }
  }

  /** 问 AI / 解释：把选区作为引用块送入右栏问答 */
  const askQuestion = (mode: 'ask' | 'explain'): void => {
    const b = bubble
    if (!b) return
    closeBubble()
    askAI(b.quote, b.page, mode)
  }

  /** 复制选中原文，按钮短暂显示「已复制」 */
  const copyQuote = async (): Promise<void> => {
    const b = bubble
    if (!b) return
    try {
      await navigator.clipboard.writeText(b.quote)
    } catch {
      return
    }
    setBubble((cur) => (cur ? { ...cur, copied: true } : cur))
    window.setTimeout(() => setBubble((cur) => (cur ? { ...cur, copied: false } : cur)), COPY_FEEDBACK_MS)
  }

  // 划词菜单键盘操作：1-4 选色保存、h 用最近颜色、a 问 AI、Esc 关闭。
  // 捕获阶段监听并阻止冒泡，使数字键不再触发页面的缩放快捷键
  useEffect(() => {
    if (!bubble) return
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      let handled = true
      if (/^[1-4]$/.test(e.key)) void saveHighlight(ANNOTATION_COLORS[Number(e.key) - 1].color)
      else if (e.key === 'h') void saveHighlight(useStore.getState().lastColor)
      else if (e.key === 'a') askQuestion('ask')
      else if (e.key === 'Escape') closeBubble()
      else handled = false
      if (!handled) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // 处理函数每次渲染重建，依赖 bubble 即可保证读到当前选区
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubble, currentDoc])

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
        <div
          className={`sel-float${bubble.below ? ' below' : ''}${bubble.docked ? ' docked' : ''}`}
          style={bubble.docked ? undefined : { left: bubble.x, top: bubble.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sel-bubble" style={{ '--arrow-x': `${bubble.arrowX}px` } as React.CSSProperties}>
            {ANNOTATION_COLORS.map((c, i) => (
              <button
                key={c.color}
                className="sel-dot"
                style={{ background: c.color }}
                title={`${c.label}（${i + 1}）`}
                aria-label={`${c.label}划线`}
                onClick={() => void saveHighlight(c.color)}
              />
            ))}
            <span className="sel-sep" />
            <button className="sel-btn" onClick={() => askQuestion('explain')}>解释</button>
            <button
              className="sel-btn"
              disabled={!!bubble.translated || !!bubble.translating}
              onClick={() => void translateSelection()}
            >翻译</button>
            <button className="sel-btn sel-accent" onClick={() => askQuestion('ask')}>
              <Icon d={PATH_SPARKLE} size={12} /> 问 AI
            </button>
            <button className="sel-btn" onClick={() => void noteHighlight()}>笔记</button>
            <button className="sel-btn" onClick={() => void copyQuote()}>
              {bubble.copied ? '已复制' : '复制'}
            </button>
          </div>
          {(bubble.translating || bubble.translated || bubble.transError) && (
            <div className="sel-trans-card">
              {bubble.translating && <div className="sel-trans-hint">翻译中…</div>}
              {bubble.translated && (
                <>
                  <div className="sel-trans-text">{bubble.translated}</div>
                  <div className="sel-trans-meta">
                    {bubble.engine}{bubble.latency ? ` · ${bubble.latency}ms` : ''}
                  </div>
                </>
              )}
              {bubble.transError && <div className="sel-trans-err">{bubble.transError}</div>}
            </div>
          )}
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
