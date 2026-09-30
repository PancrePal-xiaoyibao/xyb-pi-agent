#!/usr/bin/env bash
#
# 把 README 用的 SVG 源渲染成 PNG。
#
# 为什么需要它
# ------------
# SVG 在不少 Markdown 渲染环境里**不显示**——GitHub 的图片代理、编辑器预览、
# 各类导出工具都有各自的限制。README 里用 PNG 才稳。
# 但 PNG 不方便改字，所以保留 SVG 作为可编辑的源，改完跑一次本脚本重新生成。
#
# 另一个坑：**不要用宿主主题的 CSS 变量**（var(--color-*)）。
# 变量一旦离开宿主环境就不存在，fill 会回退成 SVG 默认的黑色 —— 黑底黑字全看不见。
# 所以 SVG 源里必须硬编码配色，并铺一块白色背景矩形。
#
# 用法：
#   bash scripts/xyb-render-readme-diagrams.sh
#   CHROME=/path/to/chrome bash scripts/xyb-render-readme-diagrams.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${REPO_ROOT}/docs/image/readme"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ ! -x "${CHROME}" ]; then
  echo "找不到 Chrome：${CHROME}" >&2
  echo "可用 CHROME=/path/to/chrome 指定，或在装有 Chrome 的机器上跑。" >&2
  exit 1
fi

shopt -s nullglob
files=("${DIR}"/*.svg)
if [ ${#files[@]} -eq 0 ]; then
  echo "没有 SVG 源：${DIR}" >&2
  exit 1
fi

echo "渲染 README 示意图（2x）："
for svg in "${files[@]}"; do
  name="$(basename "${svg}" .svg)"

  dims="$(python3 - "${svg}" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r'viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"', text)
print(f"{m.group(1)} {m.group(2)}" if m else "")
PY
)"
  if [ -z "${dims}" ]; then
    echo "  跳过 ${name}：读不到 viewBox" >&2
    continue
  fi

  w="${dims%% *}"
  h="${dims##* }"
  out="${DIR}/${name}.png"

  "${CHROME}" --headless --disable-gpu --no-sandbox \
    --force-device-scale-factor=2 --default-background-color=FFFFFFFF \
    --window-size="${w},${h}" --screenshot="${out}" "file://${svg}" >/dev/null 2>&1

  if [ -f "${out}" ]; then
    printf '  %-36s %sx%s\n' "${name}.png" "$((w * 2))" "$((h * 2))"
  else
    echo "  生成失败：${name}" >&2
    exit 1
  fi
done

echo "完成。README 引用 .png，SVG 只作为可编辑的源。"
