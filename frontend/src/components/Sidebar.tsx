import { useState } from 'react'
import { useStore } from '../stores/useStore'
import { api } from '../api/client'

function FolderNode({ depth }: { depth: number }) {
  void depth
  return null
}
void FolderNode

export default function Sidebar({ width = 260 }: { width?: number }) {
  const folders = useStore((s) => s.folders)
  const tags = useStore((s) => s.tags)
  const activeFolder = useStore((s) => s.activeFolder)
  const activeTag = useStore((s) => s.activeTag)
  const setFolder = useStore((s) => s.setFolder)
  const setTag = useStore((s) => s.setTag)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const refreshLibrary = useStore((s) => s.refreshLibrary)

  const [newFolder, setNewFolder] = useState('')
  const [newTag, setNewTag] = useState('')
  const [adding, setAdding] = useState<'folder' | 'tag' | null>(null)

  const rootFolders = folders.filter((f) => !f.parent_id)
  const childrenOf = (id: string) => folders.filter((f) => f.parent_id === id)

  const sidebarStyle: React.CSSProperties = {
    width, flexShrink: 0, borderRight: '1px solid var(--border)',
    padding: '12px 10px', overflowY: 'auto', background: 'var(--bg-side)',
    overflowX: 'hidden',
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

  return (
    <aside style={sidebarStyle}>
      <div style={itemStyle(activeFolder === null && activeTag === null)} onClick={() => { setFolder(null) }}>
        <span>📚</span> 全部文献
      </div>

      <div style={sectionTitle}>
        文件夹
        <span style={{ float: 'right', cursor: 'pointer' }} onClick={() => setAdding('folder')}>＋</span>
      </div>

      {adding === 'folder' && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <input
            autoFocus value={newFolder} placeholder="文件夹名"
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && newFolder.trim()) {
                await api.createFolder(newFolder.trim())
                setNewFolder(''); setAdding(null)
                await refreshSidebar(); await refreshLibrary()
              }
              if (e.key === 'Escape') setAdding(null)
            }}
            style={{ flex: 1, fontSize: 12, padding: '4px 6px' }}
          />
        </div>
      )}

      {rootFolders.map((f) => (
        <div key={f.id}>
          <div style={itemStyle(activeFolder === f.id)} onClick={() => setFolder(f.id)}>
            <span>📁</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.name}
            </span>
            <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{f.count ?? 0}</span>
          </div>
          {childrenOf(f.id).map((c) => (
            <div key={c.id} style={{ ...itemStyle(activeFolder === c.id), paddingLeft: 24 }} onClick={() => setFolder(c.id)}>
              <span>📄</span>
              <span style={{ flex: 1 }}>{c.name}</span>
            </div>
          ))}
        </div>
      ))}

      <div style={sectionTitle}>
        标签
        <span style={{ float: 'right', cursor: 'pointer' }} onClick={() => setAdding('tag')}>＋</span>
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
    </aside>
  )
}
