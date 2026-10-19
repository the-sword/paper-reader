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
  } | null>(null)

  /** 选中文字后弹出气泡 */
  const onTextSelect = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = sel.toString().trim()
    if (!text || text.length < 1) return
    // 太长的不当划词处理
    if (text.length > 400) return

    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return

    // 定位选区所属段落，并判断选的是原文还是译文
    let node: Node | null = range.commonAncestorContainer
    if (node.nodeType === 3) node = node.parentNode
    let segEl: HTMLElement | null = null
    while (node && node !== document.body) {
      if (node.nodeType === 1 && (node as HTMLElement).dataset.segid) {
        segEl = node as HTMLElement
        break
      }
      node = node.parentNode
    }
    if (!segEl) return

    const segmentId = segEl.dataset.segid!
    const side: 'source' | 'zh' = range.commonAncestorContainer.parentElement
      ?.closest('.zh-block') ? 'zh' : 'source'

    // 只弹气泡，不自动翻译；由用户点「翻译」触发
    setTerm({
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
      source: text,
      loading: false,
      segmentId,
      side,
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

  // ---- 可见性观察：进入视口的段落排队翻译 ----
  //
  // 关键点：IntersectionObserver 的回调里必须拿到「最新」的 store 状态，
  // 因此通过 ref 转发到最新的 flush 函数，避免闭包捕获旧值。
  const flushRef = useRef<() => void>(() => {})
  const observerRef = useRef<IntersectionObserver | null>(null)
  const pendingTimer = useRef<number | null>(null)

  /** 把当前可见 + 未翻译 + 未在飞的段落推入翻译队列 */
  const flushVisible = useCallback(() => {
    const st = useStore.getState()
    if (!st.aiReady || !st.currentDoc) return
    const todo: string[] = []
    for (const id of visibleRef.current) {
      if (!st.translations[id] && !st.inflight.has(id)) todo.push(id)
    }
    if (todo.length) void st.translateQueue(todo)
  }, [])

  // 始终指向最新实现
  useEffect(() => {
    flushRef.current = flushVisible
  }, [flushVisible])

  /** 抖动合并：一次滚动里多个元素进出，只调度一次 */
  const scheduleFlush = useCallback(() => {
    if (pendingTimer.current !== null) return
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null
      flushRef.current()
    }, 120)
  }, [])

  // 创建观察者（只依赖容器，不依赖 segments）
  useEffect(() => {
    visibleRef.current.clear()
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.segid
          if (!id) continue
          if (entry.isIntersecting) visibleRef.current.add(id)
          else visibleRef.current.delete(id)
        }
        scheduleFlush()
      },
      { root: scrollRef.current, rootMargin: '300px 0px 900px 0px', threshold: 0 },
    )
    observerRef.current = io
    return () => {
      io.disconnect()
      if (pendingTimer.current !== null) {
        clearTimeout(pendingTimer.current)
        pendingTimer.current = null
      }
    }
  }, [scheduleFlush])

  // 段落集合变化时重新挂观察目标
  useEffect(() => {
    const io = observerRef.current
    if (!io) return
    for (const el of itemRefs.current.values()) {
      io.observe(el)
    }
    scheduleFlush()
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
    const m: Record<string, Array<{ id: string; color: string; side: string; comment: string | null }>> = {}
    for (const a of annotations) {
      if (!a.segment_id) continue
      ;(m[a.segment_id] ||= []).push({
        id: a.id, color: a.color, side: a.side, comment: a.comment,
      })
    }
    return m
  }, [annotations])

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
            onChange={(e) => setSelectedEngine(e.target.value || null)}
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
              onClick={() => setMode(m)}
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

interface Mark { id: string; color: string; side: string; comment: string | null }

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
          <RichText text={seg.source} />
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
            ? <><RichText text={zh} />
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
