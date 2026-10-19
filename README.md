# Paper Reader

个人自用论文阅读器。自写阅读器 UI，重活拼开源（pdf.js / MinerU / OpenAI 兼容 API）。

设计文档见 [DESIGN.md](DESIGN.md)。

## 快速开始

```bash
# 1. 后端依赖（系统已具备大部分）
cd backend && pip3 install -r requirements.txt

# 2. 前端依赖
cd frontend && npm install

# 3. 一键启动（开发模式，前端热更新）
cd .. && ./start.sh
# 打开 http://127.0.0.1:5173
```

生产模式（单人使用，单端口）：

```bash
./start.sh prod        # 构建前端并启动，访问 http://127.0.0.1:8787
```

## 目录结构

```
paper-reader/
├── backend/
│   ├── app/
│   │   ├── api/          # 路由：documents / folders / tags / annotations / system
│   │   ├── core/         # config（环境变量）、db（SQLite 建表与连接）
│   │   ├── services/     # library（库/树/标签）、notes（标注与导出）
│   │   └── main.py       # FastAPI 入口、鉴权中间件、静态托管
│   ├── .env.example      # 环境变量模板，复制为 .env
│   └── requirements.txt
└── frontend/
    └── src/
        ├── api/          # fetch 封装
        ├── components/   # Sidebar / DocumentList / PdfViewer / NotePanel
        ├── stores/       # Zustand 状态
        └── styles/
```

数据目录默认 `~/paper-reader/`（`library.db` + `files/` + `parsed/` + `backups/`），
可通过 `LIB_ROOT` 环境变量改写。

## 当前进度

| 环节 | 状态 |
|---|---|
| 文件导入（拖拽/选择、sha256 去重） | ✅ |
| 文件夹树 + 标签（两套独立维度） | ✅ |
| PDF 渲染（pdf.js canvas + 可选中文本层） | ✅ |
| 选区高亮 / 标注入库 / 删除 | ✅ |
| 标注面板、写笔记、导出 Markdown | ✅ |
| 缩放（50%–400%）下标注不漂移 | ✅ 已验证 |
| 面板宽度拖拽 / 响应式布局 | ✅ 已验证（900–1920px 无溢出无交叠） |
| 缩放：± 按钮、适应宽度、快捷键 | ✅ 已验证（打开文献自动适应宽度） |
| 鉴权中间件（本地可留空） | ✅ 已内置 |
| 全文解析：MinerU 云 API | ✅ 已接入（需 token） |
| 全文解析：本地兜底（无密钥可用） | ✅ PyMuPDF，标题/章节自动识别 |
| 段落流双语阅读（上下交错） | ✅ |
| 渐进翻译（视口触发 + 预取 + 缓存） | ✅ |
| 仅原文 / 双语对照 / 仅译文 三模式 | ✅ |
| 大纲导航（章节跳转） | ✅ |
| AI 接口配置（OpenAI 兼容 + 术语表） | ✅ |
| 划词翻译 / AI 总结 | ⬜ 阶段三 |
| WebDAV 备份 | ⬜ 阶段三 |

### 两种解析引擎

| 引擎 | 条件 | 质量 |
|---|---|---|
| MinerU 云 API | 需 `MINERU_TOKEN` | 最好：双栏重排、公式 LaTeX、表格结构 |
| 本地兜底 | 无需任何配置 | 一般：按字号识别标题，不做双栏重排 |

前端点「解析全文」时自动选择：有 token 用 MinerU，没有则用本地。

## 配置

复制 `backend/.env.example` 为 `backend/.env` 后按需填写。

**配置文件可以放在两处**（程序都会读取，`backend/.env` 优先）：

- `paper-reader/.env`（项目根目录）
- `paper-reader/backend/.env`

空值不会覆盖另一处的非空值，所以你可以只在一处填 key。

**MinerU 与 AI 的 token 请直接写进 `.env`**（该文件已在 `.gitignore` 中），
不要提交到版本库，也不要贴在对话记录里。

AI 接口也可以在界面右上角 ⚙ 里配置，配置项存在本地数据库（settings 表），
优先级高于环境变量。设置页支持填写术语表（每行 `英文=中文`），翻译时会注入
prompt 保证全文译名一致。

### 限流处理

翻译时会遇到中转站的 rpm/tpm 限流（HTTP 429）。程序会自动指数退避重试
（1s → 2s → 4s → 8s，最多 5 次），并尊重服务端的 `Retry-After`。
前端并发默认为 2，失败连续 3 次会停止本批并提示。

若频繁限流，可调小 `frontend/src/stores/useStore.ts` 里的 `CONCURRENCY`。

### 代理

若本机需要代理访问外部 API，在 `.env` 里填 `PAPER_READER_PROXY`。
默认**不读取**系统代理环境变量，因为 `all_proxy` + 含 `[::1]` 的 `no_proxy`
会让 httpx 解析出错（报 `Invalid port: ':1]'`）。需要沿用系统代理时设
`PAPER_READER_USE_ENV_PROXY=1`。

## 关键设计约定

- **标注坐标一律归一化到 0-1**（相对页面宽高），与缩放、DPI、窗口尺寸无关。
- **翻译与标注解耦**：标注只认 `page + rects`，翻译只认 `segment`，换翻译引擎不需要迁移标注。
- **所有路径来自环境变量**，保证本地 → VPS 迁移只改 `.env`。
- **鉴权中间件从第一天就在**，`AUTH_TOKEN` 留空则关闭（仅本地开发）。
