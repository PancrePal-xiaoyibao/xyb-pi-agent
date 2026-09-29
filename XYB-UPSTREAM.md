# 与上游保持一致性：策略与操作手册

> 本仓库（`PancrePal-xiaoyibao/xyb-pi-agent`）是上游 `vastsa/PI-Desktop` 的 fork。
> 定制只落在三层：**插件/技能、子智能体、品牌与 UI**。核心框架要长期跟随上游。
>
> 这份文档回答两件事：**怎么跟**、**`build.publish` 这类构建配置该怎么定**。

---

## 一、结论先说

| 问题 | 决定 |
|---|---|
| 分支模型 | 单一 `main` = 上游 + 我们的提交，**merge 上游，不 rebase** |
| `upstream` 远端 | 保留为只读拉取源；`origin` 是我们的仓库（已从上游 rename 而来，避免误推） |
| 定制位置 | 全部落在**纯新增路径**或**可机械重建**的派生文件上，核心代码尽量零改动 |
| 合并频率 | 每周一 CI 自动巡检上游并开 issue；有安全/关键修复时手动提前 |
| `build.publish` | **指向本仓库**（不能指上游，见第七节）；自动更新要等签名 + 仓库公开才真正可用 |
| 许可 | LGPL-3.0：对外分发二进制时必须能拿到对应源码（就是本仓库），不能转闭源 |

---

## 二、现状实测（2026-09-30）

```
上游节奏        一天 18 → 36 个提交（极活跃，且持续在动）
合并基点        b360e04eb  2026-09-29
我们领先        12 个提交
上游领先        36 个提交
合并预判        ✓ 可干净合并，零冲突
```

fork 的偏离结构：

| 类别 | 数量 | 合并成本 |
|---|---|---|
| **纯新增**（插件 / 技能 / 子智能体 / 文档 / 脚本） | **60 个文件** | **永不冲突** |
| 修改上游既有文件 | 38 个文件 | 需要过一遍，多数能自动合并 |

**这就是当前架构最大的优点**：`apps/desktop/resources/plugins/**` 是插件机制的原生扩展点，我们 8 个助手、4 个患者插件全部落在那里，等于**几乎不用碰核心**。往后的新功能应继续遵守这条：**能做成插件/技能，就不要改 core。**

---

## 三、三类改动的处理规则

### 第 1 类：纯新增 —— 随便改，永不冲突

```
apps/desktop/resources/plugins/xyb.*     4 个患者插件（含技能与视图）
subagents/mdt-*.md                       9 个 MDT 视角
assets/brand-masters/                    品牌母版（见下）
XYB-*.md                                 设计文档
scripts/xyb-*.{sh,mjs,py}                本 fork 的工具
.github/workflows/xyb-fork-guards.yml    本 fork 的 CI
```

新功能优先往这里放。**这一层越厚，跟上游越轻松。**

### 第 2 类：派生文件 —— 不手工维护，用脚本重建

上游改同一文件时，派生文件既可能冲突，也可能被上游**静默覆盖**。所以一律用脚本重建：

| 派生资产 | 母版 | 重建命令 |
|---|---|---|
| 应用图标 / `.icns` / `.ico` / 侧栏 logo（9 个文件） | `assets/brand-masters/logo.png` | `python3 scripts/xyb-restore-brand.py` |
| 首页动图 + 静帧（4 个文件） | `assets/brand-masters/home-mascot-*.{gif,png}` | 同上 |
| `docs/image/readme/logo.png` | 同上（按竖向占比 84% 派生） | 同上 |
| i18n 帮助菜单的品牌词（9 个语言） | 替换规则（`PI-Desktop` → `xyb-pi`） | `python3 scripts/xyb-apply-brand-strings.py --fix-apphelp` |

两个脚本都**幂等**，重建后 `git status` 无变化（已实测），可以放心在每次同步后重跑。

> **为什么要有 `brand-masters/`**：品牌母版原先只存在于 `.logo-src/`（已 gitignore），
> 首页动图的上游来源视频还在 `~/Downloads`。也就是说——**只要上游覆盖了动图，母版就永久丢失**，
> 除非那个视频还在。现在母版进了版本库（约 750 KB），这是唯一可靠的兜底。

### 第 3 类：手工合并 —— 如下清单，共 38 个文件，实际只需重点看这几处

| 文件 | 我们改了什么 | 上游改动频率 | 处理方式 |
|---|---|---|---|
| `packages/i18n/src/locales/*/index.ts`（9 个） | 帮助菜单品牌词（每文件 1 行） | **极高**（近 200 个提交全部涉及） | 冲突时 `--fix-apphelp` 重放 |
| `packages/shared/src/protocol.ts` | 拆出 `APP_NAME` / `APP_DISPLAY_NAME` | 低 | 手工看 |
| `apps/desktop/electron/main/ipc/app-ipc.ts` | 设置页信息栏取显示名 | 中 | 手工看 |
| `apps/desktop/electron/main/bootstrap/startup.ts` | 关于面板取显示名 | 低 | 手工看 |
| `apps/desktop/src/features/settings/SettingsPage.tsx` | 兜底文案 | 中 | 手工看 |
| `apps/desktop/package.json` | 品牌 / `productName` / `publish` / 签名配置 | **高** | 手工看，注意别把 `name` 改成 `@xiaoyibao/*`（见第六节） |
| `scripts/release-macos.sh` 等 4 个签名脚本 | 解除写死的上游 Apple Team ID | 低 | 手工看 |
| `.github/workflows/release.yml` | `CSC_NAME` 改为仓库变量 | 中 | 手工看 |
| 品牌资产（13 个二进制） | 整套替换 | 低 | 用第 2 类脚本重建 |
| `README.md` / `README.zh-CN.md` / `docs/**` 两处 runbook | 品牌与产物名说明 | 中 | 一般能自动合并 |

---

## 四、冲突预判：只有 i18n 是热点

`packages/i18n/**` 是上游**改动最频繁**的文件族，也是双方都改过的唯一地方。
其余 32 个文件上游近期都没碰。

这不是靠猜：脚本每次都会用 `git merge-tree` 在**不落工作区**的前提下给出预判（见第九节）。

品牌文案的冲突不需要人工解：合并后跑一次 `--fix-apphelp` 即可。**不要**逐个人工改 9 个语言文件。

---

## 五、为什么必须有门禁（三个真实事故）

| 事故 | 现象 | 现在的防线 |
|---|---|---|
| 品牌化时把 `apps/desktop/package.json` 的 `name` 改成 `@xiaoyibao/desktop` | 其余 10 个包与全部 CI 仍引用 `@pi-desktop/desktop` → **12 处 `pnpm --filter` 失效**，本地打包与 tag 发布全断 | 见第六节 |
| 品牌化只覆盖了 6 个语言的帮助菜单 | 上游 2026-09-08 新增的 `de`/`es`/`fr` **从未被品牌化**，静默漏了 3 个语言 | `xyb-apply-brand-strings.py --check`（CI 门禁） |
| 品牌资产没有入库母版 | 上游一旦覆盖图标/动图，无母版可重建 | `assets/brand-masters/` + `xyb-restore-brand.py --check`（CI 门禁） |

共同点：**都不会报错**。所以 CI 里加了 `xyb-fork-guards.yml`，每次改动都检一遍。

---

## 六、不要动内部包名

`@pi-desktop/*` 是与上游共享的内部命名空间：11 个 workspace 包、根 scripts、
4 个 workflow（共 12 处 `pnpm --filter @pi-desktop/desktop`）都用它。

**用户可见的品牌不来自包名**，来自：

```
build.appId      org.xiaoyibao.desktop
build.productName 小胰宝
APP_NAME         xyb-pi        （系统菜单 / 窗口标题 / 托盘 / 崩溃上报）
APP_DISPLAY_NAME 小胰宝Pi智能助手 （设置→信息 / 关于面板）
图标与动图        assets/brand-masters/
```

改包名只会割裂命名空间并让打包/发布全断，没有任何收益。要改就 11 个包 + 12 处引用一起改，
且必须先确认 lockfile（按**路径**索引 importers，不受包名影响）。

---

## 七、发布与更新通道（`build.publish`）

### 已改为本仓库

```jsonc
// apps/desktop/package.json
"publish": [{ "provider": "github", "owner": "PancrePal-xiaoyibao", "repo": "xyb-pi-agent" }]
```

**为什么必须改**：这个配置会写进安装包内的 `app-update.yml`。原来指向上游时，
打包版的自动更新会去查 `vastsa/PI-Desktop` 的 Release，把**上游的 `PI-Desktop-*.dmg` 下载下来覆盖小胰宝**
——品牌与功能的双重回退。而且上游的 `latest-mac.yml` 里根本没有 `xiaoyibao-*` 文件，本来就对不上。

### 顺带修掉的三处「把患者送错地方」

| 位置 | 原状 | 风险 |
|---|---|---|
| `updater.ts` 的 `RELEASES_URL` | 指向上游 releases | 手动更新模式下点「有新版本」→ **跳到另一个产品的下载页** |
| `packages/shared/src/github-feedback.ts` | `GITHUB_REPO = "vastsa/PI-Desktop"` | 患者点「反馈问题」→ **issue 提到上游公开仓库**。反馈里常夹带病情、用药、就诊信息，属隐私问题 |
| 三处硬编码英文串（快捷键冲突、数据库 schema 过新、MCP 授权成功页） | 显示 `PI-Desktop` | 出错时告知患者「请安装更新的 PI-Desktop」——另一个产品的名字 |

第二处做法值得记一下：`GITHUB_REPO` 一个常量同时承担「反馈去哪提」和「远程 host 产物从哪下载」。
直接把常量改掉会让**远程 host 下载功能失联**（我们的 Release 里还没有那些产物）。
所以拆成两个：`GITHUB_FEEDBACK_REPO`（= 本仓库，反馈用）与 `GITHUB_REPO`（暂留上游，产物用），
并在注释里写明首次发布自己的版本后应合并为一个。

### ⚠️ 自动更新现在还跑不通，两个前置条件

1. **仓库是私有的**。electron-updater 的 GitHub provider 匿名访问私有仓库会 404，
   而往客户端里塞 token 不可接受。要让自动更新可用，需要**发布源可匿名访问**：
   把仓库改公开，或另建一个只放 Release 的公开仓库。
2. **macOS 需要签名**：Squirrel.Mac 要求新旧版本签名一致，未签名/adhoc 构建的自动更新会失败
   （Windows NSIS 不受此限，但未签名安装包会触发 SmartScreen 提示）。

**顺带一个合规点**：LGPL-3.0 要求分发二进制时能拿到对应源码。
现在只在本地构建、还没对外分发，所以尚未触发义务；**一旦开始把 DMG 发给病友，源码就必须可获取**——
把仓库改公开同时解决这一条和上面第 1 条。

**不建议用删除 `publish` 来「关掉」自动更新**：`supportsAutomaticUpdates()` 是按平台判定的，
不看 `app-update.yml` 是否存在；删掉配置只会让运行时的更新检查直接抛错。

### 版本号策略

沿用上游的版本号递增（上游 bump 时我们跟着），**不要加 `-xyb` 之类后缀**：
`updater.ts` 里 `allowPrerelease = false`，带预发布后缀的版本会被自动更新过滤掉。

---

## 八、值得推回上游的改动（让永久 diff 真正缩小）

下面几处不是「小胰宝特有」，而是**上游本身的通用缺陷**。合并回上游后，我们对应的提交可以删除，
永久偏离归零：

| 改动 | 为什么上游也该要 |
|---|---|
| 签名脚本把 Apple Team ID 与证书名写死，且**硬拒绝**其他 Team ID | 开源项目的签名配置不该绑定某一个团队；任何 fork 都会撞上 |
| `verify-macos-release.sh` 把 `PRODUCT_NAME` 写死为 `PI-Desktop` | 产品名应从 `package.json` 的 `build.productName` 读取，否则 fork 的发布门禁必然失败 |
| `packages/shared/src/protocol.ts` 拆分 `APP_NAME` / `APP_DISPLAY_NAME` | 「系统标识名」与「用户可见产品名」本就不是一回事，白标/本地化场景都需要 |
| `host-boot-diagnostics` 等硬编码英文串未走 i18n | 上游已有 9 个语言，这些串却无法本地化 |

推上游的前提：**改动本身对上游独立成立**（不夹带小胰宝的品牌与产品决策）。
建议逐个开 PR，不要打包成一个大 PR。

---

## 九、操作手册

```bash
# 1) 体检：拉上游 + 偏离报告 + 冲突预演（不改工作区）
bash scripts/xyb-sync-upstream.sh

# 2) 合并（要求工作区干净；自动跑品牌体检与插件校验）
bash scripts/xyb-sync-upstream.sh --merge

# 3) 合并后必须验证（上游可能改了核心接口，插件是贴着接口写的）
pnpm build:js
cargo build -p host-core        # 上游改了 crates/ 时
bash scripts/xyb-dev.sh         # 启动，确认插件与右侧面板视图仍在

# 4) 出错时
git merge --abort               # 放弃本次合并
python3 scripts/xyb-apply-brand-strings.py --fix-apphelp   # i18n 品牌词冲突
python3 scripts/xyb-restore-brand.py                       # 品牌资产被覆盖

# 5) 推送
git push origin main
```

**重点回归**：上游改动落在 `apps/desktop/electron/**` 或 `packages/plugin-sdk/**` 时，
必须确认插件加载、右侧面板视图、助手工具调用三项仍正常。

CI 会每周巡检上游并开 issue（`.github/workflows/xyb-fork-guards.yml`），不用记着手动同步。

---

## 十、有意保留的上游字符串（不是遗漏）

以下 `PI-Desktop` 字样**故意不改**，改动它们只会扩大偏离、且患者看不到：

| 位置 | 原因 |
|---|---|
| 代码注释、JSDoc、内部类型名 | 患者不可见 |
| i18n 里除帮助菜单外的 171 处品牌词 | 见下（待决） |
| `mcp-oauth.ts` / `plugin-mcp.ts` 的 `clientInfo.name` | 传给第三方 MCP 服务的协议身份，非展示文案 |
| 测试固件里的上游 URL（`apps/desktop/test/**`） | 断言的是 URL 解析行为，与品牌无关 |

### 待决

1. **i18n 里 171 处品牌词要不要全替**？现在患者仍会在输入框占位符
   （「让 PI-Desktop 帮你做任何事」）、退出对话框、启动提示里看到上游品牌。
   - `--fix-all` 一次改完，品牌一致；代价是每次同步都要重放一次（脚本已就绪，幂等）
   - 保持现状：偏离最小，但患者界面存在明显的前后不一致
   - 折中：只改**首屏与高频路径**（占位符、退出/关窗对话框、启动提示）
2. **仓库是否改公开**？一举解决自动更新可用性与 LGPL 源码可获取。改公开前需再扫一次
   历史提交里的凭据（当前 `.env*` 与 `.workbuddy/` 已忽略，`scripts/` 内无密钥）。
3. **远程 host 产物源**：现在仍取上游 Release。首次用 CI 发布自己的版本后，
   应把 `GITHUB_REPO` 与 `GITHUB_FEEDBACK_REPO` 合并。
