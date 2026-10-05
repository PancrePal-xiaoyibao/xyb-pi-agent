/**
 * Trial-query orchestrator: terminal-state and aggregation contract tests.
 *
 * SPEC: docs/spec/xyb-unified-trial-host-orchestration.md §3.3, §3.4, §5.2, §5.3
 *
 * These are the rules that decide what a dispatch *means*, so they are tested
 * without a host, a plugin, or a network. The failure they exist to prevent is
 * concrete: on 2026-10-03 an enabled, working source was reported as
 * `NOT_ENABLED` ("not ready in the current context"), which is a tool problem
 * wearing a settings problem's label, and the user never saw the results that
 * were available.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  QUERIED_STATES,
  SOURCE_STATES,
  aggregate,
  completenessSentence,
  coverageSentence,
  isQueried,
  overlapSentence,
  terminalise,
} from "../electron/main/trial-orchestrator.ts";
import { TRIAL_SOURCES, sourceByKey } from "../electron/main/trial-sources.ts";
import { interpretDispatchResult } from "../electron/main/trial-fanout.ts";

const chictr = sourceByKey("chictr");
const cde = sourceByKey("chinadrugtrials");
const veeva = sourceByKey("veeva_ctv");
const ictrp = sourceByKey("who_ictrp");
const ctgov = sourceByKey("clinicaltrials_gov");

const ok = (records, extra = {}) => ({ records, elapsedMs: 5, ...extra });

test("only SUCCESS and NO_RESULTS count as asked", () => {
  assert.deepEqual([...QUERIED_STATES], ["SUCCESS", "NO_RESULTS"]);
  for (const state of SOURCE_STATES) {
    assert.equal(isQueried(state), state === "SUCCESS" || state === "NO_RESULTS");
  }
});

test("a missing tool is TOOL_UNAVAILABLE, never NOT_ENABLED", () => {
  // The 2026-10-03 mislabel, pinned. "The tool is not in this session's
  // catalog" is an availability fact; NOT_ENABLED is reserved for the user
  // turning a source off.
  const conclusion = terminalise(cde, { toolRegistered: false });
  assert.equal(conclusion.state, "NOT_QUERIED");
  assert.equal(conclusion.reasonCode, "TOOL_UNAVAILABLE");
  assert.equal(conclusion.attempted, false);
  assert.match(conclusion.explanation, /工具在当前会话中不可用/);
  assert.doesNotMatch(conclusion.explanation, /未启用|关闭/);
});

test("a user-disabled source is NOT_ENABLED and says so", () => {
  const conclusion = terminalise(ictrp, { userDisabled: true });
  assert.equal(conclusion.state, "NOT_ENABLED");
  assert.equal(conclusion.reasonCode, "SOURCE_DISABLED_BY_USER");
});

test("a source lacking its runtime is NEEDS_SETUP with the real reason code", () => {
  const conclusion = terminalise(ictrp, {
    needsSetup: true,
    reasonCode: "PYTHON_RUNTIME_MISSING",
    explanation: "WHO ICTRP 需要 Python 3.10+ 运行时，本机未检测到。",
  });
  assert.equal(conclusion.state, "NEEDS_SETUP");
  assert.equal(conclusion.reasonCode, "PYTHON_RUNTIME_MISSING");
  assert.equal(conclusion.attempted, false);
});

test("a denied source starts nothing and is NOT_QUERIED", () => {
  const conclusion = terminalise(chictr, { denied: true });
  assert.equal(conclusion.state, "NOT_QUERIED");
  assert.equal(conclusion.reasonCode, "PERMISSION_DENIED");
  assert.equal(conclusion.attempted, false);
});

test("attempted is false exactly when we asked and got an answer", () => {
  // Enumerating branches one by one let two of them go unasserted, and the
  // comment on `terminalise` used to describe this as "true exactly when
  // dispatch started" — which is NOT the rule. `false` is the stronger claim
  // "we asked and this is the answer", so NOT_ENABLED and NEEDS_SETUP are false
  // without being NOT_QUERIED, and the three failure states are true without
  // carrying any answer. Assert the whole cross-product, not the branch list.
  assert.equal(terminalise(chictr, { toolRegistered: false }).attempted, false);
  assert.equal(terminalise(chictr, { denied: true }).attempted, false);
  assert.equal(terminalise(chictr, { notAttempted: true }).attempted, false);
  assert.equal(terminalise(chictr, { overallDeadline: true }).attempted, false);
  assert.equal(terminalise(chictr, { cancelled: true }).attempted, false);

  assert.equal(terminalise(chictr, { timedOut: true }).attempted, true);
  assert.equal(terminalise(chictr, { error: "boom" }).attempted, true);
  assert.equal(terminalise(chictr, { challenge: true }).attempted, true);
  assert.equal(terminalise(chictr, ok([])).attempted, true);
  assert.equal(terminalise(chictr, ok([{ id: 1 }])).attempted, true);

  // The two branches the enumeration missed, and the reason the rule above is
  // stated as "asked and got an answer" rather than "state !== NOT_QUERIED".
  const disabled = terminalise(chictr, { userDisabled: true });
  assert.equal(disabled.state, "NOT_ENABLED");
  assert.equal(disabled.attempted, false);

  const unready = terminalise(chictr, { needsSetup: true });
  assert.equal(unready.state, "NEEDS_SETUP");
  assert.equal(unready.attempted, false);
});

test("attempted is false exactly for the states that were never dispatched", () => {
  // Asserted as an equivalence over EVERY terminal state, so a new state added
  // to SOURCE_STATES cannot slip in with the wrong pairing.
  //
  // Do not confuse this with `isQueried`. They are different predicates: a
  // source that was dispatched and then TIMED OUT reports attempted=true but
  // isQueried=false — "we asked, we did not get an answer". Narrowing this
  // assertion to `isQueried` is wrong and fails on exactly those states.
  const observed = new Map();
  const outcomes = [
    {}, { toolRegistered: false }, { denied: true }, { notAttempted: true },
    { overallDeadline: true }, { cancelled: true }, { timedOut: true },
    { challenge: true }, { error: "boom" }, { needsSetup: true },
    { userDisabled: true }, { records: [] }, { records: [{ id: 1 }] },
  ];
  for (const outcome of outcomes) {
    const conclusion = terminalise(chictr, outcome);
    observed.set(conclusion.state, conclusion.attempted);
  }
  // Every terminal state must be reachable from the broker's outcome space,
  // otherwise this test would pass while covering only part of the machine.
  for (const state of SOURCE_STATES) {
    assert.ok(
      observed.has(state),
      `终态 ${state} 在本用例的 outcome 空间里不可达，等价性断言会空转通过`,
    );
  }
  const neverDispatched = ["NOT_QUERIED", "NOT_ENABLED", "NEEDS_SETUP"];
  for (const [state, attempted] of observed) {
    assert.equal(
      attempted,
      !neverDispatched.includes(state),
      `attempted=${attempted} 与「${state} 是否派发过」不一致`,
    );
    // And the one-way consequence that ties the two predicates together: an
    // answer can only exist if we asked.
    if (isQueried(state)) {
      assert.equal(attempted, true, `${state} 带着答案却报告 attempted=false`);
    }
  }
});

test("an empty successful response is NO_RESULTS, not a failure or a zero-row failure", () => {
  const conclusion = terminalise(chictr, ok([]));
  assert.equal(conclusion.state, "NO_RESULTS");
  assert.equal(conclusion.attempted, true);
  // A local index's miss must not be stated as "there is no such study".
  const local = terminalise(veeva, ok([]));
  assert.match(local.explanation, /本地索引中未找到/);
  assert.doesNotMatch(local.explanation, /没有相关研究。/);
});

test("a timeout is TIMEOUT and does not disturb other sources", () => {
  const conclusion = terminalise(ictrp, { timedOut: true, elapsedMs: 60_000 });
  assert.equal(conclusion.state, "TIMEOUT");
  assert.equal(conclusion.reasonCode, "SOURCE_TIMEOUT");
  assert.equal(conclusion.elapsedMs, 60_000);
  // And a sibling is unaffected.
  assert.equal(terminalise(chictr, ok([{ id: 1 }])).state, "SUCCESS");
});

test("an ICTRP empty result is disclosed as a keyword-language artifact, not a finding", () => {
  // The live behaviour: `ictrp_search {keyword:"胰腺癌"}` returns NO_RESULTS with
  // `retryable: false` and the upstream hint "This is a genuine zero". But ICTRP
  // indexes English metadata only, so a Chinese keyword CANNOT match — the zero
  // is produced by the language of the query, not by the absence of trials.
  // Rendered as the generic 「查询成功，没有匹配记录」 a patient asking in Chinese
  // would be told there are no such trials. This is a correctness rule, not
  // wording: it is the difference between a result and an artifact.
  const conclusion = terminalise(ictrp, ok([]));
  assert.equal(conclusion.state, "NO_RESULTS");
  // Still counted as asked — the source did answer.
  assert.equal(conclusion.attempted, true);
  assert.match(conclusion.explanation, /英文/);
  assert.match(conclusion.explanation, /pancreatic cancer/);
  // And it must not state the absence as a fact about the world.
  assert.doesNotMatch(conclusion.explanation, /没有匹配记录。/);
  // Nor may it say it "returned no records" — that phrasing collides with the
  // coverage sentence, which counts this same source as 「已覆盖」 because it did
  // answer. "返回 0 条" states the fact without implying it went unqueried.
  assert.doesNotMatch(conclusion.explanation, /没有返回记录/);
  assert.match(conclusion.explanation, /返回 0 条/);
  // No other source picks up this sentence: it is specific to the aggregator.
  assert.doesNotMatch(terminalise(chictr, ok([])).explanation, /英文/);
  assert.doesNotMatch(terminalise(veeva, ok([])).explanation, /英文/);
  assert.doesNotMatch(terminalise(cde, ok([])).explanation, /英文/);
});

test("a failed MCP handshake is reported with its real cause, not as a bare unavailability", () => {
  // Live ChiCTR: the bundled `chictr` server hit `mcp initialize timed out after
  // 10000ms` (errorCode TIMEOUT) and registered no tools. The catalog can only
  // see "no such tool", so the user was told 「其查询工具在当前会话中不可用，本次
  // 没有查询」 — true, and it hides the one thing they could act on. The reason
  // now travels with the outcome and replaces the cause-free sentence.
  const conclusion = terminalise(chictr, {
    toolRegistered: false,
    toolUnavailableReason: { errorCode: "TIMEOUT", message: "mcp initialize timed out after 10000ms" },
  });
  assert.equal(conclusion.state, "NOT_QUERIED");
  assert.equal(conclusion.reasonCode, "MCP_CONNECT_FAILED");
  assert.match(conclusion.explanation, /TIMEOUT/);
  assert.match(conclusion.explanation, /mcp initialize timed out after 10000ms/);
  // The generic wording must not survive alongside the real cause.
  assert.doesNotMatch(conclusion.explanation, /在当前会话中不可用/);
});

test("a missing tool with no known cause keeps the generic unavailability wording", () => {
  // The distinction the reason must not destroy: absent reason = "not reported",
  // never "reported as a handshake failure". Inventing a cause is the same class
  // of error as inventing a date.
  const conclusion = terminalise(chictr, { toolRegistered: false });
  assert.equal(conclusion.reasonCode, "TOOL_UNAVAILABLE");
  assert.match(conclusion.explanation, /在当前会话中不可用/);
  assert.doesNotMatch(conclusion.explanation, /MCP 服务本次未能连接/);
});

test("a verification challenge is CHALLENGE_REQUIRED, never worked around", () => {
  const conclusion = terminalise(chictr, { challenge: true });
  assert.equal(conclusion.state, "CHALLENGE_REQUIRED");
  assert.equal(conclusion.reasonCode, "SOURCE_CHALLENGE");
});

test("a transport error is FAILED and keeps the upstream text", () => {
  const conclusion = terminalise(chictr, { error: "browserContext closed" });
  assert.equal(conclusion.state, "FAILED");
  assert.match(conclusion.explanation, /browserContext closed/);
});

test("ICTRP keeps the two numbers separate and flags the lower bound", () => {
  const conclusion = terminalise(
    ictrp,
    ok([{ trial_id: "ACTRN1" }], { upstreamReportedTotal: 6952, matchedRowsReturned: 6262 }),
  );
  assert.equal(conclusion.state, "SUCCESS");
  assert.equal(conclusion.upstreamIncomplete, true);
  // §15.9 criterion 4: the reason code must accompany the two numbers. Without
  // it the payload gives a consumer no way to tell "count is complete" from
  // "count is a lower bound" except by comparing numbers it may not know to
  // compare — the criterion existed as prose with nothing emitting it.
  assert.equal(conclusion.reasonCode, "UPSTREAM_RESULT_INCOMPLETE");
  assert.equal(conclusion.upstreamReportedTotal, 6952);
  assert.equal(conclusion.matchedRowsReturned, 6262);
  assert.equal(conclusion.resultCount, 1);
  // Three numbers, none of them merged into "共 N 条".
  assert.notEqual(conclusion.resultCount, conclusion.upstreamReportedTotal);
  assert.match(conclusion.explanation, /下界/);
});

test("a source with no upstream total does not get a fabricated zero", () => {
  const conclusion = terminalise(ictrp, ok([{ trial_id: "ACTRN1" }], { matchedRowsReturned: 1 }));
  assert.equal(conclusion.upstreamIncomplete, true);
  assert.equal(conclusion.upstreamReportedTotal, undefined);
});

test("only ICTRP carries the lower-bound flag", () => {
  for (const source of [ctgov, chictr, veeva, cde]) {
    const conclusion = terminalise(source, ok([{ id: 1 }]));
    assert.equal(conclusion.upstreamIncomplete, undefined, `${source.key} must not be a lower bound`);
  }
});

test("aggregate always reports every registered source in registry order", () => {
  const result = aggregate({
    query: "pancreatic cancer",
    conclusions: [terminalise(chictr, ok([{ id: 1 }]))],
    startedAt: "2026-10-04T00:00:00.000Z",
    elapsedMs: 12,
  });
  assert.equal(result.statuses.length, TRIAL_SOURCES.length);
  assert.deepEqual(
    result.statuses.map((status) => status.source),
    TRIAL_SOURCES.map((source) => source.key),
  );
  // A source the caller never produced is "never asked", not "no results".
  const absent = result.statuses.find((status) => status.source === "who_ictrp");
  assert.equal(absent.state, "NOT_QUERIED");
  // NOT_ATTEMPTED, not OVERALL_DEADLINE. `fanout` always emits a conclusion for
  // every source, so a caller that omits one has said nothing about why. Naming
  // a deadline would state a cause nobody established, and the panel would then
  // print 「整体检索时间已到」 for a source that was never tried.
  assert.equal(absent.reasonCode, "NOT_ATTEMPTED");
  assert.ok(
    !/时间已到|deadline/i.test(absent.explanation),
    `未尝试的来源不得声称是超时：${absent.explanation}`,
  );
  assert.equal(absent.attempted, false);
});

test("complete is true only when all five were actually asked", () => {
  const allAsked = TRIAL_SOURCES.map((source) => terminalise(source, ok([{ id: 1 }])));
  const full = aggregate({ query: "q", conclusions: allAsked, elapsedMs: 1 });
  assert.equal(full.coverage.complete, true);
  assert.equal(full.coverage.queried, 5);

  // A NO_RESULTS source still counts as asked.
  const withEmpty = TRIAL_SOURCES.map((source) => terminalise(source, ok([])));
  assert.equal(aggregate({ query: "q", conclusions: withEmpty, elapsedMs: 1 }).coverage.complete, true);

  // One source needing setup is enough to make the result incomplete.
  const oneMissing = allAsked.map((conclusion) =>
    conclusion.source === "chinadrugtrials"
      ? terminalise(cde, { needsSetup: true, reasonCode: "INDEX_EMPTY" })
      : conclusion,
  );
  const partial = aggregate({ query: "q", conclusions: oneMissing, elapsedMs: 1 });
  assert.equal(partial.coverage.complete, false);
  assert.deepEqual(partial.coverage.missingSources, ["chinadrugtrials"]);
  assert.equal(partial.sourcesQueried, 4);
  assert.equal(partial.sourcesUnavailable, 1);
});

test("the coverage sentence names the gaps and refuses to mean 'no results'", () => {
  const conclusions = TRIAL_SOURCES.map((source) =>
    terminalise(source, source.key === "who_ictrp" ? { timedOut: true } : ok([{ id: 1 }])),
  );
  const result = aggregate({ query: "q", conclusions, elapsedMs: 1 });
  assert.match(result.coverage.sentence, /只覆盖 4\/5 处来源/);
  assert.match(result.coverage.sentence, /未覆盖不等于没有结果/);
  assert.doesNotMatch(result.coverage.sentence, /五渠道汇总|各渠道数量/);
});

test("full coverage still says 'not every matching trial' when a lower bound is present", () => {
  const conclusions = TRIAL_SOURCES.map((source) =>
    terminalise(
      source,
      source.key === "who_ictrp"
        ? ok([{ trial_id: "A" }], { upstreamReportedTotal: 6952, matchedRowsReturned: 6262 })
        : ok([{ id: 1 }]),
    ),
  );
  const result = aggregate({ query: "q", conclusions, elapsedMs: 1 });
  assert.equal(result.coverage.complete, true);
  // Layer 3 must still refuse to read as "this is all of them".
  assert.equal(result.completeness.countsAreLowerBounds, true);
  assert.deepEqual(result.completeness.upstreamIncompleteSources, ["who_ictrp"]);
  assert.match(result.completeness.sentence, /上下界|下界/);
  assert.match(result.completeness.sentence, /6262/);
  assert.match(result.completeness.sentence, /6952/);
});

test("no lower-bound source still refuses to claim the data is complete", () => {
  const sentence = completenessSentence([], []);
  assert.match(sentence, /未发现已知返回集不完整的来源/);
  assert.match(sentence, /不等于结果是全部符合条件的试验/);
});

test("aggregate merges the same trial arriving on two channels", () => {
  // This test used to assert the opposite ("without deduplicating here"), on the
  // theory that de-duplication was the F2 merge's job and not the fan-out's.
  // §15.24 established that the fan-out must merge too: a ChiCTR trial reached
  // directly and again through ICTRP was counted twice, which turns the
  // documented lower bound into an inflated number. The old assertion passed
  // only because neither registration field was keyed yet, so the merge had
  // nothing to match on — it was testing the gap, not the contract.
  const conclusions = [
    terminalise(chictr, ok([{ registration_number: "ChiCTR1" }])),
    terminalise(ictrp, ok([{ trial_id: "ChiCTR1", source_register: "ChiCTR" }])),
  ];
  const result = aggregate({ query: "q", conclusions, elapsedMs: 1 });
  assert.equal(result.totalRecords, 1, "同一试验经两条通道到达必须合并为一条");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].merged, true);
  // The counts stay a lower bound whenever an aggregator was involved — ICTRP's
  // row set is systematically short of its own upstream total, independent of
  // how many channels answered. Merging must not be read as completing it.
  assert.equal(result.completeness.countsAreLowerBounds, true);
});

test("a cancelled run keeps finished results and marks the rest as not queried", () => {
  const conclusions = [
    terminalise(chictr, ok([{ id: 1 }])),
    terminalise(ctgov, { cancelled: true }),
  ];
  const result = aggregate({ query: "q", conclusions, elapsedMs: 1, cancelled: true });
  assert.equal(result.cancelled, true);
  assert.equal(result.records.length, 1);
  const ctgovStatus = result.statuses.find((status) => status.source === "clinicaltrials_gov");
  assert.equal(ctgovStatus.state, "NOT_QUERIED");
  assert.equal(ctgovStatus.reasonCode, "TURN_CANCELLED");
});

test("the result carries the non-medical-advice disclaimer", () => {
  const result = aggregate({ query: "q", conclusions: [], elapsedMs: 1 });
  assert.match(result.disclaimer, /不构成医疗建议/);
});

test("coverageSentence is total: it handles an empty table", () => {
  assert.equal(coverageSentence([]), "本次没有可汇总的来源。");
});

test("no conclusion ever exposes a local absolute path", () => {
  // §5.2: user-visible output must not carry local absolute paths, cookie
  // fields, or sensitive archive contents. The terminaliser only ever sees
  // what the broker reports, so it must not echo a path through `error`.
  const conclusion = terminalise(cde, { error: "failed reading /Users/someone/.ctv/ctv.db" });
  // The message may be shown, but the state must be a failure the UI can label
  // rather than a SUCCESS whose explanation is a path.
  assert.equal(conclusion.state, "FAILED");
  assert.equal(conclusion.records.length, 0);
});

// ---------------------------------------------------------------------------
// End to end: a real ICTRP child result reaches the UI's two numbers and the
// clause-4.b(3) date
//
// The component tests above inject camelCase `upstreamReportedTotal` straight
// into an outcome, which verifies `terminalise`'s arithmetic but not that
// anything ever produces those fields. The real payload arrives in snake_case
// inside an MCP `TextContent` block, so without a translation layer the UI's
// two-number block and its WHO date line would render "未报告" forever while
// the service was in fact reporting both. This test bridges that gap.
// ---------------------------------------------------------------------------

/** `ictrp_search`'s actual shape, wrapped the way `client.callTool` returns it. */
const ictrpChildResult = (overrides = {}) => ({
  ok: true,
  durationMs: 30,
  content: {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          matched_rows_returned: 6262,
          upstream_reported_total: 6952,
          records_incomplete: true,
          trials: [{ trial_id: "ACTRN12611000011910" }],
          provenance: { source: "WHO ICTRP", ictrp_export_date: "10/04/2026 15:26:10" },
          ...overrides,
        }),
      },
    ],
    isError: false,
  },
});

test("a real ICTRP payload yields both numbers and the WHO date at the aggregate", () => {
  const conclusion = terminalise(ictrp, interpretDispatchResult(ictrp, ictrpChildResult()));
  const result = aggregate({ query: "q", conclusions: [conclusion], elapsedMs: 1 });
  const status = result.statuses.find((s) => s.source === "who_ictrp");

  assert.equal(status.state, "SUCCESS");
  assert.equal(status.upstreamReportedTotal, 6952, "上游自报总数必须活着到达聚合结果");
  assert.equal(status.matchedRowsReturned, 6262, "实得行数必须活着到达聚合结果");
  assert.equal(
    status.processedAt,
    "10/04/2026 15:26:10",
    "条款 4.b(3) 的 WHO 处理日期必须活着到达聚合结果",
  );
  // The lower bound must still not be presented as the whole truth.
  assert.equal(result.completeness.countsAreLowerBounds, true);
});

test("an ICTRP result missing the WHO date still reports both numbers", () => {
  const conclusion = terminalise(
    ictrp,
    interpretDispatchResult(ictrp, ictrpChildResult({ provenance: { source: "WHO ICTRP" } })),
  );
  const result = aggregate({ query: "q", conclusions: [conclusion], elapsedMs: 1 });
  const status = result.statuses.find((s) => s.source === "who_ictrp");

  assert.equal(status.processedAt, undefined, "缺日期必须留空，不得用抓取时间顶替");
  assert.equal(status.upstreamReportedTotal, 6952);
  assert.equal(status.matchedRowsReturned, 6262);
});

test("a hand-configured shadowing MCP server reaches `overlaps` in the result", () => {
  // The user's own MCP server for ChiCTR is a second, un-de-duplicated channel
  // to the same registry. It must never be *dispatched* by the fan-out — but it
  // must be *reported*, because a merged count that includes both channels is no
  // longer a lower bound. Detection is unit-tested in
  // xyb-trials-registry.test.mjs; what this pins is that the finding survives
  // the trip through `aggregate` and out to the tool result the model reads.
  // Without this, the detector could work perfectly and still never be seen.
  const conclusions = TRIAL_SOURCES.map((source) => terminalise(source, ok([])));
  const result = aggregate({
    query: { keywords: "pancreatic cancer" },
    conclusions,
    elapsedMs: 12,
    manualOverlaps: [
      {
        serverId: "my-chictr-mirror",
        toolName: "search_trials",
        builtin: "chictr",
        builtinTool: "search_trials",
        manual: "my-chictr-mirror_search_trials",
      },
    ],
  });

  assert.equal(result.overlaps.length, 1, "手工配置的重叠服务器必须在结果里被报出来");
  assert.equal(result.overlaps[0].builtin, "chictr");
  // And it must NOT have been counted as a queried source: reporting overlap is
  // not the same as covering it.
  assert.equal(result.coverage.queried, TRIAL_SOURCES.length);
  assert.ok(
    !result.coverage.missingSources.includes("my-chictr-mirror"),
    "手工服务器不是本编排器的来源，不应出现在未覆盖清单里",
  );
});

test("the lower-bound reason code reaches the aggregated result", () => {
  // The reason code is only useful if it survives `aggregate`. A separate test
  // asserts `terminalise` sets it; this one pins the end-to-end path, because
  // the consumer that needs it (the UI deciding whether to print two numbers)
  // reads `statuses[]` from the aggregate, not from terminalise.
  const result = aggregate({
    query: "pancreatic cancer",
    conclusions: [
      terminalise(ictrp, ok([{ trial_id: "ACTRN1" }], {
        upstreamReportedTotal: 6952,
        matchedRowsReturned: 6262,
      })),
    ],
    elapsedMs: 1,
  });
  const s = result.statuses.find((x) => x.source === "who_ictrp");
  assert.equal(s.reasonCode, "UPSTREAM_RESULT_INCOMPLETE");
  assert.equal(s.upstreamIncomplete, true);
  assert.equal(result.completeness.countsAreLowerBounds, true);
  assert.equal(s.upstreamReportedTotal, 6952);
  assert.equal(s.matchedRowsReturned, 6262);
});

test("a complete source keeps the plain success reason code", () => {
  // The counterpart, so "every SUCCESS gets the incomplete code" cannot pass.
  const result = aggregate({
    query: "pancreatic cancer",
    conclusions: [terminalise(chictr, ok([{ id: 1 }]))],
    elapsedMs: 1,
  });
  const s = result.statuses.find((x) => x.source === "chictr");
  assert.equal(s.reasonCode, "OK");
  assert.equal(s.upstreamIncomplete, undefined);
});

test("every aggregate record carries the channel it came from", () => {
  // §15.16: attribution belongs on the record. The raw rows from all five back
  // ends carry no `source` key at all — the real ICTRP payload keys a trial by
  // `trial_id` and has no `source` — so the panel's `it.source` resolved to
  // undefined and the record-level attribution never appeared. The aggregate
  // is the only layer that knows which channel produced a given row.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ trial_id: "ChiCTR2400081234" }])),
      terminalise(ctgov, ok([{ nctId: "NCT01234567" }])),
    ],
    elapsedMs: 3,
  });
  assert.equal(result.records.length, 2);
  for (const record of result.records) {
    assert.ok(record.source, `记录缺少 source：${JSON.stringify(record)}`);
    assert.ok(record.sourceLabel, "记录缺少 sourceLabel，面板会显示「来源：undefined」");
  }
  const bySource = Object.fromEntries(result.records.map((r) => [r.source, r.sourceLabel]));
  assert.equal(bySource.chictr, chictr.label);
  assert.equal(bySource.clinicaltrials_gov, ctgov.label);
  // The caller's own fields must survive — tagging adds, never replaces.
  const chictrRecord = result.records.find((r) => r.source === "chictr");
  assert.equal(chictrRecord.trial_id, "ChiCTR2400081234");
});

test("a first-hand trial reached through the aggregator is labelled via WHO ICTRP", () => {
  // §15.7 + §15.9 criterion 6. The ICTRP payload reports the registry a trial
  // came from in `source_register`; when that is ChiCTR, the row is a copy of a
  // ChiCTR record and must NOT be labelled plain "ChiCTR" — the user would go
  // verify updates at the wrong portal. Terms 4.b(1) is why the label exists.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(ictrp, ok([{ trial_id: "ChiCTR2400081234", source_register: "ChiCTR" }])),
    ],
    elapsedMs: 3,
  });
  const record = result.records[0];
  assert.equal(record.source, "who_ictrp", "记录必须标出真正投递它的渠道");
  assert.match(record.sourceLabel, /^ChiCTR.* via WHO ICTRP$/, `标注错误：${record.sourceLabel}`);
  assert.ok(
    !/^WHO ICTRP/.test(record.sourceLabel),
    "经聚合库收录的 ChiCTR 试验不得只标 WHO ICTRP，用户会去错门户核对更新",
  );
  assert.equal(record.sourceViaAggregator, "who_ictrp");
  assert.equal(record.sourceFirstHand, "chictr");
  // A non-first-hand row from the same aggregator is just "WHO ICTRP".
  const anzc = aggregate({
    query: "q",
    conclusions: [terminalise(ictrp, ok([{ trial_id: "ACTRN12605000026628" }]))],
    elapsedMs: 3,
  }).records[0];
  assert.match(anzc.sourceLabel, /WHO ICTRP/);
  assert.ok(!/via/.test(anzc.sourceLabel), "无关的一手来源不得被写成「via」关系");
});

test("the host overlap map agrees with the plugin's own copy", () => {
  // The overlap map is duplicated in the orchestrator because the Electron main
  // process must not import a plugin's private modules. A duplicate can drift,
  // and drift here means silently mislabelling records — so the two copies are
  // compared here and a divergence fails a test instead of confusing a user.
  const pluginSource = readFileSync(
    new URL("../resources/plugins/xyb.trials/lib/unified.js", import.meta.url),
    "utf8",
  );
  for (const key of ["chictr", "clinicaltrials_gov", "chinadrugtrials"]) {
    assert.ok(
      pluginSource.includes(`who_ictrp: [`) || pluginSource.includes(`"${key}"`) || pluginSource.includes(`'${key}'`),
      `插件端的重叠表未提到 ${key}`,
    );
  }
  // And the host map must not claim an aggregator re-publishes a source the
  // plugin does not know about: a fabricated "Veeva via WHO ICTRP" relationship
  // is exactly the invention §15.7 forbids.
  assert.ok(
    !pluginSource.includes("veeva_ctv: ["),
    "插件端把 veeva 当作可经聚合库收录的来源，与宿主端不一致",
  );
});

test("the same trial from two channels is merged, not counted twice", () => {
  // §15.5 merge rules 1-2 + §5.3 rule 4. Before this, the fan-out returned the
  // same ChiCTR trial twice — once direct, once via ICTRP — and reported
  // totalRecords: 2. §15.10 claimed the merge rules were built; they were not.
  // A double-counted total is the number-collapse §5.3 forbids, in the
  // direction that inflates.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "ChiCTR2400081234", title: "Gemcitabine" }])),
      terminalise(
        ictrp,
        ok([{ trial_id: "ChiCTR2400081234", source_register: "ChiCTR", title: "Gemcitabine" }], {
          upstreamReportedTotal: 6952,
          matchedRowsReturned: 1,
        }),
      ),
    ],
    elapsedMs: 9,
  });
  assert.equal(result.totalRecords, 1, "同一试验经两条通道到达时只能计一条");
  const record = result.records[0];
  // §15.5 rule 1: the first-hand copy wins, because ICTRP syncs weekly.
  assert.equal(record.source, "chictr");
  assert.deepEqual(record.mergedFrom, ["chictr", "who_ictrp"]);
  // §5.3: overlapWith names the sources that had this same trial.
  assert.deepEqual(record.overlapWith, ["who_ictrp"]);
  assert.equal(record.source, "chictr");
  // The losing version is preserved, so the merge is auditable rather than lossy.
  assert.equal(record.perSource.length, 2);
  assert.deepEqual(
    record.sourceLabels.map((entry) => entry.source),
    ["chictr", "who_ictrp"],
  );
  // And the aggregator's lower-bound standing is unaffected by the merge.
  assert.equal(result.completeness.countsAreLowerBounds, true);
});

test("registration numbers are folded for identity but never fuzzy-matched", () => {
  // Same trial, different punctuation/case in the number → one record.
  const folded = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "ChiCTR-IPR-17012345" }])),
      terminalise(ictrp, ok([{ trial_id: "chictripr17012345" }])),
    ],
    elapsedMs: 2,
  });
  assert.equal(folded.totalRecords, 1, "大小写与分隔符差异不得造成重复计数");

  // Different trials must never merge, however similar the numbers look.
  const distinct = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "ChiCTR2400081234" }])),
      terminalise(ctgov, ok([{ nctId: "NCT01234567" }])),
    ],
    elapsedMs: 2,
  });
  assert.equal(distinct.totalRecords, 2, "不同登记号必须是两条记录");
});

test("a record with no registration number never merges", () => {
  // §5.3 rule: identity requires a registration number. Two untitled rows from
  // different channels are kept apart — merging them on a title hint would let
  // the UI assert an identity nobody established.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ title: "A study of gemcitabine" }])),
      terminalise(ictrp, ok([{ title: "A study of gemcitabine" }])),
    ],
    elapsedMs: 2,
  });
  assert.equal(result.totalRecords, 2, "缺登记号的记录不得因标题相似而合并");
  for (const record of result.records) {
    assert.ok(!record.overlapWith || record.overlapWith.length === 0);
  }
});

test("an aggregator-only row survives the merge", () => {
  // §15.5 rule 3: an ICTRP row must not be dropped for being "extra". It may be
  // precisely the trial the first-hand channels are missing (JPRN and the other
  // registries we do not query directly).
  const result = aggregate({
    query: "q",
    conclusions: [terminalise(ictrp, ok([{ trial_id: "JPRN-UMIN000012345" }]))],
    elapsedMs: 2,
  });
  assert.equal(result.totalRecords, 1);
  assert.match(String(result.records[0].sourceLabel), /WHO ICTRP/);
});

test("the same trial arriving on two channels becomes one record", () => {
  // §15.5 merge rule 1 + §5.3 `overlapWith`. Before this the fan-out counted a
  // ChiCTR trial twice — once direct, once via ICTRP — and reported
  // `totalRecords: 2`. The SPEC's "counts are a lower bound" promise is about
  // the upstream being incomplete; a self-inflicted double count is not a lower
  // bound at all, it is an inflated number wearing the same label.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "ChiCTR2400081234", title: "T" }])),
      terminalise(ictrp, ok([{ trial_id: "ChiCTR2400081234", source_register: "ChiCTR", title: "T" }])),
    ],
    elapsedMs: 4,
  });
  assert.equal(result.totalRecords, 1, "同一条试验经两条通道到达必须合并为一条");
  const record = result.records[0];
  // First-hand wins over the aggregator: a ChiCTR copy is current, ICTRP syncs
  // weekly. Clauses 1-2 of §15.5.
  assert.equal(record.source, "chictr");
  assert.deepEqual(record.mergedFrom, ["chictr", "who_ictrp"]);
  assert.deepEqual(record.overlapWith, ["who_ictrp"]);
  // The loser is not discarded — the merge must stay auditable.
  assert.equal(record.perSource.length, 2);
  assert.deepEqual(
    record.sourceLabels.map((entry) => entry.source).sort(),
    ["chictr", "who_ictrp"],
  );
  // Separator/case folding only: ChiCTR-IPR-17012345 and ChiCTRIPR17012345 are
  // the same trial, and the fold must not go further than that.
  const folded = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "ChiCTR-IPR-17012345" }])),
      terminalise(ictrp, ok([{ trial_id: "chictripr17012345", source_register: "ChiCTR" }])),
    ],
    elapsedMs: 4,
  });
  assert.equal(folded.totalRecords, 1, "大小写与分隔符差异不得造成重复");
});

test("records without a registration number never merge on a title match", () => {
  // §15.5 rule 3: a matching title is a hint, not identity. Merging two
  // different trials because their titles look alike invents a clinical fact.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ title: "Gemcitabine in pancreatic cancer" }])),
      terminalise(ictrp, ok([{ scientific_title: "Gemcitabine in pancreatic cancer" }])),
    ],
    elapsedMs: 4,
  });
  assert.equal(result.totalRecords, 2, "缺登记号时标题相同也不得自动合并");
  for (const record of result.records) {
    assert.ok(!record.overlapWith, "未合并的记录不得带 overlapWith");
    assert.ok(!("merged" in record) || record.merged !== true);
  }
});

test("a record carried only by the aggregator still survives the merge", () => {
  // §15.5 rule 3. De-duplication must not silently delete the trials only the
  // aggregator knows about — those may be exactly what the other channels miss.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "ChiCTR2400081234" }])),
      terminalise(
        ictrp,
        ok([
          { trial_id: "ChiCTR2400081234", source_register: "ChiCTR" },
          { trial_id: "ACTRN12605000026628", source_register: "ANZCTR" },
        ]),
      ),
    ],
    elapsedMs: 4,
  });
  assert.equal(result.totalRecords, 2, "聚合库独有的试验不得因去重而消失");
  const actrn = result.records.find((r) => r.sourceLabel && /WHO ICTRP/.test(r.sourceLabel));
  assert.ok(actrn, "仅在聚合库中的试验必须保留，并标注为 WHO ICTRP");
  // And merging must not disturb the lower-bound statement.
  assert.equal(result.completeness.countsAreLowerBounds, true);
});

test("a merge keeps at least one copy of every source that reported the trial", () => {
  // The audit trail requirement — a user asking "why does this say ChiCTR when
  // I searched ICTRP" must be able to see that both channels had it.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "ChiCTR2400081234", title: "direct copy" }])),
      terminalise(ictrp, ok([{ trial_id: "ChiCTR2400081234", source_register: "ChiCTR", title: "aggregator copy" }])),
      terminalise(ctgov, ok([{ nctId: "NCT01234567", title: "unrelated" }])),
    ],
    elapsedMs: 4,
  });
  assert.equal(result.totalRecords, 2, "无关的试验不得被卷进合并");
  const merged = result.records.find((r) => r.merged === true);
  assert.ok(merged, "必须有且仅有一条合并记录");
  assert.equal(merged.perSource.length, 2);
  assert.ok(
    merged.perSource.some((r) => r.title === "aggregator copy"),
    "被覆盖的那一份必须留在 perSource 里，不能静默丢弃",
  );
});

test("records expose the URL and date their registry actually publishes", () => {
  // The panel renders "查看原始登记信息" from `sourceUrl` and "信息更新于" from
  // `fetchedAt`. The registries publish neither name: the real ICTRP snapshot
  // carries `web_address` on 6262/6262 rows and the bundled ChiCTR archive
  // carries `detail_url` on 468/468. Nothing resolved either name, so on the
  // fan-out path every link and every date was missing — measured 0 of 40 real
  // records produced an openable link. A citation the user cannot open is not a
  // citation, and WHO terms 4.b(1) presumes the attributed source is reachable.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "ChiCTR2400081234", detail_url: "https://www.chictr.org.cn/x", updated_at: "2026-10-04T22:16:46+08:00" }])),
      terminalise(ictrp, ok([{ trial_id: "ACTRN12605000026628", web_address: "https://anzctr.org.au/a.aspx", last_refreshed_date: "2020-01-13" }])),
    ],
    elapsedMs: 4,
  });
  const bySource = Object.fromEntries(result.records.map((r) => [r.source, r]));
  assert.equal(bySource.chictr.sourceUrl, "https://www.chictr.org.cn/x");
  assert.equal(bySource.who_ictrp.sourceUrl, "https://anzctr.org.au/a.aspx");
  // Dates are carried through as published, never replaced with today's date:
  // printing today would assert a refresh nobody performed.
  assert.equal(bySource.chictr.fetchedAt, "2026-10-04T22:16:46+08:00");
  assert.equal(bySource.who_ictrp.fetchedAt, "2020-01-13");
});

test("a record with no published date reports none rather than today", () => {
  // §15.15's rule applied to records: absence must stay absent. A fallback to
  // the current date looks authoritative and is wrong.
  const result = aggregate({
    query: "q",
    conclusions: [terminalise(chictr, ok([{ id: "ChiCTR2400081234", title: "no dates published" }]))],
    elapsedMs: 4,
  });
  const record = result.records[0];
  assert.ok(!record.fetchedAt, `缺少发布日期时不得编造，实得 ${JSON.stringify(record.fetchedAt)}`);
  assert.ok(!record.sourceUrl, "缺少链接时不得编造");
  // The source attribution must still be present even when the link is not.
  assert.ok(record.sourceLabel, "没有链接也要标出来源");
});

test("an explicit sourceUrl is not overwritten by a source-specific alias", () => {
  // Precedence matters: a caller that already normalised its row keeps its
  // value, and the alias is only a fallback.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ id: "A1", sourceUrl: "https://chosen.example/x", detail_url: "https://other.example/y" }])),
    ],
    elapsedMs: 4,
  });
  assert.equal(result.records[0].sourceUrl, "https://chosen.example/x");
});

test("a ChiCTR row is recognised by the field name the archive actually uses", () => {
  // The bundled ChiCTR archive calls it `registration_number` on 468 of 468
  // rows and carries no `registryId` / `registry_id` / `nctId` / `id` at all.
  // It was missing from the candidate list, so every ChiCTR row was "unkeyed"
  // and could never merge against the 579 ChiCTR-attributed rows in the ICTRP
  // snapshot. Measured on the real seeds: 0 duplicates found where 438 exist.
  // The merge rules were right; they were starved of input.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ registration_number: "ChiCTR-DCC-14004957", title: "first hand" }])),
      terminalise(ictrp, ok([{ trial_id: "ChiCTR-DCC-14004957", source_register: "ChiCTR", scientific_title: "via aggregator" }])),
    ],
    elapsedMs: 4,
  });
  assert.equal(result.totalRecords, 1, "随包 ChiCTR 的 registration_number 必须能参与合并");
  const record = result.records[0];
  assert.equal(record.merged, true);
  assert.deepEqual(record.mergedFrom, ["chictr", "who_ictrp"]);
  // First-hand wins: the ChiCTR copy is current, ICTRP syncs weekly.
  assert.equal(record.source, "chictr");
});

test("the plugin and the host agree on which field carries a registration number", async () => {
  // Two implementations of the same rule living in two languages. Divergence
  // here is silent: the plugin would merge rows the host leaves split (or the
  // reverse), and both would look correct in isolation. Assert the field-name
  // sets overlap on everything either side claims to read.
  const { readFileSync } = await import("node:fs");
  const host = readFileSync(new URL("../electron/main/trial-orchestrator.ts", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../resources/plugins/xyb.trials/lib/unified.js", import.meta.url), "utf8");
  // The names that matter on real payloads; both sides must list each one.
  for (const field of ["registration_number", "trial_id", "registry_id", "nctId", "reg_no"]) {
    assert.ok(
      new RegExp(`["']${field}["']`).test(host),
      `宿主登记号候选缺少 ${field}（真实载荷会带它）`,
    );
    assert.ok(
      new RegExp(`\\b${field}\\b`).test(plugin),
      `插件登记号候选缺少 ${field}（真实载荷会带它）`,
    );
  }
});

test("an ICTRP row is titled and statused by the field names the snapshot uses", () => {
  // The snapshot carries no `title` / `brief_title` / `name` (0 of 6262) and no
  // `status` / `overall_status` / `sourceStatusRaw` (0 of 6262). It uses
  // `scientific_title` (6221) and `recruitment_status` (6233). With neither name
  // in the candidate list, every ICTRP record went to the panel untitled and
  // unstatused — measured 0 of 50 — so the user saw a column of blank cards.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(ictrp, ok([
        { trial_id: "NCT1", scientific_title: "Gemcitabine in pancreatic cancer", recruitment_status: "Not Recruiting", source_register: "ClinicalTrials.gov" },
      ])),
    ],
    elapsedMs: 3,
  });
  const record = result.records[0];
  assert.equal(record.title, "Gemcitabine in pancreatic cancer");
  assert.equal(record.sourceStatusRaw, "Not Recruiting");
});

test("a source that reports its own title keeps it", () => {
  // The aliases are fallbacks, not overrides: ChiCTR ships a real `title` and
  // must not have it replaced by some other column that happens to be present.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(chictr, ok([{ registration_number: "ChiCTR1", title: "own title", scientific_title: "other column" }])),
    ],
    elapsedMs: 3,
  });
  assert.equal(result.records[0].title, "own title");
});

test("public_title is the fallback for rows without a scientific title", () => {
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(ictrp, ok([{ trial_id: "NCT2", public_title: "public only", recruitment_status: "Recruiting" }])),
    ],
    elapsedMs: 3,
  });
  assert.equal(result.records[0].title, "public only");
});

test("host and plugin resolve titles and statuses from the same real field names", async () => {
  // Same cross-implementation parity guard as the registration-number test: the
  // two implementations live in different languages and directories, so a name
  // added to one and not the other is a silent divergence. These are the names
  // that appear on the real bundled payloads.
  const { readFileSync } = await import("node:fs");
  const host = readFileSync(new URL("../electron/main/trial-orchestrator.ts", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../resources/plugins/xyb.trials/lib/unified.js", import.meta.url), "utf8");
  for (const field of ["scientific_title", "public_title", "recruitment_status"]) {
    assert.ok(new RegExp(`["']${field}["']`).test(host), `宿主候选表缺少 ${field}（真实 ICTRP 载荷会带它）`);
    assert.ok(new RegExp(`\\b${field}\\b`).test(plugin), `插件候选表缺少 ${field}（真实 ICTRP 载荷会带它）`);
  }
});

test("a record carries the id the panel tags cards with", () => {
  // The panel renders every card's registration-number tag from `it.id`
  // (trials.html:215) and falls back to `it.title || it.id` for the heading
  // (trials.html:212). The host resolved the registry id only to group rows for
  // merging and never wrote it back, so on the fan-out path the tag was always
  // empty — 40 of 40 records had an id and none of them showed it.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(ictrp, ok([{ trial_id: "ACTRN12605000026628", scientific_title: "T", recruitment_status: "Recruiting" }])),
    ],
    elapsedMs: 3,
  });
  assert.equal(result.records[0].id, "ACTRN12605000026628");
});

test("an ICTRP record shows its country and a ChiCTR record its institution", () => {
  // `locations` is absent from both real payloads (0 of 6262 and 0 of 468).
  // ICTRP publishes `countries` (5845 of 6262, a string array) and ChiCTR
  // publishes `institution` (468 of 468). Measured before the fix: 0 of 40
  // records rendered the panel's 地点 line.
  const result = aggregate({
    query: "q",
    conclusions: [
      terminalise(ictrp, ok([{ trial_id: "NCT1", countries: ["Australia", "Japan"] }])),
      terminalise(chictr, ok([{ registration_number: "ChiCTR1", institution: "西安交通大学第一附属医院" }])),
    ],
    elapsedMs: 3,
  });
  const ictrpRecord = result.records.find((r) => r.source === "who_ictrp");
  const chictrRecord = result.records.find((r) => r.source === "chictr");
  assert.deepEqual(ictrpRecord.locations, ["Australia", "Japan"]);
  assert.deepEqual(chictrRecord.locations, ["西安交通大学第一附属医院"]);
});

test("a record with no location gets no location, not a placeholder", () => {
  // An unknown location is not "unknown-location". A placeholder would render a
  // 地点 line that says nothing while looking like it says something.
  const result = aggregate({
    query: "q",
    conclusions: [terminalise(ictrp, ok([{ trial_id: "NCT1" }]))],
    elapsedMs: 3,
  });
  assert.equal(result.records[0].locations, undefined);
});

test("host and plugin resolve ids and locations from the same real field names", async () => {
  const { readFileSync } = await import("node:fs");
  const host = readFileSync(new URL("../electron/main/trial-orchestrator.ts", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../resources/plugins/xyb.trials/lib/unified.js", import.meta.url), "utf8");
  for (const field of ["countries", "institution"]) {
    assert.ok(new RegExp(`["']${field}["']`).test(host), `宿主地点候选缺少 ${field}（真实载荷会带它）`);
    assert.ok(new RegExp(`\\b${field}\\b`).test(plugin), `插件地点候选缺少 ${field}（真实载荷会带它）`);
  }
  // The plugin must emit `id`: the panel's tag reads it and nothing else.
  assert.ok(/\bid:\s*registryId/.test(plugin), "插件必须把 registryId 作为 id 输出，否则面板的登记号标签永远为空");
});


test("the overlap warning ships as a sentence the assistant can quote", () => {
  // `coverage` and `completeness` each carry a `.sentence` and the skill tells
  // the model to reproduce both verbatim. The overlap warning shipped only as an
  // array of objects, so on the assistant path there was nothing to quote — the
  // one place the wording existed was the panel's own renderer. A warning whose
  // text lives in a view is a warning the chat path cannot relay.
  const overlaps = [
    { serverId: "chictr", toolName: "search_trials", builtin: "chictr", builtinTool: "t", manual: "mcp_chictr" },
    { serverId: "who-ictrp", toolName: "ictrp_search", builtin: "who_ictrp", builtinTool: "t", manual: "mcp_who-ictrp" },
  ];
  const sentence = overlapSentence(overlaps);
  assert.match(sentence, /mcp_chictr/);
  assert.match(sentence, /mcp_who-ictrp/);
  // It must say the consequence, not just the fact. "Two channels overlap" alone
  // reads like a tidiness note; the load-bearing part is that the number stops
  // being a lower bound, which is exactly what §5.3 forbids silently dropping.
  assert.match(sentence, /没有去重/);
  assert.match(sentence, /不再是下界/);

  // No overlaps -> empty string, so callers test one thing.
  assert.equal(overlapSentence([]), "");
  assert.equal(overlapSentence(undefined), "");

  // And aggregate must actually carry it.
  const result = aggregate({
    query: "q",
    conclusions: [],
    elapsedMs: 1,
    manualOverlaps: overlaps,
  });
  assert.equal(result.overlapsSentence, sentence);
});

test("the overlap sentence survives a manual server with no display name", () => {
  // `manual` is the host-qualified tool name; when a caller builds the overlap
  // record without it, the sentence must still name something instead of
  // printing "undefined 与 内置的「chictr」…".
  const sentence = overlapSentence([
    { serverId: "chictr", toolName: "", builtin: "chictr", builtinTool: "t", manual: "" },
  ]);
  assert.match(sentence, /chictr/);
  assert.doesNotMatch(sentence, /undefined|null/);
});
