# 外部技能接入：opencare-skillhub 评估与接入设计

面向小胰宝客户端（患者向）。本文记录**这个组织里有什么、哪些能接、怎么接**。

状态：2026-09-30 完成侦察与许可核查；第一批已实现（见第七节）。
数据来源：`gh api` 逐仓库读取（许可证、文件树、SKILL.md 正文），非依据仓库简介。

---

## 一、先说清楚「37 个」是什么

组织下 **38 个仓库**（含 `.github`），所以「37 个」指的是**仓库数**，不是技能数。

但**一个仓库不等于一个技能**：

| 仓库 | 技能数 | 性质 |
|---|---|---|
| `OpenClaw-Medical-Skills` | **897** | 聚合库 |
| `Claude_skill_pool` | **178** | 技能池 |
| `SenseNova-Skills` | **76** | office 技能池 |
| `openclaw_skills_pool` | 36 | 技能池（含命理/风水等） |
| `feishu-lark-cli-message-process-skills` | 6 | 飞书（**已排除**） |
| `awesome_research_writter_xiaoyibao` | 5 | 研究写作 |
| 其余 31 个仓库 | 各 1 | 单技能 |

全组织 `SKILL.md` 合计 **1230 个**。所以「接入 37 个技能」与「接入 37 个仓库」
在实际体量上差两个数量级——本文按**仓库**为单位评估。

---

## 二、依赖画像（实测扫描 32 个单技能仓库）

对每个技能正文做了特征扫描：

| 特征 | 命中 | 含义 |
|---|---|---|
| 依赖脚本 | **26 / 32** | 正文里要跑 `.py` / `.js` / `scripts/` |
| 依赖密钥 | **21 / 32** | `.env` / `api_key` / `token` / `cookie` |
| 引用 MCP | 6 / 32 | 需要特定 MCP 服务在位 |
| 公网发布 | 3 / 32 | EdgeOne 等，会把数据推到公网 |
| 危险模式 | **0 / 32** | `rm -rf` / `curl \| bash` / `eval(` / `sudo` 全部无命中 |

**结论**：安全基线不差（没有明显的破坏性命令），但**三分之二依赖脚本或密钥**——
这意味着它们**不能原样搬进客户端**。插件的技能只是提示层，没有 shell 权限；
技能正文里写「执行 python scripts/ingest.py」，在小胰宝里是**一句空话**。

---

## 三、许可矩阵（硬约束）

| 许可 | 仓库 |
|---|---|
| Apache-2.0 | `chictr-trials-collector`、`clinicaltrials-intel-skill`、`clinicaltrials-query-analysis`、`inkstone-studio`、`nccn-guideline-downloader`、`RAG-content-processor`、`xyb_dicom_download_skills`、`xyb-wechat-article-transcription`、`agent-math-seed-system`、`Claude_skill_pool` |
| MIT / MIT-0 | `awesome_research_writter_xiaoyibao`、`codex-tokens-compress`、`getnote-openclaw`、`lark-todo-skill`、`SenseNova-Skills`、`sol-advisor`、`aura_health_profile` |
| **AGPL-3.0** | `graphify-xiaoyibao`、`openclaw-backup-restore-ops`、`wechat-article-downloader` |
| **无 LICENSE** | 其余 **18 个**，含最重要的患者向候选 |

### 两个必须处理的问题

**1）18 个仓库没有 LICENSE**，按默认即「保留所有权利」，严格讲不满足再分发的明确授权。
其中包括患者向权重最高的三个：

- `Medical-Record-Organizer`（病案整理）
- `clinical-trial-matching`（试验匹配）
- `skill-HADS-accessment`（心理量表）

这些都在你自己的组织下（`opencare-skillhub`），所以实际操作上你是权利人，
但**对外分发时说不清楚**。建议按统一许可补齐（同组织已有 Apache-2.0 与 MIT 先例）。

**2）AGPL-3.0 是强 copyleft**。`wechat-article-downloader` 已排除（另一条理由见下），
`graphify-xiaoyibao` 是患者向的（肿瘤标志物趋势），**已决定接入**（见第八节）。
AGPL 的传染性意味着：**分发含它的客户端，整体要按 AGPL 开源**。
仓库当前是 PRIVATE，暂不构成分发；一旦转公开就必须处理——
这条不能只写在文档里，要落到发布流程。

另：`wechat-article-downloader` 的 README 自己写明是
`qiye45/wechatDownload` 的**下游项目**，并要求「访问原创项目获得完整能力」——
属于二次分发的第三方作品，不接。

---

## 四、分类结论

### A. 接入（患者向）

| 仓库 | 能力 | 依赖 | 处理 |
|---|---|---|---|
| `clinical-trial-matching` | 癌症试验匹配（CT.gov + ChiCTR 双源、入排分析） | 纯提示 | **原样可用**，与本项目 chictr / chinadrugtrials MCP 直接衔接 |
| `clinicaltrials-query-analysis` | 靶点专题检索与报告流水线 | 脚本 | 方法论层可用，脚本层标注前置 |
| `graphify-xiaoyibao` | 肿瘤标志物趋势（CA19-9/CEA/AFP/CA50/CA72-4/CA125） | 上游需 `xyb` CLI | **已接入**（方法论层）；AGPL-3.0，许可影响单独标注 |
| `Medical-Record-Organizer` | 病案整理（影像/PDF/录音分类归档） | 脚本 + OCR | 方法论层 + 标注前置 |
| `skills_report_genie` | 医疗文件扫描分类去重、生成报告 | 脚本 | 与上者重叠，合并处理 |
| `aura_health_profile` | 化验单→健康档案→复诊简报 | 阿里云百炼 | 需配置云端密钥，默认不可用 |
| `skill-HADS-accessment` | HADS 焦虑抑郁量表 | 脚本 + EdgeOne | ⚠️ 要发布问卷到公网 |
| `xyb_dicom_download_skills` | DICOM 影像下载 | 各院内站点脚本 | 方法论层 + 标注前置 |
| `nccn-guideline-downloader` | NCCN 指南下载 | cookie | ⚠️ NCCN 有版权，且需登录态 |
| `pdf-translate` | 英文 PDF → 中文 | pdf2zh | 方法论层 + 标注前置 |

### B. 接入（运营/内容侧）

按你的要求一起进客户端，不做隔离：`xyb-wechat-article-generator`、`xyb-humanizer`、
`xyb-whitepaper-writer`、`xyb-wechat-article-transcription`、`pancrepal-wechat-news-board`、
`pancreatic-cancer-dailynews-skill`、`clinicaltrials-intel-skill`、`RAG-content-processor`、
`inkstone-studio`、`awesome_research_writter_xiaoyibao`。

> 这批**无一例外**都依赖脚本、密钥或推送通道（TG / 微信 / 飞书 / FastGPT）。
> 进客户端后能生效的是**方法论与写作规范**，实际抓取与推送仍要本机环境。

### C. 不接：开发基建（与患者端功能无关）

`agent-math-seed-system`、`agent-taste-seed-system`、`sol-advisor`、`codex-tokens-compress`、
`SenseNova-Skills`、`Claude_skill_pool`、`OpenClaw-Medical-Skills`、`openclaw_skills_pool`、
`openclaw-backup-restore-ops`、`getnote-openclaw`、`llm-wiki-pancrepal`。

理由：数学/美学大脑、Codex 编排、token 压缩、技能池、OpenClaw 运维——
这些是「养 agent 的工具」，不是患者能用的能力。技能池那几个体量也根本不现实（897 / 178 / 76 / 36）。

### D. 不接：已完成或重复

| 仓库 | 原因 |
|---|---|
| `chictr-trials-collector` | 已由 `xyb.trial-sources` 的 chictr MCP 承担 |
| `chinadrugtrials-collector` | 本轮已接入（`xyb.trial-sources` 自带采集器 + MCP） |
| `chinadurgtrials` | 同上，且与上游同源 |

### E. 不接：按你的要求排除

`feishu-lark-cli-message-process-skills`、`lark-todo-skill`（lark 类）。

---

## 五、承载方式

**新建插件 `xyb.skillpack`**（外部技能包），与现有插件分工：

| 插件 | 管什么 |
|---|---|
| `xyb.assistants` | 小胰宝**自研**的 9 个患者助手技能 |
| `xyb.trials` / `xyb.trial-sources` / `xyb.records` / `xyb.news` | 数据源与视图 |
| **`xyb.skillpack`** | **外部接入**的技能，逐个标注来源、许可、可用度 |

为什么单独成包而不是并进 `xyb.assistants`：

1. **来源可溯**：每个技能头部写明上游仓库、许可、适配方式，便于日后同步上游更新
2. **可整包停用**：这批是外部内容，患者若不需要，关掉一个插件即可，不影响自研能力
3. **不污染自研技能**：`xyb.assistants` 的红线（不做排名、不给入组建议、机制未披露就写未披露）
   由自研技能统一约束；外部技能的质量参差，混在一起会稀释约束

### 技能文档的固定头

每个适配后的技能都带一段来源说明（不藏在正文里）：

```yaml
---
name: <技能名>
description: <触发条件，精炼>
source_repo: opencare-skillhub/<repo>
source_license: Apache-2.0
adapted: 2026-09-30
readiness: 可用 | 方法论层（需本机工具） | 需配置密钥
---
```

`readiness` 是关键：**如实标注这个技能在小胰宝里能到什么程度**，
不让患者以为「技能在列表里 = 功能已就绪」。这与 `xyb.trial-sources` 面板里
给每个来源标 `need` / `limit` 是同一套做法。

### 依赖脚本怎么处理

插件没有 shell 权限，所以正文里「执行 `scripts/xxx.py`」这类指令**必须改写**，三选一：

1. **转成方法论**：把脚本要做的判断写成步骤，让助手用对话完成（适合整理/分析类）
2. **指向已有 MCP**：若本项目已有等价工具（如试验检索），改写成调用那个工具
3. **明确降级**：写「需要本机具备 X 工具；未安装时只做方法引导，不假装能跑」

绝不保留「照着跑脚本」的原文——那是给患者一个用不了的承诺。

---

## 六、分批计划

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | `clinical-trial-matching`、`Medical-Record-Organizer`、`skill-HADS-accessment`、`graphify-xiaoyibao` | **已实现**（见第七节） |
| 2 | `pdf-translate`、`xyb_dicom_download_skills`、`clinicaltrials-query-analysis`、`skills_report_genie` | 待定 |
| — | 运营/内容侧 10 个 | **不接入**（已决定，见第八节） |
| — | `aura_health_profile`（依赖阿里云百炼密钥） | 待定 |

---

## 七、第一批实现

见 `apps/desktop/resources/plugins/xyb.skillpack/`。逐个技能的适配说明写在
该插件 README 的表格里（上游仓库 / 许可 / readiness / 改写了什么）。

已接入 4 个：`trial-matching-advanced`（试验匹配）、`record-organizer`（病案整理）、
`distress-screening`（焦虑抑郁量表）、`tumor-marker-trend`（肿瘤标志物趋势）。

一个共同的处理原则：**上游正文里「执行 `scripts/xxx.py`」这类指令一律改写**。
插件技能只是提示层，没有 shell 权限；照抄进去等于给患者一个用不了的承诺。
三条出路——转方法论 / 指向本项目已有工具 / 明确标注降级。

---

## 八、决定记录

2026-09-30 由项目负责人确认：

| 事项 | 决定 |
|---|---|
| 运营/内容侧 10 个（公众号、去 AI 腔、白皮书、RAG、试验情报推送） | **暂不接入** |
| `graphify-xiaoyibao`（AGPL-3.0） | **接入**，许可影响在该技能里单独标注 |
| 把问卷发布到公网（`skill-HADS-accessment`） | **不发公网**，保持本机版 |

### 仍需处理

1. **给无 LICENSE 的仓库补许可**（尤其 `Medical-Record-Organizer`、`clinical-trial-matching`、
   `skill-HADS-accessment`）。在小胰宝转公开前必须办。
2. **AGPL-3.0 的分发策略**：`graphify-xiaoyibao` 已接入。仓库当前是 PRIVATE，
   暂不构成分发；一旦转公开、或对外分发含此技能的产物，整体需按 AGPL 处理。
   这一条要落到发布流程里，不能只写在文档。
3. **`nccn-guideline-downloader` 的版权**：NCCN 指南不是公开可自由分发的资料。
4. **剩余患者向候选是否继续接**：`pdf-translate`、`xyb_dicom_download_skills`、
   `aura_health_profile`（需云端密钥）、`skills_report_genie`（与病案整理重叠）。

