#!/usr/bin/env bash
#
# 把小胰宝的 MDT 视角子智能体安装到 ~/.agents/subagents/
#
# 为什么要脚本：PI-Desktop 的插件无法贡献子智能体（插件清单里没有这个贡献点，
# 属刻意设计——仓库不能静默往用户的代理目录里加一个"能行动的委派者"）。
# 所以只能由用户显式运行一次。
#
# 用法：
#   bash scripts/xyb-install-subagents.sh              安装 / 覆盖
#   bash scripts/xyb-install-subagents.sh --uninstall  卸载（只删本套装）
#   bash scripts/xyb-install-subagents.sh --dry-run    只看会做什么
#
# 安全约定：
#   - 只动本套装对应的文件名，其它文件一律不碰
#   - 覆盖前把同名旧文件备份到 ~/.agents/subagents/.xyb-backup-<时间戳>/
#   - --uninstall 只删本套装文件名，且删前再备份一次

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/subagents"
TARGET_DIR="${HOME}/.agents/subagents"

DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数: ${arg}" >&2; exit 2 ;;
  esac
done

if [ ! -d "${SOURCE_DIR}" ]; then
  echo "错误：找不到定义目录 ${SOURCE_DIR}" >&2
  exit 1
fi

# 只处理 mdt-*.md，避免误伤
FILES=()
while IFS= read -r f; do
  FILES+=("$(basename "${f}")")
done < <(find "${SOURCE_DIR}" -maxdepth 1 -type f -name 'mdt-*.md' | sort)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "错误：${SOURCE_DIR} 下没有 mdt-*.md" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${TARGET_DIR}/.xyb-backup-${STAMP}"

echo "定义目录: ${SOURCE_DIR}"
echo "安装目标: ${TARGET_DIR}"
echo "本套装共 ${#FILES[@]} 个文件"
echo

if [ "${UNINSTALL}" -eq 1 ]; then
  if [ ! -d "${TARGET_DIR}" ]; then
    echo "目标目录不存在，无需卸载。"
    exit 0
  fi
  removed=0
  for name in "${FILES[@]}"; do
    target="${TARGET_DIR}/${name}"
    if [ -f "${target}" ]; then
      if [ "${DRY_RUN}" -eq 1 ]; then
        echo "会删除 ${name}"
      else
        mkdir -p "${BACKUP_DIR}"
        cp -p "${target}" "${BACKUP_DIR}/${name}"
        rm -f "${target}"
        echo "已删除 ${name}"
      fi
      removed=$((removed + 1))
    fi
  done
  echo
  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "（演练模式，未改动任何文件）"
  else
    echo "已卸载 ${removed} 个文件。备份：${BACKUP_DIR}"
    echo "提示：删除后需要新开会话或重启应用才会生效。"
  fi
  exit 0
fi

# ── 安装 ──
created=0
overwritten=0
for name in "${FILES[@]}"; do
  source_file="${SOURCE_DIR}/${name}"
  target="${TARGET_DIR}/${name}"
  if [ -f "${target}" ]; then
    if [ "${DRY_RUN}" -eq 1 ]; then
      echo "会覆盖 ${name}"
    else
      mkdir -p "${BACKUP_DIR}"
      cp -p "${target}" "${BACKUP_DIR}/${name}"
      cp "${source_file}" "${target}"
      echo "已覆盖 ${name}（旧文件已备份）"
    fi
    overwritten=$((overwritten + 1))
  else
    if [ "${DRY_RUN}" -eq 1 ]; then
      echo "会新增 ${name}"
    else
      mkdir -p "${TARGET_DIR}"
      cp "${source_file}" "${target}"
      echo "已新增 ${name}"
    fi
    created=$((created + 1))
  fi
done

echo
if [ "${DRY_RUN}" -eq 1 ]; then
  echo "（演练模式，未改动任何文件）"
  exit 0
fi

echo "安装完成：新增 ${created} 个，覆盖 ${overwritten} 个"
if [ -d "${BACKUP_DIR}" ]; then
  echo "覆盖前的旧文件备份在：${BACKUP_DIR}"
fi
echo
echo "接下来："
echo "  1. 新开一个会话（或重启应用）才会加载这些定义"
echo "  2. 到「设置 → 子智能体」确认它们已出现，并按需开关"
echo "  3. 患者版还要默认关掉内置的 5 个软件工程角色，跑："
echo "     node scripts/xyb-disable-engineering-subagents.mjs"
echo "     （探索者 / 代码审查员 / 测试执行者 / 修复者 / UI 设计师）"
echo
echo "卸载：bash scripts/xyb-install-subagents.sh --uninstall"
