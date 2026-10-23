# Paper-Code Radar 需求规范 v1.0

> 通用多主题「前沿技术情报雷达与开源代码发现」子系统，内嵌于 Paper Reader 阅读器。
> 状态：P0 核心通路已实现（2026-10-22，含真实管道冒烟验证）；P1/P2 待开工。实现进度以本文档为准回写。

---

## 0. 与旧版（digest v1）的关系

现网运行的 digest v1（commit `31e85f9`：arXiv 关键词搜索 + GitHub 热门仓库 Star 增速
+ 关键词 Chips + 08:00 调度 + 一键导入阅读器）是本需求的前身。本子系统在其基础上
**演进升级、不推倒重来**，以下资产直接复用：

| 复用资产 | 说明 |
|---|---|
| 调度器 | `digest.py` 的 08:00（Asia/Shanghai）后台线程模型 |
| 防重机制 | `digest_history` 表 + ignored/imported 永不重复推荐 + 14 天冷却期 |
| 导入通路 | digest 条目 → 阅读器文献库 → 双语排版队列 |
| AI Provider | 现有 OpenAI 兼容接口客户端（UI ⚙ 已可配置） |
| GitHub Token 读取链 | 环境变量 `GITHUB_TOKEN` → settings 表 `github.token` |
| HTTP 客户端 | `core/http.make_client`（统一走代理与超时约定） |
| 前端骨架 | `DailyDigestView` 卡片流，升级为多 Topic 分栏看板 |

---

## 1. 系统定位与核心价值

* **多领域/多主题并存**：系统配置与研究领域解耦。支持同时监控多个完全独立的
  Topic（如「具身智能与机器人空间感知」「端侧 AI 部署与模型轻量化」「代码大模型与
  Agent」），每个 Topic 拥有独立的数据源订阅、过滤规则、评审侧重与展示分组。
* **代码可用性第一**：从论文中自动发现配套开源代码，深度检测 GitHub Repo 真实活性
  （是否存在、是否空仓、Star 数、主语言、最近提交），过滤纯占位仓库。
* **LLM 语义降噪**：拒绝机械关键词匹配，让 LLM 充当「资深技术 Reviewer」，按用户
  为每个 Topic 定义的关注维度提炼关键创新点与落地参考价值，输出结构化评审卡片。
* **本地化私有沉淀与检索**：论文评审通过即入库，沉淀为个人/团队的技术知识中枢，
  支持全文关键词检索与（二期）语义检索，一键导出 BibTeX 与 Markdown。

---

## 2. 总体架构

```text
               ┌────────────────────────────────────────────────────────┐
               │          Topic 配置中心 (settings 表 + 看板 UI)         │
               │      定义多主题 Topics、评审侧重、入选阈值与展示分组       │
               └──────────────────────────┬─────────────────────────────┘
                                          │
       ┌──────────────────────────────────┴──────────────────────────────┐
       ▼                                                                 ▼
[多源数据采集]                                                    [代码活性审计]
• arXiv 官方 API（按 cs.* 分类订阅）                               • 摘要/评论 GitHub 链接正则提取
• Papers With Code 每日数据（P2，可延后）                          • GitHub REST API 逐仓校验
• Hugging Face Daily Papers（P2，可延后）                          • 空仓/Star/语言/最近提交
       │                                                                 │
       └────────────────────────────┬────────────────────────────────────┘
                                    ▼
                        [两阶段智能过滤引擎]
                        Stage 1: 规则/关键词初筛（零 LLM 成本）
                        Stage 2: LLM 结构化评审与评分 (1~5)
                                    │
       ┌────────────────────────────┴────────────────────────────────────┐
       ▼                                                                 ▼
[看板展示与沉淀]                                                 [私有检索中心]
• 评审卡片流（复用阅读器 React UI，按 Topic 分栏）                • SQLite 元数据 + FTS5 全文检索
• 每日 Markdown 归档（Obsidian 兼容，见 §3.4）                    • 语义向量检索（二期，暂缓）
```

**架构硬约束（继承自阅读器主设计 D17/D18）**：

1. **零硬编码路径**：Topic 配置存 DB，密钥存 `.env` 或设置表（加密）；
2. **零 GPU 依赖**：LLM 评审与（二期）Embedding 全部走 OpenAI 兼容云 API；
3. **鉴权同源**：雷达全部 API 挂在阅读器现有 token 中间件之后，不单独开口子。

---

## 3. 功能需求

### 3.1 声明式 Topic 配置中心

系统核心逻辑数据驱动：**新增、修改关注领域只改配置，不改代码**。配置存 `settings`
表（键 `radar.topics`），通过看板 UI 增删改，支持 YAML 批量导入/导出。

每个 Topic 的完整结构：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 稳定唯一标识（如 `embodied_perception`），用于展示分组与防重关联 |
| `name` | string | 是 | 展示名（如「具身智能与机器人空间感知」） |
| `categories` | string[] | 是* | arXiv 分类订阅列表（如 `cs.RO`、`cs.CV`；与 keywords 至少一项） |
| `keywords` | string[] | 否 | 规则初筛关键词（任意命中即通过；为空则该 Topic 全量送 LLM） |
| `evaluation_focus` | string | 否 | 引导 LLM 评审的侧重点描述 |
| `min_score_to_show` | int | 是 | 入选看板与每日归档的评分阈值（1~5，默认 4） |

配置示例（即 YAML 导入/导出的格式约定）：

```yaml
topics:
  - id: "embodied_perception"
    name: "具身智能与机器人空间感知"
    categories: ["cs.RO", "cs.CV"]
    keywords: ["occupancy", "3D perception", "traversability", "stereo matching", "SLAM", "elevation map"]
    evaluation_focus: "重点关注实时性、几何结构表达、低算力端侧可行性及传感器融合方案。"
    min_score_to_show: 4

  - id: "edge_acceleration"
    name: "端侧 AI 部署与模型轻量化"
    categories: ["cs.CV", "cs.AI", "cs.LG"]
    keywords: ["quantization", "PTQ", "pruning", "NPU", "real-time", "edge device", "INT8"]
    evaluation_focus: "重点关注无损量化技术、硬件感知搜索、低显存低带宽推断架构。"
    min_score_to_show: 4
```

**验收标准**：
- UI 上新增/修改/删除 Topic 后，下一轮抓取立即按新配置生效，无需重启服务；
- YAML 导入时校验字段完整性，缺 `id`/`name` 或 `categories`/`keywords` 双空的条目
  整条拒绝并明确报错，**不得静默丢弃合法条目**；
- 删除 Topic 不删历史数据，归档查询仍可按原 Topic 过滤。

### 3.2 数据抓取与代码审计引擎

**FR-2.1 多源定时拉取（P0：arXiv 单源）**
- 按 Topic 的 `categories` 并集，调用 arXiv API 拉取各分类**最近 24 小时**新提交
  （`submittedDate` 倒序 + 提交时间窗口过滤，替换 v1 的关键词全字段 OR 搜索）；
- 同一篇论文命中多个 Topic 时按 Topic 分别评审、分别展示（`radar_papers` 按
  (id, topic_id) 存多行），评分与展示互不影响；
- `submittedDate` 解析失败或时区异常的条目直接丢弃，不允许「看起来新」的脏数据
  进入候选池（v1 踩过：被多年前的旧论文霸榜）。

**FR-2.2 代码可用性探测与打标（论文条目）**
- 正则扫描 Abstract 与 Comment 字段，提取 GitHub 链接：
  `https?://github\.com/(?P<owner>[A-Za-z0-9_.\-]+)/(?P<repo>[A-Za-z0-9_.\-]+)`
  （排除 `topics/`、`assets/` 等伪路径；`tree/`、`issues/`、`blob/` 子路径截断归一化）；
- 命中链接的仓库异步调用 GitHub API 校验并打标：
  - `is_valid`：仓库是否存在（非 404）；
  - `is_empty`：default branch 是否存在 commit（占位仓库判定）;
  - `stars`、`language`、`pushed_at`：活性佐证；
- 状态标记三态：`[Code Available]` / `[Placeholder]`（存在但空仓）/ `[No Code]`；
- 校验结果缓存到 `radar_repos` 表（见 4.1），同一仓库 7 天内不重复请求 API，
  避免重复消耗 GitHub 配额；
- **P0 保留 v1 的 GitHub 热门仓库发现流**（Star 增速黑马）作为独立卡片流；
  P2 再评估是否并入论文流。

**FR-2.3 Papers With Code / Hugging Face Daily Papers（P2，可延后）**
- PWC：拉取每日新论文的代码链接，作为 FR-2.2 正则提取的补充与交叉验证；
- HF Daily Papers：作为每日候选池的第二来源（去重键为 arXiv id）。

### 3.3 LLM 结构化评审管道

**触发条件**：仅评审通过规则初筛的论文（Stage 1 零成本，Stage 2 只花命中条目的钱）。

**输入 Payload**：

```json
{
  "paper": {
    "title": "...",
    "abstract": "...",
    "categories": ["cs.RO", "cs.CV"],
    "code_status": "code_available | placeholder | no_code"
  },
  "topic": {
    "name": "具身智能与机器人空间感知",
    "evaluation_focus": "重点关注实时性、几何结构表达、低算力端侧可行性及传感器融合方案。"
  }
}
```

**输出 Schema（LLM 返回 JSON，程序做严格校验）**：

```json
{
  "relevance_score": 4,
  "primary_tag": "3D Occupancy",
  "one_sentence_summary": "一句话讲清核心工作",
  "problem_solved": "针对……的问题",
  "core_innovation": "提出了……方法",
  "practical_value": "在……达到……，极易工程移植",
  "pass_filter": true
}
```

**工程约束**：
- 调用现有 AI Provider（OpenAI 兼容协议）；JSON 解析失败或字段缺失时自动重试 1 次
  （附加「必须只返回 JSON」的纠偏提示），再失败则标记该条 `review_failed`，不崩溃、
  不阻断批处理；
- 响应 `pass_filter=false` 或评分低于阈值的条目落库存档（供检索），但**不进入看板与每日归档**；
- 全批完成后写 `settings` 表用量记录（token 消耗），看板可见当日评审开销。

**验收标准**：
- 一次批量评审中单条 LLM 调用失败不影响其余条目；
- `one_sentence_summary` 等中文分析字段为空或非 JSON 时必须重试并留痕（status）。

### 3.4 看板展示与每日归档（本地沉淀，无外部推送）

**FR-4.1 评审卡片（站内看板）**
- 入选条件：`relevance_score >= min_score_to_show` **或** `Code Available`
  且评分 ≥ (阈值 - 1)；
- 卡片结构：
  - 头部：`[Score: ⭐⭐⭐⭐] [Topic: 空间感知] [Code: 🌟 142 Stars]`
  - 标题：英文原题（附 arXiv 链接）
  - 中文核心要点：痛点 / 方法 / 价值（来自 LLM 评审字段）
  - 操作：查看 PDF · 克隆 GitHub 代码 · 「📥 导入阅读器」（走 v1 已有通路）。

**FR-4.2 Markdown 每日归档**
- 每日汇总当日入选条目为一份 Markdown（按 Topic 分节），写入用户指定目录
  （默认 `LIB_ROOT/radar/`），文件名 `radar-YYYY-MM-DD.md`，可直接放进 Obsidian 库；
- 归档随每日管道自动生成，看板支持手动重新导出。

### 3.5 检索看板（P2）

**存储层（P0 先行）**：所有评审过的条目（含未过阈值）进入 `radar_papers` 表；
FTS5 虚表对 `title / abstract / one_sentence_summary / core_innovation` 建倒排索引。

**看板能力（复用阅读器 React 前端，替代原方案的 Streamlit）**：
- **自然语言检索（P0 仅 FTS5）**：对查询串做简单切词后布尔检索，按 Topic、代码
  状态、Star 阈值、日期范围过滤；语义向量混合检索（BGE 系）**明确列为二期**，
  本期不引入任何本地模型依赖；
- **动态筛选器**：Topic / 代码状态 / Star 阈值 / 日期范围；
- **导出**：一键复制标准 BibTeX；一键导出当日/检索结果为 Markdown；
- **聚合视图**：Topic 维度统计（每日入选数、平均分、代码可用率）。

**验收标准**：
- FTS5 检索毫秒级响应（千条级数据）；
- 检索结果中的条目可直接「导入阅读器」形成闭环。

---

## 4. 数据模型

### 4.1 新增表（轻量迁移，模式对齐 v1 的 `_ensure_digest_tables`）

```sql
-- Topic 配置（冗余落库便于归档回溯；运行时真源为 settings 表 radar.topics JSON）
CREATE TABLE IF NOT EXISTS radar_topics (
  id     TEXT PRIMARY KEY,           -- topic id（如 embodied_perception）
  name   TEXT NOT NULL,
  config TEXT NOT NULL,              -- JSON：完整 Topic 定义
  updated_at TEXT NOT NULL
);

-- 论文条目（含评审结果）
CREATE TABLE IF NOT EXISTS radar_papers (
  id            TEXT NOT NULL,       -- arxiv:<id>（去版本号）
  topic_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  authors       TEXT,                -- JSON array
  abstract      TEXT,
  categories    TEXT,                -- JSON array
  published     TEXT,
  code_status   TEXT DEFAULT 'no_code',   -- code_available|placeholder|no_code
  repo_url      TEXT,
  review_status TEXT DEFAULT 'pending',   -- pending|reviewed|review_failed|skipped
  review        TEXT,                -- JSON：LLM 评审卡片
  score         REAL,                -- 冗余 relevance_score，便于排序
  archived      INTEGER DEFAULT 0,   -- 已写入每日归档标记
  first_seen    TEXT NOT NULL,
  PRIMARY KEY (id, topic_id)
);

-- GitHub 仓库审计缓存（FR-2.2 的 7 天缓存载体）
CREATE TABLE IF NOT EXISTS radar_repos (
  full_name  TEXT PRIMARY KEY,       -- owner/repo（小写）
  is_valid   INTEGER,
  is_empty   INTEGER,
  stars      INTEGER,
  language   TEXT,
  pushed_at  TEXT,
  checked_at TEXT NOT NULL
);

-- FTS5 全文索引（external content 模式，跟随 radar_papers 同步）
CREATE VIRTUAL TABLE IF NOT EXISTS radar_fts USING fts5(
  paper_id UNINDEXED, title, abstract, summary_zh, innovation_zh,
  tokenize = 'unicode61'
);
```

### 4.2 与 v1 表的关系

- v1 的 `digest_items` / `digest_history` / `github_stars` 保留：`digest_history`
  继续承担 arXiv 条目防重；`github_stars` + 热门仓库流保留；
- 雷达论文条目使用独立 `radar_papers`，不与 `digest_items` 混写；同一论文同时出现
  在两个流时互不干扰。

---

## 5. API 设计（挂载于 `/api/radar/*`，走阅读器统一鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/radar/config` | 读取 Topics + 调度状态 |
| POST | `/api/radar/config` | 更新 Topics（含 YAML 导入文本） |
| GET | `/api/radar/config/export` | 导出 YAML 格式配置 |
| GET | `/api/radar/today` | 今日各 Topic 入选条目（分 Topic 分组返回） |
| POST | `/api/radar/refresh` | 立即执行一轮完整管道（抓取→审计→评审→归档） |
| GET | `/api/radar/archive` | 按日期/Topic/代码状态/分数检索历史（含 FTS5 检索参数 `q`） |
| POST | `/api/radar/papers/{id}/action` | ignore / import（复用 v1 用户动作语义） |
| POST | `/api/radar/papers/{id}/import-paper` | 导入阅读器文献库 + 双语排版队列（v1 通路） |
| GET | `/api/radar/papers/{id}/bibtex` | 生成标准 BibTeX |
| GET | `/api/radar/stats` | Topic 维度统计与 LLM 用量 |

---

## 6. 分阶段交付（Roadmap）

| 阶段 | 交付目标 | 核心工作项 | 预估 |
|---|---|---|---|
| **P0 核心通路** | 分类采集 → 代码审计 → LLM 评审 → 看板/归档 | ① arXiv 分类订阅拉取（24h 窗口）；② GitHub 链接正则提取 + REST 校验 + 三态打标 + 7 天缓存；③ LLM 结构化评审管道（重试与失败隔离）；④ `radar_*` 三表迁移 + FTS5；⑤ 每日 Markdown 归档；⑥ 看板按 Topic 分栏展示评审卡片 | 1 天 |
| **P1 配置与工程化** | 多主题解耦与防重持久化 | ① Topic UI 编辑器（含 YAML 导入/导出）；② FTS5 虚表接入检索；③ 条目防重与用户动作持久化对齐 v1 语义 | 1 天 |
| **P2 检索与扩展** | 知识库闭环 | ① 检索看板升级（筛选器 + BibTeX/Markdown 导出 + Topic 统计）；② Papers With Code / HF Daily Papers 数据源；③ 评估 GitHub 热门流是否并入 | 2 天 |
| **二期（暂缓）** | 语义检索 | API Embedding 或本地 bge-small-zh 存 sqlite-vec，混合检索。**本期不实现**，接口设计预留 `q` 参数扩展 | 择期 |

---

## 7. 待办（开工前需人工准备）

1. **GitHub Token**（可选）：提升 API 配额，否则限流 60 次/小时（审计一批论文
   仓库时可能不够）；已有 v1 的读取链可直接复用；
2. **LLM 服务确认**：现有 AI Provider 的模型需支持稳定 JSON 输出（DeepSeek/Qwen
   均可），无额外申请。

---

## 8. 决策记录（相对原 SRS 草案的裁剪）

| # | 原方案 | 采纳方案 | 理由 |
|---|---|---|---|
| C1 | 独立项目（config.yaml + Streamlit） | 内嵌阅读器，React 看板 | 复用鉴权/AI/导入通路，避免双服务运维 |
| C2 | config.yaml 为配置真源 | settings 表 + UI 编辑，YAML 仅导入/导出 | 与阅读器现有配置体验一致，VPS 部署免文件同步 |
| C3 | ChromaDB/sqlite-vec + BGE 向量 | 二期暂缓，P0-P2 仅 FTS5 | 先验证需求，避免过早引入向量栈；零 GPU 约束下 API Embedding 是唯一合规路线 |
| C4 | Papers With Code + HF 为 P0 数据源 | P0 仅 arXiv 单源，其余 P2 | 控制首版复杂度，单源即可验证两阶段管道 |
| C5 | v1 digest 推倒重写 | 演进复用（调度/防重/导入/AI/GitHub Token 链） | v1 上线仅一天且通路已验证，重写无收益 |
| C6 | 飞书/企微/钉钉/Slack/邮件多通道 Webhook 推送 | 删除：仅站内看板 + 每日 Markdown 归档 | 单人本地使用，群机器人推送维护成本高；Markdown 归档到 Obsidian 已满足沉淀需求 |

---

*本文档为 Paper-Code Radar 子系统的需求真源。实现过程中如与本文冲突，先改文档再改代码。*
