#!/usr/bin/env bash
# ============================================================================
# Paper Reader 一键轻量化部署到 VPS
#
# 用法（在 VPS 上，普通用户即可，不需要 root）：
#
#   ./deploy.sh                一键部署：装依赖 + 下载模型 + 构建前端 + 配置 + 启动
#   ./deploy.sh --token <t>    同上，并设置访问口令（推荐 VPS 必须设置）
#   ./deploy.sh --no-build     跳过前端构建（复用已有 dist/）
#   ./deploy.sh --set-token <t> 仅修改访问口令（不跑完整部署）
#   ./deploy.sh --status       查看服务状态
#   ./deploy.sh --logs         跟踪日志
#   ./deploy.sh --uninstall    卸载服务（保留数据）
#
#   无 npm 时自动下载 Node 到项目内 .node/（Linux x64/arm64，免 root）；
#   可选环境变量: NODE_VERSION、NPM_REGISTRY（国内建议 https://registry.npmmirror.com）
#
# 设计目标：
#   1. 单用户轻量：不需要 root、不需要 docker、不需要 nginx/caddy
#   2. 数据与代码分离：数据在 LIB_ROOT，代码随便删
#   3. 常驻：systemd user service，开机自启、崩溃自拉起
#   4. 安全：默认只监听 127.0.0.1，公网访问需显式 --token + 防火墙
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$ROOT/backend/.venv"
NODE_DIR="$ROOT/.node"
SERVICE_NAME="paper-reader"
LOG_DIR="$HOME/.local/state/paper-reader"

# 默认配置（可用环境变量覆盖）
LIB_ROOT="${LIB_ROOT:-$HOME/paper-reader}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
NODE_VERSION="${NODE_VERSION:-22.14.0}"
NPM_REGISTRY="${NPM_REGISTRY:-}"

DO_BUILD=1
DRY_RUN=0
ACTION=""
TOKEN_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)   DO_BUILD=0 ;;
    --token)      [ $# -ge 2 ] || die "--token 需要参数"; AUTH_TOKEN="$2"; TOKEN_GIVEN=1; shift ;;
    --set-token)  [ $# -ge 2 ] || die "--set-token 需要参数"; AUTH_TOKEN="$2"; ACTION="set-token"; TOKEN_GIVEN=1; shift ;;
    --status|--logs|--uninstall|--help|-h) ACTION="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done
ACTION="${ACTION:-deploy}"

info()  { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[0;32m ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()   { printf '\033[0;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 环境检查
# ---------------------------------------------------------------------------
check_env() {
  command -v python3 >/dev/null || die "需要 python3"
  python3 --version | grep -qE '3\.(9|1[0-9])' || warn "建议 Python 3.9+，当前: $(python3 --version)"

  HAVE_SYSTEMD_USER=0
  if command -v systemctl >/dev/null && systemctl --user list-units >/dev/null 2>&1; then
    HAVE_SYSTEMD_USER=1
  else
    warn "systemd user 服务不可用（容器环境？），将使用后台进程模式"
  fi
}

# ---------------------------------------------------------------------------
# 1. Python 虚拟环境 + 依赖
# ---------------------------------------------------------------------------
setup_python() {
  info "准备 Python 环境"

  # 已存在 venv 且依赖齐全则复用；注意仍需检查可选依赖
  # （BabelDOC），否则旧部署升级后双语 PDF 会一直 503
  if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import fastapi" 2>/dev/null; then
    ok "复用已有 venv"
    install_babeldoc_deps "$VENV/bin/python"
    return
  fi

  # venv 缺失或不完整（python3-venv 未装时创建半途而废：目录在、python 在、
  # 但没有 pip），一律删除重建，否则会卡在 "bin/pip: No such file or directory"
  rm -rf "$VENV"

  if ! python3 -m venv "$VENV"; then
    rm -rf "$VENV"
    warn "创建 venv 失败（缺 python3-venv？），尝试系统 Python 模式"
    warn "如需隔离环境可执行: sudo apt install python3-venv"
    USE_SYSTEM_PY=1
    return
  fi

  # 部分发行版 venv 能创建成功但不带 pip（ensurepip 拆包安装），校验后再装依赖
  if ! "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
    rm -rf "$VENV"
    warn "venv 缺少 pip（缺 python3-venv？），改用系统 Python 模式"
    warn "如需隔离环境可执行: sudo apt install python3-venv"
    USE_SYSTEM_PY=1
    return
  fi

  "$VENV/bin/python" -m pip install -q --upgrade pip
  "$VENV/bin/python" -m pip install -q -r "$ROOT/backend/requirements.txt" \
    || die "依赖安装失败"
  ok "Python 依赖就绪 ($(du -sh "$VENV" | cut -f1))"

  install_babeldoc_deps "$VENV/bin/python"
}

# 系统 Python 模式下确认依赖可用
check_system_python() {
  [ "${USE_SYSTEM_PY:-0}" = "1" ] || return 0
  local miss=()
  for m in fastapi uvicorn httpx pypdf fitz cryptography; do
    python3 -c "import $m" 2>/dev/null || miss+=("$m")
  done
  if [ ${#miss[@]} -gt 0 ]; then
    info "安装缺失依赖: ${miss[*]}"
    # 新版 Debian/Ubuntu 的 pip 受 PEP 668 保护，需要 --break-system-packages
    pip3 install -q -r "$ROOT/backend/requirements.txt" \
      || pip3 install -q --break-system-packages -r "$ROOT/backend/requirements.txt" \
      || die "依赖安装失败，请手动执行: pip3 install -r backend/requirements.txt"
  fi
  install_babeldoc_deps python3
  ok "系统 Python 依赖就绪"
}

# 安装双语 PDF 的可选依赖（BabelDOC）
# 体积约 1.1GB（含 gradio/onnxruntime），失败不阻断部署
install_babeldoc_deps() {
  local py="$1"
  if "$py" -c "import pdf2zh_next" 2>/dev/null; then
    ok "双语 PDF 依赖已就绪"
    return 0
  fi

  info "安装双语 PDF 依赖（BabelDOC，约 1.1GB，请耐心等待）"
  local extra=()
  # 系统 Python 下可能受 PEP 668 保护
  case "$py" in
    *venv*) ;;
    *) extra=(--break-system-packages) ;;
  esac

  if "$py" -m pip install -q "${extra[@]}" -r "$ROOT/backend/requirements-babeldoc.txt" 2>/dev/null; then
    ok "双语 PDF 依赖安装完成"
  else
    warn "双语 PDF 依赖安装失败，其余功能不受影响"
    warn "可稍后手动执行: $py -m pip install -r backend/requirements-babeldoc.txt"
  fi
}

# 确定解释器（venv 优先，否则系统 python）
resolve_py_bin() {
  if [ "${USE_SYSTEM_PY:-0}" = "1" ]; then
    PY_BIN="$(command -v python3)"
  elif [ -x "$VENV/bin/python" ]; then
    PY_BIN="$VENV/bin/python"
  else
    PY_BIN="$(command -v python3)"
  fi
}

# ---------------------------------------------------------------------------
# 1.5 无 npm 时自动安装项目内 Node（免 root，仅 Linux x64/arm64）
# ---------------------------------------------------------------------------
ensure_node() {
  command -v npm >/dev/null 2>&1 && return 0
  if [ -x "$NODE_DIR/bin/npm" ]; then
    export PATH="$NODE_DIR/bin:$PATH"
    return 0
  fi
  if [ "$(uname -s)" != "Linux" ]; then
    warn "自动安装 Node 仅支持 Linux，当前系统: $(uname -s)"
    return 1
  fi
  local arch
  case "$(uname -m)" in
    x86_64)  arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) warn "不支持的 CPU 架构: $(uname -m)，无法自动安装 Node"; return 1 ;;
  esac

  local tarball="node-v$NODE_VERSION-linux-$arch.tar.gz"
  local tmp
  tmp="$(mktemp -d)"
  info "本机无 npm，下载 Node v$NODE_VERSION 到 $NODE_DIR（下载约 50MB，占盘约 200MB，免 root）"
  local fetched=""
  local base
  for base in "https://registry.npmmirror.com/-/binary/node" "https://nodejs.org/dist"; do
    info "下载: $base/v$NODE_VERSION/$tarball"
    if command -v curl >/dev/null 2>&1; then
      if curl -fSL --retry 2 --connect-timeout 10 -o "$tmp/$tarball" "$base/v$NODE_VERSION/$tarball"; then
        fetched="$tmp/$tarball"; break
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q --timeout=30 -O "$tmp/$tarball" "$base/v$NODE_VERSION/$tarball"; then
        fetched="$tmp/$tarball"; break
      fi
    else
      warn "curl/wget 均不可用，无法下载 Node"
      break
    fi
  done
  if [ -z "$fetched" ]; then
    rm -rf "$tmp"
    warn "Node 下载失败（镜像不可达？），可手动安装 Node 后重跑"
    return 1
  fi

  mkdir -p "$NODE_DIR"
  if ! tar -xzf "$fetched" -C "$NODE_DIR" --strip-components=1; then
    rm -rf "$tmp" "$NODE_DIR"
    warn "Node 解压失败"
    return 1
  fi
  rm -rf "$tmp"
  export PATH="$NODE_DIR/bin:$PATH"
  command -v npm >/dev/null 2>&1 || { warn "Node 安装后 npm 仍不可用"; return 1; }
  ok "Node 就绪: $(node -v 2>/dev/null || echo "v$NODE_VERSION") @ $NODE_DIR"
}

# ---------------------------------------------------------------------------
# 2. 前端构建
# ---------------------------------------------------------------------------
build_frontend() {
  local dist="$ROOT/frontend/dist"

  # 显式 --no-build：必须有现成产物，否则服务启动后只会返回「前端尚未构建」
  if [ "$DO_BUILD" != "1" ]; then
    if [ -f "$dist/index.html" ]; then
      info "跳过前端构建，复用已有 dist/"
      return
    fi
    die "已选 --no-build 但 frontend/dist 不存在；去掉 --no-build（无 npm 会自动装 Node），
或在有 Node 的机器上执行 cd frontend && VITE_AUTH_TOKEN=<口令> npm run build 后上传 dist/"
  fi

  # 无 npm → 自动装项目内 Node；装不上则退回复用已有 dist
  if ! command -v npm >/dev/null 2>&1; then
    if ! ensure_node; then
      if [ -f "$dist/index.html" ]; then
        warn "Node 不可用，复用已有 dist/（注意其中是否包含当前口令）"
        return
      fi
      die "本机无 npm 且自动安装 Node 失败。请在有 Node 的机器上构建 dist/ 上传，
或手动安装 Node: https://nodejs.org/en/download"
    fi
  fi

  info "构建前端"
  if [ ! -d "$ROOT/frontend/node_modules" ]; then
    local reg=()
    [ -n "$NPM_REGISTRY" ] && reg=(--registry="$NPM_REGISTRY")
    (cd "$ROOT/frontend" && npm ci --silent "${reg[@]}") \
      || (cd "$ROOT/frontend" && npm install --silent "${reg[@]}") \
      || die "前端依赖安装失败"
  fi
  # 关键：把访问口令注入前端构建产物。
  # 否则前端 import.meta.env.VITE_AUTH_TOKEN 为空，不发 x-auth-token 头，
  # 后端返回 401，表现为「能连上但页面空白/加载失败」。
  local env_args=()
  if [ -n "$AUTH_TOKEN" ]; then
    env_args+=("VITE_AUTH_TOKEN=$AUTH_TOKEN")
    info "已将访问口令注入前端构建产物"
  fi
  # 限制 Node 进程内存，避免 2C2G VPS 编译时被 Linux OOM 杀掉
  env_args+=("NODE_OPTIONS=--max-old-space-size=1024")

  local build_log="/tmp/pr-frontend-build.log"
  if (cd "$ROOT/frontend" && env "${env_args[@]}" npm run build > "$build_log" 2>&1); then
    [ -f "$dist/index.html" ] || die "构建产物缺失: dist/index.html"
    ok "前端构建完成 ($(du -sh "$dist" | cut -f1))"
  else
    warn "前端构建失败！最后 20 行日志如下:"
    tail -n 20 "$build_log" 2>/dev/null || true
    die "前端构建未能成功，请根据上方错误日志排查"
  fi
}

# ---------------------------------------------------------------------------
# 2.5 低配 VPS 保护：swap
# ---------------------------------------------------------------------------
setup_swap() {
  local total_mb
  total_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  # 仅在小内存机器上处理（< 3G）
  [ "$total_mb" -lt 3072 ] || return 0

  if ! command -v swapon >/dev/null; then
    warn "无 swapon，跳过 swap 配置"
    return 0
  fi
  if [ "$(swapon --show 2>/dev/null | wc -l)" -gt 0 ]; then
    ok "已有 swap 生效: $(free -h | awk '/Swap/ {print $2}')"
    return 0
  fi

  local swapfile="/swapfile"
  # 如果已有现成文件，直接激活复用，不重复落盘
  if [ -f "$swapfile" ]; then
    if sudo -n swapon "$swapfile" 2>/dev/null; then
      ok "已激活已有 swap 文件: $swapfile"
      return 0
    fi
  fi

  warn "内存 ${total_mb}MB 偏小且无生效 swap，尝试创建 2G swap（需 sudo）"
  if sudo -n fallocate -l 2G "$swapfile" 2>/dev/null \
     && sudo -n chmod 600 "$swapfile" 2>/dev/null \
     && sudo -n mkswap "$swapfile" >/dev/null 2>&1 \
     && sudo -n swapon "$swapfile" 2>/dev/null; then
    grep -q "^$swapfile" /etc/fstab 2>/dev/null || \
      echo "$swapfile none swap sw 0 0" | sudo -n tee -a /etc/fstab >/dev/null 2>&1
    ok "已创建 2G swap（防止 OOM）"
  else
    warn "创建 swap 失败（需要 sudo），建议手动执行:"
    cat <<'EOM'
    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
    sudo mkswap /swapfile && sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
EOM
  fi
}

# ---------------------------------------------------------------------------
# 2.6 BabelDOC 资源检查
# ---------------------------------------------------------------------------
# 说明：best-effort 预下载。babeldoc --warmup 内部可能 sys.exit，
# 退出码不可信，一律以模型文件是否落盘为准；超时/失败只告警不阻断，
# 首次翻译时仍会按需自动下载。可用 BABELDOC_WARMUP=0 跳过。
check_babeldoc_assets() {
  local cache="$HOME/.cache/babeldoc"
  local model="$cache/models/doclayout_yolo_docstructbench_imgsz1024.onnx"

  if [ -f "$model" ]; then
    ok "BabelDOC 模型已就绪 ($(du -sh "$cache" 2>/dev/null | cut -f1))"
    return 0
  fi

  # 没装 pdf2zh_next 就没必要下载
  resolve_py_bin
  if ! "$PY_BIN" -c "import pdf2zh_next" 2>/dev/null; then
    warn "未安装 pdf2zh_next，跳过 BabelDOC 模型预下载"
    return 0
  fi

  if [ "${BABELDOC_WARMUP:-1}" != "1" ]; then
    warn "BabelDOC 模型未下载，首次翻译时会自动获取（约 430MB）"
    return 0
  fi

  info "预下载 BabelDOC 模型（约 430MB，最长等待 15 分钟）"
  if [ -x "$VENV/bin/babeldoc" ]; then
    timeout 900 "$VENV/bin/babeldoc" --warmup >/dev/null 2>&1 || true
  else
    timeout 900 "$PY_BIN" -c 'import sys; sys.argv=["babeldoc","--warmup"]; from babeldoc.main import main; main()' >/dev/null 2>&1 || true
  fi

  if [ -f "$model" ]; then
    ok "BabelDOC 模型下载完成 ($(du -sh "$cache" 2>/dev/null | cut -f1))"
    return 0
  fi

  warn "BabelDOC 模型预下载未完成，首次翻译时会自动获取（约 430MB）"
  cat <<'EOM'
    若 VPS 网络受限，可先在本地跑一次翻译再打包上传：
      tar -czf babeldoc-cache.tar.gz -C ~/.cache babeldoc
      scp babeldoc-cache.tar.gz user@vps:~/
      ssh user@vps 'tar -xzf ~/babeldoc-cache.tar.gz -C ~/.cache'
EOM
}

# ---------------------------------------------------------------------------
# 3. 数据目录 + 配置
# ---------------------------------------------------------------------------
setup_data() {
  info "准备数据目录: $LIB_ROOT"
  mkdir -p "$LIB_ROOT"/{files,parsed,backups}

  if [ ! -f "$ROOT/backend/.env" ]; then
    cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  else
    # 覆盖前先备份，避免误覆盖开发环境配置
    cp "$ROOT/backend/.env" "$ROOT/backend/.env.bak.$(date +%Y%m%d%H%M%S)"
    info "已备份原配置到 backend/.env.bak.*"
  fi
  # 写回部署参数（保留用户已填的密钥）
  python3 - "$ROOT/backend/.env" "$LIB_ROOT" "$HOST" "$PORT" "$AUTH_TOKEN" <<'PY'
import sys
path, lib, host, port, token = sys.argv[1:6]
kv = {}
for line in open(path, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        kv[k.strip()] = v.strip()
kv["LIB_ROOT"], kv["HOST"], kv["PORT"] = lib, host, port
if token:
    kv["AUTH_TOKEN"] = token
# 必须项兜底
kv.setdefault("PAPER_READER_SECRET", "")
if not kv["PAPER_READER_SECRET"]:
    import secrets
    kv["PAPER_READER_SECRET"] = secrets.token_urlsafe(32)
    print("  已生成 PAPER_READER_SECRET（用于加密库中 API Key）")
with open(path, "w", encoding="utf-8") as f:
    for k, v in kv.items():
        f.write(f"{k}={v}\n")
PY
  ok "配置已写入 backend/.env"
}

# ---------------------------------------------------------------------------
# 4. 启动（systemd user service 优先，否则后台进程）
# ---------------------------------------------------------------------------
install_service() {
  mkdir -p "$LOG_DIR"

  resolve_py_bin

  if [ "$HAVE_SYSTEMD_USER" = "1" ]; then
    info "安装 systemd user service"
    local unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    cat > "$unit_dir/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Paper Reader - personal paper reading server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/backend
ExecStart=$PY_BIN -m uvicorn app.main:app --host $HOST --port $PORT --workers 1 --limit-concurrency 64
Restart=on-failure
RestartSec=3
StandardOutput=append:$LOG_DIR/server.log
StandardError=append:$LOG_DIR/server.log

# --- 低配 VPS 保护 ---
# 单进程（多 worker 会成倍吃内存，2C2G 上反而拖慢）
MemoryMax=1200M
# 内存紧张时优先回收页缓存而不是 OOM kill
MemoryHigh=900M
# 降低 CPU 抢占，避免翻译任务把系统卡死
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1
    systemctl --user restart "$SERVICE_NAME"
    # 让用户服务在未登录时也能运行（VPS 必备）
    if command -v loginctl >/dev/null; then
      loginctl enable-linger "$(whoami)" >/dev/null 2>&1 || true
    fi
    ok "systemd 服务已安装并启动（开机自启）"
  else
    warn "使用后台进程模式（无开机自启、无崩溃自拉起）"
    pkill -f "uvicorn app.main:app" 2>/dev/null || true
    sleep 1
    setsid nohup "${PY_BIN:-python3}" -m uvicorn app.main:app \
      --host "$HOST" --port "$PORT" \
      > "$LOG_DIR/server.log" 2>&1 < /dev/null &
    ok "后台进程已启动"
  fi
}

# ---------------------------------------------------------------------------
# 健康检查
# ---------------------------------------------------------------------------
wait_ready() {
  info "等待服务就绪"
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 3 "http://$HOST:$PORT/api/system/health" >/dev/null 2>&1; then
      ok "服务已就绪"
      return 0
    fi
    sleep 1
  done
  warn "服务未在预期时间内响应，请查看日志: $LOG_DIR/server.log"
  return 1
}

show_summary() {
  local url="http://$HOST:$PORT"
  cat <<EOF

==================== 部署完成 ====================
  本地地址:   $url
  数据目录:   $LIB_ROOT
  日志:       $LOG_DIR/server.log
  配置:       $ROOT/backend/.env

  管理命令:
    $0 --status      查看状态
    $0 --logs        跟踪日志
    $0 --token <t>   修改访问口令
    $0 --uninstall   卸载服务（数据保留）

EOF
  if [ "$HOST" = "127.0.0.1" ]; then
    cat <<EOF
  当前仅监听本机。如需从外网访问，二选一：

  A. SSH 隧道（最省事，无需防火墙配置）
     ssh -N -L $PORT:127.0.0.1:$PORT user@你的VPS
     然后浏览器打开 http://127.0.0.1:$PORT

  B. 公网访问（务必先设置口令）
     $0 --token '一串随机长口令'
     sudo ufw allow $PORT/tcp
     HOST=0.0.0.0 $0
EOF
  fi
}

# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------
case "$ACTION" in
  deploy)
    check_env
    if [ "$DRY_RUN" = "1" ]; then
      cat <<EOF
==================== 部署预览（不会实际执行）====================
  项目目录:   $ROOT
  数据目录:   $LIB_ROOT
  监听地址:   $HOST:$PORT
  访问口令:   $([ -n "$AUTH_TOKEN" ] && echo 已设置 || echo 未设置（仅本机访问）)
  Python:     ${USE_SYSTEM_PY:-自动检测}
  前端构建:   $([ "$DO_BUILD" = "1" ] && echo 是 || echo 跳过)
  服务方式:   systemd user service
  日志目录:   $LOG_DIR
  配置文件:   $ROOT/backend/.env

  实际执行请去掉 --dry-run
=================================================================
EOF
      exit 0
    fi
    # 未显式传口令时沿用 .env 中的旧值。否则重复部署重建前端会丢口令，
    # 表现为「能打开页面但所有请求 401」
    if [ -z "$AUTH_TOKEN" ] && [ -f "$ROOT/backend/.env" ]; then
      AUTH_TOKEN="$(sed -n 's/^AUTH_TOKEN=//p' "$ROOT/backend/.env" | head -n1)"
      [ -n "$AUTH_TOKEN" ] && info "沿用 backend/.env 中的访问口令"
    fi
    if [ "$TOKEN_GIVEN" = "1" ] && [ "$DO_BUILD" != "1" ]; then
      warn "--no-build 不重建前端：新口令只写入后端，页面可能仍用旧口令"
    fi
    # 关键：低配 VPS（如 2C2G）必须在安装依赖与构建前端之前先建好 Swap！
    # 否则 npm run build (tsc -b + rollup) 容易因物理内存耗尽直接被 Linux 内核 OOM kill。
    setup_swap
    setup_python
    check_system_python
    resolve_py_bin
    build_frontend
    check_babeldoc_assets
    setup_data
    install_service
    wait_ready || true
    show_summary
    ;;
  set-token)
    [ -n "$AUTH_TOKEN" ] || die "口令不能为空"
    python3 - "$ROOT/backend/.env" "$AUTH_TOKEN" <<'PYINNER'
import sys
path, token = sys.argv[1], sys.argv[2]
kv = {}
for line in open(path, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        kv[k.strip()] = v.strip()
kv["AUTH_TOKEN"] = token
with open(path, "w", encoding="utf-8") as f:
    for k, v in kv.items():
        f.write(f"{k}={v}\n")
PYINNER
    ok "口令已写入 backend/.env"

    # 口令变更后必须重新构建前端，否则前端仍持有旧口令（或为空）
    if [ "$DO_BUILD" = "1" ]; then
      command -v npm >/dev/null 2>&1 || ensure_node || true
      if command -v npm >/dev/null 2>&1; then
        info "重新构建前端以应用新口令"
        (cd "$ROOT/frontend" && VITE_AUTH_TOKEN="$AUTH_TOKEN" npm run build >/dev/null 2>&1) \
          && ok "前端已重新构建" || warn "前端构建失败，页面可能仍用旧口令"
      else
        warn "本机无 npm 且 Node 自动安装失败，请手动执行: cd frontend && VITE_AUTH_TOKEN=<口令> npm run build"
      fi
    else
      warn "跳过前端构建（--no-build），请手动执行: cd frontend && VITE_AUTH_TOKEN=<口令> npm run build"
    fi

    if systemctl --user restart "$SERVICE_NAME" 2>/dev/null; then
      sleep 2
      if curl -fsS --max-time 5 -H "x-auth-token: $AUTH_TOKEN" "http://$HOST:$PORT/api/system/health" >/dev/null 2>&1; then
        ok "服务已重启，口令生效"
      else
        warn "服务已重启但未响应，请检查日志"
      fi
    else
      warn "systemd 不可用，请手动重启服务"
    fi
    ;;

  --status)
    if systemctl --user is-active "$SERVICE_NAME" >/dev/null 2>&1; then
      systemctl --user status "$SERVICE_NAME" --no-pager
    else
      pgrep -af "uvicorn app.main:app" || echo "未运行（systemd user service 不可用或未安装）"
    fi
    ;;
  --logs)
    tail -n 100 -f "$LOG_DIR/server.log" 2>/dev/null || echo "无日志"
    ;;
  --uninstall)
    systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$SERVICE_NAME.service"
    pkill -f "uvicorn app.main:app" 2>/dev/null || true
    systemctl --user daemon-reload 2>/dev/null || true
    ok "服务已卸载（数据保留在 $LIB_ROOT）"
    ;;
  --help|-h)
    sed -n '2,20p' "$0"
    ;;
esac
