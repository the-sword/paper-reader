import { useEffect, useRef, useState } from 'react'
import {
  api,
  type AIConfig, type EngineInfo, type EngineTestResult,
} from '../api/client'
import { useStore } from '../stores/useStore'
import { toast } from '../stores/useToast'
import RadarTopicsEditor from './RadarTopicsEditor'

const AI_PRESETS = [
  { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { label: '阿里百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
]

type Tab = 'ai' | 'engines' | 'glossary' | 'bilingual' | 'mineru' | 'radar' | 'backup' | 'export' | 'system'

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('engines')

  const tabs: Array<[Tab, string]> = [
    ['engines', '翻译引擎'],
    ['ai', 'AI 接口'],
    ['glossary', '术语表'],
    ['bilingual', '双语 PDF'],
    ['mineru', 'MinerU'],
    ['radar', '🛰 雷达'],
    ['backup', '备份'],
    ['export', '导出'],
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
          {tab === 'bilingual' && <BilingualTab />}
          {tab === 'mineru' && <MinerUTab />}
          {tab === 'radar' && <RadarTopicsEditor />}
          {tab === 'backup' && <BackupTab />}
          {tab === 'export' && <ExportTab />}
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
  const selectedEngine = useStore((s) => s.selectedEngine)
  const setSelectedEngine = useStore((s) => s.setSelectedEngine)
  const refreshAIConfig = useStore((s) => s.refreshAIConfig)

  const load = () => {
    void api.getEnginesList().then((r) => setEngines(r.engines)).catch(() => {})
  }
  useEffect(load, [])

  /** 切换当前使用的引擎：写 store（划词/段落翻译立即生效）并持久化 */
  const pick = (name: string | null) => {
    setSelectedEngine(name)
    void api.savePrefs({ selected_engine: name ?? '' }).catch(() => {})
  }

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

      <div style={{ ...boxStyle, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>当前使用</div>
        <select
          value={selectedEngine ?? ''}
          onChange={(e) => pick(e.target.value || null)}
          style={{ flex: 1, maxWidth: 260 }}
        >
          <option value="">自动（按优先级降级）</option>
          {engines.filter((e) => e.enabled && e.configured).map((e) => (
            <option key={e.name} value={e.name}>{e.label}</option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          划词与段落翻译立即生效
        </div>
      </div>

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
                background: e.configured ? 'var(--ok-soft)' : '#9ca3af22',
                color: e.configured ? 'var(--ok)' : 'var(--fg-muted)',
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
                background: t.ok ? 'var(--ok-bg)' : 'var(--err-bg)',
                color: t.ok ? 'var(--ok-strong)' : 'var(--err)',
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
          background: testRes.ok ? 'var(--ok-bg)' : 'var(--err-bg)',
          color: testRes.ok ? 'var(--ok-strong)' : 'var(--err)',
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

/** 打开自动生成开关前的风险确认文案（明确成本：常驻内存 / 满核 CPU / LLM 费用） */
const BILINGUAL_AUTO_WARN =
  '自动生成会在每篇论文导入后常驻占用约 300MB 内存、每次满核 CPU 数分钟，' +
  '并产生额外 LLM 调用费用。低配 VPS 上可能造成界面卡顿。确定开启？'

/**
 * 「双语 PDF」设置页：导入后自动生成开关（默认关闭）+ 手动生成说明。
 *
 * 打开开关必须先经风险确认（BILINGUAL_AUTO_WARN），确认后才 PUT true；
 * 关闭无风险，直接 PUT false。
 */
function BilingualTab() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void api.getBabelDocAuto()
      .then((r) => setEnabled(r.enabled))
      .catch((e) => setMsg(String(e)))
  }, [])

  const save = async (next: boolean): Promise<void> => {
    // 打开属重成本操作：必须显式确认；用户取消则保持原状
    if (next && !window.confirm(BILINGUAL_AUTO_WARN)) return
    setMsg('')
    try {
      await api.setBabelDocAuto(next)
      setEnabled(next)
      setMsg(next ? '已开启：新导入的论文会自动排队生成双语 PDF' : '已关闭')
    } catch (e) {
      setMsg(String(e))
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 0, lineHeight: 1.7 }}>
        双语 PDF 由 BabelDOC 本地排版生成（保留原论文版式，左原文右译文）。
        生成属重计算操作：满核 CPU 数分钟 + LLM 调用费用。
        默认<b>不自动生成</b>，需要时在阅读器顶部点「双语 / 译文」手动生成。
      </p>

      <div style={{ ...boxStyle, display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled === null}
          style={{ width: 'auto', margin: 0 }}
          onChange={(e) => void save(e.target.checked)}
        />
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            导入后自动生成双语 PDF
            {enabled !== null && (
              <span style={{
                marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: enabled ? 'var(--ok-soft)' : '#9ca3af22',
                color: enabled ? 'var(--ok)' : 'var(--fg-muted)', fontWeight: 400,
              }}>{enabled ? '已开启' : '已关闭'}</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 3, lineHeight: 1.6 }}>
            每篇论文导入后自动排队（串行，同时只跑 1 个任务，峰值约 300MB 内存）。
          </div>
        </div>
      </div>

      {msg && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>{msg}</div>
      )}

      <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 14, lineHeight: 1.7 }}>
        手动生成：阅读器顶部「双语 / 译文」按钮（同样会先弹成本确认）。
        队列进度见顶栏的队列指示器，失败可在其中重试。
      </p>
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
            ? <span style={{ color: 'var(--ok)' }}>已配置（模型 {status.model}）</span>
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

      <PerfCheck />
    </div>
  )
}

/** 性能自检：评估当前机器能否跑得动各功能。 */
function PerfCheck() {
  const [res, setRes] = useState<import('../api/client').SelfCheckResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const run = async () => {
    setBusy(true); setErr('')
    try {
      setRes(await api.selfcheck(false))
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  const levelColor = (l: string) =>
    l === 'excellent' ? 'var(--ok)' : l === 'good' ? '#65a30d'
    : l === 'fair' ? '#d97706' : l === 'slow' ? '#dc2626' : 'var(--fg-muted)'

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 12 }}>性能自检</strong>
        <button
          className="btn-primary"
          style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 12px' }}
          onClick={() => void run()} disabled={busy}
        >{busy ? '检测中…' : res ? '重新检测' : '开始检测'}</button>
      </div>

      {!res && !busy && (
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
          检测 CPU / 内存 / 磁盘 / ONNX 推理性能，给出各功能的可用性结论。
          部署到 VPS 后跑一次就知道够不够用。约需 5-15 秒。
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: 'var(--err)' }}>{err}</div>}

      {res && (
        <>
          <div style={{
            padding: '8px 10px', borderRadius: 6, marginBottom: 10,
            background: 'var(--bg-side)', fontSize: 12, lineHeight: 1.6,
          }}>{res.verdict}</div>

          <div style={{ fontSize: 11, lineHeight: 1.9 }}>
            <div>
              CPU：
              <b>{res.cpu.cores} 核</b>
              <span style={{ color: levelColor(res.cpu.level), marginLeft: 6 }}>
                {res.cpu.desc}
              </span>
            </div>
            <div>
              内存：
              <b>{res.memory.total_mb} MB</b>
              {res.memory.swap_mb > 0 && ` / swap ${res.memory.swap_mb} MB`}
              {res.memory.swap_mb === 0 && res.memory.total_mb < 3072 && (
                <span style={{ color: '#d97706', marginLeft: 6 }}>建议加 swap</span>
              )}
            </div>
            {res.disk.write_mb_s !== undefined && (
              <div>
                磁盘写入：
                <b style={{ color: levelColor(res.disk.level) }}>{res.disk.write_mb_s} MB/s</b>
              </div>
            )}
            {res.onnx.available ? (
              <div>
                ONNX 推理：
                <b>{res.onnx.infer_ms} ms</b>
                <span style={{ color: 'var(--fg-muted)', marginLeft: 6 }}>
                  (加载 {res.onnx.load_s}s, {res.onnx.providers?.join('/')})
                </span>
              </div>
            ) : res.onnx.reason ? (
              <div style={{ color: 'var(--fg-muted)' }}>ONNX：{res.onnx.reason}</div>
            ) : null}
          </div>

          <div style={{ marginTop: 10 }}>
            {res.features.map((f) => (
              <div key={f.name} style={{
                display: 'flex', gap: 6, fontSize: 11,
                padding: '4px 0', alignItems: 'flex-start',
              }}>
                <span style={{ color: f.ok ? 'var(--ok)' : 'var(--err-bright)', flexShrink: 0 }}>
                  {f.ok ? '✓' : '✗'}
                </span>
                <span style={{ flexShrink: 0, width: 130 }}>{f.name}</span>
                <span style={{ color: 'var(--fg-muted)', flex: 1 }}>{f.note}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}


// ---------------------------------------------------------------------------

function BackupTab() {
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fileName, setFileName] = useState('paper-reader-backup.tar.gz')
  const [includePdfs, setIncludePdfs] = useState(false)
  /** 加密口令（仅本次会话使用，不落库） */
  const [backupPw, setBackupPw] = useState('')
  const [restorePw, setRestorePw] = useState('')
  const [cfg, setCfg] = useState<{ password_set: boolean; password_masked: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [remote, setRemote] = useState<{ exists: boolean; size_bytes?: number; last_modified?: string } | null>(null)

  useEffect(() => {
    void api.getBackupConfig().then((c) => {
      setUrl(c.url); setUsername(c.username); setFileName(c.file_name)
      setCfg({ password_set: c.password_set, password_masked: c.password_masked })
    }).catch((e) => setMsg(String(e)))
  }, [])

  const save = async () => {
    setMsg('')
    try {
      await api.saveBackupConfig({
        url: url.trim(),
        username: username.trim(),
        file_name: fileName.trim() || 'paper-reader-backup.tar.gz',
        ...(password ? { password } : {}),
      })
      const c = await api.getBackupConfig()
      setCfg({ password_set: c.password_set, password_masked: c.password_masked })
      setPassword('')
      setMsg('已保存')
    } catch (e) { setMsg(String(e)) }
  }

  const test = async () => {
    setBusy('test'); setMsg('')
    try {
      const r = await api.testBackup()
      setMsg(r.ok ? `✅ ${r.message}` : `❌ ${r.error}`)
    } catch (e) { setMsg(String(e)) } finally { setBusy(null) }
  }

  const run = async () => {
    setBusy('backup'); setMsg('')
    try {
      const r = await api.runBackup(includePdfs, backupPw || undefined)
      setMsg(`✅ 已上传 ${r.size_mb} MB（${r.file_count} 个文件）${r.encrypted ? '，已加密' : ''}`)
      const info = await api.remoteBackupInfo().catch(() => null)
      if (info) setRemote(info)
    } catch (e) { setMsg(`❌ ${String(e).replace(/^Error:\s*/, '')}`) } finally { setBusy(null) }
  }

  const checkRemote = async () => {
    setBusy('remote'); setMsg('')
    try {
      const r = await api.remoteBackupInfo()
      setRemote(r)
      setMsg(r.exists ? '远端已有备份' : '远端暂无备份')
    } catch (e) { setMsg(String(e)) } finally { setBusy(null) }
  }

  const restore = async () => {
    if (!confirm('确定从远端恢复？当前数据库会先另存一份再覆盖。')) return
    setBusy('restore'); setMsg('')
    try {
      const r = await api.restoreBackup(restorePw || undefined)
      setMsg(`✅ 已恢复 ${r.restored_files} 个文件，请重启服务；加密备份恢复后需重填 API 密钥`)
    } catch (e) { setMsg(`❌ ${String(e).replace(/^Error:\s*/, '')}`) } finally { setBusy(null) }
  }

  const fileRef = useRef<HTMLInputElement>(null)
  const restoreFromFile = async (f: File) => {
    if (!confirm(`从文件「${f.name}」恢复？当前数据库会先另存一份再覆盖。`)) return
    setBusy('restorefile'); setMsg('')
    try {
      const r = await api.restoreBackupFromFile(f, restorePw || undefined)
      setMsg(`✅ 已从文件恢复 ${r.restored_files} 个文件，请重启服务；加密备份恢复后需重填 API 密钥`)
    } catch (e) { setMsg(`❌ ${String(e).replace(/^Error:\s*/, '')}`) } finally { setBusy(null) }
  }

  const settingsFileRef = useRef<HTMLInputElement>(null)
  /** 只合并设置：不动库的其他数据、无需重启；同名键被文件值覆盖 */
  const importSettings = async (f: File) => {
    if (!confirm(`从「${f.name}」导入设置？同名设置会被覆盖（界面偏好/术语表/雷达配置等），文献与标注不受影响。`)) return
    setBusy('importsettings'); setMsg('')
    try {
      const r = await api.mergeSettingsFromFile(f, restorePw || undefined)
      setMsg(`✅ ${r.message}`)
    } catch (e) { setMsg(`❌ ${String(e).replace(/^Error:\s*/, '')}`) } finally { setBusy(null) }
  }

  const mergeFileRef = useRef<HTMLInputElement>(null)
  /** 文献级合并导入：标注/AI 按论文身份挂接，不动库的其他数据 */
  const mergeImport = async (f: File) => {
    setBusy('mergeimport'); setMsg('')
    try {
      const r = await api.mergeImportFromFile(f, restorePw || undefined)
      const d = r.documents
      const lines = [
        `✅ 合并导入：${d.total} 篇（同文件 ${d.by_hash} · 同论文重锚 ${d.by_identity} · 占位 ${d.placeholder}）`,
        `标注 ${r.annotations.imported} 条（跳过已有 ${r.annotations.skipped_existing}）`
        + ` · 总结 ${r.summaries.imported} · 会话 ${r.sessions.imported}`
        + ` · 新建文件夹 ${r.folders_created}/标签 ${r.tags_created}`,
      ]
      if (r.reanchor.docs > 0) {
        lines.push(`重锚：${r.reanchor.reanchored} 条成功，${r.reanchor.kept} 条保留原坐标`)
      }
      if (r.pdfs_attached_from_archive > 0) {
        lines.push(`归档自带 PDF ${r.pdfs_attached_from_archive} 份已就位`)
      }
      if (d.placeholder > 0) {
        lines.push('占位文献可稍后单独上传 PDF，上传后标注自动点亮')
      }
      setMsg(lines.join('\n'))
      // 书库列表立即出现新文献/占位
      void useStore.getState().refreshLibrary()
      void useStore.getState().refreshSidebar()
    } catch (e) {
      setMsg(`❌ ${String(e).replace(/^Error:\s*/, '')}`)
    } finally { setBusy(null) }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 0, lineHeight: 1.6 }}>
        WebDAV 仅用于备份与换机迁移（不做双向同步）。
        备份内容包含数据库、标注、翻译缓存与解析产物；PDF 原文可选。
      </p>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>WebDAV 地址</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://dav.jianguoyun.com/dav/paper-reader/"
          style={inputStyle} />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>用户名</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)}
          placeholder="邮箱或账号" style={inputStyle} />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>
          密码 {cfg?.password_set && <span>（已设置 {cfg.password_masked}）</span>}
        </label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder={cfg?.password_set ? '留空保持不变' : '应用专用密码'} style={inputStyle} />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>备份文件名</label>
        <input value={fileName} onChange={(e) => setFileName(e.target.value)}
          style={inputStyle} />
      </div>

      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={includePdfs} style={{ width: 'auto', margin: 0 }}
          onChange={(e) => setIncludePdfs(e.target.checked)} />
        <label style={{ fontSize: 12 }}>包含 PDF 原文（体积大，但换机后可完整恢复）</label>
      </div>

      <div style={{
        marginBottom: 12, padding: 10, borderRadius: 6,
        background: 'var(--bg-side)', fontSize: 11, lineHeight: 1.7,
      }}>
        <div style={{ marginBottom: 6, color: 'var(--fg-strong)', fontWeight: 600 }}>
          加密与密钥
        </div>
        <div style={{ marginBottom: 6, color: 'var(--fg-muted)' }}>
          备份会自动剔除 API 密钥（AI Key、MinerU Token、引擎密钥、WebDAV 密码），
          恢复后需在设置里重新填写。下方口令用于加密整个归档，不落库、不上传。
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input
            type="password" value={backupPw} onChange={(e) => setBackupPw(e.target.value)}
            placeholder="备份加密口令（留空则不加密）"
            style={{ flex: 1, fontSize: 12, padding: '5px 8px' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="password" value={restorePw} onChange={(e) => setRestorePw(e.target.value)}
            placeholder="恢复时输入口令（如备份已加密）"
            style={{ flex: 1, fontSize: 12, padding: '5px 8px' }}
          />
        </div>
        {backupPw && (
          <div style={{ marginTop: 6, color: 'var(--warn)' }}>
            ⚠️ 口令不会保存在任何地方，请自行牢记；丢失将无法恢复加密备份。
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn-primary" style={{ fontSize: 12 }} onClick={() => void save()}>保存配置</button>
        <button className="btn-ghost" style={{ fontSize: 12 }} disabled={!!busy} onClick={() => void test()}>
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
        <button className="btn-ghost" style={{ fontSize: 12 }} disabled={!!busy} onClick={() => void checkRemote()}>
          {busy === 'remote' ? '查询中…' : '查看远端'}
        </button>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-primary" style={{ fontSize: 12 }} disabled={!!busy} onClick={() => void run()}>
          {busy === 'backup' ? '备份中…' : '立即备份'}
        </button>
        <button className="btn-ghost" style={{ fontSize: 12 }} disabled={!!busy} onClick={() => void restore()}>
          {busy === 'restore' ? '恢复中…' : '从远端恢复'}
        </button>
        {/* 从本地上传的备份/完整导出文件恢复（与远端恢复同一管线与安全闸） */}
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.tgz,.enc,.tar.gz"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''  // 同一文件可重复选择
            if (f) void restoreFromFile(f)
          }}
        />
        <button className="btn-ghost" style={{ fontSize: 12 }} disabled={!!busy} onClick={() => fileRef.current?.click()}>
          {busy === 'restorefile' ? '导入中…' : '从文件导入…'}
        </button>
        {/* 只合并设置：部分导出（如仅设置）的安全出路，不动库的其他数据 */}
        <input
          ref={settingsFileRef}
          type="file"
          accept=".gz,.tgz,.enc,.tar.gz"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void importSettings(f)
          }}
        />
        <button
          className="btn-ghost"
          style={{ fontSize: 12 }}
          disabled={!!busy}
          title="只导入界面偏好/术语表/雷达配置等设置，文献与标注不受影响，无需重启"
          onClick={() => settingsFileRef.current?.click()}
        >
          {busy === 'importsettings' ? '导入中…' : '仅导入设置…'}
        </button>
        {/* 文献级合并：标注/AI 按论文身份挂接（hash → arXiv/DOI → 占位） */}
        <input
          ref={mergeFileRef}
          type="file"
          accept=".gz,.tgz,.enc,.tar.gz"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void mergeImport(f)
          }}
        />
        <button
          className="btn-ghost"
          style={{ fontSize: 12 }}
          disabled={!!busy}
          title="把导出文件里的文献/标注/总结合并进当前库：同一文件直接挂接，同论文不同版式自动重锚，未知论文建占位（PDF 可后补）"
          onClick={() => mergeFileRef.current?.click()}
        >
          {busy === 'mergeimport' ? '合并中…' : '合并导入…'}
        </button>
      </div>

      {remote && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--fg-muted)' }}>
          远端：{remote.exists
            ? `${((remote.size_bytes ?? 0) / 1024 / 1024).toFixed(2)} MB · ${remote.last_modified ?? ''}`
            : '无备份'}
        </div>
      )}

      {msg && (
        <div style={{
          marginTop: 12, fontSize: 12, padding: '7px 10px', borderRadius: 6,
          background: msg.startsWith('✅') ? 'var(--ok-bg)' : msg.startsWith('❌') ? 'var(--err-bg)' : 'var(--bg-side)',
          color: msg.startsWith('❌') ? 'var(--err)' : 'var(--fg)',
          lineHeight: 1.6, wordBreak: 'break-word',
        }}>{msg}</div>
      )}

      <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 14, lineHeight: 1.6 }}>
        坚果云：设置 → 安全 → 添加应用密码，地址填
        <code style={{ fontSize: 10 }}> https://dav.jianguoyun.com/dav/你的目录/ </code>
        <br />恢复操作会先把当前数据库另存为
        <code style={{ fontSize: 10 }}> library.db.before-restore-时间戳 </code>
        再覆盖。
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** 勾选这些类目时强制带上「文献库元数据」（后端同样强制） */
const LIBRARY_DEPS = ['annotations', 'ai', 'translations', 'parsed', 'pdfs']

function fmtBytes(n?: number): string {
  if (!n) return ''
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/**
 * 「导出」页：按类目勾选打包成 tar.gz 下载到本地（与备份同构）。
 * 全部勾选 = 可直接用于恢复的完整备份；部分导出仅供留存（恢复会被拒绝）。
 * 产物同时留在服务端 backups/ 目录，历史列表可再次下载或删除。
 */
function ExportTab() {
  const [meta, setMeta] = useState<Array<{ key: string; label: string; count: number; bytes?: number }>>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [exports, setExports] = useState<Array<{
    file_name: string; size_mb: number; created_at: string; encrypted: boolean
  }>>([])

  const loadList = () => {
    void api.listExports().then((r) => setExports(r.exports)).catch(() => {})
  }

  useEffect(() => {
    void api.exportMeta().then((r) => {
      setMeta(r.categories)
      // 默认全选：导出最常见的目的是迁移/恢复，默认部分类目会产出
      // 不可恢复的文件（恢复安全闸会拒绝），用户极易踩坑
      setSelected(new Set(r.categories.map((c) => c.key)))
    }).catch(() => {})
    loadList()
  }, [])

  /** 有依赖项时 library 强制勾选（与后端 normalize_categories 一致） */
  const depActive = LIBRARY_DEPS.some((k) => selected.has(k))
  const effective = (): Set<string> => {
    const s = new Set(selected)
    if (depActive) s.add('library')
    return s
  }
  const eff = effective()
  const allOn = meta.length > 0 && meta.every((c) => eff.has(c.key))

  const toggle = (key: string) => {
    setSelected((prev) => {
      const s = new Set(prev)
      if (s.has(key)) {
        if (key === 'library' && LIBRARY_DEPS.some((k) => s.has(k))) {
          toast.notice('文献库元数据会随所选类目自动包含')
          return prev
        }
        s.delete(key)
      } else {
        s.add(key)
      }
      return s
    })
  }

  const selectAll = () => {
    setSelected(allOn ? new Set() : new Set(meta.map((c) => c.key)))
  }

  const run = async () => {
    const cats = [...effective()]
    if (!cats.length) {
      toast.notice('请至少选择一个类目')
      return
    }
    setBusy(true)
    try {
      const r = await api.runExport(cats, password || undefined)
      // 触发浏览器下载（产物同时留在服务端 backups/，历史列表可再取）
      const a = document.createElement('a')
      a.href = api.exportDownloadUrl(r.file_name)
      a.download = r.file_name
      document.body.appendChild(a)
      a.click()
      a.remove()
      // 完整/部分导出的可恢复性完全不同，提示语必须区分开
      if (r.complete) {
        toast.success(`已导出 ${r.size_mb} MB · ${r.file_count} 个文件${r.encrypted ? '（已加密）' : ''}，可用于恢复`)
      } else {
        toast.notice(`已导出 ${r.size_mb} MB（部分类目）——仅供留存，不能用于恢复`)
      }
      loadList()
    } catch (e) {
      toast.error(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }

  const del = async (name: string) => {
    if (!confirm(`删除导出文件 ${name}？`)) return
    try {
      await api.deleteExport(name)
      loadList()
    } catch (e) {
      toast.error(String(e).replace(/^Error:\s*/, ''))
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 0, lineHeight: 1.6 }}>
        勾选类目打包为 tar.gz 下载（与备份同格式）。文件同时保留在服务端
        <code style={{ fontSize: 10 }}> backups/ </code>目录，可从下方列表再次下载。
      </p>

      {/* 类目列表 */}
      <div style={boxStyle}>
        {meta.length === 0 && <div style={{ fontSize: 12 }}>加载中…</div>}
        {meta.map((c) => {
          const on = eff.has(c.key)
          const locked = c.key === 'library' && depActive
          return (
            <label
              key={c.key}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 0', cursor: 'pointer', fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={locked}
                style={{ width: 'auto', margin: 0 }}
                onChange={() => toggle(c.key)}
              />
              <span>{c.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-muted)' }}>
                {c.key === 'library' && locked
                  ? '已随所选项自动包含'
                  : `${c.count} 条${c.bytes ? ` · ${fmtBytes(c.bytes)}` : ''}`}
              </span>
            </label>
          )
        })}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button className="btn-ghost" style={{ fontSize: 11 }} onClick={selectAll}>
            {allOn ? '全不选' : '全选'}
          </button>
          {allOn && (
            <span style={{ fontSize: 11, color: 'var(--ok)' }}>
              ✓ 全部类目：此导出与完整备份等价，可直接用于恢复
            </span>
          )}
        </div>
      </div>

      {/* 可选加密 + 执行 */}
      <div style={{ ...boxStyle, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="加密口令（留空则不加密）"
          style={{ flex: 1, fontSize: 12, padding: '6px 9px' }}
        />
        <button className="btn-primary" style={{ fontSize: 12 }} disabled={busy} onClick={() => void run()}>
          {busy ? '打包中…' : '导出并下载'}
        </button>
      </div>
      {password && (
        <div style={{ fontSize: 11, color: 'var(--warn)', marginBottom: 10, lineHeight: 1.6 }}>
          ⚠️ 口令不落库、不记录；忘记口令将无法打开加密导出。
        </div>
      )}

      {/* 历史导出 */}
      {exports.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>
            历史导出（服务端 backups/ 目录，{exports.length}）
          </div>
          {exports.map((x) => (
            <div
              key={x.file_name}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5,
                padding: '5px 0', borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.file_name}>
                {x.file_name}
              </span>
              <span style={{ color: 'var(--fg-muted)', flexShrink: 0 }}>
                {x.size_mb} MB{x.encrypted ? ' · 🔒' : ''}
              </span>
              <a
                className="btn-ghost"
                style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}
                href={api.exportDownloadUrl(x.file_name)}
                download={x.file_name}
              >下载</a>
              <button
                className="btn-ghost"
                style={{ fontSize: 11, padding: '2px 8px', color: 'var(--err)', flexShrink: 0 }}
                onClick={() => void del(x.file_name)}
              >删除</button>
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 14, lineHeight: 1.7 }}>
        · 全部类目的导出 = 完整备份：可在「备份 → 从文件导入…」直接恢复，或上传 WebDAV 后从远端恢复。
        <br />· 部分导出仅供留存与检视，整体恢复会被拒绝（防止清掉未包含的数据）；
        其中的「设置」类目可用「备份 → 仅导入设置…」合并到现有库。
        <br />· 导出会自动剔除密钥（AI Key、翻译引擎密钥、WebDAV 密码、GitHub Token）。
      </p>
    </div>
  )
}
