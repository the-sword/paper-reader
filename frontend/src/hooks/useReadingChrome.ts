import { useEffect, useState, type RefObject } from 'react'

/** 滚动累计超过该像素即切换阅读 chrome：向下隐藏、向上显示 */
const SCROLL_THRESHOLD_PX = 24
/** 只有最近这段时间内有触摸或滚轮输入时，滚动才参与显隐（排除程序恢复位置时的滚动） */
const USER_INPUT_WINDOW_MS = 1000
/** 轻点时不切换 chrome 的交互元素：链接、引用标、批注标记、浮层等 */
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, .cite-ref, .cite-popup, .ann-rect, .ann-note-marker, .sel-float, .sel-bubble'

/**
 * 手机阅读的顶栏 / 工具条显隐：轻点页面切换；向下滚动隐藏、向上滚动显示。
 * 只改变 transform / opacity，不改变 main 的尺寸，避免触发适应宽度的重新拟合。
 */
export function useReadingChrome(mainRef: RefObject<HTMLElement>, enabled: boolean): boolean {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const el = mainRef.current
    if (!enabled || !el) return
    let last = el.scrollTop
    let down = 0
    let up = 0
    let lastInput = 0

    const markInput = (): void => { lastInput = Date.now() }

    const onScroll = (): void => {
      const dy = el.scrollTop - last
      last = el.scrollTop
      if (Date.now() - lastInput > USER_INPUT_WINDOW_MS) return
      if (dy > 0) {
        up = 0
        down += dy
        if (down > SCROLL_THRESHOLD_PX) { setVisible(false); down = 0 }
      } else if (dy < 0) {
        down = 0
        up -= dy
        if (up > SCROLL_THRESHOLD_PX) { setVisible(true); up = 0 }
      }
    }

    const onClick = (e: MouseEvent): void => {
      if ((e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return
      setVisible((v) => !v)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('click', onClick)
    el.addEventListener('touchstart', markInput, { passive: true })
    el.addEventListener('touchmove', markInput, { passive: true })
    el.addEventListener('wheel', markInput, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('click', onClick)
      el.removeEventListener('touchstart', markInput)
      el.removeEventListener('touchmove', markInput)
      el.removeEventListener('wheel', markInput)
    }
  }, [mainRef, enabled])

  return visible
}
