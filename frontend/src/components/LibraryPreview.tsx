import type { DocumentMeta } from '../api/client'

interface Props {
  doc: DocumentMeta | null
  lastPage: number | undefined
  onOpen: (id: string) => void
  onDelete: (doc: DocumentMeta) => void
}

/** 信息行：左侧标签，右侧值 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
      <span className="hint">{label}</span>
      <span style={{ color: 'var(--fg)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

/** 格式化时间为 YYYY-MM-DD，缺失时返回 — */
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 10)
}

/** 书库右侧预览：选中文献的信息与操作，未选中时显示空态 */
export default function LibraryPreview({ doc, lastPage, onOpen, onDelete }: Props) {
  if (!doc) {
    return (
      <aside style={previewStyle}>
        <div className="hint" style={{ padding: 20, textAlign: 'center', marginTop: 40 }}>
          单击左侧论文查看详情<br />双击或按 Enter 直接打开
        </div>
      </aside>
    )
  }

  const parseText = doc.parse_status === 'done' ? '已解析' : doc.parse_status === 'idle' ? '未解析' : doc.parse_status
  const primaryText = lastPage ? `继续阅读 · p.${lastPage}` : '开始阅读'

  return (
    <aside style={previewStyle}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-strong)', lineHeight: 1.4, marginBottom: 12 }}>
        {doc.title}
      </div>

      <InfoRow label="页数" value={`${doc.page_count ?? '?'}`} />
      <InfoRow label="添加" value={fmtDate(doc.added_at)} />
      <InfoRow label="最近打开" value={fmtDate(doc.opened_at)} />
      <InfoRow label="解析" value={parseText} />
      <InfoRow label="双语" value={doc.bilingual_ready ? '已生成' : '未生成'} />
      <InfoRow label="标注" value={`${doc.annotation_count ?? 0}`} />

      {doc.folders.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="hint" style={{ marginBottom: 6 }}>文件夹</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {doc.folders.map((f) => <span key={f.id} className="badge">{f.name}</span>)}
          </div>
        </div>
      )}
      {doc.tags.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="hint" style={{ marginBottom: 6 }}>标签</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {doc.tags.map((t) => (
              <span key={t.id} className="badge" style={{ color: t.color, borderColor: `${t.color}66` }}>{t.name}</span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
        <button className="btn-primary" onClick={() => onOpen(doc.id)}>{primaryText}</button>
        <button className="btn-ghost" onClick={() => onDelete(doc)} style={{ color: '#b42318' }}>删除</button>
      </div>
    </aside>
  )
}

const previewStyle: React.CSSProperties = {
  width: 260, flexShrink: 0, borderLeft: '1px solid var(--border)',
  background: 'var(--bg-side)', padding: 16, overflowY: 'auto',
}
