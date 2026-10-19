import { useState } from 'react'
import { useStore } from '../stores/useStore'
import { api } from '../api/client'

export default function NotePanel({ width = 300 }: { width?: number }) {
  const currentDoc = useStore((s) => s.currentDoc)
  const annotations = useStore((s) => s.annotations)
  const removeAnnotation = useStore((s) => s.removeAnnotation)
  const refreshAnnotations = useStore((s) => s.refreshAnnotations)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [tagInput, setTagInput] = useState('')

  if (!currentDoc) {
    return (
      <aside style={{ ...panelStyle, width }}>
        <div className="hint" style={{ padding: 16 }}>选择一篇文献开始阅读</div>
      </aside>
    )
  }

  const byPage = annotations.reduce<Record<number, typeof annotations>>((acc, a) => {
    ;(acc[a.page] ||= []).push(a)
    return acc
  }, {})

  const saveComment = async (id: string) => {
    await api.updateAnnotation(id, { comment: draft })
    setEditing(null)
    await refreshAnnotations(currentDoc.id)
  }

  const addTag = async () => {
    const name = tagInput.trim()
    if (!name) return
    const tag = await api.createTag(name, '#3b82f6')
    await api.tagDocument(currentDoc.id, tag.id)
    setTagInput('')
    await refreshSidebar()
    await useStore.getState().openDocument(currentDoc.id)
  }

  return (
    <aside style={{ ...panelStyle, width }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, lineHeight: 1.4 }}>
          {currentDoc.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8 }}>
          {currentDoc.page_count ?? '?'} 页 · {annotations.length} 条标注
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {currentDoc.tags.map((t) => (
            <span key={t.id} style={{
              fontSize: 11, padding: '2px 7px', borderRadius: 10,
              background: `${t.color}26`, color: t.color, border: `1px solid ${t.color}`,
            }}>{t.name}</span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addTag() }}
            placeholder="+ 标签"
            style={{ width: 70, fontSize: 11, padding: '2px 6px' }}
          />
        </div>

        <a
          href={api.exportUrl(currentDoc.id)}
          download={`${currentDoc.title}-notes.md`}
          className="btn-ghost"
          style={{ fontSize: 12, display: 'inline-block', padding: '4px 10px', textDecoration: 'none' }}
        >导出 Markdown</a>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {!annotations.length && (
          <div className="hint" style={{ padding: 12 }}>
            选中 PDF 中的文字，在气泡里点「高亮」即可创建标注。
          </div>
        )}
        {Object.entries(byPage)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([page, anns]) => (
            <div key={page} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 5 }}>
                第 {page} 页
              </div>
              {anns.map((a) => (
                <div key={a.id} style={{
                  padding: '6px 8px', marginBottom: 6, borderRadius: 6,
                  borderLeft: `3px solid ${a.color}`, background: 'var(--bg-card)',
                }}>
                  {a.quote && (
                    <div style={{ fontSize: 12, marginBottom: 4, lineHeight: 1.5, color: 'var(--fg-strong)' }}>
                      {a.quote}
                    </div>
                  )}
                  {editing === a.id ? (
                    <div>
                      <textarea
                        autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                        rows={3} style={{ width: '100%', fontSize: 12, marginBottom: 4 }}
                      />
                      <button className="btn-primary" style={{ fontSize: 11 }} onClick={() => void saveComment(a.id)}>保存</button>
                      <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setEditing(null)}>取消</button>
                    </div>
                  ) : (
                    <div
                      onClick={() => { setEditing(a.id); setDraft(a.comment ?? '') }}
                      style={{ fontSize: 12, color: a.comment ? 'var(--fg)' : 'var(--fg-muted)', cursor: 'text', minHeight: 18 }}
                    >
                      {a.comment || '点击写笔记…'}
                    </div>
                  )}
                  <button
                    className="btn-ghost"
                    style={{ fontSize: 10, padding: '1px 4px', marginTop: 2 }}
                    onClick={() => void removeAnnotation(a.id)}
                  >删除</button>
                </div>
              ))}
            </div>
          ))}
      </div>
    </aside>
  )
}

const panelStyle: React.CSSProperties = {
  flexShrink: 0, borderLeft: '1px solid var(--border)',
  display: 'flex', flexDirection: 'column', background: 'var(--bg-side)',
  overflow: 'hidden',
}
