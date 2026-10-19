import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import DocumentList from './components/DocumentList'
import PdfViewer from './components/PdfViewer'
import ReadingView from './components/ReadingView'
import SettingsDialog from './components/SettingsDialog'
import NotePanel from './components/NotePanel'
import Resizer from './components/Resizer'
import { useStore } from './stores/useStore'
import { api } from './api/client'

const W_SIDEBAR = 250
const W_LIST = 330
const W_NOTES = 300

const NARROW = 1360
const VERY_NARROW = 1120
const MIN_READER_W = 620

const SCALE_MIN = 0.4
const SCALE_MAX = 4
const SCALE_STEP = 0.15

type ViewMode = 'pdf' | 'reading'

export default function App() {
  const currentDoc = useStore((s) => s.currentDoc)
  const error = useStore((s) => s.error)
  const loading = useStore((s) => s.loading)
  const segments = useStore((s) => s.segments)
  const parseState = useStore((s) => s.parseState)
  const parseProgress = useStore((s) => s.parseProgress)
  const aiReady = useStore((s) => s.aiReady)
  const clearError = useStore((s) => s.clearError)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const startParse = useStore((s) => s.startParse)

  const [scale, setScale] = useState(1.0)
  const [wSidebar, setWSidebar] = useState(W_SIDEBAR)
  const [wList, setWList] = useState(W_LIST)
  const [wNotes, setWNotes] = useState(W_NOTES)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showNotes, setShowNotes] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useState<ViewMode>('pdf')

  const mainRef = useRef<HTMLElement>(null)
  const [baseWidth, setBaseWidth] = useState<number | null>(null)

  const clampScale = (v: number) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, +v.toFixed(2)))

  const fitWidth = useCallback(() => {
    const el = mainRef.current
    if (!el || !baseWidth) return
    const avail = el.clientWidth - 24
    if (avail <= 0) return
    setScale(clampScale(avail / baseWidth))
  }, [baseWidth])

  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth
      setShowSidebar(vw >= NARROW)
      setShowNotes(vw >= VERY_NARROW)
      const usable = vw - (vw >= NARROW ? wSidebar : 0) - (vw >= VERY_NARROW ? wNotes : 0)
      const spare = usable - wList - MIN_READER_W
      if (spare < 0) setWList(Math.max(240, wList + spare))
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换文献时按已有段落自动选择视图
  useEffect(() => {
    if (!currentDoc) return
    setBaseWidth(null)
    setView(segments.length ? 'reading' : 'pdf')
  }, [currentDoc, segments.length])

  const lastFitFor = useRef<string | null>(null)
  useEffect(() => {
    if (!currentDoc || !baseWidth) return
    if (lastFitFor.current === currentDoc.id) return
    lastFitFor.current = currentDoc.id
    fitWidth()
  }, [currentDoc, baseWidth, fitWidth])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey) return
      if (view !== 'pdf') return
      if (e.key === '+' || e.key === '=') { setScale((s) => clampScale(s + SCALE_STEP)); e.preventDefault() }
      else if (e.key === '-') { setScale((s) => clampScale(s - SCALE_STEP)); e.preventDefault() }
      else if (e.key === '0') { fitWidth(); e.preventDefault() }
      else if (e.key === '1') { setScale(1); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fitWidth, view])

  useEffect(() => {
    void refreshSidebar()
    void refreshLibrary()
  }, [refreshSidebar, refreshLibrary])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(clearError, 7000)
    return () => clearTimeout(t)
  }, [error, clearError])

  const hasSegments = segments.length > 0
  const parsing = parseState === 'running' || parseState === 'pending'

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* ---------- 顶栏 ---------- */}
      <header style={{
        height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-side)',
        overflow: 'hidden',
      }}>
        <button
          className="btn-ghost" style={{ padding: '4px 8px' }}
          title={showSidebar ? '收起侧栏' : '展开侧栏'}
          onClick={() => setShowSidebar((v) => !v)}
        >☰</button>
        <strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>Paper Reader</strong>

        {/* 视图切换 */}
        {currentDoc && (
          <div style={{ display: 'flex', gap: 2, marginLeft: 8, flexShrink: 0 }}>
            <button
              className={`seg ${view === 'pdf' ? 'active' : ''}`}
              onClick={() => setView('pdf')}
            >PDF</button>
            <button
              className={`seg ${view === 'reading' ? 'active' : ''}`}
              onClick={() => setView('reading')}
              title={hasSegments ? '段落流双语阅读' : '先解析全文'}
            >双语阅读</button>
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {/* 解析按钮 */}
          {currentDoc && view === 'reading' && !hasSegments && !parsing && (
            <button className="btn-primary" style={{ fontSize: 12 }} onClick={() => void startParse('auto')}>
              解析全文
            </button>
          )}
          {parsing && (
            <span style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
              解析中 {parseProgress.toFixed(0)}%
            </span>
          )}

          {view === 'pdf' && (
            <>
              <button className="btn-ghost" title="缩小 (−)" onClick={() => setScale((s) => clampScale(s - SCALE_STEP))}>－</button>
              <span
                title="当前缩放（点击回到 100%）"
                style={{ fontSize: 12, width: 48, textAlign: 'center', cursor: 'pointer' }}
                onClick={() => setScale(1)}
              >{Math.round(scale * 100)}%</span>
              <button className="btn-ghost" title="放大 (+)" onClick={() => setScale((s) => clampScale(s + SCALE_STEP))}>＋</button>
              <button className="btn-ghost" title="适应宽度 (0)" onClick={fitWidth}>适应宽度</button>
            </>
          )}

          <button
            className="btn-ghost"
            style={{ padding: '4px 8px' }}
            title={aiReady ? 'AI 已配置' : 'AI 未配置，点击设置'}
            onClick={() => setShowSettings(true)}
          >⚙{aiReady ? '' : '!'}</button>
          <button
            className="btn-ghost" style={{ padding: '4px 8px' }}
            title={showNotes ? '收起笔记' : '展开笔记'}
            onClick={() => setShowNotes((v) => !v)}
          >📝</button>
        </div>
      </header>

      {/* ---------- 主体 ---------- */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {showSidebar && (
          <>
            <Sidebar width={wSidebar} />
            <Resizer side="left" min={180} max={420} onResize={setWSidebar} />
          </>
        )}

        <DocumentList width={wList} />
        <Resizer side="left" min={240} max={520} onResize={setWList} />

        <main
          ref={mainRef}
          style={{ flex: '1 1 0', minWidth: 0, overflow: view === 'pdf' ? 'auto' : 'hidden', background: view === 'pdf' ? 'var(--bg-canvas)' : 'var(--bg)' }}
        >
          {!currentDoc ? (
            <div className="hint" style={{ padding: 40, textAlign: 'center' }}>
              {loading ? '加载中…' : '从左侧选择或导入一篇 PDF'}
            </div>
          ) : view === 'reading' ? (
            <ReadingView />
          ) : (
            <PdfViewer
              url={api.pdfUrl(currentDoc.id)}
              scale={scale}
              onBaseWidth={setBaseWidth}
            />
          )}
        </main>

        {showNotes && (
          <>
            <Resizer side="right" min={220} max={460} onResize={setWNotes} />
            <NotePanel width={wNotes} />
          </>
        )}
      </div>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      {error && (
        <div style={{
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
          background: '#7f1d1d', color: '#fff', padding: '10px 16px', borderRadius: 8,
          fontSize: 12, maxWidth: '70vw', zIndex: 3000,
        }}>
          {error}
        </div>
      )}
    </div>
  )
}
