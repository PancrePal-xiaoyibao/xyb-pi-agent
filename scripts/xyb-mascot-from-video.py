#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小胰宝 · 从视频生成首页 mascot 动画资源

做什么
    把一段角色视频（.mov/.mp4 等）转成首页所需的 4 个资源：
      home-mascot-light.gif / -dark.gif        (200x200, 透明)
      home-mascot-still-light.png / -dark.png  (200x200 静态兜底)

和 xyb-mascot-build.py 的区别
    build 脚本处理的是**静态图**，动效是程序化生成的；
    本脚本处理的是**已有动画的视频**，动效来自视频本身，只做抠像 + 缩放 + 转 GIF。

抠像思路（针对渐变背景）
    视频背景往往是渐变（本机这条 .mov 是色相恒定 210° 的蓝色渐变），
    纯色泛洪填充不可用。改为：**按色相带筛出背景候选 → 连通域 → 只保留与画布四边
    连通的那些**。这样既不受亮度渐变影响，又不会把角色内部同色相的像素误挖掉
    （角色内部若也有蓝色，它与边框不连通）。

取景策略（重要）
    角色在视频里会移动，若逐帧裁到内容框会导致画面抖动。所以取**全帧并集 bbox**
    算固定取景框，让角色在画布内自然移动。

用法
    python3 scripts/xyb-mascot-from-video.py <视频文件>
    python3 scripts/xyb-mascot-from-video.py a.mov --every 2 --hue 210 --band 20 --no-install
"""
import argparse
import glob
import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO, "apps", "desktop", "src", "assets")
OUT_DIR = os.path.join(REPO, ".logo-src", "mascot", "out")

CANVAS = 200
CONTENT_RATIO = 0.80   # 角色并集高度占画布比例
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"


def probe_duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def extract_frames(path, outdir):
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir)
    subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vsync", "0",
                    os.path.join(outdir, "f_%04d.png")], check=True)
    return sorted(glob.glob(os.path.join(outdir, "*.png")))


def foreground_alpha(frame, hue_deg, band_deg, min_sat=60, feather=1.5):
    """按色相带 + 边缘连通域求前景 alpha（0-255）。

    背景 = 色相落在 [hue-band/2, hue+band/2] **且饱和度足够** 且与画布四边连通的区域。

    为什么要卡饱和度：接近灰白的像素色相极不稳定（中位饱和度可能只有 10/255），
    会随机落进任意色相带。若不卡，角色身上的浅灰白区域会被误判成背景候选；
    实测某条视频里最大的「假背景」连通域就是角色自身的浅灰区（均色 202,210,217，
    而真实背景是 119,153,200，色差 158）。
    """
    hsv = np.asarray(frame.convert("HSV")).astype(np.int16)
    H, S = hsv[:, :, 0], hsv[:, :, 1]
    center = int(hue_deg / 360.0 * 255)
    band = max(1, int(band_deg / 2.0 / 360.0 * 255))
    bgish = (np.abs(H - center) <= band) & (S >= min_sat)
    lab, _ = ndimage.label(bgish)
    border = set(np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])))
    border.discard(0)
    bg = np.isin(lab, list(border)) if border else np.zeros_like(bgish)
    alpha = np.where(bg, 0.0, 255.0).astype(np.float32)
    if feather > 0:
        alpha = ndimage.gaussian_filter(alpha, feather)
    return np.clip(alpha, 0, 255).astype(np.uint8)


def build(video, every=2, hue=210.0, band=40.0, install=True, dark_brighten=0.0):
    dur = probe_duration(video)
    tmp = tempfile.mkdtemp(prefix="xyb-video-")
    try:
        files = extract_frames(video, os.path.join(tmp, "frames"))
        stride = max(1, int(every))
        picked = files[::stride]
        print("视频时长 %.2fs  总帧 %d  取每 %d 帧 -> 输出 %d 帧"
              % (dur, len(files), stride, len(picked)))

        # 1) 逐帧求 alpha，并累积并集 bbox
        fgs = []
        ux0 = uy0 = 10**9
        ux1 = uy1 = -1
        for p in picked:
            im = Image.open(p).convert("RGB")
            a = foreground_alpha(im, hue, band)
            ys, xs = np.nonzero(a >= 128)
            if len(xs):
                ux0, uy0 = min(ux0, xs.min()), min(uy0, ys.min())
                ux1, uy1 = max(ux1, xs.max()), max(uy1, ys.max())
            fgs.append((im, a))

        src_w, src_h = fgs[0][0].size
        bcx, bcy = (ux0 + ux1) / 2.0, (uy0 + uy1) / 2.0
        side = max(ux1 - ux0, uy1 - uy0) / CONTENT_RATIO
        scale = CANVAS / side
        print("并集 bbox=(%d,%d)-(%d,%d)  取景框 %.0fpx  缩放 %.3f"
              % (ux0, uy0, ux1, uy1, side, scale))

        # 取景：把「取景框」外的部分用透明补出来，再精确裁剪 + LANCZOS 缩放。
        # 不用 Image.transform：它的 AFFINE 不支持 LANCZOS，缩小 5 倍会有锯齿。
        x0 = bcx - side / 2.0
        y0 = bcy - side / 2.0
        pad_l = max(0, int(math.ceil(-x0)))
        pad_t = max(0, int(math.ceil(-y0)))
        pad_r = max(0, int(math.ceil((x0 + side) - src_w)))
        pad_b = max(0, int(math.ceil((y0 + side) - src_h)))
        padded_size = (src_w + pad_l + pad_r, src_h + pad_t + pad_b)
        box = (int(round(x0)) + pad_l, int(round(y0)) + pad_t,
               int(round(x0 + side)) + pad_l, int(round(y0 + side)) + pad_t)

        frames_light, frames_dark, stills = [], [], {}
        for idx, (im, a) in enumerate(fgs):
            rgba = Image.fromarray(np.dstack([np.asarray(im), a]), "RGBA")
            # 溢色填充：透明区是视频背景色，不处理会在缩放时把背景色混进角色边缘
            rgba = bleed_colors(rgba)
            canvas = Image.new("RGBA", padded_size, (0, 0, 0, 0))
            canvas.paste(rgba, (pad_l, pad_t))
            small = canvas.crop(box).resize((CANVAS, CANVAS), Image.LANCZOS)
            frames_light.append(small)
            fd = brighten(small, dark_brighten) if dark_brighten > 0 else small
            frames_dark.append(fd)
            if idx == 0:
                stills["light"], stills["dark"] = small, fd

        # 帧时长：贴近原速，且取 10ms 整数倍（GIF 规范限制）
        per = max(20, int(round((dur * 1000.0 / len(picked)) / 10.0)) * 10)
        print("单帧时长 %dms  循环总长 %dms" % (per, per * len(picked)))

        os.makedirs(OUT_DIR, exist_ok=True)

        def save_gif(frames, name):
            path = os.path.join(OUT_DIR, name)
            pf = [to_gif_frame(f) for f in frames]
            pf[0].save(path, save_all=True, append_images=pf[1:],
                       duration=per, loop=0, disposal=2, transparency=255,
                       optimize=False)
            print("写出 %s (%.1f KB, %d 帧)" % (name, os.path.getsize(path) / 1024, len(pf)))

        save_gif(frames_light, "home-mascot-light.gif")
        save_gif(frames_dark, "home-mascot-dark.gif")
        for theme in ("light", "dark"):
            p = os.path.join(OUT_DIR, "home-mascot-still-%s.png" % theme)
            stills[theme].save(p)
            print("写出 %s" % os.path.basename(p))

        if not install:
            print("\n--no-install：仅输出到 .logo-src/mascot/out")
            return
        for f in ("home-mascot-light.gif", "home-mascot-dark.gif",
                  "home-mascot-still-light.png", "home-mascot-still-dark.png"):
            shutil.copyfile(os.path.join(OUT_DIR, f), os.path.join(ASSETS, f))
        print("\n已安装到 %s" % os.path.relpath(ASSETS, REPO))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---- 与 xyb-mascot-build.py 共用的两个处理 ----

def bleed_colors(rgba):
    """把透明像素的 RGB 用最近可见像素填充，避免缩放时背景色混进角色边缘。"""
    arr = np.asarray(rgba).astype(np.float32)
    solid = arr[:, :, 3] > 8
    if solid.all() or not solid.any():
        return rgba
    _, inds = ndimage.distance_transform_edt(~solid, return_indices=True)
    out = arr.copy()
    for c in range(3):
        out[:, :, c] = arr[:, :, c][inds[0], inds[1]]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def brighten(layer, amount):
    if amount <= 0:
        return layer
    arr = np.asarray(layer).astype(np.float32)
    rgb = arr[:, :, :3]
    arr[:, :, :3] = rgb + (255.0 - rgb) * amount
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")


def to_gif_frame(rgba):
    """转成带透明索引的 P 模式帧（GIF 只支持二值透明）。"""
    a = np.asarray(rgba.getchannel("A"))
    keep = a >= 128
    p = rgba.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=255)
    palette = p.getpalette()[: 255 * 3] + [0, 0, 0]
    arr = np.asarray(p).copy()
    arr[~keep] = 255
    out = Image.fromarray(arr, "P")
    out.putpalette(palette)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="输入视频路径")
    ap.add_argument("--every", type=int, default=2, help="抽帧步长，默认每 2 帧取 1")
    ap.add_argument("--hue", type=float, default=210.0, help="背景色相（度），默认 210")
    ap.add_argument("--band", type=float, default=40.0,
                    help="色相容差总带宽（度），默认 40 即 ±20°")
    ap.add_argument("--dark-brighten", type=float, default=0.0,
                    help="深色主题版提亮比例，默认 0（保持原色）")
    ap.add_argument("--no-install", action="store_true")
    args = ap.parse_args()
    if not os.path.exists(args.video):
        sys.exit("找不到视频：%s" % args.video)
    build(args.video, every=args.every, hue=args.hue, band=args.band,
          install=not args.no_install, dark_brighten=args.dark_brighten)


if __name__ == "__main__":
    main()
