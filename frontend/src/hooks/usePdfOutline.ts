import { useEffect, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { api } from '../api/client'

// 与 PdfViewer 一致：本 hook 可能先于 PdfViewer 挂载，需自行保证 worker 已配置
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

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
    const outline = (await pdf.getOutline()) as BookmarkNode[] | null
    if (!outline?.length) return []
    const items: OutlineItem[] = []
    await walk(pdf, outline, 0, items)
    return items
  } finally {
    void pdf.destroy()
  }
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
    loadBookmarks(docId)
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
