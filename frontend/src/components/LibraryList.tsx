import { useState } from 'react'
import type { DocumentMeta } from '../api/client'
import { Icon, PATH_TRASH } from './icons'

/** 阅读进度圆环的半径与线宽 */
const RING_R = 8
const RING_STROKE = 2.5

/** 格式化日期为 MM-DD */
function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 阅读进度圆环：fraction 取值 0–1 */
function ProgressRing({ fraction, title }: { fraction: number; title: string }) {
  const f = Math.min(1, Math.max(0, fraction))
  const c = 2 * Math.PI * RING_R
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" style={{ flexShrink: 0 }} aria-label={title}>
      <title>{title}</title>
      <circle cx={10} cy={10} r={RING_R} fill="none" stroke="var(--border)" strokeWidth={RING_STROKE} />
      {f > 0 && (
        <circle
          cx={10} cy={10} r={RING_R} fill="none" stroke="var(--accent)" strokeWidth={RING_STROKE}
          strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 10 10)"
        />
      )}
    </svg>
  )
}

/** 解析状态徽标：已解析 / 解析中 */
function ParseBadge({ status }: { status: string }) {
  if (status === 'done') return <span className="badge ok">解析✓</span>
  if (status === 'running' || status === 'pending' || status === 'queued') {
    return <span className="badge run">解析中</span>
  }
  return null
}

interface RowProps {
  doc: DocumentMeta
  selected: boolean
  lastPage: number | undefined
  isMobile: boolean
  onSelect: () => void
  onOpen: () => void
  onDelete: () => void
}

/** 书库列表的一行：标题、元信息、徽标与阅读进度 */
function LibraryRow({ doc, selected, lastPage, isMobile, onSelect, onOpen, onDelete }: RowProps) {
  const [dragging, setDragging] = useState(false)
  const pages = doc.page_count ?? 0
  const fraction = lastPage && pages ? lastPage / pages : 0
  const metaParts = [
    `${doc.page_count ?? '?'} 页`,
    `添加于 ${shortDate(doc.added_at)}`,
    lastPage ? `上次 p.${lastPage}` : '',
  ].filter(Boolean)

  return (
    <div
      className={`lib-row${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      data-doc-id={doc.id}
      draggable
      onClick={isMobile ? onOpen : onSelect}
      onDoubleClick={onOpen}
      onDragStart={(e) => {
        // 用自定义 MIME 区分「拖动文献」与「拖入文件」
        e.dataTransfer.setData('application/x-paper-doc', doc.id)
        e.dataTransfer.setData('text/plain', doc.title)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      title="拖动到左侧文件夹可归档"
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--fg-strong)', lineHeight: 1.4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{doc.title}</div>
        <div className="hint" style={{ fontSize: 11, marginTop: 2 }}>{metaParts.join(' · ')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5, alignItems: 'center' }}>
          <ParseBadge status={doc.parse_status} />
          {doc.bilingual_ready && <span className="badge ok">双语✓</span>}
          {(doc.annotation_count ?? 0) > 0 && <span className="badge">笔记 {doc.annotation_count}</span>}
          {doc.tags.slice(0, 3).map((t) => (
            <span key={t.id} className="badge" style={{ color: t.color, borderColor: `${t.color}66` }}>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: t.color, marginRight: 4 }} />
              {t.name}
            </span>
          ))}
        </div>
      </div>

      <ProgressRing fraction={fraction} title={lastPage ? `阅读进度 ${Math.round(fraction * 100)}%` : '尚未阅读'} />

      <button
        className="btn-ghost lib-del"
        title="删除"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        style={{ padding: 3, border: 'none', display: 'flex', color: 'var(--fg-muted)' }}
      ><Icon d={PATH_TRASH} size={13} /></button>
    </div>
  )
}

interface ListProps {
  docs: DocumentMeta[]
  selectedId: string | null
  pagePos: Record<string, number>
  isMobile: boolean
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onDelete: (doc: DocumentMeta) => void
}

/** 文献列表（不含空态，空态由 LibraryView 决定） */
export default function LibraryList({ docs, selectedId, pagePos, isMobile, onSelect, onOpen, onDelete }: ListProps) {
  return (
    <>
      {docs.map((d) => (
        <LibraryRow
          key={d.id}
          doc={d}
          selected={selectedId === d.id}
          lastPage={pagePos[d.id]}
          isMobile={isMobile}
          onSelect={() => onSelect(d.id)}
          onOpen={() => onOpen(d.id)}
          onDelete={() => onDelete(d)}
        />
      ))}
    </>
  )
}
