import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useStore } from '../stores/useStore'

/** 页面占位元素选择器（PdfViewer 对所有页都预建了占位） */
const PAGE_SELECTOR = '.pdf-page[data-page]'
/** 当前页判定线：视口高度的 1/3 处 */
const ANCHOR_RATIO = 1 / 3
/** 待恢复位置的兜底过期时间（毫秒）：正常情况下重建会先消费它；PDF 慢加载时需留足余量 */
const PENDING_TTL_MS = 15000

export interface PdfPageNav {
  /** 当前页码（从 1 开始） */
  page: number
  /** 已渲染占位的总页数 */
  pageCount: number
  /** 滚动到指定页（越界自动钳制） */
  goTo: (target: number) => void
}

interface Options {
  mainRef: RefObject<HTMLElement>
  /** 当前缩放，变化时 PdfViewer 会重建所有页面 */
  scale: number
  docId: string | null
  /** 视图（原文 / 双语），切换时同样会重建页面 */
  view: string
  /** 「适应宽度」已对当前文档与视图完成拟合，才允许恢复位置 */
  ready: boolean
  /** 阅读视图是否挂载（main 存在且有文档） */
  active: boolean
}

function pageElements(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(PAGE_SELECTOR))
}

/** 二分查找锚点线所在的页：页面按文档顺序排列，顶边单调递增 */
function pageAtAnchor(pages: HTMLElement[], anchorY: number): number {
  let lo = 0
  let hi = pages.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pages[mid].getBoundingClientRect().top <= anchorY) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return Number(pages[ans].dataset.page)
}

/** 把页顶对齐到滚动容器顶部 */
function alignPageTop(el: HTMLElement, pageEl: HTMLElement): void {
  el.scrollTop += pageEl.getBoundingClientRect().top - el.getBoundingClientRect().top
}

/**
 * PDF 阅读的页码跟踪与导航。
 * 缩放 / 双语切换 / 切换标签 / 窗口 dpr 变化都会让 PdfViewer 清空并重建页面，
 * 重建期间滚动位置会被浏览器夹回顶部，因此在重建前记录当前页，
 * 等「适应宽度」完成且页面重新出现后再滚回去。
 */
export function usePdfPageNav({ mainRef, scale, docId, view, ready, active }: Options): PdfPageNav {
  const setPagePos = useStore((s) => s.setPagePos)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)

  const pageRef = useRef(1)
  const pendingRef = useRef<number | null>(null)
  const pendingTimerRef = useRef<number | null>(null)
  const restoringRef = useRef(false)
  const readyRef = useRef(ready)
  readyRef.current = ready
  const docIdRef = useRef(docId)
  docIdRef.current = docId
  const scaleInitRef = useRef(true)
  const dprRef = useRef(window.devicePixelRatio || 1)

  const clearPending = useCallback((): void => {
    pendingRef.current = null
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = null
    }
  }, [])

  const setPending = useCallback((target: number): void => {
    pendingRef.current = target
    if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = window.setTimeout(clearPending, PENDING_TTL_MS)
  }, [clearPending])

  /** 记录当前页：同步到本地状态与持久化的页码记忆 */
  const commitPage = useCallback((p: number): void => {
    pageRef.current = p
    setPage(p)
    if (docIdRef.current) setPagePos(docIdRef.current, p)
  }, [setPagePos])

  /** 页面重建完成且已拟合后，滚回待恢复的页（两帧后再滚，等布局稳定） */
  const restore = useCallback((): void => {
    const el = mainRef.current
    const target = pendingRef.current
    if (!el || target === null || !readyRef.current || restoringRef.current) return
    restoringRef.current = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      restoringRef.current = false
      const cur = mainRef.current
      if (!cur || pendingRef.current !== target) return
      const pages = pageElements(cur)
      // 页数已少于目标页（文档变化等）：目标无效，放弃恢复
      if (pages.length && target > pages.length) { clearPending(); return }
      const pageEl = pages.find((p) => Number(p.dataset.page) === target)
      if (!pageEl) return
      alignPageTop(cur, pageEl)
      clearPending()
      commitPage(target)
    }))
  }, [mainRef, clearPending, commitPage])

  // 切换文档 / 视图（含重新挂载阅读区）：恢复到该文档上次的页码
  useLayoutEffect(() => {
    if (!active || !docId) return
    const saved = useStore.getState().pagePos[docId]
    pageRef.current = saved ?? 1
    setPage(saved ?? 1)
    if (saved) setPending(saved)
    else clearPending()
  }, [active, docId, view, setPending, clearPending])

  // 缩放变化会重建页面：记录重建前的页（已有待恢复目标时不覆盖）
  useLayoutEffect(() => {
    if (scaleInitRef.current) { scaleInitRef.current = false; return }
    if (pendingRef.current === null) setPending(pageRef.current)
  }, [scale, setPending])

  // 设备像素比变化（浏览器缩放 / 跨显示器）也会重建页面，同样先记录页码
  useEffect(() => {
    if (!active) return
    const onResize = (): void => {
      const dpr = window.devicePixelRatio || 1
      if (dpr === dprRef.current) return
      dprRef.current = dpr
      if (pendingRef.current === null) setPending(pageRef.current)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [active, setPending])

  // 适应宽度完成后再尝试恢复（页面可能已经在这之前就出现了）
  useEffect(() => {
    if (ready) restore()
  }, [ready, restore])

  // 监听页面占位的增删：同步总页数，并在重建完成时尝试恢复位置
  useEffect(() => {
    const el = mainRef.current
    if (!active || !el) return
    const sync = (): void => {
      setPageCount(pageElements(el).length)
      restore()
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [active, mainRef, restore, docId, view])

  // 滚动时更新当前页（rAF 节流）；恢复期间忽略，避免重建时的夹紧把页码刷成 1
  useEffect(() => {
    const el = mainRef.current
    if (!active || !el) return
    let raf = 0
    const update = (): void => {
      raf = 0
      if (pendingRef.current !== null) return
      const pages = pageElements(el)
      if (!pages.length) return
      const anchor = el.getBoundingClientRect().top + el.clientHeight * ANCHOR_RATIO
      const p = pageAtAnchor(pages, anchor)
      if (p !== pageRef.current) commitPage(p)
    }
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [active, mainRef, commitPage, docId, view])

  const goTo = useCallback((target: number): void => {
    const el = mainRef.current
    if (!el) return
    const pages = pageElements(el)
    if (!pages.length) return
    const n = Math.min(Math.max(1, Math.round(target)), pages.length)
    const pageEl = pages.find((p) => Number(p.dataset.page) === n)
    if (!pageEl) return
    clearPending()
    alignPageTop(el, pageEl)
    commitPage(n)
  }, [mainRef, clearPending, commitPage])

  return { page, pageCount, goTo }
}
