# Paper Reader 项目上下文（持续维护）

> 用途：跨会话保留项目关键决策与现状。发生架构级变更时更新本文件。

## 架构速览

- **前端**：React 18 + TypeScript + Vite，状态管理 Zustand（`frontend/src/stores/useStore.ts`），PDF 渲染 `pdfjs-dist` 4.10.38。
- **后端**：FastAPI + SQLite（`backend/app/`）。BabelDOC 生成双语 PDF（宽页：左原文右译文）。
- **入口**：后端托管 `frontend/dist`，本地 `http://127.0.0.1:8787`。
- **构建**：`cd frontend && npm run build`（`tsc -b && vite build`）。

## 关键设计决策

- **双语 PDF**：保留 BabelDOC 宽页（1224×792）不切页；译文视图 = 前端裁右半（`PdfViewer halfView="zh"`）。
- **标注坐标**：归一化到**原文页**宽高的 0–1 坐标系，`side: source|zh` 决定双语页画在哪半页；下划线样式（非涂色）。旧双语坐标系数据存在歧义未迁移。
- **高 DPR**：canvas 位图 ×ratio（≤3、宽 ≤4096），渲染必须传 `transform: [ratio,0,0,ratio,0,0]`，否则内容缩在左上角。
- **适应宽度跟随模式**：auto-fit 后 ResizeObserver 监听容器变窄自动重拟合；手动缩放退出跟随。
- **UI v2**（设计稿 `docs/ui-redesign-v2.svg`）：NavRail + TabBar + DocHeader + OutlinePanel + RightPanel（竖向导航：导读/问答/标注/信息）+ 底部 ReaderToolbar + ⌘K CommandPalette；移动端 BottomSheet + FAB + 沉浸阅读。
- **问答引用**：解析产物注入页码标记，AI 回答带 `[p.N]`，点击跳页。

## Service Worker 缓存策略（易踩坑）

`frontend/public/sw.js`：

- HTML 入口 / 可变 API（annotations、documents、folders、tags、**reading/{id}/segments、references**）：**network-first**，断网回退缓存。
- `reading/{id}/asset/*`：SWR。
- PDF 文件：cache-first + Range 感知（缓存 200 完整响应，现场合成 206）。
- hash 静态资源：cache-first。

**原则**：凡是可能被增删改（含「空 → 有」）的 API 一律 network-first。SWR 秒回旧快照会导致「操作生效但界面不更新、刷新才出现」的错觉——标注和 segments 都踩过。segments 解析前打开文档会缓存空快照，走 SWR 会让解析完成后目录仍为空。

## 数据目录

- SQLite：`<repo>/paper-reader.db`（注意 `pgrep` 精确匹配，勿误杀）。
- BabelDOC 产物：与文档同目录 `*.dual.pdf`。

## 分支与提交

- 主分支：`main`；特性分支：`devin/*`。按阶段/独立修复拆 commit，便于 cherry-pick（如高 DPR 修复 `e41f938`）。
- 本机无推送凭据，推送由用户执行：`git push origin <branch>`。

## 已知待办 / 边界

- 设计稿左栏「缩略图」页签未实现（仅有 目录/标注）。
- 真机未测：软键盘与 `visualViewport` 下 BottomSheet 行为、触摸划词。
- 4096px canvas 降级分支未实测。
- 旧标注坐标系歧义数据无迁移方案。
