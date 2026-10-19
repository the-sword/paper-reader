# Paper Reader 跨机器迁移说明

本包用于把项目从开发机迁移到另一台机器继续开发与测试。

## 一、包里有什么

```
paper-reader/                    # 完整项目
├── .git/                        # 完整提交历史（可接续开发）
├── backend/                     # Python 后端
│   ├── app/
│   ├── requirements.txt
│   └── .env.example             # 配置模板（不含真实密钥）
├── frontend/
│   ├── src/                     # 前端源码
│   └── dist/                    # 已构建产物（启动即可用，无需 Node 也能跑）
├── start.sh
├── README.md
└── OFFLINE_DEPLOY.md            # 本文件
```

**不含** `node_modules`（172MB，可在新机器用 `npm install` 重新装）。

## 二、在新机器上跑起来

### 方式 A：只运行，不改前端（最快）

需要：Python 3.10+

```bash
cd paper-reader/backend
cp .env.example .env
pip3 install -r requirements.txt
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8787
```

浏览器打开 http://127.0.0.1:8787 。`frontend/dist` 已构建好，后端会自动托管。

### 方式 B：要改前端代码

额外需要：Node 18+

```bash
cd paper-reader/frontend
npm install            # 需要能访问 npm 源
npm run dev            # http://127.0.0.1:5173
```

或者用一键脚本（开发模式）：

```bash
cd paper-reader
chmod +x start.sh
./start.sh             # 同时起后端和前端热更新
./start.sh prod        # 生产模式，单端口
```

## 三、必须手动迁移的两样东西

这两样**不在包里**（安全与体积原因），按需单独拷：

| 内容 | 位置 | 说明 |
|---|---|---|
| 密钥配置 | `backend/.env` | MinerU token、AI key。从 `.env.example` 复制后填写 |
| 文献库 | `~/paper-reader/` | PDF、标注、翻译缓存。整个目录拷过去即可 |

迁移文献库后，确保新机器 `.env` 里 `LIB_ROOT` 指向它的实际位置。

## 四、接续开发

```bash
cd paper-reader
git log --oneline       # 已有两次提交
git status              # 应为干净
```

直接改代码、提交即可，历史连续。

## 五、当前功能

| 功能 | 状态 |
|---|---|
| 文献导入（拖拽、sha256 去重） | ✅ |
| 文件夹树 + 标签 | ✅ |
| PDF 渲染 + 文本选中 + 标注 | ✅ |
| 标注导出 Markdown | ✅ |
| 段落流双语阅读 | ✅ |
| 渐进翻译 + 段落级缓存 | ✅ |
| 本地解析（PyMuPDF，无需密钥） | ✅ |
| MinerU 云 API 解析 | ✅ 代码就绪，需 token |
| AI 接口配置 + 术语表 | ✅ |
| 划词翻译 / AI 总结 / WebDAV | ⬜ 阶段三，待开发 |

## 六、没有外部网络时怎么测试

关键设计：**核心阅读功能不依赖任何外部服务**。

- 文献导入、文件夹、标签、PDF 阅读、标注 → 全本地
- 全文解析 → 本地兜底可用（`engine=local`），不调用 MinerU
- 翻译 → 需要一个 OpenAI 兼容接口。断网时可用下面任一方式：
  1. 在目标机器上跑本地模型（Ollama / vLLM），把 `base_url` 指向
     `http://127.0.0.1:11434/v1` 之类的本地地址；
  2. 起一个 mock 接口返回固定文本，验证前端交互与缓存逻辑。

配置入口：界面右上角 ⚙。

## 七、常见问题

**Q: 白屏？**
`frontend/dist/` 是否完整。缺失时在能联网的机器上 `cd frontend && npm run build`，
再把 dist 拷过来。

**Q: 报代理相关错误（如 `Invalid port: ':1]'`）？**
本机 `all_proxy` + `no_proxy` 含 `[::1]` 会让 httpx 解析异常。项目默认忽略环境
代理、对本地地址强制直连。确需代理时在 `.env` 设 `PAPER_READER_PROXY`。

**Q: 端口被占用？**
`--port 8788`，或改 `.env` 里的 `PORT`。

**Q: 本地解析对双栏论文顺序不对？**
这是本地兜底的已知短板。配置 `MINERU_TOKEN` 后会自动改用 MinerU，能正确重排双栏。
