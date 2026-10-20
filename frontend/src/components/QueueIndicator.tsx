/**
 * 双语 PDF 后台队列指示器。
 *
 * 导入论文后会自动排队生成双语 PDF（串行，避免批量导入时内存爆掉）。
 * 这里在顶栏显示队列状态，点击展开详情，可取消/重试/开关。
 */
import { useEffect, useRef, useState } from 'react'
import { api, type QueueSnapshot } from '../api/client'
import { useStore } from '../stores/useStore'

export default function QueueIndicator() {
  const [snap, setSnap] = useState<QueueSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const prevBusy = useRef(false)
  const refreshLibrary = useStore((s) => s.refreshLibrary)

  // 轮询（有任务时 2s，空闲时 10s）
  useEffect(() => {
    let timer: number
    const tick = async () => {
      try {
        const s = await api.babelDocQueue()
        setSnap(s)
        const busy = (s.counts.running ?? 0) + (s.counts.pending ?? 0) > 0
        // 刚完成时刷新文献列表，让按钮状态跟上
        if (prevBusy.current && !busy) void refreshLibrary()
        prevBusy.current = busy
        timer = window.setTimeout(tick, busy ? 2000 : 10000)
      } catch {
        timer = window.setTimeout(tick, 15000)
      }
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [refreshLibrary])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (!snap) return null

  const running = snap.counts.running ?? 0
  const pending = snap.counts.pending ?? 0
  const failed = snap.counts.failed ?? 0
  const busy = running + pending > 0

  // 无任务且无失败时不占位
  if (!busy && failed === 0) return null

  const runningItem = snap.items.find((i) => i.status === 'running')

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="btn-ghost"
        style={{ padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
        title="双语 PDF 后台队列"
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? (
          <>
            <span style={{ color: 'var(--accent)' }}>●</span>
            {' '}双语PDF {running > 0 && runningItem
              ? `${Math.round(runningItem.progress)}%`
              : `${pending} 排队`}
          </>
        ) : (
          <span style={{ color: '#b45309' }}>⚠ {failed} 失败</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'fixed', right: 12, top: 52, zIndex: 5000,
          width: 360, maxHeight: '60vh', overflowY: 'auto',
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
          padding: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 12 }}>双语 PDF 队列</strong>
            <label style={{
              marginLeft: 'auto', fontSize: 11, display: 'flex',
              alignItems: 'center', gap: 5, cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={snap.enabled}
                style={{ width: 'auto', margin: 0 }}
                onChange={async (e) => {
                  await api.setQueueEnabled(e.target.checked)
                  setSnap((s) => (s ? { ...s, enabled: e.target.checked } : s))
                }}
              />
              导入后自动生成
            </label>
          </div>

          <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginBottom: 10, lineHeight: 1.6 }}>
            串行处理，同时只跑 1 个任务（单任务约 258MB），
            保证批量导入时内存不爆。
          </div>

          {snap.items.length === 0 && (
            <div className="hint" style={{ padding: 8 }}>队列为空</div>
          )}

          {snap.items.map((it) => (
            <div key={it.doc_id} style={{
              padding: '6px 8px', marginBottom: 5, borderRadius: 6,
              background: 'var(--bg-side)', fontSize: 11,
            }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{
                  fontSize: 10, padding: '0 5px', borderRadius: 3,
                  background:
                    it.status === 'running' ? 'var(--accent)'
                    : it.status === 'failed' ? '#ef444433'
                    : it.status === 'done' ? '#22c55e33'
                    : 'var(--border)',
                  color: it.status === 'running' ? '#fff' : 'var(--fg)',
                  flexShrink: 0,
                }}>
                  {it.status === 'running' ? `${Math.round(it.progress)}%`
                    : it.status === 'pending' ? '排队'
                    : it.status === 'done' ? '完成'
                    : it.status === 'failed' ? '失败'
                    : '跳过'}
                </span>
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }} title={it.title}>{it.title}</span>
                {it.status === 'failed' && (
                  <button
                    className="btn-ghost" style={{ fontSize: 10, padding: '0 5px' }}
                    onClick={async () => {
                      await api.retryQueueItem(it.doc_id)
                      const s = await api.babelDocQueue()
                      setSnap(s)
                    }}
                  >重试</button>
                )}
              </div>
              {it.error && it.status === 'failed' && (
                <div style={{ fontSize: 10, color: '#b91c1c', marginTop: 3 }}>
                  {it.error.slice(0, 100)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
