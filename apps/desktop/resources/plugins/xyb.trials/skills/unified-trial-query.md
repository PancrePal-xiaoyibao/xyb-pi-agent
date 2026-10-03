---
name: 四来源统一试验检索
description: 当用户想要"一条关键词查遍国内外临床试验""CT、ChiCTR、Veeva、中国药物登记平台一起查""统一给我国内外{关键词}的试验清单"时使用。按固定契约逐渠道取数并统一整理，逐渠道如实标注状态，绝不把"没查到"和"没跑"混为一谈。不给入组建议。
---

# 四来源统一试验检索

一次查询覆盖四个渠道，输出**统一清单 + 逐渠道状态**。
设计契约见仓库根目录 `XYB-TRIAL-UNIFIED-QUERY.md`（v1.0）——本技能是它的执行侧。

## 一、四个渠道与取数工具

| 渠道键 | 来源 | 工具 | 未就绪时的状态 |
|---|---|---|---|
| `clinicaltrials_gov` | ClinicalTrials.gov | `xyb_trials_search` | 网络失败 → `FAILED` |
| `chictr` | ChiCTR | MCP：`chictr` 的 `search_trials` | 缺依赖 → `NEEDS_SETUP`；反爬 → `CHALLENGE_REQUIRED` |
| `veeva_ctv` | Veeva CTV | MCP：`ctv` 的 `search_studies` | 无索引 → `INDEX_EMPTY` |
| `chinadrugtrials` | 药物临床试验登记与信息公示平台 | MCP：`chinadrugtrials` 的 `get_collector_status` → `search_trials` | 未就绪 → `NEEDS_SETUP`；会话失效 → `SESSION_EXPIRED` |

本插件提供的工具是**按需激活**的：先 `ToolSearch` 查一次工具名（如 `xyb_trials_search`、`xyb_trials_unify`），
返回 "Activated on-demand tools" 后**下一轮**才能调用。直接调用会得到 `Tool plugin_... not found`。

## 二、执行顺序（严格照做）

1. **先激活**：`ToolSearch` 找到本插件的两个工具，以及已启用来源插件的 MCP 工具。
2. **渠道 1（ClinicalTrials.gov）**：调 `xyb_trials_search`（`condition` 用英文更准，`terms` 可中文）。
3. **渠道 2（ChiCTR）**：调 ChiCTR MCP 的 `search_trials`，**中英文各查一次**（见下方「语言策略」）。
4. **渠道 3（Veeva CTV）**：调 Veeva CTV MCP 的 `search_studies`（需要中国结果时加 `country: "China"`）。
5. **渠道 4（药物临床试验登记平台）**：**先**调 `chinadrugtrials` 的 `get_collector_status` 看是否就绪；
   就绪才调 `search_trials`；未就绪就按状态如实记录，**不要**为了"跑通"去调
   `setup_environment` 或 `update_cookie`——查询不得升级成安装或凭据写入。

### 语言策略（不要只发一次原文）

不同登记库的语言覆盖不同，**同一个词在不同库里命中率差别很大**，所以关键词要按库调整，
并且**中文库必须中英文各试一次**再下结论：

| 渠道 | 主用语言 | 做法 |
|---|---|---|
| ChiCTR | 中文 | **先中文（如「胰腺癌」「免疫治疗」）→ 再英文（如 `KRAS`、`B7-H3`、`pancreatic`）**，两次结果合并去重 |
| Veeva CTV | 英文 | 用英文药名/靶点；同义词各试一次（`B7-H3` 与 `B7H3`） |
| ClinicalTrials.gov | 英文 | `condition` 英文、`terms` 可中英混用 |
| 药物临床试验登记平台 | 中文 | 中文关键词 |

实测依据（2026-10-03 真机）：

- ChiCTR：`胰腺癌` → 5 条；`KRAS` → 10 条；`B7-H3` → 1 条；`pancreatic` → 10 条；`YL201` → 0 条。
  **说明 ChiCTR 支持英文**，`YL201` 为 0 是**该库确实未登记该药名**，属 `NO_RESULTS`，**不是**语言问题、
  更不能记成 `UNAVAILABLE`。
- Veeva CTV 本地索引：`YL201` → 8 条；`B7-H3` → 2 条；`B7H3` → 0 条。
  **说明同义词写法会影响命中**，`B7H3` 与 `B7-H3` 必须都试。

**只跑了一种语言就写 `NO_RESULTS` 属错误汇报**：必须把中英文两次都跑完仍无结果，才能记
`NO_RESULTS`，并在 `explanation` 里说明已试过的词（例如「已试『胰腺癌』『pancreatic』均无匹配」）。

6. **统一整理**：把各渠道的原始结果交给 `xyb_trials_unify`：

```json
{
  "keywords": "<本次关键词>",
  "condition": "<病种>",
  "sourceResults": {
    "clinicaltrials_gov": { "state": "SUCCESS", "records": [ ... ] },
    "chictr":             { "state": "SUCCESS", "records": [ ... ] },
    "veeva_ctv":          { "state": "SUCCESS", "records": [ ... ] },
    "chinadrugtrials":    { "state": "SESSION_EXPIRED", "explanation": "会话已失效，请在浏览器重新复制 cURL 后调用 update_cookie" }
  }
}
```

**状态必须来自本次实测，不得照抄示例**：上面的 `explanation` 只是格式示范。
例如 `chictr` 在本机 `npx -y chictr-mcp-server@2.0.2` 已实测可启动，只有在真的因网络/依赖
失败时才能记 `NEEDS_SETUP`，不能因为示例里这么写就沿用。

**没跑的渠道不要省略、也不要用空数组**：明确填 `NOT_ENABLED` 并写清原因。
把某个渠道塞成 `{"state":"SUCCESS","records":[]}` 会被理解成"该来源查过且没有结果"，属错误汇报。

## 三、状态语义（不得混用）

- `SUCCESS` / `NO_RESULTS`：**该来源真的执行过**；`NO_RESULTS` 是"查了，没有匹配"。
- `NOT_ENABLED`：用户没启用，或本次没查这一处。
- `NEEDS_SETUP`：缺依赖 / 未初始化。
- `INDEX_EMPTY`：Veeva CTV 本地索引为空。
- `SESSION_EXPIRED` / `CHALLENGE_REQUIRED`：会话失效 / 需要人工验证。
- `TIMEOUT` / `FAILED`：超时 / 其它失败。

一个渠道任何状态都**不影响**其余渠道返回结果。禁止写成"四个来源都没有结果"。

## 四、去重与合并（很保守）

`xyb_trials_unify` 只在下列情况自动合并：规范化登记号完全相同、来源显式交叉引用、可审计的官方映射。

**不会**因为标题、药物、地点、申办方、疾病相似而合并。标题相同但都没有登记号的，会保留两条并给
「可能相关、未自动合并」提示——**不要**自行替它们下结论。

合并后的条目保留全部来源、全部登记号、全部原始链接；有冲突时逐来源列出原始取值，
呈现时**不得掩盖差异**（例如 CT.gov 写 `Recruiting`、ChiCTR 写「招募中」，两者都照抄）。

## 五、输出结构

```
一、本次查询（关键词 / 病种 / 时间）
二、渠道状态表（四行：渠道、状态、结果数、原因）
三、候选试验清单（按返回顺序；每条含登记号、标题、状态、分期、地点、来源链接）
四、可能相关但未自动合并（如有）
五、与医生讨论的问题清单
```

硬性规则：

- 开头写：**以下为公开试验信息整理，供参考，不构成医疗建议；是否符合入组条件需由研究医生判断。**
- **禁止**「建议你参加」「这项最适合你」这类结论。
- 注册号、状态、分期**照抄**来源；缺失写「来源未公布」。
- 渠道状态未覆盖处，明确说「这一处本次没查到」，不要让用户以为已全覆盖。
- 不接触、不推测用户没提供的信息；不复述任何会话凭据。
- 结果是**浏览线索**，不是入组资格判断。
