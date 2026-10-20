const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || ''

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) }
  if (AUTH_TOKEN) headers['x-auth-token'] = AUTH_TOKEN
  if (init?.body && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`/api${path}`, { ...init, headers })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`${res.status}: ${txt}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return res.json() as Promise<T>
  return (await res.text()) as unknown as T
}

export interface Folder { id: string; name: string; parent_id: string | null; count?: number }
export interface Tag { id: string; name: string; color: string; count?: number }
export interface DocumentMeta {
  id: string
  title: string
  file_hash: string
  file_name: string | null
  file_size: number | null
  page_count: number | null
  parse_status: string
  added_at: string
  opened_at: string | null
  folders: Folder[]
  tags: Tag[]
  duplicated?: boolean
}
export interface Annotation {
  id: string
  document_id: string
  page: number
  kind: string
  color: string
  rects: number[][]
  quote: string | null
  comment: string | null
  segment_id: string | null
  side: string
  segment_idx: number | null
  start_offset: number | null
  end_offset: number | null
  created_at: string
  updated_at: string
}
export interface Segment {
  id: string
  document_id: string
  idx: number
  section: string | null
  kind: 'text' | 'heading' | 'formula' | 'table' | 'figure' | 'caption' | 'reference'
  source: string
  page: number
  bbox: string | null
  zh: string | null
  zh_provider: string | null
  img_path?: string
  caption?: string
}
export interface SegmentsResp {
  document_id: string
  count: number
  cached_translations: number
  segments: Segment[]
}
export interface ParseProgress {
  state: string
  progress: number
  segments?: number
  error?: string | null
  task_id?: string
}
export interface EngineStatus {
  mineru_configured: boolean
  mineru_model: string
  ai_configured: boolean
  local_fallback: boolean
}
export interface AIConfig {
  base_url: string
  model: string
  temperature: number
  api_key_set: boolean
  api_key_masked: string
}
export interface EngineDomain { value: string; label: string }
export interface EngineInfo {
  name: string
  label: string
  enabled: boolean
  configured: boolean
  priority: number
  config: Record<string, string | boolean>
  domains: EngineDomain[]
  hint?: string
}
export interface EngineTestResult {
  ok: boolean
  engine?: string
  text?: string
  latency_ms?: number
  error?: string
}
export interface ArxivItem {
  arxiv_id: string
  title: string
  authors: string[]
  summary: string
  published: string
  pdf_url: string
  abs_url: string
  doi: string | null
  categories: string[]
}
export interface Reference {
  no: number
  idx: number
  text: string
  authors: string
  title: string
  year: number | null
  venue: string
}
export interface BabelDocJob {
  id: string
  kind: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  message: string
  result: null | { dual_pdf: string; mono_pdf: string | null; output_dir: string }
  error: string | null
}
export interface TermResult {
  source: string
  text: string
  engine: string
  latency_ms: number
  cached: boolean
  meta: Record<string, unknown>
}
export interface SummaryKind { value: string; label: string }
export interface SummaryItem {
  id: string
  document_id: string
  kind: string
  content: string
  model: string | null
  created_at: string
}
export interface WebDAVConfig {
  url: string
  username: string
  password_set: boolean
  password_masked: string
  file_name: string
}
export interface SystemInfo {
  lib_root: string
  db_path: string
  documents: number
  annotations: number
  auth_enabled: boolean
}

export const api = {
  info: () => req<SystemInfo>('/system/info'),

  listDocuments: (p: { folder_id?: string; tag_id?: string; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (p.folder_id) qs.set('folder_id', p.folder_id)
    if (p.tag_id) qs.set('tag_id', p.tag_id)
    if (p.q) qs.set('q', p.q)
    const s = qs.toString()
    return req<DocumentMeta[]>(`/documents${s ? `?${s}` : ''}`)
  },
  getDocument: (id: string) => req<DocumentMeta>(`/documents/${id}`),
  upload: (file: File, folderId?: string) => {
    const fd = new FormData()
    fd.append('file', file)
    if (folderId) fd.append('folder_id', folderId)
    return req<DocumentMeta>('/documents/upload', { method: 'POST', body: fd })
  },
  deleteDocument: (id: string) => req<{ ok: boolean }>(`/documents/${id}`, { method: 'DELETE' }),
  setDocumentFolders: (docId: string, folderIds: string[]) =>
    req<{ ok: boolean; folder_ids: string[] }>(`/documents/${docId}/folders`,
      { method: 'PUT', body: JSON.stringify({ folder_ids: folderIds }) }),
  pdfUrl: (id: string) => `/api/documents/${id}/file${AUTH_TOKEN ? `?token=${AUTH_TOKEN}` : ''}`,

  listFolders: () => req<Folder[]>('/folders'),
  createFolder: (name: string, parentId?: string) =>
    req<Folder>('/folders', { method: 'POST', body: JSON.stringify({ name, parent_id: parentId ?? null }) }),
  deleteFolder: (id: string) => req<{ ok: boolean }>(`/folders/${id}`, { method: 'DELETE' }),

  listTags: () => req<Tag[]>('/tags'),
  createTag: (name: string, color: string) =>
    req<Tag>('/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),
  deleteTag: (id: string) => req<{ ok: boolean }>(`/tags/${id}`, { method: 'DELETE' }),
  tagDocument: (docId: string, tagId: string, add = true) =>
    req<{ ok: boolean }>(`/tags/${docId}/${tagId}?add=${add}`, { method: 'POST' }),

  listAnnotations: (docId: string, page?: number) => {
    const qs = new URLSearchParams({ document_id: docId })
    if (page !== undefined) qs.set('page', String(page))
    return req<Annotation[]>(`/annotations?${qs}`)
  },
  createAnnotation: (a: {
    document_id: string; page?: number; kind: string
    rects?: number[][]; color: string; quote: string; comment: string
    segment_id?: string | null; side?: string
    start_offset?: number | null; end_offset?: number | null
  }) => req<Annotation>('/annotations', { method: 'POST', body: JSON.stringify(a) }),
  updateAnnotation: (id: string, p: { color?: string; comment?: string }) =>
    req<Annotation>(`/annotations/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  deleteAnnotation: (id: string) => req<{ ok: boolean }>(`/annotations/${id}`, { method: 'DELETE' }),
  exportUrl: (docId: string) => `/api/annotations/export/${docId}${AUTH_TOKEN ? `?token=${AUTH_TOKEN}` : ''}`,

  // ---- 阅读（解析 + 翻译）----
  startParse: (docId: string, engine: 'auto' | 'mineru' | 'local' = 'auto') =>
    req<{ engine: string; state: string; segments?: number; task_id?: string }>(
      `/reading/${docId}/parse`, { method: 'POST', body: JSON.stringify({ engine }) }),
  parseProgress: (docId: string) => req<ParseProgress>(`/reading/${docId}/parse/progress`),
  getSegments: (docId: string) => req<SegmentsResp>(`/reading/${docId}/segments`),
  translateSegments: (docId: string, segmentIds: string[], force = false, engine?: string | null) =>
    req<{
      results: Array<{ segment_id: string; text: string; provider: string; cached: boolean; latency_ms?: number }>
      errors: Array<{ segment_id: string; error: string }>
    }>(
      `/reading/${docId}/translate`,
      { method: 'POST', body: JSON.stringify({ segment_ids: segmentIds, force, engine: engine || null }) }),

  // ---- arXiv ----
  arxivSearch: (query: string, field = 'all', limit = 10) =>
    req<{ count: number; results: ArxivItem[] }>('/arxiv/search',
      { method: 'POST', body: JSON.stringify({ query, field, limit }) }),
  arxivByDoi: (doi: string) =>
    req<{
      matched: ArxivItem | null
      meta: { doi: string; title: string; authors: string[]; year: number | null; container: string } | null
      score: number
      candidates: ArxivItem[]
    }>('/arxiv/by-doi', { method: 'POST', body: JSON.stringify({ doi }) }),
  arxivImport: (arxivId: string, opts?: { title?: string; authors?: string[]; folderId?: string }) =>
    req<{ ok: boolean; duplicated: boolean; document: { id: string; title: string; page_count: number; authors: string | null } }>(
      '/arxiv/import',
      { method: 'POST', body: JSON.stringify({
        arxiv_id: arxivId,
        title: opts?.title ?? null,
        authors: opts?.authors ?? null,
        folder_id: opts?.folderId ?? null,
      }) }),

  // ---- 参考文献 ----
  getReferences: (docId: string) =>
    req<{ count: number; references: Reference[] }>(`/reading/${docId}/references`),

  // ---- 划词翻译 ----
  translateTerm: (text: string, engine?: string | null) =>
    req<TermResult>('/reading/term',
      { method: 'POST', body: JSON.stringify({ text, engine: engine || null }) }),
  termStats: () => req<{ memory: number; database: number }>('/reading/term/stats'),
  clearTermCache: () =>
    req<{ ok: boolean; cleared: number }>('/reading/term/cache/clear', { method: 'POST' }),

  // ---- AI 总结 ----
  summaryKinds: () => req<{ kinds: SummaryKind[] }>('/reading/summary/kinds'),
  createSummary: (docId: string, kind: string, question?: string) =>
    req<{ id: string; kind: string; content: string; model?: string; input_chars?: number }>(
      `/reading/summary/${docId}`,
      { method: 'POST', body: JSON.stringify({ kind, question: question || null }) }),
  startSummary: (docId: string, kind: string, question?: string) =>
    req<{ job_id: string; status: string }>(
      `/reading/summary/${docId}/start`,
      { method: 'POST', body: JSON.stringify({ kind, question: question || null }) }),
  summaryJob: (jobId: string) =>
    req<{
      id: string
      kind: string
      status: 'running' | 'done' | 'failed' | 'cancelled'
      progress: number
      message: string
      result: null | { id: string; content: string; model?: string; input_chars?: number }
      error: string | null
    }>(`/reading/summary/job/${jobId}`),
  cancelSummary: (jobId: string) =>
    req<{ ok: boolean; status: string }>(
      `/reading/summary/job/${jobId}/cancel`, { method: 'POST' }),

  listSummaries: (docId: string) =>
    req<{ summaries: SummaryItem[] }>(`/reading/summary/${docId}`),
  deleteSummary: (id: string) =>
    req<{ ok: boolean }>(`/reading/summary/item/${id}`, { method: 'DELETE' }),

  // ---- 备份 ----
  getBackupConfig: () => req<WebDAVConfig>('/reading/backup/config'),
  saveBackupConfig: (c: { url?: string; username?: string; password?: string; file_name?: string }) =>
    req<{ ok: boolean }>('/reading/backup/config', { method: 'POST', body: JSON.stringify(c) }),
  testBackup: () =>
    req<{ ok: boolean; message?: string; error?: string }>('/reading/backup/test', { method: 'POST' }),
  runBackup: (includePdfs = false, password?: string) =>
    req<{
      ok: boolean; size_mb: number; file_count: number; encrypted: boolean
      uploaded_at: string; endpoint: string
    }>(
      '/reading/backup/run',
      { method: 'POST', body: JSON.stringify({ include_pdfs: includePdfs, password: password || null }) }),
  remoteBackupInfo: () =>
    req<{ exists: boolean; size_bytes?: number; last_modified?: string }>('/reading/backup/remote'),
  restoreBackup: (password?: string) =>
    req<{ ok: boolean; restored_files: number }>('/reading/backup/restore',
      { method: 'POST', body: JSON.stringify({ password: password || null }) }),

  // ---- AI 探活 ----
  probeAI: () => req<{ ok: boolean; latency_ms?: number; error?: string }>('/reading/config/ai/probe'),

  retranslate: (docId: string, mode: 'clear' | 'retranslate', engine?: string | null, limit?: number) =>
    req<{ ok: boolean; mode: string; cleared: number; translated: number; failed?: number }>(
      `/reading/${docId}/retranslate`,
      { method: 'POST', body: JSON.stringify({ mode, engine: engine || null, limit: limit ?? null }) }),

  // ---- 双语 PDF（BabelDOC）----
  startBabelDoc: (docId: string, pages?: string) =>
    req<{ job_id: string; status: string }>(
      `/reading/babeldoc/${docId}/start`,
      { method: 'POST', body: JSON.stringify({ pages: pages || null }) }),
  babelDocJob: (jobId: string) =>
    req<BabelDocJob>(`/reading/babeldoc/job/${jobId}`),
  cancelBabelDoc: (jobId: string) =>
    req<{ ok: boolean }>(`/reading/babeldoc/job/${jobId}/cancel`, { method: 'POST' }),
  babelDocStatus: (docId: string) =>
    req<{ generated: boolean; size?: number }>(`/reading/babeldoc/${docId}/status`),
  babelDocPdfUrl: (docId: string) => `/reading/babeldoc/${docId}/pdf`,

  // ---- 界面偏好 ----
  getPrefs: () => req<{ values: Record<string, unknown> }>('/reading/prefs'),
  savePrefs: (values: Record<string, unknown>) =>
    req<{ ok: boolean; values: Record<string, unknown> }>('/reading/prefs',
      { method: 'POST', body: JSON.stringify({ values }) }),

  // ---- 配置 ----
  getEngines: () => req<EngineStatus>('/reading/config/engines'),
  getAIConfig: () => req<AIConfig>('/reading/config/ai'),
  saveAIConfig: (c: { base_url?: string; api_key?: string; model?: string; temperature?: number }) =>
    req<{ ok: boolean }>('/reading/config/ai', { method: 'POST', body: JSON.stringify(c) }),
  getEnginesList: () => req<{ engines: EngineInfo[] }>('/reading/engines'),
  setEngineOrder: (order: string[]) =>
    req<{ ok: boolean; order: string[] }>('/reading/engines/order',
      { method: 'POST', body: JSON.stringify({ order }) }),
  getEngineConfig: (name: string) => req<Record<string, unknown>>(`/reading/engines/${name}/config`),
  saveEngineConfig: (name: string, cfg: {
    enabled?: boolean; appid?: string; appkey?: string
    domain?: string; endpoint?: string; region?: string
  }) => req<{ ok: boolean }>(`/reading/engines/${name}/config`,
      { method: 'POST', body: JSON.stringify(cfg) }),
  testEngine: (name: string) =>
    req<EngineTestResult>(`/reading/engines/${name}/test`, { method: 'POST' }),
  getGlossary: () => req<{ glossary: Record<string, string> }>('/reading/config/glossary'),
  saveGlossary: (g: Record<string, string>) =>
    req<{ ok: boolean; count: number }>('/reading/config/glossary', { method: 'POST', body: JSON.stringify({ glossary: g }) }),
}
