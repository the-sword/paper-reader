# Paper Reader

个人自用论文阅读器。自写阅读器 UI，重活拼开源（pdf.js / MinerU / OpenAI 兼容 API / arXiv）。

设计文档见 [DESIGN.md](DESIGN.md)。

## 快速开始

```bash
# 1. 后端依赖
cd backend && pip3 install -r requirements.txt

# 2. 前端依赖
cd frontend && npm install

# 3. 一键启动
cd .. && ./start.sh
# 开发模式（前端热更新）：访问 http://127.0.0.1:5173
# 生产模式（单端口）：./start.sh prod → http://127.0.0.1:8787
```

数据目录默认 `~/paper-reader/`（`library.db` + `files/` + `parsed/` + `backups/`），
可通过 `LIB_ROOT` 环境变量改写。

> **核心阅读功能零依赖外部服务**：文献管理、PDF 阅读、标注、本地解析全部离线可用。
> 只有翻译和 AI 总结需要网络。

## 目录结构

```
paper-reader/
├── backend/
│   ├── app/
│   │   ├── api/          # 路由：documents / folders / tags / annotations / reading / phase3 / arxiv
│   │   ├── core/         # config（环境变量）、db（SQLite + 迁移）、http（代理处理）
│   │   ├── services/     # library / parser / translate / engines / mineru / arxiv /
│   │   │                 # summarize / jobs / notes / backup / prefs / glossary_cache
│   │   └── main.py       # FastAPI 入口、鉴权中间件、静态托管
│   ├── .env.example      # 环境变量模板，复制为 .env
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── api/          # fetch 封装
│       ├── components/   # Sidebar / DocumentList / PdfViewer / ReadingView / NotePanel /
│       │                 # SummaryPanel / ReaderSettings / ArxivPanel / SettingsDialog /
│       │                 # RichText / MarkdownView / RightPanel / Resizer
│       ├── stores/       # Zustand 状态
│       └── styles/       # 主题变量与全局样式
├── start.sh              # 一键启动（dev / prod）
├── export.sh             # 打包迁移到另一台机器
└── DESIGN.md             # 设计文档
```

---

## 功能清单

### 资源管理
| 功能 | 说明 |
|---|---|
| PDF 导入 | 拖拽或选择，sha256 内容寻址**自动去重** |
| **arXiv 添加** | 关键词搜索 / DOI 反查 Crossref → 匹配 arXiv → 一键下载导入 |
| 文件夹树 | 多层级，一篇文献可归属多个文件夹 |
| 标签 | 与文件夹独立的第二维度 |
| **拖拽归档** | 普通拖放 = 移动；按住 Alt = 追加到多个文件夹 |

### 阅读
| 功能 | 说明 |
|---|---|
| PDF 视图 | pdf.js 渲染 + 可选中文本层，选区高亮 |
| 双语阅读视图 | 段落流，英文下方紧跟中文（仿沉浸式翻译） |
| 三模式切换 | 仅原文 / 双语对照 / 仅译文 |
| 公式渲染 | KaTeX，含行内公式；自动修复 MinerU 的重复 `\tag` 与 OCR 字母间距 |
| 图表表格 | MinerU 产出的图片真实渲染，表格 HTML 渲染 |
| 缩放 | ± 按钮 / 快捷键 / 适应宽度，标注坐标不受缩放影响 |
| **引用标跳转** | 正文 `[7,11,20]` 可点击，弹出对应参考文献卡片 |
| 专注排版 | 右侧「Aa」面板：主题、字号、页宽、行高，实时生效 |

### 标注
| 功能 | 说明 |
|---|---|
| 部分标注 | 精确到选中的几个字，不是整段 |
| 原文 / 译文分开 | 分别记录，可单独高亮 |
| 4 色高亮 + 笔记 | 点击色块高亮，或点「笔记」高亮并写批注 |
| 侧栏管理 | 按「第 N 段」分组，带原文/译文标签 |
| 导出 Markdown | 一篇文献的全部标注导出 |

### 智能
| 功能 | 说明 |
|---|---|
| 全文翻译 | 段落级 + 本地缓存，重复阅读零成本；**自动/手动模式可切换** |
| 划词翻译 | 选中文字 → 气泡 → 手动点「翻译」；**严格限制单段**，跨段自动截断 |
| 清除译文缓存并重翻 | 按需切换引擎重翻（机翻快、AI 准，AI 会保留人名原文） |
| AI 总结 | 5 种类型，后台任务执行，**可随时取消**，流式显示进度 |
| 术语表 | 每行 `英文=中文`，翻译时注入 prompt 保证全文译名一致 |

### 个性化（全部持久化）
翻译方式、显示模式、翻译引擎、上次视图、阅读主题、字号、页宽、行高、三栏宽度、两侧栏显隐——**全部记住，打开就是上次的样子**。

---

## 阅读主题

四套预设 + 跟随系统。色值取自 Readwise Reader / Firefox 阅读模式 / Momei，对比度 ≥ 4.5:1（WCAG AA）。

| 主题 | 背景 | 文字 | 场景 |
|---|---|---|---|
| 跟随系统 | 自动 | 自动 | 浅色→锐利，深色→深夜 |
| 锐利 Crisp | `#ffffff` | `#1a1a1a` | 日间明亮 |
| 羊皮纸 Sepia | `#f4ecd8` | `#5b4636` | 长时间阅读最护眼 |
| 柔和 Soft | `#f8f9fa` | `#333333` | 低对比不刺眼 |
| 深夜 Night | `#1a1a1b` | `#d7dadc` | 夜间 |

阅读区使用独立配色变量 `--rd-*`，与侧栏应用配色分离，阅读时更聚焦。

**页宽范围 640-900px**：控制在 640-760 时约 65-80 字符/行，最接近纸质阅读节奏。
实际宽度还受窗口大小限制（取更小者）。

---

## 翻译引擎

可插拔设计，按优先级尝试、失败自动降级。在 ⚙ →「翻译引擎」里配置、排序和测试。

| 引擎 | 配置 | 说明 |
|---|---|---|
| 百度领域翻译 | AppID + 密钥 | 学术论文/信息技术垂直领域，50 万字符/月 |
| **腾讯云机器翻译** | SecretId + SecretKey | **额度最大**，500 万字符/月 |
| **火山引擎翻译** | AK + SK | 200 万字符/月 |
| Google 免费端点 | 无需 | 非官方端点，可能被限流 |
| Bing 免费端点 | 无需 | 非官方端点，token 端点可能失效 |
| DeepL | API Key | 免费版 50 万字符/月 |
| AI 大模型 | OpenAI 兼容 | 质量最好但慢（单段 5-10 秒），会保留人名原文 |

申请入口：
- 百度 → [翻译开放平台](https://fanyi-api.baidu.com/product/12)（注意：通用翻译与领域翻译是两个产品，额度独立）
- 腾讯云 → [API 密钥](https://console.cloud.tencent.com/cam/capi) + 开通「机器翻译」+ CAM 授予 `QcloudTMTFullAccess`
- 火山引擎 → [密钥管理](https://console.volcengine.com/iam/keymanage/) + 开通「机器翻译」

> 实测：腾讯云 300-440ms，AI 5-10 秒。日常通读用机翻，关键段落用 AI 重翻。

### 限流处理

中转站常有限流（429）。程序自动指数退避重试并尊重 `Retry-After`；
重试有总时间预算，绝不无限挂起。前端并发默认 2，可在
`frontend/src/stores/useStore.ts` 调 `CONCURRENCY`。

---

## 解析引擎

| 引擎 | 条件 | 质量 |
|---|---|---|
| MinerU 云 API | 需 `MINERU_TOKEN` | 最好：双栏重排、公式 LaTeX、表格结构、图表图片 |
| 本地兜底 | 无需配置 | 一般：按字号识别标题，不做双栏重排 |

点「解析全文」时自动选择。MinerU 免费额度 1000 页/天，个人使用约占 5%。

> MinerU 有严格限流，程序内置 3 秒请求间隔 + 429 退避。首次访问较慢（冷启动 10-15 秒）。

---

## 配置

复制 `backend/.env.example` 为 `.env`。**配置文件可放在两处**（都会读取，`backend/.env` 优先），空值不覆盖另一处的非空值。

**密钥请只写进 `.env`**（已在 `.gitignore` 中），不要提交到版本库，也不要贴在对话记录里。
AI 接口也可以在界面 ⚙ 里配置，存本地数据库，优先级高于环境变量。

### 代理

若本机需要代理，在 `.env` 填 `PAPER_READER_PROXY`。
默认**不读取**系统代理环境变量——`all_proxy` + 含 `[::1]` 的 `no_proxy` 会让 httpx
解析出错（报 `Invalid port: ':1]'`）。需沿用系统代理时设 `PAPER_READER_USE_ENV_PROXY=1`。

---

## 数据备份

设置 →「备份」标签页。**纯手动触发**，无自动备份、无定时同步。

备份内容：数据库一致性快照 + 解析产物；PDF 原文可选（体积大）。

**两层安全防护**：

1. **剔除密钥**（默认）——打包前从快照删除 `ai.api_key` / `webdav` / `engine.*`，
   密钥根本不进备份文件。恢复后需在设置里重新填写。
2. **归档加密**（可选）——PBKDF2（20 万次迭代）派生密钥 + Fernet 加密整个归档。
   口令仅本次会话使用，不落库、不上传；丢失则无法恢复。

恢复前会自动把当前库另存为 `library.db.before-restore-<时间戳>`，并做路径穿越防护。

**单向设计**：只上传或恢复，不做双向同步。多设备使用需自行管理版本。

坚果云：设置 → 安全 → 添加应用密码，地址填
`https://dav.jianguoyun.com/dav/你的目录/`。

---

## 关键设计约定

- **标注坐标归一化到 0-1**（相对页面宽高），与缩放、DPI、窗口尺寸无关。
- **翻译与标注解耦**：标注只认 `page + rects`，翻译只认 `segment`，换引擎不需要迁移标注。
- **引用标识别防 LaTeX 误匹配**：MinerU 偶尔漏掉 `$` 包裹，正则已加前置约束并对含
  LaTeX 命令的文本整体跳过识别。
- **所有路径来自环境变量**，本地 → VPS 迁移只改 `.env`。
- **鉴权中间件从第一天就在**，`AUTH_TOKEN` 留空则关闭（仅本地开发）。

---

## 一键部署到 VPS

单用户轻量方案：**不需要 root、docker、nginx/caddy**。数据与代码分离，systemd 常驻（开机自启 + 崩溃自拉起）。

```bash
# 上传到 VPS 后
./deploy.sh --dry-run              # 预览部署参数，不会实际执行
./deploy.sh                        # 完整部署（venv + 构建 + systemd + 启动）
./deploy.sh --token '随机长口令'    # 设置访问口令（公网访问必设）
./deploy.sh --status               # 查看服务状态
./deploy.sh --logs                 # 跟踪日志
./deploy.sh --uninstall            # 卸载服务（数据保留）
```

| 特性 | 说明 |
|---|---|
| 环境隔离 | 自动建 venv；缺 `python3-venv` 时自动降级系统 Python 并检测依赖 |
| 配置安全 | 覆盖 `.env` 前自动备份为 `.env.bak.<时间戳>` |
| 密钥生成 | 自动生成 `PAPER_READER_SECRET`（加密库中 API Key） |
| 常驻 | systemd user service + `enable-linger`（未登录也运行） |
| 鉴权 | 默认只监听 127.0.0.1；公网访问需 `--token` |

**外网访问两种方式**：

```bash
# A. SSH 隧道（最省事，无需防火墙）
ssh -N -L 8787:127.0.0.1:8787 user@你的VPS

# B. 公网直连（务必先设口令）
./deploy.sh --token '一串随机长口令'
sudo ufw allow 8787/tcp
HOST=0.0.0.0 ./deploy.sh
```

**Token 模式说明**：

`--token` 会写入 `.env`、**重新构建前端**（把口令注入产物）、并重启服务。
静态资源（HTML/JS/CSS）不鉴权，否则浏览器首次访问拿不到口令，页面永远无法打开；
数据由 API 层鉴权保护。

```bash
# 修改口令后必须重新部署前端，否则页面仍用旧口令
./deploy.sh --token '新口令'
# 或跳过构建时手动执行
cd frontend && VITE_AUTH_TOKEN='新口令' npm run build && cd .. && ./deploy.sh --no-build
```

---

## 迁移到另一台机器

```bash
./export.sh          # 生成 ~/paper-reader-export/paper-reader-<时间戳>.tar.gz
```

包含源码、git 历史、已构建前端。不含 `node_modules`、`.env`、文献库。
详见 [OFFLINE_DEPLOY.md](OFFLINE_DEPLOY.md)。

---

## 已知限制

- 含未渲染 LaTeX 的段落，引用标不会变成可点击（刻意取舍，避免误匹配）
- DOI 反查依赖 Crossref 标题 + arXiv 标题相似度，无 arXiv 版本的论文找不到
- AI 引擎全量重翻一篇 180 段论文约 20-30 分钟（机翻约 30 秒）
- 划词翻译的 Google/Bing 免费端点不稳定，可能失效
