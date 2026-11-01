/**
 * 全局 toast 通知（唯一一套）。
 *
 * 此前项目里并存 4 套反馈：全局 error 条（App）、全局 notice 条（App）、
 * 雷达私有 toast、面板内联错误框。现在统一为：
 *   - toast.error(text)             错误，7s 自动消失，红实底
 *   - toast.notice(text, action?)   中性提示，8s，可带动作（如「查看」）
 *   - toast.success(text, action?)  成功确认，5s，可带「撤销」
 * 面板内联错误（紧邻表单的语境反馈）仍留在原处，不进全局 toast。
 */
import { create } from 'zustand'

export interface ToastAction {
  label: string
  run: () => void
}

export type ToastKind = 'error' | 'notice' | 'success'

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  action?: ToastAction | null
}

/** 各类型的自动消失时长（毫秒） */
const DURATION: Record<ToastKind, number> = {
  error: 7000,
  notice: 8000,
  success: 5000,
}

/** 同时最多保留的条数（超出丢最旧的，避免刷屏） */
const MAX_TOASTS = 3

interface ToastState {
  toasts: ToastItem[]
  dismiss: (id: number) => void
  _push: (kind: ToastKind, text: string, action?: ToastAction | null) => void
}

let seq = 0

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  _push: (kind, text, action) => {
    const id = ++seq
    set((s) => {
      const next = [...s.toasts, { id, kind, text, action: action ?? null }]
      return { toasts: next.slice(Math.max(0, next.length - MAX_TOASTS)) }
    })
    window.setTimeout(() => {
      useToast.getState().dismiss(id)
    }, DURATION[kind])
  },
}))

/** 便捷入口：组件外（store / hook）经 getState 调，组件里也可直接用 */
export const toast = {
  error: (text: string): void => useToast.getState()._push('error', text),
  notice: (text: string, action?: ToastAction | null): void =>
    useToast.getState()._push('notice', text, action),
  success: (text: string, action?: ToastAction | null): void =>
    useToast.getState()._push('success', text, action),
}
