# Paper Reader 设计文档 v0.2

> 个人自用论文阅读器。自写阅读器 UI 与全流程，重活全部拼开源。
> 状态：需求已冻结，配置已确定，待开工。

---

## 1. 决策汇总（已确认）

| # | 决策点 | 结论 | 带来的收益 |
|---|---|---|---|
| D1 | 运行形态 | **本地 Web**：浏览器 UI + Python 服务 | 免装 Rust/webkit2gtk；刷新即生效；未来可多设备访问 |
| D2 | 翻译与标注的关系 | **原文唯一真相 + 译文运行时叠加** | 换翻译引擎不需要迁移任何标注 |
| D3 | 数据组织 | **数据库优先**：导入即复制进库 | 移动/重命名不丢数据，同步只需管库 |
| D4 | 排版方式 | **重排渲染：段落流双语对照** | 绕开像素级坐标锚定，工作量降一档 |
| D5 | AI 接口 | **统一 OpenAI 兼容协议（三方 API）** | 一个接口覆盖 DeepSeek/Qwen/GLM/Ollama |
| D6 | 解析服务 | **MinerU 官方云 API**（免费，1000 页/天） | 不依赖本地 GPU，省磁盘，免维护 |
| D7 | 阅读器内核 | **pdf.js** | Web 生态事实标准，文本层/标注层现成 |
| D8 | 双语排版形式 | **段落内上下交错** | 长文阅读最自然，无左右跳视线 |
| D9 | 翻译粒度 | **段落级翻译 + 本地缓存** | 边滑边译不卡，重读零成本 |
| D10 | WebDAV 角色 | **仅备份与迁移** | 无冲突解决，实现最简 |
| D11 | 组织维度 | **文件夹 + 标签两套独立维度** | 一篇文献可多归属，SQL 直查 |
| D12 | 标注存储 | **结构化入库 + 可导出** | 可跨文献回顾，数据可带走 |
| D13 | 划词交互 | **选区气泡，同时给"高亮/翻译"两个动作** | 一次拖选覆盖两种意图 |
| D14 | 划词翻译来源 | **免费机翻 API 为主，AI 兜底** | 划词瞬时返回，省钱 |
| D15 | 前端栈 | **React 18 + TypeScript + Vite** | 生态最大，AI 辅助生成效果好 |
| D16 | MVP 顺序 | 详见第 6 节 | 每阶段都可独立使用 |
| D17 | 部署形态 | **本地开发验证 → 未来迁 VPS** | 要求代码从第一天就是环境可移植的 |
| D18 | 库根目录 | 代码 `ws/dev`，数据 `~/paper-reader` | 代码与数据分离，便于备份与迁移 |
| D19 | 界面语言 | **仅中文** | 不做 i18n 框架，省一层复杂度 |
| D20 | 情报雷达 | **Paper-Code Radar 内嵌为阅读器子系统**：多主题 arXiv 分类订阅 + 论文配套代码活性审计 + LLM 结构化评审 + 站内看板与每日 Markdown 归档（无外部推送） | 复用鉴权 / AI Provider / 一键导入通路；配置存 DB（UI 编辑，YAML 仅导入导出）；向量检索二期暂缓。详见 [docs/radar_srs.md](docs/radar_srs.md) |

### 部署可移植性的三条硬约束（源自 D17）

因为最终要搬到 VPS，以下三条从第一行代码起就必须成立，事后补代价极高：

1. **零硬编码路径**：库根目录、端口、API key 全部来自环境变量或 `settings` 表；
2. **零 GPU 依赖**：解析走云 API，架构中不得存在"本地算力"假设；
3. **鉴权从第一天就在**：即使本地自己用，也走同一个 token 中间件。否则上线时要改遍所有路由。

### 已知风险（必须带进设计）

- **R1 免费机翻 API 无官方保证**：Google/Bing 端点属社区逆向，可能失效或限流。→ 必须实现 Provider 降级链：机翻 → AI 接口，且 UI 上标出"译文来自机翻/AI"。
- **R2 磁盘仅剩 41G（95% 已用）**：→ 库根目录放 `~/paper-reader`（同盘，但代码数据分离）；因改用云 API，不再需要 2-3G 本地模型；备份策略只全量备份元数据+标注，PDF 可选。
- **R3 标注坐标还原**：pdf.js 选区坐标依赖渲染缩放比。→ 阶段一的验收标准就是"换缩放/重开应用后高亮位置不漂"。
- **R4 云 API 额度**：MinerU 免费 1000 页/天（超出的部分降优先级，不拒服务）。个人正常使用约占 5%，但批量导入上百篇时会触及。→ 需实现导入队列和额度感知（读响应头/错误码，超限则排队重试）。
- **R5 对外暴露后的安全问题**：VPS 上运行时，数据库里存着 API key 和全部文献。→ 必须 HTTPS + token 鉴权，且 API key 在库中加密存储（用环境变量提供的主密钥）。

---

## 2. 架构总览

```
┌─────────────────────────── 浏览器 (React + TS + Vite) ───────────────────────────┐
│  资源层          阅读层                        智能层              产出层          │
│  文件树/标签     pdf.js 渲染 + 标注层           AI 配置             标注列表        │
│  导入           段落流双语视图                  总结面板            跨文献回顾      │
│                 划词气泡（高亮/翻译）            划词翻译                          │
└───────────────────────────────────┬──────────────────────────────────────────────┘
                                    │ HTTP + WebSocket (progress stream)
                                    │ [token 中间件：本地/远程同一套]
┌───────────────────────────────────▼──────────────────────────────────────────────┐
│                    本体服务 (Python 3.10 + FastAPI)                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ library  │ │  parse   │ │ translate│ │   ai     │ │  notes   │ │ backup   │  │
│  │ 库/树/标签│ │MinerU云API│ │ 调度+缓存 │ │ Provider │ │ 标注 CRUD │ │ WebDAV   │  │
│  └──────────┘ └──────────┘ └────┬─────┘ └────┬─────┘ └──────────┘ └──────────┘  │
│                                 │            │                                   │
│                    ┌────────────▼────────────▼────────────┐                      │
│                    │  内部 adapter：seg 结构 / LLM 调用     │                      │
│                    └───────────────────────────────────────┘                     │
└───────────────────────────────────┬──────────────────────────────────────────────┘
                                    │
                    SQLite (WAL) + 文件系统 (md5 寻址)
                                    │
                    ┌───────────────┴───────────────┐
               MinerU 云 API                 OpenAI 兼容 API
              (免费 1000 页/天)              (三方服务商)
```

**分层原则**：浏览器只做渲染和交互，所有落盘、网络、重计算都在 Python 侧。服务本身是**无状态可迁移**的——本地机和 VPS 跑同一份二进制，只靠环境变量区分。

**为什么没有 sidecar**：最初计划用独立 sidecar 承载 MinerU 本地推理。改用云 API 后，解析退化为纯 HTTP 调用，sidecar 的价值（进程隔离、独立环境）不复存在，因此合并进主服务。这是决策变更带来的简化——模块边界（`parse` 适配器）保留，未来若要换回本地部署，只需替换适配器实现，不影响其他模块。

---

## 3. 数据模型

### 3.1 目录布局

```
/home/lq016/ws/dev/paper-reader/    # 代码目录
└── ...

~/paper-reader/                     # 数据目录（LIB_ROOT，可由环境变量覆盖）
├── library.db                      # SQLite（唯一真相源）
├── files/                          # PDF 原文，按 md5 前两位分桶
│   └── ab/abcdef123....pdf
├── parsed/                         # MinerU 产物，按 md5 分桶
│   └── ab/abcdef123.../
│       ├── content.md              # 结构化 Markdown（含 LaTeX 公式）
│       ├── content_list.json       # 段落级结构（含 bbox，供后续锚定用）
│       └── images/                 # 图表抽取
└── backups/                        # 本地导出（WebDAV 前的中转）
```

> **代码与数据分离**（D18）：代码在 `ws/dev/paper-reader/`（就是你当前工作区），数据在 `~/paper-reader/`。迁 VPS 时只需拷数据目录并改 `LIB_ROOT`。

### 3.2 表结构（初版，开工时细化）

```sql
-- 文献条目：一篇文献就是一个 document
CREATE TABLE documents (
  id            TEXT PRIMARY KEY,          -- uuid
  title         TEXT NOT NULL,
  authors       TEXT,                      -- JSON array
  year          INTEGER,
  journal       TEXT,
  doi           TEXT,
  abstract      TEXT,
  file_hash     TEXT UNIQUE NOT NULL,      -- md5，内容寻址去重
  file_size     INTEGER,
  page_count    INTEGER,
  parse_status  TEXT DEFAULT 'pending',    -- pending|running|done|failed
  added_at      TEXT NOT NULL,
  opened_at     TEXT
);

-- 层级：文件夹是树，documents 可多个（多归属）
CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE document_folders (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, folder_id)
);

-- 标签：独立维度，含颜色
CREATE TABLE tags (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#888888'
);
CREATE TABLE document_tags (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);

-- 标注：坐标用原始 PDF 页面坐标存储（不使用屏幕像素），见 R3
CREATE TABLE annotations (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL,           -- 1-based
  kind        TEXT NOT NULL,              -- highlight|underline|note|screenshot
  color       TEXT,
  rects       TEXT NOT NULL,              -- JSON: [[x1,y1,x2,y2],...] 归一化到页面宽高 0-1
  quote       TEXT,                       -- 选中的原文
  comment     TEXT,                       -- 用户写的笔记
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_ann_doc ON annotations(document_id, page);

-- 段落：MinerU 解析后落库，翻译以段落为单位
CREATE TABLE segments (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,           -- 全局序号，阅读顺序
  section     TEXT,                       -- Abstract/Intro/Method...
  kind        TEXT NOT NULL,              -- text|heading|formula|table|figure|caption|reference
  source      TEXT NOT NULL,              -- 英文原文（formula 存 LaTeX）
  bbox        TEXT,                       -- JSON，可选，后续做锚定用
  UNIQUE(document_id, idx)
);

-- 译文缓存：同一段落只翻一次
CREATE TABLE translations (
  segment_id   TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,             -- openai-compat|google-free|bing-free
  model        TEXT,
  target_lang  TEXT NOT NULL DEFAULT 'zh-CN',
  text         TEXT NOT NULL,
  token_in     INTEGER,
  token_out    INTEGER,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (segment_id, provider, target_lang)
);

-- AI 总结结果
CREATE TABLE summaries (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- overview|method|contributions|limitations|qa
  content     TEXT NOT NULL,              -- Markdown
  model       TEXT,
  created_at  TEXT NOT NULL
);

-- 服务配置（AI 端点、机翻开关、库路径等）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- JSON
);
```

**几个刻意设计**：

- `rects` 存**归一化到 0-1 的页面宽高比**，而不是像素或缩放后坐标。这是解决 R3 的关键：渲染时乘回当前视口尺寸，缩放就不会漂。
- `translations` 的主键包含 `provider`，意味着同一段可以同时有机翻版和 AI 版，切换引擎不必删缓存。
- `segments` 与 `annotations` **完全解耦**：标注只认 `page + rects`，翻译只认 `segment`。这正是 D2「原文唯一真相」在数据层的体现——翻译重跑不影响任何标注。

---

## 4. 模块拆解与开源复用

| 模块 | 来源 | 自写内容 | 预估 |
|---|---|---|---|
| library（库/树/标签） | 纯自写 | 导入、去重、树 CRUD、标签 CRUD、查询 | 小 |
| parse（解析） | **MinerU**（本地，GPU 加速） | 调用封装、进度流、产物落库、失败重试 | 中 |
| render（阅读器 UI） | **pdf.js** | 自定义工具栏、侧边栏、标注层、选区气泡 | **大（最大头）** |
| bilingual（段落流双语） | 自写 | 段落流布局、上下交错、滚动联动、渐进翻译 | 中 |
| translate（翻译调度） | 自写 + LLM | 段落切块、并发、缓存、术语表注入、降级链 | 中 |
| ai（Provider） | 自写 | OpenAI 兼容客户端、配置校验、超时重试、用量统计 | 小 |
| notes（标注） | 自写 | 选区→归一化坐标、渲染、CRUD、导出 Markdown | 中 |
| backup（WebDAV） | 自写（httpx） | 打包、上传、下载、恢复校验 | 小 |
| app（外壳） | 自写 | FastAPI 路由、WebSocket 进度、静态资源托管、启动脚本 | 中 |

**值得说明的取舍**：`render` 是唯一"大"的模块，也是唯一**没有好开源替代品**的部分——因为你要的是"自己写的阅读器 UI"。pdf.js 只提供渲染和文本层这两个底层能力，工具栏、侧边栏、标注交互、双语排版全部要自己搭。这是这个项目的真实成本所在，其余模块加起来也没它重。

---

## 5. 关键技术路径

### 5.1 标注坐标不漂移（对应 R3）

```
渲染时:  viewport = page.getViewport({scale})
选区时:  从 pdf.js 取 TextLayer 的 rect → 除以 viewport 尺寸 → 得到 0-1 归一化 rect
存储时:  只存归一化值（与缩放、DPI、窗口大小无关）
还原时:  rect * 当前 viewport 尺寸 → 绘制
```
验收：同一篇文档在 50%、100%、200% 缩放下高亮位置必须一致；重启应用后一致。

### 5.2 段落级渐进翻译（对应 D9）

1. 打开文献 → 拿到 `segments` 列表（解析阶段已落库）
2. 视口内可见段落 → 查 `translations` 缓存
3. 命中 → 直接渲染；未命中 → 进入翻译队列（并发 4-6，可配）
4. 结果写库 + 推送到前端增量渲染
5. 预取：当前视口下方 2 屏的段落提前入队

成本控制：`segments` 中 `kind` 为 `formula`/`figure`/`table` 的不翻译，只翻译 `text`/`heading`/`caption`。

### 5.3 AI 与机翻的降级链（对应 R1 + D14）

```
划词翻译:  Google 免费端点 ─失败/限流→ Bing 免费端点 ─失败→ OpenAI 兼容接口
全文翻译:  仅走 OpenAI 兼容接口（质量优先，且可注入术语表保证全文一致）
```
每次返回都带 `provider` 字段，UI 用角标标出来源，避免"不知道这段是谁翻的"。

### 5.4 术语表注入

`settings` 里存一份 `{英文术语: 中文译名}` 的 JSON。全文翻译时拼进 system prompt：
> 以下术语必须使用指定译名：attention → 注意力机制；...

这是小绿鲸"学科翻译"的实质，自己维护成本很低，效果提升明显。

---

## 6. 分阶段计划

### 阶段一：地基（必须最先做）
**交付**：导入 PDF → 文件夹/标签管理 → pdf.js 渲染 → 高亮/下划线/笔记 → 导出 Markdown。
**验收标准**：
- 导入时按 md5 去重，重复导入不产生第二份文件
- 标注在缩放与重启后位置准确（5.1 的验收）
- 一篇文献可同时属于多个文件夹和多个标签
- 能一键导出一篇文献的全部标注为 Markdown

**为什么先做这个**：它是唯一"不做就返工"的部分，且做完立刻就是可用的 PDF 阅读器，有独立价值。

### 阶段二：解析 + 双语精读
**交付**：MinerU 云 API 接入 → 段落流视图 → 段落级翻译缓存 → 上下交错双语 → 大纲导航。
**验收标准**：
- 首次打开论文时可见段落立即显示，译文渐进浮现不阻塞滚动
- 同一段落二次阅读零 API 调用（命中缓存）
- 公式以 LaTeX 渲染，图表作为图片内联
- 可切换"仅原文 / 双语 / 仅译文"
- 解析任务失败（含额度超限）时能在 UI 看到明确原因并可重试

### 阶段三：智能与备份
**交付**：AI 总结（概览/方法/贡献/局限）→ 划词气泡（高亮+翻译）→ WebDAV 备份与恢复。
**验收标准**：
- 划词翻译在 1 秒内出结果，失败自动降级且 UI 有提示
- 总结结果可重新生成、可保存多个版本
- 备份文件可在另一台机器完整恢复（含标注）

### 阶段四：打磨
全文搜索、快捷键体系、大 PDF 性能、标注跨文献回顾页、阅读进度记忆、主题切换。

---

## 7. 技术栈清单

**前端**
- React 18 + TypeScript + Vite
- pdf.js（`pdfjs-dist`）
- Zustand（状态管理，比 Redux 轻）
- Tailwind CSS（UI 快速成型）
- react-resizable-panels（三栏布局）
- KaTeX（公式渲染）

**后端**
- Python 3.10 + FastAPI + uvicorn
- SQLite（WAL 模式，`sqlite3` 标准库即可，不引入 ORM 负担）
- httpx（MinerU / AI / WebDAV 三类外部调用统一用它）
- cryptography（API key 加密存储，对应 R5）

**外部服务**
- MinerU 官方云 API（`https://mineru.net/api/v4`，免费 1000 页/天）
- OpenAI 兼容三方 API（翻译 + 总结）

**开发环境现状**
- Node v22.23.3 ✅ / Python 3.10.12 ✅
- Rust ❌（已不需要）/ webkit2gtk ❌（已不需要）/ 本地 GPU ❌（已不需要）
- ⚠️ 磁盘仅剩 41G — 已通过"数据放 `~/paper-reader`、不装本地模型"规避

---

## 8. 外部服务接入要点

### 8.1 MinerU 云 API

| 项 | 值 |
|---|---|
| Base | `https://mineru.net/api/v4` |
| 鉴权 | `Authorization: Bearer <token>`（在 mineru.net 的 API 管理页创建） |
| 单文件解析 | `POST /extract/task`，body 传 `url` �� `model_version: "vlm"` |
| 本地文件 | `POST /file-urls/batch` 拿签名上传链接 → `PUT` 上传 → 系统自动提交 |
| 查询结果 | `GET /extract/task/{task_id}`，`state` ∈ pending/running/done/failed |
| 额度 | 每账号每天 1000 页最高优先级；超出降优先级但不拒服务 |
| 限制 | 单文件 ≤200MB、≤200 页 |
| 产物 | `full_zip_url` 下载 zip，含 `full.md` + `content_list.json` + 图片 |

**注意**：`/extract/task` 只接受 URL，不接受直接上传。所以本地文件必须走 `/file-urls/batch` 的签名上传流程，或者在导入时把文件挂到一个公网可达的地址。**推荐用签名上传**（不依赖你的服务器有公网地址，本地开发也能跑）。

**回调替代轮询**：API 支持 `callback`，但本地开发时服务没有公网地址，收不到回调。统一用**轮询**实现，迁移 VPS 后再可选启用回调。

### 8.2 OpenAI 兼容 API

```
POST {base_url}/chat/completions
{
  "model": "<可配>",
  "messages": [...],
  "temperature": 0.3,
  "stream": true
}
```
配置项：`base_url`、`api_key`、`model`、`temperature`、`timeout`、`max_concurrency`。
`api_key` 落库前用 `cryptography.Fernet` 加密，主密钥来自环境变量 `PAPER_READER_SECRET`。

---

## 9. 环境变量契约

所有可配置项集中在环境变量（`.env`，不入库），确保本地→VPS 迁移只改这一个文件：

```bash
# 数据
LIB_ROOT=/home/lq016/paper-reader          # VPS 上改成对应路径
# 服务
HOST=127.0.0.1                              # VPS 上通常改 0.0.0.0
PORT=8787
AUTH_TOKEN=                                 # 留空则不启用鉴权（仅本地开发）
PAPER_READER_SECRET=                        # 用于加密库中 API key 的主密钥，必填
# MinerU
MINERU_TOKEN=
MINERU_MODEL=vlm
# AI（也可在 UI 里配置，UI 配置优先）
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
```

---

## 10. 开工前仅剩的待办

需求与配置已全部冻结。真正开始写代码前，只剩下面这些"要你去申请/准备"的一次性动作，不影响设计：

1. **MinerU token**：在 [mineru.net](https://mineru.net) 注册 → API 管理页创建 token。
2. **AI 服务商账号**：选一个 OpenAI 兼容的三方服务（如 DeepSeek / 硅基流动 / 阿里百炼），拿到 `base_url` + `key` + 一个便宜模型名。
3. **WebDAV 账号**：用于备份，任何支持 WebDAV 的网盘（坚果云 / Nextcloud / 群晖）都行。
4. **Linux 附加依赖**：前端跑起来不需要额外系统包；但若 `pdfjs-dist` 想走 canvas 加速，需确认 `libgl` 存在（可选，不影响功能）。

前两项不准备好也不阻碍开工——阶段一（纯本地阅读 + 标注）完全不依赖任何外部 API。

---

*本文档随决策更新。开工顺序见第 6 节，阶段一验收标准通过后再进入阶段二。*
