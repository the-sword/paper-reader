import { useEffect, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { api } from '../api/client'
import { getRegisteredPdf, subscribeRegisteredPdf } from '../lib/pdfRegistry'

// 与 PdfViewer 一致：本 hook 可能先于 PdfViewer 挂载，需自行保证 worker 已配置
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/** 等待 PdfViewer 注册 PDF 实例的超时（毫秒）；超时才回退自行 getDocument */
const AWAIT_REGISTRY_MS = 15000
/** 等待期间的轮询间隔（毫秒） */
const AWAIT_POLL_MS = 300

/** 目录条目：页码从 1 开始，depth 为书签嵌套层级（0 为顶层） */
export interface OutlineItem {
  id: string
  title: string
  page: number
  depth: number
}

/** pdf.js getOutline 返回的书签节点（只取用到的字段） */
interface BookmarkNode {
  title: string
  dest: string | unknown[] | null
  items?: BookmarkNode[]
}

/** 按文献 id 缓存已读取的书签（只缓存成功结果；失败可在下次进入时重试） */
const cache = new Map<string, OutlineItem[]>()

/** 把书签 dest 解析为页码（1 起始）；解析失败返回 null */
async function resolvePage(pdf: PDFDocumentProxy, dest: BookmarkNode['dest']): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    if (!explicit || !explicit[0]) return null
    return (await pdf.getPageIndex(explicit[0])) + 1
  } catch {
    return null
  }
}

/** 递归展开书签树为扁平列表（保持文档顺序） */
async function walk(
  pdf: PDFDocumentProxy, nodes: BookmarkNode[], depth: number, out: OutlineItem[],
): Promise<void> {
  for (const n of nodes) {
    const title = (n.title ?? '').trim()
    const page = title ? await resolvePage(pdf, n.dest) : null
    if (page !== null) out.push({ id: `bm-${out.length}`, title, page, depth })
    if (n.items?.length) await walk(pdf, n.items, depth + 1, out)
  }
}

/** 读取原文 PDF 的书签；无书签或加载失败返回空数组 */
async function loadBookmarks(docId: string): Promise<OutlineItem[]> {
  // 只读书签，不预取页面数据：disableAutoFetch/disableStream 让加载尽量轻
  const task = pdfjsLib.getDocument({
    url: api.pdfUrl(docId), disableAutoFetch: true, disableStream: true,
  })
  const pdf = await task.promise
  try {
    return await readOutlineItems(pdf)
  } finally {
    void pdf.destroy()
  }
}

/** 从给定 PDF 实例解析书签（不负责实例的销毁） */
async function readOutlineItems(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  const outline = (await pdf.getOutline()) as BookmarkNode[] | null
  if (!outline?.length) return []
  const items: OutlineItem[] = []
  await walk(pdf, outline, 0, items)
  return items
}

/**
 * 等待 PdfViewer 注册的同一文档实例：命中即复用（零额外下载）。
 * 先查已有注册，再挂订阅 + 300ms 轮询双保险；最多等 AWAIT_REGISTRY_MS，
 * 超时（如 OutlinePanel 单独使用、加载失败）返回 null，由调用方回退。
 */
async function awaitRegisteredPdf(docId: string): Promise<PDFDocumentProxy | null> {
  const existing = getRegisteredPdf(docId)
  if (existing) return existing
  return new Promise((resolve) => {
    let done = false
    const finish = (pdf: PDFDocumentProxy | null): void => {
      if (done) return
      done = true
      window.clearInterval(poll)
      unsubscribe()
      resolve(pdf)
    }
    const unsubscribe = subscribeRegisteredPdf((id, pdf) => {
      if (id === docId) finish(pdf)
    })
    const poll = window.setInterval(() => {
      const pdf = getRegisteredPdf(docId)
      if (pdf) finish(pdf)
    }, AWAIT_POLL_MS)
    window.setTimeout(() => finish(null), AWAIT_REGISTRY_MS)
  })
}

/**
 * 加载书签入口：优先复用阅读器已加载的 PDF（首开只下载一份）；
 * 超时等不到实例才回退轻量 getDocument。
 */
async function loadBookmarksSmart(docId: string): Promise<OutlineItem[]> {
  const pdf = await awaitRegisteredPdf(docId)
  if (pdf) {
    try {
      return await readOutlineItems(pdf)
    } catch {
      // 共享实例解析失败（如已被销毁）→ 走回退路径
    }
  }
  return loadBookmarks(docId)
}

interface OutlineState {
  docId: string | null
  items: OutlineItem[]
  loading: boolean
}

/**
 * 原文 PDF 书签目录。docId 变化时忽略过期结果；同一文献切回时直接取缓存。
 * 返回的 items 只对应当前 docId（切换瞬间不会暴露上一篇的目录）。
 */
export function usePdfOutline(docId: string | null): { items: OutlineItem[]; loading: boolean } {
  const [state, setState] = useState<OutlineState>({ docId: null, items: [], loading: false })

  useEffect(() => {
    if (!docId) {
      setState({ docId: null, items: [], loading: false })
      return
    }
    const cached = cache.get(docId)
    if (cached) {
      setState({ docId, items: cached, loading: false })
      return
    }
    let alive = true
    setState({ docId, items: [], loading: true })
    loadBookmarksSmart(docId)
      .then((items) => {
        cache.set(docId, items)
        if (alive) setState({ docId, items, loading: false })
      })
      .catch(() => {
        if (alive) setState({ docId, items: [], loading: false })
      })
    return () => { alive = false }
  }, [docId])

  if (state.docId !== docId) return { items: [], loading: !!docId }
  return { items: state.items, loading: state.loading }
}
