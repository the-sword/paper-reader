import { useStore } from '../stores/useStore'
import QueueIndicator from './QueueIndicator'
import { Icon, PATH_PLUS, PATH_X, PATH_COMMAND, PATH_SEARCH } from './icons'

interface Props {
  onOpenPalette: () => void
  onOpenSettings: () => void
}

/** 文档标签页栏：左侧标签，右侧搜索 / 队列 / AI 状态（双语进度统一到阅读器顶部按钮） */
export default function TabBar({ onOpenPalette, onOpenSettings }: Props) {
  const openTabs = useStore((s) => s.openTabs)
  const currentDoc = useStore((s) => s.currentDoc)
  const aiReady = useStore((s) => s.aiReady)
  const openDocument = useStore((s) => s.openDocument)
  const closeTab = useStore((s) => s.closeTab)
  const setMainView = useStore((s) => s.setMainView)
  const mainView = useStore((s) => s.mainView)

  /** 鼠标滚轮纵向转横向，标签区滚动条已隐藏，靠此切换溢出的标签 */
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (e.deltaX || !e.deltaY) return
    e.currentTarget.scrollLeft += e.deltaY
  }

  return (
    <div className="tab-bar">
      <div
        className="tab-scroll"
        onWheel={onWheel}
        style={{ display: 'flex', alignItems: 'stretch', gap: 2, paddingLeft: 6, minWidth: 0, flex: '0 1 auto' }}
      >
        {openTabs.map((t) => {
          const active = currentDoc?.id === t.id && mainView === 'reader'
          return (
            <div
              key={t.id}
              className={`tab-item${active ? ' active' : ''}`}
              title={t.title}
              onClick={() => {
                if (currentDoc?.id !== t.id) void openDocument(t.id)
                else setMainView('reader')
              }}
              onMouseDown={(e) => {
                // 中键关闭标签
                if (e.button === 1) { e.preventDefault(); closeTab(t.id) }
              }}
            >
              <span className="tab-title">{t.title}</span>
              <button
                className="tab-close"
                title="关闭标签"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}
              ><Icon d={PATH_X} size={11} /></button>
            </div>
          )
        })}
        <button
          className="btn-ghost"
          title="回到书库"
          onClick={() => setMainView('library')}
          style={{ alignSelf: 'center', marginLeft: 4, padding: '2px 8px', border: 'none' }}
        ><Icon d={PATH_PLUS} size={14} /></button>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', flexShrink: 0 }}>
        <button
          onClick={onOpenPalette}
          title="命令面板"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px 0 9px',
            borderRadius: 13, background: 'var(--bg)', border: '1px solid var(--border)',
            color: 'var(--fg-muted)', fontSize: 12, cursor: 'pointer', minWidth: 170,
          }}
        >
          <Icon d={PATH_SEARCH} size={12} />
          <span style={{ flex: 1, textAlign: 'left' }}>搜索论文、笔记或命令…</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10,
            border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px',
          }}>
            <Icon d={PATH_COMMAND} size={9} />K
          </span>
        </button>

        <QueueIndicator />

        <button
          onClick={onOpenSettings}
          title={aiReady ? 'AI 已配置' : 'AI 未配置，点击设置'}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent',
            color: 'var(--fg-muted)', fontSize: 12, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap',
          }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: aiReady ? '#12B76A' : '#F79009',
          }} />
          {aiReady ? 'AI' : 'AI 未配置'}
        </button>
      </div>
    </div>
  )
}
