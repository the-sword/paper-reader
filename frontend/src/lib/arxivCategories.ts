/**
 * arXiv 分类速查表（arxiv.org/category_taxonomy，2025-08 快照）。
 *
 * 用途：Topic 配置的「arXiv 分类」搜索选择器。对 arXiv 不熟悉的用户
 * 直接输中文（如「机器人」「大模型」）或英文缩写即可匹配到分类。
 *
 * kw 为小写检索串：id + 英文名 + 中文 + 常用别名，搜索用 includes 匹配。
 * 清单静态且极少变动，直接内置前端，无需后端接口。
 */

export interface ArxivCategory {
  id: string
  zh: string
  kw: string
}

const c = (id: string, zh: string, alias = ''): ArxivCategory => ({
  id,
  zh,
  kw: `${id} ${zh} ${alias}`.toLowerCase(),
})

export const ARXIV_CATEGORIES: ArxivCategory[] = [
  // ---- Computer Science ----
  c('cs.AI', '人工智能', 'artificial intelligence ai 智能体 agent 大模型'),
  c('cs.CL', '计算语言学（NLP/大模型）', 'computation and language nlp llm 语言 语音对话 gpt transformer'),
  c('cs.CV', '计算机视觉与模式识别', 'computer vision 视觉 图像 检测 分割 recognition'),
  c('cs.LG', '机器学习', 'machine learning 深度学习 deep learning neural 神经网络'),
  c('cs.RO', '机器人学', 'robotics robot 机器人 具身 embodied 机械臂 导航 slam 无人机'),
  c('cs.MA', '多智能体系统', 'multiagent 多智能体 agent swarm 集群'),
  c('cs.GR', '图形学', 'graphics 渲染 3d 三维 建模 nerf gaussian splatting'),
  c('cs.HC', '人机交互', 'human-computer interaction hci 界面 交互'),
  c('cs.IR', '信息检索', 'information retrieval 搜索 推荐 rag 检索增强'),
  c('cs.AR', '硬件架构', 'hardware architecture 芯片 电路 嵌入式'),
  c('cs.CC', '计算复杂性', 'complexity 复杂性'),
  c('cs.CE', '计算工程金融与科学', 'engineering finance 计算工程'),
  c('cs.CG', '计算几何', 'computational geometry 几何'),
  c('cs.CR', '密码学与安全', 'cryptography security 安全 密码 隐私 对抗攻击'),
  c('cs.CY', '计算机与社会', 'society 社会 伦理 公平'),
  c('cs.DB', '数据库', 'database 数据库 查询'),
  c('cs.DC', '分布式并行与集群计算', 'distributed parallel 分布式 并行 集群 推理加速'),
  c('cs.DL', '数字图书馆', 'digital libraries 数字图书馆'),
  c('cs.DM', '离散数学', 'discrete math 离散'),
  c('cs.DS', '数据结构与算法', 'data structures algorithms 算法'),
  c('cs.ET', '新兴技术', 'emerging technologies 新兴技术 量子计算'),
  c('cs.FL', '形式语言与自动机', 'formal languages automata 自动机 形式化验证'),
  c('cs.GL', '综合文献', 'general literature'),
  c('cs.GT', '计算机科学与博弈论', 'game theory 博弈'),
  c('cs.IT', '信息论', 'information theory 信息论 编码'),
  c('cs.LO', '计算机逻辑', 'logic 逻辑 证明'),
  c('cs.MM', '多媒体', 'multimedia 多模态 多媒体'),
  c('cs.MS', '数学软件', 'mathematical software'),
  c('cs.NA', '数值分析', 'numerical analysis 数值'),
  c('cs.NE', '神经与进化计算', 'neural evolutionary 神经进化 神经形态 脉冲 spiking'),
  c('cs.NI', '网络与互联网架构', 'networking 网络 5g'),
  c('cs.OH', '计算机科学其他', 'other'),
  c('cs.OS', '操作系统', 'operating systems 操作系统'),
  c('cs.PF', '性能', 'performance 性能'),
  c('cs.PL', '编程语言', 'programming languages 编程语言 编译'),
  c('cs.SC', '符号计算', 'symbolic computation 符号'),
  c('cs.SE', '软件工程', 'software engineering 软件工程 代码生成'),
  c('cs.SD', '声音', 'sound audio 声音 音频 tts asr 语音合成'),
  c('cs.SI', '社交与信息网络', 'social information networks 社交网络 图'),
  c('cs.SY', '系统与控制', 'systems control 控制 系统'),

  // ---- Electrical Engineering and Systems Science ----
  c('eess.AS', '音频与语音处理', 'audio speech 音频 语音 asr tts 说话人'),
  c('eess.IV', '图像与视频处理', 'image video 图像 视频 压缩 增强 医学影像'),
  c('eess.SP', '信号处理', 'signal processing 信号 雷达 通信 频谱'),
  c('eess.SY', '系统与控制', 'systems control 控制 系统 电力'),

  // ---- Statistics ----
  c('stat.ML', '统计机器学习', 'statistics machine learning 机器学习 统计学习'),
  c('stat.AP', '统计应用', 'applications 应用统计'),
  c('stat.CO', '统计计算', 'computation 统计计算'),
  c('stat.TH', '统计理论', 'theory 统计理论'),

  // ---- Mathematics（AI 研究常用）----
  c('math.OC', '优化与控制', 'optimization control 优化 最优控制 运筹'),
  c('math.PR', '概率', 'probability 概率 随机'),
  c('math.ST', '统计理论', 'statistics theory 统计'),
  c('math.DS', '动力系统', 'dynamical systems 动力系统 混沌'),
  c('math.IT', '信息论', 'information theory 信息论'),
  c('math.NA', '数值分析', 'numerical analysis 数值'),

  // ---- Quantitative Biology ----
  c('q-bio.QM', '定量生物学方法', 'quantitative methods 定量 生信'),
  c('q-bio.NC', '神经与认知', 'neurons cognition 神经 认知 脑科学'),

  // ---- Quantitative Finance ----
  c('q-fin.TR', '交易与市场微观结构', 'trading 交易 量化'),
  c('q-fin.CP', '计算金融', 'computational finance 计算金融'),
  c('q-fin.ST', '统计金融', 'statistical finance 统计'),
  c('q-fin.PR', '证券定价', 'pricing 定价'),
  c('q-fin.RM', '风险管理', 'risk 风险'),
  c('q-fin.PM', '投资组合管理', 'portfolio 投资组合'),
  c('q-fin.GN', '一般金融', 'general finance'),

  // ---- Economics ----
  c('econ.EM', '计量经济学', 'econometrics 计量'),
  c('econ.GN', '一般经济学', 'general economics'),
  c('econ.TH', '理论经济学', 'theory 理论'),

  // ---- Physics（常用子库）----
  c('physics.comp-ph', '计算物理', 'computational physics 计算物理 模拟'),
  c('physics.data-an', '数据分析与统计物理', 'data analysis 数据分析'),
  c('physics.optics', '光学', 'optics 光学 光子'),
  c('physics.med-ph', '医学物理', 'medical physics 医学 影像'),
  c('physics.app-ph', '应用物理', 'applied physics'),
  c('physics.flu-dyn', '流体力学', 'fluid dynamics 流体 cfd'),
  c('physics.ins-det', '仪器与探测', 'instrumentation 探测 传感器'),
  c('physics.soc-ph', '社会物理', 'social physics 社会'),
  c('physics.chem-ph', '化学物理', 'chemical physics 化学'),
  c('physics.atom-ph', '原子物理', 'atomic physics 原子'),
  c('physics.plasm-ph', '等离子体物理', 'plasma 等离子体 聚变'),
  c('physics.space-ph', '空间物理', 'space 空间'),
  c('physics.ao-ph', '大气与海洋物理', 'atmospheric ocean 大气 海洋'),
  c('astro-ph', '天体物理（整个子库）', 'astrophysics 天文'),
  c('cond-mat', '凝聚态物理（整个子库）', 'condensed matter 材料'),
  c('gr-qc', '广义相对论与量子宇宙学', 'general relativity quantum cosmology 引力'),
  c('hep-ex', '粒子物理实验', 'high energy experiment 对撞机'),
  c('hep-lat', '格点量子场论', 'lattice 格点'),
  c('hep-ph', '粒子物理现象学', 'high energy phenomenology'),
  c('hep-th', '粒子物理理论', 'high energy theory 弦论'),
  c('math-ph', '数学物理', 'mathematical physics'),
  c('nlin', '非线性科学（整个子库）', 'nonlinear 非线性 复杂系统'),
]

const BY_ID = new Map(ARXIV_CATEGORIES.map((x) => [x.id.toLowerCase(), x]))

export function categoryLabel(id: string): string {
  const hit = BY_ID.get(id.toLowerCase())
  return hit ? `${id} ${hit.zh}` : id
}

/** 关键词 → 分类匹配：id/中文/别名 includes 命中；id 前缀命中排前。
 *  remote 为后端同步的 arXiv 官方最新清单（{id: 英文名}），仅补充
 *  内置表没有的条目（arXiv 新增分类时无需改代码），中文名缺失时显示英文名。 */
export function searchCategories(
  query: string, limit = 8, remote: Record<string, string> = {},
): ArxivCategory[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hit = ARXIV_CATEGORIES.filter((x) => x.kw.includes(q))
  hit.sort((a, b) => Number(b.id.startsWith(q)) - Number(a.id.startsWith(q)))
  const out = hit.slice(0, limit)
  if (out.length < limit) {
    const known = new Set(ARXIV_CATEGORIES.map((x) => x.id.toLowerCase()))
    for (const [id, en] of Object.entries(remote)) {
      if (out.length >= limit) break
      const lid = id.toLowerCase()
      if (known.has(lid)) continue
      if (lid.includes(q) || en.toLowerCase().includes(q)) {
        out.push({ id, zh: en, kw: `${id} ${en}`.toLowerCase() })
      }
    }
  }
  return out
}

/** 宽松校验手工输入的自定义分类（如 cs2.LG? 不放行；physics.data-an 放行）。 */
export function looksLikeCategoryId(s: string): boolean {
  return /^[a-z-]+\.[a-z-]+$/i.test(s.trim())
}
