/**
 * Paper-Code Radar 情报雷达看板
 *
 * 多主题 arXiv 分类订阅 + 论文配套代码活性审计 + LLM 结构化评审。
 * 三个标签页：今日情报（分 Topic 卡片流）/ 检索（FTS5 + 多维筛选）/ 配置（Topic 编辑 + YAML 导入导出）。
 * 需求来源：docs/radar_srs.md；无外部推送，产出为站内看板 + 每日 Markdown 归档。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  api,
  type RadarPaper, type RadarTopic, type RadarDayResponse, type RadarSearchResponse,
} from '../api/client'
import { useStore } from '../stores/useStore'
import CategoryPicker from './CategoryPicker'

type Tab = 'today' | 'search' | 'config'

const CODE_BADGE: Record<RadarPaper['code_status'], { text: string; color: string; bg: string; title: string }> = {
  code_available: { text: '✓ 代码可用', color: '#166534', bg: 'rgba(34,197,94,.15)', title: '仓库真实存在且非空' },
  placeholder: { text: '⚠ 占位仓库', color: '#92400e', bg: 'rgba(245,158,11,.15)', title: '链接存在但仓库为空或已失效' },
  no_code: { text: '无代码', color: 'var(--fg-muted)', bg: 'var(--bg-side)', title: '摘要与评论中未发现开源代码' },
}

function stars(score: number | null): string {
  const n = Math.max(0, Math.min(5, Math.round(score || 0)))
  return '⭐'.repeat(n) || '—'
}

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : ''
}

export default function RadarView() {
  const [tab, setTab] = useState<Tab>('today')
  const refreshLibrary = useStore((s) => s.refreshLibrary)

  // ---- 今日情报 ----
  const [day, setDay] = useState<RadarDayResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [topicFilter, setTopicFilter] = useState<string>('all')
  const [importing, setImporting] = useState<Record<string, boolean>>({})

  // ---- 检索 ----
  const [q, setQ] = useState('')
  const [searchTopic, setSearchTopic] = useState('')
  const [searchCode, setSearchCode] = useState('')
  const [searchScore, setSearchScore] = useState('')
  const [searchFrom, setSearchFrom] = useState('')
  const [searchTo, setSearchTo] = useState('')
  const [searchResult, setSearchResult] = useState<RadarSearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchedOnce, setSearchedOnce] = useState(false)

  // ---- 配置 ----
  const [topics, setTopics] = useState<RadarTopic[]>([])
  const [schedulerEnabled, setSchedulerEnabled] = useState(true)
  const [yamlText, setYamlText] = useState('')
  const [showYaml, setShowYaml] = useState(false)
  const [configMsg, setConfigMsg] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null) // 展开编辑的 topic id

  // ---- 归档回溯：日期框直接绑定 day.date（正在查看的日期），空值时原生 date 控件只会显示 yyyy/mm/dd 占位符 ----

  const loadToday = async (date?: string) => {
    setLoading(true)
    try {
      const res = date ? await api.radarArchive(date) : await api.radarToday()
      setDay(res)
    } catch (e) {
      setDay({ date: '', topics: {}, total: 0 })
      alert(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }

  const loadConfig = async () => {
    try {
      const cfg = await api.radarGetConfig()
      setTopics(cfg.topics)
      setSchedulerEnabled(cfg.scheduler_enabled)
    } catch {
      /* 配置加载失败不打断看板 */
    }
  }

  useEffect(() => {
    void loadToday()
    void loadConfig()
  }, [])

  const topicName = (id: string) => topics.find((t) => t.id === id)?.name || id

  const handleRefresh = async () => {
    if (refreshing) return
    const ok = confirm(
      '将立即执行一轮完整管道：抓取 arXiv → 代码审计 → LLM 评审。\n' +
      '涉及 LLM 调用，耗时可能 1-3 分钟，且消耗少量 token。继续？'
    )
    if (!ok) return
    setRefreshing(true)
    try {
      const res = await api.radarRefresh()
      const parts = Object.values(res.topics || {})
        .map((s) => `${s.name}: 初筛${s.stage1}/评审${s.reviewed}/入选${s.shown}${s.failed ? `/失败${s.failed}` : ''}`)
      alert(`管道完成${res.cached ? '（今日已有缓存）' : ''}\n${parts.join('\n') || res.message || ''}`)
      await loadToday()
    } catch (e) {
      alert(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setRefreshing(false)
    }
  }

  const handleImport = async (p: RadarPaper) => {
    setImporting((m) => ({ ...m, [p.id]: true }))
    try {
      await api.radarImportPaper(p.id)
      await refreshLibrary()
      alert(`已导入：${p.title}`)
    } catch (e) {
      alert(`导入失败: ${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setImporting((m) => ({ ...m, [p.id]: false }))
    }
  }

  const handleIgnore = async (p: RadarPaper) => {
    if (!confirm('忽略后将永不再次推荐该论文，确认？')) return
    try {
      await api.radarActOnPaper(p.id, 'ignore')
      // 同一论文可能命中多个 Topic（后端按 (id, topic_id) 多行存储），
      // ignore 会让所有分组里的该论文一起消失，total 需按实际移除数递减
      setDay((cur) => {
        if (!cur) return cur
        const next: Record<string, RadarPaper[]> = {}
        let removed = 0
        for (const [tid, arr] of Object.entries(cur.topics)) {
          next[tid] = arr.filter((x) => {
            if (x.id === p.id) { removed++; return false }
            return true
          })
        }
        return { ...cur, topics: next, total: Math.max(0, cur.total - removed) }
      })
    } catch (e) {
      alert(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const handleBibtex = async (p: RadarPaper) => {
    try {
      const text = await api.radarBibtex(p.id)
      await navigator.clipboard.writeText(text)
      alert('BibTeX 已复制到剪贴板')
    } catch (e) {
      alert(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const doSearch = async () => {
    setSearching(true)
    try {
      const res = await api.radarSearch({
        q: q.trim() || undefined,
        topic_id: searchTopic || undefined,
        code_status: searchCode || undefined,
        min_score: searchScore ? Number(searchScore) : undefined,
        date_from: searchFrom || undefined,
        date_to: searchTo || undefined,
        limit: 100,
      })
      setSearchResult(res)
      setSearchedOnce(true)
    } catch (e) {
      alert(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setSearching(false)
    }
  }

  const saveTopics = async (next: RadarTopic[], enabled?: boolean) => {
    setConfigMsg('保存中…')
    try {
      const res = await api.radarSaveConfig({ topics: next, scheduler_enabled: enabled })
      setTopics(res.topics)
      setSchedulerEnabled(res.scheduler_enabled)
      setConfigMsg(`已保存 ${res.topics.length} 个 Topic`)
    } catch (e) {
      setConfigMsg(`保存失败: ${String(e).replace(/^Error:\s*/, '')}`)
    }
  }

  const updateTopic = (idx: number, patch: Partial<RadarTopic>) => {
    setTopics((cur) => cur.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }

  const addTopic = () => {
    const id = `topic_${Date.now().toString(36)}`
    setTopics((cur) => [...cur, {
      id, name: '新主题', categories: [], keywords: [],
      evaluation_focus: '', min_score_to_show: 4,
    }])
    setExpanded(id)
  }

  const removeTopic = (idx: number) => {
    if (!confirm('删除该 Topic？历史归档数据将保留。')) return
    setTopics((cur) => cur.filter((_, i) => i !== idx))
  }

  const doYamlImport = async () => {
    if (!yamlText.trim()) return
    try {
      const res = await api.radarImportYaml(yamlText)
      setTopics(res.topics)
      setConfigMsg(`导入完成：成功 ${res.imported} 条，拒绝 ${res.rejected} 条（共 ${res.total} 条）`)
      setShowYaml(false)
      setYamlText('')
    } catch (e) {
      setConfigMsg(`导入失败: ${String(e).replace(/^Error:\s*/, '')}`)
    }
  }

  const doYamlExport = async () => {
    try {
      const text = await api.radarExportYaml()
      setYamlText(text)
      setShowYaml(true)
      setConfigMsg('已生成导出 YAML，可复制保存')
    } catch (e) {
      setConfigMsg(`导出失败: ${String(e).replace(/^Error:\s*/, '')}`)
    }
  }

  // 今日卡片：按 topic 过滤
  const todayGroups = useMemo(() => {
    const entries = Object.entries(day?.topics || {})
    return topicFilter === 'all' ? entries : entries.filter(([tid]) => tid === topicFilter)
  }, [day, topicFilter])

  const todayTotal = todayGroups.reduce((n, [, arr]) => n + arr.length, 0)

  const cardStyle: React.CSSProperties = {
    padding: 14,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-side)',
  }

  const renderPaperCard = (p: RadarPaper, showTopic = false) => {
    const badge = CODE_BADGE[p.code_status] || CODE_BADGE.no_code
    const rv = p.review || {}
    const isImporting = !!importing[p.id]
    const absUrl = `https://arxiv.org/abs/${p.id.replace('arxiv:', '')}`
    return (
      <div key={`${p.topic_id}:${p.id}`} style={cardStyle}>
        {/* 头部：分数 + 主题 + 代码状态 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6, fontSize: 11 }}>
          <span title={`评审分 ${p.score ?? '—'}/5`}>{stars(p.score)}</span>
          {showTopic && (
            <span style={{
              background: 'var(--bg-active)', borderRadius: 10, padding: '1px 8px',
              color: 'var(--fg-strong)',
            }}>{topicName(p.topic_id)}</span>
          )}
          {rv.primary_tag && (
            <span style={{ color: 'var(--fg-muted)' }}>#{rv.primary_tag}</span>
          )}
          <span
            style={{ marginLeft: 'auto', color: badge.color, background: badge.bg, borderRadius: 10, padding: '1px 8px' }}
            title={badge.title}
          >
            {p.code_status === 'code_available' && p.repo_stars > 0
              ? `${badge.text} 🌟${p.repo_stars}` : badge.text}
          </span>
        </div>

        {/* 标题 */}
        <a href={absUrl} target="_blank" rel="noreferrer"
          style={{ color: 'var(--fg-strong)', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
          {p.title}
        </a>

        {/* 中文评审要点 */}
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7, color: 'var(--fg)' }}>
          {rv.one_sentence_summary && <div><b>一句话：</b>{rv.one_sentence_summary}</div>}
          {rv.problem_solved && <div style={{ color: 'var(--fg-muted)' }}><b>痛点：</b>{rv.problem_solved}</div>}
          {rv.core_innovation && <div><b>方法：</b>{rv.core_innovation}</div>}
          {rv.practical_value && <div style={{ color: 'var(--fg-muted)' }}><b>价值：</b>{rv.practical_value}</div>}
          {p.review_status === 'review_failed' && (
            <div style={{ color: '#b91c1c' }}>评审失败（LLM 未返回有效结果）</div>
          )}
        </div>

        {/* 底部信息与操作 */}
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--fg-muted)' }}>
          <span>{(p.authors || []).slice(0, 3).join(', ')}{(p.authors || []).length > 3 ? ' 等' : ''}</span>
          <span>{fmtDate(p.published)}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {p.repo_url && (
              <a className="btn-ghost" href={p.repo_url} target="_blank" rel="noreferrer"
                style={{ fontSize: 11, padding: '3px 8px', textDecoration: 'none', border: '1px solid var(--border)' }}>
                ⧉ 代码
              </a>
            )}
            <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)' }}
              onClick={() => void handleBibtex(p)} title="复制 BibTeX">
              📚 BibTeX
            </button>
            <button className="btn-primary" style={{ fontSize: 11, padding: '3px 8px' }}
              disabled={isImporting} onClick={() => void handleImport(p)}>
              {isImporting ? '导入中…' : '📥 导入阅读器'}
            </button>
            <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)' }}
              onClick={() => void handleIgnore(p)} title="永不再次推荐">
              ✕
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      flex: 1, height: '100%', overflowY: 'auto',
      background: 'var(--bg)', color: 'var(--fg)', padding: '24px 32px 60px',
    }}>
      {/* 顶部：标题 + 标签页 + 刷新 */}
      <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 14, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--fg-strong)' }}>
            🛰 Paper-Code Radar
          </h2>
          <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
            {([['today', '今日情报'], ['search', '检索'], ['config', '配置']] as Array<[Tab, string]>).map(([k, label]) => (
              <button key={k} className="btn-ghost"
                style={{
                  fontSize: 12, padding: '5px 12px',
                  border: `1px solid ${tab === k ? 'var(--accent)' : 'var(--border)'}`,
                  background: tab === k ? 'var(--bg-active)' : 'transparent',
                  color: tab === k ? 'var(--fg-strong)' : 'var(--fg-muted)',
                }}
                onClick={() => {
                  setTab(k)
                  if (k === 'config') void loadConfig()
                }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {tab === 'today' && (
              <input type="date" value={day?.date || ''}
                onChange={(e) => {
                  const d = e.target.value
                  if (d) void loadToday(d)
                }}
                max={new Date().toISOString().slice(0, 10)}
                style={{ fontSize: 11, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--fg)' }}
                title="查看所选日期的情报（回溯往期）" />
            )}
            {tab === 'today' && (
              <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 12px', border: '1px solid var(--border)' }}
                disabled={refreshing || loading} onClick={() => void handleRefresh()}>
                {refreshing ? '管道运行中…' : '⚡ 运行管道'}
              </button>
            )}
          </div>
        </div>
        {tab === 'today' && (
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>
            每天 08:00 自动运行 · arXiv 24h 分类订阅 · LLM 评审降噪 · 每日归档至 ~/paper-reader/radar/
            {day?.date ? ` · 当前：${day.date}` : ''}
          </div>
        )}
      </div>

      {/* ============ 今日情报 ============ */}
      {tab === 'today' && (
        <>
          {/* Topic 过滤条 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, fontSize: 12 }}>
            <button className="btn-ghost"
              style={{
                borderRadius: 12, padding: '3px 12px', fontSize: 11,
                border: `1px solid ${topicFilter === 'all' ? 'var(--accent)' : 'var(--border)'}`,
                background: topicFilter === 'all' ? 'var(--bg-active)' : 'transparent',
              }}
              onClick={() => setTopicFilter('all')}>
              全部 ({day?.total ?? 0})
            </button>
            {topics.map((t) => {
              const n = (day?.topics || {})[t.id]?.length || 0
              return (
                <button key={t.id} className="btn-ghost"
                  style={{
                    borderRadius: 12, padding: '3px 12px', fontSize: 11,
                    border: `1px solid ${topicFilter === t.id ? 'var(--accent)' : 'var(--border)'}`,
                    background: topicFilter === t.id ? 'var(--bg-active)' : 'transparent',
                  }}
                  onClick={() => setTopicFilter(t.id)}>
                  {t.name} ({n})
                </button>
              )
            })}
          </div>

          {loading && !day && (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--fg-muted)' }}>
              正在加载情报…
            </div>
          )}

          {!loading && todayTotal === 0 && (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
              {topics.length === 0
                ? '尚未配置任何 Topic，请先到「配置」页添加研究主题'
                : (day?.total ?? 0) === 0
                  ? '今日暂无入选论文。点「⚡ 运行管道」立即抓取，或等待每日 08:00 自动运行。'
                  : '该筛选条件下暂无入选论文'}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {todayGroups.map(([tid, papers]) => (
              <div key={tid}>
                <div style={{
                  display: 'flex', alignItems: 'center', padding: '7px 12px', marginBottom: 10,
                  borderRadius: 6, background: 'var(--bg-side)', border: '1px solid var(--border)',
                }}>
                  <strong style={{ fontSize: 13, color: 'var(--fg-strong)' }}>
                    {topicName(tid)} · {papers.length} 篇
                  </strong>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-muted)' }}>按评审分排序</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {papers.map((p) => renderPaperCard(p, todayGroups.length > 1))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ============ 检索 ============ */}
      {tab === 'search' && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doSearch() }}
              placeholder="关键词检索（标题/摘要/中文分析，空格分隔多词为 AND）"
              style={{ flex: '1 1 320px', fontSize: 13, padding: '7px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', outline: 'none' }}
            />
            <select value={searchTopic} onChange={(e) => setSearchTopic(e.target.value)}
              style={{ fontSize: 12, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--fg)' }}>
              <option value="">全部 Topic</option>
              {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select value={searchCode} onChange={(e) => setSearchCode(e.target.value)}
              style={{ fontSize: 12, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--fg)' }}>
              <option value="">代码状态不限</option>
              <option value="code_available">有可用代码</option>
              <option value="placeholder">占位仓库</option>
              <option value="no_code">无代码</option>
            </select>
            <select value={searchScore} onChange={(e) => setSearchScore(e.target.value)}
              style={{ fontSize: 12, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--fg)' }}>
              <option value="">分数不限</option>
              {[5, 4, 3].map((n) => <option key={n} value={n}>≥ {n} 分</option>)}
            </select>
            <input type="date" value={searchFrom} onChange={(e) => setSearchFrom(e.target.value)} title="起始日期"
              style={{ fontSize: 11, padding: '5px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--fg)' }} />
            <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>→</span>
            <input type="date" value={searchTo} onChange={(e) => setSearchTo(e.target.value)} title="截止日期"
              style={{ fontSize: 11, padding: '5px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--fg)' }} />
            <button className="btn-primary" style={{ fontSize: 12, padding: '7px 16px' }}
              disabled={searching} onClick={() => void doSearch()}>
              {searching ? '检索中…' : '🔍 检索'}
            </button>
          </div>

          {searchedOnce && searchResult && (
            <>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 10 }}>
                命中 {searchResult.total} 条（历史评审全量库，含未入选条目；语义向量检索为二期）
              </div>
              {searchResult.total === 0 ? (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
                  未命中。注意中文检索按连续子串匹配，可尝试换更短的关键词。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {searchResult.items.map((p) => renderPaperCard(p, true))}
                </div>
              )}
            </>
          )}
          {!searchedOnce && (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
              输入关键词或组合筛选器，检索全部历史评审记录
            </div>
          )}
        </>
      )}

      {/* ============ 配置 ============ */}
      {tab === 'config' && (
        <div style={{ maxWidth: 860 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14, color: 'var(--fg-strong)' }}>监控主题（{topics.length}）</strong>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--fg-muted)' }}>
              <input type="checkbox" checked={schedulerEnabled}
                onChange={(e) => void saveTopics(topics, e.target.checked)} />
              每天 08:00 自动运行管道
            </label>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 12px', border: '1px solid var(--border)' }}
                onClick={addTopic}>＋ 新增 Topic</button>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 12px', border: '1px solid var(--border)' }}
                onClick={() => void doYamlExport()}>导出 YAML</button>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 12px', border: '1px solid var(--border)' }}
                onClick={() => { setShowYaml(true); setConfigMsg('粘贴 YAML 后点「解析导入」') }}>导入 YAML</button>
              <button className="btn-primary" style={{ fontSize: 12, padding: '5px 14px' }}
                onClick={() => void saveTopics(topics)}>保存全部</button>
            </div>
          </div>

          {configMsg && (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 10 }}>{configMsg}</div>
          )}

          {topics.length === 0 && (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13, border: '1px dashed var(--border)', borderRadius: 8 }}>
              暂无 Topic。点击「＋ 新增 Topic」或「导入 YAML」开始配置研究方向。
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topics.map((t, idx) => {
              const isOpen = expanded === t.id
              return (
                <div key={t.id} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-side)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-strong)' }}>
                        {t.name || '(未命名)'}
                        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--fg-muted)' }}>
                          {t.id} · 入选阈值 {t.min_score_to_show}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.categories.length > 0 && `分类: ${t.categories.join(', ')}`}
                        {t.categories.length > 0 && t.keywords.length > 0 && ' · '}
                        {t.keywords.length > 0 && `关键词: ${t.keywords.join(', ')}`}
                        {!t.categories.length && !t.keywords.length && '（未配置分类与关键词）'}
                      </div>
                    </div>
                    <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 10px', border: '1px solid var(--border)' }}
                      onClick={() => setExpanded(isOpen ? null : t.id)}>
                      {isOpen ? '收起' : '编辑'}
                    </button>
                    <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)' }}
                      onClick={() => removeTopic(idx)} title="删除（历史数据保留）">✕</button>
                  </div>

                  {isOpen && (
                    <div style={{ padding: '4px 14px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <Field label="名称" hint={HINTS.name}>
                        <input value={t.name} onChange={(e) => updateTopic(idx, { name: e.target.value })}
                          style={inputStyle} />
                      </Field>
                      <Field label="Topic ID" hint={HINTS.id}>
                        <input value={t.id} disabled
                          style={{ ...inputStyle, color: 'var(--fg-muted)', background: 'var(--bg)' }} />
                      </Field>
                      <Field label="arXiv 分类" hint={HINTS.categories}>
                        <CategoryPicker value={t.categories}
                          onChange={(categories) => updateTopic(idx, { categories })} />
                      </Field>
                      <Field label="初筛关键词" hint={HINTS.keywords}>
                        <input value={t.keywords.join(', ')}
                          onChange={(e) => updateTopic(idx, { keywords: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })}
                          placeholder="occupancy, SLAM, NPU（逗号分隔）"
                          style={inputStyle} />
                      </Field>
                      <Field label="LLM 评审侧重" hint={HINTS.focus}>
                        <textarea value={t.evaluation_focus} rows={2}
                          onChange={(e) => updateTopic(idx, { evaluation_focus: e.target.value })}
                          placeholder="引导 LLM 的关注维度，如：重点关注实时性、低算力端侧可行性"
                          style={{ ...inputStyle, resize: 'vertical' }} />
                      </Field>
                      <Field label="入选阈值" hint={HINTS.threshold}>
                        <select value={t.min_score_to_show}
                          onChange={(e) => updateTopic(idx, { min_score_to_show: Number(e.target.value) })}
                          style={{ ...inputStyle, width: 120 }}>
                          {[3, 4, 5].map((n) => <option key={n} value={n}>{n} 分及以上</option>)}
                        </select>
                      </Field>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* YAML 导入/导出区 */}
          {showYaml && (
            <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 8 }}>
                YAML 格式（与导出格式一致）。导入时逐条校验：非法条目拒绝，合法条目按 id 合并更新。
              </div>
              <textarea value={yamlText} rows={12}
                onChange={(e) => setYamlText(e.target.value)}
                placeholder={'topics:\n  - id: "embodied_perception"\n    name: "具身智能与机器人空间感知"\n    categories: ["cs.RO", "cs.CV"]\n    keywords: ["occupancy", "SLAM"]\n    evaluation_focus: "重点关注实时性与端侧可行性"\n    min_score_to_show: 4'}
                style={{ width: '100%', fontSize: 12, fontFamily: 'monospace', padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', outline: 'none' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn-primary" style={{ fontSize: 12, padding: '5px 14px' }}
                  onClick={() => void doYamlImport()}>解析导入</button>
                <button className="btn-ghost" style={{ fontSize: 12, padding: '5px 12px', border: '1px solid var(--border)' }}
                  onClick={() => setShowYaml(false)}>取消</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  fontSize: 12, padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', outline: 'none',
}

const fieldStyle: React.CSSProperties = {
  fontSize: 12, display: 'grid', gridTemplateColumns: '90px 1fr',
  gap: '4px 8px', alignItems: 'center',
}

// 字段说明：写在表单里而不是靠用户记忆，placeholder 只在输入前可见，不够
const HINTS = {
  name: '显示在看板分组与筛选项上的名字，随意起',
  id: '内部标识，小写字母数字下划线；创建后不可改（历史归档靠它关联）',
  categories: '决定每天从 arXiv 抓哪些分类的论文；留空则这个 Topic 抓不到任何论文',
  keywords: '省钱开关：论文标题/摘要命中任一关键词才送 LLM 评审；留空则该分类全部论文都送审（耗 token）',
  focus: '告诉 LLM 评审时侧重看什么，影响打分与评语；留空则按通用标准评审',
  threshold: '评审分达到该值才出现在「今日情报」；带可用代码的论文阈值可放宽 1 分',
} as const

function Field({ label, title, hint, children }: {
  label: string; title?: string; hint: string; children: React.ReactNode
}) {
  return (
    <label style={fieldStyle}>
      <span style={{ color: 'var(--fg-muted)' }} title={title}>{label}</span>
      {children}
      <span style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{hint}</span>
    </label>
  )
}
