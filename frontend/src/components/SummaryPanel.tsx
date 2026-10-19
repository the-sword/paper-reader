/**
 * AI 总结面板。
 *
 * 交互原则：**完全手动触发**
 *   - 打开标签页只读取类型列表与历史记录，不发起任何 AI 调用
 *   - 只有点击「生成总结」才启动任务
 *   - 任务在后端独立线程执行，可随时「取消」
 *
 * 流程：
 *   startSummary → 轮询 job 状态 → done 后写入当前视图并刷新历史
 */
import { useEffect, useRef, useState } from 'react'
import { api, type SummaryItem, type SummaryKind } from '../api/client'
import { useStore } from '../stores/useStore'
import MarkdownView from './MarkdownView'

const POLL_MS = 900

export default function SummaryPanel() {
  const currentDoc = useStore((s) => s.currentDoc)
  const [kinds, setKinds] = useState<SummaryKind[]>([])
  const [activeKind, setActiveKind] = useState('overview')
  const [question, setQuestion] = useState('')

  const [jobId, setJobId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [history, setHistory] = useState<SummaryItem[]>([])
  const [current, setCurrent] = useState<SummaryItem | null>(null)

  const timerRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    void api.summaryKinds().then((r) => setKinds(r.kinds)).catch(() => {})
  }, [])

  useEffect(() => {
    setCurrent(null)
    setError(null)
    stopPolling()
    setRunning(false)
    setJobId(null)
    if (!currentDoc) { setHistory([]); return }
    void api.listSummaries(currentDoc.id)
      .then((r) => setHistory(r.summaries))
      .catch(() => setHistory([]))
  }, [currentDoc])

  // 组件卸载时停止轮询
  useEffect(() => () => stopPolling(), [])

  const stopPolling = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const refreshHistory = async () => {
    if (!currentDoc) return
    try {
      const list = await api.listSummaries(currentDoc.id)
      setHistory(list.summaries)
    } catch { /* 忽略 */ }
  }

  const generate = async () => {
    if (!currentDoc) return
    setError(null)
    setCurrent(null)
    setProgress(5)
    setMessage('启动任务')
    setRunning(true)
    setCancelling(false)
    cancelledRef.current = false

    try {
      const { job_id } = await api.startSummary(
        currentDoc.id, activeKind,
        activeKind === 'qa' ? question : undefined,
      )
      setJobId(job_id)

      timerRef.current = window.setInterval(async () => {
        try {
          const st = await api.summaryJob(job_id)
          setProgress(st.progress)
          setMessage(st.message || '')

          if (st.status === 'running') return

          stopPolling()
          setRunning(false)
          setJobId(null)

          if (st.status === 'done' && st.result) {
            const r = st.result
            setCurrent({
              id: r.id,
              document_id: currentDoc.id,
              kind: st.kind,
              content: r.content,
              model: r.model ?? null,
              created_at: new Date().toISOString(),
            })
            await refreshHistory()
          } else if (st.status === 'cancelled') {
            setMessage('已取消')
          } else {
            setError(st.error || '生成失败')
          }
        } catch (e) {
          stopPolling()
          setRunning(false)
          setJobId(null)
          setError(String(e).replace(/^Error:\s*/, ''))
        }
      }, POLL_MS)
    } catch (e) {
      setRunning(false)
      setJobId(null)
      setError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const cancel = async () => {
    if (!jobId) return
    setCancelling(true)
    setMessage('正在取消…')
    try {
      await api.cancelSummary(jobId)
      cancelledRef.current = true
      // 轮询会捕获 cancelled 状态并复位 UI
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
      setCancelling(false)
    }
  }

  if (!currentDoc) {
    return <div className="hint" style={{ padding: 20 }}>选择一篇文献后可生成 AI 总结</div>
  }

  const del = async (id: string) => {
    await api.deleteSummary(id)
    if (current?.id === id) setCurrent(null)
    await refreshHistory()
  }

  const labelOf = (k: string) => kinds.find((x) => x.value === k)?.label ?? k

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 控制区 */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {kinds.map((k) => (
            <button
              key={k.value}
              onClick={() => setActiveKind(k.value)}
              disabled={running}
              style={{
                fontSize: 11, padding: '4px 9px', borderRadius: 12,
                cursor: running ? 'not-allowed' : 'pointer',
                opacity: running && activeKind !== k.value ? 0.5 : 1,
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
            disabled={running}
            placeholder="针对这篇论文提问，例如：训练用了什么数据和超参数？"
            style={{ width: '100%', fontSize: 12, padding: '6px 8px', marginBottom: 8, resize: 'vertical' }}
          />
        )}

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {!running ? (
            <button
              className="btn-primary"
              style={{ fontSize: 12 }}
              onClick={() => void generate()}
              disabled={activeKind === 'qa' && !question.trim()}
            >生成总结</button>
          ) : (
            <>
              <button
                className="btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => void cancel()}
                disabled={cancelling}
              >{cancelling ? '取消中…' : '取消'}</button>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                {message}{progress > 0 && ` ${Math.round(progress)}%`}
              </span>
            </>
          )}
        </div>

        {running && (
          <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginTop: 8 }}>
            <div style={{
              height: '100%', width: `${progress}%`, background: 'var(--accent)',
              borderRadius: 2, transition: 'width 0.4s',
            }} />
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 8, fontSize: 11, color: '#b91c1c', background: '#ef44441a',
            padding: '6px 8px', borderRadius: 6, lineHeight: 1.5, wordBreak: 'break-word',
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
