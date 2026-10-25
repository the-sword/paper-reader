import { useStore, type MainView } from '../stores/useStore'
import { Icon, PATH_LIBRARY, PATH_BOOK_OPEN, PATH_RADAR, PATH_SEARCH, PATH_SETTINGS } from './icons'

interface Props {
  onOpenSettings: () => void
  onOpenArxiv: () => void
}

/** 导航按钮：图标 + 10px 文字标签，激活态用 --bg-active 底色 */
function NavItem({ icon, label, active, disabled, onClick }: {
  icon: string[]
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`nav-item${active ? ' active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      <Icon d={icon} size={18} />
      <span>{label}</span>
    </button>
  )
}

/** 全局导航轨：书库 / 阅读 / 雷达 / 发现 / 设置（手机端为底部横条） */
export default function NavRail({ onOpenSettings, onOpenArxiv }: Props) {
  const mainView = useStore((s) => s.mainView)
  const setMainView = useStore((s) => s.setMainView)
  const openTabs = useStore((s) => s.openTabs)
  const currentDoc = useStore((s) => s.currentDoc)
  const openDocument = useStore((s) => s.openDocument)

  const go = (v: MainView) => setMainView(v)

  const openReader = () => {
    if (currentDoc) { go('reader'); return }
    const last = openTabs[openTabs.length - 1]
    if (last) void openDocument(last.id)
  }

  return (
    <nav className="nav-rail">
      <div className="nav-logo">P</div>
      <NavItem icon={PATH_LIBRARY} label="书库" active={mainView === 'library'} onClick={() => go('library')} />
      <NavItem
        icon={PATH_BOOK_OPEN} label="阅读"
        active={mainView === 'reader'} disabled={openTabs.length === 0}
        onClick={openReader}
      />
      <NavItem icon={PATH_RADAR} label="雷达" active={mainView === 'radar'} onClick={() => go('radar')} />
      <NavItem icon={PATH_SEARCH} label="发现" onClick={onOpenArxiv} />
      <div className="nav-spacer" style={{ flex: 1 }} />
      <NavItem icon={PATH_SETTINGS} label="设置" onClick={onOpenSettings} />
    </nav>
  )
}
