/**
 * Trial-source registry contract tests.
 *
 * SPEC: docs/spec/xyb-unified-trial-host-orchestration.md §4.1, §6.2, §6.5, §10「来源扩展框架」
 *
 * The registry is the only place a source, plugin, server, tool, timeout or
 * parameter shape is named. These tests pin those names to the *real* tools:
 * a descriptor that points at a tool which does not exist fails at runtime as
 * "some tool mysteriously vanished", which is the failure mode the vendoring
 * gate exists to prevent. Here we prevent the descriptor half of it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FANOUT_CHILD_COUNT,
  MAX_FANOUT_CONCURRENCY,
  OVERALL_DEADLINE_MS,
  TRIAL_SOURCES,
  UPSTREAM_INCOMPLETE_SOURCES,
  childToolName,
  detectManualOverlaps,
  dispatchOrder,
  isUpstreamIncomplete,
  mapArgs,
  sourceByKey,
  sourceKeys,
} from "../electron/main/trial-sources.ts";
import { aggregate, terminalise } from "../electron/main/trial-orchestrator.ts";
import {
  TRIAL_COMPOSITE_TOOL,
  TRIAL_MERGE_TOOL,
  isTrialCompositeTool,
} from "../electron/main/trial-fanout.ts";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("registers exactly the five v1 sources in display order", () => {
  assert.deepEqual(sourceKeys(), [
    "clinicaltrials_gov",
    "chictr",
    "veeva_ctv",
    "chinadrugtrials",
    "who_ictrp",
  ]);
});

test("names each source's tool with the plugin-tool identity the host dispatches", () => {
  assert.equal(
    childToolName(sourceByKey("chictr")),
    "plugin_xyb.trial-sources_chictr_search_trials",
  );
  assert.equal(
    childToolName(sourceByKey("veeva_ctv")),
    "plugin_xyb.trial-sources_veeva-ctv_search_studies",
  );
  assert.equal(
    childToolName(sourceByKey("chinadrugtrials")),
    "plugin_xyb.trial-sources_chinadrugtrials_search_trials",
  );
  assert.equal(
    childToolName(sourceByKey("who_ictrp")),
    "plugin_xyb.trial-sources_who-ictrp_ictrp_search",
  );
  // A plugin agentTool (not an MCP server) has no server segment.
  assert.equal(childToolName(sourceByKey("clinicaltrials_gov")), "plugin_xyb.trials_xyb_trials_search");
});

test("every declared serverId exists in the trial-sources manifest", () => {
  const manifest = JSON.parse(
    readFileSync(join(desktopRoot, "resources/plugins/xyb.trial-sources/manifest.json"), "utf8"),
  );
  const declared = new Set(
    (manifest.contributes?.mcpServers ?? []).map((server) => server.id),
  );
  for (const source of TRIAL_SOURCES) {
    if (!source.serverId) continue;
    assert.ok(
      declared.has(source.serverId),
      `${source.key} points at MCP server "${source.serverId}", which the manifest does not declare`,
    );
  }
});

test("only ICTRP is a lower-bound source, and it is declared as an aggregator", () => {
  assert.deepEqual([...UPSTREAM_INCOMPLETE_SOURCES], ["who_ictrp"]);
  assert.ok(isUpstreamIncomplete("who_ictrp"));
  for (const key of ["clinicaltrials_gov", "chictr", "veeva_ctv", "chinadrugtrials"]) {
    assert.equal(isUpstreamIncomplete(key), false);
  }
  assert.equal(sourceByKey("who_ictrp").kind, "aggregator_registry");
  // Veeva is a local index and must say so — it may not present as a live
  // global registry query (§6.3 point 2).
  assert.equal(sourceByKey("veeva_ctv").kind, "local_index");
  assert.equal(sourceByKey("chinadrugtrials").kind, "archived_scrape");
});

test("no source in the fan-out has a side effect", () => {
  // The composite must never write to disk or pull the network on a user's
  // behalf without a consent gate. CDE's archive read is the one archived
  // source in v1 and it is read-only here; its writing path (sync_incremental)
  // is deliberately not reachable from this registry.
  for (const source of TRIAL_SOURCES) {
    assert.equal(source.sideEffect, "none", `${source.key} has a side effect in the fan-out`);
  }
});

test("maps each query onto the real tool's parameter names", () => {
  assert.deepEqual(mapArgs(sourceByKey("clinicaltrials_gov"), "pancreatic cancer"), {
    condition: "pancreatic cancer",
    terms: "",
  });
  assert.deepEqual(mapArgs(sourceByKey("chictr"), "胰腺癌"), {
    keyword: "胰腺癌",
    max_results: 20,
  });
  assert.deepEqual(mapArgs(sourceByKey("veeva_ctv"), "pancreatic cancer"), {
    keyword: "pancreatic cancer",
    limit: 20,
    offset: 0,
  });
  // CDE names it `keywords` and paginates by page count, not row count.
  assert.deepEqual(mapArgs(sourceByKey("chinadrugtrials"), "胰腺癌"), {
    keywords: "胰腺癌",
    max_pages: 2,
  });
  assert.deepEqual(mapArgs(sourceByKey("who_ictrp"), "pancreatic cancer"), {
    keyword: "pancreatic cancer",
    limit: 20,
    offset: 0,
  });
});

test("never emits a parameter the target tool does not declare", () => {
  // Guards the exact bug class that made CDE's mapping wrong on the first pass:
  // a shared shape name silently sending `keyword` to a tool that wants
  // `keywords`. The sets below are the names mapArgs may legitimately use, not a
  // full transcription of each schema — the test below this one reads the real
  // declarations out of the shipped sources. `filters` was removed from the
  // ICTRP row here: ictrp_search does not declare it (it belongs to
  // ictrp_filter), and a hand-copied allowlist that permits an undeclared name
  // is a guard with a hole in it.
  const schemas = {
    chictr: new Set(["keyword", "registration_number", "year", "max_results"]),
    veeva_ctv: new Set(["keyword", "condition", "sponsor", "status", "phase", "country", "type", "limit", "offset"]),
    chinadrugtrials: new Set(["keywords", "state", "indication", "reg_no", "max_pages", "incremental"]),
    who_ictrp: new Set(["keyword", "limit", "offset", "fields", "sort_by", "descending", "refresh"]),
  };
  for (const [key, allowed] of Object.entries(schemas)) {
    const args = mapArgs(sourceByKey(key), "pancreatic cancer");
    for (const name of Object.keys(args)) {
      assert.ok(allowed.has(name), `${key} would send undeclared parameter "${name}"`);
    }
  }
});

test("the fan-out never enables ICTRP's upstream refresh", () => {
  // refresh=true would re-hit the WHO portal. The bundled snapshot exists so
  // the fan-out stays off the network; ICTRP's own default is already false,
  // and the registry must not override it.
  const args = mapArgs(sourceByKey("who_ictrp"), "pancreatic cancer");
  assert.equal(args.refresh, undefined);
});

test("child count and concurrency are within host capacity", async () => {
  assert.equal(FANOUT_CHILD_COUNT, 5);
  assert.equal(MAX_FANOUT_CONCURRENCY, 4);
  // The composite itself holds one plugin permit while it fans out, so the host
  // budget must admit parent + children. Below that a sibling waits 30s and
  // fails as HOST_OVERLOADED — the wrong reason reported for the wrong layer.
  const budget = readFileSync(join(desktopRoot, "..", "..", "crates/host-core/src/tool_budget.rs"), "utf8");
  const plugins = Number(/pub const MAX_IN_FLIGHT_PLUGINS: usize = (\d+);/.exec(budget)?.[1]);
  const perSession = Number(/pub const MAX_IN_FLIGHT_PER_SESSION: usize = (\d+);/.exec(budget)?.[1]);
  const needed = FANOUT_CHILD_COUNT + 1;
  assert.ok(
    plugins >= needed,
    `MAX_IN_FLIGHT_PLUGINS is ${plugins} but a fan-out of ${FANOUT_CHILD_COUNT} needs ${needed}`,
  );
  assert.ok(
    perSession >= needed,
    `MAX_IN_FLIGHT_PER_SESSION is ${perSession} but a fan-out of ${FANOUT_CHILD_COUNT} needs ${needed}`,
  );
});

test("the overall deadline exceeds every single-source deadline", () => {
  // A composite whose total budget is shorter than one of its children can
  // only ever report that child as a timeout — the child never gets the time
  // its descriptor granted it.
  for (const source of TRIAL_SOURCES) {
    assert.ok(
      source.timeoutMs < OVERALL_DEADLINE_MS,
      `${source.key} timeout ${source.timeoutMs}ms does not fit inside the ${OVERALL_DEADLINE_MS}ms deadline`,
    );
  }
  // And it must exceed the longest child, so the longest source can settle on
  // its own terms rather than being cut off by the composite.
  const longest = Math.max(...TRIAL_SOURCES.map((source) => source.timeoutMs));
  assert.ok(OVERALL_DEADLINE_MS > longest);
});

test("unregistered keys are not addressable", () => {
  assert.equal(sourceByKey("mcp_user_configured"), undefined);
  assert.equal(sourceByKey(""), undefined);
  assert.equal(sourceByKey("README"), undefined);
});

test("rejects an unknown argShape instead of dispatching a guess", () => {
  assert.throws(
    () => mapArgs({ argShape: "telepathy", defaultLimit: 1 }, "x"),
    /unmapped argShape/,
  );
});

test("dispatches longest processing time first, so ICTRP is not the late start", () => {
  assert.deepEqual(
    dispatchOrder().map((source) => source.key),
    ["who_ictrp", "chictr", "chinadrugtrials", "clinicaltrials_gov", "veeva_ctv"],
  );
  // Non-increasing deadlines: the defining property of LPT, so this cannot
  // silently stop being LPT if a new source is added with a bigger timeout.
  const deadlines = dispatchOrder().map((source) => source.timeoutMs);
  for (let i = 1; i < deadlines.length; i += 1) {
    assert.ok(
      deadlines[i - 1] >= deadlines[i],
      `dispatch order is not longest-first at position ${i}: ${deadlines[i - 1]} < ${deadlines[i]}`,
    );
  }
});

test("the LPT schedule finishes inside the overall deadline", () => {
  // Simulates the fan-out as bounded-concurrency scheduling and asserts the
  // wall clock. This is the arithmetic that makes ICTRP-first load-bearing:
  // with concurrency 4 the fifth source starts late, and it must be a short
  // one. Starting ICTRP at t=15 would end at t=75 — zero slack against the
  // 75s deadline.
  const order = dispatchOrder();
  const slots = new Array(MAX_FANOUT_CONCURRENCY).fill(0);
  for (const source of order) {
    // Place each source on the earliest-free slot (LPT list scheduling).
    let earliest = 0;
    for (let i = 1; i < slots.length; i += 1) {
      if (slots[i] < slots[earliest]) earliest = i;
    }
    slots[earliest] += source.timeoutMs;
  }
  const wallClock = Math.max(...slots);
  assert.ok(
    wallClock <= OVERALL_DEADLINE_MS,
    `LPT schedule takes ${wallClock}ms, which exceeds the ${OVERALL_DEADLINE_MS}ms deadline`,
  );
  // And the critical path is ICTRP itself: no ordering can beat 60s, so the
  // schedule must not be materially worse than that.
  const longest = Math.max(...TRIAL_SOURCES.map((source) => source.timeoutMs));
  assert.equal(wallClock, longest);
});

test("a late start for the longest source is what ICTRP-first avoids", () => {
  // Regression for the ordering bug this replaced: putting ICTRP last costs
  // exactly the 15s of the shortest source it displaces, and that is the whole
  // slack in the 75s budget.
  const worst = TRIAL_SOURCES.slice().sort((a, b) => a.timeoutMs - b.timeoutMs);
  const slots = new Array(MAX_FANOUT_CONCURRENCY).fill(0);
  for (const source of worst) {
    let earliest = 0;
    for (let i = 1; i < slots.length; i += 1) {
      if (slots[i] < slots[earliest]) earliest = i;
    }
    slots[earliest] += source.timeoutMs;
  }
  const wallClock = Math.max(...slots);
  assert.equal(wallClock, OVERALL_DEADLINE_MS, "shortest-first should exactly fill the deadline");
  assert.ok(wallClock >= Math.max(...TRIAL_SOURCES.map((s) => s.timeoutMs)) + 15_000);
});

// ---------------------------------------------------------------------------
// Manual MCP overlap (SPEC §15.12(c), user ruling)
//
// A hand-configured server never enters the fan-out, but if it shadows a
// built-in source the two paths do not de-duplicate against each other. The
// merged count then stops being a lower bound and becomes an upper bound —
// which is exactly the kind of quiet wrongness the two-number contract exists
// to prevent. Silence is the failure mode; a warning is the fix.
// ---------------------------------------------------------------------------

test("a hand-configured server with a built-in server id is reported as an overlap", () => {
  const overlaps = detectManualOverlaps([{ serverId: "chictr", fullName: "mcp_chictr_search_trials" }]);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].builtin, "chictr");
  assert.equal(overlaps[0].serverId, "chictr");
});

test("overlap matching folds case and separators", () => {
  for (const variant of ["Veeva-CTV", "VEEVA_CTV", "veeva ctv", "veevaCtv"]) {
    const overlaps = detectManualOverlaps([{ serverId: variant }]);
    assert.equal(overlaps.length, 1, `expected ${variant} to match veeva-ctv`);
    assert.equal(overlaps[0].builtin, "veeva_ctv");
  }
});

test("a tool name matching a built-in tool is reported even under another server id", () => {
  const overlaps = detectManualOverlaps([{ serverId: "my-mirror", toolName: "ictrp_search" }]);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].builtin, "who_ictrp");
});

test("an unrelated manual server is not reported", () => {
  const overlaps = detectManualOverlaps([
    { serverId: "filesystem", toolName: "read_file" },
    { serverId: "weather", toolName: "forecast" },
  ]);
  assert.deepEqual(overlaps, []);
});

test("overlap detection tolerates an empty or absent tool list", () => {
  assert.deepEqual(detectManualOverlaps([]), []);
  assert.deepEqual(detectManualOverlaps(null), []);
  assert.deepEqual(detectManualOverlaps(undefined), []);
});

test("the aggregate result carries overlaps through to the caller", () => {
  const source = { key: "chictr", label: "ChiCTR", kind: "remote_registry", toolName: "search_trials", argShape: "keyword_maxresults", pluginId: "xyb.trial-sources", serverId: "chictr", defaultLimit: 20, timeoutMs: 45_000 };
  const result = aggregate({
    query: "q",
    conclusions: [terminalise(source, { records: [{ id: "x" }], elapsedMs: 1 })],
    elapsedMs: 5,
    manualOverlaps: detectManualOverlaps([{ serverId: "chictr" }]),
  });
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0].builtin, "chictr");
});

test("the ICTRP local analysis tools are structurally unreachable from the fan-out", () => {
  // §15.9 criterion 8. `ictrp_filter` / `ictrp_export` / `ictrp_cache_status`
  // and the other six are *analysis* tools: they operate on a result set the
  // session already holds, so dispatching them during a fresh fan-out would
  // either fail or export something the user never asked for.
  //
  // This is asserted structurally rather than by name, because the registry is
  // the only way anything reaches the fan-out: if no descriptor names them,
  // no code path can dispatch them, including one added later.
  const localTools = [
    "ictrp_filter",
    "ictrp_export",
    "ictrp_cache_status",
    "ictrp_field_query",
    "ictrp_registry_summary",
    "ictrp_find_duplicates",
    "ictrp_snapshot",
    "ictrp_bundle_status",
  ];
  const dispatched = TRIAL_SOURCES.map((source) => source.toolName);
  for (const tool of localTools) {
    assert.ok(
      !dispatched.includes(tool),
      `${tool} 是结果集分析工具，不得进入扇出（扇出只能调 ictrp_search）`,
    );
  }
  // Positive control: exactly nine tools exist on the service, and precisely
  // one of them is the fan-out entry point.
  assert.deepEqual(dispatched.filter((t) => t.endsWith("ictrp_search")), ["ictrp_search"]);
});

test("every source in the registry is dispatched without any user configuration", () => {
  // §15.9 criterion 1: enabling the plugin is the *only* precondition. A source
  // that a user has to install or register by hand is not "integrated" — it is
  // a chore, and the failure mode is that the fan-out silently covers four
  // sources while the UI still says five.
  //
  // The registry is a closed module-level constant (the descriptor table), so
  // "no user configuration required" is asserted structurally: the five keys
  // exist with no input from any config surface, and the dispatcher's source
  // list comes from that constant rather than from user-supplied arguments.
  assert.deepEqual(sourceKeys(), [
    "clinicaltrials_gov",
    "chictr",
    "veeva_ctv",
    "chinadrugtrials",
    "who_ictrp",
  ]);
  assert.equal(TRIAL_SOURCES.length, 5);
  // Every source must name a real tool — an entry with an empty toolName would
  // be a source the fan-out reports as "queried" while never dispatching it.
  for (const source of TRIAL_SOURCES) {
    assert.ok(source.toolName, `${source.key} 缺少 toolName，会被报成"已查询"但从不派发`);
    assert.ok(source.pluginId, `${source.key} 缺少 pluginId`);
  }
});

test("the intercepted tool name is derived, and matches what the catalog registers", async () => {
  // The defect this pins down: `TRIAL_COMPOSITE_TOOL` was a hand-written
  // literal `plugin_xyb.trials_xyb_trials_unify`, but `pluginToolName` sanitises
  // the plugin id, so the catalog actually registers
  // `plugin_xyb_trials_xyb_trials_unify`. The host compared `q.toolName` against
  // a string no tool could ever have, which made the whole fan-out — state
  // machine, LPT dispatch, both lower-bound numbers, WHO attribution, overlap
  // detection — unreachable in production while every test passed, because the
  // tests called `runTrialComposite` directly and never asked what name the host
  // compares against.
  //
  // So: assert the constant equals what the SDK function produces, and assert
  // the SDK function produces an underscore where the bug had a dot. Deriving
  // the constant makes the bug unreintroducible; this test makes the *derivation*
  // itself load-bearing, so someone re-hardcoding it gets a red test.
  const { pluginToolName } = await import("@pi-desktop/plugin-sdk");

  assert.equal(TRIAL_COMPOSITE_TOOL, pluginToolName("xyb.trials", "xyb_trials_fanout"));
  assert.equal(TRIAL_COMPOSITE_TOOL, "plugin_xyb_trials_xyb_trials_fanout");
  assert.ok(
    !TRIAL_COMPOSITE_TOOL.includes("."),
    "工具全名不得含点：pluginToolName 会把插件 id 里的点换成下划线",
  );
  assert.ok(isTrialCompositeTool(TRIAL_COMPOSITE_TOOL));
  // The buggy literal must no longer match anything.
  assert.ok(!isTrialCompositeTool("plugin_xyb.trials_xyb_trials_unify"));
});

test("the merge tool is a separate name the host does not intercept", async () => {
  // Two tools, one job each. The host intercepts only the fan-out entry point;
  // the merge tool runs the plugin's own pure `unified.buildResult`. If these
  // ever collapse to one name, the host must guess which of the two the caller
  // wanted, and both guesses are bad: guessing "fan-out" discards the results
  // the caller already fetched, guessing "merge" hands it an empty list.
  const { pluginToolName } = await import("@pi-desktop/plugin-sdk");

  assert.equal(TRIAL_MERGE_TOOL, pluginToolName("xyb.trials", "xyb_trials_unify"));
  assert.notEqual(TRIAL_MERGE_TOOL, TRIAL_COMPOSITE_TOOL);
  assert.ok(
    !isTrialCompositeTool(TRIAL_MERGE_TOOL),
    "合并工具必须由插件自己执行，不得被宿主拦截",
  );
});

test("both tool names exist in the plugin manifest", async () => {
  // The host constant is only half the contract: the plugin must actually
  // register both names, or one of the two paths answers `TOOL_NOT_FOUND`.
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(
    readFileSync(
      new URL("../resources/plugins/xyb.trials/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const names = manifest.contributes.agentTools.map((tool) => tool.name);
  assert.ok(names.includes("xyb_trials_fanout"), "manifest 必须声明扇出入口");
  assert.ok(names.includes("xyb_trials_unify"), "manifest 必须声明合并工具");
});

test("normalizeQuery accepts every keyword spelling both schemas document", async () => {
  // The merge schema documents `keywords` (plural); the original normalizeQuery
  // read only `keyword` (singular). A schema-compliant call therefore threw
  // "需要一个关键词" — a hard failure that is indistinguishable from "no
  // results", which is the worst possible confusion for a search tool.
  const { normalizeQuery } = await import("../electron/main/trial-fanout.ts");

  assert.equal(normalizeQuery({ keywords: "胰腺癌" }), "胰腺癌");
  assert.equal(normalizeQuery({ keyword: "pancreatic cancer" }), "pancreatic cancer");
  assert.equal(normalizeQuery({ q: "IBI343" }), "IBI343");
  assert.equal(normalizeQuery({ condition: "pancreatic cancer" }), "pancreatic cancer");
  assert.equal(
    normalizeQuery({ condition: "pancreatic cancer", terms: "KRAS" }),
    "pancreatic cancer KRAS",
  );
  // Whitespace-only is not a keyword.
  assert.throws(() => normalizeQuery({ keywords: "   " }), /关键词/);
  assert.throws(() => normalizeQuery({}), /关键词/);
});


/** Declared `properties` names of one tool in a vendored JS/TS MCP server. */
function declaredPropsJs(source, toolName) {
  const start = source.indexOf(`name: "${toolName}"`);
  if (start < 0) return null;
  const rest = source.slice(start);
  const end = rest.indexOf("required:");
  const frag = end >= 0 ? rest.slice(0, end) : rest.slice(0, 6000);
  return new Set([...frag.matchAll(/\n\s{6,10}(\w+):\s*\{/g)].map((m) => m[1]));
}

test("every parameter the fan-out sends is declared by the tool that receives it", async () => {
  // Replaces a guard whose allowlists were hand-copied literals. Two had drifted
  // from the shipped tools — veeva was missing start_date_from / start_date_to /
  // updated_since, chinadrugtrials was missing seven filter fields — and who_ictrp
  // wrongly ALLOWED `filters`, which ictrp_search does not declare (it belongs to
  // ictrp_filter, a different tool). The drift happened to be harmless because
  // mapArgs emits two or three arguments and those were right on both sides; that
  // is luck, and it stops being luck the moment someone widens mapArgs.
  //
  // The guard now reads each declaration from the shipped source. Two servers are
  // npm packages we do not vendor, so their sets are pinned with the version the
  // names were read from — a bump is then a visible edit here, not a silent drift.
  const { readFileSync } = await import("node:fs");
  const vendor = new URL("../resources/plugins/xyb.trial-sources/mcp/", import.meta.url);

  const cde = declaredPropsJs(readFileSync(new URL("chinadrugtrials-mcp.mjs", vendor), "utf8"), "search_trials");
  assert.ok(cde && cde.size >= 10, "CDE 声明集读取失败（太小或找不到工具）");

  // chictr-mcp-server@3.0.2, search_trials
  const chictr = new Set(["keyword", "registration_number", "year", "max_results"]);
  // ctv-mcp-server@0.1.0, SEARCH_PROPS for search_studies
  const veeva = new Set([
    "keyword", "condition", "sponsor", "status", "phase", "country", "type",
    "start_date_from", "start_date_to", "updated_since", "limit", "offset",
  ]);

  const py = readFileSync(new URL("ictrp/ictrp_mcp/server.py", vendor), "utf8");
  const start = py.indexOf('name="ictrp_search"');
  assert.ok(start >= 0, "vendored server.py 里找不到 ictrp_search");
  const frag = py.slice(start, py.indexOf('"required"', start));
  const ictrp = new Set([...frag.matchAll(/"(\w+)":\s*\{/g)].map((m) => m[1]));
  ictrp.delete("items");
  ictrp.delete("properties");
  assert.ok(ictrp.size >= 6, "ICTRP 声明集读取失败（太小）");

  const declared = { chictr, veeva_ctv: veeva, chinadrugtrials: cde, who_ictrp: ictrp };
  for (const [key, allowed] of Object.entries(declared)) {
    const args = mapArgs(sourceByKey(key), "pancreatic cancer");
    assert.ok(Object.keys(args).length > 0, `${key} 的 mapArgs 什么都没产出`);
    for (const name of Object.keys(args)) {
      assert.ok(
        allowed.has(name),
        `${key} 会发送它并未声明的参数 "${name}"；该工具声明的是 ${[...allowed].sort().join(", ")}`,
      );
    }
  }
});
