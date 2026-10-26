import { useState } from 'react'
import { useStore } from '../stores/useStore'
import { api } from '../api/client'

/** 文件大小格式化为 KB / MB */
function fmtSize(bytes: number | null): string {
  if (!bytes) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 时间格式化为 YYYY-MM-DD HH:mm，缺失时返回 — */
function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 信息行：左侧标签，右侧值 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
      <span className="hint">{label}</span>
      <span style={{ color: 'var(--fg)', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
}

/** 右栏「信息」页签：文献元数据、标签与文件夹、Markdown 导出 */
export default function DocInfoPanel() {
  const currentDoc = useStore((s) => s.currentDoc)
  const annotations = useStore((s) => s.annotations)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const [tagInput, setTagInput] = useState('')

  if (!currentDoc) {
    return <div className="hint" style={{ padding: 16 }}>选择一篇文献查看信息</div>
  }

  const parseText = currentDoc.parse_status === 'done' ? '已解析' : currentDoc.parse_status === 'idle' ? '未解析' : currentDoc.parse_status

  const addTag = async () => {
    const name = tagInput.trim()
    if (!name) return
    const tag = await api.createTag(name, '#3b82f6')
    await api.tagDocument(currentDoc.id, tag.id)
    setTagInput('')
    await refreshSidebar()
    // 只刷新元数据，不重载段落，避免打断输入与页面闪烁
    await useStore.getState().refreshCurrentDocMeta()
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, lineHeight: 1.4, color: 'var(--fg-strong)' }}>
        {currentDoc.title}
      </div>

      <InfoRow label="页数" value={`${currentDoc.page_count ?? '?'}`} />
      <InfoRow label="添加时间" value={fmtTime(currentDoc.added_at)} />
      <InfoRow label="最近打开" value={fmtTime(currentDoc.opened_at)} />
      <InfoRow label="解析" value={parseText} />
      <InfoRow label="双语 PDF" value={currentDoc.bilingual_ready ? '已生成' : '未生成'} />
      <InfoRow label="标注" value={`${annotations.length} 条`} />
      <InfoRow label="文件名" value={currentDoc.file_name ?? '—'} />
      <InfoRow label="文件大小" value={fmtSize(currentDoc.file_size)} />

      <div style={{ marginTop: 14 }}>
        <div className="hint" style={{ marginBottom: 6 }}>文件夹</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {currentDoc.folders.length === 0 && <span className="hint">未归档</span>}
          {currentDoc.folders.map((f) => <span key={f.id} className="badge">{f.name}</span>)}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="hint" style={{ marginBottom: 6 }}>标签</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
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
            style={{ width: 80, fontSize: 11, padding: '2px 6px' }}
          />
        </div>
      </div>

      <a
        href={api.exportUrl(currentDoc.id)}
        download={`${currentDoc.title}-notes.md`}
        className="btn-ghost"
        style={{ display: 'inline-block', marginTop: 16, fontSize: 12, padding: '4px 10px', textDecoration: 'none' }}
      >导出 Markdown</a>
    </div>
  )
}
