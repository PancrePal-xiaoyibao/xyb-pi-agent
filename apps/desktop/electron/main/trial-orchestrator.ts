/**
 * Trial-query fan-out: terminal-state adjudication and aggregation.
 *
 * SPEC: docs/spec/xyb-unified-trial-host-orchestration.md §3.3, §5.2, §5.3
 *
 * Pure functions only — no network, no filesystem, no clock beyond what the
 * caller injects. The orchestrator owns dispatch; this module owns the rules
 * that decide what a dispatch *means*, so those rules can be tested without a
 * host, a plugin, or a network.
 *
 * The result shape deliberately matches the already-shipped F2 contract in
 * `resources/plugins/xyb.trials/lib/unified.js` (`statuses` / `coverage` /
 * `completeness` / `totalRecords`), because chat and panel must render one
 * contract. Two field spellings for the same fact is how a UI ends up
 * disagreeing with a test.
 *
 * The single most important rule here: only `SUCCESS` and `NO_RESULTS` count as
 * "we asked". Everything else is a distinct failure to ask, and it may never be
 * rendered as "no results". On 2026-10-03 an enabled, working CDE source was
 * labelled `NOT_ENABLED` with the reason "this tool is not ready in the current
 * context" — a tool-availability problem reported as a user-settings problem —
 * and the user did not get results that were available. That mislabel is what
 * §3.4 point 8 and the `NOT_ENABLED`/`NEEDS_SETUP` distinction exist to prevent.
 */

import { TRIAL_SOURCES, childToolName, isUpstreamIncomplete } from "./trial-sources.ts";
import type { ManualOverlap } from "./trial-sources.ts";
import type { SourceConclusion, SourceOutcome, TrialSource } from "./trial-fanout.ts";

/** The terminal states a source conclusion can hold (SPEC §5.2). */
export const SOURCE_STATES = Object.freeze([
  "SUCCESS",
  "NO_RESULTS",
  "NOT_ENABLED",
  "NEEDS_SETUP",
  "NOT_QUERIED",
  "TIMEOUT",
  "CHALLENGE_REQUIRED",
  "FAILED",
]);

/** States that mean the source was actually asked (SPEC §3.3). */
export const QUERIED_STATES = Object.freeze(["SUCCESS", "NO_RESULTS"]);

/** True when this state means "we asked and this is the answer". */
export function isQueried(state: string): boolean {
  return QUERIED_STATES.includes(state);
}

const DISCLAIMER =
  "以下为公开试验信息整理，供参考，不构成医疗建议；是否符合入组条件需由研究医生判断。";

/**
 * Terminalise one source from the outcome of its dispatch.
 *
 * `outcome` is the narrow shape the Electron broker reports; anything it does
 * not describe becomes `NOT_QUERIED` with a reason rather than a fabricated
 * zero. `toolRegistered: false` is deliberately NOT `NOT_ENABLED`: an absent
 * tool is an availability problem, and the spec reserves `NOT_ENABLED` for a
 * source the user explicitly turned off.
 *
 * `attempted` answers one question only: did the dispatch start? It is
 * deliberately neither `state !== "NOT_QUERIED"` nor an alias for `isQueried`.
 * The exact pairing over every terminal state:
 *
 *     attempted === false  <=>  state in {NOT_QUERIED, NOT_ENABLED, NEEDS_SETUP}
 *
 * `false` therefore covers three different stories — we chose not to ask, the
 * user turned the source off, and the source cannot run yet — while the three
 * states that ARE failures (`TIMEOUT`, `CHALLENGE_REQUIRED`, `FAILED`) report
 * `true`, because we did ask. So `false` does not mean "not asked" (wrong for
 * NOT_ENABLED and NEEDS_SETUP) and `true` does not mean "we have data" (wrong
 * for the three failures). One consequence is worth stating: `isQueried(state)`
 * implies `attempted`, but not the reverse.
 */
export function terminalise(source: TrialSource, outcome: SourceOutcome): SourceConclusion {
  const base = {
    source: source.key,
    displayName: source.label,
    kind: source.kind,
    freshness: source.freshness,
    toolName: childToolName(source),
    attempted: false,
    records: [],
    resultCount: 0,
    elapsedMs: 0,
  };
  const fail = (state: string, reasonCode: string, explanation: string) => ({
    ...base,
    state,
    reasonCode,
    explanation,
  });
  const dispatched = (extra: Record<string, unknown>) => ({ attempted: true, elapsedMs: outcome.elapsedMs ?? 0, ...extra });

  if (outcome.userDisabled) {
    return fail(
      "NOT_ENABLED",
      "SOURCE_DISABLED_BY_USER",
      `${source.label} 已在设置中关闭，本次没有查询。`,
    );
  }
  if (outcome.needsSetup) {
    return {
      ...fail(
        "NEEDS_SETUP",
        outcome.reasonCode ?? "NEEDS_SETUP",
        outcome.explanation ?? `${source.label} 尚未完成初始化，本次没有查询。`,
      ),
      // Carried separately from the prose so the UI can offer it as a runnable
      // line instead of asking the user to retype it out of a sentence.
      ...(outcome.fixCommand ? { fixCommand: outcome.fixCommand } : {}),
    };
  }
  if (outcome.toolRegistered === false) {
    // Not a settings problem: the tool is missing from this session's catalog.
    // Only an explicit `false` means missing — an absent field means the broker
    // did not report registration, which must not be read as absence, or every
    // later branch below becomes unreachable.
    //
    // When the broker also knows the server was declared and its MCP handshake
    // failed, that reason replaces the cause-free sentence. The generic text
    // described a ChiCTR server whose real failure was a 10s `initialize`
    // timeout as merely "not available in this session", which is true and
    // useless: it reads like a transient session quirk rather than a server
    // that failed to start, and it hides the error the user can act on.
    const reason = outcome.toolUnavailableReason;
    if (reason) {
      const detail = reason.message.trim();
      return fail(
        "NOT_QUERIED",
        "MCP_CONNECT_FAILED",
        `${source.label} 的 MCP 服务本次未能连接（${reason.errorCode}）` +
          (detail ? `：${detail}` : "") +
          `，其查询工具因此未注册，本次没有查询。`,
      );
    }
    return fail(
      "NOT_QUERIED",
      "TOOL_UNAVAILABLE",
      `${source.label} 的查询工具在当前会话中不可用，本次没有查询。`,
    );
  }
  if (outcome.denied) {
    return fail(
      "NOT_QUERIED",
      "PERMISSION_DENIED",
      `${source.label} 的查询未被授权，本次没有启动。`,
    );
  }
  if (outcome.notAttempted) {
    // No cause is asserted because none was observed: the caller simply did not
    // report on this source. The text says only that, so the UI cannot show a
    // fabricated "the deadline passed" for a source nobody tried to reach.
    return fail(
      "NOT_QUERIED",
      "NOT_ATTEMPTED",
      `${source.label} 本次没有产生结果，原因未报告。`,
    );
  }
  if (outcome.overallDeadline) {
    return fail(
      "NOT_QUERIED",
      "OVERALL_DEADLINE",
      `整体检索时间已到，${source.label} 还没开始，本次没有查询。`,
    );
  }
  if (outcome.cancelled) {
    return fail("NOT_QUERIED", "TURN_CANCELLED", `本次检索被取消，${source.label} 没有查询。`);
  }
  if (outcome.timedOut) {
    return {
      ...base,
      ...dispatched({}),
      state: "TIMEOUT",
      reasonCode: "SOURCE_TIMEOUT",
      explanation: `${source.label} 在期限内没有返回。`,
    };
  }
  if (outcome.challenge) {
    return {
      ...base,
      ...dispatched({}),
      state: "CHALLENGE_REQUIRED",
      reasonCode: "SOURCE_CHALLENGE",
      explanation: `${source.label} 要求人工验证；请在该来源页面完成验证后重试。`,
    };
  }
  if (outcome.error) {
    return {
      ...base,
      ...dispatched({}),
      state: "FAILED",
      reasonCode: outcome.reasonCode ?? "SOURCE_UPSTREAM_ERROR",
      explanation: `${source.label} 查询失败：${outcome.error}`,
    };
  }

  // Dispatched and returned. `attempted` is true from the moment dispatch
  // starts, regardless of what came back (§5.2).
  const records = Array.isArray(outcome.records) ? outcome.records : [];
  if (records.length === 0) {
    return {
      ...base,
      ...dispatched({}),
      state: "NO_RESULTS",
      reasonCode: "NO_MATCHING_RECORDS",
      explanation: noResultsSentence(source),
    };
  }

  const conclusion: SourceConclusion = {
    ...base,
    ...dispatched({}),
    state: "SUCCESS",
    reasonCode: "OK",
    explanation: successSentence(source, records.length),
    records,
    resultCount: records.length,
    // The host's own truncation, which is explainable, as opposed to the
    // upstream's silent incompleteness below. Both may be true at once (§6.5).
    truncated: Boolean(outcome.truncated),
    requestedLimit: source.defaultLimit,
  };
  if (isUpstreamIncomplete(source.key)) {
    // ICTRP's row set is a lower bound, and the two numbers must stay separate.
    conclusion.upstreamIncomplete = true;
    // §15.9 criterion 4 requires this reason code alongside the two numbers.
    // It is NOT a failure: the result is usable and must be presented. The code
    // exists so a consumer can branch on "these counts are a lower bound"
    // without re-deriving that from the numbers — and so the two-number display
    // is something the contract demands rather than something a UI happens to
    // do. Leaving it at "OK" (the original behaviour) made criterion 4's prose
    // unenforceable: nothing in the payload distinguished a complete count from
    // a lower bound except the numbers themselves, which a consumer may not
    // know to compare.
    conclusion.reasonCode = "UPSTREAM_RESULT_INCOMPLETE";
    conclusion.upstreamReportedTotal = outcome.upstreamReportedTotal;
    conclusion.matchedRowsReturned = outcome.matchedRowsReturned ?? records.length;
    // ICTRP terms 4.b(3) oblige us to display the date WHO processed the data.
    // Carried verbatim from provenance; absent stays absent so the UI can omit
    // the line rather than print a date nobody asserted.
    conclusion.processedAt = outcome.processedAt;
  }
  return conclusion;
}

/**
 * Which first-hand registries each aggregator re-publishes.
 *
 * Mirrors `SOURCE_OVERLAPS` in `resources/plugins/xyb.trials/lib/unified.js`.
 * It has to be duplicated rather than imported: that file is plugin-facing
 * JavaScript loaded by the plugin host, and the Electron main process must not
 * reach into a plugin's private modules. The cost of the duplicate is that the
 * two can drift — which is exactly why `trial-orchestrator.test.mjs` asserts
 * this map against the plugin's own copy, so a divergence fails a test instead
 * of silently mislabelling records.
 */
const SOURCE_OVERLAPS: Record<string, readonly string[]> = Object.freeze({
  who_ictrp: Object.freeze(["chictr", "clinicaltrials_gov", "chinadrugtrials"]),
});

/**
 * Which source wins when two channels carry the same registration number.
 *
 * Mirrors `SOURCE_AUTHORITY` in `resources/plugins/xyb.trials/lib/unified.js`
 * (same duplication rationale as `SOURCE_OVERLAPS`). §15.5 merge rules 1–2:
 * first-hand registries win over aggregators because a first-hand copy is
 * current while ICTRP syncs weekly. The original plugin code picked the winner
 * by `localeCompare`, which happened to be right only because `chictr` sorts
 * before `who_ictrp`; the SPEC records that as a lesson — "只要规则的正确性
 * 依赖某个未写下的排序假设，就必须把它写成数据，而不是留给巧合".
 */
const SOURCE_AUTHORITY: Record<string, number> = Object.freeze({
  clinicaltrials_gov: 0,
  chictr: 0,
  chinadrugtrials: 0,
  veeva_ctv: 10,
  who_ictrp: 20,
});

function compareSourceAuthority(a: string, b: string): number {
  const rankA = SOURCE_AUTHORITY[a] ?? 100;
  const rankB = SOURCE_AUTHORITY[b] ?? 100;
  if (rankA !== rankB) return rankA - rankB;
  return a.localeCompare(b);
}

/**
 * Normalise a registration number for identity comparison.
 *
 * Case and separator folding only — deliberately no fuzzy matching. Merging two
 * different trials because their IDs "look alike" is a far worse failure than
 * showing one trial twice: the user acts on a clinical fact that is not true.
 * Mirrors the plugin's `normalizeRegistryId` (which strips `-`, `_`, space,
 * `·` and `/`).
 */
function normalizeRegistryId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value) return "";
  return value.toUpperCase().replace(/[\s_\-·/]/g, "");
}

/**
 * Field names that may carry a trial's registration number, in priority order.
 *
 * `registration_number` is here because that is what the bundled ChiCTR archive
 * actually calls it — verified against the real seed, where **all 468 rows**
 * carry `registration_number` (e.g. `ChiCTR-DCC-14004957`) and none carries
 * `registryId`, `registry_id`, `nctId` or `id`. Without it every ChiCTR row was
 * unkeyed, so the 468-row first-hand seed could never de-duplicate against the
 * 579 ChiCTR-attributed rows inside the ICTRP snapshot — measured: **0 of 0**
 * real overlaps found, on data where the overlap is the whole reason both
 * channels exist. The merge logic was correct and starved of input.
 */
const REGISTRY_ID_CANDIDATES = Object.freeze([
  "registry_id",
  "registryId",
  "registration_number",
  "registrationNumber",
  "reg_no",
  "regNo",
  "nct_id",
  "nctId",
  "trial_id",
  "id",
]);

/**
 * Field names that may carry a trial's title.
 *
 * Same shape of gap as the URL and date lists above, found by applying §15.27's
 * lesson to every remaining candidate list: the WHO ICTRP snapshot has **no
 * `title`, no `brief_title` and no `name`** — 0 of 6262 rows — but carries
 * `scientific_title` on 6221 and `public_title` on 6260. Measured through the
 * fan-out: **0 of 50** records had a title, so the panel rendered 50 blank
 * cards. A list of trials with no titles is not a list of trials.
 *
 * `scientific_title` is tried before `public_title` because it is the fuller
 * form; `public_title` is the fallback for the two rows that lack it.
 */
const RECORD_TITLE_CANDIDATES = Object.freeze([
  "title",
  "briefTitle",
  "brief_title",
  "scientific_title",
  "scientificTitle",
  "public_title",
  "publicTitle",
  "name",
]);

/**
 * Field names that may carry a trial's recruitment status.
 *
 * The WHO ICTRP snapshot has no `status`, no `overall_status` and no
 * `sourceStatusRaw` — 0 of 6262 rows — but carries `recruitment_status` on 6233.
 * Separately, the bundled ChiCTR archive carries `recruitment_status` on all
 * 468 rows and no `status` at all. Without this list, "招募中" and "已结束" were
 * indistinguishable on the fan-out path.
 *
 * The resolved value lands in `sourceStatusRaw`, not `status`: it is the
 * registry's own wording, unclassified, and the panel maps it to a Chinese
 * label. Calling it `status` would imply a normalised vocabulary we do not have.
 */
const RECORD_STATUS_CANDIDATES = Object.freeze([
  "recruitment_status",
  "recruitmentStatus",
  "overall_status",
  "overallStatus",
  "status",
  "sourceStatusRaw",
  "state",
]);

/**
 * Field names that may carry the URL a user can open to verify a row.
 *
 * The real names are source-specific and none of them is `url`: the WHO ICTRP
 * snapshot carries `web_address` on **6262 of 6262 rows**, and the bundled
 * ChiCTR archive carries `detail_url` on **468 of 468**. Nothing read either, so
 * on the fan-out path every record rendered without its "查看原始登记信息" link —
 * measured: **0 of 40** real records produced an openable link. An unverifiable
 * citation is not a citation: the point of showing a trial is that the user can
 * go read the registry entry, and WHO terms clause 4.b(1) presumes the user can
 * actually reach the source being attributed.
 */
const RECORD_URL_CANDIDATES = Object.freeze([
  "sourceUrl",
  "source_url",
  "url",
  "link",
  "web_address",
  "detail_url",
  "detailUrl",
  "registry_url",
]);

/**
 * Field names that may carry where a trial is running.
 *
 * Third instance of the same defect class as the title and status lists. The
 * panel renders `地点：` from `record.locations`, and neither real source
 * publishes a field by that name: the ICTRP snapshot carries `countries` (5845
 * of 6262 rows, e.g. `["Australia"]`) and the bundled ChiCTR archive carries
 * `institution` (468 of 468, e.g. "西安交通大学第一附属医院"). Measured through
 * the fan-out: **0 of 40** records had any location.
 *
 * `countries` is tried first because it is a list (a trial can run in several),
 * so it carries more than the single-site `institution` fallback.
 */
const RECORD_LOCATION_CANDIDATES = Object.freeze([
  "locations",
  "countries",
  "country",
  "institution",
  "sites",
  "facilities",
]);

/**
 * Field names that may carry "when was this row last updated upstream".
 *
 * Deliberately never defaulted to the current date. Printing today's date next
 * to a trial asserts it was refreshed today — a claim about the data that nobody
 * made, and the same reasoning as §15.15's refusal to fall back to `Date.now()`
 * for the WHO processing date. A missing date renders as missing.
 */
const RECORD_DATE_CANDIDATES = Object.freeze([
  "fetchedAt",
  "fetched_at",
  "updated_at",
  "updatedAt",
  "last_refreshed_date",
  "registration_date",
]);

/**
 * Attach the channel to every record, and say when a record reached us only
 * through an aggregator.
 *
 * Two separate obligations meet here:
 *
 *  1. §15.16 — attribution must sit on the record, not only in the summary.
 *     The raw rows from the five back ends carry no `source` field at all
 *     (verified against the real ICTRP payload, whose primary key is
 *     `trial_id` and which has no `source` key), so without this the panel's
 *     `it.source` / `it.sourceUrl` render as `undefined` and the record-level
 *     attribution the SPEC demands never appears. Both ends had the concept;
 *     the middle — this function — was missing.
 *
 *  2. §15.7 — WHO ICTRP terms clause 4.b(1) requires attributing data as WHO
 *     ICTRP, and §15.9 criterion 6 requires a Chinese trial reached through the
 *     aggregator to read "ChiCTR via WHO ICTRP", NOT "ChiCTR". Labelling the
 *     aggregator's copy as the first-hand registry would tell the user to go
 *     verify updates at a portal that is not the one holding this copy.
 *
 * The original fields are preserved and the tags added under distinct keys, so
 * a source that already reports its own `source` is not overwritten.
 */
function tagRecords(status: SourceConclusion): TaggedRecord[] {
  const records = Array.isArray(status.records) ? status.records : [];
  if (records.length === 0) return [];
  const via = SOURCE_OVERLAPS[status.source] ?? [];
  const label = sourceLabelOf(status.source);
  return records.map((record) => {
    const bag = record && typeof record === "object" ? (record as Record<string, unknown>) : {};
    const inner = firstHandKey(bag, status.source);
    const firstHand = inner && via.includes(inner) ? inner : undefined;
    const tagged: Record<string, unknown> = {
      ...bag,
      source: status.source,
      sourceLabel: firstHand ? `${sourceLabelOf(firstHand)} via ${label}` : label,
      ...(firstHand ? { sourceViaAggregator: status.source, sourceFirstHand: firstHand } : {}),
    };
    // Resolve the source-specific field names the panel reads. The panel looks
    // for `title` / `status` / `sourceUrl` / `fetchedAt`; the registries publish
    // `scientific_title` / `public_title`, `recruitment_status`, `web_address` /
    // `detail_url` and `updated_at`. Normalising here keeps the panel's own
    // short candidate list honest instead of asking it to learn five schemas.
    //
    // The title and status were the last two names missing, and on the real
    // ICTRP snapshot they were missing on **every** row: `title`, `brief_title`
    // and `name` are all absent (0 of 6262) while `scientific_title` is present
    // on 6221 and `public_title` on 6260; `status`, `overall_status` and
    // `sourceStatusRaw` are absent on all 6262 while `recruitment_status` is
    // present on 6233. Measured through the fan-out: **0 of 50** records had a
    // title or a status, so the panel rendered 50 blank cards with no way to
    // tell them apart. Nested fields are tried in order and only used when the
    // plain name is empty, so a source that already reports `title` wins.
    const title = firstString(bag, RECORD_TITLE_CANDIDATES);
    if (title && !tagged.title) tagged.title = title;
    const sourceStatus = firstString(bag, RECORD_STATUS_CANDIDATES);
    if (sourceStatus && !tagged.sourceStatusRaw) tagged.sourceStatusRaw = sourceStatus;
    const url = firstString(bag, RECORD_URL_CANDIDATES);
    if (url && !tagged.sourceUrl) tagged.sourceUrl = url;
    const date = firstString(bag, RECORD_DATE_CANDIDATES);
    if (date && !tagged.fetchedAt) tagged.fetchedAt = date;
    // The panel renders each card with `it.id` as its registration-number tag
    // (trials.html:215) and `it.title || it.id` as the heading (trials.html:212).
    // The host computed the registry id only to group rows for merging and never
    // wrote it back, so the tag was always empty and an untitled row had no
    // heading at all. Emitting what we already resolved costs nothing.
    const registryId = registryIdOf(bag);
    if (registryId && !tagged.id) tagged.id = registryId;
    // Same shape as the title and status lists: the panel reads `locations`,
    // and the real payloads have none — the ICTRP snapshot carries `countries`
    // (5845 of 6262 rows, a string array) and the ChiCTR archive carries
    // `institution` (468 of 468). Measured: 0 of 40 records had a location.
    const locations = firstList(bag, RECORD_LOCATION_CANDIDATES);
    if (locations.length && !tagged.locations) tagged.locations = locations;
    return { record: tagged, registryId };
  });
}

/** First non-empty string among `fields`, in the order given. */
function firstString(bag: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = bag[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * Collect location strings from the first present field among `fields`.
 *
 * Accepts both shapes the real payloads use: `countries` is an array of
 * country names and `institution` is a single string. An object-shaped entry is
 * flattened to its `name`/`site`/`country` when one exists, so a source that
 * publishes `[{country: "..."}]` is not silently dropped. Returns `[]` rather
 * than a placeholder when nothing is present — an unknown location is not
 * "unknown-location".
 */
function firstList(bag: Record<string, unknown>, fields: readonly string[]): string[] {
  for (const field of fields) {
    const value = bag[field];
    if (Array.isArray(value)) {
      const out = value.map((entry) => locationText(entry)).filter(Boolean);
      if (out.length) return out;
      continue;
    }
    const single = locationText(value);
    if (single) return [single];
  }
  return [];
}

/** Flatten one location entry (string or object) to a display string. */
function locationText(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  if (!entry || typeof entry !== "object") return "";
  const bag = entry as Record<string, unknown>;
  for (const key of ["country", "city", "site", "name", "province"]) {
    const value = bag[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * The registration number a raw row claims, normalised for comparison.
 *
 * `trial_id` is in the candidate list because that is the WHO ICTRP primary
 * key — verified against the real payload, where a row looks like
 * `{trial_id: "ACTRN12605000026628", source_register: "ANZCTR", …}`. Without it
 * every ICTRP row would be "unkeyed" and never merge, silently restoring the
 * double-count this function exists to remove.
 */
function registryIdOf(bag: Record<string, unknown>): string {
  for (const field of REGISTRY_ID_CANDIDATES) {
    const value = normalizeRegistryId(bag[field]);
    if (value) return value;
  }
  return "";
}

/** The registered spellings that name the registry a row originally came from. */
const REGISTRY_FIELD_CANDIDATES = Object.freeze([
  "source_register", // WHO ICTRP
  "sourceRegister",
  "registry",
  "source_registry",
]);

/**
 * Which first-hand registry does this row say it came from, in our key space?
 *
 * Returns undefined when the row does not name one, or names one we do not
 * model. Not modelled is the common case and must stay quiet: the real ICTRP
 * snapshot spreads its 6262 rows over JPRN, EU CTIS, ANZCTR and a dozen other
 * registries, of which we carry three. Inventing a "JPRN via WHO ICTRP"
 * relationship would imply a first-hand channel this app does not have, so an
 * unknown registry simply keeps the aggregator's own label.
 */
function firstHandKey(bag: Record<string, unknown>, channel: string): string | undefined {
  for (const field of REGISTRY_FIELD_CANDIDATES) {
    const value = bag[field];
    if (typeof value !== "string" || !value) continue;
    const key = normalizeRegistryName(value);
    if (key && TRIAL_SOURCES.some((source) => source.key === key)) return key;
  }
  return undefined;
}

/**
 * Fold a registry's display name to our source key.
 *
 * The aggregate reports "ChiCTR" and "ClinicalTrials.gov"; our keys are
 * `chictr` and `clinicaltrials_gov`. Comparing the raw strings would silently
 * never match on four of the five sources, which is the failure mode this
 * whole function exists to remove — so compare structurally: letters and digits
 * only, lowercased, with the dot that separates "clinicaltrials.gov" from
 * "gov" dropped.
 */
function normalizeRegistryName(value: string): string {
  const folded = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = {
    chictr: "chictr",
    chinesetrialsregistry: "chictr",
    clinicaltrialsgov: "clinicaltrials_gov",
    clinicaltrials: "clinicaltrials_gov",
    nct: "clinicaltrials_gov",
    chinadrugtrials: "chinadrugtrials",
    chinadrugclinicaltrialsregistry: "chinadrugtrials",
    veevactv: "veeva_ctv",
    veevactvclinicaltrials: "veeva_ctv",
  };
  return aliases[folded] ?? folded;
}

function sourceLabelOf(key: string): string {
  return TRIAL_SOURCES.find((source) => source.key === key)?.label ?? key;
}

/** A tagged record paired with the normalised registration number it claimed. */
type TaggedRecord = { record: Record<string, unknown>; registryId: string };

/**
 * Merge records that arrived through more than one channel.
 *
 * SPEC §15.5 merge rules 1–2 and §5.3's `overlapWith`. Without this the fan-out
 * returned the *same trial twice* — once from ChiCTR and once from ICTRP —
 * counted both, and reported `totalRecords: 2`. That is worse than a cosmetic
 * duplicate: §5.3 rule 4 requires the three numbers to stay visible and never be
 * collapsed, and a double-counted total is exactly the collapse the rule
 * forbids, in the direction that inflates. §15.10 claimed this was built; it was
 * not, which is why the gap is recorded as §15.24 rather than quietly fixed.
 *
 * Rules, in the order the SPEC states them:
 *   1. Same registration number, different channels → one record, the one from
 *      the higher-authority source (first-hand beats aggregator).
 *   2. Aggregator rows are NOT dropped for being "extra": a row the aggregator
 *      carried alone stays, because it may be precisely the trial the other
 *      channels are missing (§15.5 rule 3).
 *   3. Records with no registration number never merge. They are returned
 *      as-is; a title match is a hint, not identity, so it produces no merge.
 */
function mergeRecords(tagged: TaggedRecord[]): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  const unkeyed: Record<string, unknown>[] = [];

  for (const { record, registryId } of tagged) {
    if (!registryId) {
      unkeyed.push(record);
      continue;
    }
    const bucket = groups.get(registryId);
    if (bucket) bucket.push(record);
    else groups.set(registryId, [record]);
  }

  const merged: Record<string, unknown>[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    merged.push(mergeGroup(group));
  }
  return [...merged, ...unkeyed];
}

/**
 * Collapse one same-registration-number group into a single record.
 *
 * The winner is chosen by `SOURCE_AUTHORITY`, not by arrival order — arrival
 * order is the scheduler's concurrency, which is not a statement about data
 * freshness. Everything the losers contributed is preserved under `perSource`
 * and named in `mergedFrom` / `overlapWith`, so the merge is auditable rather
 * than lossy: a user asking "why does this say ChiCTR when ICTRP also had it"
 * can see both.
 */
function mergeGroup(group: Record<string, unknown>[]): Record<string, unknown> {
  const ranked = [...group].sort((a, b) =>
    compareSourceAuthority(String(a.source ?? ""), String(b.source ?? "")),
  );
  const primary = ranked[0];
  const others = ranked.slice(1);
  const sources = ranked.map((record) => String(record.source ?? "")).filter(Boolean);

  const perSource: Record<string, unknown>[] = [];
  for (const record of ranked) {
    const extra = { ...record };
    delete extra.perSource;
    perSource.push(extra);
  }

  return {
    ...primary,
    merged: true,
    mergedFrom: sources,
    // §5.3's field: which other sources had this same trial. Only non-empty
    // when a merge actually happened, so its presence is itself the signal
    // that a count has been de-duplicated.
    overlapWith: sources.filter((source) => source !== primary.source),
    sourceLabels: ranked.map((record) => ({
      source: record.source,
      label: record.sourceLabel,
    })),
    perSource,
  };
}

function noResultsSentence(source: TrialSource): string {
  switch (source.kind) {
    case "local_index":
      // A local index that misses may simply be missing coverage. Saying
      // "no such study" would overstate what a local corpus can know.
      return "本地索引中未找到匹配记录；这不等同于“没有相关研究”。";
    case "archived_scrape":
      return "随包归档中未找到匹配记录；归档只覆盖已抓取的病种与时间范围。";
    case "aggregator_registry":
      // ICTRP indexes English-language metadata only: a Chinese keyword matches
      // nothing there *by construction*, and the service reports that inevitable
      // miss as `NO_RESULTS` with `retryable: false` and the hint "This is a
      // genuine zero". Rendered as "查询成功，没有匹配记录" that reads as a
      // finding about the world when it is an artifact of the keyword's
      // language — a patient asking in Chinese would be told no such trials
      // exist. The vendored service tree is byte-identical to upstream (gated by
      // scripts/xyb-check-ictrp-vendor.mjs), so the correction belongs here, in
      // the layer that owns what the user is actually told.
      return `${source.label} 本次查询返回 0 条。注意：该来源只索引英文元数据，中文关键词必然 0 命中，这不能作为“没有相关试验”的依据；请改用英文关键词（如 pancreatic cancer）重查。`;
    default:
      return `${source.label} 查询成功，没有匹配记录。`;
  }
}

function successSentence(source: TrialSource, count: number): string {
  const suffix = isUpstreamIncomplete(source.key) ? "（聚合库，条数为下界）" : "";
  return `${source.label} 返回 ${count} 条记录${suffix}。`;
}

/**
 * Layer 2 — which sources were asked. A model paraphrasing this sentence is how
 * "4 of 5 sources" becomes "五渠道汇总", so it is generated once, here.
 */
export function coverageSentence(statuses: SourceConclusion[]): string {
  const list = statuses;
  const total = list.length;
  if (total === 0) return "本次没有可汇总的来源。";

  const queried = list.filter((status) => isQueried(status.state));
  const missing = list.filter((status) => !isQueried(status.state));
  const queriedNames = queried.map((status) => status.displayName);

  if (!missing.length) {
    return `本次已覆盖全部 ${total} 处来源（${queriedNames.join("、")}）。`;
  }

  const missingParts = missing.map(
    (status) => `${status.displayName}（${status.explanation}）`,
  );
  return (
    `本次只覆盖 ${queried.length}/${total} 处来源：` +
    (queriedNames.length ? queriedNames.join("、") : "无") +
    `。未覆盖：${missingParts.join("；")}。` +
    `未覆盖不等于没有结果。`
  );
}

/**
 * Layer 3 — what the numbers *mean*.
 *
 * "Covered every source" is not "got every trial": an upstream aggregator's
 * result set is systematically smaller than the count it reports. If those two
 * facts are not stated separately, `SUCCESS` plus full coverage reads as "this
 * is every matching trial", which is exactly what WHO ICTRP's CSVs cannot
 * support (§15.2).
 */
export function completenessSentence(statuses: SourceConclusion[], incompleteSources: string[]): string {
  const sources = incompleteSources;
  if (!sources.length) {
    // No known lower-bound source: say only that, never that the data is whole.
    return "本次未发现已知返回集不完整的来源。这不等于结果是全部符合条件的试验。";
  }
  const numbers = sources
    .map((source) => {
      const status = statuses.find((candidate) => candidate.source === source);
      if (!status) return "";
      const got = status.matchedRowsReturned ?? status.resultCount;
      const reported = status.upstreamReportedTotal;
      if (reported === undefined) {
        return `${status.displayName}：实得 ${got} 条`;
      }
      return `${status.displayName}：实得 ${got} 条、上游自报 ${reported} 条`;
    })
    .filter(Boolean);
  return (
    `以下来源的返回集是**下界**（上游导出静默不完整）：${numbers.join("；")}。` +
    `不要把实得条数当作符合条件的试验总数。`
  );
}

/**
 * Aggregate five conclusions into the result contract (SPEC §5.3).
 *
 * `complete` is true only when every source was actually asked. A source that
 * needed setup, timed out, or was never dispatched keeps `complete` false — the
 * product may not call such a result a complete five-source search.
 */
export function aggregate({
  query,
  conclusions,
  startedAt,
  elapsedMs,
  cancelled = false,
  manualOverlaps = [],
}: {
  query: unknown;
  conclusions: SourceConclusion[];
  startedAt?: string;
  elapsedMs: number;
  cancelled?: boolean;
  manualOverlaps?: import("./trial-sources.ts").ManualOverlap[];
}) {
  // Every registered source lands in the table in registry order, whether or
  // not the caller produced a conclusion for it. A missing conclusion is
  // terminalised as "never asked", never as an empty result set.
  //
  // The reason is deliberately NOT `overallDeadline`: the fan-out always emits a
  // conclusion for every source (see `fanout`), so a caller that omits one has
  // told us nothing about why. Asserting 「整体检索时间已到」 for a source nobody
  // tried to dispatch states a cause that was never established — the same rule
  // as §15.15's refusal to substitute `Date.now()` for a date never reported.
  // Absence of an answer is not evidence of a deadline.
  const statuses = TRIAL_SOURCES.map((source) => {
    const provided = conclusions.find((conclusion) => conclusion.source === source.key);
    return provided ?? terminalise(source, { notAttempted: true });
  });

  const queried = statuses.filter((status) => isQueried(status.state));
  const missing = statuses.filter((status) => !isQueried(status.state));
  const records = mergeRecords(statuses.flatMap((status) => tagRecords(status)));
  const incompleteSources = statuses
    .filter((status) => status.upstreamIncomplete && isQueried(status.state))
    .map((status) => status.source);

  return {
    schemaVersion: 1,
    host: "pi-desktop",
    query,
    statuses,
    coverage: {
      total: statuses.length,
      queried: queried.length,
      missing: missing.length,
      complete: missing.length === 0,
      queriedSources: queried.map((status) => status.source),
      missingSources: missing.map((status) => status.source),
      sentence: coverageSentence(statuses),
    },
    completeness: {
      coverageComplete: missing.length === 0,
      upstreamIncompleteSources: incompleteSources,
      countsAreLowerBounds: incompleteSources.length > 0,
      sentence: completenessSentence(statuses, incompleteSources),
    },
    sourcesQueried: queried.length,
    sourcesUnavailable: missing.length,
    totalRecords: records.length,
    records,
    startedAt,
    elapsedMs,
    cancelled: Boolean(cancelled),
    // Manual servers that shadow a built-in source. They never enter the
    // fan-out, but the caller must surface them: two un-de-duplicated channels
    // to the same registry turn a lower-bound count into an upper bound.
    overlaps: manualOverlaps,
    // The sentence, not just the array. `coverage` and `completeness` each ship
    // one and the skill tells the model to reproduce those verbatim; without a
    // sentence here the same instruction had nothing to quote, so on the
    // assistant path this warning either vanished or got improvised per reply.
    // The panel built its own copy in `renderOverlap`, so the wording users
    // actually saw was the one the host could not vouch for — and §15.24's whole
    // point is that duplicate counting silently turns a stated lower bound into
    // an upper bound. Built here for the same reason the other two are: chat and
    // panel must render one sentence, not two.
    overlapsSentence: overlapSentence(manualOverlaps),
    disclaimer: DISCLAIMER,
  };
}

/**
 * Say, in one sentence, that two channels point at the same registry.
 *
 * Empty string when there is nothing to warn about, so callers can treat the
 * empty string as "say nothing" instead of having to test the array as well.
 */
export function overlapSentence(overlaps: ManualOverlap[] | undefined): string {
  if (!overlaps || !overlaps.length) return "";
  const parts = overlaps.map((item) => {
    const builtin = item.builtin ? `内置的「${item.builtin}」` : "一个内置来源";
    const manual = item.manual || item.serverId || "你手工配置的 MCP 服务";
    return `${manual} 与 ${builtin} 指向同一数据源`;
  });
  return (
    `注意：${parts.join("；")}。两条通道的结果没有去重，` +
    `把它们相加会得到偏高的数字——本工具报出的条数在这种情况下不再是下界。`
  );
}
