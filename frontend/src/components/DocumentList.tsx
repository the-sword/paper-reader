import { useRef, useState } from 'react'
import { useStore } from '../stores/useStore'
import { api, type DocumentMeta } from '../api/client'

export default function DocumentList({ width = 340 }: { width?: number }) {
  const documents = useStore((s) => s.documents)
  const currentDoc = useStore((s) => s.currentDoc)
  const loading = useStore((s) => s.loading)
  const activeFolder = useStore((s) => s.activeFolder)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const openDocument = useStore((s) => s.openDocument)
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const refreshSidebar = useStore((s) => s.refreshSidebar)

  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const doUpload = async (files: FileList | File[]) => {
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

  return (
    <div className="doc-list" style={{ width, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg)', minWidth: 0 }}>
      <div style={{ padding: 10, borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索标题…"
          style={{ flex: '1 1 120px', minWidth: 0, fontSize: 13, padding: '6px 8px' }}
        />
        <button className="btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? '导入中' : '导入'}
        </button>
        <input
          ref={fileRef} type="file" accept="application/pdf" multiple hidden
          onChange={(e) => e.target.files && void doUpload(e.target.files)}
        />
      </div>

      <div
        style={{ flex: 1, overflowY: 'auto', padding: 8 }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false)
          void doUpload(e.dataTransfer.files)
        }}
      >
        {loading && <div className="hint">加载中…</div>}
        {!loading && !documents.length && (
          <div
            className="hint"
            style={{
              border: dragOver ? '2px dashed var(--accent)' : '2px dashed var(--border)',
              borderRadius: 8, padding: '28px 12px', textAlign: 'center', marginTop: 12,
            }}
          >
            拖入 PDF 或点「导入」
          </div>
        )}
        {documents.map((d) => (
          <DocCard
            key={d.id}
            doc={d}
            active={currentDoc?.id === d.id}
            onClick={() => void openDocument(d.id)}
            onDelete={async () => {
              await api.deleteDocument(d.id)
              await refreshLibrary(); await refreshSidebar()
            }}
          />
        ))}
      </div>
    </div>
  )
}

function DocCard({ doc, active, onClick, onDelete }: {
  doc: DocumentMeta; active: boolean; onClick: () => void; onDelete: () => void
}) {
  const [dragging, setDragging] = useState(false)

  return (
    <div
      onClick={onClick}
      className={`doc-card${dragging ? ' dragging' : ''}`}
      data-doc-id={doc.id}
      draggable
      onDragStart={(e) => {
        // 用自定义 MIME 区分「拖动文献」与「拖入文件」
        e.dataTransfer.setData('application/x-paper-doc', doc.id)
        e.dataTransfer.setData('text/plain', doc.title)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      title="拖动到左侧文件夹可归档"
      style={{
        padding: '8px 10px', borderRadius: 8, cursor: 'grab', marginBottom: 4,
        background: active ? 'var(--bg-active)' : 'transparent',
        borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
        opacity: dragging ? 0.45 : 1,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, lineHeight: 1.35 }}>
        {doc.title}
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>{doc.page_count ?? '?'} 页</span>
        {doc.tags.length > 0 && (
          <span style={{ display: 'flex', gap: 4 }}>
            {doc.tags.slice(0, 3).map((t) => (
              <span key={t.id} style={{
                background: `${t.color}26`, color: t.color,
                padding: '0 5px', borderRadius: 8, fontSize: 10,
              }}>{t.name}</span>
            ))}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <button
            className="btn-ghost"
            style={{ fontSize: 11, padding: '1px 5px' }}
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`删除《${doc.title}》？`)) onDelete()
            }}
          >删除</button>
        </span>
      </div>
    </div>
  )
}
