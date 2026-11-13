# 中国与区域试验来源：接入设计与实测结论

面向 `xyb.trial-sources` 插件。本文记录**为什么这样接、实测到了什么、哪些还没接**。

状态：已实现并通过官方校验（5/5）。本轮实测均在本机真实执行，命令与结论可复现。

> **WHO ICTRP（第 4 处来源，规划中）：** 2026-10-04 用户确定把 `ictrp-mcp-service` 作为统一查询的第 5 个来源接入本插件。
> 形态与既有三处**不同**：源码随包 vendoring（`mcp/ictrp/`），由 `python3 -m ictrp_mcp.server` 启动，依赖
> `mcp` / `httpx` / `pydantic`，**不经过 npm 或 PyPI**。它是本插件唯一的非 Node 依赖，也是第一个需要四级运行时
> 探测的来源（可执行文件 → 随包模块 → 第三方依赖 → MCP 握手）。完整规格见
> `docs/zh-CN/spec/xyb-unified-trial-host-orchestration.md` §15；本节只记录它与既有来源的形态差异。
> **尚未实现。**

---

## 一、四处来源的能力边界（实测）

| 项目 | 形态 | 出网 | 凭据 | 许可证 |
|---|---|---|---|---|
| `chictr_trials` | npm MCP 服务 `chictr-mcp-server@3.0.2`（`CHICTR_USE_SIDECAR=1`） | 仅 `www.chictr.org.cn` | 无（sidecar 自解挑战，不需人工） | **Apache-2.0**（README 徽章误标 MIT） |
| `ctv-mcp-server` | 本地 MCP 服务，未发布 npm | `ctv.veeva.com`（GraphQL 公开，无鉴权） | 无 | MIT |
| `chinadrugtrials` | 本插件自带采集器 + MCP 服务 | `chinadrugtrials.org.cn` | **需患者本人浏览器会话** | 源仓库无 LICENSE 文件（见第七节） |
| `ictrp`（**规划中**） | 随包 vendoring 的 Python MCP 服务（`mcp/ictrp/`） | `trialsearch.who.int` | 无 | 代码 **MIT**；**数据受 WHO 条款约束**（不得商业/推广用途，须标注 WHO 与处理日期） |
| `clinicaltrials推送和订阅` | 运维/推送系统（Skill） | 多 | **12+ 组密钥**（TG / 微信 / 飞书 / FastGPT / LLM） | MIT |

**关键判断**：

- `chinadrugtrials` **已接入**。原判断是「不接入」，理由是授权会话不适合预置进分发插件。
  这一条仍成立，但结论改了：会话不进插件，而是落到患者本机的 `~/.xyb-chinadrugtrials/config.json`（0600），
  由患者本人在浏览器里复制 cURL 写入。**插件里没有任何凭据**。
- `clinicaltrials推送和订阅` **仍不接入**。它是**运营侧情报系统**（TG/GeWe/飞书推送 + FastGPT 同步），
  不是患者查询来源。它带 12+ 组生产密钥，进客户端只会扩大凭据面。
  它对应的患者侧能力（“有更新提醒我”）由 Veeva CTV 的 `create_watchlist` / `run_watchlist` 承担。
- `ictrp` **规划中，尚未接入**。它是**聚合库**（收录 ChiCTR、CT.gov、JPRN、CTIS 等），因此与 `chictr_trials`
  存在系统性重叠——同一登记号命中时保留 ChiCTR 直连版本。它的 CSV 导出**静默不完整**（实测 KRAS 场景缺 29.0%），
  所以**结果条数永远是下界**，0 命中不得表述为「不存在」。它是本插件第一个**非 Node** 依赖：Python 运行时
  不在本项目控制范围内，必须做四级探测并给出可复制的修复命令。

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

### chictr（`npx -y chictr-mcp-server@3.0.2`，`CHICTR_USE_SIDECAR=1`）✓

```
serverInfo: { name: "chictr-mcp-server", version: "2.0.2" }   ← 包的 src/index.ts:170 未更新版本号（3.0.1 实测仍未修）
10 个工具：search_trials / get_trial_detail / get_cache_stats / clear_cache /
        get_cache_stats_v2 / get_runtime_metrics / get_access_state /
        check_environment / prepare_verification_session / resume_after_verification
```

**前置条件（3.0.0 sidecar 形态）**：需本机 Python 3.10+ 与约 1GB 运行时
（自举 venv 约 325MB + Python 侧浏览器内核约 557MB）。调用检索前先调只读体检工具
`check_environment`（30s 缓存，`{"refresh":true}` 强探）。未满足时记 `NEEDS_SETUP`，
**不得记 `NO_RESULTS`**。

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

## 六、chinadrugtrials 接入（2026-09-30）

### 为什么是 MCP，而不是「让助手跑脚本」

插件系统没有 shell/exec 权限（见第二节），所以把 Python 采集器交给助手去终端执行**不是一条正规通道**。
正解是把采集器包成 MCP 服务，宿主按 `contributes.mcpServers` 拉起。

选型：MCP 服务用 **零依赖 Node**（`mcp/chinadrugtrials-mcp.mjs`，只用内置模块），
抓取时再 `spawn` 采本插件自带的 Python 采集器。理由是分层隔离——

| 层 | 运行时 | 缺了会怎样 |
|---|---|---|
| MCP 服务本身 | Node（应用生态已有） | 服务起不来 |
| 抓取逻辑 | Python 3 + requests + beautifulsoup4 | 工具能列出，抓取报「先调 setup_environment」 |

这样「Python 没装」只影响抓取，不会让整个 MCP 服务失联——患者看到的是**一句可执行的话**，
而不是一个不存在的工具。

### 声明形态

```json
{ "id": "chinadrugtrials", "transport": "stdio", "command": "node", "args": ["mcp/chinadrugtrials-mcp.mjs"] }
```

用 `node` 启动**插件内相对路径的脚本**，不是绝对路径（宿主会拒），也不是 `npx`（少一层网络与缓存不确定性）。
宿主以插件目录为 cwd 拉起子进程，所以 args 里的相对路径落在插件内；`node` 走宿主的
启动器解析（PATH / fnm / nvm-windows / Volta），GUI 进程 PATH 里没有 node 时也找得到。

**不要**把 `./mcp/xxx.mjs` 直接写成 command：那要靠 shebang + 执行位，macOS / Linux 能跑，
Windows 不能直接执行 `.mjs`，宿主拉起时 `spawn EFTYPE`，表现是「插件启用了但一个工具都没有」。
回归测试：`apps/desktop/test/xyb-chinadrugtrials-parse.test.mjs` 里按 manifest 原样声明、
经宿主启动链路（`McpServerClient`）握手的那一条。

### 组成

| 路径 | 作用 |
|---|---|
| `mcp/chinadrugtrials-mcp.mjs` | MCP 服务，8 个工具 |
| `collectors/chinadrugtrials/` | 内联的 Python 采集器（见该目录 README 的来源与许可说明） |
| `skills/china-drug-trials.md` | 操作细则：参数、会话红线、环境前置、故障排查 |
| `scripts/xyb-setup-chinadrugtrials.sh` | 终端手动准备环境（幂等，与应用内 `setup_environment` 等价） |

工具：`get_collector_status` / `setup_environment` / `update_cookie` / `search_trials` /
`sync_incremental` / `get_trial_detail` / `list_archived` / `verify_archive`。

### 会话与凭据设计

会话**不进插件、不进仓库**，落在患者本机 `~/.xyb-chinadrugtrials/config.json`（权限 0600）。

- 传到采集器时走 `--config` **文件**，不走命令行参数——命令行会出现在进程列表里，别的进程读得到
- `update_cookie` **不回显** Cookie 值，只回字段名；日志、回答、提交里都不出现
- 提取到但缺少平台常见会话字段时，工具会**提示可能不是站内请求的完整 Cookie**（而不是默默存下）
- 配置里刻意不写采集器认识的 `output` / `keywords` / `max_pages` 等键——
  采集器是 config 优先，塞了会静默覆盖命令行传的值

### 实测（本轮真实执行）

| 验证项 | 结果 |
|---|---|
| MCP 握手 `initialize` + `tools/list` | ✓ 8 个工具枚举正常 |
| 从**任意 cwd** 以绝对路径启动（模拟宿主 spawn） | ✓ 插件目录推导正确 |
| `setup_environment` | ✓ 16 秒建好 venv 并装上 requests / beautifulsoup4 |
| `get_collector_status` | ✓ 装完后 `ready: true`，解释器切到 venv |
| `update_cookie`（假 cURL） | ✓ 提取出 3 个字段，落盘 0600，不回显 |
| `update_cookie`（垃圾串） | ✓ 拒绝，不误存 |
| `search_trials`（**故意用假会话**） | ✓ 站点返回反爬挑战页 → 工具如实报「会话失效」，**没有**误报「0 条结果」 |
| 校验器反例 | ✓ 去掉执行位即报错，恢复后通过 |
| 官方 `pi-plugin check` | ✓ 16 files, 140.5 KB |

**两处踩到的坑（已修）**：

1. **异步工具被提前打断**：输入流关闭时我原本直接 `process.exit(0)`，
   抓取这类长任务会「结果还没写出去就退出」，调用方收到空响应。
   改为追踪 pending 计数，任务收尾后才退出。
2. **诊断取错日志流**：采集器的日志走的是 **stdout**（不是 stderr），
   我原先只取 stderr 的尾部 → 出错时 `log_tail` 全空、提示也泛泛。
   改为两股合并取尾部，并单独提取采集器最后一条 `[ERROR]` 行作为结论。

另外把「归档目录」的判定改成**必须真的含 `.json` 记录**：
采集器建对象时就把 `json/ word/ logs/ raw/` 建好，会话失效时会留下一个全空目录，
那种目录不能算归档，否则患者会看到「胰腺癌 0 条」这种像是结论的东西。

### 许可（待处理）

上游 `chinadrugtrials-collector` **没有 LICENSE 文件**，按默认规则即「保留所有权利」，
严格讲不满足再分发的明确授权。该仓库同属小胰宝组织（`PancrePal-xiaoyibao`），
本次按「自有代码内联」处理，但**建议尽快补 LICENSE**，否则对外分发时说不清楚。
详见 `collectors/chinadrugtrials/README.md`。

---

## 七、待决事项

1. **是否启用 `xyb.trial-sources`**：启用即授予 `mcp.server.local`（拉起本地进程）。
   患者侧默认是否开启，需产品定调。
2. **CTV 索引重建**：是否执行「备份旧库 → 重建 → 导入现有 CSV」。要动 `~/.ctv-mcp/`，等确认。
3. **npx 首次拉包时机**：chictr 首次使用需联网拉 npm 包并依赖 Playwright Chromium（约 570MB）。
   是首次检索时静默拉取，还是提示患者确认？
4. **CDE 是否接入**：~~公开检索能力有限，当前只在技能文档里作为方向提及。~~
   **已定（2026-10-04）：CDE 作为统一查询来源接入，且与其他来源同等纳入扇出**（用户否决了原同意闸门设计）。
   见 `docs/zh-CN/spec/xyb-unified-trial-host-orchestration.md` §4.3。CDE 随包种子仍未构建（§7.1 是新增能力）。
5. **跨社区**：小铃铛（淋巴瘤）、小肺宝（肺癌）是否同 App 承载，仍待定
   （见 `XYB-ASSISTANTS.md`）。
6. **`chinadrugtrials-collector` 补 LICENSE**：无 LICENSE 即默认保留所有权利，
   对外分发前应补上（第六节「许可」）。
7. **患者端会话配置的体验**：现在要求患者对站内请求「复制为 cURL」，
   对不熟悉开发者工具的人门槛偏高。是否做一个带图示的分步引导，或在
   「试验来源」面板里直接给入口，需产品定调。
8. **抓取耗时与提醒**：逐条抓取（每条 1.5 秒）在条数多时是分钟级。
   是否要默认只抓前 N 条并提示「先看看这批，再决定要不要继续」。
9. **WHO ICTRP 的运行时前置**：Python ≥3.10 与三个第三方库不在本项目控制范围内，是本插件第一个
   「开箱即用」无法单方面保证的来源。若依赖缺失在用户机器上普遍发生，需在「随包 Python 运行时」与
   「pip 指引」之间做产品决策（见 SPEC §13 门禁 10、§15.12）。
