/**
 * arXiv 分类搜索选择器（Topic 配置用）。
 *
 * 输入中文/英文关键词实时匹配内置分类速查表（arxivCategories.ts），
 * 点选即添加为 chip；也允许直接粘贴任意合法分类 id（如
 * physics.data-an），用宽松格式校验放行，不硬编码清单清单遗漏。
 */
import { useEffect, useRef, useState } from 'react'
import {
  ARXIV_CATEGORIES, categoryLabel, looksLikeCategoryId, searchCategories,
} from '../lib/arxivCategories'
import { api } from '../api/client'

export default function CategoryPicker({ value, onChange }: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState('')
  const [remote, setRemote] = useState<Record<string, string>>({})
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 后端同步的 arXiv 官方清单（含内置表没有的新分类），拉取失败静默用内置表
  useEffect(() => {
    api.radarArxivCategories()
      .then((r) => setRemote(r.categories || {}))
      .catch(() => {})
  }, [])

  const matches = searchCategories(query, 8, remote)
  const add = (id: string) => {
    const v = id.trim()
    if (!v) return
    if (!value.includes(v)) onChange([...value, v])
    setQuery('')
    setInvalid('')
    setOpen(false)
  }

  const handleEnter = () => {
    const v = query.trim()
    if (!v) return
    if (looksLikeCategoryId(v)) add(v)
    else setInvalid(`「${v}」不像分类 id；请从候选中选择，或输入形如 cs.RO 的分类编号后回车`)
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
        border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)',
        padding: '4px 8px', minHeight: 34,
      }}>
        {value.map((id) => (
          <span key={id} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11, background: 'var(--bg-active)', borderRadius: 10,
            padding: '2px 8px', color: 'var(--fg-strong)',
          }}>
            {categoryLabel(id)}
            <button
              onClick={() => onChange(value.filter((x) => x !== id))}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 0 }}
              title="移除">✕</button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setInvalid(''); setOpen(true) }}
          onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setOpen(true) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleEnter() }
            if (e.key === 'Backspace' && !query && value.length > 0) onChange(value.slice(0, -1))
          }}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150) }}
          placeholder={value.length ? '' : '输中文或缩写搜分类，如「机器人」/ robot / cs.RO'}
          style={{ flex: 1, minWidth: 180, border: 'none', background: 'none', color: 'var(--fg)', fontSize: 12, outline: 'none' }}
        />
      </div>

      {invalid && (
        <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 3 }}>{invalid}</div>
      )}

      {open && matches.length > 0 && (
        <div style={{
          position: 'absolute', zIndex: 30, top: '100%', left: 0, right: 0, marginTop: 4,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 4px 16px rgba(0,0,0,.15)', maxHeight: 260, overflowY: 'auto',
        }}>
          {matches.map((x) => (
            <button key={x.id}
              onMouseDown={(e) => { e.preventDefault(); add(x.id) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                border: 'none', background: 'none', padding: '7px 12px', fontSize: 12,
                color: 'var(--fg)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-active)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
            >
              <b style={{ color: 'var(--fg-strong)' }}>{x.id}</b>
              <span style={{ marginLeft: 8, color: 'var(--fg-muted)' }}>{x.zh}</span>
            </button>
          ))}
        </div>
      )}

      {open && query.trim() && matches.length === 0 && (
        <div style={{
          position: 'absolute', zIndex: 30, top: '100%', left: 0, right: 0, marginTop: 4,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '8px 12px', fontSize: 11, color: 'var(--fg-muted)',
        }}>
          无匹配分类。可直接输入完整分类 id（形如 cs.RO）后回车添加；全部 {ARXIV_CATEGORIES.length} 个分类见 arxiv.org/category_taxonomy
        </div>
      )}
    </div>
  )
}
