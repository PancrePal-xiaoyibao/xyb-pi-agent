#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小胰宝 · 首页 mascot 动态资源生成

做什么
    把 1~4 张角色姿态图，合成为首页所需的 4 个资源：
      home-mascot-light.gif  (200x200, 12 帧, 透明)
      home-mascot-dark.gif   (200x200, 12 帧, 透明 + 深色主题微提亮)
      home-mascot-still-light.png / -dark.png (200x200 静态兜底)
    时序与原资源同长（2220ms）：900ms 定格 + 108ms x10 跳舞 + 240ms 收尾。

关键处理（都是踩过坑的）
    1) alpha 溢色填充：透明区域的 RGB 往往是白色，直接缩放会把白色混进边缘，
       经 GIF 二值化后形成一圈难看的白毛边。做法是先用「最近的可见像素」颜色
       填满透明区再缩放，边缘混出来的就是角色自身的颜色。
    2) 抠图用「从画布边缘泛洪填充 + 连通域」，只清与边缘连通的背景块，
       保护角色内部白色区域（眼白、衣领）。输入若自带有效透明通道则直接沿用。
    3) 动效用网格形变而非整体旋转：以脚底为支点做倾斜(shear)，离脚底越远位移越大，
       再叠加落地挤压 / 拉伸。这样身体有「下盘不动、上身摆动」的感觉。
    4) 合成必须用 alpha_composite。paste(im, box, im) 会把 alpha 当遮罩再乘一次，
       半透明像素的 alpha 会被压到阈值以下而丢失（曾导致描边整圈消失且不报错）。

用法
    python3 scripts/xyb-mascot-build.py <姿态1.png> [姿态2.png ...]
    python3 scripts/xyb-mascot-build.py a.png b.png --no-install
"""
import argparse
import math
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO, "apps", "desktop", "src", "assets")
OUT_DIR = os.path.join(REPO, ".logo-src", "mascot", "out")

CANVAS = 200          # 与既有资源一致
CONTENT_RATIO = 0.80  # 角色高度占画布比例
BASELINE = 186        # 脚底基线（画布内）
# 跳舞帧：GIF 的帧时长以 10ms 为单位量化（108ms 会被截成 100ms），
# 所以取 120ms 这种整十值，保证 900 + 120*9 + 240 = 2220ms 与原资源精确同长。
DANCE_FRAMES = 9      # 比原资源的 6 帧更顺，节奏不变
STEP_MS = 120
FPS_MS = [900] + [STEP_MS] * DANCE_FRAMES + [240]

# 动作参数。
# 注意：LEAN_DEG 默认 0 —— 二维图做左右倾斜/位移会像「纸片在平移」，观感诡异，
# 所以只保留上下弹跳。需要用倾斜时加 --lean-deg 打开（多姿态素材可考虑）。
LEAN_DEG = 0.0
BOB_PX = 5.5          # 上下跳动幅度（越小越"微微跳"）
SQUASH = 0.025        # 落地压扁 / 起跳拉长幅度
STRETCH_X = 0.020


def strip_background(path, white_min=196, tol=30, feather=0.8):
    """取得角色的 RGBA 图层。

    - 输入**已带有效透明通道**（设计给的透明底 PNG）→ 直接沿用，不抠图。
    - 输入不透明（多数生成模型产出）→ 从画布边缘泛洪填充抠掉背景，
      只清与边缘连通的背景块，保护角色内部的白色区域。
    """
    im = Image.open(path).convert("RGBA")
    src_alpha = np.asarray(im.getchannel("A"))
    if (src_alpha < 10).mean() > 0.05:          # 已有 5% 以上透明像素，视为透明底素材
        print("  输入自带透明通道，跳抠图：%s" % os.path.basename(path))
        return im

    a = np.asarray(im.convert("RGB")).astype(np.int16)
    mn, mx = a.min(axis=2), a.max(axis=2)
    bgish = (mn >= white_min) & ((mx - mn) <= tol)
    lab, _ = ndimage.label(bgish)
    border = set(np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])))
    border.discard(0)
    bg = np.isin(lab, list(border)) if border else np.zeros_like(bgish)
    alpha = np.where(bg, 0.0, 255.0).astype(np.float32)
    alpha = np.clip(ndimage.gaussian_filter(alpha, feather), 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([a.astype(np.uint8), alpha]), "RGBA")


def bleed_colors(rgba):
    """把透明像素的 RGB 用最近的可见像素填充，避免缩放时把白色混进边缘。

    这是消除「白毛边」的关键：不处理的话，透明区(通常 RGB=白)会在 LANCZOS
    缩放时渗进角色边缘，GIF 二值化后就是一圈白边。
    """
    arr = np.asarray(rgba).astype(np.float32)
    solid = arr[:, :, 3] > 8
    if solid.all() or not solid.any():
        return rgba
    _, inds = ndimage.distance_transform_edt(~solid, return_indices=True)
    out = arr.copy()
    for c in range(3):
        out[:, :, c] = arr[:, :, c][inds[0], inds[1]]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def normalize(rgba, target_h):
    """溢色填充 → 裁到内容框 → 按统一高度缩放。"""
    rgba = bleed_colors(rgba)
    mask = rgba.getchannel("A").point(lambda v: 255 if v > 40 else 0)
    ch = rgba.crop(mask.getbbox())
    w, h = ch.size
    scale = target_h / h
    return ch.resize((max(1, round(w * scale)), target_h), Image.LANCZOS)


def blend(a, b, w):
    """按权重混合两个图层；尺寸不同时以较大者为画布、底边居中放置。"""
    if a.size != b.size:
        cw = max(a.size[0], b.size[0])
        ch = max(a.size[1], b.size[1])

        def fit(x):
            canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
            canvas.alpha_composite(x, ((cw - x.size[0]) // 2, ch - x.size[1]))
            return canvas

        a, b = fit(a), fit(b)
    if w <= 0.001:
        return a
    if w >= 0.999:
        return b
    return Image.blend(a, b, w)


def warp_layer(layer, sx, sy, lean_deg):
    """网格形变：以底边为基准等比缩放，再以脚底为支点做倾斜。

    - sy/sx 控制落地挤压与起跳拉伸（都以底边为基准，脚不会离地）
    - lean_deg 是整体倾斜角，位移随「离脚底的距离」增长，所以下盘稳、上身摆；
      再叠加一个二次项让上身的滞后更明显，观感更像有弹性而不是硬纸板旋转。
    """
    w, h = layer.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx = (w - 1) / 2.0
    bottom = float(h - 1)

    xs = cx + (xx - cx) * sx
    ys = bottom + (yy - bottom) * sy

    k = math.tan(math.radians(lean_deg))
    dy_from_feet = bottom - ys
    xs = xs + dy_from_feet * k
    xs = xs + dy_from_feet * k * 0.35 * (dy_from_feet / max(1.0, bottom))

    arr = np.asarray(layer).astype(np.float32)
    coords = np.stack([ys.ravel(), xs.ravel()])
    out = np.zeros_like(arr)
    for c in range(4):
        out[:, :, c] = ndimage.map_coordinates(
            arr[:, :, c], coords, order=1, mode="constant", cval=0.0
        ).reshape(h, w)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def brighten(layer, amount=0.10):
    """深色主题用：整体向白提亮少量，让彩色角色在深底上更透亮（不是加描边）。"""
    arr = np.asarray(layer).astype(np.float32)
    rgb = arr[:, :, :3]
    arr[:, :, :3] = rgb + (255.0 - rgb) * amount
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")


def render_frame(char_layer, sx, sy, lean, bob, halo=False):
    """形变 → 放到 200x200 画布（脚底对齐基线 + 弹跳位移）。"""
    warped = warp_layer(char_layer, sx, sy, lean)
    if halo:
        warped = brighten(warped)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    x = round((CANVAS - warped.size[0]) / 2)
    y = round(BASELINE + bob - warped.size[1])
    # 必须用 alpha_composite（见文件头注释 4）
    canvas.alpha_composite(warped, (x, y))
    return canvas


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


def build(pose_paths, install=True, lean_deg=LEAN_DEG):
    target_h = round(CANVAS * CONTENT_RATIO)
    layers = [normalize(strip_background(p), target_h) for p in pose_paths]
    A = layers[0]
    B = layers[1] if len(layers) > 1 else layers[0]
    print("姿态数: %d  归一化后尺寸: %s" % (len(layers), [l.size for l in layers]))
    print("动作: 上下弹跳 %.1fpx / 挤压 %.1f%% / 倾斜 %.1f°"
          % (BOB_PX, SQUASH * 100, lean_deg))

    # 帧计划: (混合权重, 横向缩放, 纵向缩放, 倾斜角, 弹跳位移)
    # f0 定格休息 -> 9 帧上下弹跳 -> 1 帧收尾
    plan = [(0.0, 1.0, 1.0, 0.0, 0)]
    for i in range(DANCE_FRAMES):
        t = i / float(DANCE_FRAMES)
        w = 0.5 - 0.5 * math.cos(2 * math.pi * t)                  # 有第二姿态时来回切换
        bounce = -BOB_PX * (1 - math.cos(4 * math.pi * t)) / 2.0   # 每循环两次弹跳
        c = math.cos(4 * math.pi * t + 1.0)                        # 与弹跳错开相位，避免机械感
        sy = 1 - SQUASH * c                                        # 落地压扁 / 起跳拉长（锚在脚底）
        sx = 1 + STRETCH_X * c
        plan.append((w, sx, sy, lean_deg, bounce))
    plan.append((0.12, 1.0, 1.0, 0.0, -1.5))                       # 收尾

    frames_light, frames_dark, stills = [], [], {}
    for idx, (w, sx, sy, lean, bob) in enumerate(plan):
        base = blend(A, B, w)
        fl = render_frame(base, sx, sy, lean, bob, halo=False)
        fd = render_frame(base, sx, sy, lean, bob, halo=True)
        frames_light.append(fl)
        frames_dark.append(fd)
        if idx == 0:
            stills["light"], stills["dark"] = fl, fd

    os.makedirs(OUT_DIR, exist_ok=True)

    def save_gif(frames, name):
        path = os.path.join(OUT_DIR, name)
        pframes = [to_gif_frame(f) for f in frames]
        pframes[0].save(
            path, save_all=True, append_images=pframes[1:],
            duration=FPS_MS, loop=0, disposal=2, transparency=255,
            optimize=False,
        )
        print("写出 %s (%.1f KB, %d 帧)" % (name, os.path.getsize(path) / 1024, len(pframes)))

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
        with open(os.path.join(OUT_DIR, f), "rb") as fh, \
                open(os.path.join(ASSETS, f), "wb") as out:
            out.write(fh.read())
    print("\n已安装到 %s" % os.path.relpath(ASSETS, REPO))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("poses", nargs="+", help="1~4 张角色姿态图")
    ap.add_argument("--no-install", action="store_true", help="只输出，不覆盖工程资源")
    ap.add_argument("--lean-deg", type=float, default=LEAN_DEG,
                    help="左右倾斜角度，默认 0（不左右晃；正值会像纸片平移，谨慎）")
    args = ap.parse_args()
    if len(args.poses) > 4:
        sys.exit("最多接受 4 张姿态图")
    build(args.poses, install=not args.no_install, lean_deg=args.lean_deg)


if __name__ == "__main__":
    main()
