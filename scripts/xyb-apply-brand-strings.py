#!/usr/bin/env python3
"""处理 i18n 里的上游品牌残留（PI-Desktop -> xyb-pi）。

为什么单独做一个脚本
--------------------
`packages/i18n/src/locales/**` 是上游改动**最频繁**的文件（近 200 个提交里
每一个都碰过它），也是我们唯一会持续冲突的地方。我们在这里的改动只是把品牌词
`PI-Desktop` 换成 `xyb-pi`，属于**纯机械替换**——所以不该靠人工解冲突，
而是合并后无条件重放一次。

三个用途：
  1. 体检：还剩多少处上游品牌词出现在用户可见文案里（现在应用里仍能看到
     「让 PI-Desktop 帮你做任何事」这类文案）。
  2. `--fix-apphelp`：把「帮助」菜单恢复成 xyb-pi（这是当前唯一已提交的品牌改动，
     解冲突时用）。
  3. `--fix-all`：把所有**安全**的文案值统一替换。遇到含 URL / 路径的值会跳过并报告，
     避免把 GitHub 链接里的仓库名一起改掉。

用法
----
  python3 scripts/xyb-apply-brand-strings.py                  # 体检（默认）
  python3 scripts/xyb-apply-brand-strings.py --fix-apphelp    # 只修 appHelp（解冲突）
  python3 scripts/xyb-apply-brand-strings.py --fix-all        # 全量替换安全值
  python3 scripts/xyb-apply-brand-strings.py --check          # CI：仍有残留则退出码 1
  python3 scripts/xyb-apply-brand-strings.py --to "小胰宝"     # 指定替换词
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_GLOB = os.path.join(ROOT, "packages", "i18n", "src", "locales", "*", "index.ts")

UPSTREAM_TOKEN = "PI-Desktop"
DEFAULT_REPLACEMENT = "xyb-pi"

# key: "value",  /  "quoted.key": "value"  —— 识别「这一行属于哪个键」
KEY_RE = re.compile(r'^\s*(?:"(?P<qkey>[^"]+)"|(?P<key>[A-Za-z_$][\w$.]*))\s*:')

# 含这些内容的值不改：改掉会破坏链接或路径
UNSAFE_RE = re.compile(r"://|github\.com|docs\.qq\.com|\bwww\.")


def locales() -> list[str]:
    return sorted(glob.glob(LOCALES_GLOB))


def scan(path: str) -> list[tuple[int, str, str, bool]]:
    """返回 [(行号, key, 行内容, 是否安全)]，含多行字符串的续行。

    按「行」而不是按「完整键值对」匹配：上游文案里有跨行的字符串字面量，
    只认 `key: "value"` 单行形式会漏计（实测 zh-CN 漏 3 处）。
    """
    rows: list[tuple[int, str, str, bool]] = []
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            if UPSTREAM_TOKEN not in line:
                continue
            m = KEY_RE.match(line)
            key = (m.group("qkey") or m.group("key")) if m else "（续行）"
            rows.append((i, key, line.strip(), not UNSAFE_RE.search(line)))
    return rows


def rewrite(path: str, replacement: str, only_key: str | None) -> tuple[int, int, list[str]]:
    """返回 (改写行数, 跳过行数, 跳过的 key 列表)。"""
    out_lines: list[str] = []
    changed = skipped = 0
    skipped_keys: list[str] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if UPSTREAM_TOKEN not in line:
                out_lines.append(line)
                continue
            m = KEY_RE.match(line)
            key = (m.group("qkey") or m.group("key")) if m else None
            if only_key and key != only_key:
                out_lines.append(line)
                continue
            if UNSAFE_RE.search(line):
                skipped += 1
                skipped_keys.append(key or line.strip()[:48])
                out_lines.append(line)
                continue
            out_lines.append(line.replace(UPSTREAM_TOKEN, replacement))
            changed += 1
    if changed:
        with open(path, "w", encoding="utf-8") as fh:
            fh.writelines(out_lines)
    return changed, skipped, skipped_keys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", default=DEFAULT_REPLACEMENT,
                    help=f"替换词，默认 {DEFAULT_REPLACEMENT}")
    ap.add_argument("--fix-apphelp", action="store_true",
                    help="只把 appHelp 恢复为品牌词（解 i18n 冲突时用）")
    ap.add_argument("--fix-all", action="store_true",
                    help="把所有安全的文案值统一替换")
    ap.add_argument("--check", action="store_true",
                    help="门禁模式：任一语言的帮助菜单未品牌化则退出码 1")
    ap.add_argument("--strict", action="store_true",
                    help="配合 --check：任何残留都算失败")
    args = ap.parse_args()

    files = locales()
    if not files:
        print("error: 未找到 i18n 语言文件", file=sys.stderr)
        return 2

    if args.fix_apphelp or args.fix_all:
        mode = "appHelp" if args.fix_apphelp else "全部安全文案"
        print(f"替换规则：{UPSTREAM_TOKEN} -> {args.to}（{mode}）\n")
        total_changed = total_skipped = 0
        for path in files:
            loc = os.path.basename(os.path.dirname(path))
            changed, skipped, keys = rewrite(
                path, args.to, "appHelp" if args.fix_apphelp else None
            )
            total_changed += changed
            total_skipped += skipped
            note = f"，跳过 {skipped}" if skipped else ""
            print(f"  {loc:<8} 改写 {changed} 行{note}")
            if keys:
                for k in keys:
                    print(f"           ↳ 跳过（含链接/路径）: {k}")
        print(f"\n合计改写 {total_changed} 行，跳过 {total_skipped} 行")
        if total_skipped:
            print("跳过的值含 URL 或路径，需人工判断是否替换。")
        if args.fix_all:
            print("\n注意：这会让 i18n 相对上游的偏离变大，每次同步都要重放。")
            print("      重放命令：python3 scripts/xyb-apply-brand-strings.py --fix-all")
        return 0

    # ── 体检 ──
    remaining = 0
    unbranded_help: list[str] = []
    print(f"i18n 中的上游品牌残留（{UPSTREAM_TOKEN}）\n")
    for path in files:
        loc = os.path.basename(os.path.dirname(path))
        rows = scan(path)
        remaining += len(rows)
        apphelp = [r for r in rows if r[1] == "appHelp"]
        if apphelp:
            unbranded_help.append(loc)
        state = "⚠ 仍是上游品牌" if apphelp else "已品牌化"
        print(f"  {loc:<8} 残留 {len(rows):>2} 处   帮助菜单：{state}")
        for ln, key, value, _safe in apphelp:
            print(f"           L{ln} {value}")

    print()
    if remaining:
        print(f"共 {remaining} 处。这些字符串会直接显示给患者（如输入框占位符、退出对话框）。")
    else:
        print("✓ 没有残留")

    if unbranded_help:
        print(f"\n⚠ 帮助菜单仍是上游品牌的语言：{', '.join(unbranded_help)}")
        print("  上游新增语言或改写文案时会这样——修：--fix-apphelp")

    if args.fix_apphelp or args.fix_all:
        return 0

    if args.check:
        # 门禁只卡「帮助菜单」：它是已提交的品牌改动，一旦回退说明合并把品牌弄丢了。
        # 其余残留属产品待办，不阻塞流程（--strict 才卡）。
        if unbranded_help or (args.strict and remaining):
            return 1
        return 0

    print("\n  只修帮助菜单（保持与上游最小偏离）：--fix-apphelp")
    print("  全部替换（品牌一致，但每次同步需重放）：--fix-all")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
