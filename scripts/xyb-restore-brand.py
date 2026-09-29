#!/usr/bin/env python3
"""从品牌母版确定性重建全部品牌资产。

为什么需要这个脚本
------------------
本仓库是小胰宝 fork，核心代码跟随上游 vastsa/PI-Desktop。品牌资产（应用图标、
侧栏 logo、首页动图、README logo）都放在**上游也拥有的路径**上，因此：

  · 上游改了同一文件 → 合并时二进制无法行级合并，需要人工选择；
  · 只有上游改了（我们自合并基点后没动过）→ git 会**静默采用上游版本**，
    品牌资产被覆盖且不报错。

两条路都足以让品牌丢失。所以把母版集中放在**纯新增目录** `assets/brand-masters/`
（永不与上游冲突），需要时用本脚本一键重建全部派生资产。

用法
----
  python3 scripts/xyb-restore-brand.py            # 重建全部品牌资产
  python3 scripts/xyb-restore-brand.py --check    # 只体检：是否有资产偏离母版（CI 用）

依赖：Pillow；图标部分会调用 scripts/xyb-generate-icons.py（同一解释器）。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTERS = os.path.join(ROOT, "assets", "brand-masters")

MASTER_LOGO = os.path.join(MASTERS, "logo.png")
ASSETS = os.path.join(ROOT, "apps", "desktop", "src", "assets")

# 首页动图与静态兜底都逐字节以母版为准。
# 静态兜底不从 GIF 派生：GIF 是 256 色调色板图，派生会引入量化色带，
# 与线上使用的全彩 PNG 不一致（实测 200x200 有 28179 px 差异）。
MASCOT_MASTERS = [
    "home-mascot-light.gif",
    "home-mascot-dark.gif",
    "home-mascot-still-light.png",
    "home-mascot-still-dark.png",
]
README_LOGO = os.path.join(ROOT, "docs", "image", "readme", "logo.png")
ICON_SCRIPT = os.path.join(ROOT, "scripts", "xyb-generate-icons.py")

CANVAS = 512
README_V_RATIO = 0.84  # 与旧 README logo 的竖向内容占比对齐，换图后显示大小不变


def digest(path: str) -> str:
    import hashlib

    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:16]


def check_masters() -> list[str]:
    missing = []
    for name in ["logo.png", *MASCOT_MASTERS]:
        path = os.path.join(MASTERS, name)
        if not os.path.isfile(path):
            missing.append(f"{name} -> {path}")
    return missing


def make_readme_logo(out_path: str) -> tuple[int, int]:
    """从 logo 母版生成 README 用 512x512，竖向内容占比对齐历史版本。"""
    src = Image.open(MASTER_LOGO).convert("RGBA")
    bbox = src.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
    if bbox is None:
        raise SystemExit("error: 母版 logo.png 全透明，无法生成 README logo")
    content = src.crop(bbox)
    cw, ch = content.size
    scale = (CANVAS * README_V_RATIO) / ch
    nw, nh = max(1, round(cw * scale)), max(1, round(ch * scale))
    resized = content.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((CANVAS - nw) // 2, (CANVAS - nh) // 2))
    canvas.save(out_path)
    return nw, nh


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只体检是否偏离母版，不改文件")
    args = ap.parse_args()

    missing = check_masters()
    if missing:
        print("error: 缺少品牌母版：", file=sys.stderr)
        for m in missing:
            print("  " + m, file=sys.stderr)
        print("\n母版应包含：logo.png（512 方形透明底）、home-mascot-light.gif、home-mascot-dark.gif",
              file=sys.stderr)
        return 1

    print("品牌母版:")
    with Image.open(MASTER_LOGO) as im:
        print(f"  {'logo.png':<40} {im.size[0]}x{im.size[1]}  "
              f"{os.path.getsize(MASTER_LOGO)} bytes")
    for name in MASCOT_MASTERS:
        p = os.path.join(MASTERS, name)
        with Image.open(p) as im:
            frames = getattr(im, "n_frames", 1)
            extra = f" frames={frames}" if frames > 1 else ""
            print(f"  {name:<40} {im.size[0]}x{im.size[1]}{extra}  "
                  f"{os.path.getsize(p)} bytes")

    # 母版 -> 工程实际读取路径
    targets: list[tuple[str, str]] = []
    for name in MASCOT_MASTERS:
        targets.append((os.path.join(MASTERS, name), os.path.join(ASSETS, name)))

    if args.check:
        drift = []
        for master, dest in targets:
            if not os.path.isfile(dest):
                drift.append(f"缺失: {os.path.relpath(dest, ROOT)}")
            elif digest(master) != digest(dest):
                drift.append(f"偏离母版: {os.path.relpath(dest, ROOT)}")
        if os.path.isfile(README_LOGO):
            with Image.open(README_LOGO) as im:
                bb = im.convert("RGBA").getchannel("A").point(
                    lambda v: 255 if v > 40 else 0).getbbox()
            if bb is None or abs((bb[3] - bb[1]) / im.size[1] - README_V_RATIO) > 0.02:
                drift.append(
                    f"偏离母版: {os.path.relpath(README_LOGO, ROOT)}（竖向内容占比异常）")
        else:
            drift.append("缺失: docs/image/readme/logo.png")

        if drift:
            print("\n⚠ 品牌资产偏离母版：")
            for d in drift:
                print("  " + d)
            print("\n修复：python3 scripts/xyb-restore-brand.py")
            return 1
        print("\n✓ 品牌资产与母版一致")
        return 0

    print("\n重建品牌资产:")
    for master, dest in targets:
        with open(master, "rb") as src, open(dest, "wb") as out:
            out.write(src.read())
        print(f"  母版   {os.path.relpath(dest, ROOT)}")

    nw, nh = make_readme_logo(README_LOGO)
    print(f"  派生   {os.path.relpath(README_LOGO, ROOT)}  ({nw}x{nh} 居中于 {CANVAS})")

    # 4) 图标族 + UI 品牌 logo：交给既有生成器，单点维护
    print("\n调用 scripts/xyb-generate-icons.py（图标 / .icns / .ico / UI logo）:")
    code = subprocess.call([sys.executable, ICON_SCRIPT, MASTER_LOGO])
    if code != 0:
        print("error: 图标生成失败", file=sys.stderr)
        return code

    print("\n完成。核对改动：git status --short -- assets apps/desktop/build apps/desktop/src/assets docs/image")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
