import { useStore } from '../stores/useStore'
import { api } from '../api/client'
import type { BilingualJob } from '../hooks/useBilingualJob'
import { parseStatusText } from '../lib/parseStatus'
import type { ReaderPrefs } from './ReaderSettings'
import ReaderSettings from './ReaderSettings'
import {
  Icon, PATH_CHEVRON_LEFT, PATH_DOWNLOAD, PATH_FOCUS, PATH_PANEL_RIGHT, PATH_PANEL_LEFT,
} from './icons'

export type ViewMode = 'pdf' | 'bilingual' | 'zh'

interface Props {
  view: ViewMode
  onViewChange: (v: ViewMode) => void
  bilingual: BilingualJob
  /** 未生成态点击双语/译文时回调（App 层弹成本确认浮层后再 start） */
  onBilingualConfirm?: (target: 'bilingual' | 'zh') => void
  readerPrefs: ReaderPrefs
  onReaderPrefsChange: (next: ReaderPrefs) => void
  rightOpen: boolean
  onToggleRight: () => void
  focusMode: boolean
  onToggleFocus: () => void
  isMobile: boolean
  leftOpen: boolean
  onToggleLeft: () => void
}

/** 格式化添加日期为 MM-DD */
function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

/** 阅读视图顶部文档信息条：标题 / 元信息，右侧视图切换与工具按钮 */
export default function DocHeader(props: Props) {
  const { view, onViewChange, bilingual, isMobile, focusMode } = props
  const currentDoc = useStore((s) => s.currentDoc)
  const segments = useStore((s) => s.segments)
  const parseState = useStore((s) => s.parseState)
  const parseProgress = useStore((s) => s.parseProgress)
  const startParse = useStore((s) => s.startParse)
  const setMainView = useStore((s) => s.setMainView)
  const setShowReparse = useStore((s) => s.setShowReparse)

  if (!currentDoc) return null

  const hasSegments = segments.length > 0
  const parsing = parseState === 'running' || parseState === 'pending' || parseState === 'queued'
  const biReady = bilingual.ready[currentDoc.id] === true
  /** 当前文档的双语任务是否正在生成（生成中按钮禁点、显示进度） */
  const biRunning = bilingual.running
  const biProgress = Math.round(bilingual.progress)
  const meta = [
    `${currentDoc.page_count ?? '?'} 页`,
    `添加于 ${shortDate(currentDoc.added_at)}`,
  ].join(' · ')

  /** 双语 / 译文：已生成则切换；未生成则弹成本确认（App 层触发 start） */
  const onDualClick = (target: 'bilingual' | 'zh') => {
    if (biReady) onViewChange(target)
    else props.onBilingualConfirm?.(target)
  }

  /** 生成中：两个按钮同状态显示进度；未生成：加「未生成」小标 */
  const dualLabel = (_target: 'bilingual' | 'zh', text: string): React.ReactNode => {
    if (biRunning) {
      const pct = `${biProgress > 0 ? ` ${biProgress}%` : '…'}`
      return <span style={{ whiteSpace: 'nowrap' }}>{text}{pct}</span>
    }
    if (!biReady) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}>
          {text}
          <span style={{ fontSize: 9, opacity: 0.75 }}>未生成</span>
        </span>
      )
    }
    return text
  }

  return (
    <header className="reader-header">
      {isMobile && (
        <button
          className="btn-ghost"
          title="返回书库"
          onClick={() => setMainView('library')}
          style={{ padding: '4px 6px', border: 'none', display: 'flex' }}
        ><Icon d={PATH_CHEVRON_LEFT} size={16} /></button>
      )}

      {!isMobile && (
        <button
          className="btn-ghost"
          title={props.leftOpen ? '收起左栏 ([)' : '展开左栏 ([)'}
          onClick={props.onToggleLeft}
          style={{ padding: '4px 6px', border: 'none', display: 'flex', color: props.leftOpen ? 'var(--accent)' : 'var(--fg-muted)' }}
        ><Icon d={PATH_PANEL_LEFT} size={16} /></button>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--fg-strong)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{currentDoc.title}</div>
        {!isMobile && <div className="hint" style={{ fontSize: 11 }}>{meta}</div>}
      </div>

      <div style={{ display: 'flex', flexShrink: 0 }}>
        <button
          className={`seg ${view === 'pdf' ? 'active' : ''}`}
          onClick={() => onViewChange('pdf')}
        >原文</button>
        {/* 手机端双栏太窄：不显示双语，偏好为双语时实际使用译文视图 */}
        {!isMobile && (
          <button
            className={`seg${!biReady ? ' seg-bi-muted' : ''} ${view === 'bilingual' ? 'active' : ''}`}
            title={biReady
              ? '在页面内阅读双语 PDF（保留原排版）'
              : biRunning ? '双语 PDF 正在生成…' : '生成保留原排版的双语 PDF（点击确认成本）'}
            onClick={() => onDualClick('bilingual')}
            disabled={!biReady && biRunning}
          >{dualLabel('bilingual', '双语')}</button>
        )}
        <button
          className={`seg${!biReady && !biRunning ? ' seg-bi-muted' : ''} ${view === 'zh' ? 'active' : ''}`}
          title={biReady
            ? '只看右半译文列'
            : biRunning ? '双语 PDF 正在生成…' : '生成双语 PDF 后可看译文列（点击确认成本）'}
          onClick={() => onDualClick('zh')}
          disabled={!biReady && biRunning}
        >{dualLabel('zh', '译文')}</button>
      </div>

      {!isMobile && biReady && (
        <a
          title="下载双语 PDF 文件"
          href={api.babelDocPdfUrl(currentDoc.id)}
          download
          style={{ display: 'flex', color: 'var(--fg-muted)' }}
        ><Icon d={PATH_DOWNLOAD} size={15} /></a>
      )}

      {!isMobile && !hasSegments && !parsing && (
        <button className="btn-ghost" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => void startParse('auto')}>
          解析全文
        </button>
      )}
      {!isMobile && parsing && (
        <span className="hint" style={{ whiteSpace: 'nowrap' }}>{parseStatusText(parseState, parseProgress)}</span>
      )}
      {!isMobile && hasSegments && !parsing && (
        // 已解析：弱化的「重新解析」，打开引擎选择浮层（目录不对时的补救入口）
        <button
          className="btn-ghost"
          title="用其他引擎重新解析全文（替换段落与目录）"
          style={{ fontSize: 12, padding: '3px 8px', color: 'var(--fg-muted)', border: 'none' }}
          onClick={() => setShowReparse(true)}
        >重新解析</button>
      )}

      {!isMobile && (
        <ReaderSettings value={props.readerPrefs} onChange={props.onReaderPrefsChange} />
      )}

      {isMobile && (
        <button
          className="btn-ghost"
          title="笔记与问答"
          onClick={props.onToggleRight}
          style={{ padding: '4px 6px', border: 'none', display: 'flex', color: props.rightOpen ? 'var(--accent)' : 'var(--fg-muted)' }}
        ><Icon d={PATH_PANEL_RIGHT} size={16} /></button>
      )}

      {!isMobile && (
        <button
          className="btn-ghost"
          title={focusMode ? '退出专注模式 (Esc)' : '专注阅读 (f)'}
          onClick={props.onToggleFocus}
          style={{ padding: '4px 6px', border: 'none', display: 'flex', color: focusMode ? 'var(--accent)' : 'var(--fg-muted)' }}
        ><Icon d={PATH_FOCUS} size={16} /></button>
      )}
    </header>
  )
}
