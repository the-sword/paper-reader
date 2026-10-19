import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  /** 拖动时回调新宽度 */
  onResize: (width: number) => void
  /** 最小宽度 */
  min?: number
  /** 最大宽度 */
  max?: number
  /** divider 位于被调整面板的哪一侧 */
  side?: 'left' | 'right'
}

/** 可拖拽的分隔条。双击复位到默认宽度。 */
export default function Resizer({ onResize, min = 160, max = 520, side = 'left' }: Props) {
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    const panel = side === 'left' ? target.previousElementSibling : target.nextElementSibling
    if (!panel) return
    startX.current = e.clientX
    startW.current = (panel as HTMLElement).getBoundingClientRect().width
    setDragging(true)
  }, [side])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const delta = side === 'left' ? e.clientX - startX.current : startX.current - e.clientX
      const next = Math.round(Math.max(min, Math.min(max, startW.current + delta)))
      onResize(next)
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [dragging, min, max, onResize, side])

  return (
    <div
      className={`resizer ${dragging ? 'active' : ''}`}
      onMouseDown={onMouseDown}
      title="拖动调整宽度，双击复位"
      onDoubleClick={() => onResize(side === 'left' ? 260 : 300)}
    />
  )
}
