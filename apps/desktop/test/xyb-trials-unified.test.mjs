/**
 * F2：四来源统一试验查询的规范化与保守合并回归测试。
 *
 * 只测纯函数层（lib/unified.js）：离线、无网络、无 MCP。
 * 覆盖 M2.1 的来源状态语义与 M2.2 的合并/去重/排序契约。
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

test("登记号规范化：只统一大小写与分隔符，不做模糊匹配", () => {
  assert.equal(unified.normalizeRegistryId("nct01234567"), "NCT01234567");
  assert.equal(unified.normalizeRegistryId("NCT01234567"), "NCT01234567");
  assert.equal(
    unified.normalizeRegistryId("ChiCTR-IPR-17012345"),
    unified.normalizeRegistryId("ChiCTRIPR17012345"),
  );
  assert.equal(unified.normalizeRegistryId(""), "");
  assert.equal(unified.normalizeRegistryId(null), "");
});

test("sourceRecordKey 由来源与规范化登记号组成；缺登记号时为空", () => {
  assert.equal(unified.sourceRecordKey("chictr", "ChiCTR-IPR-17012345"), "chictr:CHICTRIPR17012345");
  assert.equal(unified.sourceRecordKey("chictr", ""), "");
});

test("normalizeRecord 保留可追溯字段，不推测缺失值", () => {
  const record = unified.normalizeRecord("chictr", {
    reg_no: "ChiCTR2100045678",
    title: "某试验",
    status: "招募中",
    locations: ["北京", { country: "中国", city: "上海" }],
    url: "https://www.chictr.org.cn/x",
  });
  assert.equal(record.source, "chictr");
  assert.equal(record.sourceRecordKey, "chictr:CHICTR2100045678");
  assert.equal(record.title, "某试验");
  assert.equal(record.sourceStatusRaw, "招募中");
  assert.equal(record.sourceUrl, "https://www.chictr.org.cn/x");
  assert.deepEqual(record.locations, [{ site: "北京" }, { country: "中国", city: "上海" }]);
  // 未提供的字段必须为空，而不是编造
  assert.equal(record.phase, "");
  assert.deepEqual(record.interventions, []);
});

test("来源状态：NO_RESULTS 与不可用状态严格区分", () => {
  const ok = unified.sourceStatus("chictr", { state: "SUCCESS", records: [{ id: "a" }] });
  assert.equal(ok.state, "SUCCESS");
  assert.equal(ok.resultCount, 1);

  const none = unified.sourceStatus("chictr", { state: "NO_RESULTS", records: [] });
  assert.equal(none.state, "NO_RESULTS");
  assert.equal(none.resultCount, 0);
  assert.match(none.explanation, /没有匹配结果/);

  for (const state of [
    "NOT_ENABLED",
    "NEEDS_SETUP",
    "INDEX_EMPTY",
    "SESSION_EXPIRED",
    "CHALLENGE_REQUIRED",
    "TIMEOUT",
    "FAILED",
  ]) {
    const s = unified.sourceStatus("veeva_ctv", { state });
    assert.equal(s.state, state);
    assert.notEqual(s.state, "NO_RESULTS", `${state} 不能被当成"没有结果"`);
    assert.ok(s.explanation.length > 0, `${state} 必须带可执行说明`);
  }

  // 未知状态按失败处理，不静默当作成功
  assert.equal(unified.sourceStatus("chictr", { state: "WHATEVER" }).state, "FAILED");
});

test("自动合并：同一登记号跨来源合并，保留全部来源、登记号与链接", () => {
  const result = unified.buildResult({
    query: { keywords: "KRAS", condition: "pancreatic cancer" },
    sourceResults: {
      clinicaltrials_gov: {
        state: "SUCCESS",
        records: [
          {
            nctId: "NCT05123456",
            title: "A Study of Drug X",
            status: "Recruiting",
            phase: "Phase 1",
            conditions: ["Pancreatic Cancer"],
            locations: [{ country: "United States", city: "Boston" }],
            url: "https://clinicaltrials.gov/study/NCT05123456",
          },
        ],
      },
      veeva_ctv: {
        state: "SUCCESS",
        records: [
          {
            registryId: "NCT05123456",
            title: "A Study of Drug X",
            status: "Recruiting",
            url: "https://ctv.veeva.com/study/NCT05123456",
          },
        ],
      },
    },
  });

  assert.equal(result.records.length, 1, "同一登记号必须合并为一条");
  const merged = result.records[0];
  assert.equal(merged.merged, true);
  assert.deepEqual(merged.mergedFrom.sort(), ["clinicaltrials_gov", "veeva_ctv"]);
  assert.ok(merged.linkedRecordKeys.length === 2, "必须保留两个来源的记录键");
  assert.equal(merged.sourceLinks.length, 2, "必须保留全部原始链接");
  assert.deepEqual(
    merged.sourceLinks.map((l) => l.source).sort(),
    ["clinicaltrials_gov", "veeva_ctv"],
  );
  assert.equal(result.totalRecords, 2, "合并前总数可追溯");
});

test("不合并：标题/药物/地点相似但没有稳定登记号", () => {
  const result = unified.buildResult({
    query: { keywords: "胰腺癌" },
    sourceResults: {
      clinicaltrials_gov: {
        state: "SUCCESS",
        records: [{ title: "Pancreatic Cancer Trial", status: "Recruiting" }],
      },
      chictr: {
        state: "SUCCESS",
        records: [{ title: "Pancreatic Cancer Trial", status: "招募中" }],
      },
    },
  });

  assert.equal(result.records.length, 2, "缺登记号时绝不自动合并");
  assert.ok(result.records.every((r) => r.merged === false));
  assert.equal(result.mergeCandidates.length, 1, "应给出「可能相关、未自动合并」提示");
  assert.match(result.mergeCandidates[0].reason, /未自动合并/);
});

test("不合并：标题不同但登记号相同 → 仍合并（登记号是唯一依据）", () => {
  const result = unified.buildResult({
    sourceResults: {
      clinicaltrials_gov: {
        state: "SUCCESS",
        records: [{ nctId: "NCT00000001", title: "Long official title", status: "Recruiting" }],
      },
      chictr: {
        state: "SUCCESS",
        records: [{ registryId: "NCT00000001", title: "中文短标题", status: "招募中" }],
      },
    },
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].merged, true);
});

test("冲突不掩盖：同一试验各来源的标题/分期/状态逐来源保留", () => {
  const result = unified.buildResult({
    sourceResults: {
      clinicaltrials_gov: {
        state: "SUCCESS",
        records: [
          { nctId: "NCT00000002", title: "English title", status: "Recruiting", phase: "Phase 2" },
        ],
      },
      chictr: {
        state: "SUCCESS",
        records: [
          { registryId: "NCT00000002", title: "中文标题", status: "招募中", phase: "II期" },
        ],
      },
    },
  });
  const merged = result.records[0];
  assert.equal(merged.perSource.title.clinicaltrials_gov, "English title");
  assert.equal(merged.perSource.title.chictr, "中文标题");
  assert.equal(merged.perSource.sourceStatusRaw.chictr, "招募中");
  assert.equal(merged.perSource.phase.chictr, "II期");
  assert.equal(merged.locations.length, 0, "没有地点数据时不得编造");
});

test("未提供结果的来源标记为未执行，绝不显示成「没有结果」", () => {
  const result = unified.buildResult({
    query: { keywords: "胰腺癌" },
    sourceResults: {
      clinicaltrials_gov: { state: "SUCCESS", records: [{ nctId: "NCT1", title: "T" }] },
    },
  });

  assert.equal(result.statuses.length, 5, "五个来源都必须有状态");
  const bySource = Object.fromEntries(result.statuses.map((s) => [s.source, s]));
  assert.equal(bySource.clinicaltrials_gov.state, "SUCCESS");
  for (const source of ["chictr", "veeva_ctv", "chinadrugtrials", "who_ictrp"]) {
    assert.equal(bySource[source].state, "NOT_ENABLED");
    assert.notEqual(bySource[source].state, "NO_RESULTS");
  }
  assert.equal(result.sourcesQueried, 1);
  assert.equal(result.sourcesUnavailable, 4);
  assert.ok(result.disclaimer.includes("不构成医疗建议"));
});

test("单源失败不影响其余来源结果", () => {
  const result = unified.buildResult({
    sourceResults: {
      clinicaltrials_gov: {
        state: "SUCCESS",
        records: [{ nctId: "NCT00000003", title: "OK", status: "Recruiting" }],
      },
      chictr: { state: "TIMEOUT", explanation: "查询超时" },
      veeva_ctv: { state: "INDEX_EMPTY" },
      chinadrugtrials: { state: "SESSION_EXPIRED" },
      who_ictrp: { state: "FAILED", explanation: "上游导出不完整" },
    },
  });

  assert.equal(result.records.length, 1, "可用来源的结果必须照常返回");
  assert.equal(result.sourcesUnavailable, 4);
  const bySource = Object.fromEntries(result.statuses.map((s) => [s.source, s]));
  assert.equal(bySource.chictr.state, "TIMEOUT");
  assert.equal(bySource.veeva_ctv.state, "INDEX_EMPTY");
  assert.equal(bySource.chinadrugtrials.state, "SESSION_EXPIRED");
  assert.equal(bySource.chictr.resultCount, 0);
});

test("排序稳定：招募状态 → 国内地点 → 更新时间 → 主键", () => {
  const result = unified.buildResult({
    sourceResults: {
      clinicaltrials_gov: {
        state: "SUCCESS",
        records: [
          { nctId: "NCT00000010", title: "已暂停", status: "Suspended", fetchedAt: "2025-01-01" },
          {
            nctId: "NCT00000011",
            title: "招募中且在中国",
            status: "Recruiting",
            locations: [{ country: "China", city: "Shanghai" }],
            fetchedAt: "2025-01-01",
          },
          {
            nctId: "NCT00000012",
            title: "招募中但不在中国",
            status: "Recruiting",
            locations: [{ country: "United States", city: "Boston" }],
            fetchedAt: "2024-01-01",
          },
        ],
      },
    },
  });

  assert.deepEqual(
    result.records.map((r) => r.registryId),
    ["NCT00000011", "NCT00000012", "NCT00000010"],
  );
});

test("同一输入重复计算结果一致（可复现）", () => {
  const input = () => ({
    query: { keywords: "KRAS" },
    sourceResults: {
      clinicaltrials_gov: {
        state: "SUCCESS",
        records: [
          { nctId: "NCT00000020", title: "B", status: "Recruiting" },
          { nctId: "NCT00000021", title: "A", status: "Recruiting" },
        ],
      },
      chictr: { state: "SUCCESS", records: [{ reg_no: "ChiCTR2100000020", title: "C" }] },
    },
  });
  const a = unified.buildResult(input());
  const b = unified.buildResult(input());
  assert.deepEqual(
    a.records.map((r) => r.sourceRecordKey),
    b.records.map((r) => r.sourceRecordKey),
  );
});

test("状态语义：未跑 ≠ 没结果，未知状态降级为 FAILED", () => {
  const u = unified;

  // NO_RESULTS（查了没有）与 NOT_ENABLED（没查）必须区分，不得混用
  const noRes = u.buildResult({
    query: { keywords: "YL201" },
    sourceResults: { chictr: { state: "NO_RESULTS", records: [] } },
  });
  const chictr = noRes.statuses.find((s) => s.source === "chictr");
  assert.equal(chictr.state, "NO_RESULTS");
  assert.equal(noRes.sourcesQueried, 1, "NO_RESULTS 属于「已执行」");
  assert.equal(noRes.sourcesUnavailable, 4);

  // 完全没提供该来源 → NOT_ENABLED，且不得被当成「查过无结果」
  const untouched = u.buildResult({ query: { keywords: "YL201" }, sourceResults: {} });
  assert.equal(untouched.statuses.length, 5, "五渠道状态恒为五条，不得省略");
  for (const s of untouched.statuses) {
    assert.equal(s.state, "NOT_ENABLED", `${s.source} 未提供结果时应为 NOT_ENABLED`);
  }
  assert.equal(untouched.sourcesQueried, 0);
  assert.equal(untouched.sourcesUnavailable, 5);
  assert.equal(untouched.records.length, 0);

  // 未知状态不得被乐观当成 SUCCESS
  const bogus = u.buildResult({
    query: { keywords: "x" },
    sourceResults: { chictr: { state: "TOTALLY_MADE_UP", records: [] } },
  });
  assert.equal(bogus.statuses.find((s) => s.source === "chictr").state, "FAILED");
});

test("状态语义：每个合法状态都不与其它状态混淆", () => {
  const u = unified;
  const expect = {
    SUCCESS: "SUCCESS",
    NO_RESULTS: "NO_RESULTS",
    NOT_ENABLED: "NOT_ENABLED",
    NEEDS_SETUP: "NEEDS_SETUP",
    INDEX_EMPTY: "INDEX_EMPTY",
    SESSION_EXPIRED: "SESSION_EXPIRED",
    CHALLENGE_REQUIRED: "CHALLENGE_REQUIRED",
    TIMEOUT: "TIMEOUT",
    FAILED: "FAILED",
  };
  for (const [input, want] of Object.entries(expect)) {
    const r = u.buildResult({
      query: { keywords: "x" },
      sourceResults: { chictr: { state: input, records: [] } },
    });
    const s = r.statuses.find((x) => x.source === "chictr");
    assert.equal(s.state, want, `状态 ${input} 应保持为 ${want}`);
    assert.ok(s.explanation && s.explanation.length > 0, `状态 ${input} 必须有可读说明`);
  }
});

test("Veeva CTV：本地索引 0 命中不得表述为「没有相关研究」", () => {
  const u = unified;
  // 该来源的真实约束：0 命中只代表本地索引未覆盖，不代表不存在相关试验
  const r = u.buildResult({
    query: { keywords: "YL201" },
    sourceResults: {
      veeva_ctv: {
        state: "NO_RESULTS",
        records: [],
        explanation: "本地索引中未命中（索引覆盖 210 条，详情覆盖 20/210）",
      },
    },
  });
  const ctv = r.statuses.find((s) => s.source === "veeva_ctv");
  assert.equal(ctv.state, "NO_RESULTS", "本地索引 0 命中仍是「已执行」，不是 FAILED");
  assert.match(ctv.explanation, /本地索引/, "说明必须点明是本地索引未命中");
  assert.doesNotMatch(
    ctv.explanation,
    /没有相关研究|不存在相关试验/,
    "不得把索引未命中说成「没有相关研究」",
  );
  assert.equal(r.sourcesQueried, 1);
});

test("单源 NO_RESULTS 不影响其余来源返回结果", () => {
  const u = unified;
  const r = u.buildResult({
    query: { keywords: "YL201" },
    sourceResults: {
      clinicaltrials_gov: {
        state: "SUCCESS",
        records: [{ registryId: "NCT05434234", title: "YL201 in Advanced Solid Tumors" }],
      },
      veeva_ctv: { state: "NO_RESULTS", records: [], explanation: "本地索引中未命中" },
      chictr: { state: "NO_RESULTS", records: [], explanation: "已试『胰腺癌』『pancreatic』均无匹配" },
      chinadrugtrials: { state: "SESSION_EXPIRED", explanation: "会话已失效" },
      who_ictrp: { state: "NO_RESULTS", records: [], explanation: "WHO ICTRP 未命中" },
    },
  });
  assert.equal(r.totalRecords, 1, "只有渠道 1 有记录");
  assert.equal(r.records.length, 1);
  assert.equal(r.sourcesQueried, 4, "SUCCESS + 三个 NO_RESULTS 都算已执行");
  assert.equal(r.sourcesUnavailable, 1, "仅 SESSION_EXPIRED 属未取得结果");
  assert.doesNotMatch(
    JSON.stringify(r),
    /四个来源都没有结果|所有来源均无结果/,
    "不得出现「全部无结果」式汇总",
  );
});

// —— Layer 2：覆盖率契约（ADR 0311） ——
//
// 存在理由（2026-10-04 实测）：助手加载了技能、也走了渠道工具，但只查了
// CT.gov 与 ChiCTR 就结束回合，Veeva 与中国药物登记平台一次都没调，且不报错。
// 用户会拿到一个"看起来是五渠道汇总、实际只有两个渠道"的答案。
// 覆盖率契约强制把"漏查"说出来，使不完整的答案看起来就不完整。

test("覆盖率：只查了两个来源时必须点名未覆盖的三个，并说明未覆盖≠没有结果", () => {
  const r = unified.buildResult({
    query: { condition: "pancreatic cancer", terms: "IBI343" },
    sourceResults: {
      clinicaltrials_gov: { state: "SUCCESS", records: [{ id: "NCT07415525", title: "A" }] },
      chictr: { state: "SUCCESS", records: [{ id: "ChiCTR240001", title: "B" }] },
    },
  });

  assert.equal(r.coverage.total, 5);
  assert.equal(r.coverage.queried, 2);
  assert.equal(r.coverage.missing, 3);
  assert.equal(r.coverage.complete, false);
  assert.deepEqual(r.coverage.missingSources, ["veeva_ctv", "chinadrugtrials", "who_ictrp"]);
  assert.match(r.coverage.sentence, /只覆盖 2\/5/);
  assert.match(r.coverage.sentence, /Veeva CTV/);
  assert.match(r.coverage.sentence, /药物临床试验登记与信息公示平台/);
  assert.match(r.coverage.sentence, /WHO ICTRP/);
  assert.match(r.coverage.sentence, /未覆盖不等于没有结果/);
});

test("覆盖率：五个来源都查过（含 NO_RESULTS）时才算完整", () => {
  const r = unified.buildResult({
    sourceResults: {
      clinicaltrials_gov: { state: "SUCCESS", records: [{ id: "NCT07415525" }] },
      chictr: { state: "NO_RESULTS", records: [] },
      veeva_ctv: { state: "NO_RESULTS", records: [] },
      chinadrugtrials: { state: "SUCCESS", records: [{ id: "CTR20240001" }] },
      who_ictrp: { state: "NO_RESULTS", records: [] },
    },
  });
  assert.equal(r.coverage.complete, true);
  assert.equal(r.coverage.missing, 0);
  assert.match(r.coverage.sentence, /已覆盖全部 5 处来源/);
  assert.doesNotMatch(r.coverage.sentence, /未覆盖/);
});

test("覆盖率：NO_RESULTS 算「查过了」，不得与「没查」混为一谈", () => {
  // 这是本契约的核心：查了没有 ≠ 没查。前者可以写"没有结果"，
  // 后者只能说"这次没查这一处"。
  const noResults = unified.buildResult({
    sourceResults: {
      clinicaltrials_gov: { state: "NO_RESULTS", records: [] },
      chictr: { state: "NO_RESULTS", records: [] },
      veeva_ctv: { state: "NO_RESULTS", records: [] },
      chinadrugtrials: { state: "NO_RESULTS", records: [] },
      who_ictrp: { state: "NO_RESULTS", records: [] },
    },
  });
  assert.equal(noResults.coverage.complete, true, "五家都查了、都没结果 → 覆盖完整");
  assert.match(noResults.coverage.sentence, /已覆盖全部 5 处来源/);

  const notQueried = unified.buildResult({ sourceResults: {} });
  assert.equal(notQueried.coverage.complete, false, "一家都没查 → 覆盖不完整");
  assert.equal(notQueried.coverage.queried, 0);
  assert.match(notQueried.coverage.sentence, /只覆盖 0\/5/);
});

test("覆盖率：失败态（TIMEOUT/FAILED 等）一律计入未覆盖", () => {
  const r = unified.buildResult({
    sourceResults: {
      clinicaltrials_gov: { state: "SUCCESS", records: [] },
      chictr: { state: "TIMEOUT", records: [] },
      veeva_ctv: { state: "INDEX_EMPTY", records: [] },
      chinadrugtrials: { state: "SESSION_EXPIRED", records: [] },
      who_ictrp: { state: "TIMEOUT", records: [] },
    },
  });
  assert.equal(r.coverage.queried, 1);
  assert.equal(r.coverage.missing, 4);
  assert.equal(r.coverage.complete, false);
  assert.match(r.coverage.sentence, /只覆盖 1\/5/);
  assert.match(r.coverage.sentence, /查询超时/);
  assert.match(r.coverage.sentence, /本地索引为空/);
  assert.match(r.coverage.sentence, /会话已失效/);
});

test("覆盖率：isQueried 只在 SUCCESS/NO_RESULTS 为真", () => {
  assert.equal(unified.isQueried("SUCCESS"), true);
  assert.equal(unified.isQueried("NO_RESULTS"), true);
  for (const s of ["NOT_ENABLED", "NEEDS_SETUP", "INDEX_EMPTY", "SESSION_EXPIRED",
                   "CHALLENGE_REQUIRED", "TIMEOUT", "FAILED"]) {
    assert.equal(unified.isQueried(s), false, `${s} 不应算作已查询`);
  }
});

test("覆盖率句永远不含「五个来源都没有结果」式误导表述", () => {
  const r = unified.buildResult({
    sourceResults: { clinicaltrials_gov: { state: "SUCCESS", records: [] } },
  });
  assert.doesNotMatch(r.coverage.sentence, /都没有结果|均无结果|全部无结果/);
});
