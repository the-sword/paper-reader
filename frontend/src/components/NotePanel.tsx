import { useEffect, useRef, useState } from 'react'
import { useStore } from '../stores/useStore'
import { api, type Annotation } from '../api/client'
import { annotationLabel } from '../lib/annotationColors'

/**
 * 标注列表（右栏「标注」页签）。
 * 段落流标注按段落序号分组，PDF 坐标标注按页码分组。
 * 从划词菜单「笔记」进入时，通过 focusAnnotationId 定位到对应条目并直接进入评论编辑态。
 */
export default function NotePanel() {
  const currentDoc = useStore((s) => s.currentDoc)
  const annotations = useStore((s) => s.annotations)
  const removeAnnotation = useStore((s) => s.removeAnnotation)
  const refreshAnnotations = useStore((s) => s.refreshAnnotations)
  const focusAnnotationId = useStore((s) => s.focusAnnotationId)
  const setFocusAnnotation = useStore((s) => s.setFocusAnnotation)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // 定位并编辑指定标注：等列表渲染后滚动到该条，再进入评论编辑
  useEffect(() => {
    if (!focusAnnotationId) return
    const target = annotations.find((a) => a.id === focusAnnotationId)
    if (!target) return
    setEditing(target.id)
    setDraft(target.comment ?? '')
    setFocusAnnotation(null)
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-ann-id="${target.id}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [focusAnnotationId, annotations, setFocusAnnotation])

  if (!currentDoc) {
    return <div className="hint" style={{ padding: 16 }}>选择一篇文献开始阅读</div>
  }

  const groups = groupAnnotations(annotations)

  const saveComment = async (id: string) => {
    await api.updateAnnotation(id, { comment: draft })
    setEditing(null)
    await refreshAnnotations(currentDoc.id)
  }

  return (
    <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
      {!annotations.length && (
        <div className="hint" style={{ padding: 12 }}>
          选中原文后用划词菜单的色点或「笔记」添加标注。
        </div>
      )}
      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 5 }}>
            {g.label}
          </div>
          {g.items.map((a) => (
            <div key={a.id} data-ann-id={a.id} style={{
              padding: '6px 8px', marginBottom: 6, borderRadius: 6,
              borderLeft: `3px solid ${a.color}`, background: 'var(--bg-card)',
            }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                {a.segment_id && (
                  <span style={{
                    fontSize: 9, padding: '0 4px', borderRadius: 3,
                    background: a.side === 'zh' ? 'var(--zh-bg)' : 'var(--bg-active)',
                    color: a.side === 'zh' ? 'var(--zh-fg)' : 'var(--fg-muted)',
                  }}>{a.side === 'zh' ? '译文' : '原文'}</span>
                )}
                {annotationLabel(a.color) && (
                  <span style={{ fontSize: 10, color: a.color }}>{annotationLabel(a.color)}</span>
                )}
                <span style={{ fontSize: 10, color: 'var(--fg-muted)', marginLeft: 'auto' }}>p.{a.page}</span>
              </div>
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
  )
}

interface Group {
  key: string
  label: string
  order: number
  items: Annotation[]
}

/** 把标注按段落或页码分组，并按文档顺序排序 */
function groupAnnotations(annotations: Annotation[]): Group[] {
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
  return groups.sort((x, y) => x.order - y.order)
}
