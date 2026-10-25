/**
 * 右侧栏容器：标注 / AI 总结 切换。
 */
import { useState } from 'react'
import NotePanel from './NotePanel'
import SummaryPanel from './SummaryPanel'
import ChatPanel from './ChatPanel'
import { useStore } from '../stores/useStore'

type Tab = 'notes' | 'summary' | 'chat'

export default function RightPanel({ width }: { width: number }) {
  const [tab, setTab] = useState<Tab>('notes')
  const currentDoc = useStore((s) => s.currentDoc)
  const annotations = useStore((s) => s.annotations)

  return (
    <aside
      style={{
        width, flexShrink: 0, borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', background: 'var(--bg-side)',
        overflow: 'hidden', minHeight: 0,
      }}
    >
      <div style={{
        display: 'flex', flexShrink: 0, borderBottom: '1px solid var(--border)',
      }}>
        {([
          ['notes', `标注${annotations.length ? ` (${annotations.length})` : ''}`],
          ['summary', 'AI 总结'],
          ['chat', '问答'],
        ] as Array<[Tab, string]>).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, fontSize: 12, padding: '9px 4px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              color: tab === t ? 'var(--fg-strong)' : 'var(--fg-muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >{label}</button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'notes' && <NotePanel width={width} embedded />}
        {tab === 'summary' && (
          currentDoc
            ? <SummaryPanel />
            : <div className="hint" style={{ padding: 20 }}>选择一篇文献后可生成 AI 总结</div>
        )}
        {tab === 'chat' && <ChatPanel />}
      </div>
    </aside>
  )
}
