import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import DocumentList from './components/DocumentList'
import PdfViewer from './components/PdfViewer'
import SettingsDialog from './components/SettingsDialog'
import ArxivPanel from './components/ArxivPanel'
import QueueIndicator from './components/QueueIndicator'
import RadarView from './components/RadarView'
import ReaderSettings, { DEFAULT_READER_PREFS, type ReaderPrefs } from './components/ReaderSettings'
import RightPanel from './components/RightPanel'
import Resizer from './components/Resizer'
import { useStore } from './stores/useStore'
import { api } from './api/client'

const W_SIDEBAR = 250
const W_LIST = 330
const W_NOTES = 300

const NARROW = 1360
const VERY_NARROW = 1120
const MOBILE = 768
const MIN_READER_W = 620

const SCALE_MIN = 0.4
const SCALE_MAX = 4
const SCALE_STEP = 0.15

type ViewMode = 'pdf' | 'reading' | 'bilingual'

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
  const mainView = useStore((s) => s.mainView)
  const setError = (msg: string) => useStore.setState({ error: msg })

  const [scale, setScale] = useState(1.0)
  const [wSidebar, setWSidebar] = useState(W_SIDEBAR)
  const [panelPrefsLoaded, setPanelPrefsLoaded] = useState(false)
  const [wList, setWList] = useState(W_LIST)
  const [wNotes, setWNotes] = useState(W_NOTES)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showNotes, setShowNotes] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [showArxiv, setShowArxiv] = useState(false)
  /** 视图偏好是否已加载，避免用默认值覆盖用户选择 */
  const [viewPrefLoaded, setViewPrefLoaded] = useState(false)
  /** 全局阅读主题与排版 */
  const [readerPrefs, setReaderPrefs] = useState<ReaderPrefs>(DEFAULT_READER_PREFS)
  /** 专注阅读模式：隐藏两侧栏，正文最大化 */
  const [focusMode, setFocusMode] = useState(false)
  /** 窄屏（手机）下文档列表改为抽屉浮层，不再与阅读区争宽 */
  const [isMobile, setIsMobile] = useState(false)
  const [vw, setVw] = useState(0)
  const [showList, setShowList] = useState(false)
  const [showNotesDrawer, setShowNotesDrawer] = useState(false)

  /** 双语 PDF（BabelDOC）任务状态 */
  const [bdJobId, setBdJobId] = useState<string | null>(null)
  const [bdRunning, setBdRunning] = useState(false)
  const [bdProgress, setBdProgress] = useState(0)
  const [bdMessage, setBdMessage] = useState('')
  const [bdReady, setBdReady] = useState<Record<string, boolean>>({})
  const bdPollRef = useRef<number | null>(null)
  const [view, setView] = useState<ViewMode>('pdf')

  const mainRef = useRef<HTMLElement>(null)
  // 基准宽按「文档id:视图」盖章。文档刚切换的瞬间旧文档的基准还留在状态里，
  // 若被 fitWidth 拿去算缩放会得到离谱比例（如前一篇 1224pt 双栏页 →
  // 新页被缩成一小条），且 lastFitFor 会抢先记账使正确基准到达后不再重拟合
  const [baseSize, setBaseSize] = useState<{ key: string; w: number } | null>(null)
  const fitKey = currentDoc ? `${currentDoc.id}:${view}` : null
  const baseWidth = baseSize && baseSize.key === fitKey ? baseSize.w : null

  const clampScale = (v: number) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, +v.toFixed(2)))

  /** 实际完成拟合返回 true；元素/基准未就绪返回 false，供调用方决定是否记账 */
  // 「适应宽度」跟随模式：auto-fit 后置 true，容器尺寸变化（侧栏开合/
  // 分隔条拖动/窗口缩放）时经 ResizeObserver 重拟合；手动缩放退跟随。
  const fitModeRef = useRef(false)
  const exitFitMode = () => { fitModeRef.current = false }

  const fitWidth = useCallback((): boolean => {
    const el = mainRef.current
    if (!el) return false
    let base = baseWidth
    if (!base) {
      // 基准未就绪（刚打开/刚切视图）时从已渲染页反推，保证按钮立即生效；
      // offsetWidth 与容器上 --scale-factor 同代，相除即基准页宽
      const page = el.querySelector<HTMLElement>('.pdf-page')
      const sf = page ? parseFloat(getComputedStyle(page).getPropertyValue('--scale-factor')) : NaN
      if (page?.offsetWidth && sf > 0) base = page.offsetWidth / sf
    }
    if (!base || base <= 0) return false
    const avail = el.clientWidth - 24
    if (avail <= 0) return false
    // 手机上允许缩得更小（0.15），PDF 才能适应窄屏宽度而非横向滚动
    const minScale = isMobile ? 0.15 : SCALE_MIN
    setScale(Math.max(minScale, Math.min(SCALE_MAX, +(avail / base).toFixed(2))))
    fitModeRef.current = true
    return true
  }, [baseWidth, isMobile])

  // PdfViewer 测得基准宽：盖章「文档id:视图」。从 store 实时读文档，
  // 回调身份恒定（deps 为空），不会引起 PdfViewer 加载 effect 的重跑
  const onBaseWidthPdf = useCallback((w: number) => {
    const d = useStore.getState().currentDoc
    if (d) setBaseSize({ key: `${d.id}:pdf`, w })
  }, [])
  const onBaseWidthBilingual = useCallback((w: number) => {
    const d = useStore.getState().currentDoc
    if (d) setBaseSize({ key: `${d.id}:bilingual`, w })
  }, [])

  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth
      setIsMobile(vw < MOBILE)
      setVw(vw)
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

  // 启动时加载上次使用的视图
  useEffect(() => {
    void api.getPrefs().then(({ values }) => {
      // 'reading' 视图已停用，历史偏好回落为 pdf
      if (values.view_mode === 'pdf' || values.view_mode === 'bilingual') {
        setView(values.view_mode)
      }
      // 全局主题与排版
      if (typeof values.reader_theme === 'string') {
        setReaderPrefs((p) => ({ ...p, theme: values.reader_theme as ReaderPrefs['theme'] }))
      }
      // 面板尺寸与显隐
      if (typeof values.panel_sidebar === 'number') setWSidebar(values.panel_sidebar)
      if (typeof values.panel_list === 'number') setWList(values.panel_list)
      if (typeof values.panel_notes === 'number') setWNotes(values.panel_notes)
      if (typeof values.panel_sidebar_visible === 'boolean') setShowSidebar(values.panel_sidebar_visible)
      if (typeof values.panel_notes_visible === 'boolean') setShowNotes(values.panel_notes_visible)
      setPanelPrefsLoaded(true)
      setViewPrefLoaded(true)
    }).catch(() => setViewPrefLoaded(true))
  }, [])

  // 切换文献：只重置缩放，不再强制切换视图。
  // 依赖用 id 而非 currentDoc 对象：refreshCurrentDocMeta 会换新对象，
  // 若按对象重置会把 onBaseWidth 已盖好的基准清掉且不再重报
  useEffect(() => {
    if (!currentDoc) return
    setBaseSize(null)
  }, [currentDoc?.id])

  // 把主题应用到 <html>，使整个应用（含侧栏/顶栏）跟随
  useEffect(() => {
    const root = document.documentElement
    if (readerPrefs.theme === 'auto') {
      root.removeAttribute('data-reader-theme')
    } else {
      root.setAttribute('data-reader-theme', readerPrefs.theme)
    }
  }, [readerPrefs.theme])

  // 进入/退出专注模式时可用宽度变化 → 重新适应宽度。
  // 依赖只挂 focusMode 并经由 ref 取最新 fitWidth：
  // 若挂 fitWidth，baseWidth 每次更新都会触发本 effect 在 50ms 后二次拟合，
  // 恰好撞上 PdfViewer 重建清空页面、滚动条瞬时消失的窗口，量出偏大的
  // clientWidth 导致缩放溢出（横向滚动条）
  const fitWidthRef = useRef(fitWidth)
  fitWidthRef.current = fitWidth
  const focusFirstRun = useRef(true)
  useEffect(() => {
    if (focusFirstRun.current) { focusFirstRun.current = false; return }
    const t = window.setTimeout(() => { fitWidthRef.current() }, 50)
    return () => window.clearTimeout(t)
  }, [focusMode])

  // 容器尺寸变化时，跟随「适应宽度」模式自动重拟合（手动缩放后不跟随）。
  // 覆盖：侧栏/右栏开合、分隔条拖动、窗口缩放、PWA 横竖屏切换。
  useEffect(() => {
    const el = mainRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (!fitModeRef.current) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { fitWidthRef.current() })
    })
    ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [])

  // 打开文档后自动收起移动端列表抽屉（桌面端 showList 不参与渲染，无副作用）
  const openedDocId = currentDoc?.id
  useEffect(() => { setShowList(false) }, [openedDocId])

  /** 面板布局保存的防抖 timer */
  const panelSaveTimer = useRef<number | null>(null)

  // 切换文档时向后端确认双语 PDF 是否已生成，避免重复生成
  useEffect(() => {
    if (!currentDoc) return
    const id = currentDoc.id
    void api.babelDocStatus(id)
      .then((r) => setBdReady((m) => ({ ...m, [id]: r.generated })))
      .catch(() => { /* 忽略 */ })
  }, [currentDoc])

  /** 启动双语 PDF 任务并轮询进度 */
  const startBilingualPdf = async () => {
    if (!currentDoc || bdRunning) return
    setBdRunning(true); setBdProgress(5); setBdMessage('启动任务'); setError('')
    try {
      const { job_id } = await api.startBabelDoc(currentDoc.id)
      setBdJobId(job_id)
      bdPollRef.current = window.setInterval(async () => {
        try {
          const st = await api.babelDocJob(job_id)
          setBdProgress(st.progress); setBdMessage(st.message)
          if (st.status !== 'running') {
            stopBdPoll()
            setBdRunning(false); setBdJobId(null)
            if (st.status === 'done') {
              setBdReady((m) => ({ ...m, [currentDoc.id]: true }))
              // 完成后直接在页面内切换到双语 PDF 视图（并重新适应宽度）
              setBaseSize(null)
              setView('bilingual')
            } else {
              setError(`双语 PDF 生成失败：${st.error ?? '未知原因'}`)
            }
          }
        } catch (e) {
          stopBdPoll(); setBdRunning(false); setBdJobId(null)
          setError(`双语 PDF：${String(e).replace(/^Error:\s*/, '')}`)
        }
      }, 1500)
    } catch (e) {
      setBdRunning(false); setBdJobId(null)
      setError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const stopBdPoll = () => {
    if (bdPollRef.current !== null) {
      window.clearInterval(bdPollRef.current)
      bdPollRef.current = null
    }
  }

  const cancelBd = async () => {
    if (!bdJobId) return
    setBdMessage('正在取消…')
    try { await api.cancelBabelDoc(bdJobId) } catch { /* 忽略 */ }
  }

  useEffect(() => () => stopBdPoll(), [])

  /** 保存面板布局到偏好（防抖，避免拖动时频繁请求） */
  const savePanelPrefs = (patch: { sidebar?: number; list?: number; notes?: number; showSidebar?: boolean; showNotes?: boolean }) => {
    if (!panelPrefsLoaded) return
    if (panelSaveTimer.current !== null) window.clearTimeout(panelSaveTimer.current)
    panelSaveTimer.current = window.setTimeout(() => {
      panelSaveTimer.current = null
      void api.savePrefs({
        ...(patch.sidebar !== undefined ? { panel_sidebar: patch.sidebar } : {}),
        ...(patch.list !== undefined ? { panel_list: patch.list } : {}),
        ...(patch.notes !== undefined ? { panel_notes: patch.notes } : {}),
        ...(patch.showSidebar !== undefined ? { panel_sidebar_visible: patch.showSidebar } : {}),
        ...(patch.showNotes !== undefined ? { panel_notes_visible: patch.showNotes } : {}),
      }).catch(() => {})
    }, 400)
  }
  /** 切换视图并记住选择 */
  const switchView = (v: ViewMode) => {
    // 重置尺寸基准，让新视图重新测量并适应宽度
    if (v !== view) setBaseSize(null)
    setView(v)
    if (viewPrefLoaded) {
      void api.savePrefs({ view_mode: v }).catch(() => {})
    }
  }

  // 适应宽度的去重 key 必须包含视图：
  // 同一篇论文在「PDF / 双语PDF」间切换时，两者的页面尺寸不同，
  // 若只按文档 id 去重会跳过适应，导致打开时不自适应。
  const lastFitFor = useRef<string | null>(null)
  useEffect(() => {
    if (!currentDoc || !baseWidth) return
    const key = `${currentDoc.id}:${view}`
    if (lastFitFor.current === key) return
    // 拟合真正执行后再记账：若因布局未就绪被跳过，不能白消费这个 key
    if (fitWidth()) lastFitFor.current = key
  }, [currentDoc, baseWidth, fitWidth, view])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey) return

      if (e.key === 'Escape' && focusMode) {
        setFocusMode(false); e.preventDefault(); return
      }
      if (e.key === '+' || e.key === '=') { exitFitMode(); setScale((s) => clampScale(s + SCALE_STEP)); e.preventDefault() }
      else if (e.key === '-') { exitFitMode(); setScale((s) => clampScale(s - SCALE_STEP)); e.preventDefault() }
      else if (e.key === '0') { fitWidth(); e.preventDefault() }
      else if (e.key === '1') { exitFitMode(); setScale(1); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fitWidth, view, focusMode])

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
  const parsing = parseState === 'running' || parseState === 'pending' || parseState === 'queued'

  return (
    <div
      className={`app-root${focusMode ? ' focus-mode' : ''}`}
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}
    >
      {/* ---------- 顶栏 ---------- */}
      <header style={{
        height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-side)',
        overflow: 'hidden',
      }}>
        <button
          className="btn-ghost" style={{ padding: '4px 8px' }}
          title={isMobile ? '文档列表' : showSidebar ? '收起侧栏' : '展开侧栏'}
          onClick={() => {
            if (isMobile) { setShowList((v) => !v); return }
            setShowSidebar((v) => { savePanelPrefs({ showSidebar: !v }); return !v })
          }}
        >☰</button>
        <strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>Paper Reader</strong>

        {/* 视图切换 */}
        {currentDoc && (
          <div style={{ display: 'flex', gap: 2, marginLeft: 8, flexShrink: 0 }}>
            <button
              className={`seg ${view === 'pdf' ? 'active' : ''}`}
              onClick={() => switchView('pdf')}
            >PDF</button>
            <button
              className={`seg ${view === 'bilingual' ? 'active' : ''}`}
              title={bdReady[currentDoc.id]
                ? '在页面内阅读双语 PDF（保留原排版）'
                : '生成保留原排版的双语 PDF'}
              onClick={() => {
                if (bdReady[currentDoc.id]) {
                  switchView('bilingual')
                } else {
                  void startBilingualPdf()
                }
              }}
              disabled={bdRunning}
            >{bdRunning ? '生成中' : '双语PDF'}</button>
            {/* 已生成双语 PDF 时提供下载（带访问口令，与页内阅读同源鉴权） */}
            {view === 'bilingual' && bdReady[currentDoc.id] && (
              <a
                className="seg"
                style={{ textDecoration: 'none' }}
                title="下载双语 PDF 文件"
                href={api.babelDocPdfUrl(currentDoc.id)}
                download
              >下载</a>
            )}
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {/* 专注阅读：一键收起两侧栏 */}
          <button
            className={`btn-ghost ${focusMode ? 'active' : ''}`}
            style={{ padding: '4px 8px', fontSize: 11 }}
            title={focusMode ? '退出专注模式 (Esc)' : '专注阅读：收起两侧栏'}
            onClick={() => setFocusMode((v) => !v)}
          >{focusMode ? '收起' : '专注'}</button>

          {/* 全局主题与排版 */}
          <ReaderSettings value={readerPrefs} onChange={setReaderPrefs} />

          {/* 解析按钮 */}
          {bdRunning && (
            <span style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
              {bdMessage} {Math.round(bdProgress)}%
              <button
                className="btn-ghost" style={{ fontSize: 10, padding: '0 4px', marginLeft: 4 }}
                onClick={() => void cancelBd()}
              >取消</button>
            </span>
          )}

          {currentDoc && !hasSegments && !parsing && (
            <button className="btn-primary" style={{ fontSize: 12 }} onClick={() => void startParse('auto')}>
              解析全文
            </button>
          )}
          {parsing && (
            <span style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
              解析中 {parseProgress.toFixed(0)}%
            </span>
          )}

          {(view === 'pdf' || view === 'bilingual') && (
            <>
              <button className="btn-ghost" title="缩小 (−)" onClick={() => { exitFitMode(); setScale((s) => clampScale(s - SCALE_STEP)) }}>－</button>
              <span
                title="当前缩放（点击回到 100%）"
                style={{ fontSize: 12, width: 48, textAlign: 'center', cursor: 'pointer' }}
                onClick={() => { exitFitMode(); setScale(1) }}
              >{Math.round(scale * 100)}%</span>
              <button className="btn-ghost" title="放大 (+)" onClick={() => { exitFitMode(); setScale((s) => clampScale(s + SCALE_STEP)) }}>＋</button>
              <button className="btn-ghost" title="适应宽度 (0)" onClick={fitWidth}>适应宽度</button>
            </>
          )}

          <QueueIndicator />

          <button
            className="btn-ghost"
            style={{ padding: '4px 8px' }}
            title="从 arXiv 搜索并下载论文"
            onClick={() => setShowArxiv(true)}
          >arXiv</button>

          <button
            className="btn-ghost"
            style={{ padding: '4px 8px' }}
            title={aiReady ? 'AI 已配置' : 'AI 未配置，点击设置'}
            onClick={() => setShowSettings(true)}
          >⚙{aiReady ? '' : '!'}</button>
          <button
            className="btn-ghost" style={{ padding: '4px 8px' }}
            title={isMobile ? (showNotesDrawer ? '收起笔记' : '展开笔记') : showNotes ? '收起笔记' : '展开笔记'}
            onClick={() => {
              if (isMobile) { setShowNotesDrawer((v) => !v); return }
              setShowNotes((v) => { savePanelPrefs({ showNotes: !v }); return !v })
            }}
          >📝</button>
        </div>
      </header>

      {/* ---------- 主体 ---------- */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {/* 窄屏硬性隐藏：持久化面板偏好会把可见性顶回 true，不能只靠 resize 置位 */}
        {showSidebar && !isMobile && (
          <>
            <Sidebar width={wSidebar} />
            <Resizer side="left" min={180} max={420} onResize={(w) => { setWSidebar(w); savePanelPrefs({ sidebar: w }) }} />
          </>
        )}

        {mainView === 'radar' ? (
          <RadarView />
        ) : (
          <>
            {isMobile ? (
              // 手机：文档列表抽屉浮层，不挤压阅读区；未打开文档时常开（即文库页）
              (showList || !currentDoc) && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 60 }}
                    onClick={() => { if (currentDoc) setShowList(false) }}
                  />
                  <div style={{
                    position: 'fixed', left: 0, top: 46, bottom: 0, zIndex: 61,
                    width: Math.min(340, Math.max(260, Math.round(vw * 0.85))),
                    boxShadow: '2px 0 16px rgba(0,0,0,.35)', display: 'flex',
                  }}>
                    <DocumentList width={Math.min(340, Math.max(260, Math.round(vw * 0.85)))} />
                  </div>
                </>
              )
            ) : (
              <>
                <DocumentList width={wList} />
                <Resizer side="left" min={240} max={520} onResize={(w) => { setWList(w); savePanelPrefs({ list: w }) }} />
              </>
            )}

            <main
              ref={mainRef}
              style={{ flex: '1 1 0', minWidth: 0, overflow: 'auto', background: 'var(--bg-canvas)' }}
            >
              {!currentDoc ? (
                <div className="hint" style={{ padding: 40, textAlign: 'center' }}>
                  {loading ? '加载中…' : '从左侧选择或导入一篇 PDF'}
                </div>
              ) : view === 'bilingual' ? (
                bdReady[currentDoc.id] ? (
                  <PdfViewer
                    url={api.babelDocPdfUrl(currentDoc.id)}
                    scale={scale}
                    onBaseWidth={onBaseWidthBilingual}
                    dualPage
                  />
                ) : (
                  <div className="hint" style={{ padding: 40, textAlign: 'center' }}>
                    尚未生成双语 PDF，请点击顶栏「双语PDF」生成
                  </div>
                )
              ) : (
                <PdfViewer
                  url={api.pdfUrl(currentDoc.id)}
                  scale={scale}
                  onBaseWidth={onBaseWidthPdf}
                />
              )}
            </main>

            {showNotes && !isMobile && (
              <>
                <Resizer side="right" min={240} max={520} onResize={(w) => { setWNotes(w); savePanelPrefs({ notes: w }) }} />
                <RightPanel width={wNotes} />
              </>
            )}

            {/* 手机：笔记面板右侧抽屉，点顶栏 📝 开关 */}
            {isMobile && showNotesDrawer && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 60 }}
                  onClick={() => setShowNotesDrawer(false)}
                />
                <div style={{
                  position: 'fixed', right: 0, top: 46, bottom: 0, zIndex: 61,
                  width: Math.min(340, Math.max(260, Math.round(vw * 0.85))),
                  boxShadow: '-2px 0 16px rgba(0,0,0,.35)', display: 'flex',
                }}>
                  <RightPanel width={Math.min(340, Math.max(260, Math.round(vw * 0.85)))} />
                </div>
              </>
            )}
          </>
        )}
      </div>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showArxiv && <ArxivPanel onClose={() => setShowArxiv(false)} />}

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
