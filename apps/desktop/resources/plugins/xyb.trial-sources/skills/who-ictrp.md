---
name: WHO ICTRP 接入
description: 当需要查询 WHO ICTRP（全球临床试验注册库汇总）时使用——9 个工具里只有 1 个联网、另 8 个跑本地结果集；只接受英文关键词（中文实测 0 命中）；条数是下界，两个数字必须分开报；它是聚合库，不得用它否定一手来源的阳性发现。
---

# WHO ICTRP 接入

本文讲第五处来源 WHO ICTRP：它是什么、怎么调、哪两个数字必须分开报、为什么不能拿它否定别的来源。

> **一句话定位：** ICTRP 是**聚合库**（二手），不是一手登记处。它把各国注册库的记录汇总后重发，
> 用来**补覆盖面**——尤其是我们没单独接的小注册库。**它不能顶替** ClinicalTrials.gov / ChiCTR /
> 中国药物临床试验登记平台 / Veeva CTV 这些一手来源，也不提供更细的字段。

---

## 一、先看清它是什么

| 性质 | 说明 |
|---|---|
| 覆盖 | 全球，汇总各国注册库（含 ChiCTR、ClinicalTrials.gov 等的转记） |
| 语言 | **只认英文关键词**。中文关键词实测 0 命中；单词 `pancreatic` 会被站点 302 到 `NoAccess.aspx`。请用 `pancreatic cancer` 这类完整英文词组 |
| 时效 | WHO **每周更新**。随包种子另有 28 天保质期 |
| 条数语义 | **是下界**——返回集系统性小于上游自报的匹配数（见第三节） |

**下游影响：** 同一条中国试验会同时被 ChiCTR 与 ICTRP 命中。合并时保留 **ChiCTR 直连版**（更实时），
ICTRP 版进 `mergedFrom`。这在 `xyb_trials_unify` 里自动发生，但你**必须**在回答里按第五节标注来源。

---

## 二、9 个工具：只有 1 个联网

> **勘误（重要）：本服务实际注册 9 个工具，不是某些部署文档写的 10 个。**
> `ictrp_check_environment` **不存在**——`grep 'name="ictrp_'` 在 `ictrp_mcp/server.py` 上只得 9 个结果，
> 且 `grep -rn check_environment` 在服务源码树上零命中。它只出现在上游的部署文档里。
> （`check_environment` 是**另一个服务** ChiCTR 的工具，不要混为一谈。）**不要调用不存在的工具。**

| 工具 | 联网？ | 作用 |
|---|---|---|
| `ictrp_search` | **是（唯一）** | 检索并把整个结果集**物化**到本地，返回 `set_id` 与首页 |
| `ictrp_filter` | 否 | 对已物化结果集筛选 / 排序 / 翻页 |
| `ictrp_field_query` | 否 | 某字段的取值分布与填充率 |
| `ictrp_registry_summary` | 否 | 按注册库统计分布 |
| `ictrp_find_duplicates` | 否 | 找疑似重复登记 |
| `ictrp_export` | 否 | 导出结果集 |
| `ictrp_cache_status` | 否 | 本地缓存状态 |
| `ictrp_snapshot` | 否 | 把结果集写成 canonical JSON 快照（随包用） |
| `ictrp_bundle_status` | 否 | 报告哪个本地快照会服务某关键词，**不触网** |

### 因此有两条铁律

1. **扇出时只调 `ictrp_search` 一次。** 另外 8 个本地工具**绝不进扇出**——它们跑的是同一份已落盘的数据，
   重复调用只会浪费时间，不会带来新事实。
2. **精炼结果不要重新 `ictrp_search`。** 拿到 `set_id` 后用 `ictrp_filter` 反复筛——每重搜一次就是一次
   真实的上游请求，而本机已经有一份完整数据了。

`set_id` **永远来自一次 `ictrp_search`**，本地工具都要它。**禁止让用户手打 `set_id`**，也禁止自己臆造一个。

---

## 三、两个数字必须分开报（最要紧的一条）

ICTRP **没有**「匹配总数」这个单一数字。它给出两个独立的数：

| 字段 | 含义 |
|---|---|
| `matched_rows_returned` | **实得行数**——本次真正拿到手的记录数 |
| `upstream_reported_total` | **上游自报总数**——WHO 门户自己声称的匹配数 |

实测 `pancreatic cancer`：**6262 / 6952**（缺约 9.9%）。缺失原因是 **WHO 的 CSV 导出会漏掉门户自称命中的记录**。

上报给 `xyb_trials_unify` 时，**两个字段都填**（`matchedRowsReturned` 与 `upstreamReportedTotal`）。
都没有就都别填——**不要补 0**，编排器不会替你编数字。

---

## 四、三条禁令（逐字生效）

1. **不得**因为某试验没出现在 ICTRP 结果里，就说它「不存在 / 没有这个试验」。
   ——导出会漏记录，缺席不是不存在的证据。
2. **不得**把本服务的条数当作「存在的试验总数」。它始终是下界。
3. 当 `matched_rows_returned` 与 `upstream_reported_total` **不同时必须同时呈现并解释原因**
   （「实得 N 条；上游自报 M 条，缺的部分是 WHO 导出本身漏的」）。

**补充一条：** ICTRP 的单次阴性结果**不得否定其他来源的阳性发现**。ChiCTR 查到了某试验而 ICTRP 没查到，
结论是「ICTRP 这一处没查到」，不是「这条试验是假的」。

---

## 五、来源标注与 WHO 条款

呈现 ICTRP 数据时**必须**同时给出：

1. **归因**：「Source: WHO International Clinical Trials Registry Platform (ICTRP).」
2. **WHO 处理日期**：取 `provenance.ictrp_export_date`（不是逐条记录的 `last_refreshed_display`，
   后者是单条刷新时间，不是 WHO 处理整批数据的日期）。
3. **中国试验的落款**：ICTRP 侧的 ChiCTR 记录必须显示为 **`ChiCTR via WHO ICTRP`**，
   **不得**直接写成「ChiCTR」——后者会让读者以为拿到的是直连版本，而实际上它已经过 WHO 转手、可能滞后。

> WHO 条款约束的是**数据本身**："These Terms and Conditions apply to all data obtained from the WHO ICTRP,
> independent of format and method of acquisition." 义务在**持有数据期间一直有效**，卸载也不终止。
> 逐条要求见 `docs/spec/xyb-unified-trial-host-orchestration.md` §15.7。**营销与商业用途被禁止**。

---

## 六、调用顺序

1. **激活**：工具按需注册。用 `ToolSearch` 找 `ictrp`（以及 ChiCTR / Veeva / chinadrugtrials 的工具），
   **下一轮**才调用。不要因为第一轮看不到工具就转去抓网页。
2. **检索**：`ictrp_search`，`keyword` 传英文、`limit: 100`。拿到 `set_id`。
3. **精炼**：要筛就用 `ictrp_filter`，**不要**重搜。
4. **整理**：把结果连同上述两个数字一起交给 `xyb_trials_unify`。

**失败时的处理：** 该来源失败时**永不返回 0 条**（失败即报错）。所以你看到的 0 条是 `NO_RESULTS`（真的没匹配），
不是失败；而 `NEEDS_SETUP` / `TIMEOUT` / `FAILED` 必须照实报状态，**不得**混作「查过了，没有」。
环境不齐（缺 Python 3.10+ 或依赖）时报 `NEEDS_SETUP`。

---

## 七、不要用浏览器替代它

ChiCTR 与 CDE 的检索页是 **JS 渲染**的，浏览器抓取**一定失败**——这两家用各自的 MCP 工具（详见「中国试验来源接入」）。
ICTRP 同理：**不要用网页抓取去做 `ictrp_search` 的活**。渠道工具就在手边，失败时要如实报失败状态，
而不是绕过去假装成功。
