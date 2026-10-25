import { useEffect, useMemo, useState } from 'react'
import { useStore, filterBySmartView } from '../stores/useStore'
import { api, type DocumentMeta } from '../api/client'
import { Icon, PATH_SEARCH } from './icons'

/** 论文搜索防抖间隔（毫秒） */
const SEARCH_DEBOUNCE_MS = 150
/** 空输入时展示的最近打开论文数 */
const RECENT_LIMIT = 5
/** 输入关键词时展示的论文上限 */
const SEARCH_LIMIT = 8

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface Props {
  commands: PaletteCommand[]
  onClose: () => void
}

/** 列表中的一项：分组内的可选条目 */
interface Item {
  key: string
  group: string
  label: string
  hint?: string
  run: () => void
}

/** 按关键词筛选（大小写不敏感；空关键词全部保留） */
function matches(text: string, q: string): boolean {
  return !q || text.toLowerCase().includes(q.toLowerCase())
}

/** ⌘K 命令面板：打开的标签 / 论文 / 命令，↑↓ 选择，Enter 执行，Esc 关闭 */
export default function CommandPalette({ commands, onClose }: Props) {
  const openTabs = useStore((s) => s.openTabs)
  const openDocument = useStore((s) => s.openDocument)
  const [query, setQuery] = useState('')
  const [papers, setPapers] = useState<DocumentMeta[]>([])
  const [active, setActive] = useState(0)

  const q = query.trim()

  useEffect(() => {
    const t = window.setTimeout(() => {
      api.listDocuments(q ? { q } : {})
        .then((docs) => setPapers(
          q ? docs.slice(0, SEARCH_LIMIT) : filterBySmartView(docs, 'recent').slice(0, RECENT_LIMIT),
        ))
        .catch(() => setPapers([]))
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [q])

  const items = useMemo<Item[]>(() => {
    const tabs: Item[] = openTabs
      .filter((t) => matches(t.title, q))
      .map((t) => ({ key: `tab-${t.id}`, group: '打开的标签', label: t.title, run: () => void openDocument(t.id) }))
    const docs: Item[] = papers.map((d) => ({
      key: `doc-${d.id}`, group: q ? '论文' : '最近打开', label: d.title,
      hint: `${d.page_count ?? '?'} 页`, run: () => void openDocument(d.id),
    }))
    const cmds: Item[] = commands
      .filter((c) => matches(c.label, q))
      .map((c) => ({ key: `cmd-${c.id}`, group: '命令', label: c.label, hint: c.hint, run: c.run }))
    return [...tabs, ...docs, ...cmds]
  }, [openTabs, papers, commands, q, openDocument])

  const safeActive = Math.min(active, Math.max(0, items.length - 1))

  const runItem = (item: Item | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'Enter') { e.preventDefault(); runItem(items[safeActive]); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      const n = items.length
      if (n) setActive((safeActive + step + n) % n)
    }
  }

  let lastGroup = ''
  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(16,24,40,.32)', zIndex: 2000,
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh',
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(580px, calc(100vw - 24px))', maxHeight: '64vh', display: 'flex', flexDirection: 'column',
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-pop)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--fg-muted)', display: 'flex' }}><Icon d={PATH_SEARCH} size={15} /></span>
          <input
            autoFocus
            value={query}
            placeholder="搜索论文、标签或命令…"
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={onKeyDown}
            style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 14, padding: 0, color: 'var(--fg-strong)' }}
          />
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px' }}>Esc</span>
        </div>

        <div style={{ overflowY: 'auto', padding: '6px 6px 8px' }}>
          {items.length === 0 && (
            <div className="hint" style={{ padding: '16px 12px' }}>没有匹配结果</div>
          )}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? <div className="cmd-group">{it.group}</div> : null
            lastGroup = it.group
            return (
              <div key={it.key}>
                {header}
                <div
                  className={`cmd-item${i === safeActive ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runItem(it)}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.label}
                  </span>
                  {it.hint && <span className="hint" style={{ flexShrink: 0 }}>{it.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
