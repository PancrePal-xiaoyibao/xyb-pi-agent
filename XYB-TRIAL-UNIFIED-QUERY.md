# 四渠道统一临床试验查询：设计契约（F2）

**文档版本：v1.8**（对应实现：`xyb.trials` 0.2.0 / `xyb.trial-sources` 0.2.0 / `xyb.records` 0.3.0）
**状态：已实现并通过离线回归**
**上游设计版本：SPEC v8（ADR-F2-01 方案 B）**

本文是 F2 的唯一事实来源：说明**统一查询覆盖哪四个渠道、协调层放在哪、去重到什么程度算证据充分、以及哪些事明确不做**。
行为若有变更，必须同步更新本文版本号与「变更记录」。

---

## 一、目标与非目标

### 目标

一个入口输入关键词，得到**国内外四个渠道**的候选试验统一清单：

| 渠道键 | 来源 | 形态 | 前置条件 |
|---|---|---|---|
| `clinicaltrials_gov` | ClinicalTrials.gov | 插件直连官方 API v2（`net.fetch`） | 无，开箱可用 |
| `chictr` | ChiCTR 中国临床试验注册中心 | MCP 服务 `chictr-mcp-server@2.0.2` | 首次需 npm 拉取 + Playwright Chromium |
| `veeva_ctv` | Veeva CTV 全球研究库 | MCP 服务 `npx -y ctv-mcp-server@0.1.0` | **开箱可用**：随包分发的种子索引（1352 条）在首次启动时复制到 `~/.ctv-mcp/ctv.db`（见第八节）。仍须注意**全文检索可能漏收 graphql 入库记录**，0 命中时按「本地索引未命中」如实说明，可用 `get_study_detail` 直查绕过 |
| `chinadrugtrials` | 药物临床试验登记与信息公示平台 | 本机采集器 MCP（`./mcp/chinadrugtrials-mcp.mjs`） | 需 Python 依赖 + 患者本人浏览器会话 |

统一呈现：候选清单、**逐渠道执行状态**、结果数、查询时间、原始来源链接。

### 非目标（明确不做）

1. **不绕过**验证码、反爬、登录墙或浏览器会话保护。
2. **不自动安装**任何依赖（`npx` 包、Chromium、`ctv-mcp-server`、Python、采集器）。
3. **不写入或回显**任何 Cookie / token（会话由患者本机 `~/.xyb-chinadrugtrials/config.json` 持有，0600）。
4. **不把** `mcp.server.local` 权限并入 `xyb.trials`（见第三节权限隔离）。
5. **不用**标题、药物、地点、申办方、疾病、日期或分期相似度做自动合并。
6. **不把**「没跑」「跑不起来」渲染成「该来源没有结果」。
7. **不给**入组或诊疗建议，不输出「适合你」「建议参加」。

---

## 二、为什么协调层不能放在插件进程里（M2.0 能力审计结论）

审计对象：宿主 `apps/desktop/electron/main/plugin-runtime.ts`、插件 SDK `packages/plugin-sdk/src/index.ts`、插件间通信规范 `docs/spec/07-plugins/04-plugin-security.md` 与 `docs/spec/07-plugins/12-plugin-ipc-and-host-services.md`。

| 候选通道 | 结论 | 依据 |
|---|---|---|
| 插件直接调用另一插件的 MCP 工具 | **不可用** | MCP 工具由宿主注册在**来源插件自己的命名空间**（`plugin_<来源插件>_<server>_<tool>`），SDK 不提供跨插件工具调用 API |
| 把 `mcp.server.local` 加进 `xyb.trials` | **拒绝** | 会让默认零配置的 CT.gov 查询插件获得拉起本地进程的高风险权限，破坏 `xyb.trial-sources` 的隔离设计 |
| 插件消息总线 `pi.bus` | **不适配** | 总线是 fire-and-forget 发布/订阅，载荷对匹配订阅者公开；没有请求-响应、没有调用方身份、没有超时语义；且 `xyb.trial-sources` 自身也无法借总线调用它自己的 MCP |
| 宿主级 composite-tool / workflow 契约 | **暂不引入** | 需要新增宿主契约与权限模型，属于架构变更，应先出 ADR，不并入本次最小修复 |

**因此采纳 ADR-F2-01 方案 B**：保留四个底层适配器/服务各自的权限与生命周期，
新增一个**受契约约束的统一协调层**，由两部分组成：

1. **编排（取数）**：助手按技能 `skills/unified-trial-query.md` 逐渠道调用既有工具。
   这一步天然只能发生在 Agent 模式——插件的按需工具需要 `ToolSearch` 激活，Plan 模式默认过滤插件工具。
2. **规范化与保守合并（定形）**：`lib/unified.js` 纯函数模块 + 工具 `xyb_trials_unify`。
   这一步是确定性的、离线可测的，不依赖模型判断。

> 诚实边界：第 1 步依赖助手按契约执行，**不是**宿主强制的确定性工作流。
> 所以渠道缺失必须由第 2 步如实呈现状态，而不是让编排层的疏漏看起来像「查过了没有」。

---

## 三、权限隔离（实现约束）

| 组件 | 权限 | 说明 |
|---|---|---|
| `xyb.trials` | `ui.view`、`agent.tool.register`、`agent.prompt.inject`、`net.fetch`（域名白名单 `clinicaltrials.gov`） | 只直连 CT.gov；新增 `xyb_trials_unify` 是纯计算工具，**不需要新权限** |
| `xyb.trial-sources` | `ui.view`、`agent.prompt.inject`、`mcp.server.local` | 只负责声明并隔离三个本地 MCP；插件本身不做 fs/net 查询 |

统一查询**不新增跨插件调用**，三个 MCP 的来源与凭据边界保持原样。

---

## 四、统一数据形状

### 4.1 记录 `UnifiedTrialRecord`

| 字段 | 说明 |
|---|---|
| `source` | `clinicaltrials_gov` / `chictr` / `veeva_ctv` / `chinadrugtrials` |
| `sourceRecordKey` | `${source}:${规范化登记号}`；无登记号时为空串 |
| `registryId` / `registryIds[]` | 登记号及交叉引用 |
| `title` | 来源原文标题 |
| `sourceStatusRaw` | 招募状态，照抄来源 |
| `phase`、`conditions[]`、`interventions[]` | 有则填，无则空 |
| `locations[]` | `{ country?, province?, city?, site? }` |
| `sourceUrl` | 原始登记页链接 |
| `fetchedAt` | 抓取日期 |

缺失字段一律留空，**不推测、不填空**。

### 4.2 渠道状态 `SourceQueryStatus`

`state` 取下列之一，且必须带可执行 `explanation`：

`SUCCESS`｜`NO_RESULTS`｜`NOT_ENABLED`｜`NEEDS_SETUP`｜`INDEX_EMPTY`｜`SESSION_EXPIRED`｜`CHALLENGE_REQUIRED`｜`TIMEOUT`｜`FAILED`

语义边界（可被测试断言）：

- `NO_RESULTS` 仅当**该来源实际执行成功且返回零条**；
- 未在本次查询中提供结果的来源 → `NOT_ENABLED`，绝不等同于 `NO_RESULTS`；
- 缺少依赖 / 索引为空 / 会话失效 / 需人工验证 → 各自的专用状态，不合并成 `FAILED`；
- 单个来源任何状态都**不阻断**其余来源。

### 4.3 结果对象

`buildResult()` 返回 `{ query, statuses[4], sourcesQueried, sourcesUnavailable, totalRecords, records[], mergeCandidates[], disclaimer, fetchedAt }`。

`sourcesQueried + sourcesUnavailable === 4` 恒成立，用于界面上如实说明覆盖范围。

---

## 五、合并与去重规则（保守）

### 自动合并，仅限以下情形

1. 规范化后的**官方登记号完全相同**（大小写、`-`、`_`、`·`、`/` 归一后比较）；
2. 某来源记录**显式给出**另一注册库的交叉引用；
3. 适配器提供**可审计的官方映射**。

### 绝不作为合并依据

标题、药物、地点、申办方、疾病、日期、分期、相似度评分。

### 合并后必须保留

- 全部来源（`mergedFrom`）、全部登记号（`registryIds`）、全部原始链接（`sourceLinks`）、
  各来源记录键（`linkedRecordKeys`）；
- 有冲突时逐来源保留原始取值（`perSource.title` / `perSource.phase` / `perSource.sourceStatusRaw`），
  **不掩盖差异**。

### 疑似但未合并

标题相同/近似但**没有稳定登记号**时，两条记录都保留，并在 `mergeCandidates` 里给出
「可能相关、未自动合并」提示。禁止静默丢弃或强行合并。

### 排序（稳定、可复现）

招募状态（在招优先）→ 国内地点优先 → 更新时间新者优先 → `sourceRecordKey` 兜底。

---

## 六、调用序列（助手侧契约）

```
1. ToolSearch 激活：xyb_trials_search / xyb_trials_unify，以及已启用来源的 MCP 工具
2. 渠道 1：xyb_trials_search            → SUCCESS / NO_RESULTS / FAILED(网络)
3. 渠道 2：chictr search_trials         → **中英文各一次**（如「胰腺癌」+ `pancreatic`/`KRAS`）
                                        → 或 NEEDS_SETUP / CHALLENGE_REQUIRED / SESSION_EXPIRED
4. 渠道 3：ctv search_studies（country: China 可选） → 或 INDEX_EMPTY
5. 渠道 4：chinadrugtrials get_collector_status → 未就绪则记状态；就绪才 search_trials
6. xyb_trials_unify({ keywords, condition, sourceResults })
7. 呈现：逐渠道状态 + 候选清单 + 原始链接；未覆盖处显式说明
```

硬性约束：

- 第 5 步**先查状态再查询**。统一查询**不得**隐式调用 `setup_environment` / `update_cookie`——
  查询不应升级成安装或凭据写入；缺前置就如实报告，让用户自己决定是否配置。
- 任一渠道缺前置或失败，继续其余渠道，最后统一呈现状态。
- 不使用、不记录、不复述会话凭据。
- **语言**：中文库（ChiCTR、药物登记平台）必须**中英文各查一次**再下结论；同义词写法
  （`B7-H3` / `B7H3`）也要各试。只跑一种语言就记 `NO_RESULTS` 属错误汇报，
  须在 `explanation` 写明已试过的词。

---

## 七、验证证据

| 验收点 | 证据 |
|---|---|
| 同登记号跨来源合并、保留全部来源/登记号/链接 | `apps/desktop/test/xyb-trials-unified.test.mjs` |
| 缺登记号时**不**自动合并，仅提示 | 同上 |
| 冲突逐来源保留 | 同上 |
| `NO_RESULTS` 与各不可用状态不混淆 | 同上 |
| 未提供的来源 → `NOT_ENABLED` | 同上 |
| 单渠道失败不影响其余结果 | 同上 |
| 排序稳定、重复计算一致 | 同上 |
| 状态语义不混淆、未知状态降级 `FAILED`、未跑 → `NOT_ENABLED` | 同上（14 pass） |
| 工具与 manifest 契约、离线可加载 | `node scripts/xyb-check-plugin-contract.mjs` |
| F1 摘要确认/脱敏/不写盘回归 | `apps/desktop/test/xyb-records-summary.test.mjs` |
| 构建与测试基线复现 | `XYB-AUDIT-F3-BUILD-TEST-EVIDENCE.md` |
| 扫描器证据核验 | `XYB-AUDIT-F4-SCANNER-EVIDENCE.md` |
| 许可与分发风险 | `XYB-AUDIT-F5-LICENSE-RISK.md` |

```bash
cd apps/desktop && node --test test/xyb-trials-unified.test.mjs test/xyb-records-summary.test.mjs  # → 26 pass
node scripts/xyb-check-plugin-contract.mjs   # → ✓ 6 个插件通过（exit 0）
node scripts/xyb-check-plugins.mjs           # → 结果 6/6 通过（exit 0）
node scripts/xyb-check-plugin-api.mjs        # → ✓ 插件 API 面完好（exit 0）
cargo test -p host-core --locked             # → 671 passed / 0 failed（exit 0）
```

实测日期：本仓 BASELINE_MAIN `0a022317` + 本次改动；Node v22.19.0、cargo 1.98.1。

---

## 八、已知限制（如实记录）

1. 编排依赖助手执行技能契约，非宿主强制工作流；渠道缺失通过状态呈现来兜底。
2. 三个 MCP 渠道的可用性取决于本机前置条件，**未在本仓 CI 中端到端验证**（不安装、不使用真实会话）。
   2026-10-03 在本机做了一次**人工实测**，结论见下表；该实测不进入 CI，不构成长期保证。

   | 渠道 | 实测结果 | 性质 |
   |---|---|---|
   | `chictr` | `npx -y chictr-mcp-server@2.0.2` 启动成功；`胰腺癌` → 5 条、`KRAS` → 10 条、`B7-H3` → 1 条、`pancreatic` → 10 条、`YL201` → 0 条；`get_access_state` = `NORMAL` | **可用**，支持中英文；`YL201`=0 属 `NO_RESULTS` |
   | `veeva_ctv` | `npx -y ctv-mcp-server@0.1.0`（**已发布到 npm**，MIT）启动成功，暴露 12 个工具；`get_index_stats` → 本地索引 210 条、46 列含 `start_date`。**但 `search_studies {keyword:"YL201"}` 返回 0 命中**，而库中实际有 8 条 | **服务器可用，但全文检索有缺口**，详见第 9 条 |
   | `chinadrugtrials` | MCP 启动成功；`get_collector_status` → `python available=true (venv 3.13.12)`、`collector_deps.ok=true`、`cookie.configured=false`、`ready=false` | **环境就绪**，仅待用户本人配置会话（属正常设计，不得自动化） |
3. Veeva CTV 旧版本地索引可能报 `no such column: start_date`，按 `INDEX_EMPTY` / `FAILED` 如实呈现。
4. `chinadrugtrials` 的 `search_trials` 有本地归档副作用；统一查询只做检索，不触发同步/归档任务。
5. 面板 `views/trials.html` 目前只渲染 CT.gov 单源结果；四渠道统一视图由助手在会话中呈现。
6. **已更正（v1.1 → v1.2）**：`pnpm build:js` / `pnpm test` 实际**可以运行并通过**。早先记录的「未能运行」是因为 PATH 上的 pnpm 为 9.12.2 且 worktree 无 `node_modules`。把 corepack 缓存的 pnpm 10.34.5 前置到 PATH 后，`pnpm install --frozen-lockfile`、`pnpm build:js`、`pnpm test` 全部 **exit 0**（`cargo test -p host-core` 671 pass）。修正手法见 `XYB-AUDIT-F3-BUILD-TEST-EVIDENCE.md` v2.0。
7. **已更正（v1.1 → v1.2）**：所谓「168 个基线既有失败」是**隔离 worktree 缺 `node_modules` 导致的假失败**，不是既有债务、不是代码缺陷。安装依赖后 `apps/desktop` 全量测试为 **3203 pass / 0 fail**。这一条修正依据项目原则：缺依赖时不得把解析失败当作缺陷立项。详见 `XYB-AUDIT-F3-BUILD-TEST-EVIDENCE.md` v2.0 的更正表。
8. 本机 `cargo fmt` / `cargo clippy` 门禁**无法执行**：工具链未安装 `rustfmt` / `clippy` 组件（`stable-aarch64-apple-darwin`）。需 `rustup component add rustfmt clippy`；本次**未**据此判断 Rust 格式/lint 通过或失败。
9. **Veeva CTV 检索存在 FTS 漏收缺口（已定位根因，可用服务自身 SQL 修复）**：

   **接入侧已恢复**：`ctv-mcp-server` 已发布到 npm（`@0.1.0`，MIT），`xyb.trial-sources/manifest.json:38`
   声明的裸命令 `"command": "ctv-mcp-server"` 现在**可解析**；`npx -y ctv-mcp-server@0.1.0` 实测启动成功，
   暴露 12 个工具。早先「该包在 npm 上不存在（`E404`）」的记录**已过期**。

   **但检索侧有真实缺陷**：`search_studies` 的全文检索依赖 `studies_fts` 表，而该表
   **漏收了经 graphql 途径入库的记录**。实测本机库：

   | 项目 | 数量 |
   |---|---|
   | `studies` 总行数 | 210 |
   | `studies_fts` 行数 | **193**（缺 17） |
   | 其中 `source='csv'` | 190 / 进 FTS 190 ✓ |
   | 其中 `source='graphql'` | 20 / **进 FTS 仅 3**（缺 17）✗ |

   后果：**库中确有 `YL201` 8 条，`search_studies {keyword:"YL201"}` 却返回 `total_matched: 0`**。
   这不是「没有相关研究」，而是**全文索引漏收**。直查 `studies` 表与
   `get_study_detail {study_id: "<NCT/UTN>"}` 都能取到这些记录（数据完好），**只有 FTS 检索路径看不见**。

   已实测的修复方式：用服务自身 `reindexFts` 的同款 `INSERT INTO studies_fts (...) SELECT ... FROM studies`
   SQL 重建缺失行 → `studies_fts` **193 → 210**，`YL201` 命中 **0 → 8**（经真实 MCP `search_studies` 复验）。
   **操作前必须备份 `ctv.db`。**

   **呈现约束（本次未改契约语义）**：该渠道 0 命中时**必须**按服务返回的 `notice` 如实说明
   「**本地索引中未命中**」并附 coverage（`indexed_studies` / `detail_coverage`），
   **不得**表述为「没有相关研究」。这不新增状态值——仍用 `NO_RESULTS`，但 `explanation`
   须写明是「本地索引未命中」而非「不存在相关试验」。

10. **渠道 4（`chinadrugtrials`）的归档根与关键词语义（v1.5 起）**：
    - 归档根默认 `~/.xyb-chinadrugtrials`，可用环境变量 `XYB_CHINADRUCTRIALS_DATA_DIR` 覆盖。
      **采集器固定写 `<root>/output/<关键词>/`**（`scraper.py:1135`）；若把根指到采集器目录
      （如 `~/Downloads/chinadrugtrials`），MCP 会自动按 `output/` 子目录查找，无须改动采集器。
    - **`keywords` 支持多个**（逗号/顿号/空格分隔，上限 8 个），逐个关键词分别抓取、各自归档到一个目录。
      采集器一次只接受一个关键词，且**用关键词拼目录名**，因此整串传下去只会得到 `胰腺癌_实体瘤`
      这一个目录——多关键词必须由 MCP 层循环调用。
    - 渠道 4 的会话由 MCP **启动时自动刷新**站点下发的反爬字段（`FSSBBIl…S/T`），
      并暴露 `refresh_cookie` 供手动触发。刷新**只覆盖站点同名字段，保留本人登录态字段**；
      登录态本身过期（被重定向到登录/验证页）时刷新救不回来，必须由本人重新「复制为 cURL」。
    - `get_collector_status` 在「环境就绪但归档为空」时返回 `bootstrap_plan`，给出一次可执行的
      首次同步建议（关键词 `胰腺癌,实体瘤`）。**不会自动执行**：抓取有落盘副作用与被判挑战页的风险。

11. **归档解析的两个已知数据缺陷及规避方式（v1.5 起）**，均已实测于 139 条归档：
    - **申请人名称占位符**：`details['申请人名称']` 在归档里可能是占位符（实测为 `'1'`），
      真值只在 `sections['基本信息']['申请人名称']`。`get_trial_detail` 返回的 `applicant_name`
      已自动取真值并过滤纯数字；归档原值另存于 `scraped_applicant_name` 供排查。
    - **参加机构表列错位**：采集器 `_extract_table_kv`（`scraper.py:864`）对列数为偶数的行按
      `(cells[0],cells[1])、(cells[2],cells[3])…` 机械配对，而该表为 6 列
      （序号|机构名称|主要研究者|国家或地区|省（州）|城市），于是整表错位一格，且字典键冲突
      会把同省机构互相覆盖（38 家只剩 19 个省市键）。**`sections` 中的该表不可直接使用**；
      `get_trial_detail` 改从 `full_text`（无损顺序文本，含 `序号\n机构名称\n…` 表头）按列还原，
      实测 139/139 条归档全部还原成功。
      > 影响面提示：归档里「主要研究者信息」章节的电话/邮箱属于研究者本人，不是申办方联系人。
      > 引用时不要与申请人联系人混为一谈（此点在 CTR20252528 的人工核对中确认为易错点）。

12. **渠道 4 的可用性判定不得只看依赖探测（v1.6 起）**：
    - `get_collector_status` 新增 `collector_files`（采集器脚本是否随包存在：`scraper` /
      `verifier` / `requirements` / `cookie_tools`）。**`collector_deps` 只探测 venv 能否 import
      `requests`/`bs4`，看不到「脚本根本不在磁盘上」**——MCP 被单独安装成 npm 包、或插件目录被
      裁剪时，旧实现会打印 `ready: true` + `collector_deps.ok: true`，直到真正调用
      `search_trials` 才以 ENOENT 失败。现在脚本缺失时 `collector_deps` 直接标记
      `skipped`，不再给出误导性的 ok。
    - `ready` 语义**收紧**为「现在就能抓取」（= python + 脚本齐 + 依赖齐 + 会话已配置），
      并新增独立的 `quote_read_available`（已归档数据是否可读）。两者刻意分开：**归档非空时
      即使不能抓，`list_archived` / `search_trials` / `get_trial_detail` 仍完全可用**，
      不应因为「不能抓」就说整个渠道不可用。
    - `bootstrap_plan` 的触发条件放宽为「**归档为空 + 采集器在 + python 在**」，不再要求
      已配置会话——全新部署恰恰还没有 cookie，把 cookie 当门槛会让最需要引导的新用户看不到
      任何提示。未就绪的原因改用 `blockers` 如实列出，`ready_to_run` 表示是否可直接执行。

13. **MCP 入口判定必须走 realpath（v1.6 起）**：
    - 启动守卫原先比较字面路径 `import.meta.url === new URL('file://' + resolve(argv[1]))`。
      macOS 的 `/tmp` 是 `/private/tmp` 的软链接，`npm link`、符号链接安装、或经 `/tmp` 中转
      启动时两者只在字面上不同，判定为 `isDirectRun = false`，**进程静默退出、exit 0、无任何
      报错**——宿主只看到「MCP 起不来」而拿不到原因。现改为字面比较失败后回退 `realpathSync`。
    - 复核方式：`ln -s <插件>/mcp/chinadrugtrials-mcp.mjs /tmp/link/server.mjs && node /tmp/link/server.mjs`
      应打印 `[chinadrugtrials-mcp] started; plugin=…`。
14. **`list_archived` 的截断与「目录不存在」必须如实区分（v1.7 起）**：
    - `limit` 默认 50，旧返回体只有 `records`/`trials` 两个数，调用方**无法区分**「总共就 50 条」
      与「139 条里只给了前 50 条」。实测 IBI343 的 `CTR20252528` 在胰腺癌归档中排**第 114 位**：
      患者按药名翻归档会得到「没有」这个错误结论。现返回 `returned_records`、`truncated`，
      截断时附 `truncation_note`（写明还有多少条没显示、不得据此下结论）与 `suggested_limit`。
    - 用 `keywords` 过滤一个**本机不存在**的目录时，旧实现返回 0 条却不说明，与「归档确实为空」
      混为一谈。现返回 `matched_archive: false` 与 `warning`，明确「这 0 条不是『没有试验』」，
      并提示先不带 `keywords` 看本机实际有哪些归档目录。
    - 注意 `safeKeywordDir` 的转义（非 `\w` 非中文 → `_`）**与采集器 `scraper.py:1134` 的
      `re.sub(r'[^\w\u4e00-\u9fff]', '_', …)` 完全一致**，两侧已逐字节比对确认。
      若归档目录名来自**其它工具**（如外部 `chinadrugtrials` 项目的 `B7-H3_CD276_招募中`，
      保留了连字符），它不落在本 MCP 的命名空间内，`keywords` 过滤不到属预期行为——
      应改用不带 `keywords` 的调用查看实际目录名，而不是把目录名当关键词传。

---

## 九、随包分发与数据刷新（v1.8 起）

四个渠道中，只有渠道 3（Veeva CTV）需要**本地索引**才能检索。为了做到「开箱即用」，
索引随安装包分发；但分发副本是**只读种子**，不是运行时数据。

### 9.1 为什么不能直接用包内那份

安装到 `/Applications`、`Program Files` 后，普通用户对应用目录**没有写权限**。
ctv-mcp-server 的刷新工具（`sync_sitemap` / `import_csv_export` / `backfill_details`）
会写库，指向包内路径必然失败。因此分两份：

| 位置 | 角色 | 谁写 |
|---|---|---|
| `<插件>/data/ctv.db` | **只读种子**，随安装包分发 | 构建时由仓库内容决定，运行时永不修改 |
| `~/.ctv-mcp/ctv.db` | **运行时索引** | ctv-mcp-server 读写；首次由种子复制而来 |

`xyb.trial-sources` 在 `onLoad` 时执行 `ensureVeevaSeed()`：**只在目标不存在时**复制。
已有本地库（用户刷新过）**永不覆盖**。复制失败不阻断插件加载——渠道 1/2/4 不受影响。

默认目录 `~/.ctv-mcp` 可用插件设置 `veevaDataDir` 覆盖，该值经 `manifest.json` 的
`mcpServers[].env` 以 `{ "setting": "veevaDataDir" }` 注入 `CTV_DATA_DIR`。

> 复制为什么用 `node:fs` 而不是 `pi.fs.writeText`：宿主 fs API 只接受字符串，
> 无法搬运 50MB 二进制库。插件 `main.js` 由宿主以真实 Node 模块加载
> （`plugin-host-process.mjs` 的 `loadPluginModule` 走 `createRequire`），
> `pi.file-manager` 已有同样的先例。

### 9.2 数据刷新链路

```
ctv-mcp-server 刷新索引          →  ~/.ctv-mcp/ctv.db（约 63MB）
  node scripts/xyb-sync-trial-data.mjs --apply
   ├─ 调用 scripts/slim-db.mjs 瘦身（63.7MB → 49.7MB，7 项自检）
   └─ 复制到 <插件>/data/ctv.db
git commit                        →  下次打包自动带进 dmg/exe
```

刷新**按需**进行（季度或重要试验更新），与发布次数无关：文件内容不变时 git 不产生
新对象，发布多少次仓库都不增长。

`apps/desktop/package.json` 的 `build.extraResources` 已含
`{"from": "resources/plugins", "to": "plugins"}`，插件内 `data/` 会随包分发，
**无需改打包配置**。仓库 `.gitignore` 未忽略 `data/` 或 `*.db`，`ctv.db` 可直接入库。

### 9.3 瘦身做了什么（以及没做什么）

上游 `studies` 表把同一份位置数据存了两遍：`locations_json` 与
`detail_json.locations`。实测抽样 300 条有 292 条**逐字节相同**，多占 14.7MB。

`slim-db.mjs` 把 `locations_json` 置 NULL 并 VACUUM，**不删列**——上游
`repository.js:210,337` 每次 upsert 都写这一列，删列会让上游直接报错。

两个必须记住的操作细节：

- **必须临时摘掉 `trg_studies_fts_au`**。SQLite 只要发现「存在会写虚拟表的触发器」
  就拒绝整条 `UPDATE studies`（报 `unsafe use of virtual table "studies_fts"`），
  哪怕该触发器的 `WHEN` 条件根本不看 `locations_json`。脚本先取出 DDL、DROP、
  更新，再在 `finally` 里原样装回，并断言装回成功——**触发器没装回去的库表面正常，
  要等用户下次同步才会暴露**，是最难排查的一类损坏。
- **`is_china` 必须保持原值**。维护它的触发器条件含 `new.locations_json IS NOT NULL`，
  置 NULL 后不再触发，所以脚本显式比对瘦身前后的中国试验数（实测 408 不变）。

瘦身是**一次性**的：只读查询不改变体积，写操作会把 `locations_json` 写回（涨回约 63MB）。
对分发场景可接受，需要时再跑一次即可（幂等，输出逐字节相同）。

### 9.4 已知风险

- `ctv.db` 进 git 后，**历史里的那 50MB 不可撤销**。刷 4 次约 200MB，clone 会变慢。
  这是选择「进 git」方案时明确接受的代价。
- 脚本不自动 `git add`/`commit`，刷新后是否入库由人决定（避免未经确认的库进入历史）。
- 缺 node_modules 或未跑过 `pnpm install` 时，同步脚本仍可运行（只依赖 `node:fs`、
  `node:child_process` 与 `sqlite3` CLI）。

---

## 变更记录

| 版本 | 变更 |
|---|---|
| v1.0 | 初版。确立四渠道范围、方案 B 协调层、权限隔离、统一数据形状、保守去重规则与状态语义。 |
| v1.1 | 补入 F3/F4/F5 证据文档引用与实际复核命令；如实记录构建未能运行的退因（pnpm 引擎校验）与 168 个基线既有测试失败；未改动任何契约语义。 |
| v1.2 | **更正** v1.1 的第 6、7 条已知限制：构建与测试实际通过（exit 0，`apps/desktop` 3203 pass / 0 fail），先前的「未能运行」与「168 个失败」均为隔离 worktree 缺依赖所致。新增第 8 条：`cargo fmt` / `clippy` 因工具链缺组件无法执行。未改动任何契约语义。 |
| v1.3 | 场景测试（`b7h3 YL201` 四渠道）后的**更正与加固**：①更正 v1.2 的隐含结论——渠道 2/4 实测**可用/就绪**，此前记 `NEEDS_SETUP` 是探测方式错误所致，并对三渠道给出实测表（已知限制第 2 条）；②明确**语言策略**：中文库须中英文各查一次、同义词各试，只跑一种语言不得记 `NO_RESULTS`（调用序列硬性约束新增一条，技能同步更新）；③新增第 9 条已知限制，如实记录 Veeva CTV 的 `ctv-mcp-server` 在 npm 不存在、渠道连不上的接入缺口，并规定该渠道须记 `NEEDS_SETUP` 而非 `INDEX_EMPTY`；④状态语义回归测试增至 14 pass。未改动任何契约语义。 |
| v1.4 | 渠道 3 端到端复验与**根因定位**：①更正 v1.3 的结论——`ctv-mcp-server` **已发布到 npm**（`@0.1.0`、MIT），实测 `npx -y ctv-mcp-server@0.1.0` 启动成功、暴露 12 个工具，「包不存在（E404）」的记录作废；②新发现并定位**真实检索缺陷**：`studies_fts` 漏收 `source='graphql'` 的入库记录（实测 210 条中缺 17 条，graphql 侧 20 条仅 3 条进 FTS），导致**库中有 `YL201` 8 条却 0 命中**；③实测确认修复方式（用服务自身 `reindexFts` 同款 SQL 重建缺失行 → FTS 193→210、`YL201` 命中 0→8，经真实 MCP 复验）并写明须先备份；④明确呈现约束：0 命中须说「本地索引中未命中」并附 coverage，不得说「没有相关研究」；⑤同步更正 `xyb.trial-sources` 的 `main.js` / `README.md` / `skills/china-trials.md` 三处已过期的「包不存在、渠道不可用」文案。未改契约语义（仍用 `NO_RESULTS`，只约束 `explanation` 措辞）。 |
| v1.5 | 渠道 4（`chinadrugtrials`）**MCP 服务端改造与两个解析缺陷修复**（只改 MCP 侧，未动已验收的 `scraper.py`）：①归档根可配置——`XYB_CHINADRUCTRIALS_DATA_DIR` 覆盖默认 `~/.xyb-chinadrugtrials`，指向采集器目录时自动按 `output/` 子目录查找（修复「采集了 139 条但 MCP 报本机无归档」）；②`keywords` 支持多关键词（逗号/顿号/空格分隔，上限 8），由 MCP 层循环调用采集器——整串下发只会得到一个 `胰腺癌_实体瘤` 目录（`scraper.py:1135` 用关键词拼目录名）；③会话自维护：MCP 启动时自动刷新站点反爬字段并新增 `refresh_cookie` 工具，只覆盖站点同名字段、保留本人登录态（实测 `fetch_bootstrap_cookie` → HTTP 202、`FSSBBIl…S/T` 两字段）；④`get_collector_status` 在「环境就绪但归档为空」时返回 `bootstrap_plan`，**不自动执行**（抓取有落盘副作用）；⑤修复**申请人名称占位符**（`details['申请人名称']` 实测为 `'1'`，真值取 `sections['基本信息']`，原值存 `scraped_applicant_name`）与**参加机构表列错位**（`sections` 中该表因 6 列被机械配对而错位一格、38 家只剩 19 个省市键，改从 `full_text` 还原，实测 139/139 条全部还原成功）；⑥新增回归测试 `apps/desktop/test/xyb-chinadrugtrials-parse.test.mjs`（6 pass）并为模块加 `isDirectRun` 守卫使其可被 import 而不启动传输层。新增已知限制第 10、11 条。未改契约语义与四来源状态枚举。 |
| v1.6 | 渠道 4 的**可用性判定与入口守卫加固**（`get_collector_status` 的三个真实缺陷，均在「单独安装 MCP / 全新部署 / 软链接启动」三个场景实测复现）：①`collector_deps` 只测 venv 依赖、看不到采集器脚本缺失，导致 `ready: true` 却必然 ENOENT——新增 `collector_files` 并把 `ready` 收紧为「现在就能抓取」，另设 `quote_read_available` 表达「已归档数据可读」（归档非空时即使不能抓，查询/详情仍完全可用）；②`bootstrap_plan` 原先要求已配置会话，而全新部署恰恰没有 cookie，最需要引导的新用户反而看不到提示——触发条件放宽为「归档为空 + 采集器在 + python 在」，未就绪原因改用 `blockers` 列出、`ready_to_run` 表示可否直接执行；③`isDirectRun` 只比字面路径，macOS（`/tmp`→`/private/tmp`）与 `npm link` 场景下判定失败会**静默退出、exit 0、无任何报错**，现回退 `realpathSync` 比较。新增已知限制第 12、13 条；回归测试 `apps/desktop/test/xyb-chinadrugtrials-parse.test.mjs` 由 6 pass 增至 **9 pass / 0 fail**（含隔离安装、全新部署、软链接启动三例）。未改契约语义与四来源状态枚举。 |
| v1.7 | **`list_archived` 的两个误读风险修复**（由 IBI343 端到端模拟暴露）：①`limit` 默认 50 且旧返回体不区分「总共就这么多」与「被截断」——实测 `CTR20252528` 在胰腺癌归档排第 114 位，默认调用下按药名翻归档会得出「没有」的错误结论；现返回 `returned_records`/`truncated`，截断时给 `truncation_note` 与 `suggested_limit`；②用 `keywords` 过滤不存在的目录时返回 0 条却不说破，与「归档为空」混为一谈，现返回 `matched_archive: false` 与 `warning`。另确认 `safeKeywordDir` 与 `scraper.py:1134` 的转义规则逐字节一致（连字符→下划线），外部工具建的目录名不落在本 MCP 命名空间内属预期。新增已知限制第 14 条；回归测试由 9 pass 增至 **11 pass / 0 fail**。未改契约语义与四来源状态枚举。 |
| v1.8 | **渠道 3 改为开箱可用：随包分发本地索引 + 首次启动种子复制**（承载方案经用户确认「初始化构建一次 + 脚本更新」）：①`xyb.trial-sources/manifest.json` 修掉裸命令 `"command": "ctv-mcp-server"`（干净机器上必然 `command not found`），改为 `npx -y ctv-mcp-server@0.1.0`，并通过 `env` 把新增设置 `veevaDataDir` 注入 `CTV_DATA_DIR`（`{ "setting": "veevaDataDir" }`，由 `mcp-config.ts` 的 `resolveMcpRefs` 解析）；②新增 `scripts/slim-db.mjs`（瘦身 + 7 项自检，幂等）与 `scripts/xyb-sync-trial-data.mjs`（瘦身→校验→复制进 `<插件>/data/ctv.db`，默认不覆盖、需显式 `--force`）；③`xyb.trial-sources` 新增 `ensureVeevaSeed()`：首次启动把只读种子复制到 `~/.ctv-mcp/ctv.db`（**只在目标不存在时**，用户刷新结果永不覆盖；失败不阻断加载），因宿主 `pi.fs.writeText` 只收字符串无法搬运 50MB 二进制而使用 `node:fs`（与 `pi.file-manager` 同先例）；④新增测试 `apps/desktop/test/xyb-trial-sources-seed.test.mjs`（6 pass，覆盖已存在不覆盖、无种子降级、真实 50MB 二进制一致性、自定义目录、onLoad 容错）；⑤文档新增第九节「随包分发与数据刷新」，记录只读种子 vs 运行时索引的双份设计、刷新链路、瘦身的两个关键操作约束（必须临时摘 `trg_studies_fts_au`、`is_china` 必须保持不变）与「git 历史 50MB 不可撤销」的风险。`xyb.trial-sources` 0.1.0 → 0.2.0。未改契约语义与四来源状态枚举。 |
