/**
 * 段落流双语阅读视图。
 *
 * 设计要点（对应 DESIGN.md D4/D8/D9）：
 *   - 不做像素级还原，把 PDF 解析成段落流，逐段呈现
 *   - 双语模式：每段英文下方紧跟中文译文（上下交错）
 *   - 渐进翻译：只翻译视口内 + 下方 2 屏的段落，结果写进 store 缓存
 *   - 公式用 KaTeX 渲染，图表显示占位
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../stores/useStore'
import { api, type Segment } from '../api/client'
import RichText, { normalizeOcrSpacing } from './RichText'

type Mode = 'source' | 'bilingual' | 'zh'


export default function ReadingView() {
  const currentDoc = useStore((s) => s.currentDoc)
  const segments = useStore((s) => s.segments)
  const translations = useStore((s) => s.translations)
  const engines = useStore((s) => s.engines)
  const selectedEngine = useStore((s) => s.selectedEngine)
  const setSelectedEngine = useStore((s) => s.setSelectedEngine)
  const aiReady = useStore((s) => s.aiReady)
  const annotations = useStore((s) => s.annotations)
  const addAnnotation = useStore((s) => s.addAnnotation)
  const [mode, setMode] = useState<Mode>('bilingual')

  // 选区气泡：翻译 + 标注
  const [term, setTerm] = useState<{
    x: number; y: number; source: string
    text?: string; engine?: string; latency?: number; cached?: boolean
    loading: boolean; error?: string
    // 标注相关
    segmentId: string
    side: 'source' | 'zh'
    truncated?: boolean
    /** 选区在段落内的字符偏移（相对纯文本） */
    startOffset?: number
    endOffset?: number
  } | null>(null)

  /** 选中文字后弹出气泡 */
  /**
   * 计算选区在「段落纯文本」中的起止偏移。
   *
   * 难点：段落里可能混有 KaTeX 渲染的公式（拆成大量 span），
   * 直接用 textContent 长度会算错。这里以段落的 source/译文原文为基准，
   * 通过 Range 前缀长度来定位：
   *   - 把段落容器内的全部内容作为参照，求「从段首到选区起点」的文本长度
   *   - 公式节点整体按 1 个占位符计（渲染时保留同一占位符参与切分）
   */
  const computeOffsets = (
    range: Range, segEl: HTMLElement, side: 'source' | 'zh',
  ): { startOffset?: number; endOffset?: number } => {
    try {
      // 定位文本容器：原文是 <p>，译文是 .zh-block
      const container = side === 'zh'
        ? (segEl.querySelector('.zh-block') as HTMLElement | null)
        : (segEl.querySelector('p') as HTMLElement | null)
      if (!container) return {}

      // 起点必须在容器内，否则无从计算
      if (!container.contains(range.startContainer)) return {}

      const before = document.createRange()
      before.selectNodeContents(container)
      before.setEnd(range.startContainer, range.startOffset)
      const startOffset = before.toString().length

      // 终点可能落在别的段落（跨段被截断的情况）。
      // 此时标注范围取「起点 → 本段末尾」。
      if (!container.contains(range.endContainer)) {
        const total = container.textContent?.length ?? 0
        return total > startOffset ? { startOffset, endOffset: total } : {}
      }

      const upto = document.createRange()
      upto.selectNodeContents(container)
      upto.setEnd(range.endContainer, range.endOffset)
      const endOffset = upto.toString().length

      if (endOffset <= startOffset) return {}
      return { startOffset, endOffset }
    } catch {
      return {}
    }
  }

  /** 向上查找最近的段落容器 */
  const closestSeg = (n: Node | null): HTMLElement | null => {
    let node: Node | null = n
    if (node && node.nodeType === 3) node = node.parentNode
    while (node && node !== document.body) {
      if (node.nodeType === 1 && (node as HTMLElement).dataset.segid) {
        return node as HTMLElement
      }
      node = node.parentNode
    }
    return null
  }

  /** 向上查找译文容器（判断选的是原文还是译文） */
  const inZh = (n: Node | null): boolean => {
    let el: HTMLElement | null = n && n.nodeType === 1
      ? (n as HTMLElement)
      : n?.parentElement ?? null
    return !!el?.closest('.zh-block')
  }

  const onTextSelect = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return

    const range = sel.getRangeAt(0)

    // 划词翻译只处理「同一个段落内」的选区。
    // 起止点落在不同段落时，截断到起始段落内部，避免把整篇/M 段送去翻译。
    const startSeg = closestSeg(range.startContainer)
    const endSeg = closestSeg(range.endContainer)
    if (!startSeg) return

    let text = sel.toString().trim()
    let crossSeg = false

    if (endSeg && endSeg !== startSeg) {
      crossSeg = true
      // 只保留起始段落内的部分
      const clipped = document.createRange()
      clipped.selectNodeContents(startSeg)
      clipped.setStart(range.startContainer, range.startOffset)
      text = clipped.toString().trim()
      if (!text) return
    }

    if (text.length < 1) return

    // 单段内的上限：防止整段超长导致接口慢/超限
    if (text.length > 600) {
      text = text.slice(0, 600)
      crossSeg = true
    }

    // 用选区首个矩形定位气泡
    const rects = range.getClientRects()
    const rect = rects.length ? rects[0] : (() => {
      const r = startSeg.getBoundingClientRect()
      return { left: r.left, top: r.top, width: 0, height: 0 }
    })()
    if (rect.width === 0 && rect.height === 0 && !crossSeg) return

    const segmentId = startSeg.dataset.segid!
    const side: 'source' | 'zh' = inZh(range.startContainer) || inZh(range.endContainer)
      ? 'zh' : 'source'

    // 计算选区在该段落内的字符偏移，用于「部分标注」
    const offsets = computeOffsets(range, startSeg, side)

    // 只弹气泡，不自动翻译；由用户点「翻译」触发
    setTerm({
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
      source: text,
      loading: false,
      segmentId,
      side,
      truncated: crossSeg,
      ...offsets,
    })
  }, [])

  /** 手动触发划词翻译 */
  const doTranslate = async () => {
    const t = term
    if (!t || t.text || t.loading) return
    setTerm({ ...t, loading: true, error: undefined })
    try {
      const r = await api.translateTerm(t.source, selectedEngine)
      setTerm((cur) =>
        cur && cur.source === t.source
          ? { ...cur, text: r.text, engine: r.engine, latency: r.latency_ms,
              cached: r.cached, loading: false }
          : cur,
      )
    } catch (e) {
      setTerm((cur) =>
        cur && cur.source === t.source
          ? { ...cur, loading: false, error: String(e).replace(/^Error:\s*/, '') }
          : cur,
      )
    }
  }

  /** 高亮当前选区 */
  const doHighlight = async (color: string) => {
    const t = term
    if (!t || !currentDoc) return
    await addAnnotation(currentDoc.id, 1, [], t.source, color, {
      segmentId: t.segmentId,
      side: t.side,
      kind: 'highlight',
      startOffset: t.startOffset,
      endOffset: t.endOffset,
    })
    setTerm(null)
    window.getSelection()?.removeAllRanges()
  }

  /** 高亮并立即写笔记（侧栏可编辑） */
  const doNote = async () => {
    const t = term
    if (!t || !currentDoc) return
    await addAnnotation(currentDoc.id, 1, [], t.source, '#ffd400', {
      segmentId: t.segmentId,
      side: t.side,
      kind: 'note',
      startOffset: t.startOffset,
      endOffset: t.endOffset,
    })
    setTerm(null)
    window.getSelection()?.removeAllRanges()
  }

  /** 点击空白处关闭气泡 */
  useEffect(() => {
    if (!term) return
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.term-bubble')) return
      // 如果有新选区则不关闭
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return
      setTerm(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [term])

  const scrollRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map())
  const visibleRef = useRef<Set<string>>(new Set())
  /** 可见段落变化时触发重渲染（用于按钮计数） */
  const [visibleTick, setVisibleTick] = useState(0)
  /** 翻译模式：auto=滚动自动翻译（默认），manual=仅手动 */
  const [autoTranslate, setAutoTranslate] = useState(true)
  /** 偏好是否已加载（避免用默认值覆盖用户设置） */
  const prefsLoadedRef = useRef(false)

  // ---- 可见性观察：进入视口的段落排队翻译 ----
  //
  // 启动时加载界面偏好（翻译模式 / 显示模式 / 引擎）
  useEffect(() => {
    void api.getPrefs().then(({ values }) => {
      if (typeof values.translate_mode === 'string') {
        setAutoTranslate(values.translate_mode !== 'manual')
      }
      if (typeof values.reading_mode === 'string'
          && ['source', 'bilingual', 'zh'].includes(values.reading_mode)) {
        setMode(values.reading_mode as Mode)
      }
      if (typeof values.selected_engine === 'string' && values.selected_engine) {
        setSelectedEngine(values.selected_engine)
      }
      prefsLoadedRef.current = true
      // 若为自动模式，补一次首屏翻译（此时观察者已记录可见段落）
      if (values.translate_mode !== 'manual') {
        setTimeout(() => flushRef.current?.(), 200)
      }
    }).catch(() => {
      prefsLoadedRef.current = true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSelectedEngine])

  // 可见段落追踪 + 渐进翻译。
  //
  // 行为由「翻译模式」开关决定：
  //   auto    （默认）：滚动到视口内的段落自动排队翻译（原行为）
  //   manual          ：只记录可见段落，等用户点「翻译当前可见」
  //
  // IntersectionObserver 的回调里必须拿到最新的开关与 store 状态，
  // 因此通过 ref 转发，避免闭包捕获旧值。
  const flushRef = useRef<() => void>(() => {})
  const observerRef = useRef<IntersectionObserver | null>(null)
  const pendingTimer = useRef<number | null>(null)
  const autoModeRef = useRef(true)

  useEffect(() => {
    autoModeRef.current = autoTranslate
  }, [autoTranslate])

  /** 把当前可见 + 未翻译 + 未在飞的段落推入翻译队列 */
  const flushVisible = useCallback((force = false) => {
    // 偏好尚未加载完成时，不自动翻译（避免用户设为手动却先触发一次）
    if (!force && (!autoModeRef.current || !prefsLoadedRef.current)) return
    const st = useStore.getState()
    if (!st.aiReady || !st.currentDoc) return
    const todo: string[] = []
    for (const id of visibleRef.current) {
      if (!st.translations[id] && !st.inflight.has(id)) todo.push(id)
    }
    if (todo.length) void st.translateQueue(todo)
  }, [])

  useEffect(() => {
    flushRef.current = () => flushVisible()
  }, [flushVisible])

  /** 抖动合并：一次滚动里多个元素进出，只调度一次 */
  const scheduleFlush = useCallback(() => {
    if (pendingTimer.current !== null) return
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null
      flushRef.current()
    }, 150)
  }, [])

  // 创建观察者。
  //
  // 依赖 segments：首次渲染时滚动容器可能尚未挂载（ref 为 null），
  // 此时 root 会退化为整个视口，导致可见段落集合始终为空。
  // 放到 segments 变化之后重建，可确保容器已就绪。
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    visibleRef.current.clear()
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.segid
          if (!id) continue
          if (entry.isIntersecting) visibleRef.current.add(id)
          else visibleRef.current.delete(id)
        }
        setVisibleTick((t) => t + 1)
        scheduleFlush()   // 自动模式下会真正触发翻译
      },
      { root, rootMargin: '300px 0px 900px 0px', threshold: 0 },
    )
    observerRef.current = io

    // 立即观察所有已渲染段落
    for (const el of itemRefs.current.values()) io.observe(el)

    return () => {
      io.disconnect()
      if (pendingTimer.current !== null) {
        clearTimeout(pendingTimer.current)
        pendingTimer.current = null
      }
    }
  }, [segments, mode, scheduleFlush])



  // 按段落聚合标注，传给段落渲染
  /** 重翻流程状态 */
  const [retranslating, setRetranslating] = useState(false)
  const [retransMsg, setRetransMsg] = useState('')

  const doRetranslate = async () => {
    if (!currentDoc) return
    const engineName = selectedEngine || '自动'
    if (!confirm(
      `将清除本篇的全部译文缓存并用「${engineName}」重新翻译。\n\n`
      + '标注和笔记不会受影响。继续？',
    )) return

    setRetranslating(true)
    setRetransMsg('正在清除旧译文…')
    const st = useStore.getState()
    try {
      // 第一步：清空缓存
      const cleared = await api.retranslate(currentDoc.id, 'clear')
      setRetransMsg(`已清除 ${cleared.cleared} 条，开始重翻…`)

      // 第二步：清空前端已加载的译文，重新排队
      st.resetTranslations()
      const ids = translatable.map((x) => x.id)
      if (ids.length) {
        await st.translateQueue(ids, selectedEngine)
      }
      setRetransMsg('重翻完成')
      await st.loadSegments(currentDoc.id)
    } catch (e) {
      setRetransMsg(`失败：${String(e).replace(/^Error:\s*/, '').slice(0, 80)}`)
    } finally {
      setRetranslating(false)
    }
  }

  const annBySegment = useMemo(() => {
    const m: Record<string, Mark[]> = {}
    for (const a of annotations) {
      if (!a.segment_id) continue
      ;(m[a.segment_id] ||= []).push({
        id: a.id, color: a.color, side: a.side, comment: a.comment,
        start_offset: a.start_offset, end_offset: a.end_offset,
      })
    }
    return m
  }, [annotations])

  // 可见段落中待翻译的数量（visibleTick 变化时重算）
  const visiblePending = useMemo(() => {
    void visibleTick
    let n = 0
    for (const id of visibleRef.current) {
      if (!translations[id]) n++
    }
    return n
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTick, translations])

  // ---- 大纲 ----
  const outline = useMemo(
    () => segments.filter((s) => s.kind === 'heading'),
    [segments],
  )

  const jumpTo = (id: string) => {
    const el = itemRefs.current.get(id)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ---- 进度 ----
  const translatable = segments.filter((s) => ['text', 'heading'].includes(s.kind))
  const done = translatable.filter((s) => translations[s.id]).length
  const pct = translatable.length ? Math.round((done / translatable.length) * 100) : 0

  if (!segments.length) {
    return (
      <div className="hint" style={{ padding: 40, textAlign: 'center' }}>
        尚未解析。点击上方「解析全文」生成段落流。
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* 大纲 */}
      {outline.length > 0 && (
        <nav style={{
          width: 180, flexShrink: 0, borderRight: '1px solid var(--border)',
          overflowY: 'auto', padding: '10px 6px', background: 'var(--bg-side)',
        }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', padding: '0 6px 8px' }}>大纲</div>
          {outline.map((h) => (
            <div
              key={h.id}
              onClick={() => jumpTo(h.id)}
              style={{
                fontSize: 12, padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                color: 'var(--fg)', lineHeight: 1.4,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              title={h.source}
            >{h.source}</div>
          ))}
        </nav>
      )}

      {/* 正文 */}
      <div
        ref={scrollRef}
        onMouseUp={onTextSelect}
        style={{ flex: 1, minWidth: 0, overflowY: 'auto', position: 'relative' }}
      >
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 32px 120px' }}>
          {segments.map((seg) => (
            <SegmentBlock
              key={seg.id}
              seg={seg}
              mode={mode}
              zh={translations[seg.id]?.text}
              inflight={useStore.getState().inflight.has(seg.id)}
              marks={annBySegment[seg.id] ?? []}
              register={(el) => {
                if (el) itemRefs.current.set(seg.id, el)
                else itemRefs.current.delete(seg.id)
              }}
            />
          ))}
        </div>

        {/* 划词翻译气泡 */}
        {term && (
          <div
            className="term-bubble"
            style={{ left: term.x, top: term.y }}
            onMouseUp={(e) => e.stopPropagation()}
          >
            <div className="term-source">
              {term.source.length > 70 ? term.source.slice(0, 70) + '…' : term.source}
            </div>
            {term.truncated && (
              <div style={{
                fontSize: 10, color: '#b45309', background: '#fef3c7',
                padding: '2px 6px', borderRadius: 4, marginTop: 4,
              }}>
                已截取为首段内容（划词翻译仅处理单段）
              </div>
            )}

            {/* 未翻译：显示触发按钮，不自动请求 */}
            {!term.loading && !term.text && !term.error && (
              <div style={{ marginTop: 6 }}>
                <button
                  className="btn-primary"
                  style={{ fontSize: 11, padding: '3px 10px' }}
                  onClick={() => void doTranslate()}
                >翻译</button>
                <span style={{ fontSize: 10, color: 'var(--fg-muted)', marginLeft: 6 }}>
                  {selectedEngine
                    ? engines.find((e) => e.name === selectedEngine)?.label
                    : '自动选择引擎'}
                </span>
              </div>
            )}

            {term.loading && (
              <div className="term-result loading">翻译中…</div>
            )}
            {!term.loading && term.text && (
              <>
                <div className="term-result">{term.text}</div>
                <div className="term-meta">
                  {term.engine}
                  {term.latency !== undefined && term.latency > 0 && ` · ${term.latency}ms`}
                  {term.cached && ' · 缓存'}
                </div>
              </>
            )}
            {!term.loading && term.error && (
              <div className="term-result error">
                {term.error}
                <button
                  className="btn-ghost"
                  style={{ fontSize: 10, padding: '0 5px', marginLeft: 6 }}
                  onClick={() => void doTranslate()}
                >重试</button>
              </div>
            )}

            <div className="term-actions">
              {[
                ['#ffd400', '黄'],
                ['#22c55e', '绿'],
                ['#3b82f6', '蓝'],
                ['#ef4444', '红'],
              ].map(([c, label]) => (
                <button
                  key={c}
                  className="hl-dot"
                  style={{ background: c }}
                  title={`高亮（${term.side === 'zh' ? '译文' : '原文'}）`}
                  onClick={() => void doHighlight(c)}
                >{label}</button>
              ))}
              <button
                className="btn-ghost"
                style={{ fontSize: 11, padding: '1px 7px' }}
                onClick={() => void doNote()}
                title="高亮并写笔记"
              >笔记</button>
            </div>
            <button
              className="btn-ghost term-close"
              onClick={() => setTerm(null)}
            >✕</button>
          </div>
        )}
      </div>

      {/* 右侧：模式与进度 */}
      <div style={{
        width: 150, flexShrink: 0, borderLeft: '1px solid var(--border)',
        padding: 12, background: 'var(--bg-side)', display: 'flex',
        flexDirection: 'column', gap: 14, overflowY: 'auto',
      }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>翻译引擎</div>
          <select
            value={selectedEngine ?? ''}
            onChange={(e) => {
              const v = e.target.value || null
              setSelectedEngine(v)
              if (prefsLoadedRef.current) {
                void api.savePrefs({ selected_engine: v ?? '' }).catch(() => {})
              }
            }}
            style={{ width: '100%', fontSize: 11, padding: '4px 6px' }}
          >
            <option value="">自动（按优先级）</option>
            {engines.filter((e) => e.enabled && e.configured).map((e) => (
              <option key={e.name} value={e.name}>{e.label}</option>
            ))}
          </select>
          {!aiReady && (
            <div style={{ fontSize: 10, color: '#b91c1c', marginTop: 4, lineHeight: 1.4 }}>
              未配置可用引擎，点右上角 ⚙ 设置
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>显示模式</div>
          {([['source', '仅原文'], ['bilingual', '双语对照'], ['zh', '仅译文']] as const).map(([m, label]) => (
            <div
              key={m}
              onClick={() => {
                setMode(m)
                if (prefsLoadedRef.current) {
                  void api.savePrefs({ reading_mode: m }).catch(() => {})
                }
              }}
              style={{
                fontSize: 12, padding: '5px 8px', borderRadius: 5, cursor: 'pointer',
                marginBottom: 3,
                background: mode === m ? 'var(--bg-active)' : 'transparent',
                color: mode === m ? 'var(--fg-strong)' : 'var(--fg)',
              }}
            >{label}</div>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>翻译方式</div>
          <div style={{ display: 'flex', gap: 2, marginBottom: 10 }}>
            {([
              [true, '自动'],
              [false, '手动'],
            ] as Array<[boolean, string]>).map(([v, label]) => (
              <button
                key={label}
                onClick={() => {
                  setAutoTranslate(v)
                  if (prefsLoadedRef.current) {
                    void api.savePrefs({ translate_mode: v ? 'auto' : 'manual' }).catch(() => {})
                  }
                }}
                title={v
                  ? '滚动到视口内的段落会自动翻译'
                  : '只在你点击按钮时翻译'}
                style={{
                  flex: 1, fontSize: 10, padding: '3px 0', cursor: 'pointer',
                  border: `1px solid ${autoTranslate === v ? 'var(--accent)' : 'var(--border)'}`,
                  background: autoTranslate === v ? 'var(--accent)' : 'transparent',
                  color: autoTranslate === v ? '#fff' : 'var(--fg)',
                }}
              >{label}</button>
            ))}
          </div>

          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>翻译进度</div>
          <div style={{ height: 5, background: 'var(--border)', borderRadius: 3 }}>
            <div style={{
              height: '100%', width: `${pct}%`, background: 'var(--accent)',
              borderRadius: 3, transition: 'width 0.3s',
            }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
            {done} / {translatable.length}
          </div>
        </div>

        <button
          className="btn-ghost"
          style={{ fontSize: 11 }}
          disabled={visiblePending === 0}
          title="只翻译当前屏幕内可见且未翻译的段落"
          onClick={() => flushVisible(true)}
        >翻译当前可见{visiblePending > 0 ? ` (${visiblePending})` : ''}</button>

        <button
          className="btn-ghost"
          style={{ fontSize: 11 }}
          onClick={() => {
            const st = useStore.getState()
            const all = translatable.filter((s) => !translations[s.id]).map((s) => s.id)
            if (all.length) void st.translateQueue(all, selectedEngine)
          }}
        >翻译全文</button>

        <button
          className="btn-ghost"
          style={{ fontSize: 11 }}
          disabled={retranslating}
          title="清除本篇译文缓存并重新翻译（标注不受影响）"
          onClick={() => void doRetranslate()}
        >{retranslating ? '重翻中…' : '清除译文缓存并重翻'}</button>

        {!autoTranslate && (
          <div style={{ fontSize: 10, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            手动模式：滚动不会自动翻译
          </div>
        )}

        {retransMsg && (
          <div style={{
            fontSize: 10, color: 'var(--fg-muted)', lineHeight: 1.5,
            wordBreak: 'break-word',
          }}>{retransMsg}</div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface Mark {
  id: string
  color: string
  side: string
  comment: string | null
  start_offset: number | null
  end_offset: number | null
}

function SegmentBlock({
  seg, mode, zh, inflight, marks, register,
}: {
  seg: Segment
  mode: Mode
  zh?: string
  inflight: boolean
  marks: Mark[]
  register: (el: HTMLElement | null) => void
}) {
  const srcRef = useRef<HTMLDivElement>(null)
  const zhRef = useRef<HTMLDivElement>(null)

  // formula 用 KaTeX 渲染
  useEffect(() => {
    if (seg.kind !== 'formula') return
    const el = srcRef.current
    if (!el) return
    let disposed = false

    void import('katex').then((katex) => {
      if (disposed || !el) return

      // 剥掉外层 $$...$$ / $...$ / \[...\]，注意首尾可能有换行
      let latex = seg.source.trim()
      latex = latex.replace(/^\${1,2}\s*/, '').replace(/\s*\${1,2}$/, '')
      latex = latex.replace(/^\\\[\s*/, '').replace(/\s*\\\]$/, '')
      latex = latex.replace(/^\\begin\{equation\*?\}/, '')
        .replace(/\\end\{equation\*?\}$/, '')
      latex = latex.trim()

      // MinerU 的 OCR 会把字符间距写成独立字符（如 "W a r p"、"c l s"），
      // KaTeX 能解析但渲染间距异常，这里把纯字母序列里的空格去掉。
      // 只处理 \mathrm/\mathsf/\mathit/\text 内部，避免误伤真正的空格语义。
      latex = normalizeOcrSpacing(latex)

      if (!latex) {
        el.textContent = seg.source
        return
      }

      try {
        katex.default.render(latex, el, {
          throwOnError: false,
          displayMode: true,
          strict: false,
          // 出错时把错误的源码标红，便于发现未被支持的宏
          errorColor: '#dc2626',
          trust: false,
          macros: {
            // MinerU 常见写法：\mathsf 里带空格，KaTeX 支持
            '\\mathop': '\\mathop',
          },
        })
      } catch (e) {
        // 渲染失败时退化为等宽文本，至少能看清原始 LaTeX
        el.textContent = ''
        const pre = document.createElement('pre')
        pre.textContent = latex
        pre.style.cssText = 'font-size:12px;color:var(--fg-muted);white-space:pre-wrap;margin:0'
        el.appendChild(pre)
        console.warn('公式渲染失败:', e, latex.slice(0, 80))
      }
    }).catch((e) => {
      if (el) el.textContent = seg.source
      console.warn('KaTeX 加载失败:', e)
    })

    return () => { disposed = true }
  }, [seg.source, seg.kind])

  if (seg.kind === 'figure') {
    const imgUrl = seg.img_path
      ? `/api/reading/${encodeURIComponent(seg.document_id)}/asset/${seg.img_path}`
      : null
    return (
      <figure ref={register} data-segid={seg.id} style={{ margin: '18px 0', textAlign: 'center' }}>
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={seg.caption || 'figure'}
            loading="lazy"
            style={{
              maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)',
              background: '#fff',
            }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div style={{
            padding: '28px 12px', background: 'var(--bg-card)', border: '1px dashed var(--border)',
            borderRadius: 8, color: 'var(--fg-muted)', fontSize: 12,
          }}>[图表]</div>
        )}
        {seg.caption && (
          <figcaption style={{
            fontSize: 12, color: 'var(--fg-muted)', marginTop: 6, lineHeight: 1.5,
            maxWidth: '92%', margin: '6px auto 0',
          }}>{seg.caption}</figcaption>
        )}
      </figure>
    )
  }

  // 参考文献：紧凑展示，默认折叠
  if (seg.kind === 'reference') {
    return (
      <div ref={register} data-segid={seg.id} style={{
        fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.6, margin: '3px 0',
        paddingLeft: 12, textIndent: -12,
      }}>{seg.source}</div>
    )
  }

  if (seg.kind === 'heading') {
    return (
      <section ref={register} data-segid={seg.id} style={{ margin: '30px 0 12px' }}>
        <h3 style={{ fontSize: 17, margin: 0, color: 'var(--fg-strong)', lineHeight: 1.5 }}>
          {mode === 'zh' && zh
            ? <RichText text={zh} />
            : <RichText text={seg.source} />}
        </h3>
        {mode === 'bilingual' && zh && (
          <div className="zh-heading-zh">
            <RichText text={zh} />
          </div>
        )}
      </section>
    )
  }

  if (seg.kind === 'formula') {
    return (
      <div ref={register} data-segid={seg.id} style={{ margin: '12px 0', overflowX: 'auto' }}>
        <div ref={srcRef} />
      </div>
    )
  }

  if (seg.kind === 'table') {
    return (
      <div
        ref={register}
        data-segid={seg.id}
        className="md-table"
        style={{
          margin: '18px 0', overflowX: 'auto',
          border: '1px solid var(--border)', borderRadius: 8, padding: 4,
          background: 'var(--bg-card)',
        }}
        dangerouslySetInnerHTML={{ __html: seg.source }}
      />
    )
  }

  // 普通正文
  const srcMarks = marks.filter((m) => m.side === 'source')
  const zhMarks = marks.filter((m) => m.side === 'zh')

  // 只把「有明确字符范围」的标注转成高亮区间；整段标注用左侧色条表示
  const toRanges = (list: Mark[]) =>
    list
      .filter((m) => m.start_offset !== null && m.end_offset !== null)
      .map((m) => ({
        start: m.start_offset as number,
        end: m.end_offset as number,
        color: m.color,
      }))

  const srcRanges = toRanges(srcMarks)
  const zhRanges = toRanges(zhMarks)

  return (
    <div
      ref={register}
      data-segid={seg.id}
      className={`seg-block${marks.length ? ' has-mark' : ''}`}
      style={{ margin: '14px 0' }}
    >
      {mode !== 'zh' && (
        <p
          ref={srcRef}
          className={srcMarks.length ? 'marked-text' : undefined}
          style={{
            margin: 0, fontSize: 15, lineHeight: 1.9, color: 'var(--fg-strong)',
            textAlign: 'justify',
            ['--mark-color' as string]: srcMarks[0]?.color ?? 'transparent',
          }}
        >
          <RichText text={seg.source} highlights={srcRanges} />
          {srcMarks.length > 0 && (
            <span className="seg-mark-count" title={`原文有 ${srcMarks.length} 条标注`}>
              {srcMarks.length}
            </span>
          )}
        </p>
      )}
      {mode !== 'source' && (
        <div
          ref={zhRef}
          className={`zh-block${mode === 'bilingual' && zh ? ' zh-inline' : ''}`}
          style={{
            marginTop: mode === 'bilingual' && zh ? 8 : 0,
            // 译文略小与原文形成层次，纯译文模式恢复常规字号
            fontSize: mode === 'zh' ? 15 : 14,
            lineHeight: 1.85,
            textAlign: 'justify',
            color: mode === 'zh' ? 'var(--fg-strong)' : 'var(--fg)',
            minHeight: 20,
            ['--mark-color' as string]: zhMarks[0]?.color ?? 'transparent',
          }}
        >
          {zh
            ? <><RichText text={zh} highlights={zhRanges} />
                {zhMarks.length > 0 && (
                  <span className="seg-mark-count" title={`译文有 ${zhMarks.length} 条标注`}>
                    {zhMarks.length}
                  </span>
                )}</>
            : null}
          {!zh && (inflight
            ? <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>翻译中…</span>
            : <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>—</span>)}
        </div>
      )}
    </div>
  )
}
