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
import type { Segment } from '../api/client'

type Mode = 'source' | 'bilingual' | 'zh'

export default function ReadingView() {
  const segments = useStore((s) => s.segments)
  const translations = useStore((s) => s.translations)
  const [mode, setMode] = useState<Mode>('bilingual')

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
      <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 32px 120px' }}>
          {segments.map((seg) => (
            <SegmentBlock
              key={seg.id}
              seg={seg}
              mode={mode}
              zh={translations[seg.id]?.text}
              inflight={useStore.getState().inflight.has(seg.id)}
              register={(el) => {
                if (el) itemRefs.current.set(seg.id, el)
                else itemRefs.current.delete(seg.id)
              }}
            />
          ))}
        </div>
      </div>

      {/* 右侧：模式与进度 */}
      <div style={{
        width: 150, flexShrink: 0, borderLeft: '1px solid var(--border)',
        padding: 12, background: 'var(--bg-side)', display: 'flex',
        flexDirection: 'column', gap: 14, overflowY: 'auto',
      }}>
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
            if (all.length) void st.translateQueue(all)
          }}
        >翻译全文</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function SegmentBlock({
  seg, mode, zh, inflight, register,
}: {
  seg: Segment
  mode: Mode
  zh?: string
  inflight: boolean
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
      try {
        const latex = seg.source.replace(/^\$\$?|\$\$?$/g, '').trim()
        katex.default.render(latex, el, { throwOnError: false, displayMode: true })
      } catch {
        el.textContent = seg.source
      }
    }).catch(() => { if (el) el.textContent = seg.source })
    return () => { disposed = true }
  }, [seg.source, seg.kind])

  if (seg.kind === 'figure') {
    return (
      <figure ref={register} data-segid={seg.id} style={{ margin: '18px 0', textAlign: 'center' }}>
        <div style={{
          padding: '28px 12px', background: 'var(--bg-card)', border: '1px dashed var(--border)',
          borderRadius: 8, color: 'var(--fg-muted)', fontSize: 12,
        }}>
          [图表] {seg.caption || seg.source || ''}
        </div>
      </figure>
    )
  }

  if (seg.kind === 'heading') {
    return (
      <section ref={register} data-segid={seg.id} style={{ margin: '30px 0 12px' }}>
        <h3 style={{ fontSize: 17, margin: 0, color: 'var(--fg-strong)', lineHeight: 1.4 }}>
          {mode === 'zh' && zh ? zh : seg.source}
        </h3>
        {mode === 'bilingual' && zh && (
          <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 3 }}>{zh}</div>
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
      <div ref={register} data-segid={seg.id} style={{
        margin: '16px 0', padding: 12, border: '1px solid var(--border)',
        borderRadius: 8, fontSize: 12, overflowX: 'auto',
      }} dangerouslySetInnerHTML={{ __html: seg.source }} />
    )
  }

  // 普通正文
  return (
    <div ref={register} data-segid={seg.id} style={{ margin: '14px 0' }}>
      {mode !== 'zh' && (
        <p ref={srcRef} style={{
          margin: 0, fontSize: 15, lineHeight: 1.75, color: 'var(--fg-strong)',
          textAlign: 'justify',
        }}>{seg.source}</p>
      )}
      {mode !== 'source' && (
        <div ref={zhRef} style={{
          marginTop: mode === 'bilingual' && zh ? 6 : 0,
          fontSize: 15, lineHeight: 1.8, textAlign: 'justify',
          color: mode === 'zh' ? 'var(--fg-strong)' : 'var(--fg)',
          borderLeft: mode === 'bilingual' ? '2px solid var(--border)' : 'none',
          paddingLeft: mode === 'bilingual' ? 10 : 0,
          minHeight: 20,
        }}>
          {zh ?? (inflight
            ? <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>翻译中…</span>
            : <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>—</span>)}
        </div>
      )}
    </div>
  )
}
