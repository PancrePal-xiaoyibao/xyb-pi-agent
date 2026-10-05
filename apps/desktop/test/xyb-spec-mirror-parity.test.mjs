// Guards the gate that guards the SPEC's structural integrity.
//
// `scripts/check-spec-mirror-parity.mjs` is only useful if it actually fails on
// the drift it claims to catch — and its checks are non-obvious enough (a window
// that must span a whole bullet but not a whole file; an ordinal sequence;
// cross-document citations that are legitimately dangling) that they need their
// own tests rather than a hand-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  inspectSpec,
  checkParity,
  citesAnotherDocument,
  chineseOrdinal,
} from "../../../scripts/check-spec-mirror-parity.mjs";

const root = new URL("../../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

// The SPEC is a Chinese-language original and the sole authority for its topic,
// so it is checked on its own rather than against a counterpart.
const AUTHORITY = "docs/zh-CN/spec/xyb-unified-trial-host-orchestration.md";

test("the shipped SPEC passes structural parity with no mirror", () => {
  // The one assertion that matters for the real document. Its 72 internal
  // cross-references must all resolve, its 82 section numbers must be unique,
  // and its code fences must balance.
  const failures = checkParity({ spec: { source: read(AUTHORITY) }, mirror: null });
  assert.deepEqual(failures, [], `SPEC 自身结构漂移：\n  ${failures.join("\n  ")}`);
});

test("single-authority mode tolerates a mirror being absent entirely", () => {
  // Paired mode is still available for a future bilingual SPEC; the gate must
  // not require one, or a Chinese-only page could never be checked at all.
  const failures = checkParity({
    spec: { source: "### 1.1 A\n\n见 §1.1。\n" },
    mirror: null,
  });
  assert.deepEqual(failures, []);
});

test("single-authority mode has no English counterpart on disk", () => {
  // Pins the migration: the file was moved out of `docs/spec/` precisely because
  // two documentation gates read that directory as the English source of truth.
  assert.throws(() => read("docs/spec/xyb-unified-trial-host-orchestration.md"));
});

test("chinese ordinals parse across the ranges the SPEC uses", () => {
  assert.equal(chineseOrdinal("三"), 3);
  assert.equal(chineseOrdinal("九"), 9);
  assert.equal(chineseOrdinal("十"), 10);
  assert.equal(chineseOrdinal("十二"), 12);
  assert.equal(chineseOrdinal("十九"), 19);
  assert.equal(chineseOrdinal("二十"), 20);
});

test("subsections count as sections", () => {
  // Requiring exactly three hashes made every `#### 15.3.5` citation look
  // dangling — the gate reported 11 phantom failures against a healthy file.
  const facts = inspectSpec("### 15.1 顶层\n\n#### 15.3.5 子节\n");
  assert.deepEqual(
    facts.headings.map((h) => h.number),
    ["15.1", "15.3.5"],
  );
});

test("a mirror-only section is rejected", () => {
  const failures = checkParity({
    spec: { source: "### 1.1 只有英文有\n" },
    mirror: { source: "### 1.1 中文\n\n### 1.2 只有中文有\n" },
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /§1\.2 .*does not exist in the authority/s);
});

test("a dangling cross-reference is rejected", () => {
  // The exact §15.23 bug: the authority cites a section it does not contain.
  const failures = checkParity({
    spec: { source: "### 1.1 A\n\n见 §1.9 的说明。\n" },
    mirror: { source: "### 1.1 A\n" },
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /§1\.9 does not resolve/);
});

test("a cross-reference into another document is allowed", () => {
  // `docs/guide/…指导.md` §3.5 is a real citation of a real section — in a
  // different file. Demanding that this SPEC contain it would be wrong.
  const source = "- `docs/guide/临床新能力接入规范指导.md` — **已改**（2026-10-05）：新增 **§3.5「形态 D」**，其中的 `3.5.5` 与 `3.5.6` 是清单（裸数字，不带 §）。\n";
  assert.ok(citesAnotherDocument(source, "3.5"));
  const failures = checkParity({ spec: { source }, mirror: { source: "" } });
  assert.deepEqual(failures, []);
});

test("a whole bullet is scoped to the document it names, however long", () => {
  // The real bullet runs ~250 characters between the filename and `§3.5.6`, so
  // a distance-based window silently reports healthy citations as dangling.
  const filler = "共六个小节：".repeat(30);
  const source = `- \`docs/guide/临床新能力接入规范指导.md\` — **已改**（${filler}）：新增 **§3.5「形态 D」**，其中的 \`3.5.6\` 为检查清单。\n`;
  assert.ok(source.length > 250, `夹具必须至少和真实 bullet 一样长，否则测不到窗口问题（${source.length}）`);
  assert.ok(citesAnotherDocument(source, "3.5"), "长 bullet 里的引用仍然属于那份文档");
});

test("a filename in a previous bullet does not excuse a dangling reference", () => {
  // Scoping has to be per bullet: a whole-file window would let any bullet
  // anywhere in the document launder a broken citation.
  const source = "- `docs/guide/某个指南.md` 引用了 §3.5。\n- 本文件见 §9.9。\n";
  assert.ok(citesAnotherDocument(source, "3.5"));
  assert.ok(!citesAnotherDocument(source, "9.9"));
  const failures = checkParity({ spec: { source: "### 1.1 A\n\n" + source }, mirror: { source: "" } });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /§9\.9 does not resolve/);
});

test("duplicate section numbers and unbalanced fences are rejected", () => {
  const dup = checkParity({
    spec: { source: "### 1.1 A\n\n### 1.1 B\n" },
    mirror: { source: "" },
  });
  assert.ok(dup.some((f) => /§1\.1 is declared twice/.test(f)), dup.join("; "));

  const fences = checkParity({
    spec: { source: "### 1.1 A\n\n```js\nconst x = 1;\n" },
    mirror: { source: "" },
  });
  assert.ok(fences.some((f) => /fences are unbalanced/.test(f)), fences.join("; "));
});

test("a renumbered gap ordinal is rejected on both sides", () => {
  // 1 -> 3 is still "increasing", so the sequence check alone reports a jump;
  // the cross-file check is what names the specific section that disagrees.
  const failures = checkParity({
    spec: { source: "### 1.1 第一个真缺口：A\n\n### 1.2 第二个真缺口：B\n" },
    mirror: { source: "### 1.1 第一个真缺口：A\n\n### 1.2 第三个真缺口：B\n" },
  });
  assert.ok(failures.some((f) => /jump|contiguous/.test(f)), failures.join("; "));
  assert.ok(
    failures.some((f) => /§1\.2 is gap #3 in the mirror but #2 in the authority/.test(f)),
    failures.join("; "),
  );
});

test("a reused ordinal is rejected even when the sequence increases", () => {
  // The §15.19/§15.20 bug: both labelled 第四个. Repetition makes the last
  // ordinal fall short of what the length implies, which is how it is caught.
  const failures = checkParity({
    spec: { source: "### 1.1 第一个真缺口：A\n\n### 1.2 第一个真缺口：B\n" },
    mirror: { source: "" },
  });
  assert.ok(failures.some((f) => /strictly increase/.test(f)), failures.join("; "));
  assert.ok(failures.some((f) => /reused: 1/.test(f)), failures.join("; "));
});

test("gap ordinals must not skip a number", () => {
  // Contiguity is the check that would have caught §15.19/§15.20 both being
  // labelled 第四个: a reused ordinal is a skip somewhere else.
  const failures = checkParity({
    spec: { source: "### 1.1 第一个真缺口：A\n\n### 1.2 第三个真缺口：C\n" },
    mirror: { source: "" },
  });
  assert.ok(failures.some((f) => /jump|contiguous/.test(f)), failures.join("; "));
});
