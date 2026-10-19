import { useState } from 'react'
import { useStore } from '../stores/useStore'
import { api } from '../api/client'

export default function NotePanel({ width = 300, embedded = false }: { width?: number; embedded?: boolean }) {
  const currentDoc = useStore((s) => s.currentDoc)
  const annotations = useStore((s) => s.annotations)
  const removeAnnotation = useStore((s) => s.removeAnnotation)
  const refreshAnnotations = useStore((s) => s.refreshAnnotations)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [tagInput, setTagInput] = useState('')

  /** 根据 embedded 决定外层容器 */
  const Shell = ({ children }: { children: React.ReactNode }) =>
    embedded ? (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {children}
      </div>
    ) : (
      <aside style={{ ...panelStyle, width }}>{children}</aside>
    )

  if (!currentDoc) {
    return (
      <Shell>
        <div className="hint" style={{ padding: 16 }}>选择一篇文献开始阅读</div>
      </Shell>
    )
  }

  // 段落流标注按段落序号分组，PDF 坐标标注按页码分组
  type Group = { key: string; label: string; order: number; items: typeof annotations }
  const groups: Group[] = []
  const segGroups = new Map<string, Group>()
  const pageGroups = new Map<number, Group>()

  for (const a of annotations) {
    if (a.segment_id) {
      const k = a.segment_id
      let g = segGroups.get(k)
      if (!g) {
        g = {
          key: k,
          label: a.segment_idx !== null && a.segment_idx !== undefined
            ? `第 ${a.segment_idx + 1} 段`
            : '段落',
          order: a.segment_idx ?? 9999,
          items: [],
        }
        segGroups.set(k, g)
        groups.push(g)
      }
      g.items.push(a)
    } else {
      let g = pageGroups.get(a.page)
      if (!g) {
        g = { key: `p${a.page}`, label: `第 ${a.page} 页`, order: 100000 + a.page, items: [] }
        pageGroups.set(a.page, g)
        groups.push(g)
      }
      g.items.push(a)
    }
  }
  groups.sort((x, y) => x.order - y.order)

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
    <Shell>
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
            在「双语阅读」里选中文字，气泡中点色块高亮、或点「笔记」。
            <br />PDF 视图里选中文字也能高亮。
          </div>
        )}
        {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 5 }}>
                {g.label}
              </div>
              {g.items.map((a) => (
                <div key={a.id} style={{
                  padding: '6px 8px', marginBottom: 6, borderRadius: 6,
                  borderLeft: `3px solid ${a.color}`, background: 'var(--bg-card)',
                }}>
                  {a.segment_id && (
                    <span style={{
                      fontSize: 9, padding: '0 4px', borderRadius: 3, marginBottom: 3,
                      display: 'inline-block',
                      background: a.side === 'zh' ? 'var(--zh-bg)' : 'var(--bg-active)',
                      color: a.side === 'zh' ? 'var(--zh-fg)' : 'var(--fg-muted)',
                    }}>{a.side === 'zh' ? '译文' : '原文'}</span>
                  )}
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
    </Shell>
  )
}

const panelStyle: React.CSSProperties = {
  flexShrink: 0, borderLeft: '1px solid var(--border)',
  display: 'flex', flexDirection: 'column', background: 'var(--bg-side)',
  overflow: 'hidden',
}
