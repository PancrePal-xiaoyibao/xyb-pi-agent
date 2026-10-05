#!/usr/bin/env node
/**
 * SPEC structural integrity. The XYB trial-orchestration SPEC is authored in
 * Chinese and is the sole authority; it previously sat in `docs/spec/` beside a
 * hand-maintained Chinese outline, which two documentation gates read as an
 * English/Chinese pair and rejected. It now lives in `docs/zh-CN/spec/` and has
 * no counterpart, so there is no pair left to compare.
 *
 * What still matters is the document's *internal* consistency: the drift this
 * gate has actually caught is a section number that exists in one place and is
 * cited from another, which silently makes a cross-reference wrong. Single
 * authority mode keeps exactly that check.
 *
 * Usage:
 *   node scripts/check-spec-mirror-parity.mjs
 *   node scripts/check-spec-mirror-parity.mjs --spec docs/zh-CN/spec/foo.md
 *   node scripts/check-spec-mirror-parity.mjs --spec a.md --mirror b.md   (paired mode)
 *
 * What this checks (and what it deliberately does not):
 *   1. Single-authority mode: every `§X.Y` cross-reference resolves to a real
 *      section in the same file, section numbers are unique, and code fences
 *      are balanced.
 *   2. Paired mode (only when a `--mirror` is given): additionally, every
 *      section number in the mirror exists in the authority, gap ordinals agree
 *      per section number, and extra mirror structure is allowed only where the
 *      mirror declares itself an outline.
 *
 * It does NOT compare prose or translation quality: no machine can tell whether
 * a Chinese paragraph still means what an English one means, and a gate that
 * claimed to would be worse than no gate. It catches *structural* drift only,
 * which is the drift that silently makes a cross-reference wrong.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

const DEFAULTS = {
  spec: "docs/zh-CN/spec/xyb-unified-trial-host-orchestration.md",
  mirror: null,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") options.spec = argv[++i];
    else if (arg === "--mirror") options.mirror = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/check-spec-mirror-parity.mjs [--spec <path>] [--mirror <path>]");
      process.exit(0);
    }
  }
  return options;
}

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** Parse a Chinese ordinal such as 十二 / 二十 / 九 into its value. */
export function chineseOrdinal(text) {
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + CN_DIGITS[text[1]];
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return CN_DIGITS[tens] * 10 + (ones ? CN_DIGITS[ones] : 0);
  }
  return CN_DIGITS[text];
}

// Section numbers appear under both `###` (top-level sections) and `####`
// (subsections such as §15.3.5 and §7.9.1), so the level must not be pinned:
// requiring exactly three hashes made every subsection citation look dangling.
const HEADING = /^#{2,5}\s+§?(\d+(?:\.\d+)+)\s*(.*)$/;
const GAP_HEADING = /^#{2,5}\s+§?(\d+(?:\.\d+)+)\s+第([一二三四五六七八九十]+)(?:个真缺口|处缺口)/;

/** Structural facts about one SPEC file, as a plain object so tests can call it. */
export function inspectSpec(source) {
  const lines = source.split("\n");
  const headings = [];
  const gaps = [];
  let fences = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim().startsWith("```")) fences += 1;
    const heading = HEADING.exec(line);
    if (heading) headings.push({ number: heading[1], title: heading[2].trim(), line: index + 1 });
    const gap = GAP_HEADING.exec(line);
    if (gap) gaps.push({ number: gap[1], ordinal: chineseOrdinal(gap[2]), line: index + 1 });
  }
  const citations = new Set();
  for (const match of source.matchAll(/§(\d+(?:\.\d+)+)/g)) citations.add(match[1]);
  return { headings, gaps, citations, fences, lines };
}

/**
 * True when the text immediately preceding a §-citation names another document,
 * e.g. `` `docs/guide/临…指导.md` §3.5 `` — cross-document references are valid
 * even though this file has no such section.
 */
/**
 * True when a §-citation belongs to another document rather than to this file.
 *
 * Distance is the wrong signal: one dense bullet can run
 *
 *   - `docs/guide/…指导.md` — **已改**（…）：新增 **§3.5「…」**，共六个小节——`3.5.5`
 *     …；`3.5.6` 形态 D 检查清单。同时：`§0` 指向新增小节；…
 *
 * and a name 250 characters before the citation still governs it. So the unit is
 * the *bullet*: if a bullet names another document, every §-reference in that
 * bullet is read as pointing into that document. Line-level scoping keeps a
 * previous bullet's filename from excusing this one's dangling reference.
 */
export function citesAnotherDocument(source, citation) {
  const escaped = citation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`§${escaped}`);
  const hasOtherDoc = /`[^`\n]*\.md`/;
  for (const bullet of source.split(/\n(?=\s*[-*] )/)) {
    if (!pattern.test(bullet)) continue;
    if (hasOtherDoc.test(bullet)) return true;
  }
  return false;
}

export function checkParity({ spec, mirror }) {
  const failures = [];
  const fail = (message) => failures.push(message);

  const authority = inspectSpec(spec.source);
  const translation = mirror ? inspectSpec(mirror.source) : null;

  for (const [label, facts] of [["authority", authority], ["mirror", translation]]) {
    if (!facts) continue;
    if (facts.fences % 2 !== 0) {
      fail(`${label}: code fences are unbalanced (${facts.fences}) — a fence was opened and never closed`);
    }
    const seen = new Map();
    for (const heading of facts.headings) {
      if (seen.has(heading.number)) {
        fail(`${label}: section §${heading.number} is declared twice (lines ${seen.get(heading.number)} and ${heading.line})`);
      }
      seen.set(heading.number, heading.line);
    }
  }

  // 3. Cross-references must resolve. In single-authority mode this is the whole
  //    gate: the drift this catches is a cited section that does not exist.
  //    Some §-references deliberately point at *other* documents (e.g.
  //    `docs/guide/…` §3.5), so a citation is only checked when the text right
  //    before it does not name a different file — otherwise the gate would
  //    demand that this SPEC contain sections belonging to a guide.
  const authorityNumbers = new Set(authority.headings.map((h) => h.number));
  for (const citation of [...authority.citations].sort()) {
    if (authorityNumbers.has(citation)) continue;
    if (citesAnotherDocument(spec.source, citation)) continue;
    fail(`authority: cross-reference §${citation} does not resolve to any section in this file`);
  }

  if (!translation) return failures;

  // 1. Mirror sections must exist in the authority.
  for (const heading of translation.headings) {
    if (!authorityNumbers.has(heading.number)) {
      fail(
        `mirror: §${heading.number} ("${heading.title}") does not exist in the authority — ` +
          `the SPEC is the sole authority, so a section that lives only in the mirror cannot be cited or corrected`,
      );
    }
  }

  // 2. Gap ordinals: strictly increasing, unique, contiguous, and identical
  //    per section number across the two files.
  for (const [label, facts] of [["authority", authority], ["mirror", translation]]) {
    if (!facts) continue;
    const ordinals = facts.gaps.map((g) => g.ordinal);
    if (ordinals.length === 0) continue;
    for (let i = 1; i < ordinals.length; i += 1) {
      if (ordinals[i] <= ordinals[i - 1]) {
        fail(
          `${label}: gap ordinals must strictly increase (§${facts.gaps[i].number} is #${ordinals[i]} ` +
            `after §${facts.gaps[i - 1].number} #${ordinals[i - 1]})`,
        );
      }
    }
    const duplicates = ordinals.filter((value, index) => ordinals.indexOf(value) !== index);
    if (duplicates.length > 0) {
      fail(`${label}: gap ordinal(s) reused: ${[...new Set(duplicates)].join(", ")}`);
    }
    const expected = ordinals[0] + ordinals.length - 1;
    if (ordinals[ordinals.length - 1] !== expected) {
      fail(
        `${label}: gap ordinals jump (${ordinals[0]}..${ordinals[ordinals.length - 1]} ` +
          `across ${ordinals.length} sections — expected contiguous numbering)`,
      );
    }
  }
  const authorityGaps = new Map(authority.gaps.map((g) => [g.number, g.ordinal]));
  for (const gap of translation.gaps) {
    const mine = authorityGaps.get(gap.number);
    if (mine !== undefined && mine !== gap.ordinal) {
      fail(`§${gap.number} is gap #${gap.ordinal} in the mirror but #${mine} in the authority`);
    }
  }

  // 3. Cross-references inside the authority must resolve. Some §-references
  //    deliberately point at *other* documents (e.g. `docs/guide/…` §3.5), so a
  //    citation is only checked when the text right before it does not name a
  //    different file — otherwise the gate would demand that this SPEC contain
  //    sections belonging to a guide.
  const authorityLines = spec.source.split("\n");
  void authorityLines;

  return failures;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const read = (rel) => stripFrontMatter(readFileSync(path.join(root, rel), "utf8"));
  let spec;
  let mirror = null;
  try {
    spec = { path: options.spec, source: read(options.spec) };
    if (options.mirror) mirror = { path: options.mirror, source: read(options.mirror) };
  } catch (error) {
    console.error(`✗ cannot read SPEC${options.mirror ? " pair" : ""}: ${error.message}`);
    process.exit(1);
  }

  const failures = checkParity({ spec, mirror });
  const authority = inspectSpec(spec.source);

  console.log(`${spec.path}    sections=${authority.headings.length} gaps=${authority.gaps.length} citations=${authority.citations.size}`);
  if (mirror) {
    const translation = inspectSpec(mirror.source);
    console.log(`${mirror.path}    sections=${translation.headings.length} gaps=${translation.gaps.length}`);
  } else {
    console.log("单权威模式（无镜像可比）：只校验自身交叉引用、章节唯一性与代码栅栏配平。");
  }

  if (failures.length > 0) {
    console.error(`\n结果：失败（${failures.length} 项）`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log("\n结果：通过（0 项提示）");
}

/** Drop a leading `---` front-matter block so VitePress metadata is not scanned. */
function stripFrontMatter(source) {
  if (!source.startsWith("---\n")) return source;
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) return source;
  return source.slice(end + 5);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
