---
name: 中国试验来源接入
description: 当需要调用中国与区域试验数据源时使用——ChiCTR（中国临床试验注册中心）、中国药物临床试验登记平台、Veeva CTV 的工具参数、前置条件与访问受限处理；并说明 WHO ICTRP 这个**聚合库**为何不能顶替一手来源。属操作细则，检索与匹配方法见「临床试验助手」。
---

# 中国试验来源接入

「临床试验助手」讲的是**怎么检索、怎么匹配、怎么摊开依据**；本文只讲**数据源怎么接、工具怎么调、卡住了怎么办**。

五处来源覆盖范围不同，谁也不能替代谁。默认能用的是 ClinicalTrials.gov。

| 来源 | 覆盖 | 怎么接 | 关键前提 |
|---|---|---|---|
| ClinicalTrials.gov | 全球（含中国申办方在美国登记的） | 内置工具 `xyb_trials_search` | 无，开箱可用 |
| ChiCTR | 中国注册试验（含研究者发起 IIT） | MCP 工具，见下 | 首次需联网拉包；**需 Python 3.10+ 与约 1GB 运行时**（3.0.1 sidecar 形态），先调 `check_environment` |
| 中国药物临床试验登记平台 | 中国药物注册试验 | MCP 工具 `chinadrugtrials`，细则见「中国药物临床试验登记平台接入」 | **需本人浏览器会话；首次需准备 Python 环境** |
| Veeva CTV | 全球研究库（可筛 China） | MCP 工具，见下 | **须先建本地索引** |
| WHO ICTRP | 全球，但**是二手聚合库** | MCP 工具 `ictrp` 的 `ictrp_search`，细则见「WHO ICTRP 接入」 | 需本机 Python 3.10+ 与依赖；**条数是下界**（见下） |

> WHO ICTRP 把上面几家的记录汇总后重发，所以同一条试验会重复进来。它用来**补覆盖面**
> （尤其是没单独接的小注册库），不是放宽精度——`ictrp_search` 只认英文关键词（中文实测 0 命中），
> 且返回集系统性小于上游自报的匹配数：成功时也必须把「实得行数」与「上游自报总数」
> **两个数分开报**，不得合成一个「共 N 条」。同一条中国试验被 ChiCTR 与 ICTRP 同时命中时，
> 合并保留 **ChiCTR 直连版**（更实时），ICTRP 版进 `mergedFrom`。

> **中文关键词在 ICTRP 上的 0 命中不是发现，是语言产物**：该库只索引英文元数据，服务会把
> 这种必然的空集报成 `NO_RESULTS` + `retryable: false` + 「This is a genuine zero」。
> 这**不得**转述为「没有相关试验」或「查不到」；必须说明是关键词语言不匹配，并改用英文
> 关键词（如 `pancreatic cancer`）重查。宿主侧编排器已把该来源的 `NO_RESULTS` 文案固定为
> 这一口径（见 `trial-orchestrator.ts` 的 `noResultsSentence`），照抄即可，不要自行改写。

> 拿不到来源时必须明说「这一处没查到」，不要用其他来源的结果顶上，也不要让患者以为已全覆盖。

---

## 一、ChiCTR（中国临床试验注册中心）

接入方式：MCP 服务 `chictr`，由 `xyb.trial-sources` 插件声明（走 `npx chictr-mcp-server@3.0.2`，注入 `CHICTR_USE_SIDECAR=1`）。
缓存落在 `~/.chictr/cache/`。

### 前置条件与自省（先看这一步）

3.0.1 起 ChiCTR 走 **Python sidecar** 通道，前置条件变重：需本机 Python 3.10+，
以及约 1GB 的依赖与浏览器内核（**venv 实测 321MB** + Python 侧内核约 557MB）。
**调用任何 chictr 工具前，先调 `check_environment`**：

- 只读、不下载、不修改任何文件；带 30 秒缓存（`{"refresh": true}` 可强制重探）
- 返回 `ready`、`summary`、`actions[]`，以及 `checks`（`node` / `venv` / `python_deps` /
  `browser` / `sidecar_script` / `sidecar` / `playwright_fallback`）
- `ready: false` 时把 `actions[]` 里的修复步骤**如实转述给用户**（含可复制的命令），
  不要自己猜原因，也不要把它说成「查不到」

环境未就绪时，**如实说明这一处没查**，状态记 `NEEDS_SETUP`，不得记 `NO_RESULTS`。

**首次配置必须由用户本人执行**（插件没有 shell 能力，无法代为安装）。命令**不能**按包内
`postinstall` 提示的那样写：

```
❌ npx chictr-mcp-server setup      # 无效：这个 bin 指向 dist/index.js（MCP 服务器），
                                    #       它不认 setup 子命令，静默退出 0、什么都不做
✅ npx -y -p chictr-mcp-server@3.0.2 chictr-setup setup --browser
```

`--browser` 会额外下载 Python 侧浏览器内核（约 560MB）；不加则只有回退路径用不了，
sidecar 路径不受影响。**实测耗时约 6 分钟**（单步超时默认 1800s），
且**必须给出远超 MCP 握手 10s 的等待预期**——这一步不要在会话里同步等。
健康检查用 `npx -y -p chictr-mcp-server@3.0.2 chictr-setup doctor`。

### 工具与参数

**search_trials** — 检索。四个参数**全部可选**，可以只按年份或只按注册号查。

- `keyword`：注册题目关键词，如 `KRAS G12C`、`胰腺癌`
- `registration_number`：注册号，如 `ChiCTR2500111173`
- `year`：注册年份，如 `2024`；省略则默认当前年份
- `max_results`：条数上限，默认 20，最大 100

**get_trial_detail** — 按注册号取详情，`registration_number` 必填。详情比列表丰富得多。

**诊断类工具**（只在出问题时用，别当检索手段）：`check_environment`、`get_cache_stats`、
`get_cache_stats_v2`、`get_runtime_metrics`、`get_access_state`、`clear_cache`
（**清缓存是破坏性操作，先问用户**）。

### 访问受限时怎么办

正常路径下站点挑战由 **sidecar 自动解开**（`curl_cffi` 伪装 TLS 指纹 + `patchright` 反检测
Chromium 内核，实测约 6.7s，cookie 有效期约 55 分钟），用户无感知。**这条路径不需要人工介入。**

只有在 sidecar 不可用（未装 Python 依赖 / sidecar 未启动）而回退到 Playwright 路径、
且确实触发挑战时，才走人工流程：

1. `get_access_state` 看状态：`NORMAL` / `SUSPECTED` / `CHALLENGED` / `COOLDOWN` / `RECOVERY`
2. 处于 `CHALLENGED` 时，用 `prepare_verification_session` 取得 `verification_id`
3. 请用户**人工完成验证**
4. 用 `resume_after_verification` 传 `verification_id` 恢复

**硬约束**：这条路是「让本人完成站点要求的验证」，不是「绕过验证」。不得尝试破解验证码、不得伪造 Cookie、不得绕访问控制。用户不在场就直接说明暂时查不到，不要硬试。

### 已知版本漂移（会踩）

本机若曾全局装过旧版 `chictr-mcp-server`，它的 `search_trials` 参数是 `keyword`（必填）+ `months`，与本版本的 `registration_number` / `year` **不一致**。所以插件固定用 `npx ...@3.0.2`，不要改用全局命令。

**为什么是 3.0.2 而不是 3.0.0（重要）**：3.0.0 的详情页解析器把整页压平后用正则猜边界，
字段清单只有 58 项，且**老式注册号 `ChiCTR-IIR-17013424` 这类编号匹配不到**
（正则写成 `ChiCTR\d{6,}`，搜索与详情两条路径都漏）。3.0.1 改为按表格结构解析
（标签在 `<td class=left_title>`、值在紧邻的下一个 `<td>`），字段清单扩到 76 项，
平均每页字段数 21.9 → 58.6。

3.0.2 是 3.0.1 的**必要补丁**，修掉两处静默数据丢失，不能停在 3.0.1：

- 「纳入标准」「排除标准」两个标签从未进 `DETAIL_LABELS` 白名单，结构解析直接跳过它们，
  实测覆盖率 **0/468** —— 而页面里这两个字段每页都有。3.0.1 的 tarball 里打包的
  sidecar 就是这个带缺陷的版本，所以只能靠 3.0.2 拿全量重抓。
- `_TAG_RE` 原写成 `r"<[^>]+>"`，会把正文里的数学比较符当成标签起点，
  从 `<10%` 一路删到后面某个 `>`。实测 `ChiCTR1800014927` 等 9 条记录的
  「排除标准」中 `'T细胞转导效率<10%或者培养后T细胞扩增小于5倍；'` 整段消失。
  收紧为 `r"</?[A-Za-z!][^>]*>"`。

3.0.2 实测：全量 468 条重抓 468/468 成功，字段数 min 41 / max 67 / avg 58.6，
不同字段 76 个，回查 HTML 原文 28809 个字段值 0 处不符；100% 覆盖字段由 34 升至 37。

**不要回退到 3.0.0 或停留在 3.0.1**——那会静默丢掉纳入/排除标准、联络人、
伦理委员会、单位等整类字段。

**两套 Chromium 内核的坑**：Node 侧 `playwright` 期望 `chromium-1234`，Python 侧 `patchright`
期望 `chromium-1243`，两者**不是同一个内核**。走 sidecar 路径时 Node 侧内核**完全不需要**，
所以 `check_environment` 会把 Node 侧内核缺失标为可忽略（`playwright_fallback`）。
不要因为这个检查项去下载那 570MB——那是回退路径才需要的。

---

## 二、中国药物临床试验登记与信息公示平台

接入方式：MCP 服务 `chinadrugtrials`，由本插件自带采集器（`collectors/chinadrugtrials`）与 MCP 服务
（`mcp/chinadrugtrials-mcp.mjs`）在**本机**完成抓取与归档。数据落在 `~/.xyb-chinadrugtrials/`。

**它的前置条件比另两处重**，所以操作细则单独成文——工具参数、环境准备、会话配置、
归档产物与故障排查，一律见「中国药物临床试验登记平台接入」。本节只留三条不能忘的：

- 站点校验**浏览器会话**，抓取前必须由本人从浏览器复制 cURL 配置会话；会话过期是常态
- 首次使用要先准备 Python 环境（助手可一键准备，但**Python 本体只能患者自己装**）
- 故障与会话失效必须如实区分，**不得解释成「没有相关试验」**，也不得绕过验证

**凭证红线**：会话只写在本机 `~/.xyb-chinadrugtrials/config.json`（权限 0600）。

- 不得替患者生成、猜测或复用他人 Cookie
- 不得写入技能文档、日志、回答或任何提交

---

## 三、Veeva CTV

接入方式：MCP 服务 `veeva-ctv`，由 `npx -y ctv-mcp-server@0.1.0` 拉起（**开箱可用，无需你手动装包**）。

> ✅ **开箱即有本地索引（2026-10-04 起）**：应用随包分发一份 Veeva 本地索引种子（1352 条研究），首次启动时自动复制到 `~/.ctv-mcp/ctv.db`，因此**不需要用户先建索引**。索引是**本机快照**，不是实时站点。
>
> 用户可自行刷新（`sync_sitemap` / `import_csv_export` / `backfill_details`），刷新结果写在同一位置，**不会被种子覆盖**。数据目录可用插件设置「Veeva CTV 数据目录」更改。
>
> ⚠️ **检索有已知缺口**：全文检索用的 `studies_fts` 表**漏收了经 graphql 途径入库的记录**。表现为**库里明明有 `YL201` 8 条，`search_studies {keyword:"YL201"}` 却 0 命中**。
>
> 因此：
> - 0 命中时**必须**按服务返回的 `notice` 说「**本地索引中未命中**」并附 coverage，**不得**说「没有相关研究」；
> - 可用 `get_study_detail {study_id: "<NCT/UTN>"}` **绕过 FTS 直查**（实测缺失记录详情可正常取到）；
> - 修索引可用服务自身的 `reindexFts` 同款 SQL 重建缺失行（实测重建后 FTS 193 → 210、`YL201` 命中 8 条），**操作前先备份 `ctv.db`**。

### 索引从哪来

检索走**本地索引**，不是实时站点（站点 `robots.txt` 禁止抓 `/study-search`）。索引为空时检索返回 `INDEX_EMPTY`，不是「没有结果」。

随包分发的种子索引已覆盖常见检索需求。需要**更新到最新**时，有两条路：

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
