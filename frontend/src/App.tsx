import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PdfViewer from './components/PdfViewer'
import SettingsDialog from './components/SettingsDialog'
import ArxivPanel from './components/ArxivPanel'
import RadarView from './components/RadarView'
import { DEFAULT_READER_PREFS, type ReaderPrefs } from './components/ReaderSettings'
import RightPanel from './components/RightPanel'
import OutlinePanel from './components/OutlinePanel'
import Resizer from './components/Resizer'
import NavRail from './components/NavRail'
import TabBar from './components/TabBar'
import DocHeader, { type ViewMode } from './components/DocHeader'
import ReaderToolbar from './components/ReaderToolbar'
import CommandPalette, { type PaletteCommand } from './components/CommandPalette'
import LibraryView from './components/LibraryView'
import { useStore } from './stores/useStore'
import { useBilingualJob } from './hooks/useBilingualJob'
import { usePdfPageNav } from './hooks/usePdfPageNav'
import { api } from './api/client'

const W_NOTES = 300

const VERY_NARROW = 1120
const MOBILE = 768

const SCALE_MIN = 0.4
const SCALE_MAX = 4
const SCALE_STEP = 0.15
/** 手机端允许缩到的最小比例，保证 PDF 能适应窄屏宽度 */
const MOBILE_SCALE_MIN = 0.15
/** 手机端抽屉宽度：视口的 85%，限定在 [260, 340] */
const DRAWER_MIN_W = 260
const DRAWER_MAX_W = 340
/** 跳页定位后目标页闪烁描边的时长（毫秒） */
const FLASH_MS = 600

/** 阅读主题的切换顺序（值与 ReaderSettings 中的 theme 一致） */
const THEME_CYCLE: Array<{ value: ReaderPrefs['theme']; label: string }> = [
  { value: 'auto', label: '跟随系统' },
  { value: 'crisp', label: '明亮' },
  { value: 'sepia', label: '护眼' },
  { value: 'soft', label: '柔和' },
  { value: 'night', label: '夜间' },
]

const clampScale = (v: number): number => Math.max(SCALE_MIN, Math.min(SCALE_MAX, +v.toFixed(2)))

/** 下一个阅读主题（循环） */
function nextTheme(current: ReaderPrefs['theme']): { value: ReaderPrefs['theme']; label: string } {
  const i = THEME_CYCLE.findIndex((t) => t.value === current)
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length]
}

/** 当前焦点是否在可输入元素上（此时不响应单键快捷键） */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export default function App() {
  const currentDoc = useStore((s) => s.currentDoc)
  const error = useStore((s) => s.error)
  const loading = useStore((s) => s.loading)
  const clearError = useStore((s) => s.clearError)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const mainView = useStore((s) => s.mainView)
  const setMainView = useStore((s) => s.setMainView)
  const rightOpen = useStore((s) => s.rightOpen)
  const setRightOpen = useStore((s) => s.setRightOpen)
  const leftOpen = useStore((s) => s.leftOpen)
  const jumpRequest = useStore((s) => s.jumpRequest)

  const [scale, setScale] = useState(1.0)
  const [panelPrefsLoaded, setPanelPrefsLoaded] = useState(false)
  const [wNotes, setWNotes] = useState(W_NOTES)
  const [showSettings, setShowSettings] = useState(false)
  const [showArxiv, setShowArxiv] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** 视图偏好是否已加载，避免用默认值覆盖用户选择 */
  const [viewPrefLoaded, setViewPrefLoaded] = useState(false)
  /** 全局阅读主题与排版 */
  const [readerPrefs, setReaderPrefs] = useState<ReaderPrefs>(DEFAULT_READER_PREFS)
  /** 专注阅读模式：隐藏导航轨与标签栏，正文最大化 */
  const [focusMode, setFocusMode] = useState(false)
  /** 窄屏（手机）下笔记面板改为抽屉浮层 */
  const [isMobile, setIsMobile] = useState(false)
  const [vw, setVw] = useState(0)
  const [view, setView] = useState<ViewMode>('pdf')

  const mainRef = useRef<HTMLElement>(null)
  // 基准宽按「文档id:视图」盖章。文档刚切换的瞬间旧文档的基准还留在状态里，
  // 若被 fitWidth 拿去算缩放会得到离谱比例（如前一篇 1224pt 双栏页 →
  // 新页被缩成一小条），且 lastFitFor 会抢先记账使正确基准到达后不再重拟合
  const [baseSize, setBaseSize] = useState<{ key: string; w: number } | null>(null)
  const fitKey = currentDoc ? `${currentDoc.id}:${view}` : null
  const baseWidth = baseSize && baseSize.key === fitKey ? baseSize.w : null
  /** 最近一次完成「适应宽度」拟合的 key，供页码恢复判断布局是否已稳定 */
  const [fitDoneKey, setFitDoneKey] = useState<string | null>(null)

  const readerActive = mainView === 'reader' && !!currentDoc

  // 「适应宽度」跟随模式：auto-fit 后置 true，容器尺寸变化（右栏开合/
  // 窗口缩放）时经 ResizeObserver 重拟合；手动缩放退跟随。
  const fitModeRef = useRef(false)
  const exitFitMode = (): void => { fitModeRef.current = false }

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
    // 手机上允许缩得更小，PDF 才能适应窄屏宽度而非横向滚动
    const minScale = isMobile ? MOBILE_SCALE_MIN : SCALE_MIN
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

  const onBilingualDone = useCallback((): void => {
    setBaseSize(null)
    setView('bilingual')
  }, [])
  const bilingual = useBilingualJob(onBilingualDone)

  const pageNav = usePdfPageNav({
    mainRef, scale, docId: currentDoc?.id ?? null, view,
    ready: fitKey !== null && fitDoneKey === fitKey, active: readerActive,
  })
  // 快捷键回调需要最新的页码导航，用 ref 避免频繁重绑监听
  const pageNavRef = useRef(pageNav)
  pageNavRef.current = pageNav

  // 目录 / 标注 / 页码引用的跳页请求：滚动到该页并闪烁描边 600ms
  useEffect(() => {
    if (!jumpRequest) return
    pageNavRef.current.goTo(jumpRequest.page)
    const el = mainRef.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${jumpRequest.page}"]`)
    if (!el) return
    el.classList.remove('pdf-flash')
    void el.offsetWidth
    el.classList.add('pdf-flash')
    const t = window.setTimeout(() => el.classList.remove('pdf-flash'), FLASH_MS)
    return () => window.clearTimeout(t)
  }, [jumpRequest])

  useEffect(() => {
    const onResize = (): void => {
      const w = window.innerWidth
      setIsMobile(w < MOBILE)
      setVw(w)
      // 手机端抽屉默认收起；桌面端由偏好决定（见下方偏好加载）
      if (w < MOBILE) setRightOpen(false)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 启动时加载上次使用的视图与阅读偏好
  useEffect(() => {
    void api.getPrefs().then(({ values }) => {
      // 'reading' 视图已停用，历史偏好回落为 pdf
      if (values.view_mode === 'pdf' || values.view_mode === 'bilingual') {
        setView(values.view_mode)
      }
      if (typeof values.reader_theme === 'string') {
        setReaderPrefs((p) => ({ ...p, theme: values.reader_theme as ReaderPrefs['theme'] }))
      }
      if (typeof values.panel_notes === 'number') setWNotes(values.panel_notes)
      // 右栏显隐：有偏好用偏好，否则宽屏默认展开
      setRightOpen(typeof values.panel_notes_visible === 'boolean'
        ? values.panel_notes_visible
        : window.innerWidth >= VERY_NARROW)
      setPanelPrefsLoaded(true)
      setViewPrefLoaded(true)
    }).catch(() => setViewPrefLoaded(true))
  }, [])

  // 切换文献：只重置缩放基准。依赖用 id 而非 currentDoc 对象：
  // refreshCurrentDocMeta 会换新对象，若按对象重置会把 onBaseWidth 已盖好的基准清掉且不再重报
  useEffect(() => {
    if (!currentDoc) return
    setBaseSize(null)
  }, [currentDoc?.id])

  // 把主题应用到 <html>，使整个应用跟随
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
  // 阅读区挂载时才有 main，故随 readerActive 重新订阅
  useEffect(() => {
    const el = mainRef.current
    if (!el || !readerActive || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (!fitModeRef.current) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { fitWidthRef.current() })
    })
    ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [readerActive])

  /** 面板布局保存的防抖 timer */
  const panelSaveTimer = useRef<number | null>(null)

  /** 保存笔记面板布局到偏好（防抖，避免拖动时频繁请求） */
  const savePanelPrefs = (patch: { notes?: number }): void => {
    if (!panelPrefsLoaded || patch.notes === undefined) return
    if (panelSaveTimer.current !== null) window.clearTimeout(panelSaveTimer.current)
    panelSaveTimer.current = window.setTimeout(() => {
      panelSaveTimer.current = null
      void api.savePrefs({ panel_notes: patch.notes }).catch(() => {})
    }, 400)
  }

  // 桌面端右栏显隐写回偏好（手机抽屉的开关不持久化）
  useEffect(() => {
    if (!panelPrefsLoaded || isMobile) return
    void api.savePrefs({ panel_notes_visible: rightOpen }).catch(() => {})
  }, [rightOpen, panelPrefsLoaded, isMobile])

  /** 切换视图并记住选择 */
  const switchView = (v: ViewMode): void => {
    // 重置尺寸基准，让新视图重新测量并适应宽度
    if (v !== view) setBaseSize(null)
    setView(v)
    if (viewPrefLoaded) {
      void api.savePrefs({ view_mode: v }).catch(() => {})
    }
  }

  /** 原文 / 双语切换：双语未生成时触发生成 */
  const onBilingualClick = (): void => {
    if (!currentDoc) return
    if (bilingual.ready[currentDoc.id]) switchView('bilingual')
    else void bilingual.start()
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
    if (fitWidth()) {
      lastFitFor.current = key
      setFitDoneKey(key)
    }
  }, [currentDoc, baseWidth, fitWidth, view])

  const toggleFocus = (): void => setFocusMode((v) => !v)

  const toggleRight = (): void => {
    const st = useStore.getState()
    st.setRightOpen(!st.rightOpen)
  }

  const toggleLeft = (): void => {
    const st = useStore.getState()
    st.setLeftOpen(!st.leftOpen)
  }

  const zoomIn = (): void => { exitFitMode(); setScale((s) => clampScale(s + SCALE_STEP)) }
  const zoomOut = (): void => { exitFitMode(); setScale((s) => clampScale(s - SCALE_STEP)) }
  const zoomReset = (): void => { exitFitMode(); setScale(1) }

  const cycleTheme = (): void => {
    setReaderPrefs((p) => ({ ...p, theme: nextTheme(p.theme).value }))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape' && focusMode) {
        setFocusMode(false); e.preventDefault(); return
      }
      if (!readerActive) return
      const nav = pageNavRef.current
      if (e.key === '+' || e.key === '=') { zoomIn(); e.preventDefault() }
      else if (e.key === '-') { zoomOut(); e.preventDefault() }
      else if (e.key === '0') { fitWidth(); e.preventDefault() }
      else if (e.key === '1') { zoomReset(); e.preventDefault() }
      else if (e.key === ']') { toggleRight(); e.preventDefault() }
      else if (e.key === '[') { toggleLeft(); e.preventDefault() }
      else if (e.key === 'f') { toggleFocus(); e.preventDefault() }
      else if (e.key === 'j') { nav.goTo(nav.page + 1); e.preventDefault() }
      else if (e.key === 'k') { nav.goTo(nav.page - 1); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // zoomIn 等为每次渲染新建的闭包，依赖 fitWidth/readerActive/focusMode 即可覆盖其读取的状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitWidth, readerActive, focusMode, isMobile, leftOpen])

  useEffect(() => {
    void refreshSidebar()
    void refreshLibrary()
  }, [refreshSidebar, refreshLibrary])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(clearError, 7000)
    return () => clearTimeout(t)
  }, [error, clearError])

  const commands = useMemo<PaletteCommand[]>(() => {
    const base: PaletteCommand[] = [
      { id: 'library', label: '打开书库', run: () => setMainView('library') },
      { id: 'radar', label: '情报雷达', run: () => setMainView('radar') },
      { id: 'arxiv', label: '从 arXiv 导入', run: () => setShowArxiv(true) },
      { id: 'settings', label: '设置', run: () => setShowSettings(true) },
      { id: 'theme', label: `切换主题：${nextTheme(readerPrefs.theme).label}`, run: cycleTheme },
    ]
    if (!currentDoc) return base
    const biReady = bilingual.ready[currentDoc.id] === true
    const doc: PaletteCommand[] = [
      { id: 'focus', label: focusMode ? '退出专注模式' : '切换专注模式', hint: 'f', run: toggleFocus },
      { id: 'fit', label: '适应宽度', hint: '0', run: () => { fitWidth() } },
      { id: 'right', label: '切换右栏', hint: ']', run: toggleRight },
      { id: 'view-pdf', label: '切到原文', run: () => switchView('pdf') },
      { id: 'view-bi', label: '切到双语', run: onBilingualClick },
      { id: 'parse', label: '解析全文', run: () => { void useStore.getState().startParse('auto') } },
    ]
    if (!biReady) doc.push({ id: 'bi-gen', label: '生成双语 PDF', run: () => { void bilingual.start() } })
    return [...base, ...doc]
    // 命令闭包读取的是最新渲染的状态，随渲染重建即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDoc, focusMode, readerPrefs.theme, bilingual.ready, view, isMobile, rightOpen, leftOpen])

  const drawerW = Math.min(DRAWER_MAX_W, Math.max(DRAWER_MIN_W, Math.round(vw * 0.85)))

  /** 阅读区主体：无文档 / 双语未生成时给提示，否则渲染 PDF */
  const renderReaderBody = () => {
    if (!currentDoc) {
      return (
        <div className="hint" style={{ padding: 40, textAlign: 'center' }}>
          {loading ? '加载中…' : '从书库选择或导入一篇 PDF'}
        </div>
      )
    }
    if (view === 'bilingual') {
      if (!bilingual.ready[currentDoc.id]) {
        return (
          <div className="hint" style={{ padding: 40, textAlign: 'center' }}>
            尚未生成双语 PDF，请点击顶部「双语」生成
          </div>
        )
      }
      return (
        <PdfViewer
          url={api.babelDocPdfUrl(currentDoc.id)}
          scale={scale}
          onBaseWidth={onBaseWidthBilingual}
          dualPage
        />
      )
    }
    return (
      <PdfViewer
        url={api.pdfUrl(currentDoc.id)}
        scale={scale}
        onBaseWidth={onBaseWidthPdf}
      />
    )
  }

  const leftShown = leftOpen && !isMobile && !focusMode

  const renderReader = () => (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', minWidth: 0 }}>
      {leftShown && <OutlinePanel page={pageNav.page} pageCount={pageNav.pageCount} />}

      <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <DocHeader
          view={view}
          onViewChange={switchView}
          bilingual={bilingual}
          readerPrefs={readerPrefs}
          onReaderPrefsChange={setReaderPrefs}
          rightOpen={rightOpen}
          onToggleRight={toggleRight}
          focusMode={focusMode}
          onToggleFocus={toggleFocus}
          isMobile={isMobile}
          leftOpen={leftShown}
          onToggleLeft={toggleLeft}
        />
        <main
          ref={mainRef}
          style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto', background: 'var(--bg-canvas)', position: 'relative' }}
        >
          {renderReaderBody()}
        </main>
        {currentDoc && (
          <ReaderToolbar
            mainRef={mainRef}
            page={pageNav.page}
            pageCount={pageNav.pageCount}
            scale={scale}
            onGoTo={pageNav.goTo}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onZoomReset={zoomReset}
            onFitWidth={() => { fitWidth() }}
            focusMode={focusMode}
            onToggleFocus={toggleFocus}
          />
        )}
      </div>

      {!isMobile && rightOpen && (
        <Resizer side="right" min={240} max={520} onResize={(w) => { setWNotes(w); savePanelPrefs({ notes: w }) }} />
      )}
      {!isMobile && <RightPanel width={wNotes} />}

      {/* 手机：右栏抽屉（笔记 / 问答 / 导读 / 信息），由 DocHeader 的按钮开关 */}
      {isMobile && rightOpen && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 60 }}
            onClick={() => setRightOpen(false)}
          />
          <div style={{
            position: 'fixed', right: 0, top: 0, bottom: 56, zIndex: 61,
            width: drawerW, boxShadow: '-2px 0 16px rgba(0,0,0,.35)', display: 'flex',
          }}>
            <RightPanel width={drawerW} embedded />
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className={`app-shell${focusMode ? ' focus-mode' : ''}`}>
      <NavRail
        onOpenSettings={() => setShowSettings(true)}
        onOpenArxiv={() => setShowArxiv(true)}
      />

      <div className="app-content">
        <TabBar
          bilingual={bilingual}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setShowSettings(true)}
        />

        {mainView === 'library' && (
          <LibraryView isMobile={isMobile} onOpenArxiv={() => setShowArxiv(true)} />
        )}
        {mainView === 'radar' && <RadarView />}
        {mainView === 'reader' && renderReader()}
      </div>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showArxiv && <ArxivPanel onClose={() => setShowArxiv(false)} />}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}

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
