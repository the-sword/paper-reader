import type { ReactNode } from 'react'

interface Props {
  title: string
  /** 标题条右侧的动作区（按钮、徽标等） */
  actions?: ReactNode
  children: ReactNode
}

/** 右侧面板统一外壳：顶部 48px 标题条（标题 + 右侧动作区）+ 可滚动内容区 */
export default function PanelFrame({ title, actions, children }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{
        height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-strong)', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {actions}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  )
}
