/**
 * 双语 PDF 生成确认浮层。
 *
 * 双语生成属重成本操作（满核 CPU 数分钟 + LLM 调用费用，低配机界面会卡），
 * 所有入口（双语 / 译文按钮、⌘K「生成双语 PDF」命令）在未生成态点击时
 * 都先经本浮层确认，确认后才开始生成并切到目标视图。
 */
interface Props {
  /** 即将生成的文档标题 */
  docTitle: string
  /** 确认后切换的目标视图：双栏（双语）或译文列 */
  target: 'bilingual' | 'zh'
  onCancel: () => void
  onStart: () => void
}

export default function BilingualConfirmOverlay({ docTitle, target, onCancel, onStart }: Props) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 6000, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420, maxWidth: '92vw', background: 'var(--bg)',
          border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 12px 40px rgba(0,0,0,0.3)', padding: 18,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
          生成双语 PDF？
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--fg)' }}>
          生成《{docTitle}》的双语 PDF 需要数分钟 CPU 满核运算与 LLM 调用费用，
          低配服务器期间界面可能变卡。
        </div>
        <div style={{
          marginTop: 10, fontSize: 11, color: 'var(--fg-muted)',
          background: 'var(--bg-side)', borderRadius: 6, padding: '6px 9px', lineHeight: 1.7,
        }}>
          完成后将以「{target === 'bilingual' ? '双语（左右对照）' : '译文列'}」视图打开。
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={onCancel}>取消</button>
          <button className="btn-primary" style={{ fontSize: 12 }} onClick={onStart}>开始生成</button>
        </div>
      </div>
    </div>
  )
}
