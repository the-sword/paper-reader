/**
 * 阅读排版调节面板。
 *
 * 参考 Readwise Reader / Firefox 阅读模式的用法：
 *   - 主题：Crisp / Sepia / Soft / Night / 跟随系统
 *   - 字号 14-20px
 *   - 页宽 640-900px（控制每行字符数，是沉浸感的关键）
 *   - 行高 1.6-2.2
 *
 * 所有调整实时生效，并写入偏好设置持久化。
 *
 * 定位：弹窗用 position:fixed 锚定到按钮位置。
 * 若用 absolute 会被右侧滚动容器裁剪而遮挡在正文之下。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'

export interface ReaderPrefs {
  theme: 'auto' | 'crisp' | 'sepia' | 'soft' | 'night'
  width: number
  fontSize: number
  lineHeight: number
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  theme: 'auto',
  width: 720,
  fontSize: 16,
  lineHeight: 1.9,
}

const THEMES: Array<{ value: ReaderPrefs['theme']; label: string; bg: string; fg: string }> = [
  { value: 'auto', label: '跟随系统', bg: 'linear-gradient(135deg,#fff 50%,#1a1a1b 50%)', fg: '#888' },
  { value: 'crisp', label: '锐利', bg: '#ffffff', fg: '#1a1a1a' },
  { value: 'sepia', label: '羊皮纸', bg: '#f4ecd8', fg: '#5b4636' },
  { value: 'soft', label: '柔和', bg: '#f8f9fa', fg: '#333333' },
  { value: 'night', label: '深夜', bg: '#1a1a1b', fg: '#d7dadc' },
]

interface Props {
  value: ReaderPrefs
  onChange: (next: ReaderPrefs) => void
}

export default function ReaderSettings({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 弹窗固定定位用
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      // 弹窗在按钮左下方，宽度 260
      const panelW = 264
      const panelH = 320
      let left = r.right - panelW
      let top = r.bottom + 8
      // 边界保护：不超出视口
      left = Math.max(8, Math.min(left, window.innerWidth - panelW - 8))
      if (top + panelH > window.innerHeight) {
        top = Math.max(8, r.top - panelH - 8)
      }
      setAnchor({ left, top })
    }
    setOpen((v) => !v)
  }

  const update = (patch: Partial<ReaderPrefs>) => {
    const next = { ...value, ...patch }
    onChange(next)
    // 持久化（不阻塞 UI）
    void api.savePrefs({
      reader_theme: next.theme,
      reader_width: next.width,
      reader_font_size: next.fontSize,
      reader_line_height: next.lineHeight,
    }).catch(() => {})
  }

  const row = (label: string, node: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)', width: 40, flexShrink: 0 }}>{label}</span>
      {node}
    </div>
  )

  return (
    <>
      <button
        ref={btnRef}
        className="btn-ghost"
        style={{ padding: '4px 8px' }}
        title="阅读排版设置"
        onClick={toggle}
      >Aa</button>

      {open && anchor && (
        <div
          ref={panelRef}
          style={{
            position: 'fixed', left: anchor.left, top: anchor.top, zIndex: 5000,
            width: 264, padding: 12, borderRadius: 8,
            background: 'var(--bg)', border: '1px solid var(--border)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
          }}
        >
          {/* 主题 */}
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>主题</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {THEMES.map((t) => (
              <button
                key={t.value}
                onClick={() => update({ theme: t.value })}
                title={t.label}
                style={{
                  width: 42, height: 34, borderRadius: 6, cursor: 'pointer',
                  background: t.bg, color: t.fg, fontSize: 9,
                  border: value.theme === t.value
                    ? '2px solid var(--accent)'
                    : '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >{t.label.slice(0, 2)}</button>
            ))}
          </div>

          {/* 字号 */}
          {row('字号', (
            <>
              <input
                type="range" min={14} max={20} step={1} value={value.fontSize}
                onChange={(e) => update({ fontSize: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 11, width: 32, textAlign: 'right' }}>{value.fontSize}px</span>
            </>
          ))}

          {/* 页宽 */}
          {row('页宽', (
            <>
              <input
                type="range" min={640} max={900} step={20} value={value.width}
                onChange={(e) => update({ width: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 11, width: 32, textAlign: 'right' }}>{value.width}</span>
            </>
          ))}

          {/* 行高 */}
          {row('行高', (
            <>
              <input
                type="range" min={1.6} max={2.2} step={0.1} value={value.lineHeight}
                onChange={(e) => update({ lineHeight: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 11, width: 32, textAlign: 'right' }}>{value.lineHeight.toFixed(1)}</span>
            </>
          ))}

          <div style={{
            marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--border)',
            fontSize: 10, color: 'var(--fg-muted)', lineHeight: 1.6,
          }}>
            页宽控制在 640-760 时约 65-80 字符/行，最接近纸质阅读节奏。
          </div>
        </div>
      )}
    </>
  )
}
