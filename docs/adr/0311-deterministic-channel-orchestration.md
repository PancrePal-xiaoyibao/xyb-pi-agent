# ADR 0311: Reliable routing and orchestration for unified trial queries

- Status: Accepted (architectural direction; implementation SPEC approval required)
- Date: 2026-10-04
- Scope note: this ADR was written when the unified query covered four sources.
  WHO ICTRP was confirmed as the fifth source on 2026-10-04; the orchestration
  direction here is source-count-agnostic and carries over unchanged, with the
  fifth source's contract, deadlines, and acceptance criteria defined in the
  host-orchestration SPEC §15. References to "four" below are historical.

## Context

The unified clinical-trial query covers four independently implemented sources:
ClinicalTrials.gov, ChiCTR, Veeva CTV, and the China drug trial registry. The
existing design (ADR-F2-01 and `XYB-TRIAL-UNIFIED-QUERY.md` v1.11) assigns
coordination to the assistant: it is expected to load a skill, call each
source's tool, then pass per-source results to `xyb_trials_unify`, whose
`lib/unified.js` merge logic is deterministic.

This design has two separate reliability questions that must not be conflated:

1. **Intent routing:** does an arbitrary natural-language user message enter
   trial-query handling at all?
2. **Execution and reporting:** once trial-query handling starts, are all
   eligible sources attempted, and are every source's result and failure
   represented faithfully?

### Observed failures

**2026-10-03: routing missed.** A user asked how many trials each channel had
for IBI343. The assistant did not call any channel tool; it tried generic page
fetches against JS-rendered search/list pages for ClinicalTrials.gov, ChiCTR,
and the China drug trial registry. All failed. The user summarized the failure:

> 手没加载技能 → 不知道有四个渠道 → 只能拿通用工具去抓网页。
> 用优先级保证先用工具，无效后用浏览器托底可以考虑吗

The skill description matched intent phrasing such as “找临床试验” and
“统一查询”; the user phrased a statistical question (“按渠道汇总 IBI343 的
数量”). Expanding skill applicability text and adding priority guidance to
always-listed tool descriptions improved this case, but neither mechanism
forces model routing or tool selection.

**2026-10-04: routing worked, fan-out did not.** In a live app run, the assistant
loaded `unified-trial-query`, called the ClinicalTrials.gov search tool, then
ChiCTR `search_trials`, and ended the turn. Veeva CTV and the China drug trial
registry were not queried; `xyb_trials_unify` was not called. The user could
therefore receive a plausible partial answer without an explicit indication
that two sources were omitted. This demonstrates that skill activation and
successful tool selection do not guarantee complete execution.

### Verified plugin/host boundary

The four channel MCP tools belong to `xyb.trial-sources`; the query and panel
belong to `xyb.trials`. The plugin SDK exposes tools for a plugin to register,
plus model, network, bus, and service APIs, but no API for one plugin to invoke
another plugin's MCP tools. A panel `bridge.invoke` is forwarded to that
plugin's own `onPanelInvoke` (`apps/desktop/electron/main/plugin-runtime.ts:2225`);
it does not cross this boundary. `pi.bus` is publish/subscribe, not a
request/response RPC with caller identity, response correlation, or timeout.

Consequently, neither an `xyb.trials` panel button nor an in-plugin
`xyb_trials_unify` function can itself dispatch all four existing channel MCP
tools. A host capability is required for deterministic cross-plugin fan-out
without collapsing source ownership or bypassing source permissions.

## Decision

Treat intent routing, source execution, and result presentation as separate
responsibilities. The target architecture is a **host-owned unified trial-query
orchestrator, exposed to both chat and the trial panel**, with conservative
natural-language routing and an explicit fallback when intent is uncertain.
This ADR has been accepted as the bounded architectural direction, not as
implementation authorization. The implementation SPEC must resolve the
permission-mediated child invocation contract, consent UX, source eligibility,
lifecycle, and side-effect gates before coding. No implementation may begin
until that SPEC is explicitly approved.

### 1. Intent routing: high-confidence automatic route, clarify on uncertainty

Do not promise that any finite trigger list or classifier will recognize every
possible phrasing. Skill applicability and tool descriptions remain useful
supporting guidance, not correctness mechanisms.

For chat:

- Route high-confidence clinical-trial search/count intent to the unified
  query entry point.
- If intent is ambiguous, ask a short clarification rather than silently
  scraping registry search pages or presenting a partial answer as complete.
- Offer an explicit “找临床试验” action/entry point that bypasses natural-
  language intent classification.

Measure routing on a representative, versioned corpus of real and paraphrased
queries, including count/statistical wording, Chinese colloquialisms, mixed
Chinese/English drug names, follow-up turns, negatives, and unrelated medical
questions. Track recall and false-trigger rate separately; set acceptance
thresholds during implementation design. Do not describe the classifier as
100% reliable.

### 2. Execution: one host-owned composite orchestration entry point

Once a request is classified as a trial query—or the user enters through the
explicit action—the host invokes one composite operation. It dispatches to the
four existing source capabilities while preserving each source plugin's
configuration, permission, network-domain, and setup boundaries. It must not
reimplement a source scraper inside `xyb.trials`, merge the source plugins, or
silently grant cross-plugin permissions.

The same host-owned operation must serve chat and the panel; the panel must not
attempt cross-plugin MCP calls through `xyb.trials`' bridge. The existing
`xyb.trials` pure merge/normalization function can remain the merge component
if its contract fits the host interface; its presence does not itself perform
fan-out.

**Invocation boundary (security requirement).** Source MCP calls are
represented by registered `RegisteredPluginTool` entries in
`PluginRuntime.getTools()` and their `execute` closures preserve source-plugin
liveness, settings, MCP call cancellation, and source attribution. However,
calling a closure directly from a composite would bypass host-core's ordinary
`tools.execute` permission decision, approval prompt, mode handling, admission,
turn-dispatchability check, and child-tool audit. Calling `McpServerClient`
directly would bypass still more policy/lifecycle checks. Therefore the
composite MUST NOT invoke registered closures or raw MCP clients as a shortcut.
Each child dispatch must pass through the normal host-core `tools.execute`
policy path with a unique child tool-call identity and the original session /
turn identity. If current architecture cannot re-enter that path for nested
calls, add a narrowly scoped host-core child-dispatch RPC that applies
semantically equivalent per-child risk/permission/approval, cancellation,
turn-validity, admission, and audit. A composite-level approval alone is not
proof of per-source authorization; registered/enabled source plugins alone are
not proof of per-call user consent.

The orchestration contract is **attempt every eligible source**, not “always
obtain four usable results.” A source is eligible only when its plugin is
enabled in the active project, its exact MCP tool is registered and live, its
MCP server permission/configuration checks passed, its source prerequisites are
satisfied, and the current per-tool permission decision allows invocation.
Missing/unregistered tools, disabled plugins, missing setup, explicit consent
denial, deadline expiry before dispatch, and lifecycle changes have distinct
reasons and must not be collapsed into `NOT_ENABLED`. Each source must receive
an explicit terminal status even if another source fails. One timeout, rate
limit, challenge, or source error must not discard successful results from
other sources.

Bounded parallel execution may reduce wall-clock latency, but is not assumed
safe until per-source concurrency, rate limits, cancellation, and resource
lifecycle have been verified. ChiCTR has been observed taking about 9.9–12.7
seconds; the China registry scrape about 8 seconds. The host design must define
per-source deadlines, an overall deadline, progress/cancellation behavior, and
how late results are handled.

### 3. Result contract: distinguish execution state from result count

The composite operation returns structured, machine-readable per-source
statuses, records, error categories, and coverage metadata. At minimum, the
status model must distinguish:

- `SUCCESS`: source queried and returned one or more records.
- `NO_RESULTS`: source queried successfully and returned zero matching records.
- `NOT_ENABLED`: user/source configuration explicitly disables it.
- `NEEDS_SETUP`: required setup, dependency, local index, or session is missing.
- `NOT_QUERIED`: orchestration did not dispatch the source (for example,
  ineligible, explicitly skipped, or not started); include a reason.
- `TIMEOUT`, `FAILED`, `CHALLENGE_REQUIRED`, and other actionable terminal
  failures as appropriate.

`NOT_QUERIED` must never be rendered as `NO_RESULTS`; `NOT_ENABLED` must not be
used as a catch-all for “we do not know whether this ran.” The current
`lib/unified.js` convention that maps an absent source result to `NOT_ENABLED`
needs evolution before it can represent all orchestration outcomes honestly.

The host UI renders the status and coverage block from this structure; it must
not rely solely on the assistant to copy a sentence from tool output. The
assistant may explain results, but cannot override source status or claim a
complete four-source search if any source was not queried or did not complete.
“Not covered” is not “no results.” Partial success is valid and useful only
when its incompleteness is visible.

### 4. Source-specific side effects and permissions

> **Superseded in part (2026-10-04, by the SPEC, pending approval).** The paragraph
> below excludes the China drug trial registry's archive-producing search from
> unattended fan-out behind a consent gate. The user vetoed that consent gate:
> writing a local archive is not a destructive operation, and prompting on every
> query recreates exactly the "user is forced to hand-type tool names" failure
> mode this ADR exists to eliminate. The approved direction is now **CDE is
> fanned out equally with every other source, reading its local archive**, which
> is side-effect-free; only networked collection (`search_trials`,
> `sync_incremental`) stays out of the query fan-out. See the SPEC §4.3, §3.1
> and §5.2. The original text is retained below for history and must not be
> implemented as written.

The China drug trial registry's current `search_trials` writes raw HTML, JSON,
and Word archives locally as part of scraping. For the initial composite
operation, **exclude this archive-producing search from unattended fan-out**.
Return `NOT_QUERIED` with reason `SIDE_EFFECT_CONSENT_REQUIRED` unless and until a
separately reviewed consent flow or a side-effect-free search capability is
implemented. This decision prevents an ordinary query or model `auto` mode
from silently initiating local archival. `setup_environment`, `update_cookie`,
and `refresh_cookie` are never implicit query steps.

The composite host broker uses only fixed registered source tools; it does not
accept arbitrary plugin/tool names, network URLs, or executable paths from the
model. Registration must continue to enforce source plugin `mcp.server.local`
(or `.remote` for HTTP), HTTP egress grants, plugin-owned settings/config
references, and redirect checks. Per-call host-core risk/permission policy
remains authoritative. Audit records must attribute each child call to both
the composite and the original plugin/server/tool. No credential values or
archived contents enter audit logs.

### 5. Browser fallback is limited

Tool-first guidance remains useful. Generic browser/page-fetch scraping of
JS-rendered registry search/list pages is not a fallback for channel APIs and
must not be presented as equivalent evidence. Browser use may supplement a
specific record/detail page after an identifier is known, with provenance kept
separate from source-query results. A host deny-list may be considered as a
defense-in-depth guardrail, but it does not replace intent routing or composite
orchestration.

## Consequences

**Expected benefits**

- Once the unified operation is invoked, a single host-owned path controls
  fan-out for both chat and panel, rather than asking the model to remember four
  independent calls.
- Partial failure is isolated and visible; the UI can distinguish zero results
  from disabled, unconfigured, unqueried, timed-out, or failed sources.
- Natural-language routing is treated as measurable and fallible. Ambiguity has
  an explicit clarification path, and users retain a deterministic explicit
  entry point.
- Source adapters remain independently owned, preserving permission and
  configuration boundaries.

**Costs and limits**

- This requires host architecture work: composite operation registration,
  permission mediation, bounded fan-out, structured result transport, and UI
  rendering. It is not achievable by editing only the `xyb.trials` plugin.
- Natural-language recognition remains imperfect. The explicit entry point
  and clarification behavior reduce the impact but do not make arbitrary
  phrasing recognition deterministic.
- “All four attempted” is conditional on eligibility and consent; it does not
  mean all four succeeded or returned records.
- Latency and source side effects may make unattended fan-out inappropriate
  until deadlines, progress, consent, and rate-safety are resolved.

## Alternatives considered

**A. Keep widening skill trigger phrases and tool descriptions.** Retain as
supporting guidance only. Rejected as the primary reliability strategy because
phrasing is open-ended, and the live run showed that even a loaded skill did not
ensure all four tools were called.

**B. Plugin-only panel orchestration plus status contract.** Rejected as the
solution to four-source execution: the panel's plugin cannot invoke the other
plugin's MCP tools. A panel-only status display can expose incompleteness but
cannot perform the promised fan-out. The panel should call the same host
composite operation as chat once that operation exists.

**C. Host-owned composite orchestration shared by chat and panel.** Recommended
target direction in this ADR. After the operation is invoked and child
permission decisions allow dispatch, it attempts each eligible source and
centralizes structured status reporting. Every per-source MCP child call must
re-enter host-core's normal `tools.execute` policy path (or a separately
reviewed equivalent host-core child-dispatch contract); direct callback/client
invocation is prohibited. Initial unattended fan-out excludes archive-producing
CDE search. This does not guarantee that arbitrary user phrasing is recognized;
routing, clarification, and explicit entry remain separate requirements.

**D. Let `xyb.trials` call the source MCP servers itself or absorb them.**
Rejected: the SDK has no MCP invocation API, and combining source implementations
would undermine plugin ownership and permission isolation.

**E. Use `pi.bus` as request/response RPC.** Rejected for this purpose: the
verified API is publish/subscribe and provides no request correlation, caller
identity, response channel, or timeout contract. A future host-owned RPC would
be a new capability, not an existing bus feature.

**F. Deny registry search-page fetching at the host.** Possible defense in
depth to prevent a known ineffective action. Rejected as the primary solution:
it stops some wrong calls but neither recognizes the user's intent nor starts
the channel tools.

## Relationship to ADR-F2-01

ADR-F2-01 selected assistant-driven source orchestration with deterministic
pure-function merge because plugins could not call one another's MCP tools.
This ADR preserves the merge logic's role but revises the orchestration
assumption in light of live evidence: assistant orchestration can work, but it
is not a guarantee of complete fan-out. The target is now a host-owned
composite operation that invokes source-owned capabilities under their existing
boundaries and may reuse the pure merge component. This is an architectural
direction requiring review; it does not silently amend implementation scope or
authorize host changes.

## Evidence

- 2026-10-03 user-reported run: generic fetches against ClinicalTrials.gov,
  ChiCTR, and China registry search/list pages; no channel tools were called and
  the fetches failed.
- 2026-10-04 app logs: `Skill` loaded at 22:44:54; CT.gov search completed at
  22:45:00 (~948 ms); ChiCTR `search_trials` completed at 22:45:12 (~12.661 s);
  turn ended without Veeva CTV, China registry, or `xyb_trials_unify` calls.
  This is evidence that skill routing can improve while complete fan-out still
  fails.
- `packages/plugin-sdk/src/index.ts`: `pi` exposes agent registration/completion,
  model listing, network, bus, and services APIs, but no MCP tool invocation API.
- `apps/desktop/electron/main/plugin-runtime.ts:2225`: unhandled panel channels
  are forwarded to the calling plugin's `onPanelInvoke`; this is not a
  cross-plugin MCP dispatcher.
- `apps/desktop/resources/plugins/xyb.trials/lib/unified.js`: deterministic
  normalization/merge/status function; it only processes supplied per-source
  results and does not dispatch queries.
- `XYB-TRIAL-UNIFIED-QUERY.md` v1.11: records source setup/limitations and the
  archive side effect on China registry search; source latency observations are
  approximately 9.9–12.7 s for ChiCTR and approximately 8 s for the China
  registry scrape.
- The existing skill and tool descriptions contain tool-first guidance. Their
  presence is useful but is not host enforcement or evidence of guaranteed
  intent recognition.