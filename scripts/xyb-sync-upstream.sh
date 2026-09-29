#!/usr/bin/env bash
#
# 把上游 vastsa/PI-Desktop 的新提交并入小胰宝 fork。
#
# 设计原则：先体检、后合并。默认只体检，不碰工作区。
#
# 用法：
#   bash scripts/xyb-sync-upstream.sh                 # 体检：fetch + 偏离报告 + 冲突预演
#   bash scripts/xyb-sync-upstream.sh --merge         # 体检通过后合并，并做品牌体检
#   bash scripts/xyb-sync-upstream.sh --merge --push  # 合并并推送 origin
#
# 为什么是 merge 而不是 rebase：
#   本 fork 的 main 已推送到公开仓库。rebase 会重写已发布的 12 个提交，
#   每次同步都产生新的提交哈希，历史无法追溯，也无法与他人协作。
#   merge 保留一条明确的分界线（upstream 到哪、我们加了什么），可审计。
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

UPSTREAM_REMOTE="upstream"
UPSTREAM_REF="${UPSTREAM_REMOTE}/main"
ORIGIN_BRANCH="main"

DO_MERGE=0
DO_PUSH=0
for arg in "$@"; do
  case "${arg}" in
    --merge) DO_MERGE=1 ;;
    --push) DO_PUSH=1; DO_MERGE=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：${arg}（可用：--merge / --push）" >&2; exit 2 ;;
  esac
done

blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "错误：未找到 git。"

# ── 0. 前置检查 ────────────────────────────────────────────────────────────
git remote get-url "${UPSTREAM_REMOTE}" >/dev/null 2>&1 || die \
"错误：未配置 upstream 远端。请先执行：
  git remote add upstream git@github.com:vastsa/PI-Desktop.git"

if [ "${DO_MERGE}" -eq 1 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    die "错误：工作区不干净，先提交或 stash。合并期间混入未提交改动容易丢东西。

$(git status --short)"
  fi
fi

# ── 1. 拉取上游 ────────────────────────────────────────────────────────────
blue "▸ 拉取上游 ${UPSTREAM_REMOTE} …"
if ! git fetch "${UPSTREAM_REMOTE}" --prune --tags 2>&1 | tail -5; then
  warn "⚠ 拉取失败。常见原因：网络抖动或 SSH 认证瞬时失败（本机出现过多次）。
   稍后重试即可；如持续失败，检查 ssh -T git@github.com。"
  exit 1
fi

BEHIND="$(git rev-list --count "HEAD..${UPSTREAM_REF}")"
AHEAD="$(git rev-list --count "${UPSTREAM_REF}..HEAD")"
BASE="$(git merge-base HEAD "${UPSTREAM_REF}")"

echo
echo "  上游最新：$(git log -1 --format='%h  %ad  %s' --date=format:'%Y-%m-%d %H:%M' "${UPSTREAM_REF}")"
echo "  合并基点：$(git log -1 --format='%h  %ad' --date=format:'%Y-%m-%d' "${BASE}")"
echo "  上游领先：${BEHIND} 个提交"
echo "  我们领先：${AHEAD} 个提交（= fork 的提交数）"

if [ "${BEHIND}" -eq 0 ]; then
  echo
  green "✓ 已与上游同步，无需操作。"
  exit 0
fi

# ── 2. 上游待并入的提交 ────────────────────────────────────────────────────
echo
blue "▸ 上游待并入的提交（最多 15 条）"
git log --format='  %h  %ad  %s' --date=format:'%m-%d %H:%M' \
  "HEAD..${UPSTREAM_REF}" | head -15
if [ "${BEHIND}" -gt 15 ]; then
  echo "  … 另有 $((BEHIND - 15)) 条"
fi
echo
echo "  上游改动的文件数：$(git diff --name-only "HEAD...${UPSTREAM_REF}" | wc -l | tr -d ' ')"

# ── 3. 冲突预演（不修改工作区）─────────────────────────────────────────────
echo
blue "▸ 冲突预演（git merge-tree，不落工作区）"
MERGE_TREE_OUT="$(git merge-tree --write-tree --name-only HEAD "${UPSTREAM_REF}" 2>&1)"
MERGE_TREE_RC=$?
if [ "${MERGE_TREE_RC}" -eq 0 ]; then
  green "  ✓ 可干净合并，无冲突"
  CONFLICTS=""
else
  CONFLICTS="$(printf '%s\n' "${MERGE_TREE_OUT}" | tail -n +2)"
  warn "  ⚠ 预测到冲突文件："
  printf '%s\n' "${CONFLICTS}" | sed 's/^/      /'
fi

# ── 4. 我们的偏离分类（决定长期维护成本的指标）─────────────────────────────
echo
blue "▸ 小胰宝 fork 相对上游的偏离（相对合并基点 ${BASE:0:7}）"
ADDED=$(git diff --name-status "${BASE}"...HEAD | grep -c '^A' || true)
MODIFIED=$(git diff --name-status "${BASE}"...HEAD | grep -c '^M' || true)
DELETED=$(git diff --name-status "${BASE}"...HEAD | grep -c '^D' || true)
echo "  纯新增（永不冲突，主要是插件/技能/子智能体/文档）：${ADDED}"
echo "  修改上游既有文件（合并关注点）：${MODIFIED}"
echo "  删除：${DELETED}"

BOTH="$(comm -12 \
  <(git diff --name-only "${BASE}"...HEAD | sort) \
  <(git diff --name-only "HEAD...${UPSTREAM_REF}" | sort))"
echo
if [ -n "${BOTH}" ]; then
  echo "  ⚠ 双方都改过的文件（下次合并最可能冲突的地方）："
  printf '%s\n' "${BOTH}" | sed 's/^/      /'
else
  green "  ✓ 与上游本轮改动没有文件重叠"
fi

# ── 5. 体检结束 ────────────────────────────────────────────────────────────
if [ "${DO_MERGE}" -eq 0 ]; then
  echo
  echo "体检完成。要真正合并："
  echo "  bash scripts/xyb-sync-upstream.sh --merge"
  exit 0
fi

# ── 6. 合并 ────────────────────────────────────────────────────────────────
echo
blue "▸ 合并 ${UPSTREAM_REF} → ${ORIGIN_BRANCH}（--no-ff，保留分界）"
if ! git merge --no-ff "${UPSTREAM_REF}" -m \
  "Merge ${UPSTREAM_REMOTE}/main into ${ORIGIN_BRANCH}

并入上游 $(git log -1 --format='%h (%ad)' --date=format:'%Y-%m-%d' "${UPSTREAM_REF}") 及其之前 ${BEHIND} 个提交。
本 fork 的定制全部位于：apps/desktop/resources/plugins/、subagents/、skills、品牌资产与设置页。
"; then
  echo
  warn "⚠ 合并有冲突，需要人工处理。已提交的冲突文件："
  git diff --name-only --diff-filter=U | sed 's/^/      /'
  echo
  echo "  品牌字符串（packages/i18n/**）冲突的机械化解法："
  echo "    git checkout --theirs packages/i18n/src/locales/<loc>/index.ts"
  echo "    python3 scripts/xyb-apply-brand-strings.py --fix-apphelp"
  echo "  解决后：git add <文件> && git commit"
  echo
  echo "  放弃本次合并：git merge --abort"
  exit 1
fi

NEW_HEAD="$(git rev-parse --short HEAD)"
green "  ✓ 合并完成：${NEW_HEAD}"

# ── 7. 合并后体检：品牌资产 + 仓库校验 ─────────────────────────────────────
echo
blue "▸ 品牌资产体检（上游可能覆盖了品牌资源）"
if command -v python3 >/dev/null; then
  if python3 scripts/xyb-restore-brand.py --check >/dev/null 2>&1; then
    green "  ✓ 品牌资产与母版一致"
  else
    warn "  ⚠ 品牌资产被上游覆盖或缺失，正在从母版重建…"
    python3 scripts/xyb-restore-brand.py | sed 's/^/      /'
    echo
    warn "  已重建。请检查并提交：git status --short"
  fi
else
  warn "  ⚠ 未找到 python3，跳过品牌体检"
fi

echo
blue "▸ 插件与子智能体校验"
if command -v node >/dev/null; then
  node scripts/xyb-check-plugins.mjs 2>&1 | tail -6 | sed 's/^/      /'
  node scripts/xyb-check-subagents.mjs 2>&1 | tail -3 | sed 's/^/      /'
else
  warn "  ⚠ 未找到 node，跳过"
fi

# ── 8. 后续步骤 ────────────────────────────────────────────────────────────
cat <<EOF

────────────────────────────────────────────────────────────
合并后必须做的事（上游可能改了核心接口，插件是贴着接口写的）：

  1) 编译 workspace 包
       pnpm build:js
  2) 重新编译 Rust host（上游改了 host-core 时）
       cargo build -p host-core
  3) 启动应用，确认插件与视图仍在
       bash scripts/xyb-dev.sh

  上游改动落在 apps/desktop/electron/** 或 packages/plugin-sdk/** 时，
  务必重点回归：插件加载、右侧面板视图、助手工具调用。
────────────────────────────────────────────────────────────
EOF

if [ "${DO_PUSH}" -eq 1 ]; then
  echo
  blue "▸ 推送 origin/${ORIGIN_BRANCH}"
  git push origin "${ORIGIN_BRANCH}" || die "推送失败。"
  green "✓ 已推送"
else
  echo
  echo "确认无误后推送：git push origin ${ORIGIN_BRANCH}"
fi
