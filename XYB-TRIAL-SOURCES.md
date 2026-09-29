# 中国与区域试验来源：接入设计与实测结论

面向 `xyb.trial-sources` 插件。本文记录**为什么这样接、实测到了什么、哪些还没接**。

状态：已实现并通过官方校验（5/5）。本轮实测均在本机真实执行，命令与结论可复现。

---

## 一、三处来源的能力边界（实测）

| 项目 | 形态 | 出网 | 凭据 | 许可证 |
|---|---|---|---|---|
| `chictr_trials` | npm MCP 服务 `chictr-mcp-server@2.0.2` | 仅 `www.chictr.org.cn` | 无 | **Apache-2.0**（README 徽章误标 MIT） |
| `ctv-mcp-server` | 本地 MCP 服务，未发布 npm | `ctv.veeva.com`（GraphQL 公开，无鉴权） | 无 | MIT |
| `chinadrugtrials` | Python 采集器 + 独立技能 | `chinadrugtrials.org.cn` | **需用户本人浏览器会话 Cookie** | **无 LICENSE 文件** |
| `clinicaltrials推送和订阅` | 运维/推送系统（Skill） | 多 | **12+ 组密钥**（TG / 微信 / 飞书 / FastGPT / LLM） | MIT |

**关键判断**：后两者**不接入客户端**。

- `chinadrugtrials` 需要授权会话 Cookie，属用户私密凭据，不适合预置进分发插件；
  且无 LICENSE（默认保留所有权利），因此**不内联其代码**，只在技能文档里写清用法，用用户本机已有副本。
- `clinicaltrials推送和订阅` 是**运营侧情报系统**（TG/GeWe/飞书推送 + FastGPT 同步），
  不是患者查询来源。它带 12+ 组生产密钥，进客户端只会扩大凭据面。
  它对应的患者侧能力（"有更新提醒我"）由 Veeva CTV 的 `create_watchlist` / `run_watchlist` 承担。

---

## 二、为什么用 MCP，以及为什么单独成插件

### 插件系统没有 shell/exec 权限

权限表里**不存在**执行外部进程的权限项（低：`ui.view` 等；中：`fs.read` 等；
高：`fs.write` / `net.fetch` / `mcp.server.*` 等）。
所以「跑一个本地 Python/Node 工具」的唯一正规通道就是 **`contributes.mcpServers`**。

### 单独成插件而不是并进 `xyb.trials`

`mcp.server.local` 属**高风险权限**（会拉起本地进程，须用户显式授权）。
`xyb.trials` 是默认可用、零配置的核心来源（ClinicalTrials.gov，低/中权限），
不应被高风险权限拖累——否则每个患者都要为了基础功能接受本地进程。

**插件是否启用，本身就是授权动作。** 不想要本地进程的患者永远不必接受，
核心功能也不受影响。这与已确立的「权限面越小，患者信任成本越低」一致。

---

## 三、实测验证（真实握手）

对两个 MCP 服务做了 JSON-RPC `initialize` + `tools/list` 握手，不是读文档。

### chictr（`npx -y chictr-mcp-server@2.0.2`）✓

```
serverInfo: { name: "chictr-mcp-server", version: "2.0.2" }
9 个工具：search_trials / get_trial_detail / get_cache_stats / clear_cache /
        get_cache_stats_v2 / get_runtime_metrics / get_access_state /
        prepare_verification_session / resume_after_verification
```

`search_trials` 的四个参数 `keyword` / `registration_number` / `year` / `max_results`
**全部可选**（可以只按年份或只按注册号查）。

### ⚠️ 版本漂移（会踩）

本机**全局安装的旧版**握手返回 `serverInfo 0.1.0`，其 `search_trials` 参数为
`keyword`（**必填**）+ `months`，与 2.0.2 的 `registration_number` / `year` **不一致**。

→ 插件固定 `npx ...@2.0.2`，不用 `@latest`、不用全局命令。技能文档按 2.0.2 写参数。

### ⚠️ 反爬与人工验证

站点会触发滑动验证，headless 下无法处理。工具提供状态机：
`get_access_state`（NORMAL/SUSPECTED/CHALLENGED/COOLDOWN/RECOVERY）
→ `prepare_verification_session` → 人工完成 → `resume_after_verification`。

技能文档写明：这是**让本人完成站点要求的验证**，不是绕过验证；用户不在场就如实说查不到。

### veeva-ctv（裸命令 `ctv-mcp-server`）✓

```
serverInfo: { name: "ctv-mcp-server", version: "0.1.0" }
12 个工具：search_studies / get_study_detail / import_csv_export / sync_sitemap /
        backfill_details / export_rag / generate_report /
        create_watchlist / run_watchlist / list_watchlists / get_change_digest / get_index_stats
```

`include_contacts` 默认脱敏（隐私默认值正确）。

### 🐛 实测发现真 bug：旧库 schema 导致检索完全不可用

```
search_studies   → {"error":"UNKNOWN","message":"no such column: start_date"}
get_index_stats  → 同上
```

定位过程：

| 检查 | 结果 |
|---|---|
| `~/.ctv-mcp/ctv.db` 是否存在 | 存在，2.7MB，`studies` 表 **18 列** |
| 代码建表语句 | `repository.ts:19` 定义 **40 列**，含 `start_date` |
| 是否缺迁移 | 无 `ALTER TABLE` / 无 `user_version`；建表用 `CREATE TABLE IF NOT EXISTS` |
| 换新数据目录重跑（`CTV_DATA_DIR`） | `studies` **40 列**、含 `start_date`；两个工具均正常 |

**根因**：`CREATE TABLE IF NOT EXISTS` 对**已存在的旧表不生效**，项目内也没有迁移机制，
于是旧 schema 的库一直留着，而查询语句已按新 schema 写。

新库的表现是 `{"error":"INDEX_EMPTY","hint":"先用 import_csv_export 导入…或 sync_sitemap"}`
——**这是「没建索引」，不是「没有相关研究」**。技能文档专门写了这条区分，
避免把故障当结论告诉患者。

**处置建议**（未执行，等确认）：备份 `ctv.db` → 让服务按新 schema 重建
→ 用 `import_csv_export`（项目内已有 `CTV_results_2026-08-25.csv`）或 `sync_sitemap` 重建索引。
根治应在项目里补 schema 迁移。

### 索引前提（产品事实）

CTV 检索走**本地索引**而非实时站点，因为 `ctv.veeva.com` 的 `robots.txt` 禁止抓 `/study-search`
（工具的 description 里写明了）。所以首次使用必须先建库，否则等于空库。

---

## 四、修掉的虚假声明（本轮）

新加的两条校验（MCP 规则 + settings 引用检查）立刻抓出 4 处**「声明了但没实现」**——
患者侧表现为"开关拨了没反应"，且不会有任何报错。

| 位置 | 问题 | 处理 |
|---|---|---|
| `xyb.trials` | 声明设置 `sourceChiCTR`（默认**开**）与白名单 `chictr.org.cn`、`chinadrugtrials.org.cn`，但代码**只实现了 ClinicalTrials.gov** | 删除该设置；白名单收窄为 `clinicaltrials.gov` |
| `xyb.assistants` | 声明 `diseaseFocus`、`includePastoral` 两个设置，无任何文件引用 | 删除。信仰类规则已由 `psych-support.md` 用技能规则实现（默认只用非宗教鼓励语） |
| `xyb.news` | 声明 `cacheHours`，但**没实现任何缓存** | 删除该设置；白名单收窄为 `eutils.ncbi.nlm.nih.gov` |

`xyb.trials` 那条最要紧：勾选"检索 ChiCTR"看起来能查中国注册试验，实际什么都没发生。

---

## 五、知识分工（避免两个技能打架）

| 技能 | 管什么 |
|---|---|
| `xyb.trials` · 临床试验助手 | 检索策略、关键词矩阵、筛选排序、输出模板、硬性规则 |
| `xyb.trial-sources` · 中国试验来源接入 | 各来源的**接入方式、工具参数、前置条件、卡住怎么办** |

两份技能描述里互相点名（"属操作细则，方法与模板见另一方"），避免助手选错。

---

## 六、待决事项

1. **是否启用 `xyb.trial-sources`**：启用即授予 `mcp.server.local`（拉起本地进程）。
   患者侧默认是否开启，需产品定调。
2. **CTV 索引重建**：是否执行「备份旧库 → 重建 → 导入现有 CSV」。要动 `~/.ctv-mcp/`，等确认。
3. **npx 首次拉包时机**：chictr 首次使用需联网拉 npm 包并依赖 Playwright Chromium（约 570MB）。
   是首次检索时静默拉取，还是提示患者确认？
4. **CDE 是否接入**：公开检索能力有限，当前只在技能文档里作为方向提及。
5. **跨社区**：小铃铛（淋巴瘤）、小肺宝（肺癌）是否同 App 承载，仍待定
   （见 `XYB-ASSISTANTS.md`）。
