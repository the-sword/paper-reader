import { useEffect, useState } from 'react'
import {
  api,
  type AIConfig, type EngineInfo, type EngineTestResult,
} from '../api/client'
import { useStore } from '../stores/useStore'

const AI_PRESETS = [
  { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { label: '阿里百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
]

type Tab = 'ai' | 'engines' | 'glossary' | 'mineru' | 'system'

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('engines')

  const tabs: Array<[Tab, string]> = [
    ['engines', '翻译引擎'],
    ['ai', 'AI 接口'],
    ['glossary', '术语表'],
    ['mineru', 'MinerU'],
    ['system', '系统信息'],
  ]

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
          width: 640, maxHeight: '88vh', display: 'flex', flexDirection: 'column',
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 12, overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)',
          padding: '0 8px', background: 'var(--bg-side)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, padding: '0 10px 0 4px' }}>设置</span>
          <div style={{ display: 'flex', flex: 1 }}>
            {tabs.map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  fontSize: 12, padding: '10px 12px', border: 'none', background: 'transparent',
                  color: tab === t ? 'var(--fg-strong)' : 'var(--fg-muted)',
                  borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: 'pointer',
                }}
              >{label}</button>
            ))}
          </div>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={onClose}>关闭</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {tab === 'engines' && <EnginesTab />}
          {tab === 'ai' && <AITab onSaved={() => { /* no-op */ }} />}
          {tab === 'glossary' && <GlossaryTab />}
          {tab === 'mineru' && <MinerUTab />}
          {tab === 'system' && <SystemTab />}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: 13, marginTop: 4,
}
const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--fg-muted)' }
const boxStyle: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12,
}

// ---------------------------------------------------------------------------

function EnginesTab() {
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [tests, setTests] = useState<Record<string, EngineTestResult | 'running'>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const refreshAIConfig = useStore((s) => s.refreshAIConfig)

  const load = () => {
    void api.getEnginesList().then((r) => setEngines(r.engines)).catch(() => {})
  }
  useEffect(load, [])

  const runTest = async (name: string) => {
    setTests((t) => ({ ...t, [name]: 'running' }))
    try {
      const r = await api.testEngine(name)
      setTests((t) => ({ ...t, [name]: r }))
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { ok: false, error: String(e) } }))
    }
  }

  const toggle = async (e: EngineInfo) => {
    await api.saveEngineConfig(e.name, { enabled: !e.enabled })
    await refreshAIConfig()
    load()
  }

  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...engines]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    await api.setEngineOrder(next.map((x) => x.name))
    load()
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 0, lineHeight: 1.6 }}>
        按顺序尝试，前一个失败自动降级到下一个。已启用且已配置的引擎才会参与。
      </p>

      {engines.map((e, i) => {
        const t = tests[e.name]
        return (
          <div key={e.name} style={boxStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 11, color: 'var(--fg-muted)', width: 16, textAlign: 'center',
              }}>{i + 1}</span>

              <input
                type="checkbox" checked={e.enabled} onChange={() => void toggle(e)}
                style={{ width: 'auto', margin: 0 }}
              />

              <strong style={{ fontSize: 13 }}>{e.label}</strong>

              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: e.configured ? '#22c55e22' : '#9ca3af22',
                color: e.configured ? '#16a34a' : 'var(--fg-muted)',
              }}>{e.configured ? '已配置' : '未配置'}</span>

              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }}
                  onClick={() => void move(i, -1)} title="上移">↑</button>
                <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }}
                  onClick={() => void move(i, 1)} title="下移">↓</button>
                {['baidu', 'tencent', 'volcano', 'deepl'].includes(e.name) && (
                  <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }}
                    onClick={() => setEditing(editing === e.name ? null : e.name)}>配置</button>
                )}
                <button className="btn-primary" style={{ fontSize: 11, padding: '3px 8px' }}
                  disabled={t === 'running'}
                  onClick={() => void runTest(e.name)}>
                  {t === 'running' ? '测试中' : '测试'}
                </button>
              </div>
            </div>

            {e.hint && (
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '6px 0 0 40px', lineHeight: 1.5 }}>
                {e.hint}
              </div>
            )}

            {t && t !== 'running' && (
              <div style={{
                margin: '8px 0 0 40px', fontSize: 12, padding: '6px 9px', borderRadius: 6,
                background: t.ok ? '#22c55e1a' : '#ef44441a',
                color: t.ok ? '#15803d' : '#b91c1c',
              }}>
                {t.ok
                  ? `✅ ${t.latency_ms}ms · ${t.text}`
                  : `❌ ${t.error}`}
              </div>
            )}

            {editing === e.name && (
              <EngineConfigForm
                name={e.name}
                domains={e.domains}
                onSaved={() => { setEditing(null); load(); void refreshAIConfig() }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function EngineConfigForm({
  name, domains, onSaved,
}: { name: string; domains: Array<{ value: string; label: string }>; onSaved: () => void }) {
  const [appid, setAppid] = useState('')
  const [appkey, setAppkey] = useState('')
  const [domain, setDomain] = useState('academic')
  // 各引擎的 region 语义不同：
  //   腾讯 = 云地域（ap-guangzhou）
  //   DeepL = 套餐（api-free / api-pro）
  const REGION_DEFAULT: Record<string, string> = {
    tencent: 'ap-guangzhou',
    deepl: 'api-free',
  }
  const [region, setRegion] = useState(REGION_DEFAULT[name] ?? '')
  const [cfgLoaded, setCfgLoaded] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void api.getEngineConfig(name).then((c) => {
      if (typeof c.domain === 'string') setDomain(c.domain)
      const def = REGION_DEFAULT[name] ?? ''
      let r = typeof c.region === 'string' ? c.region : ''
      // 防御：旧数据可能把别的引擎的 region 值带过来了
      if (name === 'tencent' && !r.startsWith('ap-')) r = def
      if (name === 'deepl' && !r.startsWith('api')) r = def
      setRegion(r || def)
      setCfgLoaded(true)
    }).catch(() => setCfgLoaded(true))
  }, [name])

  const save = async () => {
    setMsg('')
    try {
      const payload: Parameters<typeof api.saveEngineConfig>[1] = {
        ...(appid.trim() ? { appid: appid.trim() } : {}),
        ...(appkey.trim() ? { appkey: appkey.trim() } : {}),
      }
      // 只为使用该字段的引擎提交，避免把 api-free 写进腾讯配置
      if (name === 'baidu') payload.domain = domain
      if (name === 'tencent' || name === 'deepl') payload.region = region
      await api.saveEngineConfig(name, payload)
      setMsg('已保存')
      setTimeout(onSaved, 500)
    } catch (e) {
      setMsg(String(e))
    }
  }

  if (!cfgLoaded) return <div style={{ fontSize: 11, margin: '8px 0 0 40px' }}>加载中…</div>

  return (
    <div style={{ margin: '10px 0 0 40px', borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
      {name === 'baidu' && (
        <>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>AppID</label>
            <input value={appid} onChange={(e) => setAppid(e.target.value)}
              placeholder="留空表示不修改" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>密钥</label>
            <input type="password" value={appkey} onChange={(e) => setAppkey(e.target.value)}
              placeholder="留空表示不修改" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>翻译领域</label>
            <select value={domain} onChange={(e) => setDomain(e.target.value)}
              style={inputStyle}>
              {domains.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8, lineHeight: 1.5 }}>
            申请地址：<a href="https://fanyi-api.baidu.com/product/12" target="_blank"
              rel="noreferrer" style={{ color: 'var(--accent)' }}>百度翻译开放平台 · 领域翻译</a>
            <br />选择「学术论文」或「信息技术」领域，每月 50 万字符免费。
          </div>
        </>
      )}

      {name === 'tencent' && (
        <>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>SecretId</label>
            <input value={appid} onChange={(e) => setAppid(e.target.value)}
              placeholder="AKID...（留空不修改）" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>SecretKey</label>
            <input type="password" value={appkey} onChange={(e) => setAppkey(e.target.value)}
              placeholder="留空不修改" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>地域 Region</label>
            <select value={region} onChange={(e) => setRegion(e.target.value)} style={inputStyle}>
              <option value="ap-guangzhou">华南地区（广州）</option>
              <option value="ap-beijing">华北地区（北京）</option>
              <option value="ap-shanghai">华东地区（上海）</option>
              <option value="ap-chengdu">西南地区（成都）</option>
              <option value="ap-hongkong">港澳台地区（香港）</option>
            </select>
          </div>
          <div style={{
            fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8, lineHeight: 1.7,
            background: 'var(--bg-side)', padding: 8, borderRadius: 6,
          }}>
            <strong>申请步骤：</strong>
            <br />1. <a href="https://console.cloud.tencent.com/cam/capi" target="_blank"
              rel="noreferrer" style={{ color: 'var(--accent)' }}>API 密钥管理</a>获取 SecretId / SecretKey
            <br />2. 到<a href="https://console.cloud.tencent.com/tmt" target="_blank"
              rel="noreferrer" style={{ color: 'var(--accent)' }}>机器翻译控制台</a>开通服务
            <br />3. <strong>使用子账号密钥时</strong>，需在 CAM 授予
            <code style={{ fontSize: 10 }}>QcloudTMTFullAccess</code> 策略
            （只给 ReadOnly 会报无权限）
            <br />每月 500 万字符免费，额度在国内引擎中最大。
          </div>
        </>
      )}

      {name === 'volcano' && (
        <>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>Access Key (AK)</label>
            <input value={appid} onChange={(e) => setAppid(e.target.value)}
              placeholder="AKLT...（留空不修改）" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>Secret Key (SK)</label>
            <input type="password" value={appkey} onChange={(e) => setAppkey(e.target.value)}
              placeholder="留空不修改" style={inputStyle} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8, lineHeight: 1.5 }}>
            申请地址：
            <a href="https://console.volcengine.com/iam/keymanage/" target="_blank"
              rel="noreferrer" style={{ color: 'var(--accent)' }}>
              火山引擎密钥管理
            </a>
            <br />需开通「机器翻译」服务。每月 200 万字符免费。
          </div>
        </>
      )}

      {name === 'deepl' && (
        <>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>API Key</label>
            <input type="password" value={appkey} onChange={(e) => setAppkey(e.target.value)}
              placeholder="留空表示不修改" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>套餐</label>
            <select value={region} onChange={(e) => setRegion(e.target.value)} style={inputStyle}>
              <option value="api-free">免费版（api-free）</option>
              <option value="api-pro">专业版（api）</option>
            </select>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn-primary" style={{ fontSize: 12 }} onClick={() => void save()}>保存</button>
        {msg && <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{msg}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function AITab({ onSaved }: { onSaved: () => void }) {
  const [cfg, setCfg] = useState<AIConfig | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [msg, setMsg] = useState('')
  const [testing, setTesting] = useState(false)
  const [testRes, setTestRes] = useState<EngineTestResult | null>(null)
  const refreshAIConfig = useStore((s) => s.refreshAIConfig)

  useEffect(() => {
    void api.getAIConfig().then((c) => {
      setCfg(c); setBaseUrl(c.base_url); setModel(c.model)
    }).catch((e) => setMsg(String(e)))
  }, [])

  const save = async () => {
    setMsg('')
    try {
      await api.saveAIConfig({
        base_url: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      })
      const c = await api.getAIConfig()
      setCfg(c); setApiKey('')
      await refreshAIConfig()
      setMsg('已保存')
      onSaved()
    } catch (e) {
      setMsg(String(e))
    }
  }

  const test = async () => {
    setTesting(true); setTestRes(null)
    try {
      setTestRes(await api.testEngine('ai'))
    } catch (e) {
      setTestRes({ ok: false, error: String(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>快捷填充</label>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {AI_PRESETS.map((p) => (
            <button key={p.label} className="btn-ghost" style={{ fontSize: 11 }}
              onClick={() => { setBaseUrl(p.base); setModel(p.model) }}>{p.label}</button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Base URL（OpenAI 兼容，含 /v1）</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://your-proxy.com/v1" style={inputStyle} />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>
          API Key {cfg?.api_key_set && <span>（当前：{cfg.api_key_masked}）</span>}
        </label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={cfg?.api_key_set ? '留空保持不变' : 'sk-...'} style={inputStyle} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>模型名</label>
        <input value={model} onChange={(e) => setModel(e.target.value)}
          placeholder="deepseek-chat" style={inputStyle} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={() => void save()}>保存</button>
        <button className="btn-ghost" onClick={() => void test()} disabled={testing}>
          {testing ? '测试中…' : '测试连通'}
        </button>
        {msg && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{msg}</span>}
      </div>

      {testRes && (
        <div style={{
          marginTop: 10, fontSize: 12, padding: '7px 10px', borderRadius: 6,
          background: testRes.ok ? '#22c55e1a' : '#ef44441a',
          color: testRes.ok ? '#15803d' : '#b91c1c',
        }}>
          {testRes.ok ? `✅ ${testRes.latency_ms}ms · ${testRes.text}` : `❌ ${testRes.error}`}
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 14, lineHeight: 1.6 }}>
        Key 存储在本地数据库中，不会进入版本控制。
        这个引擎也可以作为翻译引擎参与降级链（见「翻译引擎」页）。
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

function GlossaryTab() {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void api.getGlossary().then((g) => {
      setText(Object.entries(g.glossary).map(([k, v]) => `${k}=${v}`).join('\n'))
    }).catch((e) => setMsg(String(e)))
  }, [])

  const save = async () => {
    const glossary: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) {
        const k = line.slice(0, i).trim()
        const v = line.slice(i + 1).trim()
        if (k && v) glossary[k] = v
      }
    }
    try {
      const r = await api.saveGlossary(glossary)
      setMsg(`已保存 ${r.count} 条`)
    } catch (e) {
      setMsg(String(e))
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 0, lineHeight: 1.6 }}>
        每行一条，格式 <code>英文=中文</code>。使用 AI 引擎翻译时注入 prompt，
        保证全文译名一致；机翻引擎不支持术语表。
      </p>
      <textarea
        value={text} onChange={(e) => setText(e.target.value)}
        rows={14}
        placeholder={'attention=注意力机制\ndisparity=视差\ncost volume=代价体'}
        style={{
          ...inputStyle, fontFamily: 'monospace', resize: 'vertical',
          lineHeight: 1.6,
        }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="btn-primary" onClick={() => void save()}>保存</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{msg}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function MinerUTab() {
  const [token, setToken] = useState('')
  const [model, setModel] = useState('vlm')
  const [status, setStatus] = useState<{ configured: boolean; model: string } | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void api.getEngines().then((e) =>
      setStatus({ configured: e.mineru_configured, model: e.mineru_model }))
      .catch(() => {})
  }, [])

  const save = async () => {
    setMsg('界面保存需要重启服务生效（token 存在环境变量中）。' +
      '更推荐直接编辑 backend/.env 的 MINERU_TOKEN。')
  }

  return (
    <div>
      <div style={{ ...boxStyle, background: 'var(--bg-side)' }}>
        <div style={{ fontSize: 12 }}>
          <strong>当前状态：</strong>
          {status ? (status.configured
            ? <span style={{ color: '#16a34a' }}>已配置（模型 {status.model}）</span>
            : <span style={{ color: 'var(--fg-muted)' }}>未配置，将使用本地解析兜底</span>)
            : '加载中…'}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>MinerU Token</label>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
          placeholder="留空表示不修改" style={inputStyle} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>解析模型</label>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={inputStyle}>
          <option value="vlm">vlm（推荐，精度最高）</option>
          <option value="pipeline">pipeline（更快）</option>
        </select>
      </div>

      <button className="btn-primary" onClick={() => void save()}>保存</button>
      {msg && <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 10 }}>{msg}</p>}

      <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 14, lineHeight: 1.7 }}>
        Token 申请：<a href="https://mineru.net" target="_blank" rel="noreferrer"
          style={{ color: 'var(--accent)' }}>mineru.net</a> → API 管理 → 创建 Token。
        <br />免费额度 1000 页/天。不配置时自动降级为本地解析（质量较低，不支持双栏重排与公式）。
        <br />
        <strong>修改方式：</strong>编辑 <code>backend/.env</code> 中的
        <code> MINERU_TOKEN=</code> 和 <code>MINERU_MODEL=</code>，然后重启服务。
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

function SystemTab() {
  const [info, setInfo] = useState<{ lib_root: string; db_path: string; documents: number; annotations: number; auth_enabled: boolean } | null>(null)

  useEffect(() => {
    void api.info().then(setInfo).catch(() => {})
  }, [])

  const row = (k: string, v: React.ReactNode) => (
    <div style={{ display: 'flex', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
      <span style={{ width: 110, color: 'var(--fg-muted)' }}>{k}</span>
      <span style={{ flex: 1, wordBreak: 'break-all' }}>{v}</span>
    </div>
  )

  return (
    <div>
      {info ? (
        <>
          {row('文献库路径', info.lib_root)}
          {row('数据库', info.db_path)}
          {row('文献数', info.documents)}
          {row('标注数', info.annotations)}
          {row('鉴权', info.auth_enabled ? '已启用' : '未启用（仅本地开发）')}
        </>
      ) : <div style={{ fontSize: 12 }}>加载中…</div>}
    </div>
  )
}
