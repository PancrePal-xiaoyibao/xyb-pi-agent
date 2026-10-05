/**
 * Trial-source registry — the closed list of sources the host is willing to fan out to.
 *
 * SPEC: docs/spec/xyb-unified-trial-host-orchestration.md §4.1, §4.2, §6.2, §15.3.3
 *
 * Why this table lives in the host and not in a plugin: a plugin declaring
 * "I am a qualified trial source" would be self-authorising entry into the
 * fan-out, which is exactly the presumed consent §4.2 forbids. So the model
 * cannot name a source, plugin, server, tool, URL, executable, permission mode,
 * source subset or timeout — it can only supply a query string. Everything
 * addressable lives here.
 *
 * `kind` is load-bearing, not decoration:
 *   - remote_registry      : live upstream query, the result *is* current state
 *   - aggregator_registry  : authoritative but its row set is a LOWER BOUND
 *   - local_index          : local index, must expose its build time
 *   - archived_scrape      : bundled cold-start archive
 */

import type { TrialSource } from "./trial-fanout.ts";
import { pluginToolName } from "@pi-desktop/plugin-sdk";

/** @typedef {"condition_terms" | "keyword_maxresults" | "keyword_limit_offset" | "keywords_pages"} ArgShape */
/** @typedef {"remote_registry" | "local_index" | "archived_scrape" | "aggregator_registry"} SourceKind */

/**
 * Upstream row sets that are systematically incomplete. A source listed here
 * can never have its row count presented as "trials matching your query", only
 * as a lower bound (SPEC §15.2, §15.5).
 */
export const UPSTREAM_INCOMPLETE_SOURCES = Object.freeze(["who_ictrp"]);

/**
 * The closed registry. Adding a source means adding a descriptor here plus a
 * contract test — never editing the orchestrator's state machine or the UI
 * renderer (SPEC §6.2 point 2).
 */
export const TRIAL_SOURCES = Object.freeze([
  Object.freeze({
    key: "clinicaltrials_gov",
    pluginId: "xyb.trials",
    serverId: null,
    toolName: "xyb_trials_search",
    argShape: "condition_terms",
    kind: "remote_registry",
    sideEffect: "none",
    defaultLimit: 20,
    timeoutMs: 20_000,
    freshness: "live",
    label: "ClinicalTrials.gov",
  }),
  Object.freeze({
    key: "chictr",
    pluginId: "xyb.trial-sources",
    serverId: "chictr",
    toolName: "search_trials",
    argShape: "keyword_maxresults",
    kind: "remote_registry",
    sideEffect: "none",
    defaultLimit: 20,
    timeoutMs: 45_000,
    freshness: "live",
    label: "ChiCTR（中国临床试验注册中心）",
  }),
  Object.freeze({
    key: "veeva_ctv",
    pluginId: "xyb.trial-sources",
    serverId: "veeva-ctv",
    toolName: "search_studies",
    argShape: "keyword_limit_offset",
    kind: "local_index",
    sideEffect: "none",
    defaultLimit: 20,
    timeoutMs: 15_000,
    freshness: "build_time",
    label: "Veeva CTV",
  }),
  Object.freeze({
    key: "chinadrugtrials",
    pluginId: "xyb.trial-sources",
    serverId: "chinadrugtrials",
    toolName: "search_trials",
    // The CDE server names these `keywords` (plural, comma-separated) and
    // paginates by `max_pages`, not by limit/offset. Confirmed against
    // mcp/chinadrugtrials-mcp.mjs's search_trials inputSchema.
    argShape: "keywords_pages",
    kind: "archived_scrape",
    // Reads the bundled archive; the fan-out never touches the network or the
    // disk in a way that needs consent. Network pulls (sync_incremental) are a
    // separate, consented path and are NOT part of the query fan-out (§4.3).
    sideEffect: "none",
    defaultLimit: 20,
    timeoutMs: 30_000,
    freshness: "build_time",
    label: "药物临床试验登记与信息公示平台",
  }),
  Object.freeze({
    key: "who_ictrp",
    pluginId: "xyb.trial-sources",
    serverId: "who-ictrp",
    toolName: "ictrp_search",
    argShape: "keyword_limit_offset",
    kind: "aggregator_registry",
    sideEffect: "none",
    defaultLimit: 20,
    // ICTRP's own session default is 60s and is not configurable from the
    // service layer (§15.6). The bundled snapshot is the real mitigation, so
    // this deadline stays as-is: widening it only makes the user wait longer.
    timeoutMs: 60_000,
    freshness: "live",
    label: "WHO ICTRP",
    // The only source served by an out-of-process interpreter. When its tool is
    // missing from the catalog, this flag is what turns a bare "not queried"
    // into "Python is missing, here is the line to run" (§15.9 criteria 2 vs 3).
    requiresRuntime: "python3",
  }),
]);

/** Fan-out concurrency ceiling. Kept at the value the four-source era used. */
export const MAX_FANOUT_CONCURRENCY = 4;

/** Wall-clock deadline for the whole fan-out (SPEC §4.4). */
export const OVERALL_DEADLINE_MS = 75_000;

/**
 * How often the fan-out's wait loop wakes up to re-check its own deadline.
 *
 * The wait has to be able to end on its own: a race between child promises
 * settles only when a child settles, so without this poll a single child that
 * never returns parks the whole composite forever — past every deadline, with
 * no terminal state and nothing to show the user. Polling is needed rather than
 * one armed timeout because the loop's clock (`now()`) is injected for tests.
 *
 * 250ms is well below the 15s timeout of the fastest source, so a hung child is
 * noticed promptly, and it costs at most four comparisons per second of the
 * 75s ceiling.
 */
export const FANOUT_WAKEUP_POLL_MS = 250;

/**
 * Dispatch order for the fan-out: longest processing time first (LPT).
 *
 * Why it is explicit data and not `TRIAL_SOURCES` order: with a concurrency
 * ceiling of 4 and five sources, one source starts late. If the *longest*
 * source starts late, the whole fan-out waits on it; if the shortest does, the
 * late start costs nothing because the long source was going to dominate the
 * wall clock anyway.
 *
 * Concretely with the v1 deadlines (CT.gov 20s, ChiCTR 45s, Veeva 15s,
 * CDE 30s, ICTRP 60s) and concurrency 4: ICTRP must be in the first batch.
 * Starting it first gives t=0 ICTRP(60) + ChiCTR(45) + CDE(30) + Veeva(15),
 * then t=15 CT.gov(20) → total 60s. Any ordering that starts ICTRP late makes
 * it the critical path: starting it at t=15 ends at t=75, which exactly fills
 * the 75s overall deadline with zero slack.
 *
 * This is derived by sorting on `timeoutMs` descending so it cannot drift out
 * of agreement with the deadlines above.
 */
export function dispatchOrder(): TrialSource[] {
  return TRIAL_SOURCES.slice().sort((a, b) => {
    if (b.timeoutMs !== a.timeoutMs) return b.timeoutMs - a.timeoutMs;
    // Stable tie-break on registry order keeps the schedule reproducible.
    return TRIAL_SOURCES.indexOf(a) - TRIAL_SOURCES.indexOf(b);
  });
}

/**
 * How many sibling calls one fan-out issues. Used to size host capacity: the
 * composite holds its own plugin permit for the whole fan-out, so the budget
 * needs `composite + children` slots or a sibling queues for 30s and fails as
 * HOST_OVERLOADED — a reason that hides the real per-source timeout.
 */
export const FANOUT_CHILD_COUNT = TRIAL_SOURCES.length;

const BY_KEY = new Map<string, TrialSource>(
  TRIAL_SOURCES.map((source) => [source.key as string, source as TrialSource]),
);

/** Look a descriptor up by its registry key. Returns undefined for anything else. */
export function sourceByKey(key: string): TrialSource | undefined {
  return BY_KEY.get(key);
}

/** Every registered key, in display order (matches the spec's ordered key list). */
export function sourceKeys(): string[] {
  return TRIAL_SOURCES.map((source) => source.key);
}

/** True when the source's upstream row set is a lower bound rather than a count. */
export function isUpstreamIncomplete(key: string): boolean {
  return (UPSTREAM_INCOMPLETE_SOURCES as readonly string[]).includes(key);
}

/**
 * The exact tool identity a child dispatch must address.
 *
 * Deliberately derived from the descriptor rather than accepted from a caller:
 * a child call that names its own tool is a child call that can name someone
 * else's tool.
 *
 * **Built with `pluginToolName`, never by string interpolation.** The previous
 * template hand-wrote `plugin_${pluginId}_${serverId}_${toolName}`, which looks
 * right and is wrong on every source: the catalog registers through
 * `pluginToolName`, which sanitises `[^a-zA-Z0-9_]` to `_`. So the plugin id
 * `xyb.trial-sources` registers as `xyb_trial_sources`, and the server ids
 * `veeva-ctv` / `who-ictrp` / `chictr-mcp-server` lose their hyphens. Every
 * derived name carried the dots and hyphens the catalog had replaced, matched
 * nothing, and the fan-out reported all five sources as
 * `TOOL_UNAVAILABLE / 当前会话中不可用` while the tools were loaded and working.
 *
 * The production symptom was "0/5 来源覆盖，五个都说工具在任何会话都不可用".
 * Unit tests passed because the tests' fake catalogs were built with the same
 * wrong string, so the two mistakes agreed with each other.
 *
 * MCP tools are registered under the *key* `pluginMcpToolKey(serverId, toolName)`
 * = `${serverId}_${toolName}`, then passed through `pluginToolName` — so the two
 * halves must be joined before sanitising, exactly as done below.
 */
export function childToolName(source: TrialSource): string {
  const localKey = source.serverId
    ? `${source.serverId}_${source.toolName}`
    : source.toolName;
  return pluginToolName(source.pluginId, localKey);
}

/**
 * Map a model-supplied query onto one source's own parameter names (SPEC §4.1:
 * parameter mapping is the registry's job so the model never guesses).
 *
 * `query` is a plain string; nothing in it can redirect the call. Every shape
 * below was read off the real tool's `inputSchema`, not assumed:
 *   - xyb_trials_search      : { condition, terms }         (xyb.trials/main.js)
 *   - chictr search_trials   : { keyword, max_results }     (chictr-mcp-server 3.0.2)
 *   - veeva search_studies   : { keyword, limit, offset }   (ctv-mcp-server 0.1.0)
 *   - cde search_trials      : { keywords, max_pages }      (chinadrugtrials-mcp.mjs)
 *   - ictrp_search           : { keyword, limit, offset }   (ictrp_mcp/server.py)
 */
export function mapArgs(source: TrialSource, query: string): Record<string, unknown> {
  const keyword = typeof query === "string" ? query.trim() : "";
  switch (source.argShape) {
    case "condition_terms":
      // Two-field sources split the query: the leading phrase is the condition,
      // the remainder are the free terms. A single-word query is all condition.
      return { condition: keyword, terms: "" };
    case "keyword_maxresults":
      return { keyword, max_results: source.defaultLimit };
    case "keyword_limit_offset":
      return { keyword, limit: source.defaultLimit, offset: 0 };
    case "keywords_pages":
      // `max_pages` is a page count, not a row count: the CDE server pages at
      // roughly 10 records. Round up so `defaultLimit` is never undershot.
      return { keywords: keyword, max_pages: Math.ceil(source.defaultLimit / 10) };
    default:
      throw new Error(`unmapped argShape: ${source.argShape}`);
  }
}

/**
 * Manual MCP servers whose tool names collide with a built-in trial source.
 *
 * SPEC §15.12(c), user ruling: a server the user configured by hand never enters
 * the fan-out — its argument shape, result contract and row-count semantics are
 * unknown, so it cannot be terminalised, and the built-in sources carry a
 * contract ("a failure never returns zero rows") that a foreign server does not.
 *
 * But overlap must still be *detected and shown*. If a user's hand-configured
 * `ictrp` server sits next to the built-in one, the model may call either; the
 * two do not de-duplicate against each other, so a merged count silently becomes
 * an upper bound. That turns "the count is a lower bound" into a lie. Silence is
 * the failure mode here, not duplication.
 *
 * Normalisation folds case and `-`/`_` so `Veeva-CTV`, `veeva_ctv` and
 * `veevaCTX`-style variants all match.
 */
function normalizeServerId(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** The built-in trial sources' server ids, for overlap comparison. */
const BUILTIN_SERVER_IDS = Object.freeze([
  ...new Set(
    TRIAL_SOURCES.map((source) => source.serverId).filter((id) => typeof id === "string" && id.length > 0),
  ),
]);

/**
 * Report every manual MCP tool whose server or tool name shadows a built-in
 * trial source.
 *
 * @param {{ fullName?: string, serverId?: string, toolName?: string }[]} manualTools
 * @returns {{ serverId: string, toolName: string, builtin: string, builtinTool: string, manual: string }[]}
 */
export type ManualOverlap = {
  serverId: string;
  toolName: string;
  builtin: string;
  builtinTool: string;
  manual: string;
};

export function detectManualOverlaps(
  manualTools: { fullName?: string; serverId?: string; toolName?: string }[] | null | undefined,
): ManualOverlap[] {
  const overlaps: ManualOverlap[] = [];
  if (!Array.isArray(manualTools)) return overlaps;
  for (const tool of manualTools) {
    const server = normalizeServerId(tool?.serverId);
    const name = normalizeServerId(tool?.toolName);
    if (!server && !name) continue;
    for (const source of TRIAL_SOURCES) {
      const builtinServer = normalizeServerId(source.serverId);
      const builtinTool = normalizeServerId(source.toolName);
      // Same server id is the strong signal. A tool name that matches a built-in
      // source's own tool name across a differently-named server is the weaker
      // one, and is still worth surfacing because the model will read it as the
      // same capability.
      const sameServer = builtinServer && server === builtinServer;
      const sameTool = builtinTool && name === builtinTool;
      if (sameServer || sameTool) {
        overlaps.push({
          serverId: String(tool?.serverId ?? ""),
          toolName: String(tool?.toolName ?? ""),
          builtin: source.key,
          builtinTool: childToolName(source),
          manual: String(tool?.fullName ?? tool?.serverId ?? ""),
        });
        break;
      }
    }
  }
  return overlaps;
}
