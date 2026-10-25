#!/usr/bin/env bash
# 一键跑全部测试：后端 pytest + 前端构建（tsc 类型检查 + vite build）
set -e
cd "$(dirname "$0")"

echo "==== 后端测试（pytest）===="
cd backend
if [ ! -x .venv/bin/python ]; then
  echo "未找到 backend/.venv，先安装依赖：python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt"
  exit 1
fi
.venv/bin/python -m pytest
cd ..

echo "==== 前端构建（tsc + vite）===="
cd frontend
npm run build

echo "==== 全部通过 ===="
