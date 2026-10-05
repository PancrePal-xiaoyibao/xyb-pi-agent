/**
 * Trial-query fan-out broker.
 *
 * SPEC: docs/spec/xyb-unified-trial-host-orchestration.md §4.1, §4.2, §4.4
 *
 * This is the seam between "the orchestrator decided to ask five sources" and
 * "host-core actually admitted five tool calls". It lives in Electron because
 * Electron is the only party that holds both the host RPC client and the
 * plugin catalog, but it is deliberately thin: it decides *nothing* about which
 * sources exist, what they are called, or what their parameters are. All of
 * that is the registry's, so a compromised or confused caller cannot widen the
 * fan-out.
 *
 * What it must get right (§4.2):
 *   - every child goes through the ordinary `tools.execute` permission path,
 *     with a unique child toolCallId and the original session/turn identity;
 *   - a child never starts before its own permission decision allows it;
 *   - the user can see *which* source is asking for approval, so each child
 *     pre-registers its attribution under the composite's identity;
 *   - the composite result preserves every decision.
 *
 * It must NOT do the tempting shortcut: calling `RegisteredPluginTool.execute`
 * directly, or `McpServerClient.callTool` directly. Those skip the permission
 * gate, the session grant, the admission budget and the audit trail — the four
 * things §4.2 exists to preserve.
 */

import { pluginToolName } from "@pi-desktop/plugin-sdk";

/**
 * Registry descriptor (see trial-sources.ts). Declared structurally here so the
 * broker depends on the shape it uses, not on the whole descriptor.
 */
export type TrialSource = {
  key: string;
  label: string;
  kind: string;
  pluginId: string;
  serverId: string | null;
  toolName: string;
  argShape: string;
  sideEffect?: string;
  defaultLimit: number;
  timeoutMs: number;
  freshness?: string;
  /**
   * Set when this source needs something outside the process to work at all —
   * a Python interpreter for the vendored ICTRP service, say. Only sources with
   * this flag get a runtime probe when their tool turns out to be unregistered.
   */
  requiresRuntime?: string;
};

/**
 * What one dispatch reported. Every field is optional because the broker only
 * sets what it observed — an absent field means "not reported", never "reported
 * false". The terminaliser relies on that distinction (`toolRegistered === false`
 * rather than `!toolRegistered`).
 */
export type SourceOutcome = {
  records?: unknown[];
  elapsedMs?: number;
  truncated?: boolean;
  denied?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  challenge?: boolean;
  toolRegistered?: boolean;
  needsSetup?: boolean;
  userDisabled?: boolean;
  overallDeadline?: boolean;
  /**
   * The caller never produced an outcome for this source at all.
   *
   * Distinct from `overallDeadline`, which asserts a concrete cause. A caller
   * that simply omits a source has said nothing about why it did, and inventing
   * a deadline for it states a cause that was never established.
   */
  notAttempted?: boolean;
  explanation?: string;
  /**
   * A single copy-pasteable command that resolves `needsSetup`, when one
   * exists. §15.9 criterion 3 requires the repair line to be *runnable*, so it
   * travels with the outcome rather than being composed from the reason code
   * by each consumer.
   */
  fixCommand?: string;
  error?: string;
  reasonCode?: string;
  upstreamReportedTotal?: number;
  matchedRowsReturned?: number;
  /** WHO-processed date, verbatim from the aggregator's provenance (clause 4.b(3)). */
  processedAt?: string;
};

/** Narrow an unknown into a string-keyed bag for tolerant field reads. */
function asBag(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A host-core `tools.execute` result, as it crosses back into Electron. */
export type DispatchResult = {
  ok?: boolean;
  content?: unknown;
  errorCode?: string;
  denied?: boolean;
  durationMs?: number;
};

/** One child dispatch. */
export type ChildCall = {
  sessionId: string;
  turnId?: string | null;
  toolCallId: string;
  toolName: string;
  args: unknown;
  mode?: string;
  label?: string;
};

/** The minimal catalog entry the broker needs to dispatch a source. */
export type ResolvedTool = { fullName: string; pluginId?: string };

/** One entry of the aggregate result's `statuses` table. */
export type SourceConclusion = {
  source: string;
  displayName: string;
  state: string;
  reasonCode?: string;
  explanation: string;
  /** A runnable repair line for `NEEDS_SETUP` states, when one exists. */
  fixCommand?: string;
  attempted: boolean;
  records: unknown[];
  resultCount: number;
  elapsedMs: number;
  kind?: string;
  freshness?: string;
  toolName?: string;
  truncated?: boolean;
  requestedLimit?: number;
  upstreamIncomplete?: boolean;
  upstreamReportedTotal?: number;
  matchedRowsReturned?: number;
  /** WHO-processed date, verbatim from the aggregator's provenance (clause 4.b(3)). */
  processedAt?: string;
};

import {
  FANOUT_WAKEUP_POLL_MS,
  MAX_FANOUT_CONCURRENCY,
  OVERALL_DEADLINE_MS,
  dispatchOrder,
  mapArgs,
  detectManualOverlaps,
  isUpstreamIncomplete,
} from "./trial-sources.ts";
import { aggregate, terminalise } from "./trial-orchestrator.ts";
import type { ProbeResult } from "./trial-runtime.ts";

/** Error codes host-core returns in-band (not as JSON-RPC errors). */
export const HOST_ERROR_CODES = Object.freeze({
  DENIED: "TOOL_DENIED",
  ABORTED: "TOOL_ABORTED",
  TIMEOUT: "TOOL_TIMEOUT",
  NOT_FOUND: "TOOL_NOT_FOUND",
  OVERLOADED: "HOST_OVERLOADED",
  TURN_CANCELLED: "TOOL_TURN_CANCELLED",
  FAILED: "TOOL_FAILED",
  DISABLED_IN_PLAN: "PLUGIN_DISABLED_IN_PLAN",
});

/**
 * Map one host-core `tools.execute` result onto the outcome shape the
 * terminaliser consumes.
 *
 * The important detail: host-core reports a permission denial and a capacity
 * rejection as a *normal* result with `ok:false` plus an `errorCode`, not as a
 * JSON-RPC error. So a caller that only wraps this in try/catch will see five
 * "successes" and silently treat denials as empty result sets. Everything here
 * exists to prevent that.
 *
 * Pure function so the mapping is testable without a host.
 */
/**
 * @param {TrialSource} source
 * @param {DispatchResult | undefined} result
 * @returns {SourceOutcome}
 */
export function interpretDispatchResult(source: TrialSource, result: DispatchResult | undefined): SourceOutcome {
  const elapsedMs = typeof result?.durationMs === "number" ? result.durationMs : 0;

  if (!result || result.ok !== true) {
    const code = result?.errorCode ?? HOST_ERROR_CODES.FAILED;
    const bag = asBag(result?.content);
    const message = bag.error ?? bag.message ?? "";

    if (result?.denied === true || code === HOST_ERROR_CODES.DENIED) {
      return { denied: true, elapsedMs };
    }
    if (code === HOST_ERROR_CODES.ABORTED || code === HOST_ERROR_CODES.TURN_CANCELLED) {
      return { cancelled: true, elapsedMs };
    }
    if (code === HOST_ERROR_CODES.TIMEOUT) {
      // The host's own dispatch timeout elapsed. This is the source failing to
      // return in time, not the composite giving up on it.
      return { timedOut: true, elapsedMs };
    }
    if (code === HOST_ERROR_CODES.NOT_FOUND) {
      // The tool vanished between catalog check and dispatch. An availability
      // fact, so TOOL_UNAVAILABLE rather than a failure of the source itself.
      return { toolRegistered: false, elapsedMs };
    }
    if (code === HOST_ERROR_CODES.OVERLOADED) {
      // Admission rejected the child. Reported as an error with the real text
      // so the user sees capacity pressure rather than a fake empty result.
      return {
        error: String(message) || "host tool capacity did not become available",
        reasonCode: HOST_ERROR_CODES.OVERLOADED,
        elapsedMs,
      };
    }
    if (code === HOST_ERROR_CODES.DISABLED_IN_PLAN) {
      return {
        needsSetup: false,
        denied: true,
        elapsedMs,
      };
    }
    return {
      error: String(message) || code,
      reasonCode: code,
      elapsedMs,
    };
  }

  const content = result.content;
  if (detectChallenge(content)) {
    return { challenge: true, elapsedMs };
  }
  return {
    records: extractRecords(content),
    elapsedMs,
    truncated: asBag(content).truncated === true,
    ...lowerBoundEvidence(source, content),
  };
}

/**
 * Peel the MCP `TextContent` wrapper off a child's result, if present.
 *
 * An MCP tool answers `{content: [{type: "text", text: "<json>"}], isError}`
 * (`plugin-mcp.ts` `callTool` returns the raw protocol result), while a
 * plugin-registered tool returns its structured value directly. Both reach this
 * broker by the same route, so a field read that only understands one shape
 * silently finds nothing on the other — which is exactly how a working channel
 * comes to look like an empty one.
 *
 * Unwrapping is deliberately shallow and non-destructive: a payload that is
 * already structured passes through untouched, and text that does not parse as
 * JSON is left alone (a plain-text answer is a legitimate answer, and turning a
 * parse failure into `{}` would erase the evidence of what was returned).
 */
export function unwrapToolContent(content: unknown): unknown {
  const blocks = Array.isArray(content)
    ? content
    : content && typeof content === "object" && Array.isArray(asBag(content).content)
      ? (asBag(content).content as unknown[])
      : null;
  if (!blocks) return content;

  const texts = blocks
    .map((block) => (block && typeof block === "object" ? asBag(block).text : undefined))
    .filter((text): text is string => typeof text === "string" && text.trim() !== "");
  if (texts.length === 0) return content;

  // One text block is the ordinary case; several are joined the way the host's
  // own `describeMcpContent` joins them, so a multi-block answer still parses.
  const joined = texts.join("\n").trim();
  try {
    const parsed = JSON.parse(joined);
    return parsed && typeof parsed === "object" ? parsed : content;
  } catch {
    return content;
  }
}

/**
 * Pull the aggregator's two numbers and the WHO-processed date out of a real
 * child payload.
 *
 * `ictrp_search` answers in snake_case and nests the date inside `provenance`:
 * `upstream_reported_total`, `matched_rows_returned`,
 * `provenance.ictrp_export_date` (ictrp_mcp/tools.py `search()`). `terminalise`
 * reads camelCase `upstreamReportedTotal` / `matchedRowsReturned`, so without
 * this translation the UI's two-number block and its clause-4.b(3) date line
 * would both silently render "未报告" no matter what the service actually said.
 *
 * Three deliberate properties:
 *   - Only the declared lower-bound source is read. A count that arrives from a
 *     source whose row set is not systematically short is just a count, and
 *     displaying it as a lower bound would understate a complete answer.
 *   - A missing number stays `undefined`, never `0`. "No number" and "the number
 *     is zero" are different claims (§5).
 *   - The WHO date is taken from provenance verbatim and never falls back to
 *     `Date.now()`: that would be "when we fetched", which is not the fact
 *     clause 4.b(3) asks the user to see, and it would look authoritative while
 *     being wrong.
 */
function lowerBoundEvidence(
  source: TrialSource,
  content: unknown,
): Pick<SourceOutcome, "upstreamReportedTotal" | "matchedRowsReturned" | "processedAt"> {
  if (!isUpstreamIncomplete(source.key)) return {};
  const bag = asBag(unwrapToolContent(content));
  const provenance = asBag(bag.provenance);
  return {
    upstreamReportedTotal: finiteOrUndefined(bag.upstream_reported_total),
    matchedRowsReturned: finiteOrUndefined(bag.matched_rows_returned),
    processedAt: typeof provenance.ictrp_export_date === "string" && provenance.ictrp_export_date
      ? provenance.ictrp_export_date
      : undefined,
  };
}

/**
 * Keep only genuine finite numbers; anything else is "not reported".
 *
 * A string like `"6262"` is converted rather than dropped, because the service
 * is free to serialise counts as strings and a count is a count. `null`, `""`,
 * `NaN` and objects are all absence, not zero.
 */
function finiteOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Recognise a verification challenge in an otherwise "successful" response.
 *
 * A challenge arrives as HTTP 200 with a challenge page, so it cannot be
 * detected by status code. It must never be worked around (§5.2
 * `CHALLENGE_REQUIRED` is explicitly "永不绕过").
 */
/**
 * @param {unknown} content
 * @returns {boolean}
 */
export function detectChallenge(content: unknown): boolean {
  const bag = asBag(content);
  if (bag.challenge === true || bag.challengeRequired === true) return true;
  const code = bag.code ?? bag.errorCode;
  return code === "CHALLENGE_REQUIRED" || code === "SOURCE_CHALLENGE";
}

/**
 * Pull the record array out of a plugin tool's response.
 *
 * Plugin tools do not share one envelope, so this reads the known shapes rather
 * than assuming one. Returning `[]` for an unrecognised shape would be the
 * dangerous option — it turns "I do not understand this response" into "no
 * results" — so an unrecognised shape throws and the caller terminalises it as
 * FAILED.
 */
/**
 * @param {unknown} content
 * @returns {unknown[]}
 */
export function extractRecords(content: unknown): unknown[] {
  if (!content || typeof content !== "object") {
    throw new Error("source returned no record envelope");
  }
  // Unwrap BEFORE the bare-array shortcut: an MCP answer arrives as
  // `[{type:"text", text:"<the real payload>"}]`, which is itself an array.
  // Returning it as-is would hand the caller one pseudo-record — the envelope —
  // instead of the trials inside it, so every MCP source would report exactly
  // 1 result no matter how many rows it returned. Only a payload that is still
  // an array *after* unwrapping is a genuine bare record list.
  const unwrapped = unwrapToolContent(content);
  if (Array.isArray(unwrapped)) return unwrapped;
  const bag = asBag(unwrapped);
  for (const key of ["records", "trials", "studies", "results", "items", "data"]) {
    const value = bag[key];
    if (Array.isArray(value)) return value;
  }
  // A structured answer with an explicit count of zero is a real zero.
  const count = bag.total ?? bag.count ?? bag.totalCount;
  if (typeof count === "number" && count === 0) return [];
  throw new Error(`source returned an unrecognised envelope: ${Object.keys(bag).join(",")}`);
}

/**
 * Run one bounded list-scheduling pass over the sources.
 *
 * Guarantees, in order of importance:
 *   1. A source is never dispatched twice for one composite (the dedup set).
 *   2. The overall deadline stops *starting* new work; work already started is
 *      reported as TIMEOUT, and work never started as NOT_QUERIED with
 *      `OVERALL_DEADLINE`.
 *   3. Late results never rewrite an already-returned conclusion.
 *   4. Every registered source ends with exactly one terminal state.
 *
 * The scheduler is injected so tests drive it with fake sources, and the
 * concurrency ceiling is the registry's, not a caller's.
 */
export async function runFanout({
  sources = dispatchOrder(),
  dispatch,
  deadlineMs = OVERALL_DEADLINE_MS,
  concurrency = MAX_FANOUT_CONCURRENCY,
  now = () => Date.now(),
  isCancelled = () => false,
}: {
  sources?: TrialSource[];
  dispatch: (source: TrialSource) => Promise<SourceOutcome>;
  deadlineMs?: number;
  concurrency?: number;
  now?: () => number;
  isCancelled?: () => boolean;
}): Promise<SourceConclusion[]> {
  const startedAt = now();
  const conclusions = new Map();
  const dispatched = new Set();
  const inflight = new Map();
  const pending = sources.slice();

  const deadlineReached = () => now() - startedAt >= deadlineMs;
  const aborted = () => isCancelled();

  // Every promise in `inflight` carries a marker so the wait loop can tell
  // "this child settled" from "the poll woke me because time passed". A
  // never-settling child has no marker value to inspect — the marker is the
  // thing that exists precisely when there is something to read.
  const WAKEUP = Symbol("fanout.wakeup");
  const waitForWakeup = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(WAKEUP), Math.max(1, Math.min(FANOUT_WAKEUP_POLL_MS, remainingMs())));
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
    });
  const remainingMs = () => Math.max(0, deadlineMs - (now() - startedAt));

  const startOne = (source: TrialSource) => {
    if (dispatched.has(source.key)) return null;
    dispatched.add(source.key);
    const promise = (async () => {
      try {
        const outcome = await dispatch(source);
        return { source, outcome };
      } catch (error) {
        return {
          source,
          outcome: {
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: now() - startedAt,
          },
        };
      }
    })();
    inflight.set(source.key, { source, promise });
    return promise;
  };

  while (pending.length > 0 || inflight.size > 0) {
    // Fill free slots. The deadline and cancellation stop new starts only.
    while (pending.length > 0 && inflight.size < concurrency) {
      if (deadlineReached() || aborted()) break;
      const source = pending.shift();
      if (!source) break;
      startOne(source);
    }

    if (inflight.size === 0) break;

    // Wait for whichever child settles first — but never longer than the
    // overall deadline, and never longer than it takes an aborted turn to be
    // noticed.
    //
    // This used to be a bare `Promise.race([...inflight.values()])`. A race
    // with no timer only settles when something *else* settles, so one child
    // that never returns (a hung MCP subprocess, a suspended sidecar, a promise
    // nobody resolves) parked the whole composite on that await forever: no
    // timeout, no terminal state, no sentence for the user — the two failures
    // the doc comment above promises cannot happen. The comment here already
    // said "re-arm if none settle"; nothing in the code could re-arm it. That
    // is the difference between describing an intent and stating a guarantee.
    //
    // The timer polls rather than firing one exact wake-up: `now()` and
    // `isCancelled()` are injected, so there is no wall clock we could arm a
    // single timeout against, and a poll costs one comparison per interval.
    // `unref()` keeps a pending wait from holding the process alive.
    const settled = await Promise.race([...inflight.values()].map((entry) => entry.promise).concat(waitForWakeup()));

    // Mark first, then sweep: `Promise.race` resolves to whichever promise
    // settled, and the wake-up timer resolves to the same `WAKEUP` sentinel it
    // produced. Anything else is a real child result and still needs recording.
    if (settled !== WAKEUP && settled && typeof settled === "object" && "source" in settled) {
      const result = settled as { source: TrialSource; outcome: SourceOutcome };
      inflight.delete(result.source.key);
      conclusions.set(result.source.key, terminalise(result.source, result.outcome));
    }

    // Sweep anything that has now passed its bound. A settled child was already
    // removed from `inflight` just above, so this only fires for children that
    // are still pending.
    const reached = deadlineReached();
    const stopped = aborted();
    if (reached || stopped) {
      for (const [key, entry] of [...inflight]) {
        if (conclusions.has(key)) continue;
        const source = entry.source;
        inflight.delete(key);
        conclusions.set(
          key,
          terminalise(
            source,
            stopped
              ? { cancelled: true, elapsedMs: now() - startedAt }
              : { timedOut: true, elapsedMs: now() - startedAt },
          ),
        );
      }
    }
  }

  // Anything never started gets a reason, never a silent absence.
  for (const source of sources) {
    if (conclusions.has(source.key)) continue;
    const reason = aborted() ? { cancelled: true } : { overallDeadline: true };
    conclusions.set(source.key, terminalise(source, reason));
  }

  // Preserve registry order in the result regardless of completion order.
  return sources.map((source) => conclusions.get(source.key));
}

/**
 * The broker the orchestrator calls: check the catalog, then dispatch through
 * the ordinary permission path.
 *
 * `resolveTool` must answer from the *live* catalog so a tool unloaded between
 * the composite's own approval and a child's start is refused rather than
 * forwarded (§4.2: re-check liveness immediately before dispatch).
 */
export function createFanoutBroker({
  resolveTool,
  dispatchChild,
  enabledInProject,
  probeRuntime,
  isCancelled,
  now = () => Date.now(),
}: {
  resolveTool: (source: TrialSource) => ResolvedTool | null | undefined;
  dispatchChild: (child: ChildCall) => Promise<DispatchResult>;
  enabledInProject?: (pluginId: string) => boolean;
  /**
   * Check that a source's out-of-process prerequisite is satisfiable.
   *
   * Consulted only when the tool is absent from the catalog, because that is
   * the only point where "not registered" and "cannot be registered" look
   * identical (§15.9 criterion 2 vs 3). A misconfigured runtime leaves no
   * trace by dispatch time — the server simply never registered its tools — so
   * the cause must be re-derived rather than read off the failure.
   */
  probeRuntime?: (source: TrialSource) => Promise<ProbeResult>;
  isCancelled?: () => boolean;
  now?: () => number;
}): (input: {
  sessionId: string;
  turnId?: string | null;
  argsFor: (source: TrialSource) => unknown;
  onChild?: (source: TrialSource, childToolCallId: string) => void;
}) => Promise<SourceConclusion[]> {
  return async function fanout({ sessionId, turnId, argsFor, onChild }) {
    const sources = dispatchOrder();
    return runFanout({
      sources,
      now,
      isCancelled,
      dispatch: async (source) => {
        const tool = resolveTool(source);
        if (!tool || !tool.fullName) {
          // The tool is missing from this session's catalog. Before reporting
          // "not queried", ask whether the reason is a prerequisite the user
          // can fix (§15.3.5). Reporting TOOL_UNAVAILABLE for a missing Python
          // interpreter is true but useless: the tool *is* unavailable, and the
          // user still has no idea what to do about it.
          //
          // A probe that cannot reach a verdict must NOT be promoted to a
          // setup demand — telling someone to install what they already have
          // is worse than saying nothing. Only an explicit `missing` diverts.
          if (source.requiresRuntime && probeRuntime) {
            const probe = await probeRuntime(source);
            if (probe.status === "missing") {
              return {
                needsSetup: true,
                reasonCode: probe.reasonCode,
                explanation: probe.explanation,
                fixCommand: probe.fixCommand,
              };
            }
          }
          return { toolRegistered: false };
        }
        if (enabledInProject && !enabledInProject(tool.pluginId ?? "")) {
          return {
            needsSetup: true,
            reasonCode: "PLUGIN_NOT_ENABLED",
            explanation: `${source.label} 的插件未在当前项目启用。`,
          };
        }
        const childToolCallId = `${turnId ?? sessionId}:trial:${source.key}`;
        const args = argsFor(source);
        // Pre-register attribution so an approval prompt can name this source
        // rather than showing a bare tool name (§4.2, ADR 0062).
        onChild?.(source, childToolCallId);
        const result = await dispatchChild({
          sessionId,
          turnId,
          toolCallId: childToolCallId,
          toolName: tool.fullName,
          args,
        });
        return interpretDispatchResult(source, result);
      },
      concurrency: MAX_FANOUT_CONCURRENCY,
    });
  };
}

/**
 * Normalise the composite's arguments into the single keyword string every
 * source's `argShape` is built from.
 *
 * The composite accepts either `keyword` (the canonical form) or the
 * `condition`/`terms` pair ClinicalTrials.gov uses, because the model will
 * naturally reuse the shape it has seen for that one source. Accepting both
 * here is what stops a CT.gov-shaped call from reaching the registry as an
 * empty keyword and producing five "no results" answers.
 *
 * ImportedClinicalTrials: an empty query is refused rather than fanned out —
 * five empty searches are five wasted network calls and five misleading
 * "0 results" rows.
 */
/**
 * @param {unknown} args
 * @returns {string}
 */
export function normalizeQuery(args: unknown): string {
  const raw = asBag(args);
  // The panel (`trials.html`) and the merge tool disagree about where the query
  // lives: the panel sends `{ query: { keywords, condition } }` while the tool
  // schema takes `condition` / `keywords` at the top level. Both are in use, so
  // read both. Without the nested branch a panel-shaped call to the fan-out
  // threw "需要一个关键词" — and for a search tool a hard failure is easily read
  // as "no results", which is the worst way to be wrong.
  const nested = asBag(raw.query);
  // `keywords` (plural) is what both tool schemas document, `keyword` is the
  // singular form the registry itself uses. Reading only one of them meant a
  // schema-compliant call threw "需要一个关键词" — a hard failure that looks
  // exactly like "no results", which is the worst possible confusion for a
  // search tool. Accept every spelling the caller could reasonably have read.
  const direct =
    firstString(raw.keyword) ||
    firstString(raw.keywords) ||
    firstString(raw.q) ||
    firstString(nested.keyword) ||
    firstString(nested.keywords);
  if (direct) return direct;
  const condition = firstString(raw.condition) || firstString(nested.condition);
  const terms = firstString(raw.terms) || firstString(nested.terms);
  const joined = [condition, terms].filter(Boolean).join(" ").trim();
  if (!joined) {
    throw new Error(
      "试验检索需要一个关键词（keywords / keyword，或 condition/terms）",
    );
  }
  return joined;
}

/** First non-empty trimmed string among the given value, or "" (never null). */
function firstString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The plugin that owns the two trial tools.
 */
export const TRIAL_PLUGIN_ID = "xyb.trials";

/**
 * The agent tool the fan-out backs (§4.1).
 *
 * **Built with `pluginToolName`, never written out by hand.** The previous
 * hard-coded literal was `plugin_xyb.trials_xyb_trials_unify`, which looks right
 * and is wrong: `pluginToolName` sanitises the plugin id, so the dot in
 * `xyb.trials` becomes an underscore and the catalog actually registers
 * `plugin_xyb_trials_xyb_trials_unify`. The string never matched any tool the
 * model could call, which meant the entire fan-out — state machine, LPT
 * dispatch, both lower-bound numbers, WHO attribution, overlap detection — was
 * dead code in production while every test passed, because the tests called
 * `runTrialComposite` directly and never asked what name the host compares
 * against.
 *
 * Deriving it here makes that class of bug impossible to reintroduce: the name
 * is now computed by the same function the catalog uses.
 */
export const TRIAL_COMPOSITE_TOOL = pluginToolName(TRIAL_PLUGIN_ID, "xyb_trials_fanout");

/** The merge-only tool (`xyb_trials_unify`). The host does NOT intercept it. */
export const TRIAL_MERGE_TOOL = pluginToolName(TRIAL_PLUGIN_ID, "xyb_trials_unify");

/** True when this full tool name is the trial composite. */
/**
 * @param {string} fullName
 * @returns {boolean}
 */
export function isTrialCompositeTool(fullName: string): boolean {
  return fullName === TRIAL_COMPOSITE_TOOL;
}

/**
 * Run the composite end to end: fan out, then aggregate.
 *
 * This is the adapter the Electron `plugins.execute` handler calls. It is
 * deliberately in this module (not inline in the handler) so the whole path —
 * catalog check, attribution, dispatch, aggregation — is testable without a
 * host process, and so the handler stays a transport concern.
 *
 * The composite's own approval already happened; each *child* still gets its
 * own, which is the whole reason the fan-out re-enters `tools.execute` instead
 * of calling plugin code directly.
 */
export async function runTrialComposite({
  sessionId,
  turnId,
  args,
  mode,
  logger,
  resolveTool,
  enabledInProject,
  probeRuntime,
  dispatchChild,
  registerChildAttribution,
  releaseChildAttribution,
  manualTools,
  now = () => Date.now(),
}: {
  sessionId: string;
  turnId?: string | null;
  args: unknown;
  mode?: string;
  logger?: { app?: (...a: unknown[]) => void };
  manualTools?: { fullName?: string; serverId?: string; toolName?: string }[];
  resolveTool: (source: TrialSource) => ResolvedTool | null | undefined;
  enabledInProject?: (pluginId: string) => boolean;
  probeRuntime?: (source: TrialSource) => Promise<ProbeResult>;
  dispatchChild: (child: ChildCall) => Promise<DispatchResult>;
  registerChildAttribution?: (child: ChildCall) => void;
  releaseChildAttribution?: (child: ChildCall) => void;
  now?: () => number;
}): Promise<unknown> {
  const startedAt = now();
  const query = normalizeQuery(args);
  const registeredChildren = [];

  const fanout = createFanoutBroker({
    resolveTool,
    enabledInProject,
    probeRuntime,
    now,
    dispatchChild: async (child) => {
      try {
        return await dispatchChild({ ...child, mode });
      } finally {
        releaseChildAttribution?.(child);
      }
    },
  });

  const conclusions = await fanout({
    sessionId,
    turnId,
    argsFor: (source) => mapArgs(source, query),
    onChild: (source, childToolCallId) => {
      const resolved = resolveTool(source);
      const child = {
        sessionId,
        turnId,
        toolCallId: childToolCallId,
        toolName: resolved?.fullName ?? "",
        args: mapArgs(source, query),
        label: source.label,
      };
      registeredChildren.push(child);
      registerChildAttribution?.(child);
    },
  });

  const result = aggregate({
    query,
    conclusions,
    startedAt: new Date(startedAt).toISOString(),
    elapsedMs: now() - startedAt,
    manualOverlaps: detectManualOverlaps(manualTools),
  });

  logger?.app?.("plugin", "info", "trial fan-out complete", {
    data: {
      queried: result.coverage.queried,
      total: result.coverage.total,
      totalRecords: result.totalRecords,
      missing: result.coverage.missingSources.join(","),
    },
  });

  return result;
}
