#!/usr/bin/env bash
# =============================================================================
# deploy-remote.sh — 把 dsh-remote-x 插件挂载到本机的 DeepSeek Harness 并启动
#
# 两种模式（自动识别）：
#   A. 预装环境（如 xiaoxin：~/deepseek-harness 已有源码 + node_modules）
#        → node --import tsx/esm apps/cli/src/bin.ts web --patch <补丁>
#   B. 全新机器 → 下载 Harness 源码（~/harness-src 预置或 GitHub）→ pnpm install → 启动
#
# 用法：bash deploy-remote.sh [安装目录，默认 ~/dsh-remote]
# 环境变量：
#   PORT              Web 端口（默认 3080；被占用自动改 3099）
#   HARNESS_DIR       显式指定 Harness 源码目录（含 packages/ 的 monorepo 根）
#   DEEPSEEK_API_KEY  设置后用真实 DeepSeek 模型；否则追加 Echo 测试适配器
#
# 完成后打印带 token 的访问地址、日志与停止命令。
# =============================================================================
set -euo pipefail

INSTALL_DIR="${1:-$HOME/dsh-remote}"
PORT="${PORT:-3080}"
PLUGIN_SRC="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION="v$(grep -o '"node": *"[^"]*"' "$PLUGIN_SRC/package.json" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo '22.19.0')"

log() { printf '\n\033[1;36m[deploy]\033[0m %s\n' "$*"; }

if [ "$(uname -s)" != "Linux" ] && [ "$(uname -s)" != "Darwin" ]; then
  echo "此脚本面向 Linux/macOS。当前：$(uname -s)" >&2
  exit 1
fi
log "外网连通性: $(curl -sI -m 8 https://github.com 2>&1 | head -1 || echo 'github 不可达（仅影响全新下载，预装环境不受影响）')"

# ---------- 停止旧测试实例（先于端口检测，否则旧实例占用会让脚本误选新端口） ----------
if [ "$(pgrep -f 'apps/cli/src/bin[.]ts web' | head -1)" != "" ]; then
  log "发现旧的测试实例，先停止 ..."
  pkill -f 'apps/cli/src/bin[.]ts web' 2>/dev/null || true
  sleep 3
fi

# ---------- 端口占用自检 ----------
if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ":$PORT "; then
  log "端口 $PORT 已被占用，改用 3099"
  PORT=3099
  if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ":$PORT "; then
    log "3099 也被占用，改用 3098"; PORT=3098
  fi
fi

mkdir -p "$INSTALL_DIR"

# ---------- 1. node（预装环境通常已有；全新机器解压官方二进制） ----------
if ! command -v node >/dev/null 2>&1; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) NODE_ARCH="x64" ;;
    aarch64 | arm64) NODE_ARCH="arm64" ;;
    *) echo "不支持的架构：$ARCH" >&2; exit 1 ;;
  esac
  NODE_DIR="$INSTALL_DIR/node-$NODE_VERSION"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    log "下载 Node $NODE_VERSION ($NODE_ARCH) ..."
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o node.tar.xz
    tar -xJf node.tar.xz
    rm -f node.tar.xz
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi
CURRENT_NODE_V="$(node -v 2>/dev/null || echo 'v0.0.0')"
CURRENT_MAJOR="${CURRENT_NODE_V#v}"; CURRENT_MAJOR="${CURRENT_MAJOR%%.*}"
if [ "${CURRENT_MAJOR:-0}" -ge 22 ] 2>/dev/null; then
  log "node $CURRENT_NODE_V ✓（满足 engines.node）"
else
  log "警告: node $CURRENT_NODE_V 可能不满足 engines.node ≥22，继续执行但可能出现兼容问题"
fi

# ---------- 2. 定位 Harness 源码（预装优先） ----------
HARNESS_DIR="${HARNESS_DIR:-}"
if [ -z "$HARNESS_DIR" ]; then
  for candidate in "$HOME/deepseek-harness" "$INSTALL_DIR/deepseek-harness" "$HOME/harness-src/deepseek-harness-master"; do
    if [ -d "$candidate/packages" ]; then HARNESS_DIR="$candidate"; break; fi
  done
fi

SOURCE_MODE=1
if [ -n "$HARNESS_DIR" ]; then
  # ===== 模式 A：预装源码环境，tsx 加载器直接跑 TS（插件与适配器零构建） =====
  log "使用已安装的 Harness: $HARNESS_DIR"
  if [ ! -d "$HARNESS_DIR/node_modules/tsx" ]; then
    echo "$HARNESS_DIR 缺少 node_modules/tsx —— 请先在该目录安装依赖（pnpm install / npm install）" >&2
    exit 1
  fi
  cd "$HARNESS_DIR"
  NODE_BIN="$(command -v node)"
  if [ -x "$HOME/.hermes/node/bin/node" ]; then
    NODE_BIN="$HOME/.hermes/node/bin/node"   # 与本机 dsh-web 服务保持同一 node
  fi
  RUN_CMD="$NODE_BIN --import tsx/esm apps/cli/src/bin.ts"
else
  # ===== 模式 B：全新机器 =====
  SOURCE_MODE=0
  if ! command -v pnpm >/dev/null 2>&1; then
    log "安装 pnpm ..."
    if command -v corepack >/dev/null 2>&1; then
      corepack enable >/dev/null 2>&1 || true
      corepack prepare pnpm@11.7.0 --activate >/dev/null 2>&1 || true
    fi
    if ! command -v pnpm >/dev/null 2>&1; then
      NPM_GLOBAL="$INSTALL_DIR/npm-global"
      mkdir -p "$NPM_GLOBAL"
      npm install -g pnpm@11 --prefix "$NPM_GLOBAL" >/dev/null
      export PATH="$NPM_GLOBAL/bin:$PATH"
    fi
  fi
  log "pnpm $(pnpm -v)"
  if [ ! -d "$INSTALL_DIR/deepseek-harness" ]; then
    if [ -d "$HOME/harness-src/deepseek-harness-master" ]; then
      log "使用预置源码 ~/harness-src ..."
      mv "$HOME/harness-src/deepseek-harness-master" "$INSTALL_DIR/deepseek-harness"
    elif curl -sI -m 10 https://github.com >/dev/null 2>&1; then
      log "从 GitHub 下载 Harness 源码 ..."
      curl -fsSL "https://github.com/deepseek-ai/deepseek-harness/archive/refs/heads/master.tar.gz" -o harness.tar.gz
      tar -xzf harness.tar.gz
      mv deepseek-harness-master deepseek-harness
      rm -f harness.tar.gz
    else
      echo "无法获取 Harness 源码：本机访问不了 github，且未在 ~/harness-src 预置。" >&2
      exit 1
    fi
  fi
  cd "$INSTALL_DIR/deepseek-harness"
  if [ ! -d node_modules ]; then
    log "pnpm install（首次较久）..."
    pnpm install
  fi
  RUN_CMD="pnpm dsh"
fi

# ---------- 3. 复制插件 ----------
log "同步 dsh-remote-x 插件 ..."
rm -rf "$INSTALL_DIR/dsh-remote-x"
cp -r "$PLUGIN_SRC" "$INSTALL_DIR/dsh-remote-x"

# ---------- 4. 生成 cordis 补丁（0.0.0.0 + token + 可选 Echo） ----------
TOKEN="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
TOKEN="${TOKEN:-dshremote$(date +%s)}"
PATCH_FILE="$INSTALL_DIR/remote.patch.yml"
{
  echo "# 由 deploy-remote.sh 生成（$(date '+%F %T')）"
  echo "# webserver 用顶层裸行 patch 覆盖（insert 会与 web-app bundle 已有行重复 id）；"
  echo "# patch 替换目标行整个 config，需重述 bundle 行全部键。"
  echo "- id: webserver"
  echo "  config:"
  echo "    host: '0.0.0.0'"
  echo "    port: $PORT"
  echo "    compression: gzip"
  echo "    compressionLevel: 1"
  echo "    compressionThresholdBytes: 1024"
  echo "- insert:"
  echo "    - id: dsh-remote-x"
  echo "      name: '$INSTALL_DIR/dsh-remote-x/src/index.ts'"
  echo "      config:"
  echo "        route: /remote"
  echo "        title: DeepSeek 远程控制"
  echo "        token: '$TOKEN'"
  if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
    echo "- insert:"
    echo "    - id: echo-llm"
    echo "      name: '$INSTALL_DIR/dsh-remote-x/deploy/echo-adapter.ts'"
  fi
} > "$PATCH_FILE"

# ---------- 5. 防火墙（尽力而为） ----------
if command -v ufw >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
fi

# ---------- 6. 启动 ----------
LOG="$INSTALL_DIR/harness.log"
if [ "$(pgrep -f 'apps/cli/src/bin[.]ts web' | head -1)" != "" ]; then
  log "发现旧的测试实例，先停止 ..."
  pkill -f 'apps/cli/src/bin[.]ts web' 2>/dev/null || true
  sleep 3
fi
log "启动 Harness Web UI（端口 $PORT，模式：$([ "$SOURCE_MODE" -eq 1 ] && echo 源码tsx || echo pnpm)）..."
nohup $RUN_CMD web --patch "$PATCH_FILE" --no-open > "$LOG" 2>&1 &
echo $! > "$INSTALL_DIR/harness.pid"
sleep 6
if ! kill -0 "$(cat "$INSTALL_DIR/harness.pid")" 2>/dev/null; then
  echo "启动失败，最近日志：" >&2
  tail -n 40 "$LOG" >&2
  exit 1
fi

LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
LOCAL_IP="${LOCAL_IP:-<主机IP>}"

log "部署完成！"
cat <<EOF

  插件页面（手机 / 平板 / 电脑）：
    http://$LOCAL_IP:$PORT/remote/?token=$TOKEN

  模型：
$(if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
    echo "    真实 DeepSeek（deepseek-official）"
else
    echo "    Echo 测试适配器（模型下拉选「Echo 回声模型」；export DEEPSEEK_API_KEY 后重启切真实模型）"
fi)

  常用命令：
    API 实测   PORT=$PORT bash $INSTALL_DIR/dsh-remote-x/deploy/verify.sh
    查看日志   tail -f $LOG
    停止       kill \$(cat $INSTALL_DIR/harness.pid)

  说明：本实例独立于 systemd 的 dsh-web.service（3080）运行，互不影响；
        Harness 服务的接管守卫只匹配 apps/cli/lib/bin[.]js，不会杀本实例。
EOF
