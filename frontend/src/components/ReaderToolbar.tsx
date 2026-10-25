import { useEffect, useRef, useState, type RefObject } from 'react'
import { Icon, PATH_CHEVRON_LEFT, PATH_CHEVRON_RIGHT, PATH_FOCUS } from './icons'

/** 滚动停止多久后工具条重新浮现（毫秒） */
const IDLE_SHOW_MS = 800
/** 鼠标进入阅读区底部多少像素时浮现工具条 */
const REVEAL_ZONE_PX = 120
/** 工具条淡入淡出的过渡时长见 global.css（240ms） */

interface Props {
  mainRef: RefObject<HTMLElement>
  page: number
  pageCount: number
  scale: number
  onGoTo: (page: number) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onFitWidth: () => void
  focusMode: boolean
  onToggleFocus: () => void
}

/** 底部浮动工具条：页码 | 缩放 | 适应宽度 | 专注。滚动时淡出，停止后或鼠标靠近底部时浮现 */
export default function ReaderToolbar(props: Props) {
  const { mainRef, page, pageCount, scale, onGoTo } = props
  const [hidden, setHidden] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const hoverRef = useRef(false)

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    let timer = 0
    const onScroll = (): void => {
      window.clearTimeout(timer)
      if (hoverRef.current) return
      setHidden(true)
      timer = window.setTimeout(() => setHidden(false), IDLE_SHOW_MS)
    }
    const onMove = (e: MouseEvent): void => {
      const r = el.getBoundingClientRect()
      if (e.clientY > r.bottom - REVEAL_ZONE_PX) setHidden(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('mousemove', onMove)
    return () => {
      window.clearTimeout(timer)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('mousemove', onMove)
    }
  }, [mainRef])

  const commitDraft = (): void => {
    const n = parseInt(draft, 10)
    setEditing(false)
    if (!Number.isNaN(n)) onGoTo(n)
  }

  const btn = (title: string, onClick: () => void, label: React.ReactNode, extra?: React.CSSProperties) => (
    <button className="tb-btn" title={title} onClick={onClick} style={extra}>{label}</button>
  )

  return (
    <div
      className={`reader-toolbar${hidden ? ' hidden' : ''}`}
      onMouseEnter={() => { hoverRef.current = true; setHidden(false) }}
      onMouseLeave={() => { hoverRef.current = false }}
    >
      {btn('上一页 (k)', () => onGoTo(page - 1), <Icon d={PATH_CHEVRON_LEFT} size={14} />)}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, minWidth: 64, justifyContent: 'center' }}>
        <input
          aria-label="当前页码"
          value={editing ? draft : String(page)}
          onFocus={() => { setEditing(true); setDraft(String(page)) }}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitDraft(); (e.target as HTMLInputElement).blur() }
            if (e.key === 'Escape') { setEditing(false); (e.target as HTMLInputElement).blur() }
          }}
          onBlur={() => setEditing(false)}
          style={{
            width: 36, textAlign: 'center', fontSize: 12, padding: '2px 4px',
            border: 'none', background: 'transparent', color: 'var(--fg-strong)',
          }}
        />
        <span style={{ color: 'var(--fg-muted)' }}>/ {pageCount || '–'}</span>
      </span>
      {btn('下一页 (j)', () => onGoTo(page + 1), <Icon d={PATH_CHEVRON_RIGHT} size={14} />)}

      <span className="tb-sep" />

      {btn('缩小 (−)', props.onZoomOut, '−')}
      {btn('回到 100%', props.onZoomReset, `${Math.round(scale * 100)}%`, { minWidth: 46, fontVariantNumeric: 'tabular-nums' })}
      {btn('放大 (+)', props.onZoomIn, '+')}

      <span className="tb-sep" />

      {btn('适应宽度 (0)', props.onFitWidth, '适应宽度')}
      {btn(props.focusMode ? '退出专注 (Esc)' : '专注阅读 (f)', props.onToggleFocus,
        <Icon d={PATH_FOCUS} size={14} />)}
    </div>
  )
}
