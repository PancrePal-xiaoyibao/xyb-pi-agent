# ADR 0311: Deterministic channel orchestration for the unified trial query

- Status: Proposed
- Date: 2026-10-04

## Context

The unified trial query (`XYB-TRIAL-UNIFIED-QUERY.md`, v1.11) spans four channels:
ClinicalTrials.gov, ChiCTR, Veeva CTV, and the China drug trial registry. Per
[ADR-F2-01](#relationship-to-adr-f2-01), the coordination layer is **assistant
orchestration**: the model reads the `unified-trial-query` skill, calls each
channel's tool, then hands the raw per-source results to the deterministic pure
merge function in `xyb.trials/lib/unified.js` via `xyb_trials_unify`.

This was a deliberate choice — plugins cannot invoke another plugin's MCP tools
(namespacing is per-source-plugin, and the SDK exposes no cross-plugin call API),
so a fully in-plugin coordinator was not available without an architectural
change.

**The observed failure mode (2026-10-03, reproduced).** A user asked, in
plain language, how many trials each channel had for IBI343. The assistant
**never called any channel tool**. It used a generic page-fetch tool three
times against JS-rendered search pages
(`clinicaltrials.gov/search?term=IBI343`,
`chinadrugtrials.org.cn/search.html?keyword=IBI343`,
`chictr.org.cn/search?keyword=IBI343`) and all three failed. The user then
reported the root cause themselves:

> 手没加载技能 → 不知道有四个渠道 → 只能拿通用工具去抓网页。
> 用优先级保证先用工具，无效后用浏览器托底可以考虑吗

The skill was not loaded because its `description` triggered on **intent
phrasing** ("找临床试验", "统一查询") while the user asked a **statistical
phrasing** question ("按渠道汇总 IBI343 的数量"). Nothing was broken in code;
the orchestration simply never started.

**Why the current mitigation is insufficient.** Two mitigations shipped
(XYB-TRIAL-UNIFIED-QUERY.md v1.11):

1. Widened skill `description` to cover statistical phrasings.
2. Priority rules pushed into the **tool descriptions** of
   `xyb_trials_search` / `xyb_trials_unify` — these are resident in the tool
   list and do not depend on skill matching.

Both are **probabilistic**. Skill activation is a model judgment over a
free-text catalog; tool selection is likewise a model choice. Neither provides
any guarantee. There is a hard ceiling here: **user phrasings cannot be
enumerated**. Every widened trigger list is a patch for the phrasings someone
already thought of, and the next unseen phrasing fails the same way. A
failure mode that depends on the model *remembering* to choose correctly is not
fixed by better prose — it is only made less frequent.

The specific harm is compounding: when orchestration silently does not start,
the user receives an **incomplete answer with no indication that it is
incomplete**. Channels that were never queried are indistinguishable from
channels that were queried and returned nothing — precisely the
"不可用 ≠ 0 条" failure the SPEC already forbids at the data layer, but which
remains reachable at the orchestration layer.

## Decision

Adopt a **three-layer defense**, ordered by determinism, and be explicit that
only the first layer is actually guaranteed:

### Layer 1 — Panel-initiated orchestration (deterministic, implement first)

The `xyb.trials` panel gets explicit entry points that run the full
four-channel sweep over a **code path**, not a model path. The panel calls
`bridge.invoke("xyb.trials.unify", {...})` and the plugin panel script drives
the per-channel calls.

Consequence: pressing the button **always** queries all enabled channels. No
skill loading, no trigger matching, no model discretion. This is the only layer
that converts the failure mode into an impossibility rather than a rarity.

Scope limit: a panel button is a *user-initiated* guarantee, not an ambient
one. It does not help a user who asks in chat and never opens the panel.

### Layer 2 — Orchestration status is always explicit (deterministic, implement with Layer 1)

Whatever path produced the answer — panel or assistant — the result **must**
carry a machine-checkable per-channel status block, and any channel that was
*not queried* must be reported as `NOT_ENABLED` with an explicit
"本次查询未包含该来源" explanation.

This already exists in `lib/unified.js`. The gap is that the **assistant can
bypass it entirely** by answering without calling `xyb_trials_unify`. Therefore
this layer additionally requires: when the assistant answers a
clinical-trial-count question, it must route through the merge function so the
status block is present. Enforcement is via Layer 3.

The invariant: **an incomplete answer must be visibly incomplete.** Silence
must never be readable as "zero results".

### Layer 3 — Host-level interception (deferred, requires separate decision)

Deferred options, in increasing intrusiveness:

- **(3a) Deny list-page fetching.** The host refuses page-fetch calls whose URL
  matches a channel's search-list pattern (`/search?...`, `?keyword=...` on the
  four channel domains), returning an actionable message naming the channel
  tool that should be used instead. This is a **guardrail, not an
  orchestrator** — it stops the wrong action, it does not start the right one.
- **(3b) Forced skill injection.** When the host detects a trial-related intent
  it injects the unified-query skill body directly, bypassing model discretion.
  Requires locating the `# Skills` prompt-assembly point, which was **not found**
  during this investigation (`grep` for `# Skills` / `skillsSection` /
  `skillCatalog` over `apps/desktop/electron/main/*.ts` returned nothing;
  assembly likely lives in `packages/` or `crates/host-core`).
- **(3c) Host-level composite tool.** A host-owned tool that fans out to all
  four channel MCP servers and returns merged output. This removes model
  orchestration from the path entirely and is the only option that fixes the
  *chat* case as well as the panel case. It is also the largest change: it
  moves orchestration ownership from plugin to host and must answer how
  per-plugin permission and network-domain grants are honored for a tool that
  acts across four plugins.

**This ADR does not decide Layer 3.** Layers 3a–3c each require their own
decision because each touches host architecture, permission semantics, or both.
Recording them here as the considered option space.

### Non-decision: do not keep widening trigger phrases

Rejected as the primary strategy. Trigger widening remains useful as a cheap
supporting measure, but treating it as *the* fix means accepting an
unbounded patch treadmill for a failure mode that is deterministic in nature.

## Consequences

**Positive**

- Layer 1 makes the four-channel sweep reliable for panel users with no
  dependency on model behavior.
- Layer 2 guarantees that partial results are never presented as complete —
  this holds regardless of which layer produced the data.
- Naming Layer 3 now prevents the option space from being rediscovered later,
  and prevents Layer 1 from being mistaken for a complete fix.

**Negative / accepted costs**

- Layer 1 adds surface to the panel and duplicates some orchestration logic
  that the skill also describes (two descriptions of one sequence — they can
  drift; the shared contract lives in `lib/unified.js`, which both must use).
- **The chat path remains probabilistic until Layer 3.** This ADR knowingly
  leaves the original user complaint only partially fixed. This must not be
  reported as resolved.
- Layer 2 depends on assistant compliance, which is not enforceable without
  Layer 3. It is a correctness *contract*, not a mechanism.

**Risks**

- If the panel sweep runs all four channels synchronously it may be slow
  (ChiCTR measured 9.9s, CDE live scrape ~8s) and may trip rate limits when
  repeated. Needs progress reporting and per-channel timeout handling before
  shipping.
- The chinadrugtrials channel has an **archive side effect** on search
  (already a known limitation, XYB-TRIAL-UNIFIED-QUERY.md): a panel button that
  silently triggers a scrape is a different user expectation than a search
  button. Must be surfaced, not hidden.

## Alternatives

**A. Widen trigger phrases only** (status quo of v1.11). Rejected as primary:
probabilistic, unbounded, and fails on unenumerated phrasings. Kept as
support.

**B. Panel-initiated orchestration + explicit status contract** (Layers 1+2,
**chosen**). Low cost, no host change, fully deterministic for panel users.
Cannot fix the chat path.

**C. Host-level composite tool** (Layer 3c). The only complete fix — makes the
chat path deterministic too. Rejected *for now* because it is an architecture
and permission-semantics change beyond the authorized scope
(M1+M2+M4+M5+M6). Should be revisited on its own merits.

**D. Make the plugin call the four MCP servers itself.** Re-examined and
**rejected** on the M2.0 capability audit: MCP tools are namespaced to the
source plugin and the SDK exposes no cross-plugin invocation API. Absorbing
`mcp.server.local` into `xyb.trials` would also break the permission isolation
that ADR-F2-01 established.

**E. `pi.bus` request/response.** Rejected: `pi.bus` is fire-and-forget with no
caller identity, no reply channel, and no timeout — unusable for aggregation.

## Relationship to ADR-F2-01

ADR-F2-01 chose "assistant skill orchestration + deterministic pure-function
merge" as the coordination layer. This ADR is **not a reversal**: it keeps that
merge layer (`lib/unified.js`) as the single source of truth and adds explicit
entry points and an explicit status contract around it.

It is, however, a **documented narrowing of ADR-F2-01's confidence**: that ADR
treated assistant orchestration as sufficient. Observation since then shows it
is sufficient *when it runs* and silently absent when it does not. ADR-F2-01's
decision stands for the merge layer; its orchestration assumption is amended by
Layers 1–3 above.

## Evidence

- 2026-10-03 user screenshot: three generic page fetches against channel search
  pages, all failed; no channel tool called.
- `apps/desktop/resources/plugins/xyb.trials/skills/unified-trial-query.md` —
  skill description widened; priority section added.
- `apps/desktop/resources/plugins/xyb.trials/main.js` — priority rules in
  `xyb_trials_search` / `xyb_trials_unify` tool descriptions.
- Post-restart log: assistant switched to channel tools
  (`plugin_xyb_trial_sources_veeva_ctv_search_studies ok:true`, ChiCTR
  `search_trials` invoked) — i.e. mitigation works *when the skill loads*.
  This is the probabilistic layer, and it succeeded on this phrasing.
- `apps/desktop/resources/plugins/xyb.trials/lib/unified.js` — the
  deterministic status/merge contract that Layers 1 and 2 both consume.
