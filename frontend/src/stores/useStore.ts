import { create } from 'zustand'
import { api, type Annotation, type DocumentMeta, type Folder, type Tag } from '../api/client'

interface State {
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
}

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
    set({ loading: true, error: null })
    try {
      const currentDoc = await api.getDocument(id)
      const annotations = await api.listAnnotations(id)
      set({ currentDoc, annotations, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  closeDocument: () => set({ currentDoc: null, annotations: [] }),

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
}))
