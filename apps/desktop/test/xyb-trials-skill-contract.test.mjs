// The skill file is a contract with the model, and it is the only place that
// tells the assistant what each path's result contains. When it promises a
// field a path cannot produce, the assistant is told to present a sentence that
// does not exist — and silence about an unverified overlap reads as "no overlap".
//
// This test measures both result surfaces and holds the skill to what they
// actually return, instead of to what the prose remembers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runTrialComposite } from "../electron/main/trial-fanout.ts";
import { childToolName } from "../electron/main/trial-sources.ts";
import { buildResult } from "../resources/plugins/xyb.trials/lib/unified.js";

const skill = readFileSync(
  new URL("../resources/plugins/xyb.trials/skills/unified-trial-query.md", import.meta.url),
  "utf8",
);

/** Run the real fan-out once so the assertion is against live output, not code reading. */
async function fanoutResult() {
  return runTrialComposite({
    sessionId: "s",
    turnId: "t",
    args: { keywords: "pancreatic cancer" },
    resolveTool: (source) => ({ fullName: childToolName(source), pluginId: source.pluginId }),
    enabledInProject: () => true,
    dispatchChild: async (child) =>
      child.toolName.includes("ictrp_search")
        ? {
            ok: true,
            durationMs: 10,
            content: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    matched_rows_returned: 3,
                    upstream_reported_total: 6952,
                    records_incomplete: true,
                    trials: [],
                  }),
                },
              ],
            },
          }
        : { ok: true, durationMs: 5, content: { trials: [] } },
    now: () => Date.now(),
  });
}

test("the fan-out carries the overlap sentence and the merge path does not", async () => {
  const fanout = await fanoutResult();
  const merged = buildResult({ query: { keywords: "x" }, sourceResults: {} });

  assert.ok("overlapsSentence" in fanout, "扇出路径必须产出 overlapsSentence");
  assert.equal(
    "overlapsSentence" in merged,
    false,
    "合并路径（插件 API 面）枚举不了用户 MCP 服务器，因此不应产出 overlapsSentence",
  );
  // Both paths must still carry the two sentences they DO promise.
  for (const [label, res] of [
    ["fanout", fanout],
    ["unify", merged],
  ]) {
    assert.equal(typeof res.coverage?.sentence, "string", `${label} 必须带 coverage.sentence`);
    assert.equal(typeof res.completeness?.sentence, "string", `${label} 必须带 completeness.sentence`);
  }
});

test("the skill does not claim both paths return the overlap sentence", async () => {
  // The defect this test exists for: the skill said 「两个工具都会返回两句话」
  // and listed overlapsSentence among them, so an assistant on the merge path
  // was told to present a field it would never receive.
  const coversBoth =
    /`xyb_trials_fanout`（以及 `xyb_trials_unify`）会返回\*\*两句话\*\*/.test(skill) ||
    /xyb_trials_fanout.{0,12}以及.{0,12}xyb_trials_unify.{0,20}两句话/.test(skill);
  assert.equal(coversBoth, false, "技能文档不得把 overlapsSentence 说成两条路径都有");

  // It must instead say, explicitly, which path lacks it.
  assert.match(
    skill,
    /`overlapsSentence` 只有 `xyb_trials_fanout` 有/,
    "技能文档必须写明 overlapsSentence 只有扇出路径有",
  );
  assert.match(
    skill,
    /不要因为路径 B 没返回它，就以为没有重叠/,
    "必须警告：合并路径没有这句话不等于没有重叠",
  );
});

test("every field the skill names for a path exists on that path", async () => {
  // Scan the skill for backticked field names and check the ones that look like
  // result keys against the two real surfaces. This is what would have caught
  // the overlap defect on the day it was written.
  const fanout = await fanoutResult();
  const merged = buildResult({ query: { keywords: "x" }, sourceResults: {} });
  const known = {
    fanout: new Set(Object.keys(fanout)),
    unify: new Set(Object.keys(merged)),
  };
  const results = { fanout, unify: merged };

  // Fields that live one level down, e.g. `coverage.sentence`. `known` holds the
  // KEY SET, not the object, so the nested walk has to read `results` — passing
  // the Set made every dotted name look absent and reported a healthy fan-out as
  // missing `coverage.sentence`.
  const nested = (path, name) => {
    const [head, tail] = name.split(".");
    const value = results[path][head];
    return value !== undefined && typeof value === "object" ? tail in value : false;
  };
  const carries = (path, name) => known[path].has(name) || nested(path, name);

  for (const name of ["coverage.sentence", "completeness.sentence"]) {
    assert.ok(carries("fanout", name), `扇出路径缺少 ${name}`);
    assert.ok(carries("unify", name), `合并路径缺少 ${name}`);
  }
  assert.ok(carries("fanout", "overlapsSentence"), "扇出路径缺少 overlapsSentence");
  assert.equal(carries("unify", "overlapsSentence"), false);
});
