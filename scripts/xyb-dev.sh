#!/usr/bin/env bash
#
# 小胰宝 · 开发启动脚本
#
# 为什么需要它：本机环境有三处会让 Electron 应用起不来的预设，每次手敲容易漏。
#   1. NODE_OPTIONS 被注入了 node-language-shim.cjs（拦截 fs，pnpm 装依赖时也会被它拦）
#   2. ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node，报
#      "does not provide an export named 'BrowserWindow'"
#   3. Chromium 自带沙箱在本机初始化失败，必须传 --no-sandbox
#
# 用法：
#   bash scripts/xyb-dev.sh              # 直接启动（要求 host-core 已编译）
#   bash scripts/xyb-dev.sh --build-host # 先编译 host-core 再启动
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# 本机 Node 22（满足 engines: >=22.19.0）；cargo 供 host-core 编译与运行
NODE_BIN="/Users/qinxiaoqiang/.workbuddy/binaries/node/versions/22.22.2-3/bin"
CARGO_BIN="${HOME}/.cargo/bin"

if [ ! -x "${NODE_BIN}/node" ]; then
  echo "找不到 Node：${NODE_BIN}/node" >&2
  exit 1
fi

if [ "${1:-}" = "--build-host" ]; then
  if [ ! -x "${CARGO_BIN}/cargo" ]; then
    echo "找不到 cargo，请先安装 Rust：https://rustup.rs" >&2
    exit 1
  fi
  echo "编译 host-core（走 USTC 镜像加速）..."
  "${CARGO_BIN}/cargo" \
    --config 'source.crates-io.replace-with="ustc"' \
    --config 'source.ustc.registry="sparse+https://mirrors.ustc.edu.cn/crates.io-index/"' \
    build -p host-core
fi

HOST_BIN="${REPO_ROOT}/target/debug/pi-desktop-host-core"
if [ ! -x "${HOST_BIN}" ]; then
  echo "提示：host-core 未编译，模型配置与 AI 对话将不可用。" >&2
  echo "      先执行：bash scripts/xyb-dev.sh --build-host" >&2
fi

echo "启动小胰宝（开发模式）..."

env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE \
  PATH="${NODE_BIN}:${CARGO_BIN}:${PATH}" \
  node scripts/dev-electron.mjs -- --no-sandbox
