/**
 * F2 扩展：第 5 来源（WHO ICTRP）的契约回归测试。
 *
 * 对应 SPEC `docs/zh-CN/spec/xyb-unified-trial-host-orchestration.md` §15.9 第 4、5、6、7、9 条。
 * 只测纯函数层（lib/unified.js）：离线、无网络、无 MCP、不启动 Python。
 *
 * 为什么单独成文件而不并入 xyb-trials-unified.test.mjs：那个文件测的是四来源
 * 就成立的通用语义（状态机、合并、排序），本文件测的是 **ICTRP 独有的三个失败模式** ——
 * 「下界被当成上界」「聚合库否定直连来源」「重叠记录被重复计数」。
 * 这三者在四来源时代不存在，混进去会让通用测试的意图变模糊。
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..", "resources", "plugins", "xyb.trials", "lib", "unified.js");
const unified = require(PLUGIN);

// —— §15.9 第 1 条：ICTRP 是第 5 个来源，且顺序在最后 ——

test("WHO ICTRP 已登记为第 5 个来源，排序在四个一手来源之后", () => {
  assert.deepEqual([...unified.SOURCES], [
    "clinicaltrials_gov",
    "chictr",
    "veeva_ctv",
    "chinadrugtrials",
    "who_ictrp",
  ]);
  assert.equal(unified.SOURCE_LABELS.who_ictrp, "WHO ICTRP");
  // 聚合库，不是一手注册库——kind 决定呈现方式，不是装饰
  assert.equal(unified.SOURCE_KINDS.who_ictrp, "aggregator_registry");
});

// —— §15.9 第 4 条：下界契约（本条是 §15 的核心） ——

test("ICTRP 的条数永远是下界：上游自报数与实得行数分开呈现，禁止合并", () => {
  const r = unified.buildResult({
    query: { condition: "pancreatic cancer" },
    sourceResults: {
      who_ictrp: {
        state: "SUCCESS",
        records: [{ id: "ACTRN12605000026628", title: "T" }],
        upstreamReportedTotal: 6952,
        matchedRowsReturned: 6262,
      },
    },
  });

  const s = r.statuses.find((x) => x.source === "who_ictrp");
  assert.equal(s.upstreamReportedTotal, 6952, "上游自报数必须原样保留");
  assert.equal(s.matchedRowsReturned, 6262, "实得行数必须原样保留");
  assert.equal(s.upstreamIncomplete, true, "该来源的返回集是下界");
  assert.notEqual(s.upstreamReportedTotal, s.matchedRowsReturned, "两个数字不得被压成一个");
});

test("ICTRP 即使 SUCCESS，也必须进入 countsAreLowerBounds 名单", () => {
  const r = unified.buildResult({
    sourceResults: {
      who_ictrp: {
        state: "SUCCESS",
        records: [{ id: "NCT1", title: "T" }],
        upstreamReportedTotal: 6952,
        matchedRowsReturned: 1,
      },
    },
  });

  assert.equal(r.completeness.countsAreLowerBounds, true, "SUCCESS 不等于数据完整");
  assert.deepEqual(r.completeness.upstreamIncompleteSources, ["who_ictrp"]);
  assert.match(r.completeness.sentence, /下界/);
  assert.match(r.completeness.sentence, /实得 1 条/);
  assert.match(r.completeness.sentence, /上游自报 6952 条/);
  assert.match(
    r.completeness.sentence,
    /不构成它不存在的证据/,
    "必须点明「不在结果里」不等于「不存在」",
  );
});

test("ICTRP 未查（NOT_ENABLED）时不算下界来源，不得把没查说成不完整", () => {
  const r = unified.buildResult({
    sourceResults: { who_ictrp: { state: "NOT_ENABLED" } },
  });
  assert.deepEqual(r.completeness.upstreamIncompleteSources, []);
  assert.equal(r.completeness.countsAreLowerBounds, false);
});

test("ICTRP 未提供上游自报数时只说实得条数，不编造第二个数字", () => {
  const r = unified.buildResult({
    sourceResults: {
      who_ictrp: { state: "SUCCESS", records: [{ id: "NCT1", title: "T" }] },
    },
  });
  const s = r.statuses.find((x) => x.source === "who_ictrp");
  assert.equal(s.upstreamReportedTotal, undefined, "缺失的数字不得被写成 0");
  assert.equal(s.matchedRowsReturned, undefined);
  assert.match(r.completeness.sentence, /实得 1 条/);
  assert.doesNotMatch(r.completeness.sentence, /上游自报/);
});

// —— §15.9 第 5 条：聚合库不得否定一手来源的阳性发现 ——

test("ICTRP 缺席不得否定其它来源的阳性记录", () => {
  const r = unified.buildResult({
    sourceResults: {
      chictr: { state: "SUCCESS", records: [{ id: "ChiCTR240001", title: "中国试验" }] },
      who_ictrp: { state: "NO_RESULTS", records: [], explanation: "WHO ICTRP 未命中" },
    },
  });

  assert.equal(r.records.length, 1, "ICTRP 没查到不代表这条试验不存在");
  assert.equal(r.records[0].title, "中国试验");
  assert.doesNotMatch(
    r.coverage.sentence,
    /都没有结果|均无结果|全部无结果/,
    "不得出现「全部无结果」式汇总",
  );
});

test("ICTRP 失败（TIMEOUT/FAILED）不得影响其它来源返回，且计入未覆盖", () => {
  const r = unified.buildResult({
    sourceResults: {
      clinicaltrials_gov: { state: "SUCCESS", records: [{ id: "NCT1", title: "OK" }] },
      who_ictrp: { state: "TIMEOUT", explanation: "查询超时" },
    },
  });

  assert.equal(r.records.length, 1, "可用来源的结果必须照常返回");
  assert.equal(r.coverage.complete, false, "ICTRP 没查成 → 覆盖不完整");
  assert.deepEqual(r.coverage.missingSources, ["chictr", "veeva_ctv", "chinadrugtrials", "who_ictrp"]);
  assert.match(r.coverage.sentence, /WHO ICTRP/);
});

// —— §15.9 第 6 条：重叠合并（ChiCTR via WHO ICTRP） ——

test("ICTRP 与 ChiCTR 命中同一登记号时保留直连版，ICTRP 版标注真实来源", () => {
  // ICTRP 收录 source_register = "ChiCTR" 的记录且每周同步，
  // 同一条中国试验会从两个来源各进一次。这是**系统性重叠**，不是偶发重复。
  const r = unified.buildResult({
    sourceResults: {
      chictr: {
        state: "SUCCESS",
        records: [{ id: "ChiCTR2400012345", title: "直连版标题", status: "招募中" }],
      },
      who_ictrp: {
        state: "SUCCESS",
        records: [{ id: "ChiCTR2400012345", title: "聚合库版标题", status: "Recruiting" }],
        upstreamReportedTotal: 2,
        matchedRowsReturned: 2,
      },
    },
  });

  assert.equal(r.records.length, 1, "同一登记号只能占一行");
  // 保留直连版（更新的、实时的），不是聚合库版
  assert.equal(r.records[0].primarySource, "chictr", "主记录必须是直连来源，不是聚合库");
  assert.equal(r.records[0].title, "直连版标题");
  assert.deepEqual(r.records[0].mergedFrom, ["chictr", "who_ictrp"], "两个来源都要留痕");
  // ICTRP 版本不得被丢弃——它进 perSource，供 UI 标注「ChiCTR via WHO ICTRP」
  assert.equal(r.records[0].perSource.title.who_ictrp, "聚合库版标题");
});

test("who_ictrp 声明了与 chictr / clinicaltrials_gov 的系统性重叠", () => {
  const s = unified.sourceStatus("who_ictrp", { state: "SUCCESS", records: [] });
  assert.deepEqual(s.overlapWith, ["chictr", "clinicaltrials_gov"]);
  // 不重叠的来源不得凭空长出该字段
  assert.equal(unified.sourceStatus("veeva_ctv", { state: "SUCCESS", records: [] }).overlapWith, undefined);
});

test("合并优先级是「一手 > 聚合库」，不是字母序巧合", () => {
  // 回归测试（2026-10-04）：主记录原取 `source.localeCompare()` 字典序第一。
  // `chictr` 与 `clinicaltrials_gov` 恰好都排在 `who_ictrp` 之前，所以当时结果
  // **看起来**符合 SPEC —— 但那是巧合，任何新增来源的字母序都可能翻转结论。
  // 因此规则改为显式权威序，本测试锁住它。
  const pair = unified.buildResult({
    sourceResults: {
      who_ictrp: { state: "SUCCESS", records: [{ id: "NCT9", title: "聚合库版" }] },
      clinicaltrials_gov: { state: "SUCCESS", records: [{ id: "NCT9", title: "一手版" }] },
    },
  });
  assert.equal(pair.records[0].primarySource, "clinicaltrials_gov", "一手来源必须赢");
  assert.equal(pair.records[0].title, "一手版");
  assert.deepEqual(pair.records[0].mergedFrom, ["clinicaltrials_gov", "who_ictrp"]);

  // ChiCTR 侧同理（SPEC §15.5 合并规则 1）
  const cn = unified.buildResult({
    sourceResults: {
      who_ictrp: { state: "SUCCESS", records: [{ id: "ChiCTR2400012345", title: "聚合库版" }] },
      chictr: { state: "SUCCESS", records: [{ id: "ChiCTR2400012345", title: "直连版" }] },
    },
  });
  assert.equal(cn.records[0].primarySource, "chictr", "ChiCTR 直连版必须赢过 ICTRP 版本");

  // 单一来源不构成「合并」，因此没有 primarySource —— 这不是缺陷，
  // 而是「合并」这个概念只在多来源命中同一登记号时才成立。
  const solo = unified.buildResult({
    sourceResults: { who_ictrp: { state: "SUCCESS", records: [{ id: "NCT8", title: "仅此一条" }] } },
  });
  assert.equal(solo.records[0].merged, false);
  assert.equal(solo.records[0].primarySource, undefined);
  assert.deepEqual(solo.records[0].mergedFrom, ["who_ictrp"]);
});

test("未登记来源按确定性顺序回落，不崩且可复现", () => {
  // 新增来源若忘了登记权威序，结果仍须确定（不能依赖对象键遍历顺序）
  const make = () => unified.buildResult({
    sourceResults: {
      who_ictrp: { state: "SUCCESS", records: [{ id: "NCT7", title: "A" }] },
    },
  });
  const first = make().records[0].primarySource;
  const second = make().records[0].primarySource;
  assert.equal(first, second, "同一输入必须得到同一主记录");
});

// —— §15.9 第 7 条：写盘失败仍返回结果 ——

test("上游写了说明不得被升级成「来源失败」", () => {
  // 这一条原先写成：传入 explanation: "…（CACHE_WRITE_FAILED）"，再断言
  // s.explanation 匹配 /缓存未落盘/ ——它断言的是自己的夹具，任何 explanation
  // 都能通过；而 CACHE_WRITE_FAILED 全仓库只有那一处、无任何代码产出。
  // 那是「一条永远不失败的门禁」的测试版。
  //
  // 真正属于本层的契约是：**上游附带说明，不等于来源失败**。写盘失败发生在上游
  // 服务内部（`cache/store.py` 对 OSError 是 pass 后照常返回结果；随包副本逐字节
  // 一致、不得就地修改），本层能守的是「不因为 explanation 有内容就改判状态」。
  // 故这里用一段**与缓存无关**的说明，把「有 explanation」与「写盘失败」解耦：
  // 若实现是靠 explanation 里的关键词猜状态，这条就会红。
  const r = unified.buildResult({
    sourceResults: {
      who_ictrp: {
        state: "SUCCESS",
        records: [{ id: "NCT1", title: "T" }],
        explanation: "服务在返回结果时附带的任意说明，与缓存无关",
      },
    },
  });
  const s = r.statuses.find((x) => x.source === "who_ictrp");
  assert.equal(s.state, "SUCCESS", "带说明的正常结果不得被改判为失败");
  assert.equal(r.records.length, 1, "结果照常返回");
  assert.match(s.explanation, /任意说明/, "上游说明必须原样透传，不得被丢弃或改写");
});

test("来源自报 FAILED 时不得靠 explanation 洗成成功", () => {
  // 反向：状态由 state 决定，不由 explanation 的文风决定。
  const r = unified.buildResult({
    sourceResults: {
      who_ictrp: {
        state: "FAILED",
        records: [{ id: "NCT1", title: "T" }],
        explanation: "结果已返回，但缓存未落盘",
      },
    },
  });
  const s = r.statuses.find((x) => x.source === "who_ictrp");
  assert.equal(s.state, "FAILED", "state 是权威，explanation 不能把它洗白");
});

// —— §15.9 第 8 条：本地工具不进扇出 ——

test("ICTRP 的本地工具名不出现在统一查询的扇出路径里", () => {
  // 纯函数层无法断言「宿主没调某个 MCP 工具」，但可以断言扇出只认来源 key，
  // 且 unified.js 不引用任何本地工具名（一旦引用，说明有人把本地工具塞进了扇出）。
  const src = require("node:fs").readFileSync(PLUGIN, "utf8");
  for (const localTool of [
    "ictrp_filter",
    "ictrp_export",
    "ictrp_field_query",
    "ictrp_registry_summary",
    "ictrp_find_duplicates",
    "ictrp_cache_status",
    "ictrp_snapshot",
    "ictrp_bundle_status",
  ]) {
    assert.ok(
      !src.includes(localTool),
      `${localTool} 是本地工具（需先物化 set_id），不得出现在扇出编排里`,
    );
  }
});

// —— 未知状态的保守降级 ——

test("ICTRP 收到未知状态时降级为 FAILED，不得乐观当成功", () => {
  const r = unified.buildResult({
    sourceResults: { who_ictrp: { state: "MADE_UP_STATE", records: [{ id: "NCT1" }] } },
  });
  const s = r.statuses.find((x) => x.source === "who_ictrp");
  assert.equal(s.state, "FAILED");
  assert.notEqual(s.state, "SUCCESS");
  assert.notEqual(s.state, "NO_RESULTS");
});

test("ICTRP 的 NEEDS_SETUP 不得被当成「没有结果」", () => {
  // §15.3.5：Python 缺失/依赖缺失时是 NEEDS_SETUP（用户可以修），
  // 不是 NO_RESULTS（数据上确实没有）。这两者对用户的意义完全不同。
  const r = unified.buildResult({
    sourceResults: {
      who_ictrp: { state: "NEEDS_SETUP", explanation: "Python 运行时缺失（PYTHON_RUNTIME_MISSING）" },
    },
  });
  const s = r.statuses.find((x) => x.source === "who_ictrp");
  assert.equal(s.state, "NEEDS_SETUP");
  assert.notEqual(s.state, "NO_RESULTS");
  assert.equal(unified.isQueried("NEEDS_SETUP"), false, "需要安装 ≠ 已查询");
  assert.match(r.coverage.sentence, /WHO ICTRP/, "覆盖率句必须点名它没查成");
});

// ---------------------------------------------------------------------------
// §15.9 criterion 6 / 9: the ICTRP copy of a Chinese trial must be labelled
// "via WHO ICTRP".
//
// `mergedFrom` already records which sources contributed. What it does not say
// is *how* the aggregator's copy relates to the first-hand one — and that is
// the part a user needs to decide which portal to trust for updates.
// ---------------------------------------------------------------------------

test("the aggregator's copy of a first-hand trial is labelled via WHO ICTRP", () => {
  assert.equal(unified.sourceAttributionLabel("chictr", "who_ictrp"), "ChiCTR（中国临床试验注册中心） via WHO ICTRP");
});

test("the first-hand copy carries no via label", () => {
  // The primary record IS the direct version; labelling it "via" would invert
  // the relationship the merge rule exists to preserve.
  assert.equal(unified.sourceAttributionLabel("chictr", "chictr"), "ChiCTR（中国临床试验注册中心）");
});

test("the via label names the actual first-hand source, not a hard-coded one", () => {
  // WHO ICTRP carries both ChiCTR and ClinicalTrials.gov registrations, so the
  // label must name whichever one is actually in play. Hard-coding "ChiCTR"
  // would mislabel every NCT record the aggregator also carries.
  assert.equal(
    unified.sourceAttributionLabel("clinicaltrials_gov", "who_ictrp"),
    "ClinicalTrials.gov via WHO ICTRP",
  );
});

test("a source with no overlap relation is not given a via label", () => {
  // Nothing in SOURCE_OVERLAPS says Veeva routes through WHO ICTRP, so writing
  // "Veeva CTV via WHO ICTRP" would invent a relationship that is not there.
  assert.equal(unified.sourceAttributionLabel("veeva_ctv", "who_ictrp"), "WHO ICTRP");
  assert.equal(unified.sourceAttributionLabel("", "who_ictrp"), "WHO ICTRP");
});

test("two first-hand sources merging are both named plainly", () => {
  // chictr + clinicaltrials_gov on one registry id: neither came "via" the
  // other, so neither gets a via label.
  assert.equal(unified.sourceAttributionLabel("chictr", "clinicaltrials_gov"), "ClinicalTrials.gov");
});

test("an unknown source key falls back to the raw key rather than a blank", () => {
  assert.equal(unified.sourceAttributionLabel("chictr", "some_new_registry"), "some_new_registry");
  assert.equal(unified.sourceAttributionLabel("chictr", ""), "");
});

test("a merged record exposes a label for each contributing source", () => {
  const merged = unified.buildResult({
    query: { condition: "pancreatic cancer" },
    sourceResults: {
      chictr: {
        state: "SUCCESS",
        records: [{ registryId: "ChiCTR2400081234", title: "A", sourceStatusRaw: "Recruiting" }],
      },
      who_ictrp: {
        state: "SUCCESS",
        records: [{ registryId: "ChiCTR2400081234", title: "A", sourceStatusRaw: "Recruiting" }],
      },
    },
  });
  assert.equal(merged.records.length, 1, "同一登记号应合并为一条");
  const record = merged.records[0];
  assert.equal(record.primarySource, "chictr", "一手来源必须保留为主记录");
  const bySource = Object.fromEntries(record.sourceLabels.map((l) => [l.source, l.label]));
  assert.equal(bySource.chictr, "ChiCTR（中国临床试验注册中心）");
  assert.equal(bySource.who_ictrp, "ChiCTR（中国临床试验注册中心） via WHO ICTRP");
});
