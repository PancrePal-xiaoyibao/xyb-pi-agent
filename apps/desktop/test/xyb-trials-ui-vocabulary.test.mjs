/**
 * The trial panel's state vocabulary must cover every state the two backends emit.
 *
 * SPEC: docs/zh-CN/spec/xyb-unified-trial-host-orchestration.md §3.3, §15.13
 *
 * Two layers produce source states: the plugin's own `lib/unified.js` (used by
 * the assistant-facing `xyb_trials_unify` tool) and the host orchestrator's
 * `trial-orchestrator.ts` (used by the real fan-out composite). They are *not*
 * the same list — the orchestrator has `NOT_QUERIED`, the plugin has
 * `INDEX_EMPTY` / `SESSION_EXPIRED`. The panel renders whichever table it is
 * handed, and `stateName()` falls back to the raw token, so a missing entry
 * shows an English constant like "NOT_QUERIED" to a Chinese-reading user.
 *
 * That is the same family as the 2026-10-03 mislabel this spec keeps returning
 * to: `NOT_QUERIED` means "we never asked", and it must never be silently
 * rendered as indistinguishable from a real answer or a real failure.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { SOURCE_STATES } from "../electron/main/trial-orchestrator.ts";

const html = readFileSync(
  new URL("../resources/plugins/xyb.trials/views/trials.html", import.meta.url),
  "utf8",
);
const unifiedSource = readFileSync(
  new URL("../resources/plugins/xyb.trials/lib/unified.js", import.meta.url),
  "utf8",
);

/** Pull the keys of the panel's `STATE_ZH` literal. */
function panelStates() {
  const start = html.indexOf("const STATE_ZH = {");
  assert.ok(start >= 0, "面板必须定义 STATE_ZH");
  const end = html.indexOf("};", start);
  const body = html.slice(start, end);
  return [...body.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);
}

/** Pull the string literals of an array constant in unified.js. */
function unifiedStates() {
  const start = unifiedSource.indexOf("const STATES = Object.freeze([");
  assert.ok(start >= 0, "unified.js 必须定义 STATES");
  const end = unifiedSource.indexOf("]);", start);
  return [...unifiedSource.slice(start, end).matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

test("the panel translates every state the host orchestrator can emit", () => {
  const known = new Set(panelStates());
  const missing = SOURCE_STATES.filter((state) => !known.has(state));
  assert.deepEqual(
    missing,
    [],
    `面板缺少这些状态的中文名，用户会直接看到英文常量：${missing.join(", ")}`,
  );
});

test("the panel translates every state the plugin aggregator can emit", () => {
  const known = new Set(panelStates());
  const missing = unifiedStates().filter((state) => !known.has(state));
  assert.deepEqual(missing, [], `unified.js 的状态未在面板翻译：${missing.join(", ")}`);
});

test("NOT_QUERIED is distinct from FAILED and from an empty result", () => {
  // The whole point of the state: "we never got to ask" is not "the source is
  // broken" and not "there is nothing there".
  const states = panelStates();
  assert.ok(states.includes("NOT_QUERIED"));
  assert.ok(states.includes("FAILED"));
  assert.notEqual(
    html.match(/NOT_QUERIED:\s*"([^"]+)"/)?.[1],
    html.match(/FAILED:\s*"([^"]+)"/)?.[1],
  );
});

test("the two backends agree on the states they share", () => {
  // Overlap is expected and fine; what must not happen is one side inventing a
  // spelling for a state the other already named.
  const unified = new Set(unifiedStates());
  const host = new Set(SOURCE_STATES);
  const shared = [...host].filter((state) => unified.has(state));
  assert.ok(shared.includes("SUCCESS"), "两侧至少共享 SUCCESS，否则本测试没有意义");
  assert.ok(shared.includes("NO_RESULTS"));
});

// ---------------------------------------------------------------------------
// Per-record source attribution
//
// ICTRP terms 4.b(1) require attributing the source of the data as WHO ICTRP.
// That obligation attaches to the *records*, not only to a summary line: in a
// merged list a trial that came via the aggregator must not be visually
// identical to one that came from a first-hand registry.
// ---------------------------------------------------------------------------

test("a rendered record shows which source it came from", () => {
  assert.match(
    html,
    /it\.source[\s\S]{0,120}?sourceName\(/,
    "记录卡片必须用 sourceName() 标出来源，而不是只靠汇总区一行",
  );
  assert.match(html, /"来源："/, "来源标签应当有中文前缀");
});

test("the record card falls back to sourceUrl when url is absent", () => {
  // `unified.js` `normalizeRecord()` emits `sourceUrl`, while older callers emit
  // `url`. Reading only `url` would silently drop the "view original record"
  // link for every normalized record.
  assert.match(html, /const link = it\.sourceUrl \|\| it\.url;/);
});

test("every CSS custom property the panel uses is defined", () => {
  const defined = new Set([...html.matchAll(/^\s*(--[a-z-]+):/gm)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]));
  // `--pi-plugin-titlebar-height` is injected by the host titlebar.
  used.delete("--pi-plugin-titlebar-height");
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `面板用了未定义的 CSS 变量：${missing.join(", ")}`);
});

test("a merged record renders the per-source labels, not just a bare source key", () => {
  // §15.9 criterion 9. The panel must show "ChiCTR via WHO ICTRP" for the
  // aggregator's copy; rendering `sourceName(it.source)` alone would print
  // "WHO ICTRP" and quietly drop the fact that a first-hand copy exists.
  assert.match(
    html,
    /it\.sourceLabels[\s\S]{0,200}?entry\.label/,
    "合并记录必须渲染 sourceLabels 里的 label",
  );
  assert.match(html, /sourceName\(it\.source\)/, "未合并的记录仍需回退到固定译名");
});

test("a NEEDS_SETUP source shows a copyable fix command in the panel", () => {
  // §15.9 criterion 3. Telling a user "缺少 Python 运行时" without the line to
  // run leaves them knowing something is broken and nothing about what to do.
  // The command must be rendered, not folded into the prose sentence: it has to
  // be selectable on its own (the `.fix-command` rule sets `user-select: all`),
  // otherwise "可复制" is a claim the UI does not honour.
  assert.match(html, /st\.fixCommand/, "面板必须读取 fixCommand");
  assert.match(
    html,
    /fix-command[\s\S]{0,120}?st\.fixCommand|st\.fixCommand[\s\S]{0,160}?fix-command/,
    "fixCommand 必须渲染成可复制的命令元素，而不是拼进解释文字里",
  );
  assert.match(
    html,
    /\.fix-command\s*\{[\s\S]{0,400}?user-select:\s*all/,
    "修复命令必须可整条选中，否则「可复制」只是文案",
  );
  // And the plugin must pass it through before the panel can ever see it.
  assert.match(unifiedSource, /fixCommand:\s*text\(raw\.fixCommand\)\s*\|\|\s*undefined/,
    "sourceStatus 必须原样透传 fixCommand；缺失时留空，不得编造");
});

test("the WHO ICTRP terms disclosure is a real entry, not a single link", () => {
  // §15.9 criterion 9 + §15.7. The obligations are OURS, not the user's to go
  // find on who.int: the panel must carry the six obligations itself and quote
  // the clause verbatim, because paraphrasing loses "independent of format and
  // method of acquisition" — the exact phrase that makes the bundled seed as
  // binding as a live query. A lone external link is not a disclosure entry.
  assert.match(html, /createElement\("details"\)/, "条款披露必须是可折叠入口");
  assert.match(html, /class\s*=\s*"terms"|className\s*=\s*"terms"/, "披露入口缺少 .terms 类");
  assert.match(html, /使用条款与义务/, "披露入口的标题必须说明这是使用条款");
  // Verbatim quote, not a paraphrase.
  assert.match(
    html,
    /independent of format and method of acquisition/,
    "必须逐字引用条款原文：转述会丢掉独立于获取格式与方法这一措辞",
  );
  assert.match(
    html,
    /retains any of the data/,
    "必须引用 in effect as long as the user retains any of the data —— 卸载不终止义务",
  );
  // All six obligations must actually be listed, each identified by its clause.
  for (const clause of ["4.b(1)", "4.b(3)", "4.b(2)", "4.c", "4.d", "4.e"]) {
    assert.ok(html.includes(clause), `六条义务缺少条款 ${clause}`);
  }
  // Clause numbers alone are not enough — the 4.e duty is specifically about
  // the WHO name and emblem, and 4.c about claiming proprietary rights.
  assert.match(html, /专有权利/, "条款 4.c（不得主张专有权利）必须写出含义");
  assert.match(html, /名称或徽标/, "条款 4.e（不得使用 WHO 名称或徽标）必须写出含义");
  assert.match(html, /营销、推广或商业用途/, "条款 4.d（禁止商业用途）必须写出含义");
  assert.match(html, /无隶属关系/, "必须声明与 WHO 无隶属关系");
  // Every CSS class the disclosure introduces must have a rule, and every
  // variable those rules use must exist (an undeclared custom property fails
  // silently — the §15.16 lesson).
  for (const cls of ["terms-body", "terms-quote", "terms-list"]) {
    assert.ok(html.includes(`.${cls}`), `披露入口用了 .${cls} 但没有对应的 CSS 规则`);
  }
  assert.match(html, /\.terms\s*>?\s*summary/, "折叠标题需要样式，否则看不见可点");
});

test("the panel never claims 没有找到 when it never asked", () => {
  // `doCoverage()` can only reach this plugin's own channel and passes an empty
  // `sourceResults`, so every source is NOT_ENABLED and the record list is empty.
  // The old empty state said 「没有找到符合条件的公开试验」 — asserting a cause
  // (no matches) that the data explicitly denies (nothing was asked). Worse, it
  // printed directly under a coverage panel that says 「本次只覆盖 0/5 处来源……
  // 未覆盖不等于没有结果」, so one screen carried two sentences that contradict
  // each other and the more conclusion-shaped one is the one users believe.
  // Same rule as §15.26: when you do not know the cause, say you do not know it.
  const emptyStates = [...html.matchAll(/el\(\s*"div",\s*"empty",\s*([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(emptyStates.length >= 2, "面板应至少有两种空态文案（问过 / 没问）");

  // The "no matches" sentence must be reachable only on the queried branch.
  // Match against the rendered string literal, not the first mention anywhere —
  // the doc comment above the function quotes the sentence too, and a guard that
  // keys on the comment passes no matter what the code does.
  const noMatchLiteral = html.indexOf('"没有找到符合条件的公开试验。可以换关键词再试。"');
  assert.ok(noMatchLiteral >= 0, "问过之后的空态文案应当保留");
  const queriedGuard = html.lastIndexOf("queried === 0", noMatchLiteral);
  assert.ok(
    queriedGuard >= 0 && noMatchLiteral - queriedGuard < 900,
    "「没有找到」这句代码必须落在 queried === 0 的 else 分支里",
  );

  // And the never-asked sentence must exist and must not be a "no matches" claim.
  assert.ok(html.includes("本次没有查询任何来源"), "面板必须有一种空态明确说「本次一处都没问」");
  // The never-asked sentence explicitly disclaims the "no matches" reading
  // ("这不是「没有找到符合条件的试验」"), so allow the negation but not the claim.
  assert.ok(
    !/本次没有查询任何来源(?![\s\S]{0,60}这不是)[\s\S]{0,60}「?没有找到/.test(html),
    "「一处都没问」的空态里不得正面给出「没有找到」这种结论",
  );

  // The count must come from the aggregator, not be recomputed in the panel.
  assert.ok(
    /typeof res\.sourcesQueried === "number"/.test(html),
    "面板必须用聚合器算出的 sourcesQueried，不能在面板里按状态重数一遍",
  );
  assert.ok(
    /render\(res && res\.items, note, 1\)/.test(html),
    "直连 CT.gov 的检索只要返回了就说明问过一处，零命中在那里才是真的「没有匹配」",
  );
});


test("the panel renders the host's overlap sentence instead of writing its own", () => {
  // The warning wording used to live only in the panel's renderOverlap, which
  // meant the assistant path could not relay it (the host shipped a bare array)
  // and a wording change in one place silently left the other stale. The host
  // now builds it — same as coverage.sentence and completeness.sentence — so the
  // panel must pass it through rather than re-word it.
  assert.ok(
    /renderOverlap\(res && res\.overlaps, res && res\.overlapsSentence\)/.test(html),
    "面板必须把宿主算出的 overlapsSentence 交给 renderOverlap",
  );
  assert.ok(
    /function renderOverlap\(overlaps, sentence\)/.test(html),
    "renderOverlap 必须接收宿主的句子",
  );
  // The panel must not keep its own phrasing of the same warning.
  assert.ok(
    !/两条通道的结果未去重，合并计数会偏高/.test(html),
    "面板不得自己拼一份重叠提示文案（宿主已给出，两处会漂移）",
  );
});
