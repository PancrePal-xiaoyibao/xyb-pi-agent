---
name: 中国试验来源接入
description: 当需要调用中国与区域试验数据源时使用——ChiCTR（中国临床试验注册中心）、中国药物临床试验登记平台、Veeva CTV 的工具参数、前置条件与访问受限处理。属操作细则，检索与匹配方法见「临床试验助手」。
---

# 中国试验来源接入

「临床试验助手」讲的是**怎么检索、怎么匹配、怎么摊开依据**；本文只讲**数据源怎么接、工具怎么调、卡住了怎么办**。

四处来源覆盖范围不同，谁也不能替代谁。默认能用的是 ClinicalTrials.gov。

| 来源 | 覆盖 | 怎么接 | 关键前提 |
|---|---|---|---|
| ClinicalTrials.gov | 全球（含中国申办方在美国登记的） | 内置工具 `xyb_trials_search` | 无，开箱可用 |
| ChiCTR | 中国注册试验（含研究者发起 IIT） | MCP 工具，见下 | 首次需联网拉包；站点有反爬 |
| 中国药物临床试验登记平台 | 中国药物注册试验 | 本机脚本（非 MCP） | **需本人浏览器会话 Cookie** |
| Veeva CTV | 全球研究库（可筛 China） | MCP 工具，见下 | **须先建本地索引** |

> 拿不到来源时必须明说「这一处没查到」，不要用其他来源的结果顶上，也不要让患者以为已全覆盖。

---

## 一、ChiCTR（中国临床试验注册中心）

接入方式：MCP 服务 `chictr`，由 `xyb.trial-sources` 插件声明（走 `npx chictr-mcp-server@2.0.2`）。
缓存落在 `~/.chictr/cache/`。

### 工具与参数

**search_trials** — 检索。四个参数**全部可选**，可以只按年份或只按注册号查。

- `keyword`：注册题目关键词，如 `KRAS G12C`、`胰腺癌`
- `registration_number`：注册号，如 `ChiCTR2500111173`
- `year`：注册年份，如 `2024`；省略则默认当前年份
- `max_results`：条数上限，默认 20

**get_trial_detail** — 按注册号取详情，`registration_number` 必填。详情比列表丰富得多。

**诊断类工具**（只在出问题时用，别当检索手段）：`get_cache_stats`、`get_cache_stats_v2`、`get_runtime_metrics`、`clear_cache`（**清缓存是破坏性操作，先问用户**）。

### 访问受限时怎么办

站点会反爬，频繁请求触发滑动验证。工具提供了状态机：

1. `get_access_state` 看状态：`NORMAL` / `SUSPECTED` / `CHALLENGED` / `COOLDOWN` / `RECOVERY`
2. 处于 `CHALLENGED` 时，用 `prepare_verification_session` 取得 `verification_id`
3. 请用户**人工完成验证**
4. 用 `resume_after_verification` 传 `verification_id` 恢复

**硬约束**：这条路是「让本人完成站点要求的验证」，不是「绕过验证」。不得尝试破解验证码、不得伪造 Cookie、不得绕访问控制。用户不在场就直接说明暂时查不到，不要硬试。

### 已知版本漂移（会踩）

本机若曾全局装过旧版 `chictr-mcp-server`，它的 `search_trials` 参数是 `keyword`（必填）+ `months`，与本版本的 `registration_number` / `year` **不一致**。所以插件固定用 `npx ...@2.0.2`，不要改用全局命令。

---

## 二、中国药物临床试验登记与信息公示平台

**不是 MCP**，是本机 Python 采集器（`chinadrugtrials` 项目 + 配套技能）。在助手会话里按其技能文档调用本机脚本。

- 支持关键词与高级检索（登记号、适应症、方案编号、药物名称/类型、申请人、伦理委员会、研究者、参加机构、状态）
- 产物：详情原始 HTML、RAG JSON、服务器原样 `.doc`
- 支持按「登记号 + 正文内容哈希」增量同步

**凭证红线**：平台校验浏览器会话，**必须由用户本人提供 Cookie**。

- 不得替用户生成、猜测或复用他人 Cookie
- Cookie 只写在本机 `config.json`（该文件已被 `.gitignore` 排除），**不得写入技能文档、日志、回答或任何提交**
- 该平台与前述来源一样，不得绕过验证码或反爬

---

## 三、Veeva CTV

接入方式：MCP 服务 `veeva-ctv`，需本机已安装 `ctv-mcp-server`（`npm link` 或全局安装）。

### 必须先建索引

检索走**本地索引**，不是实时站点（站点 `robots.txt` 禁止抓 `/study-search`）。索引为空时检索返回 `INDEX_EMPTY`，不是「没有结果」。

建索引两条路：

- `import_csv_export`：导入从站点导出的 CSV（35 列）。参数 `file_path`（**绝对路径**必填）；可选 `backfill_details` 回源补齐全字段
- `sync_sitemap`：从官方 sitemap 枚举 slug 池（60 分片，约 597,907 条）。参数 `max_shards` 控制本次拉取片数，**每片约 1 万条，别一次拉满**

### 工具与参数

**search_studies** — 组合检索。可组合 `keyword`（全文，匹配标题/摘要/适应症/关键词/纳排标准）、`condition`、`sponsor`、`status[]`、`phase[]`、`country`、`type`、`start_date_from` / `start_date_to`、`updated_since`、`limit`、`offset`。查中国相关研究加 `country: "China"`。

**get_study_detail** — `study_id` 必填（UTN / NCT / slug / 详情页 URL 都可），返回 37 字段，含 CSV 导出里没有的**纳入排除标准**。`include_contacts` 默认脱敏，**不要主动打开**。

**backfill_details** — 批量补详情，`utns` 留空则自动取未补齐的。受内置节流保护，耗时较长。

**export_rag** — 按临床语义分节导出知识库文档块（概览/摘要/详细描述/纳排标准/分组/干预/中心），带元数据头便于溯源。`include_contacts` 同样默认脱敏。

**generate_report** — 按检索条件出分析报告（状态/分期/申办方/适应症/国家分布、入组规模、启动年份趋势）。

**订阅巡检**（对应「有更新就提醒我」）：`create_watchlist` 建订阅 → `run_watchlist` 巡检（本地水位 + 轮询 diff，只拉 6 个轻量字段比对状态与更新时间）→ `get_change_digest` 读最近 N 天变更。`list_watchlists` 看已有订阅。**注意**：CTV 无 webhook/RSS，所以是轮询，不是实时。

**get_index_stats** — 看索引规模与详情覆盖率。

### 已知故障（会踩，且表现极像"没数据"）

旧版建的 `~/.ctv-mcp/ctv.db` 是**旧 schema**（`studies` 表 18 列、没有 `start_date`），而代码查 `start_date` → `search_studies` 与 `get_index_stats` 直接报 `no such column: start_date`。

原因是建表用 `CREATE TABLE IF NOT EXISTS`，对已存在的旧表不生效，项目里也没有迁移机制。

处理：备份旧库后让它按新 schema 重建（新库 40 列），再用 `import_csv_export` 或 `sync_sitemap` 重新建索引。**报这个错时不要告诉患者「没有相关研究」**，那是故障不是空结果。

---

## 四、跨来源的硬约束（与「临床试验助手」一致）

1. **来源可溯**：每条结论都能指回登记编号与原文链接，写明取自哪个来源、查的什么条件
2. **区分「没查到」与「查不到」**：索引为空、访问受限、工具报错，都要如实说明，不得含糊成「没有」
3. **跨来源数据不可混算**：不同来源的登记口径、字段、更新节奏都不同，不做合并统计、不互相比「谁更多」
4. **不做入组判断**：只列条件与差异，是否适合由研究医生结合病情判断；不给"建议参加"
5. **不做医院与医生排名**
6. **不预测生存期**，不把早期数据当结论
7. **机制未披露就写未披露**，不推断
8. 所有输出带免责声明：信息整理，不替代医生判断，不构成用药建议

## 调用这些工具前：先激活

本插件提供的工具是**按需激活**的（宿主为省上下文，插件工具默认不进工具列表）。
直接调用会得到 `Tool plugin_... not found`——这不是插件坏了，是还没激活。
先 `ToolSearch` 用工具名查一次（例如查 `xyb_trials_search`），返回
"Activated on-demand tools" 之后，**下一轮**才能正常调用。
