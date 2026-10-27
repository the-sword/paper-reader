/**
 * 已加载 PDF 文档的跨组件共享注册表。
 *
 * 背景：PdfViewer 与 usePdfOutline（目录书签）各自 getDocument 会把同一份
 * PDF 完整下载两遍。此注册表让后加载的一方（目录 hook）等待/复用
 * PdfViewer 已加载的 PDFDocumentProxy，首开同一文档全程只发生一份下载。
 *
 * 生命周期：
 *   - PdfViewer 加载成功 → set(docId, pdf)（通知订阅者）；
 *   - PdfViewer 卸载/换文档 destroy 前 → delete(docId)（同样通知）。
 *   - 同一文档在原文/双语/译文视图间切换共用同一 PdfViewer 实例与
 *     同一 pdf 对象，set 幂等不重复注册。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

/** docId → 已加载的 PDF 文档代理（PdfViewer 是唯一写入方） */
const registry = new Map<string, PDFDocumentProxy>()

/** 订阅者集合：docId 出现/移除时逐个回调 */
const listeners = new Set<(docId: string, pdf: PDFDocumentProxy | null) => void>()

/** 取已注册的 PDF（没有则 null） */
export function getRegisteredPdf(docId: string): PDFDocumentProxy | null {
  return registry.get(docId) ?? null
}

/** 注册/更新文档实例并通知订阅者（幂等：同一实例重复 set 只通知一次） */
export function setRegisteredPdf(docId: string, pdf: PDFDocumentProxy): void {
  if (registry.get(docId) === pdf) return
  registry.set(docId, pdf)
  for (const fn of listeners) fn(docId, pdf)
}

/** 注销文档实例并通知订阅者（PdfViewer destroy 前调用） */
export function deleteRegisteredPdf(docId: string): void {
  if (!registry.delete(docId)) return
  for (const fn of listeners) fn(docId, null)
}

/** 订阅注册表变化，返回取消订阅函数 */
export function subscribeRegisteredPdf(
  fn: (docId: string, pdf: PDFDocumentProxy | null) => void,
): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
