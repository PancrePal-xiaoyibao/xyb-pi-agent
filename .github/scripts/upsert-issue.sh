#!/usr/bin/env bash
#
# 按标题「开或更新」一个 issue。
#
# 用途：上游同步的冲突/失败通知。同一类事件应更新同一个 issue，
# 而不是每周新开一个——否则通知会堆成噪音，最后没人看。
#
# 用法：
#   GH_TOKEN=... bash .github/scripts/upsert-issue.sh "标题" /path/body.md
#
set -euo pipefail

TITLE="${1:-}"
BODY_FILE="${2:-}"

if [ -z "${TITLE}" ] || [ -z "${BODY_FILE}" ]; then
  echo "用法: upsert-issue.sh <标题> <正文文件>" >&2
  exit 2
fi

if [ ! -f "${BODY_FILE}" ]; then
  echo "错误：正文文件不存在：${BODY_FILE}" >&2
  exit 2
fi

if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "错误：需要 GH_TOKEN 或 GITHUB_TOKEN" >&2
  exit 2
fi

EXISTING="$(gh issue list --state open --search "${TITLE} in:title" \
  --json number --jq '.[0].number // empty')"

if [ -n "${EXISTING}" ]; then
  gh issue comment "${EXISTING}" --body-file "${BODY_FILE}"
  echo "已更新既有 issue #${EXISTING}"
else
  gh issue create --title "${TITLE}" --body-file "${BODY_FILE}"
fi
