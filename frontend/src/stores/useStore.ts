import { create } from 'zustand'
import {
  api,
  type Annotation, type DocumentMeta, type Folder, type RemapReport, type Segment, type Tag,
} from '../api/client'
import { DEFAULT_ANNOTATION_COLOR } from '../lib/annotationColors'

/** 书库智能视图：客户端在已获取的文献列表上过滤 */
export type SmartView = 'all' | 'recent' | 'unread' | 'parsed' | 'bilingual' | 'annotated'
/** 书库排序方式 */
export type LibrarySort = 'added' | 'opened' | 'title'
/** 主视图：书库 / 阅读 / 情报雷达 */
export type MainView = 'library' | 'reader' | 'radar'
/** 右侧面板页签：导读 / 问答 / 标注 / 信息 */
export type RightTab = 'guide' | 'chat' | 'notes' | 'info'
/** 目录/标注/引用请求跳页：nonce 保证同一页重复请求也能触发 */
export interface JumpRequest {
  page: number
  nonce: number
}
/** 问答引用块：划词原文与所在页 */
export interface ChatQuote {
  text: string
  page: number
}
/** 自动发送的问题（「解释」用），由 ChatPanel 消费后清空 */
export interface ChatAutoSend {
  text: string
  nonce: number
}
/** 「解释」动作自动发送的提示语 */
export const EXPLAIN_PROMPT = '请结合上下文解释这段话（先一句话概括，再展开）：'
const LS_LEFT_OPEN = 'pr.leftOpen'
/** 左栏目录的默认显隐：宽屏默认展开，窄屏默认收起 */
const LEFT_WIDE_PX = 1280

/** 读取左栏显隐偏好；无记录时按视口宽度决定 */
function readLeftOpen(): boolean {
  const raw = window.localStorage.getItem(LS_LEFT_OPEN)
  if (raw === 'true' || raw === 'false') return raw === 'true'
  return window.innerWidth >= LEFT_WIDE_PX
}

/** 文档标签页（只存 id 与标题，文档内容按需加载） */
export interface OpenTab {
  id: string
  title: string
}

const LS_TABS = 'pr.openTabs'
const LS_PAGE_POS = 'pr.pagePos'
/** 阅读页码写入 localStorage 的节流间隔（毫秒） */
const PAGE_POS_SAVE_MS = 500

/** 读取 localStorage JSON，解析失败或类型不符时返回兜底值 */
function readLocal<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    return valid(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

const isOpenTabs = (v: unknown): v is OpenTab[] =>
  Array.isArray(v) && v.every((t) => typeof t?.id === 'string' && typeof t?.title === 'string')
const isPagePos = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 书库列表请求的递增序号 */
let librarySeq = 0

let pagePosTimer: number | null = null
/** 立即把当前页码记忆写入 localStorage（定时器触发、页面隐藏/卸载时调用） */
function flushPagePos(): void {
  if (pagePosTimer !== null) {
    window.clearTimeout(pagePosTimer)
    pagePosTimer = null
  }
  window.localStorage.setItem(LS_PAGE_POS, JSON.stringify(useStore.getState().pagePos))
}
/** 节流写入页码记忆：定时器触发时读取最新快照，窗口内的变化都会落盘 */
function schedulePagePosSave(): void {
  if (pagePosTimer !== null) return
  pagePosTimer = window.setTimeout(flushPagePos, PAGE_POS_SAVE_MS)
}

/** 标签页去重追加：已存在则保持原位 */
function addTab(tabs: OpenTab[], tab: OpenTab): OpenTab[] {
  return tabs.some((t) => t.id === tab.id) ? tabs : [...tabs, tab]
}

function persistTabs(tabs: OpenTab[]): void {
  window.localStorage.setItem(LS_TABS, JSON.stringify(tabs))
}

/** 按智能视图过滤文献（客户端过滤，不改变后端接口） */
export function filterBySmartView(docs: DocumentMeta[], view: SmartView): DocumentMeta[] {
  switch (view) {
    case 'recent':
      return docs.filter((d) => d.opened_at).sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''))
    case 'unread':
      return docs.filter((d) => !d.opened_at)
    case 'parsed':
      return docs.filter((d) => d.parse_status === 'done')
    case 'bilingual':
      return docs.filter((d) => d.bilingual_ready)
    case 'annotated':
      return docs.filter((d) => (d.annotation_count ?? 0) > 0)
    default:
      return docs
  }
}

/** 按排序方式返回新数组（不修改原数组） */
export function sortDocuments(docs: DocumentMeta[], sort: LibrarySort): DocumentMeta[] {
  const list = [...docs]
  if (sort === 'title') return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
  if (sort === 'opened') return list.sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''))
  return list
}

/** 段落流标注无法自动对应时给出提示；全部迁移成功则不打扰 */
function announceRemap(remap?: RemapReport): void {
  if (!remap || remap.detached <= 0) return
  useStore.setState({
    notice: `重新解析完成：${remap.detached} 条段落标注无法自动对应，已保留为页面标注`,
  })
}

interface State {
  // 库
  folders: Folder[]
  tags: Tag[]
  documents: DocumentMeta[]
  /** 不受文件夹/标签/搜索影响的全量文献，用于智能视图计数 */
  allDocuments: DocumentMeta[]
  currentDoc: DocumentMeta | null
  annotations: Annotation[]
  activeFolder: string | null
  activeTag: string | null
  search: string
  loading: boolean
  error: string | null
  mainView: MainView
  /** 已打开的文档标签页（顺序即标签栏顺序） */
  openTabs: OpenTab[]
  /** 每篇文档上次阅读的页码 */
  pagePos: Record<string, number>
  smartView: SmartView
  librarySort: LibrarySort
  /** 右侧面板是否展开（收起时只剩竖向导航轨） */
  rightOpen: boolean
  rightTab: RightTab
  /** 左侧目录栏是否展开（localStorage 'pr.leftOpen' 持久化） */
  leftOpen: boolean
  jumpRequest: JumpRequest | null
  chatQuote: ChatQuote | null
  chatAutoSend: ChatAutoSend | null
  /** 需要在笔记面板中定位并进入编辑态的标注 id */
  focusAnnotationId: string | null
  /** 最近使用的划线色，划词菜单「h」键直接用它保存 */
  lastColor: string

  // 阅读
  segments: Segment[]
  translations: Record<string, { text: string; provider: string }>
  inflight: Set<string>
  aiReady: boolean
  /** MinerU 是否已配置 MINERU_TOKEN（重新解析菜单据此启用云端选项） */
  mineruReady: boolean
  /** 重新解析浮层是否打开（目录页签 / 阅读头部 / ⌘K 共用） */
  showReparse: boolean
  setShowReparse: (v: boolean) => void
  parseState: string
  /** 轻量提示条文案（非错误，如重新解析后标注迁移结果）；定时自动清除 */
  notice: string | null
  setNotice: (msg: string | null) => void
  parseProgress: number
  engines: import('../api/client').EngineInfo[]
  selectedEngine: string | null   // null = 自动（按优先级）

  // 动作
  refreshLibrary: () => Promise<void>
  refreshSidebar: () => Promise<void>
  openDocument: (id: string) => Promise<void>
  closeDocument: () => void
  closeTab: (id: string) => void
  setPagePos: (docId: string, page: number) => void
  setFolder: (id: string | null) => void
  setTag: (id: string | null) => void
  setSmartView: (v: SmartView) => void
  setLibrarySort: (v: LibrarySort) => void
  setSearch: (q: string) => void
  setMainView: (v: MainView) => void
  refreshAnnotations: (docId: string) => Promise<void>
  addAnnotation: (docId: string, page: number, rects: number[][], quote: string, color: string,
                  opts?: { segmentId?: string; side?: string; kind?: string
                           startOffset?: number; endOffset?: number }) => Promise<Annotation | null>
  setRightOpen: (v: boolean) => void
  openRight: (tab: RightTab) => void
  setLeftOpen: (v: boolean) => void
  requestJump: (page: number) => void
  setChatQuote: (q: ChatQuote | null) => void
  askAI: (quote: string, page: number, mode: 'ask' | 'explain') => void
  setFocusAnnotation: (id: string | null) => void
  setLastColor: (color: string) => void
  removeAnnotation: (id: string) => Promise<void>
  clearError: () => void
  moveDocumentToFolder: (docId: string, folderId: string | null, additive?: boolean) => Promise<void>

  // 阅读动作
  loadSegments: (docId: string) => Promise<void>
  startParse: (engine?: 'auto' | 'mineru' | 'local') => Promise<void>
  pollParse: (docId: string) => Promise<void>
  translateQueue: (ids: string[], engine?: string | null) => Promise<void>
  refreshAIConfig: () => Promise<void>
  loadEngines: () => Promise<void>
  setSelectedEngine: (name: string | null) => void
  resetTranslations: () => void
  refreshCurrentDocMeta: () => Promise<void>
}

/** 同时在飞的翻译请求上限（中转站常有 rpm 限流，默认保守取 2） */
const CONCURRENCY = 2
/** 连续失败多少次后停止本批翻译 */
const MAX_ERRORS = 3

export const useStore = create<State>((set, get) => ({
  folders: [],
  tags: [],
  documents: [],
  allDocuments: [],
  currentDoc: null,
  annotations: [],
  activeFolder: null,
  activeTag: null,
  search: '',
  loading: false,
  error: null,
  mainView: 'library',
  openTabs: readLocal<OpenTab[]>(LS_TABS, [], isOpenTabs),
  pagePos: readLocal<Record<string, number>>(LS_PAGE_POS, {}, isPagePos),
  smartView: 'all',
  librarySort: 'added',
  rightOpen: true,
  rightTab: 'chat',
  leftOpen: readLeftOpen(),
  jumpRequest: null,
  chatQuote: null,
  chatAutoSend: null,
  focusAnnotationId: null,
  lastColor: DEFAULT_ANNOTATION_COLOR,

  segments: [],
  translations: {},
  inflight: new Set<string>(),
  aiReady: false,
  mineruReady: false,
  showReparse: false,
  setShowReparse: (v) => set({ showReparse: v }),
  parseState: 'idle',   // idle=未解析 | queued=排队中 | pending/running=进行中 | done | failed
  notice: null,
  setNotice: (msg) => set({ notice: msg }),
  parseProgress: 0,
  engines: [],
  selectedEngine: null,

  refreshSidebar: async () => {
    const [folders, tags] = await Promise.all([api.listFolders(), api.listTags()])
    set({ folders, tags })
  },

  refreshLibrary: async () => {
    // 请求序号：连续触发（如搜索逐字输入）时只采纳最后一次的结果，防止旧响应晚到覆盖
    const seq = ++librarySeq
    set({ loading: true, error: null })
    try {
      const { activeFolder, activeTag, search } = get()
      const filtered = !!(activeFolder || activeTag || search)
      // 有筛选时并行再取一份全量列表，供智能视图计数使用；无筛选直接复用
      const [documents, allDocuments] = await Promise.all([
        api.listDocuments({
          folder_id: activeFolder ?? undefined,
          tag_id: activeTag ?? undefined,
          q: search || undefined,
        }),
        filtered ? api.listDocuments() : Promise.resolve<DocumentMeta[] | null>(null),
      ])
      if (seq !== librarySeq) return
      set({ documents, allDocuments: allDocuments ?? documents, loading: false })
    } catch (e) {
      if (seq !== librarySeq) return
      set({ error: String(e), loading: false })
    }
  },

  openDocument: async (id) => {
    set({ loading: true, error: null, segments: [], translations: {}, parseState: 'idle', parseProgress: 0, mainView: 'reader' })
    try {
      const currentDoc = await api.getDocument(id)
      const annotations = await api.listAnnotations(id)
      const openTabs = addTab(get().openTabs, { id, title: currentDoc.title })
      set({ currentDoc, annotations, openTabs, loading: false })
      persistTabs(openTabs)
      await get().loadSegments(id)
    } catch (e) {
      // 恢复的标签若已失效（文档被删），顺手移除
      const openTabs = get().openTabs.filter((t) => t.id !== id)
      set({ error: String(e), loading: false, openTabs })
      persistTabs(openTabs)
    }
  },

  closeDocument: () =>
    set({ currentDoc: null, annotations: [], segments: [], translations: {} }),

  closeTab: (id) => {
    const { openTabs, currentDoc } = get()
    const idx = openTabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const rest = openTabs.filter((t) => t.id !== id)
    set({ openTabs: rest })
    persistTabs(rest)
    if (currentDoc?.id !== id) return
    // 关闭的是当前文档：优先切到右邻标签，其次左邻；都没有则回书库
    const neighbor = openTabs[idx + 1] ?? openTabs[idx - 1]
    // 只有阅读视图下才切到相邻标签；其他视图（如书库删除文档）停留在原视图
    if (neighbor && get().mainView === 'reader') {
      void get().openDocument(neighbor.id)
      return
    }
    get().closeDocument()
    if (!neighbor) set({ mainView: 'library' })
  },

  setPagePos: (docId, page) => {
    const pagePos = { ...get().pagePos, [docId]: page }
    set({ pagePos })
    schedulePagePosSave()
  },

  setMainView: (v) => set({ mainView: v }),

  setRightOpen: (v) => set({ rightOpen: v }),
  openRight: (tab) => set({ rightOpen: true, rightTab: tab }),
  setLeftOpen: (v) => {
    window.localStorage.setItem(LS_LEFT_OPEN, String(v))
    set({ leftOpen: v })
  },
  requestJump: (page) => set({ jumpRequest: { page, nonce: (get().jumpRequest?.nonce ?? 0) + 1 } }),
  setChatQuote: (q) => set({ chatQuote: q }),
  askAI: (quote, page, mode) => {
    set({ rightOpen: true, rightTab: 'chat', chatQuote: { text: quote, page } })
    if (mode === 'explain') {
      set({ chatAutoSend: { text: EXPLAIN_PROMPT, nonce: (get().chatAutoSend?.nonce ?? 0) + 1 } })
    }
  },
  setFocusAnnotation: (id) => set({ focusAnnotationId: id }),
  setLastColor: (color) => set({ lastColor: color }),

  setFolder: (id) => {
    set({ activeFolder: id, activeTag: null, smartView: 'all', mainView: 'library' })
    void get().refreshLibrary()
  },
  setTag: (id) => {
    set({ activeTag: id, activeFolder: null, smartView: 'all', mainView: 'library' })
    void get().refreshLibrary()
  },
  setSmartView: (v) => {
    set({ smartView: v, activeFolder: null, activeTag: null, mainView: 'library' })
    void get().refreshLibrary()
  },
  setLibrarySort: (v) => set({ librarySort: v }),
  setSearch: (q) => {
    set({ search: q })
    void get().refreshLibrary()
  },

  refreshAnnotations: async (docId) => {
    const annotations = await api.listAnnotations(docId)
    set({ annotations })
  },

  addAnnotation: async (docId, page, rects, quote, color, opts) => {
    // 乐观更新：先插入临时标注让高亮立即可见，落库成功后刷新替换；
    // 失败则回滚并报错。避免后端被同步任务阻塞时高亮“消失”的体感
    const now = new Date().toISOString()
    const tmp: Annotation = {
      id: `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      document_id: docId, page, kind: opts?.kind ?? 'highlight',
      rects, color, quote, comment: '',
      segment_id: opts?.segmentId ?? null,
      side: opts?.side ?? 'source',
      segment_idx: null,
      start_offset: opts?.startOffset ?? null,
      end_offset: opts?.endOffset ?? null,
      created_at: now, updated_at: now,
    }
    set((s) => ({ annotations: [...s.annotations, tmp] }))
    try {
      const saved = await api.createAnnotation({
        document_id: docId, page, kind: opts?.kind ?? 'highlight',
        rects, color, quote, comment: '',
        segment_id: opts?.segmentId ?? null,
        side: opts?.side ?? 'source',
        start_offset: opts?.startOffset ?? null,
        end_offset: opts?.endOffset ?? null,
      })
      await get().refreshAnnotations(docId)
      return saved
    } catch (e) {
      set((s) => ({
        annotations: s.annotations.filter((a) => a.id !== tmp.id),
        error: String(e),
      }))
      return null
    }
  },

  removeAnnotation: async (id) => {
    await api.deleteAnnotation(id)
    const doc = get().currentDoc
    if (doc) await get().refreshAnnotations(doc.id)
  },

  clearError: () => set({ error: null }),

  /**
   * 把文献移动到文件夹。
   *   folderId = null  → 移出所有文件夹（未分类）
   *   additive = true  → 追加到该文件夹（保留原有归属）
   *   默认（false）    → 替换：只属于目标文件夹
   */
  moveDocumentToFolder: async (docId, folderId, additive = false) => {
    const doc = get().documents.find((d) => d.id === docId)
    const existing = (doc?.folders ?? []).map((f) => f.id)

    let next: string[]
    if (folderId === null) {
      next = []
    } else if (additive) {
      next = Array.from(new Set([...existing, folderId]))
    } else {
      next = [folderId]
    }

    // 乐观更新，失败再回滚
    const prev = existing
    set({
      documents: get().documents.map((d) =>
        d.id === docId
          ? {
              ...d,
              folders: get().folders.filter((f) => next.includes(f.id)),
            }
          : d,
      ),
    })

    try {
      await api.setDocumentFolders(docId, next)
      await get().refreshSidebar()
      await get().refreshLibrary()
    } catch (e) {
      set({
        error: `移动失败：${String(e).replace(/^Error:\s*/, '')}`,
        documents: get().documents.map((d) =>
          d.id === docId
            ? { ...d, folders: get().folders.filter((f) => prev.includes(f.id)) }
            : d,
        ),
      })
    }
  },

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
        parseState: resp.count > 0 ? 'done' : 'idle',
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
      // 有任何可用引擎就认为可以翻译
      const list = await api.getEnginesList()
      const usable = list.engines.filter((e) => e.enabled && e.configured).length
      set({ aiReady: eng.ai_configured || usable > 0, engines: list.engines, mineruReady: eng.mineru_configured })
    } catch {
      set({ aiReady: false, mineruReady: false })
    }
  },

  loadEngines: async () => {
    try {
      const list = await api.getEnginesList()
      set({ engines: list.engines })
    } catch { /* 忽略 */ }
  },

  setSelectedEngine: (name) => set({ selectedEngine: name }),

  /** 清空前端已加载的译文（用于重翻） */
  resetTranslations: () => set({ translations: {}, inflight: new Set<string>() }),

  /**
   * 只刷新当前文档的元数据（标签、文件夹等），不重载段落与译文。
   * 用于打标签这类操作，避免整页重建导致输入中断。
   */
  refreshCurrentDocMeta: async () => {
    const doc = get().currentDoc
    if (!doc) return
    try {
      const fresh = await api.getDocument(doc.id)
      set({ currentDoc: fresh })
    } catch { /* 忽略 */ }
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
        announceRemap(r.remap)
      } else {
        set({ parseState: r.state, parseProgress: r.state === 'queued' ? 0 : 10 })
        await get().pollParse(doc.id)
      }
    } catch (e) {
      set({ parseState: 'failed', error: String(e) })
    }
    // 段落 id 已整体替换：刷新标注（段落流标注已迁移/解除锚定）与文档元数据（parse_engine）
    await get().refreshCurrentDocMeta()
    if (get().currentDoc?.id === doc.id) await get().refreshAnnotations(doc.id)
  },

  pollParse: async (docId) => {
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 2500))
      try {
        const p = await api.parseProgress(docId)
        set({ parseState: p.state, parseProgress: p.progress ?? 0 })
        if (p.state === 'done') {
          await get().loadSegments(docId)
          announceRemap(p.remap)
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
  translateQueue: async (ids, engine) => {
    const st = get()
    const eng = engine !== undefined ? engine : st.selectedEngine
    if (!st.aiReady || !st.currentDoc) return
    const docId = st.currentDoc.id

    const pending = ids.filter((id) => !st.translations[id] && !st.inflight.has(id))
    if (!pending.length) return

    const inflight = new Set(st.inflight)
    pending.forEach((id) => inflight.add(id))
    set({ inflight })

    // 分片并发
    let errStreak = 0
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const chunk = pending.slice(i, i + CONCURRENCY)
      const dropInflight = () => {
        const ni = new Set(get().inflight)
        chunk.forEach((id) => ni.delete(id))
        set({ inflight: ni })
      }
      try {
        const resp = await api.translateSegments(docId, chunk, false, eng)
        const translations = { ...get().translations }
        for (const r of resp.results) {
          if (r.text) translations[r.segment_id] = { text: r.text, provider: r.provider }
        }
        set({ translations })
        dropInflight()

        if (resp.errors?.length) {
          errStreak++
          const first = resp.errors[0].error || ''
          set({
            error: first.includes('限流') || first.includes('429')
              ? '接口限流，已自动重试；建议调小并发或稍后再试'
              : `翻译失败：${first.slice(0, 120)}`,
          })
          if (errStreak >= MAX_ERRORS) break
          // 限流时放慢节奏
          await new Promise((r) => setTimeout(r, 1500 * errStreak))
        } else {
          errStreak = 0
        }
      } catch (e) {
        dropInflight()
        set({ error: String(e).slice(0, 160) })
        break
      }
    }
  },
}))

// 离开页面前立即落盘，避免节流窗口内的页码变化丢失
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPagePos)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPagePos()
  })
}
