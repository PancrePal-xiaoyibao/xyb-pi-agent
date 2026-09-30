#!/usr/bin/env bash
#
# 小胰宝 · 中国药物临床试验登记平台采集环境准备
#
# 在 ~/.xyb-chinadrugtrials/ 下建 Python 虚拟环境并安装采集器依赖。
# 幂等：已就绪时直接退出，不会重复安装。
#
# 应用内也有等价能力（MCP 工具 setup_environment），本脚本供终端手动执行时使用。
#
# 用法：bash scripts/xyb-setup-chinadrugtrials.sh

set -euo pipefail

DATA_DIR="${HOME}/.xyb-chinadrugtrials"
VENV_DIR="${DATA_DIR}/venv"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${REPO_ROOT}/apps/desktop/resources/plugins/xyb.trial-sources"
REQUIREMENTS="${PLUGIN_DIR}/collectors/chinadrugtrials/scripts/requirements.txt"

info() { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ -f "${REQUIREMENTS}" ] || fail "找不到依赖清单：${REQUIREMENTS}"

# ── 1. 找 python3 ──────────────────────────────
if [ -x "${VENV_DIR}/bin/python3" ]; then
  PYTHON="${VENV_DIR}/bin/python3"
  info "已存在虚拟环境：${VENV_DIR}"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="$(command -v python3)"
else
  fail "$(cat <<'MSG'
本机没有 python3，无法准备采集环境。
macOS 可执行：xcode-select --install
也可以从 https://www.python.org/downloads/ 安装后重试。
这一步只能由你本人完成，脚本装不了 Python。
MSG
)"
fi

info "Python：${PYTHON} ($("${PYTHON}" -c 'import sys;print(sys.version.split()[0])'))"

# ── 2. 建虚拟环境 ──────────────────────────────
if [ ! -x "${VENV_DIR}/bin/python3" ]; then
  info "创建虚拟环境：${VENV_DIR}"
  mkdir -p "${DATA_DIR}"
  chmod 700 "${DATA_DIR}" 2>/dev/null || true
  "${PYTHON}" -m venv "${VENV_DIR}" || fail "创建虚拟环境失败"
  PYTHON="${VENV_DIR}/bin/python3"
fi

# ── 3. 装依赖 ──────────────────────────────────
if "${PYTHON}" -c "import requests, bs4" >/dev/null 2>&1; then
  info "采集器依赖已就绪，跳过安装。"
else
  info "安装采集器依赖（需要联网，可能要一两分钟）…"
  "${VENV_DIR}/bin/pip" install --disable-pip-version-check -r "${REQUIREMENTS}" \
    || fail "依赖安装失败。多为网络问题，可换国内镜像后重试：
    ${VENV_DIR}/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r ${REQUIREMENTS}"
fi

# ── 4. 自检 ────────────────────────────────────
if ! "${PYTHON}" -c "import requests, bs4" >/dev/null 2>&1; then
  fail "依赖自检未通过，请查看上面的安装输出。"
fi

info ""
info "采集环境已就绪。"
info "  数据目录：${DATA_DIR}"
info "  解释器  ：${PYTHON}"
info ""
info "接下来（都在小胰宝里操作）："
info "  1. 重启应用，在「试验来源」面板确认该来源已启用"
info "  2. 在浏览器打开 https://www.chinadrugtrials.org.cn 并正常访问一次"
info "  3. 用开发者工具对站内【实际搜索请求】右键「复制为 cURL」"
info "  4. 在会话里把这段 cURL 交给助手，让它调用会话配置工具保存"
info "  5. 之后就可以让助手检索、取详情、做增量同步"
info ""
info "注意：站点校验浏览器会话，会话过期后需要你本人重新复制一次。"
info "      抓取是逐条进行的（每条间隔 1.5 秒），比查缓存慢。"
