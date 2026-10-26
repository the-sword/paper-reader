/**
 * 右侧上下文面板。
 *   - 桌面端：面板 + 右缘 48px 竖向导航轨（导读 / 问答 / 标注 / 信息）；收起时只剩竖轨。
 *   - 手机端（embedded）：抽屉内顶部横向分段控件切换页签，不显示竖轨。
 */
import { useStore, type RightTab } from '../stores/useStore'
import NotePanel from './NotePanel'
import SummaryPanel from './SummaryPanel'
import ChatPanel from './ChatPanel'
import DocInfoPanel from './DocInfoPanel'
import PanelFrame from './PanelFrame'
import {
  Icon, PATH_SPARKLE, PATH_CHAT, PATH_PEN, PATH_INFO, PATH_CHEVRON_LEFT, PATH_CHEVRON_RIGHT,
} from './icons'

/** 竖向导航轨的页签定义（顺序即展示顺序） */
const TABS: Array<{ value: RightTab; label: string; icon: string | string[] }> = [
  { value: 'guide', label: '导读', icon: PATH_SPARKLE },
  { value: 'chat', label: '问答', icon: PATH_CHAT },
  { value: 'notes', label: '标注', icon: PATH_PEN },
  { value: 'info', label: '信息', icon: PATH_INFO },
]

interface Props {
  width: number
  /** 手机抽屉模式：不显示竖轨，改用顶部分段控件 */
  embedded?: boolean
}

/** 按页签渲染对应面板内容（问答自带标题条，其余统一由 PanelFrame 包裹） */
function PanelBody({ tab }: { tab: RightTab }) {
  const annotationCount = useStore((s) => s.annotations.length)
  const currentDoc = useStore((s) => s.currentDoc)
  if (tab === 'chat') return <ChatPanel />
  if (tab === 'notes') {
    return <PanelFrame title={`标注 ${annotationCount}`}><NotePanel /></PanelFrame>
  }
  if (tab === 'info') return <PanelFrame title="信息"><DocInfoPanel /></PanelFrame>
  // 导读页内部在无文档时不能挂载（其 Hook 顺序依赖文档是否存在）
  return (
    <PanelFrame title="导读">
      {currentDoc ? <SummaryPanel /> : <div className="hint" style={{ padding: 20 }}>选择一篇文献后可生成 AI 总结</div>}
    </PanelFrame>
  )
}

/** 右缘竖向导航轨：图标 + 10px 文字，激活态同 NavRail；标注页签带数量徽标 */
function RightRail() {
  const rightOpen = useStore((s) => s.rightOpen)
  const rightTab = useStore((s) => s.rightTab)
  const openRight = useStore((s) => s.openRight)
  const setRightOpen = useStore((s) => s.setRightOpen)
  const annotationCount = useStore((s) => s.annotations.length)

  const onTab = (tab: RightTab): void => {
    // 点击已激活页签收起面板，点击其他页签则切换并展开
    if (rightOpen && rightTab === tab) setRightOpen(false)
    else openRight(tab)
  }

  return (
    <div style={{
      width: 48, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 4, padding: '10px 0', background: 'var(--bg-side)', borderLeft: '1px solid var(--border)',
    }}>
      {TABS.map((t) => {
        const active = rightOpen && rightTab === t.value
        return (
          <button
            key={t.value}
            className={`nav-item${active ? ' active' : ''}`}
            title={t.label}
            onClick={() => onTab(t.value)}
            style={{ position: 'relative' }}
          >
            <Icon d={t.icon} size={16} />
            <span>{t.label}</span>
            {t.value === 'notes' && annotationCount > 0 && (
              <span style={{
                position: 'absolute', top: 4, right: 4, minWidth: 14, height: 14, padding: '0 3px',
                borderRadius: 7, background: '#F04438', color: '#fff', fontSize: 9, lineHeight: '14px',
                textAlign: 'center', fontWeight: 600,
              }}>{annotationCount}</span>
            )}
          </button>
        )
      })}
      <div style={{ flex: 1 }} />
      <button
        className="nav-item"
        title={rightOpen ? '收起右栏 (])' : '展开右栏 (])'}
        onClick={() => setRightOpen(!rightOpen)}
      >
        <Icon d={rightOpen ? PATH_CHEVRON_RIGHT : PATH_CHEVRON_LEFT} size={14} />
      </button>
    </div>
  )
}

/** 手机抽屉内的横向分段控件 */
function MobileTabs() {
  const rightTab = useStore((s) => s.rightTab)
  const openRight = useStore((s) => s.openRight)
  return (
    <div style={{ display: 'flex', padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      {TABS.map((t) => (
        <button
          key={t.value}
          className={`seg ${rightTab === t.value ? 'active' : ''}`}
          style={{ flex: 1, padding: '4px 0' }}
          onClick={() => openRight(t.value)}
        >{t.label}</button>
      ))}
    </div>
  )
}

export default function RightPanel({ width, embedded = false }: Props) {
  const rightOpen = useStore((s) => s.rightOpen)
  const rightTab = useStore((s) => s.rightTab)

  if (embedded) {
    return (
      <aside className="right-panel" style={{
        width: '100%', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-side)',
        overflow: 'hidden',
      }}>
        <MobileTabs />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <PanelBody tab={rightTab} />
        </div>
      </aside>
    )
  }

  return (
    <div style={{ display: 'flex', flexShrink: 0, minHeight: 0 }}>
      {rightOpen && (
        <aside className="right-panel" style={{
          width, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-side)',
          overflow: 'hidden', minHeight: 0,
        }}>
          <PanelBody tab={rightTab} />
        </aside>
      )}
      <RightRail />
    </div>
  )
}
