# XYB-EXTENSIONS.md — 扩展开发规范（插件 / 技能 / MCP）

> 面向：想给小胰宝加能力的开发者，以及**替开发者干活的 AI agent**。
>
> 怎么用这份文件：把它和你要改的目录一起交给 agent。它应当先按 §2 选定通道，
> 按 §3 交出最小交付物，再跑 §4 的权限红线与 §6 的门禁，最后把门禁输出贴回来。
>
> 规范正文在上游文档（`docs/plugin-development.md`、`docs/spec/07-plugins/**`）。
> 本文件只写**本 fork 的取舍、红线与门禁**；与上游规范冲突时以上游规范为准。

---

## 1. 两条硬约束

| 约束 | 含义 |
|---|---|
| **开箱即用** | 患者装完 DMG/EXE 就应该能用上能力。做不到"零前置"的，也必须做到"首次一键就绪"（有进度、有体积告知、失败可诊断），而不是让患者自己去研究怎么装。 |
| **不显著撑大安装包** | **KB 级进包，MB 级以上一律不进包。** 当前 Linux 三包 104–164MB；新增随包内容的建议阈值是相对上一版 ±3%。 |

由此定义两个级别，全篇都用它判断：

- **L1（随包）**：装上就有，零网络零前置。纯提示技能、纯 HTTP 直连实现、零/轻依赖的内置抓取器。
- **L2（首次一键就绪）**：不进包。浏览器运行时、索引数据、外部 CLI、模型快照。宿主负责下载、校验、进度、可卸载。

---

## 2. 先选通道（判定树，从上往下问）

| # | 问题 | 通道 |
|---|---|---|
| 1 | 只是"告诉助手怎么做"的提示 / 方法论，不需要执行代码？ | **技能**（L1，随包） |
| 2 | 需要代码，且要 UI / 工具 / 设置 / 工作区文件 / 网络？ | **插件** |
| 3 | 需要以"独立进程"形态提供一组工具（本地脚本、第三方 CLI、非 JS 服务）？ | **插件 + `contributes.mcpServers`** |
| 4 | 只给愿意自己装的用户用，不进安装包？ | **插件市场**（目录条目，不影响开箱基线） |
| 5 | 重量在数据或第三方运行时（索引 / 浏览器 / CLI）？ | 走 **L2 受管组件**（§5），不要塞进 `resources/**` |

**关键事实**：插件权限表里**不存在**「执行外部进程」这一项。想让助手跑本地工具，唯一正规通道就是在插件的 `manifest.json` 里声明 `contributes.mcpServers`（见 `docs/spec/07-plugins/13-plugin-permissions-matrix.md`）。

---

## 3. 三条通道的最小交付物

### 3.1 技能（skill）

- 位置二选一：
  - 随包：`apps/desktop/resources/skills/*.md`（L1，任何插件都不需要）
  - 插件内：`skills/*.md`，由 `manifest.contributes.skills` 登记，**需要 `agent.prompt.inject`（high，默认拒绝）**
- 最小内容：Markdown + front-matter（`name` / `description`）；正文写清「什么时候用、怎么做、边界与免责」。
- 技能**要跑脚本**时的额外要求：
  1. 依赖越少越好：优先只用标准库；要第三方库就写进 §5 的声明，别假设患者机器上有。
  2. 声明前置：Python 版本、依赖、需要的网络域名、是否需要用户会话。
  3. **长跑脚本必须自带总预算与明确报错**。宿主（例如 Bash 工具）默认 60s 就杀进程，只留一句 `bash timed out`；脚本自己封顶并说清原因。外部技能仓库 `opencare-skillhub/clinicaltrials-query-analysis` 的 `scripts/search.py` 就是这么做的（`_TOTAL_BUDGET` + `--timeout`），可以照着改。
  4. 面向患者的输出不得给出诊疗结论；写"登记信息整理，是否适合由研究医生判断"。
- 红线：技能是提示层，**不得**夹带"忽略系统提示 / 提升权限 / 绕过确认"之类指令。

### 3.2 插件（plugin）

- 位置：`apps/desktop/resources/plugins/<family>.<name>/`（内置 L1）；市场安装的走用户级目录。
- 必需文件：
  - `manifest.json`：`schemaVersion: 1`；`id` 匹配 `^[a-z0-9]+(\.[a-z0-9_-]+)+$`；`name` / `description` 至少给 `en` + `zh-CN`（对象形态两个语言都必填）。
  - `main.js`：CommonJS，导出 `activate` / `deactivate`。
  - 可选：`renderer/`、`views/`、`skills/`、`assets/`。
- 能力声明：`contributes.{views, commands, skills, agentTools, mcpServers, settings, providers, services, themes, windowAppearance}`。**每一项都要在 `permissions` 里有对应权限**，否则加载即失败或功能静默不可用。
- 生命周期：按 `activationEvents`（`onStartup` / `onCommand:*`）激活；`deactivate` 必须清理监听、定时器、子进程、socket——宿主会在 reload / 关闭 / 禁用 / 崩溃时调用它。
- 参考实现（本 fork 的真代码，优先照抄它们的形状）：
  - `xyb.trials`：`net.fetch + agent.tool.register`，直连公开 API 并把能力注册成**助手工具**；默认可用、零配置。
  - `xyb.news`：只申请 `ui.view + net.fetch`，做成**面板 + 命令**（不注册工具）——想要"看得见"而不是"助手能调"时照它写。
  - `xyb.records`：`fs.read + fs.write`，配 `views / settings / skills / commands`（工具并非必需；本地资料库靠命令与技能驱动）。
  - `xyb.trial-sources`：`mcp.server.local` + 自带 MCP 服务（见 §3.3），**默认关闭**、按需授权。
- 最小示例：`examples/plugins/hello`；组件示例 `roundtable`、`ui-slots-lab`。

### 3.3 MCP 服务

- 声明位置：插件 `manifest.json` → `contributes.mcpServers`：

```jsonc
{
  "id": "chinadrugtrials",
  "label": "中国药物临床试验登记与信息公示平台",
  "transport": "stdio",                       // stdio | http
  "command": "node",                           // 启动器，由宿主解析到真实 node
  "args": ["mcp/chinadrugtrials-mcp.mjs"],     // 相对插件目录（cwd 即插件目录）
  "env": {}
}
```

- 自带的脚本服务一律写成「`node` + 相对脚本路径」，**不要**把 `./mcp/xxx.mjs` 直接写成 command：
  直接执行靠 shebang + 执行位，Windows 不能直接执行 `.mjs`（`spawn EFTYPE`），装包后工具一个都没有。

- 权限：`mcp.server.local`（stdio，拉起本机进程）与 `mcp.server.remote`（http）**都是 high、默认拒绝**，必须由用户逐条显式授权。
- 三种落地形态，按"重量在哪"选：

| 形态 | 适用 | 做法 | 本 fork 实例 |
|---|---|---|---|
| **A 自带服务**（首选，开箱即用） | 逻辑在代码里、依赖轻 | 服务随插件分发，**优先零 npm 依赖（只用 Node 内置模块）**；需要第三方库的那层单独声明 | `xyb.trial-sources/mcp/chinadrugtrials-mcp.mjs`（920 行，零依赖，包 Python 采集器） |
| **B vendor 第三方包** | 上游包许可允许（MIT / Apache-2.0） | 把包随插件分发，去掉"首次 npx 拉包" | ChiCTR（Apache-2.0） |
| **C 受管组件（L2）** | 运行时/数据很重 | 首次使用下载 + 校验 + 进度 + 可卸载；**数据与重运行时绝不进包** | Playwright Chromium（约 570MB）、Veeva 本地索引 |

- **直查优先于索引**：上游有可用的查询接口就直接查（零前置、真开箱即用）；只有上游确实没有检索能力时才建本地索引，且优先"按关键词从候选池筛出子集 → 只抓这些"，而不是全量抓取。
  - 已验证的例子（Veeva CTV）：`POST https://ctv.veeva.com/graphql` 的 `studyProfile(nct|utn|slug)` **匿名可用**（37 字段，约 1s）→ 详情可直查；但 GraphQL **没有列表/检索字段**，而 `/study-search` 被 robots 禁止 → 检索只能靠本地索引，候选池用官方 sitemap（robots 明确声明允许）。
- **凭证红线**（这条不接受例外）：
  1. 只写 `<应用数据目录>/config.json`，权限 `0600`；
  2. **绝不**经命令行参数传递（进程列表可读），走 `--config` 文件；
  3. 不进日志、不进工具返回值、不进仓库。

---

## 4. 权限与安全红线

权限分三级（完整表见 `docs/spec/07-plugins/13-plugin-permissions-matrix.md`）：

- **low**：安装即授予。`ui.panel` / `ui.view` / `ui.theme` / `notify` 等。
- **medium**：首次使用确认。`fs.read` / `clipboard.*` / `shell.openExternal` / `background.service` / `bus.*` / `ui.microphone` 等。
- **high**：**默认拒绝**，逐条显式授权。清单要背下来：
  `fs.write`、`fs.delete`、`agent.tool.register`、`agent.prompt.inject`、`agent.extension`、`provider.register`、`net.fetch`、`net.websocket`、`net.anyHost`、`mcp.server.local`、`mcp.server.remote`、`browser.cdp`、`desktop.control`、`audio.capture.background`。

必须遵守：

1. **最小权限面**。不要为了顺手把 high 权限全申请上——权限面直接等于患者的信任成本。
2. **核心功能不被高风险拖累**。`xyb.trials`（ClinicalTrials.gov 直连）是零配置核心来源；需要拉起本地进程的能力一律单开插件、**默认关闭**（`xyb.trial-sources` 就是这么做的）。
3. **网络 fail-closed**：`net.fetch` 受 `manifest.net.domains` 白名单限制；**空列表或格式非法 = 完全不出网**（不是"默认全通"）。
4. **文件范围必填**：`fs.write` / `fs.delete` 必须声明 scope，整树通配会被校验拒；删除走系统回收站、非递归、限速。
5. 不得绕过任何权限检查、域名白名单、URL 校验、origin 校验、插件授权；不得把 host 能力悄悄放大。

---

## 5. 体积与"首次一键就绪"（L2 的声明制）

需要 L2 的插件**必须声明**它要准备什么，UI 才能诚实告知患者：

```jsonc
// 目标形态（宿主通道待建）：声明式，不自己下载
"requires": [
  { "kind": "playwright-chromium", "bytes": 597688320, "source": "playwright", "license": "Apache-2.0" },
  { "kind": "sqlite-index",        "bytes": 3000000,   "source": "sitemap",    "license": "n/a" },
  { "kind": "python-deps",         "bytes": 2000000,   "source": "pypi",       "license": "PSF-2.0" }
]
```

宿主负责：下载 → `sha256` + `sizeBytes` 校验 → 装进应用私有缓存目录 → 进度（复用 `plugin.installProgress` 通道）→ **体积与来源告知并征得同意** → 可卸载 → 失败可诊断。

规则：

- **禁止把 MB 级内容放进 `resources/**`**。任何这样的 PR 必须回答"为什么不能走 L2"并给出体积差。
- 本地数据（索引/缓存）必须**带 schema 版本**，并在版本不匹配时自动重建（本 fork 踩过一次：`ctv.db` 18 列 → 40 列漂移，功能表面正常实际上查不全）。
- 随包内容只允许：契约/schema、目录快照（几十 KB）、离线兜底的最小能力。

---

## 6. 提交前必须跑的门禁（本仓库自带脚本）

```bash
# 插件必备三件套
node scripts/xyb-check-plugins.mjs          # 清单必需字段 / 权限名 / 图标 token / MCP 规则 / 虚假声明
node scripts/xyb-check-plugin-api.mjs       # 插件实际调用的 pi.<ns>.<method> 是否仍在 packages/plugin-sdk/src 中声明
node scripts/xyb-check-plugin-contract.mjs  # 用「与宿主同等严格」的模拟 pi 实跑 onLoad / 命令 / 工具（离线）

# 涉及真实接口时
node scripts/xyb-check-plugin-contract.mjs --online   # 联网真打数据源，回答「患者按下去会发生什么」

# 若贡献子智能体 / 动到品牌资产
node scripts/xyb-check-subagents.mjs
python3 scripts/xyb-apply-brand-strings.py --check
python3 scripts/xyb-restore-brand.py --check

# 若提交市场目录条目
node scripts/check-marketplace-catalog.mjs --url <catalog-url> --plugin <id>

# 若改动发布/产物命名相关
node scripts/check-release-docs.mjs
```

**为什么必须跑插件三件套**：插件的 `main.js` **不在任何 tsconfig 的 `include` 里**，所以 `pnpm build:js`、`typecheck`、`test` 全都不会发现插件写错；上游改插件 SDK 时，只有这三条门禁会失败。

**跑之前注意两个前置**：

- `xyb-check-plugin-contract.mjs` **离线即可跑**（不需要 `packages/shared/dist`），联网时加 `--online` 才会真打数据源。
- `xyb-check-subagents.mjs` 需要 `packages/shared/dist`（官方解析器在那里）；没构建过会报「找不到官方解析器」，先跑一次 `pnpm build:js`。

**静态门禁通过 ≠ 运行时正确**。上游动了 `packages/plugin-sdk/**` 之后，仍必须起一次应用，点一遍：**插件加载 / 右侧面板视图 / 助手工具调用**。

---

## 7. 提交流程与仓库边界

- **本仓库（fork 层）**：`1 request = 1 branch + 1 worktree`，从 `origin/main` 开分支；不要直接改 main。
- **定制层路径**（上游同步守卫会逐字节保护，上游不可能覆盖它们）：
  `apps/desktop/resources/plugins/xyb.*`、`subagents/`、`assets/brand-masters/`、`scripts/xyb-*`、`XYB-*.md`。
  新增能力优先落在这里——**能做成插件/技能，就不要改 core**。
- **上游（vastsa/PI-Desktop）**：如果你做的改进与本 fork 品牌无关（例如 SDK 缺一个通用能力），请单独向上游提 PR，减少永久偏离。
- **市场条目**：改目录 JSON，`id / version / permissions / sha256 / sizeBytes / license / source_repo` 必填；包放贡献者自己的 Release，不要塞进本仓库（仓库会被大文件撑爆）。

---

## 8. 常见错误（全部来自本 fork 的真实事故）

| 症状 | 根因 | 规则 |
|---|---|---|
| 同一版 Linux 三包名字不一致（deb `xiaoyibao` / rpm `pi-desktop`） | 改名只改了一半 | 产物名**显式、ASCII、带架构**；发布前跑 `check-release-feeds.mjs` |
| AppImage 变成 `-0.16.0.AppImage`，更新检查 404 | 用 `${productName}`（中文）当文件名，electron-builder 回退到作用域名 | **产物名禁用 `${productName}` / `${name}`** |
| 工具卡 60s 后被宿主杀掉，只留 `bash timed out` | 脚本重试没有总预算（45s × 5 + 退避 ≈ 5 分钟） | 长跑脚本必须自带总预算与可读报错 |
| 插件"启用了但工具报错" | `main.js` 不参与类型检查 | 契约测试 `xyb-check-plugin-contract.mjs` |
| 本地索引突然查不全 | schema 漂移无版本校验 | 本地数据带 schema 版本 + 自动重建 |
| 凭证出现在进程列表 / 日志里 | 走 argv 传参 | 只走 `0600` 配置文件，不进 argv/日志 |
| 把上游没有 LICENSE 的代码随包分发 | 未确认许可 | **分发前必须确认许可**：MIT / Apache-2.0 可；AGPL 需单独评估（例如 `graphify-xiaoyibao`）；无 LICENSE 先找作者要授权 |

---

## 9. 参考

- 上游开发指南：[`docs/plugin-development.md`](docs/plugin-development.md)（zero-to-one，含 §6.2 Skill、§6.9 MCP server）
- 上游规范（契约，按需查）：`docs/spec/07-plugins/`
  - 清单 schema → `02-plugin-manifest-schema.md`
  - 权限矩阵 → `13-plugin-permissions-matrix.md`
  - 打包与安装 → `06-plugin-packaging.md`
  - 市场 → `07-plugin-marketplace.md`、`15-plugin-center.md`
  - 签名与更新 → `08-plugin-signing-updates.md`
  - 可信扩展 / agent extension → `16-trusted-extensions.md`
- SDK 与工具：`packages/plugin-sdk/`、`packages/plugin-devkit/`、`examples/plugins/**`
- 本 fork 的经验记录：[`XYB-SKILLHUB.md`](XYB-SKILLHUB.md)（外部技能接入与 readiness）、[`XYB-TRIAL-SOURCES.md`](XYB-TRIAL-SOURCES.md)（数据源实测）、[`XYB-UPSTREAM.md`](XYB-UPSTREAM.md)（定制层边界与跟随策略）
