# 中国与区域试验来源（xyb.trial-sources）

可选数据源扩展插件。把**中国与区域临床试验数据源**以 MCP 服务的形式绑定进小胰宝，
让「临床试验助手」除了 ClinicalTrials.gov 之外，还能查到中国注册试验与全球研究库。

## 为什么单独成插件

`mcp.server.local` 属**高风险权限**——它允许插件拉起本地进程。

核心的 `xyb.trials`（ClinicalTrials.gov，开箱可用）权限是低/中级别，不该被高风险权限拖累。
所以这批来源单独成插件：**插件是否启用，本身就是用户的授权动作**。
不想要本地进程的患者永远不必接受它，核心功能也不受影响。

## 贡献的内容

| 类型 | 内容 |
|---|---|
| MCP 服务 | `chictr`、`veeva-ctv`、`chinadrugtrials`、`who-ictrp`（WHO ICTRP，聚合库） |
| 采集器 | `collectors/chinadrugtrials/`（Python，供上面的 MCP 服务调用） |
| 技能 | `skills/china-trials.md`（来源总览与接入）、`skills/china-drug-trials.md`（登记平台操作细则）、`skills/who-ictrp.md`（WHO ICTRP 聚合库） |
| 视图 | 「试验来源」面板：逐源写清覆盖范围、能查什么、需要什么、注意什么 |
| 命令 | 小胰宝：看看有哪些试验来源 |

权限：`ui.view`、`agent.prompt.inject`、`mcp.server.local`。
**不申请** `fs.*` 与 `net.fetch`——本插件不读写患者文件、不自己发网络请求，
联网检索与抓取都由 MCP 服务在各自进程内完成。

## 四处来源的前置条件

### chictr（ChiCTR 中国临床试验注册中心）

声明为 `npx -y chictr-mcp-server@3.0.2`，并注入 `CHICTR_USE_SIDECAR=1`。

**3.0.0 起改为 Python sidecar 形态**（本机 127.0.0.1:8848）。首次使用需联网拉取 npm 包，
搜索走 sidecar 纯 HTTP 通道（实测约 1.5s/页），比旧 Playwright 路径快得多，
也修掉了旧路径每页 5–10s 的人为延时。代价是前置条件变成 **Python 运行时 + 约 1GB**：

- 需本机 Python **3.10+**（本项目无法代为安装）
- Python 依赖装进自举的 venv，实测约 **321MB**（`playwright` 134M + `patchright` 134M 等）
- 浏览器内核实测约 **557MB**（`~/Library/Caches/ms-playwright`）

**首次配置必须由用户本人在终端执行一次**（插件没有 shell 能力，代不了）：

```bash
npx -y -p chictr-mcp-server@3.0.2 chictr-setup setup --browser
```

注意**不能**照着包自身 `postinstall` 的提示写 `npx chictr-mcp-server setup`——那个 bin 指向
`dist/index.js`（MCP 服务器本身），它不认 `setup` 子命令，会**静默退出 0 且什么都不做**。
真正可用的入口是第二个 bin `chictr-setup`。实测 `setup` 约 **6 分钟**。

服务自带环境体检：**调用 chictr 工具前先调 `check_environment`**，
它只读、不下载，会返回 `ready` / `summary` / `actions[]` 以及各项检查详情。

**sidecar 自动过盾**：站点的阿里盾挑战由 sidecar 用 `curl_cffi`（TLS 指纹伪装）+
`patchright`（Chromium 反检测补丁）自动解开（实测约 6.7s，无需人工）。
旧文档写的「触发时需人工验证」是实况**仍然**成立但**仅在回退路径与异常情况下**需要；
正常路径下挑战对用户不可见。

**为什么固定版本而不用 `@latest` 或全局命令**：实测本机全局装的旧版
`search_trials` 参数是 `keyword`（必填）+ `months`，而 3.0.0 是
`registration_number` / `year`（全部可选）——参数签名不一致。固定版本才能保证技能文档写的参数是对的。

站点有反爬与滑动验证。工具仍保留人工验证流程
（`get_access_state` → `prepare_verification_session` → 人工完成 → `resume_after_verification`），
供 sidecar 不可用时的异常路径使用。这是**让本人完成站点要求的验证**，不是绕过验证。

### veeva-ctv（Veeva CTV）

> ✅ **开箱可用（2026-10-04 起）**
>
> MCP 服务由 `npx -y ctv-mcp-server@0.1.0`（MIT）拉起，**用户无需手动装包**。
>
> 应用随包分发一份 Veeva 本地索引种子（1352 条研究），首次启动时自动复制到
> `~/.ctv-mcp/ctv.db`，因此**不需要用户先建索引**。种子是**只读**的随包数据；
> 用户刷新（`sync_sitemap` / `import_csv_export` / `backfill_details`）写在同一位置，
> **不会被种子覆盖**。数据目录可用插件设置「Veeva CTV 数据目录」更改。
>
> ⚠️ **但检索有一个已知缺口，务必注意**：`search_studies` 的全文检索依赖 `studies_fts`
> 表，而**经 graphql 途径入库的记录可能没有被写进 FTS**。曾实测 `studies` 有 210 条、
> `studies_fts` 只有 193 条，**缺失的都是 `source='graphql'` 的记录**（20 条里缺 17 条）。
> 后果是：**库里明明有 `YL201` 8 条，`search_studies {keyword:"YL201"}` 却返回 0 命中**——
> 不是没有数据，是全文索引漏收了。
>
> 因此呈现该渠道时：
> - 0 命中**必须**按服务返回的 `notice` 如实说明「**本地索引中未命中**」，并附上 coverage
>   （`indexed_studies` / `detail_coverage`）；**不得**表述为「没有相关研究」。
> - 可用 `get_study_detail {study_id: "<NCT 或 UTN>"}` 直查**绕过 FTS**——实测缺失记录的详情
>   **能正常取到**，数据完好。
> - 需要修索引时，用服务自身的 `reindexFts` 同款 SQL 重建缺失行即可（已实测有效：
>   重建后 `studies_fts` 193 → 210，`YL201` 命中 8 条）。**操作前务必备份 `ctv.db`。**

**索引本身可用**：`~/.ctv-mcp/ctv.db` 已是新 schema（46 列含 `start_date`），
早先记录的旧 schema 故障（18 列、`no such column: start_date`）**在当前库上不复现**。
建索引两条路：`import_csv_export` 导入站点导出的 CSV，或 `sync_sitemap` 枚举 slug 池。

检索走本地索引而非实时站点，因为站点 `robots.txt` 禁止抓 `/study-search`。

> ⚠️ **已知故障**：若 `~/.ctv-mcp/ctv.db` 由旧版本建立（`studies` 表 18 列、无 `start_date`），
> `search_studies` 与 `get_index_stats` 会报 `no such column: start_date`。
> 原因是建表用 `CREATE TABLE IF NOT EXISTS`，对已存在的旧表不生效，项目内也无迁移机制。
> 处理：备份旧库 → 让服务按新 schema 重建（40 列）→ 重新建索引。
> 详见 `XYB-TRIAL-SOURCES.md`。

### chinadrugtrials（中国药物临床试验登记与信息公示平台）

声明为**插件内相对可执行文件** `./mcp/chinadrugtrials-mcp.mjs`（零依赖 Node，只用内置模块）。
抓取逻辑复用本插件自带的 Python 采集器 `collectors/chinadrugtrials/`。

宿主允许把 `command` 写成插件内相对路径（`host-core/src/plugins/validation.rs` 会
`safe_join` 到插件目录并要求文件存在），这条路径比 `npx` 少一层网络与缓存不确定性。

它比另两处多两层前置，所以技能文档单独成篇：

| 前置 | 谁来做 | 说明 |
|---|---|---|
| Python 3 | **患者本人** | 工具装不了 Python。macOS 可 `xcode-select --install` |
| 采集器依赖 | 助手可代劳 | `setup_environment` 工具一键建 venv 并装 `requests` / `beautifulsoup4` |
| 浏览器会话 | **患者本人** | 站点校验会话。对站内**实际搜索请求**「复制为 cURL」→ `update_cookie` 保存 |

数据落在 `~/.xyb-chinadrugtrials/`，会话文件权限 0600，**不回显、不写日志、不进仓库**。

**冷启动不需要会话**：随包归档（139 条胰腺癌试验）复制到
`~/.xyb-chinadrugtrials/output/胰腺癌/json/`，`search_trials` 在未显式要求
`incremental` 时**先读该本地归档**，无会话也能返回结果。只有关键词不在本地归档里、
或显式要求刷新时才会联网，那时才需要下面的会话。

#### 如何获得 Cookie（请本人操作）

站点用「浏览器会话 + 反爬校验」区分真实访客与脚本。凭证必须由**你自己**在浏览器里
正常访问后取出，工具不会代为登录、不会生成或猜测凭据，也不会绕过验证码或反爬。

1. **在浏览器里正常打开平台**并搜索一次，确认能看到真实结果页：
   `https://www.chinadrugtrials.org.cn/`

2. **打开开发者工具**：Windows / Linux 按 `F12` 或 `Ctrl+Shift+I`，
   macOS 按 `⌥⌘I`；切到 **Network（网络）** 面板，勾选 **Preserve log（保留日志）**。

3. **在页面上再执行一次搜索**，在请求列表里找到那条**真正的搜索请求**
   （类型多为 `document` 或 `xhr`，名字含 `clinicaltrials` 一类关键词）。

4. **右键该请求 → Copy → Copy as cURL**
   （macOS 中文界面是「拷贝 → 以 cURL 格式拷贝」）。
   这一步复制出来的东西里带有 `-b` / `--cookie` 或 `-H 'Cookie: …'`，也就是会话凭证。

5. **交给工具保存**：把整段 cURL 原样粘贴给助手，让它调用 `update_cookie`。
   工具从里面提取 `Cookie` 字段写入本机会话文件（权限 0600）。
   粘贴内容里若没有 `-b/--cookie` 或 `Set-Cookie`，工具会明确报错而不是静默保存空会话。

也可以只复制 Cookie 字符串本身（形如 `FSSBBIl1UgzbN7N…=…; 其他字段=…`）粘贴保存。

6. **验证是否可用**：让助手调一次 `search_trials` 或 `get_collector_status`。
   会话有效时会正常返回结果；失效时报 `CHALLENGE_REQUIRED`，或返回
   「会话已失效或不是站内请求的完整 Cookie」的提示——**这不等于「没有相关试验」**。

7. **会话过期后重新做一遍第 1～5 步**。反爬 Cookie 会自然过期，这是站点行为。
   平台自己下发的反爬字段可以用 `refresh_bootstrap_cookie` 刷新并合并进本机会话文件，
   但它**只更新站点签发的字段**，不生成、不猜测任何凭据，也救不回已彻底失效的登录态。
   失效后仍需本人重新「复制为 cURL」。

命令行路径（不想走助手时）：

```bash
# 环境准备
bash scripts/xyb-setup-chinadrugtrials.sh
```

```python
# 保存会话（curl_text 换成你复制到的整段 cURL）
import sys; sys.path.insert(0, "collectors/chinadrugtrials")
from cookie_tools import save_cookie_to_config
save_cookie_to_config("<你的 config.json 路径>", curl_text, merge=True)
```

**红线**：不得替患者生成、猜测或复用他人 Cookie；不得尝试绕过验证码或反爬机制。

**CSV/命令行路径**：不想用助手时，可以跑
`bash scripts/xyb-setup-chinadrugtrials.sh` 准备环境，再按技能文档直接调采集器。

## 一处没接进插件的来源

- **CDE 药物临床试验登记平台**：公开检索能力有限，不入客户端，以官方公示为准。

### who-ictrp（WHO ICTRP，第五处）

**它不是一手登记处，是聚合库**：把各国注册库的记录汇总后重发，用来补覆盖面，
不能顶替上面三处，也不提供更细的字段。

- 形态：**vendored Python 源码**（`mcp/ictrp/`，17 个 `.py`，156K），由宿主以
  `-m ictrp_mcp.server` 启动，不是 `npx` 拉包。
- 前置：本机 Python 3.10+ 与依赖；环境不齐时报 `NEEDS_SETUP`。
- **9 个工具只有 1 个联网**（`ictrp_search`），其余 8 个跑本地已物化的结果集、**不重复联网**。
  所以扇出只调一次 `ictrp_search`，精炼用 `ictrp_filter`。
- **只认英文关键词**（中文实测 0 命中）。
- **条数是下界**：成功时也要把「实得行数」与「上游自报总数」**两个数分开报**，
  不得合成一个「共 N 条」。`pancreatic cancer` 实测 6262 / 6952。
- 随包冷启动快照 6262 条（10.6MB），**28 天**后报 `STALE`，届时回落联网。
- 数据来自 WHO ICTRP，受 WHO 条款约束，**禁止营销与商业用途**，且须标注归因与 WHO 处理日期。
  呈现 ChiCTR 记录时必须写「ChiCTR via WHO ICTRP」而非「ChiCTR」。

细节见 `skills/who-ictrp.md`；vendored 源码的完整性与上游一致性由
`node scripts/xyb-check-ictrp-vendor.mjs --upstream <repo>` 校验。

## 校验

```bash
node scripts/xyb-check-plugins.mjs apps/desktop/resources/plugins/xyb.trial-sources
pnpm pi-plugin check apps/desktop/resources/plugins/xyb.trial-sources
```

本地校验器专门覆盖了 MCP 最容易静默失效的两类问题：
`command` 写成绝对路径（宿主会拒），以及远端 MCP 域名没列入 `net.domains`。
