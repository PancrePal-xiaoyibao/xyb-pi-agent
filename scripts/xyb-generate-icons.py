#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小胰宝 · 品牌图标一键生成

用途
    把一张方形 logo 母版（PNG，建议 512x512 或 1024x1024，透明底更好）批量适配为
    PI-Desktop / 小胰宝 桌面工程所需的全部图标资产。

用法
    python3 scripts/xyb-generate-icons.py <母版.png> [--padding 0.06] [--no-install]

说明
    - 自动做「内容 bbox 居中 + 安全留白」的正方形裁剪，再用 LANCZOS 高质量缩放；
    - 输出 PNG 各档 / macOS .icns（经 iconutil）/ Windows .ico（多尺寸）；
    - 默认同时写入工程实际读取路径（apps/desktop/build、apps/desktop/src/assets/brand）；
      加 --no-install 则只输出到 build/xyb/ 不覆盖工程文件。
    - 依赖：Pillow、macOS 自带 sips/iconutil（生成 icns 需要）。

背景
    基线为 vastsa/PI-Desktop v0.15.10。图标链路：
      apps/desktop/build/             → electron-builder 安装包图标
      apps/desktop/src/assets/brand/  → 应用内品牌 logo（192，深浅两版）
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

try:
    from PIL import Image
except ImportError:
    sys.exit("缺少 Pillow：请先安装（例如 pip install Pillow）")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "build", "xyb")
DESKTOP_BUILD = os.path.join(REPO, "apps", "desktop", "build")
UI_BRAND = os.path.join(REPO, "apps", "desktop", "src", "assets", "brand")

ICON_PNGS = (16, 32, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def square_crop(im, padding):
    """以内容 bbox 中心做正方形裁剪，四周留 padding 比例的安全边距。"""
    bbox = im.getchannel("A").getbbox()
    if not bbox:
        return im
    w, h = im.size
    x0, y0, x1, y1 = bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = max(x1 - x0, y1 - y0) / (1 - 2 * padding)
    nx0, ny0 = max(0, int(cx - side / 2)), max(0, int(cy - side / 2))
    nx1, ny1 = min(w, int(cx + side / 2)), min(h, int(cy + side / 2))
    return im.crop((nx0, ny0, nx1, ny1))


def clean_edges(img):
    """清除缩放产生的边缘半透明噪点。"""
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 8 and (r, g, b) != (0, 0, 0):
                px[x, y] = (0, 0, 0, 0)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="方形 logo 母版 PNG 路径")
    ap.add_argument("--padding", type=float, default=0.06, help="安全留白比例，默认 0.06")
    ap.add_argument("--no-install", action="store_true", help="只输出到 build/xyb/，不覆盖工程文件")
    args = ap.parse_args()

    src = Image.open(args.source).convert("RGBA")
    print(f"母版: {args.source} {src.size} {src.mode}")
    base = square_crop(src, args.padding)

    os.makedirs(OUT, exist_ok=True)
    made = {}

    for s in ICON_PNGS:
        img = clean_edges(base.resize((s, s), Image.LANCZOS))
        p = os.path.join(OUT, f"icon_{s}.png")
        img.save(p)
        made[s] = p

    # macOS .icns（经 iconset + iconutil）
    icns = os.path.join(OUT, "icon.icns")
    with tempfile.TemporaryDirectory() as td:
        iset = os.path.join(td, "x.iconset")
        os.makedirs(iset)
        pairs = [
            ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
            ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
            ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
            ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
            ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
        ]
        for name, s in pairs:
            shutil.copy(made[s], os.path.join(iset, name))
        try:
            subprocess.run(["iconutil", "-c", "icns", iset, "-o", icns], check=True)
            print(f"icns: {icns}")
        except (FileNotFoundError, subprocess.CalledProcessError) as e:
            print(f"!! icns 生成失败（跳过）: {e}")

    # Windows .ico（多尺寸）
    ico = os.path.join(OUT, "icon.ico")
    ims = [Image.open(made[s]).convert("RGBA") for s, _ in ICO_SIZES]
    # 底板必须用最大的那张。Pillow 的 ICO 写入只会「向下」生成 sizes，
    # 拿 16×16 当底板（原写法 ims[0]）就只会写出一条 16×16 记录——
    # 655 字节的单尺寸 ico，Windows 任务栏/资源管理器图标全尺寸发虚。
    # append_images 对 ICO 无效，删掉以免误导。
    ims[-1].save(ico, format="ICO", sizes=ICO_SIZES)
    print(f"ico: {ico}")

    # UI 品牌区 192
    for name in ("logo-light.png", "logo-dark.png", "brand-logo.png"):
        clean_edges(base.resize((192, 192), Image.LANCZOS)).save(os.path.join(OUT, name))

    if args.no_install:
        print("\n--no-install：资产仅输出到 build/xyb/")
        return

    # 安装到工程实际读取路径
    os.makedirs(DESKTOP_BUILD, exist_ok=True)
    os.makedirs(UI_BRAND, exist_ok=True)
    install = {
        made[1024]: ["icon_1024.png", "tray-icon-mac.png"],
        made[512]: ["icon.png", "logo_dark.png"],
        ico: ["icon.ico"],
    }
    for s, names in install.items():
        for n in names:
            shutil.copy(s, os.path.join(DESKTOP_BUILD, n))
    if os.path.exists(icns):
        shutil.copy(icns, os.path.join(DESKTOP_BUILD, "icon.icns"))
    for n in ("logo-light.png", "logo-dark.png"):
        shutil.copy(os.path.join(OUT, n), os.path.join(UI_BRAND, n))

    print("\n已写入工程：")
    print(f"  {DESKTOP_BUILD}/  (icon_1024/icon/logo_dark/tray-icon-mac/icon.icns/icon.ico)")
    print(f"  {UI_BRAND}/  (logo-light/logo-dark 192)")


if __name__ == "__main__":
    main()