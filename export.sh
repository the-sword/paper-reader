#!/usr/bin/env bash
# 导出可迁移的项目包。
#
# 用法：
#   ./export.sh                 导出到 ~/paper-reader-export/
#   ./export.sh /tmp/somewhere  导出到指定目录
#
# 产出一个 tar.gz 和一个未压缩目录，两者内容一致，按需取用。
# 包含：源码、完整 git 历史、已构建的前端 dist、依赖清单
# 不含：node_modules（太大，新机器 npm install 即可）、.env（含密钥）、文献库
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_BASE="${1:-$HOME/paper-reader-export}"
STAMP="$(date +%Y%m%d-%H%M)"
NAME="paper-reader-$STAMP"
STAGE="$OUT_BASE/$NAME"

echo "==> 导出目录: $OUT_BASE"
mkdir -p "$OUT_BASE"

# ---------- 1. 确保前端是最新构建 ----------
if command -v npm >/dev/null 2>&1 && [ -d "$ROOT/frontend/node_modules" ]; then
  echo "==> 构建前端"
  (cd "$ROOT/frontend" && npx vite build >/dev/null 2>&1) || {
    echo "    构建失败，将跳过 dist（新机器需自行 npm run build）"
  }
else
  echo "==> 跳过构建（无 npm 或未安装依赖）"
fi

# ---------- 2. 复制源码（排除大目录）----------
echo "==> 复制项目文件"
mkdir -p "$STAGE"
rsync -a \
  --exclude 'node_modules' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.env' \
  --exclude '*.log' \
  --exclude '.venv' \
  --exclude 'backend/data' \
  "$ROOT/" "$STAGE/"

# dist 单独确认带上（rsync 规则里没排除它）
if [ -d "$ROOT/frontend/dist" ]; then
  mkdir -p "$STAGE/frontend/dist"
  rsync -a "$ROOT/frontend/dist/" "$STAGE/frontend/dist/"
fi

# ---------- 3. 写一份导出信息 ----------
{
  echo "Paper Reader 导出包"
  echo "导出于: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "源路径: $ROOT"
  echo "提交:   $(cd "$ROOT" && git log -1 --oneline 2>/dev/null || echo '非 git 仓库')"
  echo ""
  echo "内容:"
  echo "  - 完整源码与 git 历史"
  echo "  - frontend/dist（已构建，可直接运行）"
  echo "  - backend/requirements.txt"
  echo "  - README.md / DESIGN.md / OFFLINE_DEPLOY.md"
  echo ""
  echo "未包含（需单独准备）:"
  echo "  - backend/.env        密钥配置，从 .env.example 复制后填写"
  echo "  - ~/paper-reader/     文献库数据"
  echo "  - frontend/node_modules  新机器执行 npm install"
} > "$STAGE/EXPORT_INFO.txt"

# ---------- 4. 打 tar.gz ----------
echo "==> 压缩"
tar -czf "$OUT_BASE/$NAME.tar.gz" -C "$OUT_BASE" "$NAME"

# ---------- 5. 汇总 ----------
DIR_SIZE=$(du -sh "$STAGE" | cut -f1)
TGZ_SIZE=$(du -sh "$OUT_BASE/$NAME.tar.gz" | cut -f1)

echo ""
echo "==================== 导出完成 ===================="
echo "  目录:   $STAGE   ($DIR_SIZE)"
echo "  压缩包: $OUT_BASE/$NAME.tar.gz   ($TGZ_SIZE)"
echo ""
echo "在新机器上："
echo "  tar -xzf $NAME.tar.gz && cd $NAME/backend"
echo "  cp .env.example .env"
echo "  pip3 install -r requirements.txt"
echo "  python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8787"
echo "  # 浏览器打开 http://127.0.0.1:8787"
echo "=================================================="
