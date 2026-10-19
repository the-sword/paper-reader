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
  created_at: string
  updated_at: string
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
    document_id: string; page: number; kind: string
    rects: number[][]; color: string; quote: string; comment: string
  }) => req<Annotation>('/annotations', { method: 'POST', body: JSON.stringify(a) }),
  updateAnnotation: (id: string, p: { color?: string; comment?: string }) =>
    req<Annotation>(`/annotations/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  deleteAnnotation: (id: string) => req<{ ok: boolean }>(`/annotations/${id}`, { method: 'DELETE' }),
  exportUrl: (docId: string) => `/api/annotations/export/${docId}${AUTH_TOKEN ? `?token=${AUTH_TOKEN}` : ''}`,
}
