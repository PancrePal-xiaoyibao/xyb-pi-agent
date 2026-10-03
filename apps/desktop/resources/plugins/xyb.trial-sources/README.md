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
| MCP 服务 | `chictr`、`veeva-ctv`、`chinadrugtrials` |
| 采集器 | `collectors/chinadrugtrials/`（Python，供上面的 MCP 服务调用） |
| 技能 | `skills/china-trials.md`（中国试验来源接入）、`skills/china-drug-trials.md`（登记平台操作细则） |
| 视图 | 「试验来源」面板：逐源写清覆盖范围、能查什么、需要什么、注意什么 |
| 命令 | 小胰宝：看看有哪些试验来源 |

权限：`ui.view`、`agent.prompt.inject`、`mcp.server.local`。
**不申请** `fs.*` 与 `net.fetch`——本插件不读写患者文件、不自己发网络请求，
联网检索与抓取都由 MCP 服务在各自进程内完成。

## 三个来源的前置条件

### chictr（ChiCTR 中国临床试验注册中心）

声明为 `npx -y chictr-mcp-server@2.0.2`。首次使用需联网拉取 npm 包，
并依赖 Playwright Chromium（约 570MB，缓存在 `~/Library/Caches/ms-playwright`）。

**为什么固定版本而不用 `@latest` 或全局命令**：实测本机全局装的旧版
`search_trials` 参数是 `keyword`（必填）+ `months`，而 2.0.2 是
`registration_number` / `year`（全部可选）——参数签名不一致。固定版本才能保证技能文档写的参数是对的。

站点有反爬与滑动验证。触发时工具提供人工验证流程
（`get_access_state` → `prepare_verification_session` → 人工完成 → `resume_after_verification`）。
这是**让本人完成站点要求的验证**，不是绕过验证。

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

**CSV/命令行路径**：不想用助手时，可以跑
`bash scripts/xyb-setup-chinadrugtrials.sh` 准备环境，再按技能文档直接调采集器。

## 一处没接进插件的来源

- **CDE 药物临床试验登记平台**：公开检索能力有限，不入客户端，以官方公示为准。

## 校验

```bash
node scripts/xyb-check-plugins.mjs apps/desktop/resources/plugins/xyb.trial-sources
pnpm pi-plugin check apps/desktop/resources/plugins/xyb.trial-sources
```

本地校验器专门覆盖了 MCP 最容易静默失效的两类问题：
`command` 写成绝对路径（宿主会拒），以及远端 MCP 域名没列入 `net.domains`。
