/**
 * 情报雷达 Topic 配置编辑器（设置对话框「雷达」tab）。
 *
 * 从旧 RadarView 配置页迁移而来：Topic 增删改（含分类选择器）、
 * 调度开关、YAML 导入/导出、LLM 用量展示。表单字段说明内联（HINTS）。
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type RadarStats, type RadarTopic } from '../api/client'
import CategoryPicker from './CategoryPicker'

const inputStyle: React.CSSProperties = {
  fontSize: 12, padding: '6px 10px', borderRadius: 6, width: '100%',
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', outline: 'none',
  boxSizing: 'border-box',
}

const fieldStyle: React.CSSProperties = {
  fontSize: 12, display: 'grid', gridTemplateColumns: '84px 1fr',
  gap: '4px 8px', alignItems: 'center',
}

// 字段说明写在表单里而不是靠用户记忆，placeholder 只在输入前可见，不够
const HINTS = {
  name: '显示在看板分组与筛选项上的名字，随意起',
  id: '内部标识，小写字母数字下划线；创建后不可改（历史归档靠它关联）',
  categories: '决定每天从 arXiv 抓哪些分类的论文；留空则这个 Topic 抓不到任何论文',
  keywords: '省钱开关：论文标题/摘要命中任一关键词才送 LLM 评审；留空则该分类全部论文都送审（耗 token）',
  focus: '告诉 LLM 评审时侧重看什么，影响打分与评语；留空则按通用标准评审',
  threshold: '评审分达到该值才出现在看板；带可用代码的论文阈值可放宽 1 分',
} as const

export default function RadarTopicsEditor() {
  const [topics, setTopics] = useState<RadarTopic[]>([])
  const [schedulerEnabled, setSchedulerEnabled] = useState(true)
  const [stats, setStats] = useState<RadarStats | null>(null)
  const [msg, setMsg] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [yamlText, setYamlText] = useState('')
  const [showYaml, setShowYaml] = useState(false)

  const load = useCallback(async () => {
    try {
      const [cfg, st] = await Promise.all([api.radarGetConfig(), api.radarStats()])
      setTopics(cfg.topics)
      setSchedulerEnabled(cfg.scheduler_enabled)
      setStats(st)
    } catch (e) {
      setMsg(`加载失败: ${String(e).replace(/^Error:\s*/, '')}`)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async (next: RadarTopic[], enabled?: boolean) => {
    setMsg('保存中…')
    try {
      const res = await api.radarSaveConfig({ topics: next, scheduler_enabled: enabled })
      setTopics(res.topics)
      setSchedulerEnabled(res.scheduler_enabled)
      setMsg(`已保存 ${res.topics.length} 个 Topic，下一轮抓取生效`)
    } catch (e) {
      setMsg(`保存失败: ${String(e).replace(/^Error:\s*/, '')}`)
    }
  }

  const updateTopic = (idx: number, patch: Partial<RadarTopic>) => {
    setTopics((cur) => cur.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }

  const addTopic = () => {
    const id = `topic_${Date.now().toString(36)}`
    setTopics((cur) => [...cur, {
      id, name: '新主题', categories: [], keywords: [],
      evaluation_focus: '', min_score_to_show: 4,
    }])
    setExpanded(id)
  }

  const removeTopic = (idx: number) => {
    setTopics((cur) => cur.filter((_, i) => i !== idx))
  }

  const doYamlExport = async () => {
    try {
      setYamlText(await api.radarExportYaml())
      setShowYaml(true)
      setMsg('已生成导出 YAML，可复制保存')
    } catch (e) {
      setMsg(`导出失败: ${String(e).replace(/^Error:\s*/, '')}`)
    }
  }

  const doYamlImport = async () => {
    if (!yamlText.trim()) return
    try {
      const res = await api.radarImportYaml(yamlText)
      setTopics(res.topics)
      setMsg(`导入完成：成功 ${res.imported} 条，拒绝 ${res.rejected} 条（共 ${res.total} 条）`)
      setShowYaml(false)
      setYamlText('')
    } catch (e) {
      setMsg(`导入失败: ${String(e).replace(/^Error:\s*/, '')}`)
    }
  }

  // LLM 用量：最近 7 天
  const usageRows = Object.entries(stats?.llm_usage || {}).sort(([a], [b]) => b.localeCompare(a)).slice(0, 7)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13.5 }}>监控主题（{topics.length}）</strong>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--fg-muted)' }}>
          <input type="checkbox" checked={schedulerEnabled}
            onChange={(e) => void save(topics, e.target.checked)} />
          工作日 08:00 自动运行管道
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn-ghost" style={btnS} onClick={addTopic}>＋ 新增</button>
          <button className="btn-ghost" style={btnS} onClick={() => void doYamlExport()}>导出 YAML</button>
          <button className="btn-ghost" style={btnS} onClick={() => { setShowYaml(true); setMsg('粘贴 YAML 后点「解析导入」') }}>导入 YAML</button>
          <button className="btn-primary" style={btnS} onClick={() => void save(topics)}>保存全部</button>
        </div>
      </div>

      {msg && <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 10 }}>{msg}</div>}

      {topics.length === 0 && (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--fg-muted)', fontSize: 12.5, border: '1px dashed var(--border)', borderRadius: 8 }}>
          暂无 Topic。点击「＋ 新增」或「导入 YAML」开始配置研究方向。
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {topics.map((t, idx) => {
          const isOpen = expanded === t.id
          return (
            <div key={t.id} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-side)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    {t.name || '(未命名)'}
                    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--fg-muted)' }}>
                      {t.id} · 阈值 {t.min_score_to_show}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.categories.length > 0 && `分类: ${t.categories.join(', ')}`}
                    {t.categories.length > 0 && t.keywords.length > 0 && ' · '}
                    {t.keywords.length > 0 && `关键词: ${t.keywords.join(', ')}`}
                    {!t.categories.length && !t.keywords.length && '（未配置分类与关键词）'}
                  </div>
                </div>
                <button className="btn-ghost" style={btnS} onClick={() => setExpanded(isOpen ? null : t.id)}>
                  {isOpen ? '收起' : '编辑'}
                </button>
                <button className="btn-ghost" style={btnS} title="删除（历史数据保留）"
                  onClick={() => removeTopic(idx)}>✕</button>
              </div>

              {isOpen && (
                <div style={{ padding: '2px 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Field label="名称" hint={HINTS.name}>
                    <input value={t.name} onChange={(e) => updateTopic(idx, { name: e.target.value })} style={inputStyle} />
                  </Field>
                  <Field label="Topic ID" hint={HINTS.id}>
                    <input value={t.id} disabled style={{ ...inputStyle, color: 'var(--fg-muted)', background: 'var(--bg)' }} />
                  </Field>
                  <Field label="arXiv 分类" hint={HINTS.categories}>
                    <CategoryPicker value={t.categories}
                      onChange={(categories) => updateTopic(idx, { categories })} />
                  </Field>
                  <Field label="初筛关键词" hint={HINTS.keywords}>
                    <input value={t.keywords.join(', ')}
                      onChange={(e) => updateTopic(idx, { keywords: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })}
                      placeholder="occupancy, SLAM, NPU（逗号分隔）" style={inputStyle} />
                  </Field>
                  <Field label="LLM 评审侧重" hint={HINTS.focus}>
                    <textarea value={t.evaluation_focus} rows={2}
                      onChange={(e) => updateTopic(idx, { evaluation_focus: e.target.value })}
                      placeholder="引导 LLM 的关注维度，如：重点关注实时性、低算力端侧可行性"
                      style={{ ...inputStyle, resize: 'vertical' }} />
                  </Field>
                  <Field label="入选阈值" hint={HINTS.threshold}>
                    <select value={t.min_score_to_show}
                      onChange={(e) => updateTopic(idx, { min_score_to_show: Number(e.target.value) })}
                      style={{ ...inputStyle, width: 130 }}>
                      {[3, 4, 5].map((n) => <option key={n} value={n}>{n} 分及以上</option>)}
                    </select>
                  </Field>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* LLM 用量 */}
      {usageRows.length > 0 && (
        <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>LLM 评审用量（近 7 天）</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ color: 'var(--fg-muted)', textAlign: 'left' }}>
                <th style={{ fontWeight: 500, padding: '3px 0' }}>日期</th>
                <th style={{ fontWeight: 500 }}>调用</th>
                <th style={{ fontWeight: 500 }}>输入 tokens</th>
                <th style={{ fontWeight: 500 }}>输出 tokens</th>
              </tr>
            </thead>
            <tbody>
              {usageRows.map(([d, u]) => (
                <tr key={d} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '4px 0' }}>{d}</td>
                  <td>{u.calls}</td>
                  <td>{u.token_in.toLocaleString()}</td>
                  <td>{u.token_out.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* YAML 导入/导出 */}
      {showYaml && (
        <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 8 }}>
            YAML 格式（与导出一致）。导入逐条校验：非法条目拒绝，合法条目按 id 合并更新。
          </div>
          <textarea value={yamlText} rows={10}
            onChange={(e) => setYamlText(e.target.value)}
            placeholder={'topics:\n  - id: "embodied_perception"\n    name: "具身智能"\n    categories: ["cs.RO", "cs.CV"]\n    keywords: ["occupancy", "SLAM"]\n    evaluation_focus: "重点关注实时性"\n    min_score_to_show: 4'}
            style={{ width: '100%', fontSize: 12, fontFamily: 'monospace', padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', outline: 'none', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn-primary" style={btnS} onClick={() => void doYamlImport()}>解析导入</button>
            <button className="btn-ghost" style={btnS} onClick={() => setShowYaml(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

const btnS: React.CSSProperties = {
  fontSize: 12, padding: '5px 12px', border: '1px solid var(--border)',
}

function Field({ label, hint, children }: {
  label: string; hint: string; children: React.ReactNode
}) {
  return (
    <label style={fieldStyle}>
      <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
      {children}
      <span style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.5, gridColumn: '2' }}>{hint}</span>
    </label>
  )
}
