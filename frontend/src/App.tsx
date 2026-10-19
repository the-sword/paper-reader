import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import DocumentList from './components/DocumentList'
import PdfViewer from './components/PdfViewer'
import NotePanel from './components/NotePanel'
import Resizer from './components/Resizer'
import { useStore } from './stores/useStore'
import { api } from './api/client'

const W_SIDEBAR = 250
const W_LIST = 330
const W_NOTES = 300

/** 窗口宽度安全阈值（低于此值收起侧边栏；更低时再收起笔记面板） */
const NARROW = 1360
const VERY_NARROW = 1120

/** 阅读区需要的最小宽度：低于此值就压缩列表列 */
const MIN_READER_W = 620

const SCALE_MIN = 0.4
const SCALE_MAX = 4
const SCALE_STEP = 0.15

export default function App() {
  const currentDoc = useStore((s) => s.currentDoc)
  const error = useStore((s) => s.error)
  const loading = useStore((s) => s.loading)
  const clearError = useStore((s) => s.clearError)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const refreshLibrary = useStore((s) => s.refreshLibrary)

  const [scale, setScale] = useState(1.0)
  const [wSidebar, setWSidebar] = useState(W_SIDEBAR)
  const [wList, setWList] = useState(W_LIST)
  const [wNotes, setWNotes] = useState(W_NOTES)

  const [showSidebar, setShowSidebar] = useState(true)
  const [showNotes, setShowNotes] = useState(true)

  const mainRef = useRef<HTMLElement>(null)
  /** PDF 首页在 scale=1 时的宽度（pt），用于「适应宽度」 */
  const [baseWidth, setBaseWidth] = useState<number | null>(null)

  const clampScale = (v: number) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, +v.toFixed(2)))

  /** 适应宽度：按阅读区可用宽度算出精确 scale */
  const fitWidth = useCallback(() => {
    const el = mainRef.current
    if (!el || !baseWidth) return
    const avail = el.clientWidth - 24 // 留出左右内边距
    if (avail <= 0) return
    setScale(clampScale(avail / baseWidth))
  }, [baseWidth])

  // 分级响应式：优先保证「阅读区」宽度，其次才保留辅助面板
  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth
      setShowSidebar(vw >= NARROW)
      setShowNotes(vw >= VERY_NARROW)
      // 阅读区不足时，主动压缩文献列表
      const usable = vw - (vw >= NARROW ? wSidebar : 0) - (vw >= VERY_NARROW ? wNotes : 0)
      const spare = usable - wList - MIN_READER_W
      if (spare < 0) setWList(Math.max(240, wList + spare))
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 文献切换时自动适应宽度（一次性），避免默认比例超出阅读区
  useEffect(() => {
    if (!currentDoc) return
    setBaseWidth(null)
    // baseWidth 到达后由下面的 effect 触发
  }, [currentDoc])

  const lastFitFor = useRef<string | null>(null)
  useEffect(() => {
    if (!currentDoc || !baseWidth) return
    if (lastFitFor.current === currentDoc.id) return
    lastFitFor.current = currentDoc.id
    fitWidth()
  }, [currentDoc, baseWidth, fitWidth])

  // 快捷键：+/- 缩放，0 适应宽度，1 实际大小
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey) return
      if (e.key === '+' || e.key === '=') { setScale((s) => clampScale(s + SCALE_STEP)); e.preventDefault() }
      else if (e.key === '-') { setScale((s) => clampScale(s - SCALE_STEP)); e.preventDefault() }
      else if (e.key === '0') { fitWidth(); e.preventDefault() }
      else if (e.key === '1') { setScale(1); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fitWidth])

  useEffect(() => {
    void refreshSidebar()
    void refreshLibrary()
  }, [refreshSidebar, refreshLibrary])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(clearError, 6000)
    return () => clearTimeout(t)
  }, [error, clearError])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* ---------- 顶栏 ---------- */}
      <header style={{
        height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-side)',
        overflow: 'hidden',
      }}>
        <button
          className="btn-ghost"
          style={{ padding: '4px 8px' }}
          title={showSidebar ? '收起侧栏' : '展开侧栏'}
          onClick={() => setShowSidebar((v) => !v)}
        >☰</button>
        <strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>Paper Reader</strong>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>本地文献阅读器</span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button className="btn-ghost" title="缩小 (−)" onClick={() => setScale((s) => clampScale(s - SCALE_STEP))}>－</button>
          <span
            title="当前缩放"
            style={{ fontSize: 12, width: 48, textAlign: 'center', cursor: 'pointer' }}
            onClick={() => setScale(1)}
          >{Math.round(scale * 100)}%</span>
          <button className="btn-ghost" title="放大 (+)" onClick={() => setScale((s) => clampScale(s + SCALE_STEP))}>＋</button>
          <button className="btn-ghost" title="适应宽度 (0)" onClick={fitWidth}>适应宽度</button>
          <button
            className="btn-ghost"
            style={{ padding: '4px 8px', marginLeft: 6 }}
            title={showNotes ? '收起笔记' : '展开笔记'}
            onClick={() => setShowNotes((v) => !v)}
          >📝</button>
        </div>
      </header>

      {/* ---------- 三栏主体 ---------- */}
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
          style={{
            flex: '1 1 0', minWidth: 0, overflow: 'auto',
            background: 'var(--bg-canvas)',
          }}
        >
          {currentDoc ? (
            <PdfViewer
              url={api.pdfUrl(currentDoc.id)}
              scale={scale}
              onBaseWidth={setBaseWidth}
            />
          ) : (
            <div className="hint" style={{ padding: 40, textAlign: 'center' }}>
              {loading ? '加载中…' : '从左侧选择或导入一篇 PDF'}
            </div>
          )}
        </main>

        {showNotes && (
          <>
            <Resizer side="right" min={220} max={460} onResize={setWNotes} />
            <NotePanel width={wNotes} />
          </>
        )}
      </div>

      {error && (
        <div style={{
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
          background: '#7f1d1d', color: '#fff', padding: '10px 16px', borderRadius: 8,
          fontSize: 12, maxWidth: '70vw', zIndex: 1000,
        }}>
          {error}
        </div>
      )}
    </div>
  )
}
