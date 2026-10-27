import { useState } from 'react'
import { useStore } from '../stores/useStore'

/** 解析引擎选项：value 与后端 ParseReq.engine 对应 */
const ENGINE_OPTIONS: Array<{ value: 'mineru' | 'local'; label: string; hint: string }> = [
  { value: 'mineru', label: 'MinerU 云端', hint: '版面更准，需要 MINERU_TOKEN' },
  { value: 'local', label: '本地快速解析', hint: '无需联网，同一引擎结果一致' },
]

/** 引擎字段到展示名（历史文献无记录时为「未知」） */
export function engineLabel(engine: string | null | undefined): string {
  if (engine === 'local') return '本地解析'
  if (engine === 'mineru') return 'MinerU 云端'
  return '未知'
}

/** 默认推荐与当前引擎不同的选项；MinerU 未配置时只能选本地 */
function recommend(current: string | null | undefined, mineruReady: boolean): 'mineru' | 'local' {
  if (!mineruReady || current === 'mineru') return 'local'
  return 'mineru'
}

/** 重新解析浮层：选择引擎后确认，替换段落与目录（PDF 标注保留，段落标注尽量迁移） */
export default function ReparseMenu() {
  const currentDoc = useStore((s) => s.currentDoc)
  const mineruReady = useStore((s) => s.mineruReady)
  const setShowReparse = useStore((s) => s.setShowReparse)
  const startParse = useStore((s) => s.startParse)
  const [choice, setChoice] = useState<'mineru' | 'local'>(
    () => recommend(currentDoc?.parse_engine, mineruReady),
  )

  if (!currentDoc) return null

  const close = (): void => setShowReparse(false)
  const confirm = (): void => {
    close()
    void startParse(choice)
  }

  return (
    <>
      <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 80 }} />
      <div
        role="dialog"
        aria-label="重新解析"
        style={{
          position: 'fixed', top: 56, right: 16, zIndex: 81, width: 320,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-pop)', padding: 14,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-strong)', marginBottom: 4 }}>重新解析</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          当前：{engineLabel(currentDoc.parse_engine)}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ENGINE_OPTIONS.map((o) => {
            const disabled = o.value === 'mineru' && !mineruReady
            const active = choice === o.value
            return (
              <button
                key={o.value}
                disabled={disabled}
                onClick={() => setChoice(o.value)}
                title={disabled ? '请在设置中填写 MINERU_TOKEN 后启用' : undefined}
                style={{
                  textAlign: 'left', padding: '8px 10px', borderRadius: 'var(--radius-sm)', cursor: disabled ? 'not-allowed' : 'pointer',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: active ? 'var(--bg-active)' : 'transparent', opacity: disabled ? 0.5 : 1,
                }}
              >
                <div style={{ fontSize: 12.5, color: 'var(--fg-strong)', fontWeight: 600 }}>{o.label}</div>
                <div className="hint" style={{ fontSize: 11, marginTop: 2 }}>
                  {disabled ? '需配置 MINERU_TOKEN 才能使用' : o.hint}
                </div>
              </button>
            )
          })}
        </div>

        <div className="hint" style={{ fontSize: 11, lineHeight: 1.6, margin: '10px 0' }}>
          重新解析会替换段落与目录，段落译文缓存会清空；PDF 上的标注不受影响，段落流标注会尽量自动迁移。
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={close}>取消</button>
          <button className="btn-primary" onClick={confirm}>开始重新解析</button>
        </div>
      </div>
    </>
  )
}
