import { useEffect, useRef, useState, type ReactNode } from 'react'

/** 吸附档位：半屏 / 全屏 */
export type SheetSnap = 'half' | 'full'

/** 两档高度占视口高度的比例 */
const HEIGHT_RATIO: Record<SheetSnap, number> = { half: 0.56, full: 0.92 }
/** 拖到低于该视口比例即关闭 */
const CLOSE_RATIO = 0.3
/** 滑入 / 滑出动画时长（毫秒） */
const ANIM_MS = 220

interface Props {
  open: boolean
  onClose: () => void
  snap: SheetSnap
  onSnapChange: (snap: SheetSnap) => void
  children: ReactNode
}

/**
 * 通用底部抽屉：顶部把手可拖动，松手吸附到半屏 / 全屏，拖到很低则关闭。
 * 键盘弹起时用 visualViewport 把底边抬到键盘上方。
 */
export default function BottomSheet({ open, onClose, snap, onSnapChange, children }: Props) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  /** 拖拽中的临时高度（px）；null 表示未拖拽，使用吸附高度 */
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const [kbOffset, setKbOffset] = useState(0)
  const dragRef = useRef<{ y: number; base: number } | null>(null)
  const heightRef = useRef(0)

  // 打开：先挂载再下一帧设为可见，触发滑入；关闭：先滑出再卸载
  useEffect(() => {
    if (open) {
      setMounted(true)
      const raf = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(raf)
    }
    setShown(false)
    const t = window.setTimeout(() => setMounted(false), ANIM_MS)
    return () => window.clearTimeout(t)
  }, [open])

  // 键盘弹起：visualViewport 的可视区域缩小，把底边抬起相同高度
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = (): void => setKbOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  if (!mounted) return null

  const snapHeight = (): number => HEIGHT_RATIO[snap] * window.innerHeight

  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { y: e.clientY, base: snapHeight() }
    heightRef.current = snapHeight()
    setDragHeight(heightRef.current)
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    // 向下拖动减小高度，向上拖动增大高度（不超过全屏档）
    const maxH = HEIGHT_RATIO.full * window.innerHeight
    heightRef.current = Math.min(maxH, d.base - (e.clientY - d.y))
    setDragHeight(heightRef.current)
  }

  const onUp = (): void => {
    if (!dragRef.current) return
    dragRef.current = null
    const vh = window.innerHeight
    const h = heightRef.current
    setDragHeight(null)
    if (h < CLOSE_RATIO * vh) { onClose(); return }
    const half = Math.abs(h - HEIGHT_RATIO.half * vh)
    const full = Math.abs(h - HEIGHT_RATIO.full * vh)
    onSnapChange(half <= full ? 'half' : 'full')
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(15,23,42,.45)',
          opacity: shown ? 1 : 0, transition: `opacity ${ANIM_MS}ms ease`,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', left: 0, right: 0, bottom: kbOffset, zIndex: 71,
          height: dragHeight !== null ? dragHeight : `${HEIGHT_RATIO[snap] * 100}dvh`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          background: 'var(--bg-side)', borderRadius: '16px 16px 0 0',
          boxShadow: 'var(--shadow-pop)', paddingBottom: 'env(safe-area-inset-bottom)',
          transform: shown ? 'translateY(0)' : 'translateY(100%)',
          transition: dragHeight !== null ? 'none' : `transform ${ANIM_MS}ms ease, height 200ms ease, bottom 120ms ease`,
        }}
      >
        <div
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          style={{ padding: '8px 0 6px', flexShrink: 0, touchAction: 'none', cursor: 'grab' }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto' }} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </>
  )
}
