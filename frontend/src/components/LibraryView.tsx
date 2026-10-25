import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, filterBySmartView, sortDocuments, type LibrarySort, type SmartView } from '../stores/useStore'
import { api, type DocumentMeta } from '../api/client'
import Sidebar from './Sidebar'
import LibraryList from './LibraryList'
import LibraryPreview from './LibraryPreview'
import { Icon, PATH_CHEVRON_DOWN, PATH_SEARCH, PATH_UPLOAD } from './icons'

/** 智能视图的展示名（与 Sidebar 保持一致） */
const SMART_TITLES: Record<SmartView, string> = {
  all: '全部论文',
  recent: '最近阅读',
  unread: '未读',
  parsed: '已解析',
  bilingual: '双语就绪',
  annotated: '有笔记',
}

const SORT_OPTIONS: Array<{ value: LibrarySort; label: string }> = [
  { value: 'added', label: '添加时间' },
  { value: 'opened', label: '最近打开' },
  { value: 'title', label: '标题' },
]

/** 手机端左侧筛选抽屉宽度 */
const DRAWER_W = 260

interface Props {
  isMobile: boolean
  onOpenArxiv: () => void
}

/** 书库页：智能视图 / 文件夹 / 标签（左）+ 文献列表（中）+ 预览（右，桌面端） */
export default function LibraryView({ isMobile, onOpenArxiv }: Props) {
  const documents = useStore((s) => s.documents)
  const folders = useStore((s) => s.folders)
  const tags = useStore((s) => s.tags)
  const loading = useStore((s) => s.loading)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const smartView = useStore((s) => s.smartView)
  const activeFolder = useStore((s) => s.activeFolder)
  const activeTag = useStore((s) => s.activeTag)
  const librarySort = useStore((s) => s.librarySort)
  const setLibrarySort = useStore((s) => s.setLibrarySort)
  const pagePos = useStore((s) => s.pagePos)
  const openDocument = useStore((s) => s.openDocument)
  const openTabs = useStore((s) => s.openTabs)
  const closeTab = useStore((s) => s.closeTab)
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const activeFolderName = folders.find((f) => f.id === activeFolder)?.name
  const activeTagName = tags.find((t) => t.id === activeTag)?.name

  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showFilter, setShowFilter] = useState(false)

  const visible = useMemo(
    () => sortDocuments(filterBySmartView(documents, smartView), librarySort),
    [documents, smartView, librarySort],
  )
  const selected = visible.find((d) => d.id === selectedId) ?? null

  // 手机端：筛选条件变化后自动收起抽屉
  useEffect(() => { setShowFilter(false) }, [smartView, activeFolder, activeTag])

  const title = activeFolderName ?? activeTagName ?? SMART_TITLES[smartView]

  const doUpload = async (files: FileList | File[]): Promise<void> => {
    setUploading(true)
    try {
      for (const f of Array.from(files)) {
        if (!f.name.toLowerCase().endsWith('.pdf')) continue
        await api.upload(f, activeFolder ?? undefined)
      }
      await refreshLibrary()
      await refreshSidebar()
    } finally {
      setUploading(false)
    }
  }

  const deleteDoc = async (doc: DocumentMeta): Promise<void> => {
    if (!confirm(`删除《${doc.title}》？`)) return
    await api.deleteDocument(doc.id)
    if (openTabs.some((t) => t.id === doc.id)) closeTab(doc.id)
    if (selectedId === doc.id) setSelectedId(null)
    await refreshLibrary(); await refreshSidebar()
  }

  /** 列表键盘操作：↑↓ 移动选中，Enter 打开 */
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!visible.length) return
    const idx = visible.findIndex((d) => d.id === selectedId)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = idx < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, idx + step))
      setSelectedId(visible[next].id)
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault()
      void openDocument(selected.id)
    }
  }

  const onDropFiles = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOver(false)
    void doUpload(e.dataTransfer.files)
  }

  const listEmpty = !loading && visible.length === 0
  const emptyLibrary = listEmpty && documents.length === 0 && smartView === 'all' && !activeFolder && !activeTag && !search

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
      {/* 顶部工具条 */}
      <div style={{
        height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 14px', borderBottom: '1px solid var(--border)',
      }}>
        {isMobile && (
          <button className="btn-ghost" onClick={() => setShowFilter(true)} style={{ fontSize: 12, padding: '4px 8px', whiteSpace: 'nowrap' }}>筛选</button>
        )}
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg-strong)', whiteSpace: 'nowrap' }}>{title}</span>
          <span className="hint">{visible.length}</span>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ position: 'relative', width: isMobile ? 140 : 220, flexShrink: 1 }}>
          <span style={{ position: 'absolute', left: 9, top: 8, color: 'var(--fg-muted)', display: 'flex' }}>
            <Icon d={PATH_SEARCH} size={13} />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标题…"
            style={{ width: '100%', fontSize: 12, padding: '6px 8px 6px 28px', borderRadius: 16 }}
          />
        </div>

        {!isMobile && (
          <select
            value={librarySort}
            onChange={(e) => setLibrarySort(e.target.value as LibrarySort)}
            style={{ fontSize: 12, padding: '5px 6px' }}
            title="排序"
          >
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}

        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            className="btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
            onClick={() => setMenuOpen((v) => !v)}
            disabled={uploading}
          >
            {uploading ? '导入中…' : <>导入论文 <Icon d={PATH_CHEVRON_DOWN} size={12} /></>}
          </button>
          {menuOpen && (
            <div
              onMouseLeave={() => setMenuOpen(false)}
              style={{
                position: 'absolute', right: 0, top: 34, zIndex: 30, minWidth: 170,
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-pop)', padding: 4,
              }}
            >
              <div className="cmd-item" onClick={() => { setMenuOpen(false); fileRef.current?.click() }}>
                <Icon d={PATH_UPLOAD} size={13} /> 上传 PDF
              </div>
              <div className="cmd-item" onClick={() => { setMenuOpen(false); onOpenArxiv() }}>
                <Icon d={PATH_SEARCH} size={13} /> 从 arXiv 搜索
              </div>
            </div>
          )}
          <input
            ref={fileRef} type="file" accept="application/pdf" multiple hidden
            onChange={(e) => e.target.files && void doUpload(e.target.files)}
          />
        </div>
      </div>

      {/* 主体：左列 | 列表 | 预览 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {!isMobile && <Sidebar width={200} />}

        <div
          tabIndex={0}
          onKeyDown={onListKey}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault(); setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDropFiles}
          style={{
            flex: 1, minWidth: 0, overflowY: 'auto', outline: 'none',
            border: dragOver ? '2px dashed var(--accent)' : '2px solid transparent',
            borderRadius: 4, margin: dragOver ? 4 : 0,
          }}
        >
          {loading && <div className="hint" style={{ padding: 16 }}>加载中…</div>}

          {emptyLibrary ? (
            <div style={{ textAlign: 'center', padding: '64px 24px' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg-strong)', marginBottom: 8 }}>书库还是空的</div>
              <div className="hint" style={{ marginBottom: 16 }}>拖入 PDF 到这里，或点击右上角「导入论文」</div>
              <button className="btn-primary" onClick={() => fileRef.current?.click()}>上传 PDF</button>
            </div>
          ) : listEmpty ? (
            <div className="hint" style={{ padding: 24, textAlign: 'center' }}>此视图下没有论文</div>
          ) : (
            <LibraryList
              docs={visible}
              selectedId={selectedId}
              pagePos={pagePos}
              isMobile={isMobile}
              onSelect={setSelectedId}
              onOpen={(id) => void openDocument(id)}
              onDelete={(d) => void deleteDoc(d)}
            />
          )}
        </div>

        {!isMobile && (
          <LibraryPreview
            doc={selected}
            lastPage={selected ? pagePos[selected.id] : undefined}
            onOpen={(id) => void openDocument(id)}
            onDelete={(d) => void deleteDoc(d)}
          />
        )}
      </div>

      {/* 手机端：左侧筛选抽屉（沿用 doc-drawer 遮罩写法） */}
      {isMobile && showFilter && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 60 }}
            onClick={() => setShowFilter(false)}
          />
          <div className="doc-drawer" style={{
            position: 'fixed', left: 0, top: 0, bottom: 56, zIndex: 61,
            width: DRAWER_W, boxShadow: '2px 0 16px rgba(0,0,0,.35)', display: 'flex',
          }}>
            <Sidebar width={DRAWER_W} />
          </div>
        </>
      )}
    </div>
  )
}
