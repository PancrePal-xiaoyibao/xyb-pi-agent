---
name: 五来源统一试验检索
description: 需要查询任何临床试验相关的信息时使用——包括「找临床试验」「有没有适合我的试验」「按渠道汇总{关键词}的数量」「各渠道查到多少条」「IBI343 有多少个试验」「CT/ChiCTR/Veeva/中国药物登记平台/WHO ICTRP分别有多少」「某个药或靶点有哪些试验」。按固定契约逐渠道取数并统一整理，逐渠道如实标注状态，绝不把"没查到"和"没跑"混为一谈。不给入组建议。
---

# 五来源统一试验检索

一次查询覆盖五个渠道，输出**统一清单 + 逐渠道状态**。

## 零、取数优先级（先读这一节）

**查临床试验只能走本技能列出的渠道工具，不要用浏览器或网页抓取工具去打开登记站点。**

真实教训（2026-10-03）：用户问「按渠道汇总 IBI343 的数量」，助手没有加载本技能，
而是拿通用工具去抓 `clinicaltrials.gov/search?term=IBI343`、`chictr.org.cn/search`、
`chinadrugtrials.org.cn/search.html` 三个页面，**三次全部失败**——这些站点是 JS 渲染的，
直接抓页面拿不到结果；而同一次会话里，通过渠道工具调用**三个渠道全部成功**。

因此按以下优先级取数：

| 优先级 | 工具 | 何时用 |
|---|---|---|
| 1 | 本技能的渠道工具（`xyb_trials_search`、`chictr`/`veeva-ctv`/`chinadrugtrials` 的 MCP 工具） | **永远先试这个** |
| 2 | 浏览器 / 网页抓取（`Browser`、playwright、内置「获取」等） | **仅当**上表某个渠道返回 `FAILED`，且你需要核对那一条**具体登记号**的详情页时，才去打开**该登记号的详情 URL**（如 `https://clinicaltrials.gov/study/NCT05458219`）。不要去抓检索页 |

补充规则：

- **不要用浏览器重做渠道工具的活**。渠道工具失败时，先如实报失败状态；浏览器只用于补看
  **已知登记号**的详情页，不用于「换个方式再搜一遍」。
- **不要抓检索列表页**（`/search?...`、`?keyword=...` 这类）。这些页面靠 JS 渲染，
  抓取结果为空或超时，会让本来可用的渠道看起来像坏了。
- 若确实需要浏览器兜底，**必须先说明为什么渠道工具不可用**，再给出你打开的具体 URL 与看到的内容。
- 渠道工具提示「按需激活」时，用 `ToolSearch` 查工具名（如 `clinicaltrials`、`chictr`、
  `veeva`、`chinadrugtrials`），下一轮再调用；**不要因为第一轮找不到工具就转去抓网页**。

**登记号详情页**是可以直接打开的白名单场景（有具体 NCT/CTR/ChiCTR 号时）：

| 平台 | 详情页形态 |
|---|---|
| ClinicalTrials.gov | `https://clinicaltrials.gov/study/{NCT}` |
| 中国药物临床试验登记平台 | 用渠道 4 的 `get_trial_detail`，**不要**抓网页 |
| ChiCTR | 用渠道 2 的 `get_trial_detail`，**不要**抓网页 |

设计契约见仓库根目录 `XYB-TRIAL-UNIFIED-QUERY.md`（v1.0）——本技能是它的执行侧。

## 一、五个渠道与取数工具

| 渠道键 | 来源 | 工具 | 未就绪时的状态 |
|---|---|---|---|
| `clinicaltrials_gov` | ClinicalTrials.gov | `xyb_trials_search` | 网络失败 → `FAILED` |
| `chictr` | ChiCTR | MCP：`chictr` 的 `search_trials` | 缺依赖 → `NEEDS_SETUP`；反爬 → `CHALLENGE_REQUIRED` |
| `veeva_ctv` | Veeva CTV | MCP：`ctv` 的 `search_studies` | 无索引 → `INDEX_EMPTY` |
| `chinadrugtrials` | 药物临床试验登记与信息公示平台 | MCP：`chinadrugtrials` 的 `get_collector_status` → `search_trials` | 未就绪 → `NEEDS_SETUP`；会话失效 → `SESSION_EXPIRED` |
| `who_ictrp` | WHO ICTRP（聚合库） | MCP：`ictrp` 的 `ictrp_search` | 缺 Python/依赖 → `NEEDS_SETUP`；上游不完整 → `SUCCESS` 但**条数是下界** |

本插件提供的工具是**按需激活**的：先 `ToolSearch` 查一次工具名（如 `xyb_trials_search`、`xyb_trials_unify`），
返回 "Activated on-demand tools" 后**下一轮**才能调用。直接调用会得到 `Tool plugin_... not found`。

### 渠道 5 的四个特例（WHO ICTRP，必须照做）

**① 它的条数永远是下界，不得当总数。** ICTRP 的 CSV 导出通道**已实测会静默漏掉它自己
声称匹配的记录**（原因未明，已排除重复记录、固定行上限、分页限制）：

| 检索词 | 门户自报 | 导出实得 | 缺失 |
|---|---|---|---|
| `ChiCTR` | 14197 | 14147 | 0.4% |
| `pancreatic` | 10354 | 9273 | 10.4% |
| `pancreatic cancer` | 6952 | 6262 | 9.9% |
| `KRAS` | 1243 | 882 | **29.0%** |

按 `KRAS` 逐页抓 HTML 得 108 个不同登记号，其中 8 个**不在** CSV 里。
因此：

- 该来源**不存在**「匹配总数」这个数字；只有两个独立数字——**实得行数**
  （返回体的 `matched_rows_returned`，**不是** `rows_returned`）与**上游自报数**
  （`upstream_reported_total`）。两者**禁止合并**，也禁止只报一个。
- 返回体带 `records_incomplete` 与 `incompleteness_notice`，**必须原样呈现给用户**。
- **绝不能说「某试验不存在」，只因 ICTRP 没返回它。** 正确说法是「本次导出未包含，
  不构成不存在的证据」。
- 该来源失败时**永不返回 0 条**（失败即报错）。所以 0 条若出现，是 `NO_RESULTS` 而非失败。

**② 它与 ChiCTR 系统性重叠。** ICTRP 收录 `source_register = "ChiCTR"` 的记录且每周同步，
同一条中国试验会从渠道 2、渠道 5 各进一次。合并后保留 **ChiCTR 直连版**（更实时），
ICTRP 版本必须标注 **「ChiCTR via WHO ICTRP」**——**不得标成「ChiCTR」**。
与 ClinicalTrials.gov 同 NCT 号时保留 CT.gov 版。

**③ WHO 条款必须遵守。** 数据受 WHO ICTRP 使用条款约束：须标注 WHO ICTRP 与 **WHO 处理日期**；
不得暗示实时（ICTRP 每周更新）；不得主张专有权利；**不得使用 WHO 名称或徽标**；
**禁止任何营销、推广或商业用途**。声明与 WHO 无隶属关系。

**④ 它的 7 个工具只有 1 个联网。** `ictrp_search` 检索并把整个结果集**物化**到本机
（返回 `set_id`），其余 6 个（`ictrp_filter` / `ictrp_field_query` / `ictrp_registry_summary` /
`ictrp_find_duplicates` / `ictrp_export` / `ictrp_cache_status`）全部在本地跑、**不重复联网**。
所以**精炼结果不要重新 `ictrp_search`**——拿到 `set_id` 后用 `ictrp_filter` 反复筛。
扇出时只调 `ictrp_search` 一次。

参数形状与别的渠道不同：`ictrp_search` 用 **`keyword`（必填）+ `limit` + `offset`**，
没有独立的 `condition` 维度（病种词并进 `keyword`）。扇出时固定 `limit: 100`、`offset: 0`。

## 二、执行顺序（严格照做）

1. **先激活**：`ToolSearch` 找到本插件的两个工具，以及已启用来源插件的 MCP 工具。
2. **渠道 1（ClinicalTrials.gov）**：调 `xyb_trials_search`（`condition` 用英文更准，`terms` 可中文）。
3. **渠道 2（ChiCTR）**：调 ChiCTR MCP 的 `search_trials`，**中英文各查一次**（见下方「语言策略」）。
4. **渠道 3（Veeva CTV）**：调 Veeva CTV MCP 的 `search_studies`（需要中国结果时加 `country: "China"`）。
5. **渠道 4（药物临床试验登记平台）**：**先**调 `chinadrugtrials` 的 `get_collector_status` 看是否就绪；
   就绪才调 `search_trials`；未就绪就按状态如实记录，**不要**为了"跑通"去调
   `setup_environment` 或 `update_cookie`——查询不得升级成安装或凭据写入。
6. **渠道 5（WHO ICTRP）**：调 `ictrp` 的 `ictrp_search`，`keyword` 传本次关键词、`limit: 100`、
   `offset: 0`。**一次就够**——服务会把整个结果集物化到本机并返回 `set_id`，之后的筛选一律
   用 `ictrp_filter`（本地、免费、不联网）。返回体里的 `matched_rows_returned` 与
   `upstream_reported_total` **两个数都要带下去**，不得只报一个，也不得相加。

### 语言策略（不要只发一次原文）

不同登记库的语言覆盖不同，**同一个词在不同库里命中率差别很大**，所以关键词要按库调整，
并且**中文库必须中英文各试一次**再下结论：

| 渠道 | 主用语言 | 做法 |
|---|---|---|
| ChiCTR | 中文 | **先中文（如「胰腺癌」「免疫治疗」）→ 再英文（如 `KRAS`、`B7-H3`、`pancreatic`）**，两次结果合并去重 |
| Veeva CTV | 英文 | 用英文药名/靶点；同义词各试一次（`B7-H3` 与 `B7H3`） |
| ClinicalTrials.gov | 英文 | `condition` 英文、`terms` 可中英混用 |
| 药物临床试验登记平台 | 中文 | 中文关键词 |
| WHO ICTRP | 英文 | 病种/药物词用英文（聚合库以英文索引为主） |

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
    "chinadrugtrials":    { "state": "SESSION_EXPIRED", "explanation": "会话已失效，请在浏览器重新复制 cURL 后调用 update_cookie" },
    "who_ictrp":          {
      "state": "SUCCESS",
      "records": [ ... ],
      "matchedRowsReturned": 882,
      "upstreamReportedTotal": 1243,
      "upstreamIncomplete": true
    }
  }
}
```

**`who_ictrp` 的三个数字字段必须照实填**（`state` 为 `SUCCESS` 时）：

- `matchedRowsReturned`：本次导出**实得**多少行（来自 `matched_rows_returned`）
- `upstreamReportedTotal`：上游门户**自己声称**匹配多少条（来自 `upstream_reported_total`）
- `upstreamIncomplete`：固定 `true`

拿不到某个数字时**留空，不要填 0** —— 0 是一个有含义的断言（"确实没有"），
而"没有这个数字"与"数字是 0"是两件事。

**状态必须来自本次实测，不得照抄示例**：上面的 `explanation` 只是格式示范。
例如 `chictr` 在本机 `npx -y chictr-mcp-server@3.0.2` 已实测可启动，只有在真的因网络/依赖
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

一个渠道任何状态都**不影响**其余渠道返回结果。禁止写成"五个来源都没有结果"。

### 覆盖 ≠ 完整（两个不同的契约，都要呈现）

`xyb_trials_unify` 会返回**两句话**，它们回答的是不同问题，**两句都要转述**：

| 字段 | 回答的问题 | 什么时候是 false / 有内容 |
|---|---|---|
| `coverage.sentence` | **查了哪几处** | 有来源没真跑（`NEEDS_SETUP` / `TIMEOUT` / …）时报「未覆盖」 |
| `completeness.sentence` | **拿到的数字是什么性质** | 查过的来源里若有返回集是下界的（`who_ictrp`），报「条数是下界」 |

**「五个渠道都查了」不等于「这就是全部符合条件的试验」。** 前者的 `coverage.complete` 可以是
`true`，同时后者的 `completeness.countsAreLowerBounds` 也是 `true`——因为 WHO ICTRP 自己在
上游就漏数据。**禁止**在 `complete=true` 时把结果说成「完整检索」。

## 四、去重与合并（很保守）

`xyb_trials_unify` 只在下列情况自动合并：规范化登记号完全相同、来源显式交叉引用、可审计的官方映射。

**不会**因为标题、药物、地点、申办方、疾病相似而合并。标题相同但都没有登记号的，会保留两条并给
「可能相关、未自动合并」提示——**不要**自行替它们下结论。

合并后的条目保留全部来源、全部登记号、全部原始链接；有冲突时逐来源列出原始取值，
呈现时**不得掩盖差异**（例如 CT.gov 写 `Recruiting`、ChiCTR 写「招募中」，两者都照抄）。

## 五、输出结构

```
一、本次查询（关键词 / 病种 / 时间）
二、渠道状态表（五行：渠道、状态、结果数、原因）
三、候选试验清单（按返回顺序；每条含登记号、标题、状态、分期、地点、来源链接）
四、可能相关但未自动合并（如有）
五、与医生讨论的问题清单
```

硬性规则：

- 开头写：**以下为公开试验信息整理，供参考，不构成医疗建议；是否符合入组条件需由研究医生判断。**
- **禁止**「建议你参加」「这项最适合你」这类结论。
- 注册号、状态、分期**照抄**来源；缺失写「来源未公布」。
- 渠道状态未覆盖处，明确说「这一处本次没查到」，不要让用户以为已全覆盖。
- **`completeness.sentence` 必须原样呈现**（当 `who_ictrp` 有结果时）。只报条数不报它是下界，
  等于把「我不知道全部」说成「这就是全部」。
- ICTRP 的 `matched_rows_returned` 与 `upstream_reported_total` **两个数都写出来**，
  不合并、不相加、不只报一个。示例：「WHO ICTRP：本次导出 882 条，该库自报匹配 1243 条
  （导出通道存在已知遗漏，882 是下界）」。
- 来自 ICTRP 的中国试验标 **「ChiCTR via WHO ICTRP」**，不得标成「ChiCTR」。
- 用到 ICTRP 数据时标注 **WHO ICTRP** 与 WHO 处理日期。
- 不接触、不推测用户没提供的信息；不复述任何会话凭据。
- 结果是**浏览线索**，不是入组资格判断。
