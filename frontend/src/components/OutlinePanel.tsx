/**
 * 阅读区左栏：目录 / 标注两个页签 + 底部阅读进度卡。
 * 目录优先使用原文 PDF 书签；没有书签时回退到解析产物的 heading 段落。
 * 点击条目或标注即跳到对应页。
 */
import { useMemo, useState } from 'react'
import { useStore } from '../stores/useStore'
import type { Annotation, Segment } from '../api/client'
import { parseStatusText } from '../lib/parseStatus'
import { usePdfOutline, type OutlineItem } from '../hooks/usePdfOutline'
import { Icon, PATH_PENCIL } from './icons'

/** 阅读估算：每页约需的分钟数（用于「约剩 N 分钟」） */
const MINUTES_PER_PAGE = 2
/** 编号匹配：如 "3.2.1 xxx" 中的 "3.2.1" */
const NUMBERING_RE = /^(\d+(?:\.\d+)*)\b/

interface Props {
  /** 当前页码（由阅读区的页码导航提供） */
  page: number
  pageCount: number
  /** 手机抽屉内使用：撑满宽度、去掉右侧分隔线 */
  fluid?: boolean
  /** 跳页后的回调（手机端用于关闭目录抽屉） */
  onNavigate?: () => void
}

/** 由 heading 段落生成目录：深度 = 编号中的点数，无编号为 0 */
function buildOutline(segments: Segment[]): OutlineItem[] {
  return segments
    .filter((s) => s.kind === 'heading' && s.source.trim())
    .map((s) => {
      const num = NUMBERING_RE.exec(s.source.trim())?.[1]
      return {
        id: s.id,
        title: s.source.trim(),
        page: s.page,
        depth: num ? num.split('.').length - 1 : 0,
      }
    })
}

/** 当前所在节：page ≤ 当前页的最后一个标题 */
function currentSectionIndex(items: OutlineItem[], page: number): number {
  let idx = -1
  items.forEach((it, i) => { if (it.page <= page) idx = i })
  return idx
}

/** 节内标注颜色：取该节页范围内首条标注的颜色，无则 null */
function sectionColor(items: OutlineItem[], i: number, anns: Annotation[]): string | null {
  const from = items[i].page
  const to = i + 1 < items.length ? items[i + 1].page - 1 : Infinity
  return anns.find((a) => a.page >= from && a.page <= to)?.color ?? null
}

export default function OutlinePanel({ page, pageCount, fluid = false, onNavigate }: Props) {
  const currentDoc = useStore((s) => s.currentDoc)
  const segments = useStore((s) => s.segments)
  const annotations = useStore((s) => s.annotations)
  const requestJump = useStore((s) => s.requestJump)
  const startParse = useStore((s) => s.startParse)
  const setShowReparse = useStore((s) => s.setShowReparse)
  const parseState = useStore((s) => s.parseState)
  const parseProgress = useStore((s) => s.parseProgress)
  const pagePos = useStore((s) => s.pagePos)
  const bookmark = usePdfOutline(currentDoc?.id ?? null)
  const [tab, setTab] = useState<'outline' | 'notes'>('outline')
  const jumpTo = (p: number): void => {
    requestJump(p)
    onNavigate?.()
  }

  const parsedItems = useMemo(() => buildOutline(segments), [segments])
  const fromBookmark = bookmark.items.length > 0
  const items = fromBookmark ? bookmark.items : parsedItems
  const sourceLabel = fromBookmark ? '来自 PDF 书签' : '来自解析结果'
  const current = currentSectionIndex(items, page)
  const sortedAnns = useMemo(
    () => [...annotations].sort((a, b) => a.page - b.page),
    [annotations],
  )
  const parsed = segments.length > 0
  const parsing = parseState === 'running' || parseState === 'pending' || parseState === 'queued'

  if (!currentDoc) return null

  const progress = pageCount ? Math.min(1, page / pageCount) : 0
  const minutesLeft = Math.max(0, Math.round((pageCount - page) * MINUTES_PER_PAGE))

  return (
    <aside style={{
      width: fluid ? '100%' : 220, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
      background: 'var(--bg-side)', borderRight: fluid ? 'none' : '1px solid var(--border)',
    }}>
      <div style={{ padding: 10, flexShrink: 0 }}>
        <div style={{ display: 'flex', background: 'var(--bg-canvas)', borderRadius: 7, padding: 2 }}>
          {([['outline', '目录'], ['notes', `标注 ${annotations.length}`]] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setTab(v)}
              style={{
                flex: 1, fontSize: 12, padding: '4px 0', border: 'none', borderRadius: 5, cursor: 'pointer',
                background: tab === v ? 'var(--bg)' : 'transparent',
                color: tab === v ? 'var(--fg-strong)' : 'var(--fg-muted)',
                fontWeight: tab === v ? 600 : 400,
                boxShadow: tab === v ? '0 1px 2px rgba(16,24,40,.08)' : 'none',
              }}
            >{label}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }}>
        {tab === 'outline' && (
          <>
            {parsing && (
              // 解析中不展示旧目录，避免与即将替换的段落对不上
              <div className="hint" style={{ padding: '16px 6px' }}>{parseStatusText(parseState, parseProgress)}</div>
            )}
            {!parsing && items.length > 0 && (
              <div className="hint" style={{ fontSize: 10, padding: '2px 8px 6px' }}>{sourceLabel}</div>
            )}
            {!parsing && items.length === 0 && bookmark.loading && (
              <div className="hint" style={{ padding: '16px 6px' }}>正在读取 PDF 书签…</div>
            )}
            {!parsing && items.length === 0 && !bookmark.loading && !parsed && (
              <div className="hint" style={{ padding: '16px 6px', lineHeight: 1.8 }}>
                解析全文后生成目录
                <div>
                  <button className="btn-primary" style={{ marginTop: 8, fontSize: 12 }}
                    onClick={() => void startParse('auto')}>解析全文</button>
                </div>
              </div>
            )}
            {!parsing && items.length === 0 && !bookmark.loading && parsed && (
              <>
                <div className="hint" style={{ padding: '16px 6px' }}>未识别到章节标题</div>
                <div style={{ padding: '6px' }}>
                  <button className="btn-ghost" style={{ fontSize: 11, border: 'none', color: 'var(--fg-muted)' }}
                    onClick={() => setShowReparse(true)}>重新解析</button>
                </div>
              </>
            )}
            {!parsing && items.map((it, i) => {
              const active = i === current
              const dot = sectionColor(items, i, annotations)
              return (
                <div
                  key={it.id}
                  onClick={() => jumpTo(it.page)}
                  title={it.title}
                  style={{
                    position: 'relative', display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 8px', paddingLeft: 10 + it.depth * 12, borderRadius: 6, cursor: 'pointer',
                    fontSize: 12, lineHeight: 1.4,
                    background: active ? 'var(--bg-active)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--fg)',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {active && (
                    <span style={{ position: 'absolute', left: 0, top: 4, bottom: 4, width: 3, borderRadius: 2, background: 'var(--accent)' }} />
                  )}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.title}
                  </span>
                  {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />}
                </div>
              )
            })}
            {!parsing && parsed && !fromBookmark && items.length > 0 && (
              // 目录来自解析结果时才提供重新解析；书签目录与解析无关
              <div style={{ padding: '10px 8px 4px' }}>
                <button
                  className="btn-ghost"
                  onClick={() => setShowReparse(true)}
                  style={{ fontSize: 11, border: 'none', padding: 0, color: 'var(--fg-muted)', textDecoration: 'underline' }}
                >目录不对？重新解析</button>
              </div>
            )}
          </>
        )}

        {tab === 'notes' && (
          <>
            {sortedAnns.length === 0 && (
              <div className="hint" style={{ padding: '16px 6px', lineHeight: 1.8 }}>
                选中原文后用划词菜单添加标注
              </div>
            )}
            {sortedAnns.map((a) => (
              <div
                key={a.id}
                onClick={() => jumpTo(a.page)}
                style={{
                  padding: '7px 8px 7px 10px', marginBottom: 6, borderRadius: 6, cursor: 'pointer',
                  borderLeft: `3px solid ${a.color}`, background: 'var(--bg)',
                  border: '1px solid var(--border)', borderLeftWidth: 3,
                }}
              >
                <div style={{
                  fontSize: 11.5, lineHeight: 1.5, color: 'var(--fg-strong)',
                  overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}>{a.quote}</div>
                {a.comment && (
                  <div style={{ fontSize: 11, color: 'var(--fg)', marginTop: 3, display: 'flex', gap: 4 }}>
                    <Icon d={PATH_PENCIL} size={10} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.comment}</span>
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 3 }}>p.{a.page}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* 底部阅读进度卡 */}
      <div style={{
        margin: 8, padding: '10px 12px', flexShrink: 0, borderRadius: 'var(--radius-sm)',
        background: 'var(--bg)', border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--fg-muted)' }}>
          <span>阅读进度</span>
          <span style={{ color: 'var(--fg-strong)', fontWeight: 600 }}>{Math.round(progress * 100)}%</span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-active)', margin: '7px 0' }}>
          <div style={{ width: `${progress * 100}%`, height: '100%', borderRadius: 2, background: 'var(--accent)' }} />
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-muted)' }}>
          {page}/{pageCount || '–'} 页 · 约剩 {minutesLeft} 分钟 · 上次 p.{pagePos[currentDoc.id] ?? page}
        </div>
      </div>
    </aside>
  )
}
