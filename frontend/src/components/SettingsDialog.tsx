import { useEffect, useState } from 'react'
import { api, type AIConfig } from '../api/client'
import { useStore } from '../stores/useStore'

const PRESETS = [
  { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { label: '阿里百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
]

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const refreshAIConfig = useStore((s) => s.refreshAIConfig)
  const [cfg, setCfg] = useState<AIConfig | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [glossaryText, setGlossaryText] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void (async () => {
      const c = await api.getAIConfig()
      setCfg(c)
      setBaseUrl(c.base_url)
      setModel(c.model)
      const g = await api.getGlossary()
      setGlossaryText(
        Object.entries(g.glossary).map(([k, v]) => `${k}=${v}`).join('\n'),
      )
    })().catch((e) => setMsg(String(e)))
  }, [])

  const save = async () => {
    setSaving(true); setMsg('')
    try {
      await api.saveAIConfig({
        base_url: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      })
      // 术语表：每行 "英文=中文"
      const glossary: Record<string, string> = {}
      for (const line of glossaryText.split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) {
          const k = line.slice(0, i).trim()
          const v = line.slice(i + 1).trim()
          if (k && v) glossary[k] = v
        }
      }
      await api.saveGlossary(glossary)
      await refreshAIConfig()
      setMsg('已保存')
      setTimeout(onClose, 600)
    } catch (e) {
      setMsg(String(e))
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 9px', fontSize: 13, marginTop: 4,
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520, maxHeight: '85vh', overflowY: 'auto',
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 12, padding: 20,
        }}
      >
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>AI 接口设置</h3>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>快捷填充</label>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button
                key={p.label} className="btn-ghost" style={{ fontSize: 11 }}
                onClick={() => { setBaseUrl(p.base); setModel(p.model) }}
              >{p.label}</button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Base URL（OpenAI 兼容，含 /v1）
          </label>
          <input
            value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-proxy.com/v1" style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            API Key {cfg?.api_key_set && <span>（当前：{cfg.api_key_masked}，留空则不修改）</span>}
          </label>
          <input
            type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={cfg?.api_key_set ? '留空保持不变' : 'sk-...'} style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>模型名</label>
          <input
            value={model} onChange={(e) => setModel(e.target.value)}
            placeholder="deepseek-chat" style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            术语表（每行一条：英文=中文）
          </label>
          <textarea
            value={glossaryText} onChange={(e) => setGlossaryText(e.target.value)}
            rows={5} placeholder={'attention=注意力机制\ndisparity=视差'}
            style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          {msg && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{msg}</span>}
        </div>

        <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 14, lineHeight: 1.5 }}>
          Key 会加密存储在本地数据库，不会进入版本控制。
        </p>
      </div>
    </div>
  )
}
