/**
 * Paper-Code Radar 收件箱式情报流（重设计 2026-10）
 *
 * 设计要点（docs/radar-redesign-ui.svg）：
 *  - 单入口：按天分组的卡片流 + 日期导航；检索并入顶栏
 *  - 四动作模型：导入 / 收藏 / 不感兴趣（软冷却）/ 拉黑（⋯ 内二次确认）
 *  - 管道即后台任务：进度可见、可取消；乐观更新 + toast 撤销，全程无原生弹窗
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type RadarDayResponse, type RadarPaper, type RadarPipelineJob, type RadarRepoItem, type RadarTopic,
} from '../api/client'
import { useStore } from '../stores/useStore'

type Toast = { text: string; undo?: () => void; kind?: 'ok' | 'err' }
type Filter = { kind: 'all' | 'topic' | 'code' | 'saved' | 'repos'; topicId?: string }

const CODE_BADGE: Record<RadarPaper['code_status'], { text: string; color: string; bg: string; border: string }> = {
  code_available: { text: '✓ 代码可用', color: '#067647', bg: '#DCFAE6', border: '#ABEFC6' },
  placeholder: { text: '⚠ 占位仓库', color: '#B54708', bg: '#FEF0C7', border: '#FEDF89' },
  no_code: { text: '无代码', color: '#667085', bg: 'var(--bg-side)', border: 'var(--border)' },
}

function fmtDate(d: string): string { return d || '' }
function todayStr(): string { return new Date().toISOString().slice(0, 10) }
function shiftDate(d: string, days: number): string {
  const dt = new Date(d + 'T12:00:00')
  dt.setDate(dt.getDate() + days)
  return dt.toISOString().slice(0, 10)
}
function weekdayZh(d: string): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(d + 'T12:00:00').getDay()]
}
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export default function RadarView() {
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const openDocument = useStore((s) => s.openDocument)

  // ---- 看板数据 ----
  const [day, setDay] = useState<RadarDayResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [topics, setTopics] = useState<RadarTopic[]>([])
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState<Record<string, boolean>>({})
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [blockConfirm, setBlockConfirm] = useState<string | null>(null)

  // ---- 管道任务 ----
  const [job, setJob] = useState<RadarPipelineJob | null>(null)
  const pollRef = useRef<number | null>(null)

  // ---- 检索模式 ----
  const [searchQ, setSearchQ] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const [searchResult, setSearchResult] = useState<RadarPaper[] | null>(null)
  const [searching, setSearching] = useState(false)

  // ---- Toast ----
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<number | null>(null)
  const showToast = useCallback((t: Toast) => {
    setToast(t)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 5000)
  }, [])

  const loadDay = useCallback(async (date?: string) => {
    setLoading(true)
    try {
      const res = date && date !== todayStr()
        ? await api.radarArchive(date)
        : await api.radarToday()
      setDay(res)
    } catch (e) {
      setDay({ date: date || todayStr(), topics: {}, total: 0 })
      showToast({ text: String(e).replace(/^Error:\s*/, ''), kind: 'err' })
    } finally {
      setLoading(false)
    }
  }, [showToast])

  const loadTopics = useCallback(async () => {
    try {
      const cfg = await api.radarGetConfig()
      setTopics(cfg.topics)
    } catch { /* 配置加载失败不打断看板 */ }
  }, [])

  useEffect(() => {
    void loadDay()
    void loadTopics()
  }, [loadDay, loadTopics])

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  const topicName = (id: string) => topics.find((t) => t.id === id)?.name || id
  const viewing = day?.date || todayStr()
  const isToday = viewing === todayStr()

  // ---- 管道 ----
  const startPoll = (jobId: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    pollRef.current = window.setInterval(async () => {
      try {
        const j = await api.radarPipelineJob(jobId)
        setJob(j)
        if (j.status !== 'running') {
          if (pollRef.current) window.clearInterval(pollRef.current)
          if (j.status === 'done') {
            const parts = Object.values(j.result?.topics || {})
              .map((s) => `${s.name}：初筛${s.stage1}/评审${s.reviewed}/入选${s.shown}`)
            showToast({ text: `管道完成${parts.length ? ' · ' + parts.join('，') : ''}` })
            await loadDay(viewing)
          } else if (j.status === 'failed') {
            showToast({ text: `管道失败：${j.error || '未知错误'}`, kind: 'err' })
          } else {
            showToast({ text: '已取消管道' })
          }
        }
      } catch { /* 轮询失败静默重试 */ }
    }, 1000)
  }

  const handleRefresh = async () => {
    if (job?.status === 'running') return
    try {
      const res = await api.radarRefresh()
      setJob({ id: res.job_id, kind: 'radar-pipeline', status: 'running', progress: 0, message: '准备中' })
      startPoll(res.job_id)
    } catch (e) {
      showToast({ text: String(e).replace(/^Error:\s*/, ''), kind: 'err' })
    }
  }

  const handleCancelPipeline = async () => {
    if (!job) return
    try { await api.radarPipelineCancel(job.id) } catch { /* 忽略 */ }
  }

  // ---- 动作（乐观更新 + toast 撤销）----
  const actLocal = (pid: string, action: RadarPaper['action']) => {
    setDay((cur) => {
      if (!cur) return cur
      const topicsNext: Record<string, RadarPaper[]> = {}
      for (const [tid, arr] of Object.entries(cur.topics)) {
        topicsNext[tid] = arr
          .filter((p) => !(action === 'dismissed' && p.id === pid))
          .map((p) => (p.id === pid ? { ...p, action: action || 'new' } : p))
      }
      return { ...cur, topics: topicsNext, total: Math.max(0, cur.total - (action === 'dismissed' ? 1 : 0)) }
    })
  }

  const doAction = async (p: RadarPaper, action: Parameters<typeof api.radarActOnPaper>[1], done?: () => void) => {
    try {
      await api.radarActOnPaper(p.id, action)
      done?.()
    } catch (e) {
      showToast({ text: String(e).replace(/^Error:\s*/, ''), kind: 'err' })
    }
  }

  const handleDismiss = (p: RadarPaper) => {
    actLocal(p.id, 'dismissed')
    showToast({
      text: '已忽略，14 天内不再主动展示',
      undo: () => { void doAction(p, 'restore', () => { actLocal(p.id, 'new'); void loadDay(viewing) }) },
    })
    void doAction(p, 'dismiss')
  }

  const handleSave = (p: RadarPaper) => {
    const toSaved = p.action !== 'saved'
    actLocal(p.id, toSaved ? 'saved' : 'new')
    showToast({
      text: toSaved ? '已收藏，可稍后导入' : '已取消收藏',
      undo: () => { void doAction(p, toSaved ? 'unsave' : 'save', () => actLocal(p.id, toSaved ? 'new' : 'saved')) },
    })
    void doAction(p, toSaved ? 'save' : 'unsave')
  }

  const handleBlock = (p: RadarPaper) => {
    actLocal(p.id, 'dismissed')
    setMenuFor(null)
    setBlockConfirm(null)
    showToast({ text: '已拉黑，该论文永不再推荐', undo: () => { void doAction(p, 'restore', () => { actLocal(p.id, 'new'); void loadDay(viewing) }) } })
    void doAction(p, 'block')
  }

  const handleImport = async (p: RadarPaper) => {
    setImporting((m) => ({ ...m, [p.id]: true }))
    try {
      const res = await api.radarImportPaper(p.id)
      await refreshLibrary()
      const docId = res.document?.id
      setDay((cur) => {
        if (!cur) return cur
        const topicsNext: Record<string, RadarPaper[]> = {}
        for (const [tid, arr] of Object.entries(cur.topics)) {
          topicsNext[tid] = arr.map((x) => x.id === p.id
            ? { ...x, action: 'imported', imported_doc_id: docId ?? x.imported_doc_id } : x)
        }
        return { ...cur, topics: topicsNext }
      })
      showToast({ text: `已导入：${p.title.slice(0, 40)}` })
    } catch (e) {
      showToast({ text: `导入失败：${String(e).replace(/^Error:\s*/, '')}`, kind: 'err' })
    } finally {
      setImporting((m) => ({ ...m, [p.id]: false }))
    }
  }

  const handleBibtex = async (p: RadarPaper) => {
    try {
      const text = await api.radarBibtex(p.id)
      await navigator.clipboard.writeText(text)
      showToast({ text: 'BibTeX 已复制到剪贴板' })
    } catch (e) {
      showToast({ text: String(e).replace(/^Error:\s*/, ''), kind: 'err' })
    } finally { setMenuFor(null) }
  }

  // ---- 开源项目（独立流，不依附论文）----
  const actRepoLocal = (rid: string, action: RadarRepoItem['action']) => {
    setDay((cur) => {
      if (!cur) return cur
      const repos = (cur.repos || [])
        .filter((r) => !(action === 'dismissed' && r.id === rid))
        .map((r) => (r.id === rid ? { ...r, action: action || 'new' } : r))
      return { ...cur, repos }
    })
  }

  const doRepoAction = async (r: RadarRepoItem, action: Parameters<typeof api.radarActOnPaper>[1], done?: () => void) => {
    try {
      await api.radarActOnPaper(r.id, action)
      done?.()
    } catch (e) {
      showToast({ text: String(e).replace(/^Error:\s*/, ''), kind: 'err' })
    }
  }

  const handleRepoSave = (r: RadarRepoItem) => {
    const toSaved = r.action !== 'saved'
    actRepoLocal(r.id, toSaved ? 'saved' : 'new')
    showToast({
      text: toSaved ? '已收藏该开源项目' : '已取消收藏',
      undo: () => { void doRepoAction(r, toSaved ? 'unsave' : 'save', () => actRepoLocal(r.id, toSaved ? 'new' : 'saved')) },
    })
    void doRepoAction(r, toSaved ? 'save' : 'unsave')
  }

  const handleRepoDismiss = (r: RadarRepoItem) => {
    actRepoLocal(r.id, 'dismissed')
    showToast({
      text: '已忽略，14 天内不再主动展示',
      undo: () => { void doRepoAction(r, 'restore', () => { actRepoLocal(r.id, 'new'); void loadDay(viewing) }) },
    })
    void doRepoAction(r, 'dismiss')
  }

  const handleRepoBlock = (r: RadarRepoItem) => {
    actRepoLocal(r.id, 'dismissed')
    setMenuFor(null)
    setBlockConfirm(null)
    showToast({ text: '已拉黑，该项目永不再推荐', undo: () => { void doRepoAction(r, 'restore', () => { actRepoLocal(r.id, 'new'); void loadDay(viewing) }) } })
    void doRepoAction(r, 'block')
  }

  // ---- 检索 ----
  const doSearch = async (q: string) => {
    const query = q.trim()
    if (!query) { setSearchActive(false); setSearchResult(null); return }
    setSearchActive(true)
    setSearching(true)
    try {
      const res = await api.radarSearch({ q: query, limit: 60 })
      setSearchResult(res.items)
    } catch (e) {
      showToast({ text: String(e).replace(/^Error:\s*/, ''), kind: 'err' })
    } finally { setSearching(false) }
  }

  // ---- 过滤 ----
  const groups = useMemo(() => {
    if (filter.kind === 'repos') return []
    const entries = Object.entries(day?.topics || {})
    return entries.map(([tid, papers]) => {
      let arr = papers
      if (filter.kind === 'topic' && tid !== filter.topicId) arr = []
      if (filter.kind === 'code') arr = arr.filter((p) => p.code_status === 'code_available')
      if (filter.kind === 'saved') arr = arr.filter((p) => p.action === 'saved')
      return [tid, arr] as [string, RadarPaper[]]
    }).filter(([, arr]) => arr.length > 0)
  }, [day, filter])

  const reposShown = useMemo(() => {
    const repos = day?.repos || []
    if (filter.kind === 'topic') return repos.filter((r) => r.topic_id === filter.topicId)
    if (filter.kind === 'saved') return repos.filter((r) => r.action === 'saved')
    if (filter.kind === 'code') return []
    return repos // all / repos
  }, [day, filter])

  const totalShown = groups.reduce((n, [, a]) => n + a.length, 0)
  const savedCount = useMemo(
    () => Object.values(day?.topics || {}).flat().filter((p) => p.action === 'saved').length
      + (day?.repos || []).filter((r) => r.action === 'saved').length,
    [day],
  )
  const codeCount = useMemo(
    () => Object.values(day?.topics || {}).flat().filter((p) => p.code_status === 'code_available').length,
    [day],
  )
  const reposCount = (day?.repos || []).length

  // ---- 卡片 ----
  const renderRepoCard = (r: RadarRepoItem) => {
    const saved = r.action === 'saved'
    const isNew = !r.created_at || (Date.now() - new Date(r.created_at).getTime()) < 60 * 86400 * 1000
    return (
      <div key={r.id} style={{
        padding: '12px 14px', borderRadius: 10,
        border: '1px solid var(--border)', background: 'var(--bg-card)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
          <span style={{ background: 'var(--bg-active)', borderRadius: 10, padding: '1px 8px', color: 'var(--fg-strong)' }}>
            {topicName(r.topic_id)}
          </span>
          <span style={{ color: 'var(--fg-muted)' }}>开源项目</span>
          {saved && (
            <span style={{ background: '#FEF0C7', border: '1px solid #FEDF89', color: '#B54708', borderRadius: 10, padding: '1px 8px' }}>★ 已收藏</span>
          )}
          <span style={{
            marginLeft: 'auto', background: '#DCFAE6', border: '1px solid #ABEFC6',
            color: '#067647', borderRadius: 10, padding: '1px 8px', whiteSpace: 'nowrap',
          }}>
            ★ {r.stars.toLocaleString()}{r.star_growth > 0 && ` · ↗${r.star_growth}/天`}
          </span>
        </div>

        <div style={{ marginTop: 6, fontSize: 13.5, fontWeight: 600 }}>
          <a href={r.url} target="_blank" rel="noreferrer" style={{ color: 'var(--fg-strong)', textDecoration: 'none' }}>
            {r.title}
          </a>
          {isNew && (
            <span style={{ marginLeft: 8, fontSize: 10, color: '#B45309', background: '#FEF0C7', borderRadius: 8, padding: '1px 6px' }}>
              新项目
            </span>
          )}
        </div>

        {r.description && (
          <div style={{
            marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: 'var(--fg-muted)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{r.description}</div>
        )}

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--fg-muted)' }}>
          <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{r.language || '—'}</span>
          {r.pushed_at && <span>提交 {r.pushed_at.slice(0, 10)}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, position: 'relative' }}>
            <button className="btn-ghost" style={btnGhost} title={saved ? '取消收藏' : '收藏'}
              onClick={() => handleRepoSave(r)}>{saved ? '★ 已收藏' : '☆ 收藏'}</button>
            <button className="btn-ghost" style={btnGhost} title="不感兴趣（14 天内不再展示，可撤销）"
              onClick={() => handleRepoDismiss(r)}>不感兴趣</button>
            <button className="btn-ghost" style={btnGhost} title="更多操作"
              onClick={() => { setMenuFor(menuFor === r.id ? null : r.id); setBlockConfirm(null) }}>⋯</button>

            {menuFor === r.id && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                  onClick={() => { setMenuFor(null); setBlockConfirm(null) }} />
                <div style={{
                  position: 'absolute', right: 0, top: 30, zIndex: 41, width: 150,
                  background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(15,23,42,.18)', padding: '4px 0', overflow: 'hidden',
                }}>
                  <MenuItem onClick={() => { window.open(r.url, '_blank'); setMenuFor(null) }}>打开仓库</MenuItem>
                  <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                  {blockConfirm === r.id ? (
                    <MenuItem danger onClick={() => handleRepoBlock(r)}>确认拉黑？</MenuItem>
                  ) : (
                    <MenuItem danger onClick={() => setBlockConfirm(r.id)}>拉黑该项目…</MenuItem>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const renderStars = (score: number | null) => {
    const n = Math.max(0, Math.min(5, Math.round(score || 0)))
    return (
      <span style={{ fontSize: 11, letterSpacing: 1, color: '#F79009', whiteSpace: 'nowrap' }} title={`评审分 ${score ?? '—'}/5`}>
        {'★'.repeat(n)}<span style={{ color: 'var(--border)' }}>{'★'.repeat(5 - n)}</span>
      </span>
    )
  }

  const renderCard = (p: RadarPaper, showTopic: boolean) => {
    const badge = CODE_BADGE[p.code_status] || CODE_BADGE.no_code
    const rv = p.review || {}
    const isImporting = !!importing[p.id]
    const isOpen = expanded.has(p.id)
    const imported = p.action === 'imported'
    const saved = p.action === 'saved'
    const absUrl = `https://arxiv.org/abs/${p.id.replace('arxiv:', '')}`
    const key = `${p.topic_id}:${p.id}`

    const toggle = () => setExpanded((s) => {
      const next = new Set(s)
      if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
      return next
    })

    return (
      <div key={key} style={{
        padding: '12px 14px', borderRadius: 10,
        border: '1px solid var(--border)',
        background: imported ? 'var(--bg-side)' : 'var(--bg-card)',
        opacity: imported ? 0.78 : 1,
        cursor: 'pointer',
      }} onClick={toggle}>
        {/* 头部行：分数 + Topic + 标签 + 状态徽章 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
          {renderStars(p.score)}
          {showTopic && (
            <span style={{ background: 'var(--bg-active)', borderRadius: 10, padding: '1px 8px', color: 'var(--fg-strong)' }}>
              {topicName(p.topic_id)}
            </span>
          )}
          {rv.primary_tag && <span style={{ color: 'var(--fg-muted)' }}>#{rv.primary_tag}</span>}
          {saved && (
            <span style={{ background: '#FEF0C7', border: '1px solid #FEDF89', color: '#B54708', borderRadius: 10, padding: '1px 8px' }}>★ 已收藏</span>
          )}
          {imported && (
            <span style={{ background: '#DCFAE6', border: '1px solid #ABEFC6', color: '#067647', borderRadius: 10, padding: '1px 8px' }}>✓ 已在库</span>
          )}
          <span style={{
            marginLeft: 'auto', color: badge.color, background: badge.bg,
            border: `1px solid ${badge.border}`, borderRadius: 10, padding: '1px 8px',
          }} title={badge.text}>
            {p.code_status === 'code_available' && p.repo_stars > 0 ? `${badge.text} · ★ ${p.repo_stars}` : badge.text}
          </span>
        </div>

        {/* 标题 */}
        <div style={{ marginTop: 6, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, color: imported ? 'var(--fg-muted)' : 'var(--fg-strong)' }}>
          <a href={absUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}
            onClick={(e) => e.stopPropagation()}>
            {p.title}
          </a>
        </div>

        {/* 展开：LLM 评审四要点 */}
        {isOpen && (
          <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-active)', borderLeft: '3px solid var(--accent)', fontSize: 12, lineHeight: 1.8 }}>
            {rv.one_sentence_summary && <div><b style={{ color: 'var(--accent)' }}>一句话</b>　{rv.one_sentence_summary}</div>}
            {rv.problem_solved && <div><b style={{ color: 'var(--accent)' }}>痛点</b>　{rv.problem_solved}</div>}
            {rv.core_innovation && <div><b style={{ color: 'var(--accent)' }}>方法</b>　{rv.core_innovation}</div>}
            {rv.practical_value && <div><b style={{ color: 'var(--accent)' }}>价值</b>　{rv.practical_value}</div>}
            {p.review_status === 'review_failed' && <div style={{ color: '#b91c1c' }}>评审失败（LLM 未返回有效结果）</div>}
          </div>
        )}

        {/* 摘要（折叠两行） */}
        {!isOpen && p.abstract && (
          <div style={{
            marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: 'var(--fg-muted)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{p.abstract}</div>
        )}

        {/* 底部：作者/日期 + 动作 */}
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--fg-muted)' }}>
          <span>{(p.authors || []).slice(0, 3).join(', ')}{(p.authors || []).length > 3 ? ' 等' : ''}</span>
          <span>{fmtDate(p.published).slice(0, 10)}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            {imported && p.imported_doc_id ? (
              <button className="btn-ghost" style={{ ...btnGhost, color: 'var(--accent)', borderColor: 'var(--accent)' }}
                onClick={() => openDocument(p.imported_doc_id!)}>打开阅读 ↗</button>
            ) : imported ? null : (
              <button className="btn-primary" style={{ fontSize: 11, padding: '3px 10px' }}
                disabled={isImporting} onClick={() => void handleImport(p)}>
                {isImporting ? '导入中…' : '📥 导入阅读器'}
              </button>
            )}
            {!imported && (
              <button className="btn-ghost" style={btnGhost} title={saved ? '取消收藏' : '收藏，稍后导入'}
                onClick={() => handleSave(p)}>{saved ? '★ 已收藏' : '☆ 收藏'}</button>
            )}
            {!imported && (
              <button className="btn-ghost" style={btnGhost} title="不感兴趣（14 天内不再展示，可撤销）"
                onClick={() => handleDismiss(p)}>不感兴趣</button>
            )}
            <button className="btn-ghost" style={btnGhost} title="更多操作"
              onClick={() => { setMenuFor(menuFor === p.id ? null : p.id); setBlockConfirm(null) }}>⋯</button>

            {menuFor === p.id && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                  onClick={() => { setMenuFor(null); setBlockConfirm(null) }} />
                <div style={{
                  position: 'absolute', right: 0, top: 30, zIndex: 41, width: 150,
                  background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(15,23,42,.18)', padding: '4px 0', overflow: 'hidden',
                }}>
                  <MenuItem onClick={() => void handleBibtex(p)}>复制 BibTeX</MenuItem>
                  <MenuItem onClick={() => { window.open(absUrl, '_blank'); setMenuFor(null) }}>打开 arXiv 页面</MenuItem>
                  {p.repo_url && (
                    <MenuItem onClick={() => { window.open(p.repo_url, '_blank'); setMenuFor(null) }}>打开代码仓库</MenuItem>
                  )}
                  <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                  {blockConfirm === p.id ? (
                    <MenuItem danger onClick={() => handleBlock(p)}>确认拉黑？</MenuItem>
                  ) : (
                    <MenuItem danger onClick={() => setBlockConfirm(p.id)}>拉黑该论文…</MenuItem>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ---- 空态 ----
  const renderEmpty = () => {
    if (loading && !day) return <div style={emptyStyle}>正在加载情报…</div>
    if (topics.length === 0) {
      return (
        <div style={emptyStyle}>
          尚未配置任何监控主题。<br />
          打开右上角 ⚙ 设置 →「雷达」标签页，添加研究方向后点「立即抓取」。
        </div>
      )
    }
    if (!day?.is_posting_day) {
      return (
        <div style={{ ...emptyStyle, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          <RadarPulseIcon />
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-strong)' }}>
            {weekdayZh(viewing)} · arXiv 周末不发文
          </div>
          <div style={{ fontSize: 12 }}>新论文公告仅工作日发布</div>
          {day?.prev_date && (
            <button className="btn-ghost" style={{ ...btnGhost, color: 'var(--accent)', borderColor: 'var(--accent)' }}
              onClick={() => void loadDay(day.prev_date!)}>
              查看上一篇（{day.prev_date} {weekdayZh(day.prev_date)}）›
            </button>
          )}
        </div>
      )
    }
    if (searchActive) return <div style={emptyStyle}>未命中。英文按词、中文按连续子串匹配，可换更短的关键词。</div>
    if (totalShown === 0 && reposShown.length === 0
        && (day?.total ?? 0) === 0 && (day?.repos_total ?? 0) === 0) {
      return (
        <div style={emptyStyle}>
          今日暂无入选论文。<br />
          {job?.status === 'running' ? '管道正在运行，稍候片刻…' : '点右上「⚡ 立即抓取」立即执行一轮，或等工作日 08:00 自动运行。'}
        </div>
      )
    }
    return <div style={emptyStyle}>该筛选条件下暂无论文</div>
  }

  const hasContent = searchActive
    ? (searchResult?.length ?? 0) > 0
    : totalShown > 0 || reposShown.length > 0

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto', background: 'var(--bg)', color: 'var(--fg)', padding: '20px 28px 80px' }}>
      {/* 页头 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--fg-strong)' }}>🛰 情报雷达</h2>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
            工作日 08:00 自动抓取 · cross-list 已过滤 · 配置在 ⚙ 设置「雷达」
          </div>
        </div>
        <div style={{ marginLeft: 'auto', minWidth: 168 }}>
          <button className="btn-ghost" style={{ ...btnGhost, padding: '5px 12px', width: '100%', justifyContent: 'center', display: 'flex' }}
            disabled={job?.status === 'running'} onClick={() => void handleRefresh()}>
            ⚡ {job?.status === 'running' ? '管道运行中…' : '立即抓取'}
          </button>
          {job?.status === 'running' && (
            <div style={{ marginTop: 6 }}>
              <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-active)', overflow: 'hidden' }}>
                <div style={{ width: `${job.progress}%`, height: '100%', background: 'var(--accent)', transition: 'width .5s' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--fg-muted)', marginTop: 3 }}>
                <span>{job.message}</span>
                <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => void handleCancelPipeline()}>取消</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 工具栏：日期导航 + 搜索 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '16px 0 8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '2px 4px' }}>
          <button className="btn-ghost" style={chevBtn} title="前一天" onClick={() => void loadDay(shiftDate(viewing, -1))}>‹</button>
          <span style={{ fontSize: 12.5, fontWeight: 600, padding: '0 4px', color: 'var(--fg-strong)', minWidth: 128, textAlign: 'center' }}>
            {isToday ? '今天' : fmtDate(viewing)} · {weekdayZh(viewing)}
          </span>
          <button className="btn-ghost" style={{ ...chevBtn, opacity: isToday ? 0.35 : 1 }} title="后一天" disabled={isToday}
            onClick={() => void loadDay(shiftDate(viewing, 1))}>›</button>
        </div>
        <input
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(searchQ) }}
          placeholder="搜索论文 / 中文评审…（Enter 检索历史全库）"
          style={{ flex: '1 1 220px', fontSize: 12.5, padding: '7px 12px', borderRadius: 8, border: `1px solid ${searchActive ? 'var(--accent)' : 'var(--border)'}`, background: 'var(--bg-card)', color: 'var(--fg)', outline: 'none' }}
        />
        {searchActive && (
          <button className="btn-ghost" style={btnGhost} onClick={() => { setSearchActive(false); setSearchResult(null); setSearchQ('') }}>
            ✕ 退出检索
          </button>
        )}
      </div>

      {/* 过滤 chips（检索模式隐藏） */}
      {!searchActive && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          <Chip active={filter.kind === 'all'} onClick={() => setFilter({ kind: 'all' })}>全部 {day?.total ?? 0}</Chip>
          {topics.map((t) => {
            const n = (day?.topics || {})[t.id]?.length || 0
            return <Chip key={t.id} active={filter.kind === 'topic' && filter.topicId === t.id}
              onClick={() => setFilter({ kind: 'topic', topicId: t.id })}>{t.name} {n}</Chip>
          })}
          <Chip active={filter.kind === 'code'} onClick={() => setFilter({ kind: filter.kind === 'code' ? 'all' : 'code' })}>代码可用 {codeCount}</Chip>
          <Chip active={filter.kind === 'saved'} onClick={() => setFilter({ kind: filter.kind === 'saved' ? 'all' : 'saved' })}>已收藏 {savedCount}</Chip>
          <Chip active={filter.kind === 'repos'} onClick={() => setFilter({ kind: filter.kind === 'repos' ? 'all' : 'repos' })}>开源项目 {reposCount}</Chip>
        </div>
      )}

      {/* 检索模式 */}
      {searchActive && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '6px 0 12px' }}>
            {searching ? '检索中…' : `命中 ${searchResult?.length ?? 0} 条（历史评审全量库，含未入选条目） · 英文按词 / 中文按连续子串匹配`}
          </div>
          {searching && (searchResult === null || searchResult.length === 0) ? (
            <div style={emptyStyle}>检索中…</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(searchResult || []).map((p) => renderCard(p, true))}
            </div>
          )}
        </div>
      )}

      {/* 日历流 */}
      {!searchActive && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, borderBottom: '1px solid var(--border)', paddingBottom: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--fg-strong)' }}>
              {isToday ? '今天' : fmtDate(viewing)} · {day?.total ?? 0} 篇论文
              {reposCount > 0 && ` + ${reposCount} 个开源项目`}
            </span>
            {day?.usage && (
              <span style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginLeft: 'auto' }}>
                评审 {day.usage.reviewed} 篇 · {fmtTokens((day.usage.token_in || 0) + (day.usage.token_out || 0))} tokens · 已滤 cross-list
              </span>
            )}
          </div>

          {!hasContent ? renderEmpty() : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {groups.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {groups.map(([tid, papers]) => (
                    <div key={tid}>
                      {groups.length > 1 && (
                        <div style={{
                          display: 'flex', alignItems: 'center', padding: '6px 10px', marginBottom: 10,
                          borderRadius: 6, background: 'var(--bg-side)', border: '1px solid var(--border)', fontSize: 12,
                        }}>
                          <strong style={{ color: 'var(--fg-strong)' }}>{topicName(tid)} · {papers.length} 篇</strong>
                          <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)' }}>按评审分排序</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {papers.map((p) => renderCard(p, groups.length > 1))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {reposShown.length > 0 && (
                <div>
                  <div style={{
                    display: 'flex', alignItems: 'center', padding: '6px 10px', marginBottom: 10,
                    borderRadius: 6, background: 'var(--bg-side)', border: '1px solid var(--border)', fontSize: 12,
                  }}>
                    <strong style={{ color: 'var(--fg-strong)' }}>开源项目 · {reposShown.length} 个</strong>
                    <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-muted)' }}>按 Star 增速排序 · 独立发现</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {reposShown.map((r) => renderRepoCard(r))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', right: 24, bottom: 24, zIndex: 50,
          display: 'flex', alignItems: 'center', gap: 10,
          background: toast.kind === 'err' ? '#7f1d1d' : '#101828', color: '#fff',
          borderRadius: 8, padding: '9px 14px', fontSize: 12,
          boxShadow: '0 8px 24px rgba(15,23,42,.35)', maxWidth: 420,
        }}>
          <span>{toast.kind === 'err' ? '✕' : '✓'}</span>
          <span style={{ flex: 1 }}>{toast.text}</span>
          {toast.undo && (
            <span style={{ color: '#A5B4FC', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
              onClick={() => { toast.undo?.(); setToast(null) }}>撤销</span>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

const btnGhost: React.CSSProperties = {
  fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 6,
}

const chevBtn: React.CSSProperties = {
  fontSize: 13, padding: '2px 8px', border: 'none', background: 'transparent', lineHeight: 1.4,
}

const emptyStyle: React.CSSProperties = {
  padding: '56px 24px', textAlign: 'center', color: 'var(--fg-muted)',
  fontSize: 13, lineHeight: 2,
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button className="btn-ghost" onClick={onClick} style={{
      borderRadius: 12, padding: '3px 12px', fontSize: 11,
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      background: active ? 'var(--bg-active)' : 'transparent',
      color: active ? 'var(--fg-strong)' : 'var(--fg-muted)',
    }}>{children}</button>
  )
}

function MenuItem({ onClick, danger, children }: {
  onClick: () => void; danger?: boolean; children: React.ReactNode
}) {
  return (
    <div onClick={onClick} style={{
      padding: '7px 14px', fontSize: 12, cursor: 'pointer',
      color: danger ? '#D92D20' : 'var(--fg)',
    }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-side)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
      {children}
    </div>
  )
}

function RadarPulseIcon() {
  return (
    <svg width="40" height="40" viewBox="-20 -20 40 40">
      <circle r="17" fill="none" stroke="var(--border)" strokeWidth="1.5" />
      <circle r="10" fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.5" />
      <circle r="3.5" fill="var(--accent)" />
    </svg>
  )
}
