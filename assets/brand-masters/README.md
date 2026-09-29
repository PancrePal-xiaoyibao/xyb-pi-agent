# 品牌母版（Brand masters）

**这是品牌资产的唯一来源。除有意更换品牌设计外，不要改动这里的文件。**

## 为什么放在这里

品牌资产（应用图标、侧栏 logo、首页动图、README logo）都写在**上游也拥有的路径**上：

```
apps/desktop/build/icon.{png,ico,icns}、tray-icon-mac.png、logo_dark.png
apps/desktop/src/assets/brand/logo-{light,dark}.png
apps/desktop/src/assets/home-mascot-{light,dark}.gif
apps/desktop/src/assets/home-mascot-still-{light,dark}.png
docs/image/readme/logo.png
```

跟随上游时，这些文件有两种失效方式：

1. **上游改了同一文件** → 二进制无法行级合并，需要人工处理；
2. **只有上游改了**（我们自合并基点后没动过）→ git **静默采用上游版本**，品牌被覆盖且不报错。

把母版集中在 `assets/brand-masters/`（**纯新增目录，永不与上游冲突**）之后，
任何被覆盖的品牌资产都能确定性重建。

## 内容

| 文件 | 规格 | 用途 |
|---|---|---|
| `logo.png` | 512×512 RGBA 透明底 | 图标族、`.icns`/`.ico`、侧栏 logo、README logo 的统一母版 |
| `home-mascot-light.gif` | 200×200，35 帧 | 首页动效（浅色主题） |
| `home-mascot-dark.gif` | 200×200，35 帧 | 首页动效（深色主题） |
| `home-mascot-still-{light,dark}.png` | 200×200 全彩 | `prefers-reduced-motion` 时的静态兜底 |

静态兜底**直接从 GIF 派生会掉色**：GIF 是 256 色调色板图，派生出的 PNG 会出现量化色带
（实测 200×200 有 28179 个像素与线上版本不同）。所以它作为母版单独保存，而不是运行时生成。

## 重建

```bash
python3 scripts/xyb-restore-brand.py            # 重建全部品牌资产（幂等）
python3 scripts/xyb-restore-brand.py --check    # 只体检，偏离则退出码 1（CI 用）
```

重建是**幂等**的：正常情况下跑完 `git status` 无变化。

## 更换品牌时

1. 替换这里的母版文件（`logo.png` 建议 512 或 1024 方形透明底）
2. 跑 `python3 scripts/xyb-restore-brand.py`
3. 确认 `docs/image/readme/logo.png` 的竖向内容占比仍是 84%（对齐历史版本，保证在
   README 固定 `width` 下显示大小不变）
4. 需要重做首页动效时用 `scripts/xyb-mascot-from-video.py`（视频转 GIF）或
   `scripts/xyb-mascot-build.py`（静态图程序化动画），产物仍按上述规格
