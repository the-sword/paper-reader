/**
 * AI 总结面板。
 *
 * 功能：
 *   - 5 种总结类型：概览 / 方法 / 贡献 / 局限 / 提问
 *   - 生成前先探活 AI 端点，避免用户干等
 *   - 展示历史版本，可删除
 *   - 结果渲染 Markdown（含公式）
 *   - 一键复制
 */
import { useEffect, useState } from 'react'
import { api, type SummaryItem, type SummaryKind } from '../api/client'
import { useStore } from '../stores/useStore'
import MarkdownView from './MarkdownView'

export default function SummaryPanel() {
  const currentDoc = useStore((s) => s.currentDoc)
  const [kinds, setKinds] = useState<SummaryKind[]>([])
  const [activeKind, setActiveKind] = useState('overview')
  const [question, setQuestion] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<SummaryItem[]>([])
  const [current, setCurrent] = useState<SummaryItem | null>(null)

  useEffect(() => {
    void api.summaryKinds().then((r) => setKinds(r.kinds)).catch(() => {})
  }, [])

  useEffect(() => {
    setCurrent(null)
    setError(null)
    if (!currentDoc) { setHistory([]); return }
    void api.listSummaries(currentDoc.id)
      .then((r) => setHistory(r.summaries))
      .catch(() => setHistory([]))
  }, [currentDoc])

  if (!currentDoc) {
    return <div className="hint" style={{ padding: 20 }}>选择一篇文献后可生成 AI 总结</div>
  }

  const generate = async () => {
    setRunning(true)
    setError(null)
    setCurrent(null)
    try {
      // 先探活，避免长任务白等
      const probe = await api.probeAI()
      if (!probe.ok) {
        setError(`AI 端点不可用：${probe.error ?? '未知原因'}。请检查右上角 ⚙ 里的 AI 配置。`)
        return
      }
      const r = await api.createSummary(
        currentDoc.id, activeKind,
        activeKind === 'qa' ? question : undefined,
      )
      setCurrent({
        id: r.id, document_id: currentDoc.id, kind: r.kind,
        content: r.content, model: r.model ?? null, created_at: new Date().toISOString(),
      })
      const list = await api.listSummaries(currentDoc.id)
      setHistory(list.summaries)
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setRunning(false)
    }
  }

  const del = async (id: string) => {
    await api.deleteSummary(id)
    if (current?.id === id) setCurrent(null)
    const list = await api.listSummaries(currentDoc.id)
    setHistory(list.summaries)
  }

  const labelOf = (k: string) => kinds.find((x) => x.value === k)?.label ?? k

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 控制区 */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {kinds.map((k) => (
            <button
              key={k.value}
              onClick={() => setActiveKind(k.value)}
              style={{
                fontSize: 11, padding: '4px 9px', borderRadius: 12, cursor: 'pointer',
                border: `1px solid ${activeKind === k.value ? 'var(--accent)' : 'var(--border)'}`,
                background: activeKind === k.value ? 'var(--accent)' : 'transparent',
                color: activeKind === k.value ? '#fff' : 'var(--fg)',
              }}
            >{k.label}</button>
          ))}
        </div>

        {activeKind === 'qa' && (
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder="针对这篇论文提问，例如：训练用了什么数据和超参数？"
            style={{ width: '100%', fontSize: 12, padding: '6px 8px', marginBottom: 8, resize: 'vertical' }}
          />
        )}

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            className="btn-primary"
            style={{ fontSize: 12 }}
            onClick={() => void generate()}
            disabled={running || (activeKind === 'qa' && !question.trim())}
          >
            {running ? '生成中…' : '生成总结'}
          </button>
          {running && (
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              首次调用可能需要 1-2 分钟
            </span>
          )}
        </div>

        {error && (
          <div style={{
            marginTop: 8, fontSize: 11, color: '#b91c1c', background: '#ef44441a',
            padding: '6px 8px', borderRadius: 6, lineHeight: 1.5,
          }}>{error}</div>
        )}
      </div>

      {/* 结果区 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
        {current ? (
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
              fontSize: 11, color: 'var(--fg-muted)',
            }}>
              <span>{labelOf(current.kind)}</span>
              {current.model && <span>· {current.model}</span>}
              <button
                className="btn-ghost"
                style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 6px' }}
                onClick={() => void navigator.clipboard?.writeText(current.content)}
              >复制</button>
            </div>
            <MarkdownView text={current.content} />
          </div>
        ) : (
          !running && (
            <div className="hint" style={{ padding: '20px 4px', lineHeight: 1.7 }}>
              选择上方的总结类型，点击「生成总结」。
              <br />结果会保存在本地数据库中，随时可回看。
            </div>
          )
        )}

        {history.length > 0 && (
          <div style={{ marginTop: 22, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>
              历史记录（{history.length}）
            </div>
            {history.map((h) => (
              <div
                key={h.id}
                onClick={() => setCurrent(h)}
                style={{
                  fontSize: 11, padding: '5px 7px', borderRadius: 5, cursor: 'pointer',
                  display: 'flex', gap: 6, alignItems: 'center',
                  background: current?.id === h.id ? 'var(--bg-active)' : 'transparent',
                }}
              >
                <span>{labelOf(h.kind)}</span>
                <span style={{ color: 'var(--fg-muted)' }}>
                  {new Date(h.created_at).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
                <button
                  className="btn-ghost"
                  style={{ marginLeft: 'auto', fontSize: 10, padding: '0 4px' }}
                  onClick={(e) => { e.stopPropagation(); void del(h.id) }}
                >删除</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
