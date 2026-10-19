import { create } from 'zustand'
import {
  api,
  type Annotation, type DocumentMeta, type Folder, type Segment, type Tag,
} from '../api/client'

interface State {
  // 库
  folders: Folder[]
  tags: Tag[]
  documents: DocumentMeta[]
  currentDoc: DocumentMeta | null
  annotations: Annotation[]
  activeFolder: string | null
  activeTag: string | null
  search: string
  loading: boolean
  error: string | null

  // 阅读
  segments: Segment[]
  translations: Record<string, { text: string; provider: string }>
  inflight: Set<string>
  aiReady: boolean
  parseState: string
  parseProgress: number

  // 动作
  refreshLibrary: () => Promise<void>
  refreshSidebar: () => Promise<void>
  openDocument: (id: string) => Promise<void>
  closeDocument: () => void
  setFolder: (id: string | null) => void
  setTag: (id: string | null) => void
  setSearch: (q: string) => void
  refreshAnnotations: (docId: string) => Promise<void>
  addAnnotation: (docId: string, page: number, rects: number[][], quote: string, color: string) => Promise<void>
  removeAnnotation: (id: string) => Promise<void>
  clearError: () => void

  // 阅读动作
  loadSegments: (docId: string) => Promise<void>
  startParse: (engine?: 'auto' | 'mineru' | 'local') => Promise<void>
  pollParse: (docId: string) => Promise<void>
  translateQueue: (ids: string[]) => Promise<void>
  refreshAIConfig: () => Promise<void>
}

/** 同时在飞的翻译请求上限 */
const CONCURRENCY = 4

export const useStore = create<State>((set, get) => ({
  folders: [],
  tags: [],
  documents: [],
  currentDoc: null,
  annotations: [],
  activeFolder: null,
  activeTag: null,
  search: '',
  loading: false,
  error: null,

  segments: [],
  translations: {},
  inflight: new Set<string>(),
  aiReady: false,
  parseState: 'pending',
  parseProgress: 0,

  refreshSidebar: async () => {
    const [folders, tags] = await Promise.all([api.listFolders(), api.listTags()])
    set({ folders, tags })
  },

  refreshLibrary: async () => {
    set({ loading: true, error: null })
    try {
      const { activeFolder, activeTag, search } = get()
      const documents = await api.listDocuments({
        folder_id: activeFolder ?? undefined,
        tag_id: activeTag ?? undefined,
        q: search || undefined,
      })
      set({ documents, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  openDocument: async (id) => {
    set({ loading: true, error: null, segments: [], translations: {} })
    try {
      const currentDoc = await api.getDocument(id)
      const annotations = await api.listAnnotations(id)
      set({ currentDoc, annotations, loading: false })
      await get().loadSegments(id)
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  closeDocument: () =>
    set({ currentDoc: null, annotations: [], segments: [], translations: {} }),

  setFolder: (id) => {
    set({ activeFolder: id, activeTag: null })
    void get().refreshLibrary()
  },
  setTag: (id) => {
    set({ activeTag: id, activeFolder: null })
    void get().refreshLibrary()
  },
  setSearch: (q) => {
    set({ search: q })
    void get().refreshLibrary()
  },

  refreshAnnotations: async (docId) => {
    const annotations = await api.listAnnotations(docId)
    set({ annotations })
  },

  addAnnotation: async (docId, page, rects, quote, color) => {
    try {
      await api.createAnnotation({
        document_id: docId, page, kind: 'highlight',
        rects, color, quote, comment: '',
      })
      await get().refreshAnnotations(docId)
    } catch (e) {
      set({ error: String(e) })
    }
  },

  removeAnnotation: async (id) => {
    await api.deleteAnnotation(id)
    const doc = get().currentDoc
    if (doc) await get().refreshAnnotations(doc.id)
  },

  clearError: () => set({ error: null }),

  // ---------------- 阅读 ----------------

  loadSegments: async (docId) => {
    try {
      const resp = await api.getSegments(docId)
      const translations: Record<string, { text: string; provider: string }> = {}
      for (const s of resp.segments) {
        if (s.zh) translations[s.id] = { text: s.zh, provider: s.zh_provider ?? '' }
      }
      set({
        segments: resp.segments,
        translations,
        parseState: resp.count > 0 ? 'done' : 'pending',
        parseProgress: resp.count > 0 ? 100 : 0,
      })
      await get().refreshAIConfig()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  refreshAIConfig: async () => {
    try {
      const eng = await api.getEngines()
      set({ aiReady: eng.ai_configured })
    } catch {
      set({ aiReady: false })
    }
  },

  startParse: async (engine = 'auto') => {
    const doc = get().currentDoc
    if (!doc) return
    set({ parseState: 'running', parseProgress: 5, error: null })
    try {
      const r = await api.startParse(doc.id, engine)
      if (r.state === 'done') {
        await get().loadSegments(doc.id)
        set({ parseState: 'done', parseProgress: 100 })
      } else {
        set({ parseState: r.state, parseProgress: 10 })
        await get().pollParse(doc.id)
      }
    } catch (e) {
      set({ parseState: 'failed', error: String(e) })
    }
  },

  pollParse: async (docId) => {
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 2500))
      try {
        const p = await api.parseProgress(docId)
        set({ parseState: p.state, parseProgress: p.progress ?? 0 })
        if (p.state === 'done') {
          await get().loadSegments(docId)
          return
        }
        if (p.state === 'failed') {
          set({ error: p.error ?? '解析失败' })
          return
        }
      } catch (e) {
        set({ parseState: 'failed', error: String(e) })
        return
      }
    }
  },

  /**
   * 翻译队列：按 CONCURRENCY 并发推进。
   * 只对未翻译、未在飞的段落发请求，结果合并进 translations。
   */
  translateQueue: async (ids) => {
    const st = get()
    if (!st.aiReady || !st.currentDoc) return
    const docId = st.currentDoc.id

    const pending = ids.filter((id) => !st.translations[id] && !st.inflight.has(id))
    if (!pending.length) return

    const inflight = new Set(st.inflight)
    pending.forEach((id) => inflight.add(id))
    set({ inflight })

    // 分片并发
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const chunk = pending.slice(i, i + CONCURRENCY)
      try {
        const resp = await api.translateSegments(docId, chunk)
        const translations = { ...get().translations }
        for (const r of resp.results) {
          if (r.text) translations[r.segment_id] = { text: r.text, provider: r.provider }
        }
        const nextInflight = new Set(get().inflight)
        chunk.forEach((id) => nextInflight.delete(id))
        set({ translations, inflight: nextInflight })

        if (resp.errors?.length) {
          set({ error: `翻译失败：${resp.errors[0].error}` })
          const ni = new Set(get().inflight)
          chunk.forEach((id) => ni.delete(id))
          set({ inflight: ni })
          break
        }
      } catch (e) {
        set({ error: String(e) })
        const ni = new Set(get().inflight)
        chunk.forEach((id) => ni.delete(id))
        set({ inflight: ni })
        break
      }
    }
  },
}))
