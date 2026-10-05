# 小胰宝 · 病案整理（B-2）设计与边界

**文档版本：v1.1**
**对应实现：`xyb.records` 0.3.0（新增 `lib/organize.js`）**
**上游来源：`opencare-skillhub/Medical-Record-Organizer`（上游名 `patient-record-organizer`，未声明 LICENSE）**
**关联文档：`XYB-TRIAL-UNIFIED-QUERY.md`、`XYB-AUDIT-F5-LICENSE-RISK.md`、`XYB-SKILLHUB.md`**
**状态：B-2.1 已实现；B-2.2 / B-2.3 未实施**

---

## 1. 目标

把上游「病案整理」方法论中**可以确定性执行**的部分，落到小胰宝客户端本机，使患者在没有云密钥、没有外接脚本、不联网的前提下，也能把散落的资料整理成可追溯的病案索引。

具体交付：

| 能力 | 落地形态 |
|---|---|
| 资料分类 | 7 类规则分类（基于文件名 + 正文关键词） |
| 时间线 | 从正文抽取日期，去重后按时间升序排列 |
| 信息缺口提示 | 指出缺哪一类资料，并明确「只是资料里没看到」 |
| 未解析清单 | 如实列出未能解析的文件及原因 |
| 索引落盘 | 生成 Markdown 索引，**用户在界面上确认后**才写入资料库 |

## 2. 非目标（明确不做）

1. **不诊断、不解读、不给治疗建议**。整理只做「归档与索引」，不产生医学结论。
2. **不解析 PDF / Word / 图片 / DICOM / 表格正文**。当前版本只解析 `.txt` / `.md`；其余按扩展名归类并计入「未解析」。
3. **不做 OCR、不做语音转写**。上游依赖 MinerU / SiliconFlow / DashScope 云服务，客户端不引入这些依赖（见 R-B2-03）。
4. **不调用任何模型**。B-2.1 全程无网络请求、无 `agent.complete`、不消耗用户额度。
5. **不复制原件正文进索引**。索引只含分类、日期与文件名，原件始终以医院出具的为准。
6. **不内联上游代码**。仅沿用其流程命名与分类名称，实现为独立重写（见第 5 节）。
7. **不做增量更新**。当前每次整理重新生成完整索引。

## 3. 架构（ADR-B2-01）

### 决策：在 `xyb.records` 内新增纯函数库 `lib/organize.js`，而非复制技能或内联上游

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. 只保留上游技能（现状）** | 由助手按 `xyb.skillpack/skills/record-organizer.md` 用对话完成整理 | 否决：结果不确定、依赖模型、消耗额度，且无法在无模型时使用 |
| **B. 在 `xyb.records` 新增纯函数库（采纳）** | 确定性本机整理，助手与界面共用同一实现 | **采纳** |
| **C. 内联上游代码** | 直接搬运上游脚本 | 否决：上游未声明 LICENSE，内联会放大许可风险（R-B2-01） |

**理由**：方案 B 与 F2 的 `unified.js` 保持同一模式——把可确定的部分做成纯函数，网络/模型部分留给上层编排。这样整理结果可测试、可复现、离线可用，且不扩大许可暴露面。

**可逆性**：高。`lib/organize.js` 是独立纯函数模块，`main.js` 中只通过 `runOrganize()` / `saveArchive()` 接入；回滚只需删除该模块与两处接入点（见第 7 节）。

**后果**：档案是「索引」而非「正文集合」——患者仍需要打开原件。这是刻意的隐私换取。

## 4. 接口

### 4.1 `lib/organize.js` 导出

```js
CATEGORIES          // ["基本信息","检验指标","影像检查","病理报告","用药方案","诊疗记录","其他资料"]
CATEGORY_LABELS     // 分类 → 子类型名称列表
CATEGORY_RULES      // 有序 [{category, pattern}]，顺序即优先级
TEXT_EXT            // [".txt", ".md"]
KNOWN_BINARY_EXT    // 已知但当前不解析的扩展名
EXTRACTION_STATUS   // 状态枚举 → 中文说明

extOf(name)
isParseable(name)
categorize(name, contentHint)
extractDates(text)
makeRecord({sourceName, category, text, extractionStatus, dates, truncated, readError})
buildRecords(files, {read, maxFileChars})   // → {records, readErrors}
buildTimeline(records)
findGaps(records)
summarizeCategories(records)
buildArchive(records)
renderMarkdown(archive, {title})
```

分类规则顺序（先匹配者胜）：`病理报告` → `影像检查` → `检验指标` → `用药方案` → `基本信息` → `诊疗记录` → `其他资料`。顺序即优先级，例如文件名含「病理」但正文含「CT」时判为病理报告。

日期抽取支持 `2024-03-15`、`2024年3月15日`、`2023/12/31`、`2023.06.07`；月份 > 12、日期 > 31、年份不在 1900–2999 范围的不计入，避免把编号误判为日期。

### 4.2 `main.js` 接入

| 接入点 | 行为 |
|---|---|
| `runOrganize()` | 校验 `vaultDir` → **`pi.fs.requestDirectory()` 再次取权** → `collectFiles()` → `buildRecords()`（注入 `redact()`）→ `buildArchive()` → `renderMarkdown()` → 返回预览 |
| `saveArchive(payload)` | 空内容 → `EMPTY_TEXT`；否则写 `小胰宝-病案整理-<时间戳>.md` |
| 命令 `xyb.records.organize` | 「小胰宝：整理病案」 |
| 面板通道 `xyb.records.organize` | 视图按钮触发整理 |
| 面板通道 `xyb.records.organize.save` | 视图按钮确认保存 |

失败返回结构化 `reason`：`NO_VAULT` / `CANCELLED` / `EMPTY_VAULT` / `EMPTY_TEXT`。**B-2.1 不产生 `NO_MODEL` 或 `MODEL_ERROR`**，因为它不调用模型。

### 4.3 授权模型

与 F1 摘要一致：`vaultDir` 设置项**只是提示**，不是持续授权。`runOrganize()` 每次都重新调用 `pi.fs.requestDirectory()`，由用户本次亲自选择目录；取消则返回 `CANCELLED` 且不读取任何文件。这依赖 `manifest.fs.root = "userSelected"` 的作用域约束——插件拿不到用户本次未授权的路径。

## 5. 许可与来源边界

- 上游 `Medical-Record-Organizer` **未声明 LICENSE**（详见 `XYB-SKILLHUB.md:56,60,217-218` 与 `XYB-AUDIT-F5-LICENSE-RISK.md`）。
- 本实现**未复制上游任何代码或文本**，属独立重写；沿用的只有流程步骤命名与分类名称（事实性内容）。
- 当前仓库为 PRIVATE，暂不构成分发；一旦公开分发或对外交付，仍需先解决上游许可（R-B2-01）。
- 本文件**不构成合规声明**。

## 6. 验证证据

| 验证项 | 命令 | 结果 |
|---|---|---|
| 整理单元测试 | `cd apps/desktop && node --test test/xyb-records-organize.test.mjs` | **14 pass / 0 fail** |
| 摘要与脱敏回归 | `cd apps/desktop && node --test test/xyb-records-summary.test.mjs` | **12 pass / 0 fail** |
| 桌面端全量 | `cd apps/desktop && node --test test/*.test.mjs` | **3220 pass / 0 fail** |
| 插件契约 | `node scripts/xyb-check-plugin-contract.mjs` | ✓ 6 个插件通过（`xyb.records` 命令 3 个） |
| 插件清单 | `node scripts/xyb-check-plugins.mjs` | 6/6 通过 |
| 插件 API 面 | `node scripts/xyb-check-plugin-api.mjs` | 13 个 API 全部仍在 SDK 中声明 |
| 构建 / 静态检查 | `pnpm build:js`、`pnpm lint`、`pnpm --filter @pi-desktop/desktop typecheck`、`node scripts/check-architecture.mjs` | 全部 exit 0 |
| UI 完整性 | 静态核对 `records.html` 的 id 引用与 `bridge.invoke` 通道 | 9 个 id 全部解析；5 个通道均已在 `main.js:474-480` 注册 |
| 真实病历端到端 | 4 份真实 OCR 文本（基本病情 / 肿标 / CT / 病理）走 `runOrganize` + `runSummary` | 分类 1/1/1/1 正确；模型调用 0 次；送模型文本无姓名/手机/身份证/医院名 |

测试覆盖：分类优先级、日期抽取（含非法月/日/年拒绝）、已解析/未解析/读取失败/空文件的状态区分、缺口措辞（必须说明「资料中未见」且带免责声明）、输出不含绝对路径、时间线排序、归档汇总、`NO_VAULT` / `CANCELLED` 不读文件、`runOrganize` **零模型调用**、原始 PII 不落库、`saveArchive` 空内容不写盘与文件命名。

## 7. 风险与回滚

| 编号 | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R-B2-01 | 上游未声明 LICENSE | 公开分发时存在授权瑕疵 | 独立重写、不内联；分发前先补许可（`XYB-SKILLHUB.md:217-218`） |
| R-B2-02 | 规则分类可能误判 | 患者看到错误归类 | 索引仅作草稿，界面提示「以原件为准」；分类规则集中在 `CATEGORY_RULES` 可快速调整 |
| R-B2-03 | 未解析（PDF/图片占比高时档案价值低） | 患者以为已读全部资料 | 界面与档案**均列出**未解析清单及原因，不宣称「已整理全部内容」 |
| R-B2-04 | 表格/数字解析缺失 | 指标无法做趋势 | 明示不在 MVP，列入后续 `markers-trend` |
| R-B2-05 | 时间线日期可能来自文件名以外的正文误抽 | 时间线失真 | 已限制日期格式合法性；缺口提示要求核对原件 |
| R-B2-06 | 分类曾被正文关键词覆盖文件名（真实场景已复现：`01-基本病情报告.md` 因正文含「病理结果」被归为病理报告，连带 15 条时间线标错） | 患者看到错误归类 | **已修复**：`categorize()` 改为文件名优先；新增 2 条回归测试（v1.1） |
| R-B2-07 | 规则脱敏覆盖不到无标记的自由人名 | 真实姓名可能随摘要外发 | **已加固**：新增显式姓名字段规则（`姓名：X` / `患者姓名：X` / `患者：X`）并加停用词表防误伤；仍**不宣称**完全去标识（v1.1） |

**回滚步骤**（任一步单独即可回退，互不影响）：

1. 删除 `apps/desktop/resources/plugins/xyb.records/lib/organize.js`
2. `main.js`：删除 `require("./lib/organize.js")`、`runOrganize()`、`saveArchive()`，以及 `onLoad` 中的 `xyb.records.organize` 命令注册、`onUnload` 中的注销、`onPanelInvoke` 中的两个 channel 分支、`_internals` 中的对应条目
3. `manifest.json`：版本改回 `0.2.0`，删除 `xyb.records.organize` 命令与对应 `activationEvents` 项
4. `views/records.html`：删除「整理病案」按钮、`#organize-status` / `#organize-result` 区块及整理相关脚本
5. 删除 `apps/desktop/test/xyb-records-organize.test.mjs`

回滚后 `xyb.records` 回到 F1 完成态（导入 + 摘要），无残留引用。

## 8. 已知限制

1. 仅解析 `.txt` / `.md`；PDF、Word、图片、DICOM、表格只按文件名归类。
2. 每次整理全量重建，无增量更新。
3. 分类依赖**文件名优先**的关键词匹配，非语义理解，仍可能误判（如 `IMG_2031.pdf` 这类无信息文件名只能落兜底类目）。
4. 时间线只包含正文中出现的合法日期，缺日期资料不进入时间线。
5. 整理依赖用户在面板上本次亲自选目录；`vaultDir` 设置本身不构成访问授权。
6. 交接给助手的路径仍是方法论技能（`xyb.skillpack/skills/record-organizer.md`），整理结果不会自动推送给助手。
7. 脱敏是**规则式**而非实体识别：显式字段（`姓名：`/`患者姓名：`/`患者：`）与固定格式已覆盖，但正文里无任何标记的自由人名、地址、病历号、邮箱仍可能漏过。界面与 README 只能表述为「已按规则隐藏常见标识」。

## 9. 后续（未实施）

- **B-2.2**：OCR / PDF 文本层 MCP 适配器（须先解决 R-B2-01 与云密钥问题）
- **B-2.3**：远程解析服务（隐私边界需重新评估）
- 指标趋势图 `markers-trend`
- 增量更新已有档案

## 10. 变更记录

| 版本 | 变更 |
|---|---|
| v1.0 | 首次发布。B-2.1 实现 `lib/organize.js`、`runOrganize()` / `saveArchive()`、命令与面板通道、`records.html` 整理 UI、`xyb-records-organize.test.mjs`（12 pass）；`xyb.records` 0.2.0 → 0.3.0；更新 `xyb.skillpack` readiness。 |
| v1.1 | 场景测试（4 份真实病历）暴露并修复两处缺陷：①`categorize()` 改为**文件名优先于正文关键词**，修正 `01-基本病情报告.md` 被误归为病理报告及其 15 条时间线；②`redact()` 新增显式姓名字段规则并加停用词表防误伤。另修复既有规则顺序缺陷：身份证规则移到手机号规则**之前**，避免 18 位证件号被打成 `320583[电话]4`。新增回归测试 4 条（organize 14 pass、summary 12 pass）。 |
