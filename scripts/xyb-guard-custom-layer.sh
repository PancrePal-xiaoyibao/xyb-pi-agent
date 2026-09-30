#!/usr/bin/env bash
#
# 定制层不变量守卫：证明「自动合并上游」没有碰到社区定制内容。
#
# 自动把上游合进 main 是可信的，前提是能被证明「定制那层没被动过」。
# 这里用两条互补的判据，而不是靠约定：
#
#   判据 A（动态）定制层 = 我们的树里有、上游树里没有的文件。
#           上游的提交不可能改动这些路径，所以合并前后必须逐字节不变。
#           这条能自动覆盖新加的插件/技能/脚本，无需维护清单。
#
#   判据 B（显式）几组固定路径模式（插件、子智能体、品牌母版、本 fork 的脚本与文档）。
#           用于兜住一个边界情况：万一上游新增了与我们同名的文件，
#           该路径会从「判据 A 的定制层」里消失，此时靠 B 仍然守得住。
#
# 用法：
#   bash scripts/xyb-guard-custom-layer.sh <上游ref> <合并前基准ref> [合并后ref]
#
# 例：
#   bash scripts/xyb-guard-custom-layer.sh upstream/main origin/main HEAD
#
# 退出码：0 = 定制层未被触碰；1 = 被触碰（应中止自动合并）
#
set -uo pipefail

# comm 要求「输入排序」与「comm 自己的 collation」一致（都是 LC_ALL=C）。
# 只给 sort 加 LC_ALL=C 而 comm 用系统 locale，会让 comm 的比对失效：
# 实测表现为几乎把所有文件都判成「仅我们独有」（2926 个），必须整脚本统一。
export LC_ALL=C

UPSTREAM_REF="${1:-}"
BASE_REF="${2:-}"
HEAD_REF="${3:-HEAD}"

if [ -z "${UPSTREAM_REF}" ] || [ -z "${BASE_REF}" ]; then
  echo "用法: bash scripts/xyb-guard-custom-layer.sh <上游ref> <合并前基准ref> [合并后ref]" >&2
  echo "  例: bash scripts/xyb-guard-custom-layer.sh upstream/main origin/main HEAD" >&2
  exit 2
fi

for ref in "${UPSTREAM_REF}" "${BASE_REF}" "${HEAD_REF}"; do
  git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null || {
    echo "错误：ref 不存在：${ref}" >&2
    exit 2
  }
done

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# ── 判据 A：动态算出定制层 ────────────────────────────────────────────────
git ls-tree -r --name-only "${HEAD_REF}" | LC_ALL=C sort > "${TMP}/ours.txt"
git ls-tree -r --name-only "${UPSTREAM_REF}" | LC_ALL=C sort > "${TMP}/theirs.txt"
comm -23 "${TMP}/ours.txt" "${TMP}/theirs.txt" > "${TMP}/custom.txt"

git diff --name-only "${BASE_REF}" "${HEAD_REF}" | LC_ALL=C sort > "${TMP}/changed.txt"
comm -12 "${TMP}/custom.txt" "${TMP}/changed.txt" > "${TMP}/violations-a.txt"

CUSTOM_COUNT="$(wc -l < "${TMP}/custom.txt" | tr -d ' ')"
VIOL_A="$(wc -l < "${TMP}/violations-a.txt" | tr -d ' ')"

echo "定制层（上游树里不存在的文件）：${CUSTOM_COUNT} 个"
echo "  判据 A · 其中被改动的：${VIOL_A} 个"

# ── 判据 B：固定路径模式 ──────────────────────────────────────────────────
PATTERNS=(
  "apps/desktop/resources/plugins/xyb.*"
  "subagents"
  "assets/brand-masters"
  "scripts/xyb-*"
  "XYB-*.md"
)

: > "${TMP}/violations-b.txt"
for pat in "${PATTERNS[@]}"; do
  git diff --name-only "${BASE_REF}" "${HEAD_REF}" -- "${pat}" >> "${TMP}/violations-b.txt"
done
# 模式之间可能有重叠，去重
if [ -s "${TMP}/violations-b.txt" ]; then
  LC_ALL=C sort -u "${TMP}/violations-b.txt" -o "${TMP}/violations-b.txt"
fi
VIOL_B="$(wc -l < "${TMP}/violations-b.txt" | tr -d ' ')"
echo "  判据 B · 固定模式命中被改动：${VIOL_B} 个"

# ── 结论 ──────────────────────────────────────────────────────────────────
if [ "${VIOL_A}" -eq 0 ] && [ "${VIOL_B}" -eq 0 ]; then
  echo
  echo "✓ 定制层未被触碰（合并只动了上游既有的文件）"
  exit 0
fi

echo
echo "✗ 定制层被改动，自动合并应当中止：" >&2
cat "${TMP}/violations-a.txt" "${TMP}/violations-b.txt" 2>/dev/null \
  | LC_ALL=C sort -u > "${TMP}/all-violations.txt"
while IFS= read -r line; do
  [ -n "${line}" ] && echo "    ${line}" >&2
done < "${TMP}/all-violations.txt"
echo >&2
echo "注意：若这是「上游主动改了我们的路径」，说明上游开始侵占定制命名空间，" >&2
echo "      需要人工决定是跟随上游还是改名避让。" >&2
exit 1
