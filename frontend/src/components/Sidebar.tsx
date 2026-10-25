import { useState } from 'react'
import { useStore, filterBySmartView, type SmartView } from '../stores/useStore'
import { api, type Folder } from '../api/client'
import {
  Icon, PATH_FOLDER, PATH_PLUS, PATH_PENCIL, PATH_TRASH, PATH_RADAR,
} from './icons'

/** 智能视图列表（顺序即展示顺序） */
const SMART_VIEWS: Array<{ value: SmartView; label: string }> = [
  { value: 'all', label: '全部论文' },
  { value: 'recent', label: '最近阅读' },
  { value: 'unread', label: '未读' },
  { value: 'parsed', label: '已解析' },
  { value: 'bilingual', label: '双语就绪' },
  { value: 'annotated', label: '有笔记' },
]

/** api client 抛错形如 "409: {"detail":"..."}"，提取 detail 供提示 */
function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const i = m.indexOf('{')
  if (i >= 0) {
    try {
      const detail = JSON.parse(m.slice(i)).detail
      if (detail) return String(detail)
    } catch {
      /* 非 JSON，原样返回 */
    }
  }
  return m
}

export default function Sidebar({ width = 200 }: { width?: number }) {
  const folders = useStore((s) => s.folders)
  const tags = useStore((s) => s.tags)
  const allDocuments = useStore((s) => s.allDocuments)
  const activeFolder = useStore((s) => s.activeFolder)
  const activeTag = useStore((s) => s.activeTag)
  const smartView = useStore((s) => s.smartView)
  const mainView = useStore((s) => s.mainView)
  const setMainView = useStore((s) => s.setMainView)
  const setFolder = useStore((s) => s.setFolder)
  const setTag = useStore((s) => s.setTag)
  const setSmartView = useStore((s) => s.setSmartView)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const refreshLibrary = useStore((s) => s.refreshLibrary)

  const moveDocumentToFolder = useStore((s) => s.moveDocumentToFolder)
  const [newFolder, setNewFolder] = useState('')
  const [newTag, setNewTag] = useState('')
  const [adding, setAdding] = useState<'folder' | 'tag' | null>(null)
  /** 当前拖拽悬停的目标：'all' 或 folderId */
  const [dragTarget, setDragTarget] = useState<string | null>(null)
  /** 鼠标悬停的文件夹行（用于显示编辑/删除按钮） */
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** 正在重命名的文件夹 id 与输入值 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  /** 判断拖拽内容是否为文献 */
  const isDocDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('application/x-paper-doc')

  const dropProps = (targetId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isDocDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragTarget(targetId ?? 'all')
    },
    onDragLeave: () => setDragTarget(null),
    onDrop: (e: React.DragEvent) => {
      const docId = e.dataTransfer.getData('application/x-paper-doc')
      setDragTarget(null)
      if (!docId) return
      e.preventDefault()
      // 按住 Alt 为「追加到该文件夹」，默认是「移动到该文件夹」
      void moveDocumentToFolder(docId, targetId, e.altKey)
    },
  })

  const rootFolders = folders.filter((f) => !f.parent_id)
  const childrenOf = (id: string) => folders.filter((f) => f.parent_id === id)

  const createFolder = async () => {
    const name = newFolder.trim()
    if (!name) return
    try {
      await api.createFolder(name)
      setNewFolder(''); setAdding(null)
      await refreshSidebar(); await refreshLibrary()
    } catch (e) {
      alert(errText(e))
    }
  }

  const commitRename = async (f: Folder) => {
    const name = editingName.trim()
    setEditingId(null)
    if (!name || name === f.name) return
    try {
      await api.renameFolder(f.id, name)
      await refreshSidebar()
    } catch (e) {
      alert(errText(e))
    }
  }

  const removeFolder = async (f: Folder) => {
    const childIds = childrenOf(f.id).map((c) => c.id)
    const hint = childIds.length ? `（含 ${childIds.length} 个子文件夹，将一并删除）` : ''
    if (!confirm(`删除文件夹「${f.name}」${hint}？其中文献会移回未分类，不会被删除。`)) return
    try {
      await api.deleteFolder(f.id)
    } catch (e) {
      alert(errText(e))
      return
    }
    // 当前筛选的文件夹被删（或其祖先被删）时回退到「全部文献」
    if (activeFolder === f.id || (activeFolder && childIds.includes(activeFolder))) {
      setFolder(null)
    }
    await refreshSidebar(); await refreshLibrary()
  }

  const sidebarStyle: React.CSSProperties = {
    width, flexShrink: 0, borderRight: '1px solid var(--border)',
    padding: '12px 10px', overflowY: 'auto', background: 'var(--bg-side)',
    overflowX: 'hidden', display: 'flex', flexDirection: 'column',
  }

  const itemStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
    background: active ? 'var(--bg-active)' : 'transparent',
    color: active ? 'var(--fg-strong)' : 'var(--fg)',
    display: 'flex', alignItems: 'center', gap: 6,
  })

  const sectionTitle: React.CSSProperties = {
    fontSize: 11, color: 'var(--fg-muted)', letterSpacing: 0.5,
    margin: '14px 0 6px', textTransform: 'uppercase',
  }

  const opBtnStyle: React.CSSProperties = {
    cursor: 'pointer', padding: 2, display: 'inline-flex',
    color: 'var(--fg-muted)', borderRadius: 4,
  }

  const folderRow = (f: Folder, depth = 0) => {
    const isEditing = editingId === f.id
    const opsVisible = hoverId === f.id && !isEditing
    return (
      <div
        key={f.id}
        style={{
          ...itemStyle(activeFolder === f.id),
          paddingLeft: 8 + depth * 16,
          ...(dragTarget === f.id
            ? { background: 'var(--bg-active)', outline: '2px dashed var(--accent)', outlineOffset: -2 }
            : {}),
        }}
        onClick={() => setFolder(f.id)}
        onMouseEnter={() => setHoverId(f.id)}
        onMouseLeave={() => setHoverId(null)}
        {...dropProps(f.id)}
        data-folder-id={f.id}
      >
        <Icon d={PATH_FOLDER} />
        {isEditing ? (
          <input
            autoFocus value={editingName}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(f)
              if (e.key === 'Escape') setEditingId(null)
            }}
            onBlur={() => setEditingId(null)}
            style={{ flex: 1, fontSize: 12, padding: '2px 4px', minWidth: 0 }}
          />
        ) : (
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {f.name}
          </span>
        )}
        {opsVisible ? (
          <>
            <span
              title="重命名" style={opBtnStyle}
              onClick={(e) => { e.stopPropagation(); setEditingId(f.id); setEditingName(f.name) }}
            ><Icon d={PATH_PENCIL} size={11} /></span>
            <span
              title="删除" style={opBtnStyle}
              onClick={(e) => { e.stopPropagation(); void removeFolder(f) }}
            ><Icon d={PATH_TRASH} size={11} /></span>
          </>
        ) : (
          <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{f.count ?? 0}</span>
        )}
      </div>
    )
  }

  const smartRow = (v: { value: SmartView; label: string }) => {
    const active = mainView === 'library' && smartView === v.value && !activeFolder && !activeTag
    return (
      <div
        key={v.value}
        style={{
          ...itemStyle(active),
          ...(dragTarget === 'all' && v.value === 'all'
            ? { background: 'var(--bg-active)', outline: '2px dashed var(--accent)', outlineOffset: -2 }
            : {}),
        }}
        onClick={() => setSmartView(v.value)}
        {...(v.value === 'all' ? dropProps(null) : {})}
        data-smart-view={v.value}
        title={v.value === 'all' ? '拖到此处可移出所有文件夹' : undefined}
      >
        <span style={{ flex: 1 }}>{v.label}</span>
        <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{filterBySmartView(allDocuments, v.value).length}</span>
      </div>
    )
  }

  return (
    <aside style={sidebarStyle}>
      <div style={{ ...sectionTitle, marginTop: 0 }}>智能视图</div>
      {SMART_VIEWS.map(smartRow)}

      <div style={sectionTitle}>
        文件夹
        <span
          style={{ float: 'right', cursor: 'pointer', display: 'inline-flex' }}
          onClick={() => setAdding('folder')}
        ><Icon d={PATH_PLUS} size={12} /></span>
      </div>

      {adding === 'folder' && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <input
            autoFocus value={newFolder} placeholder="文件夹名"
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createFolder()
              if (e.key === 'Escape') setAdding(null)
            }}
            style={{ flex: 1, fontSize: 12, padding: '4px 6px' }}
          />
        </div>
      )}

      {rootFolders.map((f) => (
        <div key={f.id}>
          {folderRow(f)}
          {childrenOf(f.id).map((c) => folderRow(c, 1))}
        </div>
      ))}

      <div style={sectionTitle}>
        标签
        <span
          style={{ float: 'right', cursor: 'pointer', display: 'inline-flex' }}
          onClick={() => setAdding('tag')}
        ><Icon d={PATH_PLUS} size={12} /></span>
      </div>

      {adding === 'tag' && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <input
            autoFocus value={newTag} placeholder="标签名"
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && newTag.trim()) {
                await api.createTag(newTag.trim(), '#3b82f6')
                setNewTag(''); setAdding(null)
                await refreshSidebar()
              }
              if (e.key === 'Escape') setAdding(null)
            }}
            style={{ flex: 1, fontSize: 12, padding: '4px 6px' }}
          />
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {tags.map((t) => (
          <span
            key={t.id}
            onClick={() => setTag(t.id)}
            style={{
              fontSize: 12, padding: '3px 8px', borderRadius: 20, cursor: 'pointer',
              background: activeTag === t.id ? t.color : `${t.color}26`,
              color: activeTag === t.id ? '#fff' : t.color,
              border: `1px solid ${t.color}`,
            }}
          >
            {t.name}
          </span>
        ))}
      </div>

      {/* 底部：情报雷达入口卡 */}
      <div
        onClick={() => setMainView('radar')}
        title="多主题 arXiv 订阅 + 代码活性审计 + LLM 评审"
        style={{
          marginTop: 'auto', paddingTop: 12, cursor: 'pointer',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px',
          borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
          background: mainView === 'radar' ? 'var(--bg-active)' : 'var(--bg)',
          color: 'var(--fg)', fontSize: 12,
        }}>
          <Icon d={PATH_RADAR} size={14} />
          <span style={{ flex: 1 }}>情报雷达</span>
        </div>
      </div>
    </aside>
  )
}
