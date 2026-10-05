/**
 * Trial-query fan-out broker: dispatch, deadline, and denial-mapping tests.
 *
 * SPEC: docs/spec/xyb-unified-trial-host-orchestration.md §4.1, §4.2, §4.4
 *
 * The failure these exist to prevent: host-core reports a permission denial and
 * a capacity rejection as a *normal* result (`ok:false` plus an `errorCode`),
 * not as a JSON-RPC error. A broker that only wraps dispatch in try/catch sees
 * five successes and renders denials as empty result sets — which is the
 * 2026-10-03 mislabel all over again, with the user losing results that were
 * there for the taking.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createFanoutBroker,
  detectChallenge,
  extractRecords,
  interpretDispatchResult,
  normalizeQuery,
  runFanout,
  runTrialComposite,
} from "../electron/main/trial-fanout.ts";
import { OVERALL_DEADLINE_MS, dispatchOrder, sourceByKey } from "../electron/main/trial-sources.ts";
import { aggregate, isQueried } from "../electron/main/trial-orchestrator.ts";

const chictr = sourceByKey("chictr");
const ictrp = sourceByKey("who_ictrp");
const cde = sourceByKey("chinadrugtrials");

const okResult = (content, durationMs = 10) => ({ ok: true, content, durationMs });
const errResult = (errorCode, error = "", extra = {}) => ({
  ok: false,
  errorCode,
  content: { error },
  durationMs: 10,
  ...extra,
});

// ---------------------------------------------------------------------------
// Host result → outcome mapping
// ---------------------------------------------------------------------------

test("a denied child is NOT_QUERIED, not an empty result set", () => {
  // The signal is `denied: true` on a normal result. Missing it would turn a
  // refusal into "0 trials found".
  const outcome = interpretDispatchResult(chictr, errResult("TOOL_DENIED", "permission denied", { denied: true }));
  assert.equal(outcome.denied, true);
  assert.equal(outcome.records, undefined);
});

test("a Plan-mode denial is a denial, not a setup problem", () => {
  const outcome = interpretDispatchResult(chictr, errResult("PLUGIN_DISABLED_IN_PLAN", "plugin disabled in plan"));
  assert.equal(outcome.denied, true);
  assert.notEqual(outcome.needsSetup, true);
});

test("an aborted child is CANCELLED", () => {
  for (const code of ["TOOL_ABORTED", "TOOL_TURN_CANCELLED"]) {
    const outcome = interpretDispatchResult(chictr, errResult(code, "tool aborted"));
    assert.equal(outcome.cancelled, true, `${code} should mean cancelled`);
  }
});

test("the host's own dispatch timeout is TIMEOUT, not an error", () => {
  const outcome = interpretDispatchResult(ictrp, errResult("TOOL_TIMEOUT", "dispatch timed out"));
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.error, undefined);
});

test("a vanished tool is an availability problem, not a source failure", () => {
  // Host-core says NOT_FOUND when the tool left the catalog between the
  // composite's approval and the child's start.
  const outcome = interpretDispatchResult(cde, errResult("TOOL_NOT_FOUND", "plugin tool not loaded"));
  assert.equal(outcome.toolRegistered, false);
  assert.equal(outcome.error, undefined);
});

test("capacity pressure surfaces the real reason instead of a fake zero", () => {
  const outcome = interpretDispatchResult(
    chictr,
    errResult("HOST_OVERLOADED", "host tool capacity did not become available in time"),
  );
  assert.equal(outcome.reasonCode, "HOST_OVERLOADED");
  assert.match(outcome.error, /capacity did not become available/);
  assert.equal(outcome.records, undefined);
});

test("an error code with no message still becomes a failure, never a success", () => {
  const outcome = interpretDispatchResult(chictr, errResult("SOMETHING_NEW"));
  assert.ok(outcome.error);
  assert.equal(outcome.reasonCode, "SOMETHING_NEW");
});

test("a missing result object is a failure, not an empty success", () => {
  const outcome = interpretDispatchResult(chictr, undefined);
  assert.ok(outcome.error);
  assert.equal(outcome.records, undefined);
});

test("ok:true with records maps straight through", () => {
  const outcome = interpretDispatchResult(chictr, okResult({ records: [{ id: 1 }, { id: 2 }] }, 42));
  assert.deepEqual(outcome.records, [{ id: 1 }, { id: 2 }]);
  assert.equal(outcome.elapsedMs, 42);
});

// ---------------------------------------------------------------------------
// The two ICTRP numbers and the WHO-processed date, off the real payload
//
// `ictrp_search` answers in snake_case and nests the WHO-processed date inside
// `provenance` (ictrp_mcp/tools.py `search()`: `upstream_reported_total`,
// `matched_rows_returned`, `provenance.to_dict()`). The orchestrator's
// `terminalise` reads camelCase `upstreamReportedTotal` / `matchedRowsReturned`
// off the *outcome*, so somebody has to translate. That translation is this
// function's job, and nothing checked it: the existing coverage injected the
// camelCase fields straight into the outcome, which asserted `terminalise`'s
// arithmetic while the real payload produced nothing.
//
// SPEC §15.5 / §15.8: the two numbers are separate and the WHO date is a
// disclosure obligation under ICTRP terms 4.b(3).
// ---------------------------------------------------------------------------

/** The shape `ictrp_search` actually returns, taken from tools.py `search()`. */
const ictrpPayload = (extra = {}) => ({
  status: "ok",
  set_id: "search:abc",
  matched_rows_returned: 6262,
  upstream_reported_total: 6952,
  records_incomplete: true,
  counts_are_of_retrieved_rows_not_of_matching_trials: true,
  // THREE trials, not one. A single-record fixture cannot tell the difference
  // between "the records inside the envelope" and "the envelope itself": both
  // have length 1, so a `return content` that never unwraps passes. That is not
  // hypothetical — it shipped, and every MCP source reported exactly 1 result.
  trials: [
    { trial_id: "ACTRN12611000011910" },
    { trial_id: "ACTRN12611000011911" },
    { trial_id: "ACTRN12611000011912" },
  ],
  provenance: {
    source: "WHO ICTRP",
    ictrp_export_date: "10/04/2026 15:26:10",
    rows_returned: 0,
  },
  ...extra,
});

test("the two ICTRP numbers survive a real snake_case payload", () => {
  const outcome = interpretDispatchResult(ictrp, okResult(ictrpPayload()));
  assert.equal(outcome.upstreamReportedTotal, 6952, "上游自报总数必须从 upstream_reported_total 取到");
  assert.equal(outcome.matchedRowsReturned, 6262, "实得行数必须从 matched_rows_returned 取到");
  assert.notEqual(
    outcome.upstreamReportedTotal,
    outcome.matchedRowsReturned,
    "两个数字不得被压成一个",
  );
});

test("the WHO-processed date is read from provenance, not from the fetch time", () => {
  const outcome = interpretDispatchResult(ictrp, okResult(ictrpPayload()));
  assert.equal(
    outcome.processedAt,
    "10/04/2026 15:26:10",
    "条款 4.b(3) 要求显示 WHO 处理日期；它只在 provenance.ictrp_export_date 里",
  );
});

test("a missing WHO date stays undefined rather than being invented", () => {
  // A live payload whose export_date_raw was absent on every row: tools.py then
  // never sets provenance.ictrp_export_date. Absence must stay absence — the
  // seed's field_note says exactly this, and "我们何时取的" is a different fact.
  const outcome = interpretDispatchResult(
    ictrp,
    okResult(ictrpPayload({ provenance: { source: "WHO ICTRP" } })),
  );
  assert.equal(outcome.processedAt, undefined);
  assert.equal(outcome.upstreamReportedTotal, 6952, "缺日期不影响两个数字");
});

test("a source that is not the aggregator carries no lower-bound numbers", () => {
  // The lower-bound contract belongs to ICTRP alone (§15.2). chiCTR's envelope
  // must not pick up the keys by accident.
  const outcome = interpretDispatchResult(chictr, okResult({ records: [{ id: 1 }] }));
  assert.equal(outcome.upstreamReportedTotal, undefined);
  assert.equal(outcome.processedAt, undefined);
});

// ---------------------------------------------------------------------------
// The same payload as it actually arrives: inside an MCP TextContent block
//
// `plugin-mcp.ts` `callTool` returns the raw protocol result —
// `{content: [{type: "text", text: "<json>"}], isError}` — while a
// plugin-registered tool returns its structured value directly. Both reach the
// broker by the same route. Every existing test in this file fed the *parsed*
// envelope, so the wrapper was invisible: in production `asBag(content)` would
// find no `trials`, no `upstream_reported_total` and no `provenance`, and the
// channel would have looked empty while being perfectly healthy.
// ---------------------------------------------------------------------------

/** Wrap a payload exactly the way `client.callTool` delivers it. */
const asMcpText = (payload) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  isError: false,
});

test("records are found inside an MCP TextContent block", () => {
  const outcome = interpretDispatchResult(ictrp, okResult(asMcpText(ictrpPayload())));
  // Assert the COUNT, not just membership: the failure mode is that the wrapper
  // array (always length 1) is mistaken for the record list, which yields one
  // pseudo-record per MCP source however many rows it really returned.
  assert.equal(outcome.records.length, 3, "必须解出信封里的三条记录，而不是信封本身");
  assert.deepEqual(outcome.records[0], { trial_id: "ACTRN12611000011910" });
});

test("the two ICTRP numbers and the WHO date survive the TextContent wrapper", () => {
  const outcome = interpretDispatchResult(ictrp, okResult(asMcpText(ictrpPayload())));
  assert.equal(outcome.upstreamReportedTotal, 6952);
  assert.equal(outcome.matchedRowsReturned, 6262);
  assert.equal(outcome.processedAt, "10/04/2026 15:26:10");
});

test("a plain-text answer is left alone rather than silently emptied", () => {
  // A parse failure must not be laundered into an empty result: that would turn
  // "we could not read this" into "there is nothing here".
  const content = { content: [{ type: "text", text: "upstream rejected the request" }] };
  assert.throws(
    () => interpretDispatchResult(ictrp, okResult(content)),
    /unrecognised envelope/,
    "无法解析的载荷必须抛错，而不是变成空结果",
  );
});

test("a structured plugin result passes through unwrapping unchanged", () => {
  // The CT.gov source is a plugin-registered tool and answers structurally.
  const outcome = interpretDispatchResult(chictr, okResult({ records: [{ id: 7 }] }));
  assert.deepEqual(outcome.records, [{ id: 7 }]);
});

// ---------------------------------------------------------------------------
// Challenge detection — never worked around
// ---------------------------------------------------------------------------

test("a challenge is detected even though it arrives as HTTP 200", () => {
  assert.equal(detectChallenge({ challenge: true }), true);
  assert.equal(detectChallenge({ challengeRequired: true }), true);
  assert.equal(detectChallenge({ code: "CHALLENGE_REQUIRED" }), true);
  assert.equal(detectChallenge({ errorCode: "SOURCE_CHALLENGE" }), true);
  assert.equal(detectChallenge({ records: [] }), false);
  assert.equal(detectChallenge(null), false);
});

test("a challenge-flagged success becomes CHALLENGE_REQUIRED, never records", () => {
  const outcome = interpretDispatchResult(chictr, okResult({ challenge: true, records: [] }));
  assert.equal(outcome.challenge, true);
  assert.equal(outcome.records, undefined);
});

// ---------------------------------------------------------------------------
// Record extraction — an unknown envelope must not read as zero
// ---------------------------------------------------------------------------

test("extractRecords reads each known envelope shape", () => {
  // Two records per fixture, deliberately. With one record the length cannot
  // distinguish "the records" from "the container", so a wrong implementation
  // passes; that is precisely the bug §15.19 records.
  const two = [{ a: 1 }, { a: 2 }];
  assert.deepEqual(extractRecords(two), two, "裸数组");
  assert.deepEqual(extractRecords({ records: two }), two);
  assert.deepEqual(extractRecords({ trials: two }), two);
  assert.deepEqual(extractRecords({ studies: two }), two);
  assert.deepEqual(extractRecords({ results: two }), two);
  assert.deepEqual(extractRecords({ items: two }), two);
  assert.deepEqual(extractRecords({ data: two }), two);
  // And the same shapes wrapped the way MCP actually delivers them.
  const text = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  assert.deepEqual(extractRecords(text({ trials: two })), two, "MCP TextContent 包裹的 trials");
  assert.deepEqual(extractRecords(text(two)), two, "MCP TextContent 包裹的裸数组");
});

test("an explicit zero count is a real zero", () => {
  assert.deepEqual(extractRecords({ total: 0 }), []);
  assert.deepEqual(extractRecords({ count: 0 }), []);
});

test("an unrecognised envelope throws instead of reporting zero results", () => {
  // This is the load-bearing one: "I do not understand this response" must not
  // become "there are no matching trials".
  assert.throws(() => extractRecords({ unexpected: "shape" }), /unrecognised envelope/);
  assert.throws(() => extractRecords("not an object"), /no record envelope/);
  assert.throws(() => extractRecords(null), /no record envelope/);
});

test("an unrecognised envelope terminalises as FAILED with the real text", async () => {
  const stream = await runFanout({
    sources: [chictr],
    dispatch: async () => {
      try {
        return { records: extractRecords({ unexpected: "shape" }), elapsedMs: 1 };
      } catch (error) {
        return { error: error.message, elapsedMs: 1 };
      }
    },
  });
  const [conclusion] = stream;
  assert.equal(conclusion.state, "FAILED");
  assert.match(conclusion.explanation, /unrecognised envelope/);
});

// ---------------------------------------------------------------------------
// Scheduling: deadline, cancellation, ordering, exactly-one-state
// ---------------------------------------------------------------------------

test("the fanout dispatches in LPT order and never twice", async () => {
  const seen = [];
  const stream = await runFanout({
    dispatch: async (source) => {
      seen.push(source.key);
      return { records: [{ id: source.key }], elapsedMs: 1 };
    },
  });
  assert.deepEqual(seen, dispatchOrder().map((source) => source.key));
  assert.equal(new Set(seen).size, seen.length, "a source was dispatched twice");
  assert.equal(stream.length, 5);
  assert.ok(stream.every((conclusion) => conclusion.state === "SUCCESS"));
});

test("every source ends with exactly one terminal state", async () => {
  const stream = await runFanout({
    dispatch: async (source) =>
      source.key === "chictr"
        ? { error: "boom", elapsedMs: 1 }
        : source.key === "veeva_ctv"
          ? { timedOut: true, elapsedMs: 1 }
          : { records: [{ id: 1 }], elapsedMs: 1 },
  });
  assert.equal(stream.length, 5);
  assert.deepEqual(
    stream.map((conclusion) => conclusion.source),
    dispatchOrder().map((source) => source.key),
    "results must come back in registry order, not completion order",
  );
  for (const conclusion of stream) {
    assert.ok(conclusion.state, `${conclusion.source} has no state`);
    assert.equal(typeof conclusion.explanation, "string");
  }
  assert.equal(stream.filter((c) => c.state === "SUCCESS").length, 3);
  assert.equal(stream.filter((c) => c.state === "FAILED").length, 1);
  assert.equal(stream.filter((c) => c.state === "TIMEOUT").length, 1);
});

test("the fanout returns in dispatch order, and aggregate restores the canonical order", async () => {
  // ICTRP is dispatched first but finishes last. runFanout reports in dispatch
  // (LPT) order — that is what the scheduler owes the caller. The user-visible
  // ordered-key contract (§5.2) belongs to aggregate, which reorders by the
  // registry. Keeping the two separate is what lets the schedule change without
  // changing the result shape.
  const delayByKey = { who_ictrp: 40, chictr: 30, chinadrugtrials: 20, clinicaltrials_gov: 10, veeva_ctv: 1 };
  const stream = await runFanout({
    dispatch: async (source) => {
      await new Promise((resolve) => setTimeout(resolve, delayByKey[source.key] ?? 0));
      return { records: [{ id: source.key }], elapsedMs: 1 };
    },
    concurrency: 5,
  });
  assert.deepEqual(
    stream.map((conclusion) => conclusion.source),
    dispatchOrder().map((source) => source.key),
    "runFanout reports in dispatch order",
  );

  const result = aggregate({ query: "q", conclusions: stream, elapsedMs: 1 });
  assert.deepEqual(result.statuses.map((status) => status.source), [
    "clinicaltrials_gov",
    "chictr",
    "veeva_ctv",
    "chinadrugtrials",
    "who_ictrp",
  ]);
  assert.equal(result.coverage.complete, true);
});

test("the overall deadline stops starting new sources and says why", async () => {
  let clock = 0;
  const started = [];
  const stream = await runFanout({
    now: () => clock,
    deadlineMs: 100,
    concurrency: 2,
    dispatch: async (source) => {
      started.push(source.key);
      // Each child consumes more than half the deadline.
      clock += 60;
      return { records: [{ id: source.key }], elapsedMs: 60 };
    },
  });
  assert.deepEqual(started, ["who_ictrp", "chictr"], "the deadline must stop further starts");
  const neverStarted = stream.filter((conclusion) => !started.includes(conclusion.source));
  assert.equal(neverStarted.length, 3);
  for (const conclusion of neverStarted) {
    assert.equal(conclusion.state, "NOT_QUERIED");
    assert.equal(conclusion.reasonCode, "OVERALL_DEADLINE");
    assert.equal(conclusion.attempted, false);
  }
});

test("started-but-unfinished work is never reported as a deadline skip", async () => {
  // The distinction that matters: OVERALL_DEADLINE means "never started".
  // A child that was already running has its own state.
  const stream = await runFanout({
    sources: [chictr, ictrp],
    now: () => 0,
    deadlineMs: 1,
    concurrency: 1,
    dispatch: async (source) =>
      source.key === "who_ictrp" ? { records: [{ id: 1 }], elapsedMs: 1 } : { records: [], elapsedMs: 1 },
  });
  const dispatched = stream.filter((conclusion) => conclusion.attempted);
  assert.ok(dispatched.length >= 1);
  for (const conclusion of dispatched) {
    assert.notEqual(conclusion.reasonCode, "OVERALL_DEADLINE");
  }
});

test("cancellation marks undispatched sources TURN_CANCELLED", async () => {
  const stream = await runFanout({
    sources: [chictr, ictrp],
    concurrency: 1,
    isCancelled: () => true,
    dispatch: async () => ({ records: [{ id: 1 }], elapsedMs: 1 }),
  });
  for (const conclusion of stream) {
    assert.equal(conclusion.state, "NOT_QUERIED");
    assert.equal(conclusion.reasonCode, "TURN_CANCELLED");
    assert.equal(conclusion.attempted, false);
  }
});

test("a throwing dispatch is contained as FAILED, never as a bare crash", async () => {
  const stream = await runFanout({
    sources: [chictr],
    dispatch: async () => {
      throw new Error("broker exploded");
    },
  });
  const [conclusion] = stream;
  assert.equal(conclusion.state, "FAILED");
  assert.match(conclusion.explanation, /broker exploded/);
});

test("a source is never dispatched before its turn to start", async () => {
  // Concurrency 2 over 5 sources: at most 2 in flight at any moment.
  let inFlight = 0;
  let peak = 0;
  await runFanout({
    concurrency: 2,
    dispatch: async (source) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { records: [{ id: source.key }], elapsedMs: 1 };
    },
  });
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the ceiling of 2`);
});

test("the default deadline is the spec's 75s", () => {
  assert.equal(OVERALL_DEADLINE_MS, 75_000);
});

// ---------------------------------------------------------------------------
// Broker: catalog checks and attribution
// ---------------------------------------------------------------------------

test("a tool missing from the live catalog is refused, not forwarded", async () => {
  const fanout = createFanoutBroker({
    resolveTool: (source) => (source.key === "who_ictrp" ? null : { fullName: `plugin_x_${source.key}` }),
    dispatchChild: async () => okResult({ records: [{ id: 1 }] }),
  });
  const stream = await fanout({ sessionId: "s1", turnId: "t1", argsFor: () => ({}) });
  const ictrpConclusion = stream.find((conclusion) => conclusion.source === "who_ictrp");
  assert.equal(ictrpConclusion.state, "NOT_QUERIED");
  assert.equal(ictrpConclusion.reasonCode, "TOOL_UNAVAILABLE");
});

test("a plugin not enabled in this project is NEEDS_SETUP, not NOT_ENABLED", async () => {
  // The broker asks by pluginId, so a caller does not have to know how to
  // resolve a source descriptor to a plugin.
  const asked = [];
  const fanout = createFanoutBroker({
    resolveTool: (source) => ({ fullName: `plugin_${source.pluginId}_tool`, pluginId: source.pluginId }),
    enabledInProject: (pluginId) => {
      asked.push(pluginId);
      return false;
    },
    dispatchChild: async () => okResult({ records: [] }),
  });
  const stream = await fanout({ sessionId: "s1", turnId: "t1", argsFor: () => ({}) });
  assert.equal(asked.length, 5);
  assert.ok(asked.includes("xyb.trial-sources"));
  assert.ok(stream.every((conclusion) => conclusion.state === "NEEDS_SETUP"));
  assert.ok(stream.every((conclusion) => conclusion.reasonCode === "PLUGIN_NOT_ENABLED"));
  assert.ok(stream.every((conclusion) => conclusion.attempted === false));
});

test("each child dispatches under its own toolCallId and the composite's session/turn", async () => {
  const calls = [];
  const fanout = createFanoutBroker({
    resolveTool: (source) => ({ fullName: `plugin_xyb.trial-sources_${source.key}_tool` }),
    dispatchChild: async (params) => {
      calls.push(params);
      return okResult({ records: [{ id: params.toolName }] });
    },
  });
  await fanout({ sessionId: "sess-1", turnId: "turn-1", argsFor: (source) => ({ keyword: source.key }) });
  assert.equal(calls.length, 5);
  const ids = calls.map((call) => call.toolCallId);
  assert.equal(new Set(ids).size, 5, "child toolCallIds must be unique");
  for (const call of calls) {
    assert.equal(call.sessionId, "sess-1");
    assert.equal(call.turnId, "turn-1");
    assert.match(call.toolCallId, /^turn-1:trial:/);
  }
  // Each child carries the args its own source's shape produced.
  assert.deepEqual(calls.find((c) => c.toolName.includes("chictr")).args, { keyword: "chictr" });
});

test("attribution is pre-registered before the child is dispatched", async () => {
  // An approval prompt must be able to name the source, so registration has to
  // happen before dispatch, not after the result comes back.
  const order = [];
  const fanout = createFanoutBroker({
    resolveTool: (source) => ({ fullName: `plugin_x_${source.key}` }),
    dispatchChild: async (params) => {
      order.push({ phase: "dispatch", key: params.toolName });
      return okResult({ records: [] });
    },
  });
  await fanout({
    sessionId: "s",
    turnId: "t",
    argsFor: () => ({}),
    onChild: (source, childToolCallId) => {
      order.push({ phase: "attribute", key: `plugin_x_${source.key}`, childToolCallId });
    },
  });
  const firstDispatch = order.findIndex((entry) => entry.phase === "dispatch");
  const attributionForIt = order.slice(0, firstDispatch);
  assert.ok(
    attributionForIt.some((entry) => entry.phase === "attribute"),
    "attribution must be registered before the first dispatch",
  );
});

test("the broker result is aggregated-ready: statuses only, no records invented", async () => {
  const fanout = createFanoutBroker({
    resolveTool: (source) => ({ fullName: `plugin_x_${source.key}` }),
    dispatchChild: async (params) =>
      params.toolName.includes("who_ictrp")
        ? errResult("TOOL_DENIED", "permission denied", { denied: true })
        : okResult({ records: [{ id: params.toolName }] }),
  });
  const stream = await fanout({ sessionId: "s", turnId: "t", argsFor: () => ({}) });
  assert.equal(stream.filter((conclusion) => isQueried(conclusion.state)).length, 4);
  const denied = stream.find((conclusion) => conclusion.source === "who_ictrp");
  assert.equal(denied.state, "NOT_QUERIED");
  assert.equal(denied.reasonCode, "PERMISSION_DENIED");
});

// ---------------------------------------------------------------------------
// runTrialComposite — the adapter the Electron `plugins.execute` handler calls.
//
// Everything above tests the pieces. These test the seam: that the composite
// resolves the real catalog names, registers attribution *before* dispatching,
// releases it afterwards, and hands aggregate a query string rather than the
// raw args object.
// ---------------------------------------------------------------------------

test("the composite dispatches every child under its resolved catalog name", async () => {
  const catalog = new Map(
    dispatchOrder().map((source) => [
      source.key,
      { fullName: `plugin_${source.pluginId}_${source.key}_tool`, pluginId: source.pluginId },
    ]),
  );
  const seen = [];
  const result = await runTrialComposite({
    sessionId: "s1",
    turnId: "t1",
    args: { keyword: "pancreatic cancer" },
    resolveTool: (source) => catalog.get(source.key),
    dispatchChild: async (child) => {
      seen.push(child.toolName);
      return { ok: true, content: { records: [{ id: child.toolName }] }, durationMs: 5 };
    },
  });
  assert.equal(seen.length, 5);
  for (const source of dispatchOrder()) {
    assert.ok(seen.includes(catalog.get(source.key).fullName), `dispatched ${source.key}`);
  }
  assert.equal(result.coverage.queried, 5);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.totalRecords, 5);
});

test("the composite pre-registers attribution before each dispatch and releases it after", async () => {
  const order = [];
  const catalog = new Map(
    dispatchOrder().map((source) => [source.key, { fullName: `plugin_${source.pluginId}_tool`, pluginId: source.pluginId }]),
  );
  await runTrialComposite({
    sessionId: "s1",
    turnId: "t1",
    args: { keyword: "q" },
    resolveTool: (source) => catalog.get(source.key),
    registerChildAttribution: (child) => order.push(`attribute:${child.toolName}`),
    releaseChildAttribution: (child) => order.push(`release:${child.toolName}`),
    dispatchChild: async (child) => {
      order.push(`dispatch:${child.toolName}`);
      return { ok: true, content: { records: [] }, durationMs: 1 };
    },
  });
  const firstDispatch = order.findIndex((entry) => entry.startsWith("dispatch:"));
  const firstAttribute = order.findIndex((entry) => entry.startsWith("attribute:"));
  assert.ok(firstAttribute >= 0 && firstAttribute < firstDispatch, "attribution precedes dispatch");
  // Every registered child is also released, so the map cannot leak.
  assert.equal(order.filter((e) => e.startsWith("attribute:")).length, 5);
  assert.equal(order.filter((e) => e.startsWith("release:")).length, 5);
});

test("the composite accepts both keyword and condition/terms and refuses an empty query", async () => {
  const catalog = new Map(
    dispatchOrder().map((source) => [source.key, { fullName: `plugin_${source.pluginId}_tool`, pluginId: source.pluginId }]),
  );
  const argsSeen = [];
  await runTrialComposite({
    sessionId: "s1",
    turnId: "t1",
    args: { condition: "pancreatic cancer", terms: "resectable" },
    resolveTool: (source) => catalog.get(source.key),
    dispatchChild: async (child) => {
      argsSeen.push(child.args);
      return { ok: true, content: { records: [] }, durationMs: 1 };
    },
  });
  // The condition/terms pair is folded into each source's own shape.
  const ctgovArgs = argsSeen.find((a) => "condition" in a);
  assert.deepEqual(ctgovArgs, { condition: "pancreatic cancer resectable", terms: "" });

  await assert.rejects(
    () =>
      runTrialComposite({
        sessionId: "s1",
        turnId: "t1",
        args: { keyword: "   " },
        resolveTool: (source) => catalog.get(source.key),
        dispatchChild: async () => ({ ok: true, content: { records: [] } }),
      }),
    /关键词/,
  );
});

test("a child whose tool vanished from the catalog is not dispatched", async () => {
  const dispatched = [];
  const result = await runTrialComposite({
    sessionId: "s1",
    turnId: "t1",
    args: { keyword: "q" },
    // Only ChiCTR is still installed.
    resolveTool: (source) => (source.key === "chictr" ? { fullName: "plugin_chictr_tool", pluginId: "xyb.trial-sources" } : undefined),
    dispatchChild: async (child) => {
      dispatched.push(child.toolName);
      return { ok: true, content: { records: [{ id: "x" }] }, durationMs: 1 };
    },
  });
  assert.deepEqual(dispatched, ["plugin_chictr_tool"]);
  const ictrpStatus = result.statuses.find((s) => s.source === "who_ictrp");
  assert.equal(ictrpStatus.state, "NOT_QUERIED");
  assert.equal(ictrpStatus.reasonCode, "TOOL_UNAVAILABLE");
  assert.equal(result.coverage.complete, false);
});

// ---------------------------------------------------------------------------
// Broker: runtime probe on an unregistered tool
//
// §15.9 criterion 2 says an unregistered tool is NOT_QUERIED + TOOL_UNAVAILABLE.
// Criterion 3 says a missing prerequisite is NEEDS_SETUP + PYTHON_RUNTIME_MISSING.
// Both start from the same observation — the tool is not in the catalog — so
// the probe is the only thing separating them.
// ---------------------------------------------------------------------------

test("an unregistered ICTRP tool probes the runtime before reporting unavailability", async () => {
  const probed = [];
  const fanout = createFanoutBroker({
    resolveTool: (source) => (source.key === "who_ictrp" ? null : { fullName: `plugin_x_${source.key}` }),
    probeRuntime: async (source) => {
      probed.push(source.key);
      return {
        status: "missing",
        reasonCode: "PYTHON_RUNTIME_MISSING",
        explanation: "未找到 python3。",
        fixCommand: "python3 --version",
      };
    },
    dispatchChild: async () => okResult({ records: [] }),
  });
  const stream = await fanout({ sessionId: "s1", turnId: "t1", argsFor: () => ({}) });
  const ictrp = stream.find((c) => c.source === "who_ictrp");

  assert.deepEqual(probed, ["who_ictrp"], "只应对缺工具的来源探测");
  assert.equal(ictrp.state, "NEEDS_SETUP", "缺前置条件不是「没问过」，是「没准备好」");
  assert.equal(ictrp.reasonCode, "PYTHON_RUNTIME_MISSING");
  assert.equal(ictrp.fixCommand, "python3 --version", "修复命令必须传到结论里");
  assert.equal(ictrp.attempted, false);
});

test("only sources declaring a runtime are probed", async () => {
  const probed = [];
  const fanout = createFanoutBroker({
    // Every tool missing, so the probe branch is reachable for all five.
    resolveTool: () => null,
    probeRuntime: async (source) => {
      probed.push(source.key);
      return { status: "missing", reasonCode: "PYTHON_RUNTIME_MISSING", explanation: "x" };
    },
    dispatchChild: async () => okResult({ records: [] }),
  });
  await fanout({ sessionId: "s1", turnId: "t1", argsFor: () => ({}) });
  assert.deepEqual(probed, ["who_ictrp"], "只有 who_ictrp 声明了 requiresRuntime");
});

test("a probe that cannot reach a verdict leaves the answer as NOT_QUERIED", async () => {
  // The guard that matters most: "we could not tell" must not become "install
  // Python". Promoting `unknown` would send users to fix something that is
  // already fine, and would hide the real cause.
  const fanout = createFanoutBroker({
    resolveTool: (source) => (source.key === "who_ictrp" ? null : { fullName: `plugin_x_${source.key}` }),
    probeRuntime: async () => ({ status: "unknown", explanation: "检测超时。" }),
    dispatchChild: async () => okResult({ records: [] }),
  });
  const stream = await fanout({ sessionId: "s1", turnId: "t1", argsFor: () => ({}) });
  const ictrp = stream.find((c) => c.source === "who_ictrp");
  assert.equal(ictrp.state, "NOT_QUERIED");
  assert.equal(ictrp.reasonCode, "TOOL_UNAVAILABLE");
  assert.equal(ictrp.fixCommand, undefined, "没有结论时不得编造修复命令");
});

test("a healthy runtime still reports NOT_QUERIED, not NEEDS_SETUP", async () => {
  const fanout = createFanoutBroker({
    resolveTool: (source) => (source.key === "who_ictrp" ? null : { fullName: `plugin_x_${source.key}` }),
    probeRuntime: async () => ({ status: "ok", explanation: "已就绪。" }),
    dispatchChild: async () => okResult({ records: [] }),
  });
  const stream = await fanout({ sessionId: "s1", turnId: "t1", argsFor: () => ({}) });
  const ictrp = stream.find((c) => c.source === "who_ictrp");
  assert.equal(ictrp.state, "NOT_QUERIED");
  assert.equal(ictrp.reasonCode, "TOOL_UNAVAILABLE");
});

test("a registered ICTRP tool is never probed", async () => {
  // Probing costs a process spawn; it belongs only on the missing-tool path.
  let calls = 0;
  const fanout = createFanoutBroker({
    resolveTool: (source) => ({ fullName: `plugin_${source.pluginId}_tool`, pluginId: source.pluginId }),
    probeRuntime: async () => {
      calls += 1;
      return { status: "missing", reasonCode: "PYTHON_RUNTIME_MISSING", explanation: "x" };
    },
    dispatchChild: async () => okResult({ records: [{ id: 1 }] }),
  });
  await fanout({ sessionId: "s1", turnId: "t1", argsFor: () => ({}) });
  assert.equal(calls, 0, "工具在场时不该探测运行时");
});

test("a failing source does not lose its fix command on the way to the aggregate", async () => {
  const fanout = createFanoutBroker({
    resolveTool: (source) => (source.key === "who_ictrp" ? null : { fullName: `plugin_x_${source.key}` }),
    probeRuntime: async () => ({
      status: "missing",
      reasonCode: "PYTHON_DEPS_MISSING",
      explanation: "缺少依赖。",
      fixCommand: "python3 -m pip install mcp httpx",
    }),
    dispatchChild: async () => okResult({ records: [] }),
  });
  const stream = await fanout({ sessionId: "s1", turnId: "t1", argsFor: () => ({}) });
  const result = aggregate({
    query: { keywords: "pancreatic cancer" },
    conclusions: stream,
    elapsedMs: 1,
  });
  const ictrp = result.statuses.find((c) => c.source === "who_ictrp");
  assert.equal(ictrp.state, "NEEDS_SETUP");
  assert.equal(ictrp.fixCommand, "python3 -m pip install mcp httpx");
});

test("the fan-out reads the query in the shape the panel actually sends", () => {
  // The panel (`trials.html`) sends `{ query: { keywords, condition } }`; the
  // tool schema takes `condition` / `keywords` at the top level. Both callers
  // exist, so both spellings must resolve. Before the nested branch existed a
  // panel-shaped call threw "需要一个关键词" — and for a search tool a hard
  // failure reads to the user like "no results", which is the worst way to be
  // wrong and the exact confusion this repo has already been bitten by.
  assert.equal(normalizeQuery({ query: { keywords: "胰腺癌" } }), "胰腺癌");
  assert.equal(normalizeQuery({ query: { condition: "pancreatic cancer" } }), "pancreatic cancer");
  assert.equal(
    normalizeQuery({ query: { keywords: "胰腺癌", condition: "pancreatic cancer" } }),
    "胰腺癌",
    "关键词优先于病种，与顶层形状保持同一优先级",
  );
  // The top-level shape must keep working.
  assert.equal(normalizeQuery({ keywords: "胰腺癌" }), "胰腺癌");
  assert.equal(normalizeQuery({ condition: "pancreatic cancer" }), "pancreatic cancer");
  // And an empty call still refuses rather than fanning out five empty searches.
  assert.throws(() => normalizeQuery({ query: {} }), /需要一个关键词/);
});

test("a fan-out whose every in-flight child hangs still terminates", async () => {
  // The wait loop used to be a bare `Promise.race([...inflight.values()])`. A
  // race with no timer settles only when a child settles, so when EVERY
  // in-flight slot held a child that never returned — a hung MCP subprocess, a
  // suspended sidecar — nothing could re-arm the loop and the composite parked
  // on that await forever: no timeout, no terminal state, no sentence for the
  // user. The doc comment promised "work already started is reported as
  // TIMEOUT"; nothing in the code could produce it.
  //
  // The boundary matters and is measured, not assumed: ONE hung child among
  // settled siblings is enough to re-arm the loop, so the hang needs the hung
  // children to fill every concurrency slot. This test therefore hangs the
  // first 5 sources and runs at concurrency 5 — the whole fan-out, which is
  // also the production shape (5 sources, ceiling 4, so a 5th waits).
  let clock = 0;
  const sources = dispatchOrder();
  const hung = new Set(sources.slice(0, 5).map((source) => source.key));
  let dispatches = 0;

  const conclusions = await runFanout({
    sources,
    dispatch: async (source) => {
      dispatches += 1;
      if (hung.has(source.key)) return new Promise(() => {});
      return { records: [{ id: source.key }], resultCount: 1, elapsedMs: 5 };
    },
    deadlineMs: 3000,
    concurrency: 5,
    // Advance the injected clock only when the loop asks. Without the
    // wake-up timer the loop asks exactly once (its first deadline check) and
    // then parks forever on children that never settle — so the simulated
    // clock never advances again, the deadline is never reached, and this test
    // cannot even complete. That is the hang, reproduced deterministically:
    // this test can only finish because something other than a child wakes the
    // loop.
    now: () => (clock += 1000),
    isCancelled: () => false,
  });

  assert.ok(dispatches >= 1, "at least one child must have been dispatched");

  // Every source terminates exactly once, and no source keeps the state it had
  // before the deadline fired. The loop is the vacuity guard: an empty state
  // space would satisfy the uniqueness check trivially.
  const keys = conclusions.map((item) => item.source);
  assert.equal(keys.length, sources.length, "one conclusion per registered source");
  assert.equal(new Set(keys).size, keys.length, "no source may appear twice");
  for (const item of conclusions) {
    assert.ok(typeof item.state === "string" && item.state.length > 0, `${item.source} needs a state`);
  }

  // A hung child was ASKED, so it is reported as a timeout — never as "we never
  // asked", which is the distinction lesson five records in the other direction.
  for (const key of hung) {
    const conclusion = conclusions.find((item) => item.source === key);
    assert.ok(conclusion, `${key} must have a conclusion, not a missing row`);
    if (conclusion.attempted) {
      assert.equal(conclusion.state, "TIMEOUT", `${key} was dispatched and never returned, so it timed out`);
      assert.notEqual(conclusion.reasonCode, "NOT_ATTEMPTED", `${key} was attempted; it must not be reported as never asked`);
    } else {
      assert.equal(conclusion.state, "NOT_QUERIED", `${key} never started, so it was never asked`);
    }
  }
});
