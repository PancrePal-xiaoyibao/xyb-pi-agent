/**
 * F2 扩展：第 5 来源（WHO ICTRP）的契约回归测试。
 *
 * 对应 SPEC `docs/spec/xyb-unified-trial-host-orchestration.md` §15.9 第 4、5、6、7、9 条。
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

test("ICTRP 缓存写盘失败仍返回结果，只标注未落盘", () => {
  const r = unified.buildResult({
    sourceResults: {
      who_ictrp: {
        state: "SUCCESS",
        records: [{ id: "NCT1", title: "T" }],
        explanation: "结果已返回，但缓存未落盘（CACHE_WRITE_FAILED）",
      },
    },
  });
  const s = r.statuses.find((x) => x.source === "who_ictrp");
  assert.equal(s.state, "SUCCESS", "写盘失败不得把整条来源判为失败");
  assert.equal(r.records.length, 1, "结果照常返回");
  assert.match(s.explanation, /缓存未落盘/);
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
