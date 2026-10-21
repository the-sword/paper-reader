/**
 * 每日研究情报看板 (Daily Intelligence Dashboard)
 *
 * 聚合 arXiv 前沿论文与 GitHub 高增速开源代码，支持：
 *   - 关注主题关键词管理 (Chips 增删)
 *   - 一键导入本地文献库并触发双语排版队列
 *   - 忽略/拉黑条目 (永久防重)
 *   - 往期历史回溯与手动刷新
 */
import { useEffect, useState } from 'react'
import { api, type DigestItem, type DigestResponse } from '../api/client'
import { useStore } from '../stores/useStore'

export default function DailyDigestView() {
  const [data, setData] = useState<DigestResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 关注主题
  const [topics, setTopics] = useState<string[]>([])
  const [addingTopic, setAddingTopic] = useState(false)
  const [newTopicVal, setNewTopicVal] = useState('')

  // 正在导入的条目 ID
  const [importingMap, setImportingMap] = useState<Record<string, boolean>>({})
  // 乐观移除的已忽略条目集合
  const [ignoredIds, setIgnoredIds] = useState<Set<string>>(new Set())

  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const openDocument = useStore((s) => s.openDocument)

  // 1. 加载今日数据与主题配置
  const loadToday = async () => {
    setLoading(true)
    setError(null)
    try {
      const [res, cfg] = await Promise.all([api.getTodayDigest(), api.getDigestConfig()])
      setData(res)
      setTopics(cfg.topics)
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadToday()
  }, [])

  // 2. 手动强制刷新
  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    setError(null)
    try {
      const res = await api.refreshDigest()
      setData(res)
      setIgnoredIds(new Set())
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setRefreshing(false)
    }
  }

  // 3. 移除主题
  const handleRemoveTopic = async (topic: string) => {
    const next = topics.filter((t) => t !== topic)
    setTopics(next)
    try {
      await api.updateDigestConfig({ topics: next })
    } catch {
      /* 忽略 */
    }
  }

  // 4. 添加新主题
  const handleAddTopic = async () => {
    const t = newTopicVal.trim()
    if (!t) {
      setAddingTopic(false)
      return
    }
    if (topics.includes(t)) {
      setNewTopicVal('')
      setAddingTopic(false)
      return
    }
    const next = [...topics, t]
    setTopics(next)
    setNewTopicVal('')
    setAddingTopic(false)
    try {
      await api.updateDigestConfig({ topics: next })
    } catch {
      /* 忽略 */
    }
  }

  // 5. 忽略条目
  const handleIgnore = async (item: DigestItem) => {
    setIgnoredIds((prev) => new Set(prev).add(item.id))
    try {
      await api.actOnDigestItem(item.id, 'ignore')
    } catch {
      /* 忽略失败不打断界面 */
    }
  }

  // 6. 导入 arXiv 论文并触发排版
  const handleImport = async (item: DigestItem) => {
    setImportingMap((m) => ({ ...m, [item.id]: true }))
    try {
      const res = await api.importDigestPaper(item.id)
      await refreshLibrary()
      // 更新该卡片状态
      setData((cur) => {
        if (!cur) return cur
        return {
          ...cur,
          items: cur.items.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: 'imported',
                  meta: { ...it.meta, already_in_library: true, imported_doc_id: res.document?.id },
                }
              : it,
          ),
        }
      })
    } catch (e) {
      alert(`导入文献失败: ${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setImportingMap((m) => ({ ...m, [item.id]: false }))
    }
  }

  const items = (data?.items || []).filter((it) => !ignoredIds.has(it.id))
  const arxivItems = items.filter((it) => it.source === 'arxiv')
  const githubItems = items.filter((it) => it.source === 'github')

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        overflowY: 'auto',
        background: 'var(--bg)',
        color: 'var(--fg)',
        padding: '24px 32px 60px',
      }}
    >
      {/* 顶部标题与监控主题看板 */}
      <div
        style={{
          borderBottom: '1px solid var(--border)',
          paddingBottom: 16,
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--fg-strong)' }}>
              📡 每日研究情报
            </h2>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
              每天 08:00 自动抓取 · 严密防重与 180 天轻量自洁 · 当前归档：{data?.date || '加载中…'}
            </div>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn-ghost"
              style={{ fontSize: 12, padding: '5px 12px', border: '1px solid var(--border)' }}
              disabled={refreshing || loading}
              onClick={() => void handleRefresh()}
            >
              {refreshing ? '正在拉取最新…' : '🔄 立即刷新'}
            </button>
          </div>
        </div>

        {/* 监控关键词 Chips 栏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 14,
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--fg-muted)', fontSize: 11, fontWeight: 600 }}>监控主题:</span>
          {topics.map((t) => (
            <span
              key={t}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: 'var(--bg-side)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: '2px 10px',
                fontSize: 11,
              }}
            >
              <span style={{ color: 'var(--fg-strong)' }}>{t}</span>
              <span
                onClick={() => void handleRemoveTopic(t)}
                style={{ cursor: 'pointer', color: 'var(--fg-muted)', fontSize: 12 }}
                title="移除该主题"
              >
                ✕
              </span>
            </span>
          ))}

          {addingTopic ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input
                type="text"
                value={newTopicVal}
                placeholder="例如: NeRF"
                autoFocus
                onChange={(e) => setNewTopicVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddTopic()
                  if (e.key === 'Escape') setAddingTopic(false)
                }}
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 12,
                  border: '1px solid var(--accent)',
                  outline: 'none',
                  width: 120,
                  background: 'var(--bg)',
                }}
              />
              <button
                className="btn-primary"
                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4 }}
                onClick={() => void handleAddTopic()}
              >
                确定
              </button>
            </div>
          ) : (
            <button
              className="btn-ghost"
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 12,
                border: '1px dashed var(--border)',
                color: 'var(--fg-muted)',
              }}
              onClick={() => setAddingTopic(true)}
            >
              ＋ 添加词
            </button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, borderRadius: 6, background: '#fee2e2', color: '#b91c1c', marginBottom: 16, fontSize: 12 }}>
          {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--fg-muted)' }}>
          正在加载今日精选情报…
        </div>
      )}

      {/* 双列内容流容器 */}
      {data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
            gap: 24,
            alignItems: 'start',
          }}
        >
          {/* 左列：📄 前沿论文精选 (arXiv) */}
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--bg-side)',
                marginBottom: 12,
                border: '1px solid var(--border)',
              }}
            >
              <strong style={{ fontSize: 13, color: 'var(--fg-strong)' }}>
                📄 前沿论文精选 (arXiv · {arxivItems.length} 篇)
              </strong>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-muted)' }}>综合热度排序</span>
            </div>

            {arxivItems.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>
                今日暂无新的候选论文（已过滤已读与忽略项）
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {arxivItems.map((item, idx) => {
                  const authors = item.meta.authors || []
                  const authorStr = authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' 等' : '')
                  const inLib = item.status === 'imported' || item.meta.already_in_library
                  const isImporting = !!importingMap[item.id]

                  return (
                    <div
                      key={item.id}
                      style={{
                        padding: 14,
                        borderRadius: 8,
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                        position: 'relative',
                      }}
                    >
                      {/* 标题 */}
                      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.45, marginBottom: 6 }}>
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--fg-strong)', textDecoration: 'none' }}
                          onMouseOver={(e) => (e.currentTarget.style.color = 'var(--accent)')}
                          onMouseOut={(e) => (e.currentTarget.style.color = 'var(--fg-strong)')}
                        >
                          {idx + 1}. {item.title}
                        </a>
                      </div>

                      {/* 元信息 */}
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                          marginBottom: 8,
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 6,
                        }}
                      >
                        {authorStr && <span>{authorStr}</span>}
                        {item.meta.published && <span>· {item.meta.published.slice(0, 10)}</span>}
                        {item.meta.categories && item.meta.categories.length > 0 && (
                          <span>· [{item.meta.categories.slice(0, 2).join(', ')}]</span>
                        )}
                        {inLib && (
                          <span
                            style={{
                              marginLeft: 'auto',
                              color: '#16a34a',
                              fontWeight: 600,
                              background: '#dcfce7',
                              padding: '1px 6px',
                              borderRadius: 4,
                            }}
                          >
                            ✓ 已在库中
                          </span>
                        )}
                      </div>

                      {/* TL;DR 摘要预览 */}
                      {item.summary && (
                        <div
                          style={{
                            fontSize: 11.5,
                            lineHeight: 1.6,
                            color: 'var(--fg)',
                            marginBottom: 10,
                            display: '-webkit-box',
                            WebkitLineClamp: 3,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {item.summary}
                        </div>
                      )}

                      {/* 操作区 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        {!inLib ? (
                          <button
                            className="btn-primary"
                            style={{ fontSize: 11, padding: '3px 10px' }}
                            disabled={isImporting}
                            onClick={() => void handleImport(item)}
                          >
                            {isImporting ? '导入中…' : '📥 导入阅读器'}
                          </button>
                        ) : item.meta.imported_doc_id ? (
                          <button
                            className="btn-ghost"
                            style={{ fontSize: 11, padding: '3px 10px', color: 'var(--accent)', fontWeight: 600 }}
                            onClick={() => void openDocument(item.meta.imported_doc_id!)}
                          >
                            📖 打开阅读
                          </button>
                        ) : null}

                        <button
                          className="btn-ghost"
                          style={{ fontSize: 11, padding: '3px 8px', color: 'var(--fg-muted)', marginLeft: 'auto' }}
                          onClick={() => void handleIgnore(item)}
                          title="不再对此内容进行推荐"
                        >
                          忽略 ✕
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 右列：💻 热门开源代码 (GitHub) */}
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--bg-side)',
                marginBottom: 12,
                border: '1px solid var(--border)',
              }}
            >
              <strong style={{ fontSize: 13, color: 'var(--fg-strong)' }}>
                💻 热门开源代码 (GitHub · {githubItems.length} 个)
              </strong>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-muted)' }}>Star 增速排行</span>
            </div>

            {githubItems.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>
                今日暂无高活跃新增仓库（已过滤已读与忽略项）
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {githubItems.map((item, idx) => {
                  const stars = item.meta.stars ?? 0
                  const growth = item.meta.star_growth ?? 0
                  const lang = item.meta.language || 'Other'

                  return (
                    <div
                      key={item.id}
                      style={{
                        padding: 14,
                        borderRadius: 8,
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          gap: 8,
                          marginBottom: 4,
                        }}
                      >
                        <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 0 }}>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: '#0969da', textDecoration: 'none', wordBreak: 'break-all' }}
                            onMouseOver={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                            onMouseOut={(e) => (e.currentTarget.style.textDecoration = 'none')}
                          >
                            {idx + 1}. {item.title}
                          </a>
                        </div>

                        {growth > 0 && (
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 10.5,
                              fontWeight: 700,
                              color: '#b45309',
                              background: '#fef3c7',
                              padding: '2px 8px',
                              borderRadius: 10,
                            }}
                          >
                            ⭐ +{growth}/天
                          </span>
                        )}
                      </div>

                      {/* 描述 */}
                      {item.summary && (
                        <div
                          style={{
                            fontSize: 11.5,
                            lineHeight: 1.5,
                            color: 'var(--fg)',
                            margin: '6px 0 10px',
                          }}
                        >
                          {item.summary}
                        </div>
                      )}

                      {/* 底部信息 */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: 10,
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                        }}
                      >
                        <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{lang}</span>
                        <span>⭐ {stars.toLocaleString()}</span>
                        {item.meta.pushed_at && (
                          <span style={{ color: '#059669' }}>
                            提交: {item.meta.pushed_at.slice(0, 10)}
                          </span>
                        )}
                        {item.meta.created_at && (
                          <span>创建: {item.meta.created_at.slice(0, 10)}</span>
                        )}

                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            marginLeft: 'auto',
                            color: '#0969da',
                            fontSize: 11,
                            textDecoration: 'none',
                            fontWeight: 600,
                          }}
                        >
                          打开仓库 ↗
                        </a>

                        <button
                          className="btn-ghost"
                          style={{ fontSize: 11, padding: '2px 6px', color: 'var(--fg-muted)' }}
                          onClick={() => void handleIgnore(item)}
                          title="不再对此仓库进行推荐"
                        >
                          忽略 ✕
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
