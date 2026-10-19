/**
 * arXiv 检索与下载导入面板。
 *
 * 两种模式：
 *   - 关键词：按标题/作者/摘要/全文搜索
 *   - DOI   ：先查 Crossref 元数据，再匹配 arXiv 版本
 *
 * 点击结果可一键下载 PDF 并导入文献库（自动去重）。
 */
import { useState } from 'react'
import { api, type ArxivItem } from '../api/client'
import { useStore } from '../stores/useStore'

type Mode = 'keyword' | 'doi'

export default function ArxivPanel({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('keyword')
  const [query, setQuery] = useState('')
  const [field, setField] = useState('ti')
  const [doi, setDoi] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ArxivItem[]>([])
  const [doiMeta, setDoiMeta] = useState<{ title: string; year: number | null; authors: string[] } | null>(null)
  const [doiScore, setDoiScore] = useState<number | null>(null)

  const [importing, setImporting] = useState<string | null>(null)
  const [imported, setImported] = useState<Record<string, string>>({})

  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const activeFolder = useStore((s) => s.activeFolder)

  const search = async () => {
    const q = (mode === 'doi' ? doi : query).trim()
    if (!q) { setError('请输入内容'); return }

    setLoading(true); setError(null); setResults([]); setDoiMeta(null); setDoiScore(null)
    try {
      if (mode === 'keyword') {
        const r = await api.arxivSearch(q, field, 15)
        setResults(r.results)
        if (!r.results.length) setError('未找到结果，试试换个关键词或搜索范围')
      } else {
        const r = await api.arxivByDoi(q)
        if (r.meta) {
          setDoiMeta({ title: r.meta.title, year: r.meta.year, authors: r.meta.authors })
        }
        setDoiScore(r.score)
        setResults(r.matched ? [r.matched] : r.candidates.slice(0, 8))
        if (!r.matched) {
          setError(`未找到与 DOI 高度匹配的 arXiv 版本（最高相似度 ${Math.round(r.score * 100)}%），以下为候选`)
        }
      }
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }

  const doImport = async (item: ArxivItem) => {
    setImporting(item.arxiv_id)
    setError(null)
    try {
      const r = await api.arxivImport(item.arxiv_id, {
        title: item.title,
        authors: item.authors,
        folderId: activeFolder ?? undefined,
      })
      setImported((m) => ({
        ...m,
        [item.arxiv_id]: r.duplicated ? '已在库中' : '已导入',
      }))
      await refreshLibrary()
      await refreshSidebar()
    } catch (e) {
      setError(`导入失败：${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setImporting(null)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720, maxHeight: '86vh', display: 'flex', flexDirection: 'column',
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 12, overflow: 'hidden',
        }}
      >
        {/* 头部 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
          borderBottom: '1px solid var(--border)', background: 'var(--bg-side)',
        }}>
          <strong style={{ fontSize: 14 }}>从 arXiv 添加</strong>

          <div style={{ display: 'flex', gap: 2, marginLeft: 10 }}>
            {([['keyword', '关键词搜索'], ['doi', '按 DOI']] as Array<[Mode, string]>).map(([m, label]) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(null); setResults([]) }}
                style={{
                  fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                  border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--border)'}`,
                  background: mode === m ? 'var(--accent)' : 'transparent',
                  color: mode === m ? '#fff' : 'var(--fg)',
                  borderRadius: 4,
                }}
              >{label}</button>
            ))}
          </div>

          <button className="btn-ghost" style={{ marginLeft: 'auto', fontSize: 12 }} onClick={onClose}>关闭</button>
        </div>

        {/* 搜索框 */}
        <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
          {mode === 'keyword' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                value={field}
                onChange={(e) => setField(e.target.value)}
                style={{ fontSize: 12, padding: '0 6px' }}
              >
                <option value="ti">标题</option>
                <option value="all">全文</option>
                <option value="au">作者</option>
                <option value="abs">摘要</option>
              </select>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
                placeholder="输入论文标题或关键词，回车搜索"
                style={{ flex: 1, fontSize: 13, padding: '7px 10px' }}
              />
              <button className="btn-primary" disabled={loading} onClick={() => void search()}>
                {loading ? '搜索中…' : '搜索'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={doi}
                  onChange={(e) => setDoi(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
                  placeholder="输入 DOI，如 10.1109/ICCV.2017.89"
                  style={{ flex: 1, fontSize: 13, padding: '7px 10px' }}
                />
                <button className="btn-primary" disabled={loading} onClick={() => void search()}>
                  {loading ? '查询中…' : '查找 arXiv 版本'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                先用 Crossref 获取标题，再匹配 arXiv 版本
              </div>
            </div>
          )}

          {doiMeta && (
            <div style={{
              marginTop: 10, padding: '7px 10px', borderRadius: 6,
              background: 'var(--bg-side)', fontSize: 11, lineHeight: 1.6,
            }}>
              <div><strong>Crossref：</strong>{doiMeta.title}</div>
              <div style={{ color: 'var(--fg-muted)' }}>
                {doiMeta.authors.slice(0, 4).join(', ')}{doiMeta.year ? ` · ${doiMeta.year}` : ''}
                {doiScore !== null && ` · 匹配度 ${Math.round(doiScore * 100)}%`}
              </div>
            </div>
          )}

          {error && (
            <div style={{
              marginTop: 10, fontSize: 11, color: '#b91c1c',
              background: '#ef44441a', padding: '6px 9px', borderRadius: 6, lineHeight: 1.5,
            }}>{error}</div>
          )}
        </div>

        {/* 结果列表 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 120 }}>
          {loading && (
            <div className="hint" style={{ padding: 20, textAlign: 'center' }}>
              查询中，arXiv 首次访问可能较慢（10-15 秒）…
            </div>
          )}
          {!loading && results.length === 0 && !error && (
            <div className="hint" style={{ padding: 20, textAlign: 'center', lineHeight: 1.8 }}>
              输入关键词或 DOI 开始查找。<br />
              找到后可直接下载 PDF 并导入文献库。
            </div>
          )}

          {results.map((r) => {
            const state = imported[r.arxiv_id]
            return (
              <div key={r.arxiv_id} style={{
                padding: '10px 12px', marginBottom: 8, borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg-card)',
              }}>
                <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.5, marginBottom: 4 }}>
                  {r.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>
                  {r.authors.slice(0, 5).join(', ')}
                  {r.authors.length > 5 ? ' 等' : ''}
                  {r.published && ` · ${r.published}`}
                  {r.categories.length > 0 && ` · ${r.categories.join(', ')}`}
                </div>
                {r.summary && (
                  <div style={{
                    fontSize: 11, color: 'var(--fg)', lineHeight: 1.55,
                    marginBottom: 8, maxHeight: 48, overflow: 'hidden',
                  }}>
                    {r.summary.slice(0, 240)}{r.summary.length > 240 ? '…' : ''}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>arXiv:{r.arxiv_id}</span>
                  <a
                    href={r.abs_url} target="_blank" rel="noreferrer"
                    style={{ fontSize: 11, color: 'var(--accent)' }}
                  >原文页</a>
                  <button
                    className="btn-primary"
                    style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 12px' }}
                    disabled={importing === r.arxiv_id || !!state}
                    onClick={() => void doImport(r)}
                  >
                    {importing === r.arxiv_id ? '下载中…' : (state ?? '下载并导入')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
