#!/usr/bin/env bash
# Paper Reader 一键启动
#   用法：./start.sh          开发模式（前端热更新 + 后端自动重载）
#         ./start.sh prod     生产模式（只用构建产物，单端口）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-dev}"

if [[ "$MODE" == "prod" ]]; then
  echo "==> 构建前端"
  (cd "$ROOT/frontend" && npm run build >/dev/null)
  echo "==> 启动服务 http://127.0.0.1:8787"
  cd "$ROOT/backend"
  exec python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8787
else
  echo "==> 启动后端 :8787"
  (cd "$ROOT/backend" && setsid nohup python3 -m uvicorn app.main:app --port 8787 --reload \
      > /tmp/pr-backend.log 2>&1 < /dev/null &)
  sleep 2
  echo "==> 启动前端 :5173 (热更新)"
  echo "    打开 http://127.0.0.1:5173"
  echo "    后端日志: tail -f /tmp/pr-backend.log"
  cd "$ROOT/frontend"
  exec npm run dev
fi
