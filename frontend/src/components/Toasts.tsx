/**
 * 全局 toast 渲染器：底部居中堆叠（最新在下），点击整条触发动作或关闭。
 * 挂在 App 根部一次即可，全应用（含雷达、队列完成通知）共用。
 */
import { useToast } from '../stores/useToast'

export default function Toasts() {
  const toasts = useToast((s) => s.toasts)
  const dismiss = useToast((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 3000, display: 'flex', flexDirection: 'column', gap: 8,
      alignItems: 'center', maxWidth: '70vw', pointerEvents: 'none',
    }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => {
            dismiss(t.id)
            t.action?.run()
          }}
          style={{
            pointerEvents: 'auto', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 12, lineHeight: 1.5, maxWidth: '100%',
            padding: '8px 14px', borderRadius: 8,
            boxShadow: 'var(--shadow-pop)', wordBreak: 'break-word',
            ...(t.kind === 'error'
              ? { background: 'var(--err-solid)', color: '#fff' }
              : {
                background: 'var(--bg-card)', color: 'var(--fg)',
                border: '1px solid var(--border)',
              }),
          }}
        >
          {t.kind === 'success' && <span style={{ color: 'var(--ok)', fontWeight: 700 }}>✓</span>}
          {t.kind === 'error' && <span style={{ fontWeight: 700 }}>✕</span>}
          <span>{t.text}</span>
          {t.action && (
            <span style={{
              color: t.kind === 'error' ? '#fecaca' : 'var(--accent)',
              fontWeight: 600, flexShrink: 0,
            }}>
              {t.action.label}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
