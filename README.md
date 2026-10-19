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
| MinerU 解析 → 段落流双语 | ⬜ 阶段二 |
| 全文翻译 / 划词翻译 / AI 总结 | ⬜ 阶段二/三 |
| WebDAV 备份 | ⬜ 阶段三 |

## 配置

复制 `backend/.env.example` 为 `backend/.env` 后按需填写。

**MinerU 与 AI 的 token 请直接写进 `.env`**（该文件已在 `.gitignore` 中），
不要提交到版本库，也不要贴在对话记录里。

## 关键设计约定

- **标注坐标一律归一化到 0-1**（相对页面宽高），与缩放、DPI、窗口尺寸无关。
- **翻译与标注解耦**：标注只认 `page + rects`，翻译只认 `segment`，换翻译引擎不需要迁移标注。
- **所有路径来自环境变量**，保证本地 → VPS 迁移只改 `.env`。
- **鉴权中间件从第一天就在**，`AUTH_TOKEN` 留空则关闭（仅本地开发）。
