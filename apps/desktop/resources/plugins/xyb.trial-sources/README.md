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
| MCP 服务 | `chictr`、`veeva-ctv` |
| 技能 | `skills/china-trials.md`（中国试验来源接入） |
| 视图 | 「试验来源」面板：逐源写清覆盖范围、能查什么、需要什么、注意什么 |
| 命令 | 小胰宝：看看有哪些试验来源 |

权限：`ui.view`、`agent.prompt.inject`、`mcp.server.local`。
**不申请** `fs.*` 与 `net.fetch`——本插件不读写患者文件、不自己发网络请求，
联网检索由 MCP 服务在各自进程内完成。

## 两个来源的前置条件

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

声明为裸命令 `ctv-mcp-server`，需本机已安装：

```bash
cd <ctv-mcp-server 项目目录>
npm link          # 或在有权限的环境下全局安装
```

**必须先建立本地索引**，否则检索返回 `INDEX_EMPTY`（不是「没有结果」）。
建索引两条路：`import_csv_export` 导入站点导出的 CSV，或 `sync_sitemap` 枚举 slug 池。

检索走本地索引而非实时站点，因为站点 `robots.txt` 禁止抓 `/study-search`。

> ⚠️ **已知故障**：若 `~/.ctv-mcp/ctv.db` 由旧版本建立（`studies` 表 18 列、无 `start_date`），
> `search_studies` 与 `get_index_stats` 会报 `no such column: start_date`。
> 原因是建表用 `CREATE TABLE IF NOT EXISTS`，对已存在的旧表不生效，项目内也无迁移机制。
> 处理：备份旧库 → 让服务按新 schema 重建（40 列）→ 重新建索引。
> 详见 `XYB-TRIAL-SOURCES.md`。

## 两处没接进插件的来源

- **中国药物临床试验登记与信息公示平台**：本机 Python 采集器，不是 MCP，
  且**必须由用户本人提供浏览器会话 Cookie**。接入方式写在技能文档里，由助手在会话中调用本机脚本。
  凭据只留在本机 `config.json`，不进本插件、不入仓库。
  该项目**没有 LICENSE 文件**（默认保留所有权利），因此不内联其代码，只用本机已有副本。
- **CDE 药物临床试验登记平台**：公开检索能力有限，不入客户端，以官方公示为准。

## 校验

```bash
node scripts/xyb-check-plugins.mjs apps/desktop/resources/plugins/xyb.trial-sources
pnpm pi-plugin check apps/desktop/resources/plugins/xyb.trial-sources
```

本地校验器专门覆盖了 MCP 最容易静默失效的两类问题：
`command` 写成绝对路径（宿主会拒），以及远端 MCP 域名没列入 `net.domains`。
