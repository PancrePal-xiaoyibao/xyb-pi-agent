/**
 * 随包种子内容红线（SPEC §10 第 6 条 / §7.4）。
 *
 * 为什么这条测试与 `scripts/xyb-sync-trial-json-seeds.mjs` 里的扫描不重复：
 * 那个脚本扫的是**它自己刚要写下的内容**，只在有人重跑生成时生效。种子一旦
 * 提交进仓库，就可能被别的路径改动——手工修补一个 JSON、从别处拷一份覆盖、
 * 或某个新脚本直接写文件——这些都不会经过生成器。本测试扫的是**仓库里实际
 * 随包分发的那些文件**，也就是用户装到机器上的那一份。
 *
 * 红线两类（用户 2026-10-04 判定隐私不构成约束，故此处不含个人信息检查）：
 *   1. 原始响应留档 —— ChiCTR 的 `raw_text`/`html/`、CDE 的 `raw/`、
 *      `word/*.source.doc`。依据是体量与结构化，不是隐私。
 *   2. 凭据 —— Cookie / 会话材料 / `config.json` 内容。依据是安全。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_ROOT = join(HERE, "..", "resources", "plugins", "xyb.trial-sources", "data");

/** 每个随包种子：目录、期望的文件形态、以及它必须自带的归属信息。 */
const SEEDS = [
  {
    key: "chictr",
    note: "ChiCTR 胰腺癌归档",
    file: join(SEED_ROOT, "chictr", "pancreatic_trials.json"),
  },
  {
    key: "chinadrugtrials",
    // 目录里除 139 个 CTR*.json 外还有一个 index.json 清单（记录条数与覆盖声明）。
    // 它是元数据不是数据，所以用 `dataPrefix` 把两者分开：清单不参与体量下限，
    // 但**同样要过红线扫描**——清单里出现凭据与归档路径是一样的事故。
    note: "CDE 胰腺癌归档（目录下每个 CTR*.json 都要合规）",
    dir: join(SEED_ROOT, "chinadrugtrials"),
    dataPrefix: "CTR",
  },
  {
    key: "ictrp",
    note: "WHO ICTRP 冷启动快照",
    file: join(SEED_ROOT, "ictrp", "pancreatic-cancer.json"),
  },
];

const REDLINES = [
  {
    id: "raw_archive",
    why: "原始响应留档不得进种子",
    test: (text) =>
      /raw_html_path|\.source\.doc\b/.test(text) ||
      /<html[\s>]|<!DOCTYPE\s+html|<div\s+class=["']?container/i.test(text),
  },
  {
    id: "credentials",
    why: "Cookie / 会话凭据 / config.json 内容不得进种子",
    test: (text) =>
      /\bcookie\b\s*[:=]|set-cookie|acw_sc__v2|sessionid\s*[:=]/i.test(text) ||
      /"(config|credentials?)"\s*:/.test(text),
  },
  {
    id: "raw_text_field",
    why: "整页拍平原文（raw_text）属于留档，不得随包",
    // 只在**键位置**命中。正文里出现「raw_text」这个词是允许的
    // （例如一句解释性说明），把值当键才是红线。
    test: (text) => /"raw_text"\s*:/.test(text),
  },
];

function collectSeedFiles() {
  const files = [];
  for (const seed of SEEDS) {
    if (seed.file) {
      files.push({ label: seed.key, note: seed.note, path: seed.file, seed });
      continue;
    }
    assert.ok(existsSync(seed.dir), `${seed.key}: 种子目录缺失 ${seed.dir}`);
    const entries = readdirSync(seed.dir).filter((n) => n.endsWith(".json"));
    assert.ok(entries.length > 0, `${seed.key}: ${seed.dir} 下没有 .json`);
    for (const name of entries) {
      const isData = !seed.dataPrefix || name.startsWith(seed.dataPrefix);
      files.push({ label: `${seed.key}/${name}`, note: seed.note, path: join(seed.dir, name), seed, isData });
    }
  }
  return files;
}

test("each shipped seed exists and is non-trivial", () => {
  const files = collectSeedFiles();
  assert.ok(files.length >= 3, `期望至少 3 个种子文件，实际 ${files.length}`);
  for (const file of files) {
    assert.ok(existsSync(file.path), `${file.label}: 缺失 ${file.path}`);
    // 清单文件（如 CDE 的 index.json）本来就只有几百字节，不适用体量下限。
    if (file.isData === false) continue;
    const size = statSync(file.path).size;
    assert.ok(size > 1024, `${file.label}: 体量异常小（${size} 字节），疑为空壳`);
  }
});

test("no shipped seed carries raw response archives", () => {
  const violations = [];
  for (const file of collectSeedFiles()) {
    const text = readFileSync(file.path, "utf8");
    for (const rule of REDLINES) {
      if (rule.test(text)) violations.push(`${file.label}: ${rule.id} — ${rule.why}`);
    }
  }
  assert.deepEqual(violations, [], `随包种子红线命中：\n${violations.join("\n")}`);
});

test("the redline rules would actually catch a violation", () => {
  // 一条永远不命中的检查与没有检查是同一件事。这里反向验证每条规则。
  const probes = {
    raw_archive: '{"raw_html_path":"data/raw/1.html"}',
    credentials: '{"cookie":"acw_sc__v2=abc"}',
    raw_text_field: '{"raw_text":"整页原文"}',
  };
  for (const [id, probe] of Object.entries(probes)) {
    const rule = REDLINES.find((r) => r.id === id);
    assert.ok(rule, `缺少红线规则 ${id}`);
    assert.equal(rule.test(probe), true, `红线规则 ${id} 未命中其自证样本`);
  }
  // 并且不得误报正常内容。
  const benign = JSON.stringify({
    registration_number: "ChiCTR2500102572",
    title: "一项关于胰腺癌的研究",
    raw_text_length: 12000,
    note: "本种子不含 raw_text 原文，仅保留结构化字段与长度统计。",
  });
  for (const rule of REDLINES) {
    assert.equal(rule.test(benign), false, `红线规则 ${rule.id} 误报了正常内容`);
  }
});

test("the WHO ICTRP seed keeps its attribution and processed date", () => {
  // 条款 4.b(1) 与 4.b(3)：归属与「WHO 处理该数据的日期」必须随数据存在。
  // 裁字段时最容易顺手裁掉的就是这两样，且裁掉后数据看起来毫无异常。
  const file = SEEDS.find((s) => s.key === "ictrp");
  const bundle = JSON.parse(readFileSync(file.file, "utf8"));
  assert.equal(bundle.kind, "ictrp-trial-set");
  const snapshot = bundle.snapshot ?? {};
  assert.match(String(snapshot.attribution ?? ""), /WHO|ICTRP/, "归属信息缺失或未提及 WHO");
  assert.ok(snapshot.terms_notice, "terms_notice 缺失——WHO 条款要求随数据披露");
  const processed = snapshot.provenance?.ictrp_export_date;
  assert.ok(processed, "缺 provenance.ictrp_export_date（WHO 处理日期）");
  // 处理日期与我们的抓取时间不是一回事，不得用后者顶替。
  assert.notEqual(String(processed), String(snapshot.created_at), "处理日期被抓取时间顶替");
  assert.ok(Array.isArray(bundle.trials) && bundle.trials.length > 0, "快照没有 trials");
});

test("the CDE seed index declares its record count and disease scope", () => {
  const index = JSON.parse(readFileSync(join(SEED_ROOT, "chinadrugtrials", "index.json"), "utf8"));
  assert.equal(index.source, "chinadrugtrials");
  assert.ok(index.record_count > 0, "index.json 未记录条数");
  assert.match(String(index.keyword ?? ""), /胰腺癌/, "index.json 未声明关键词范围");
  assert.ok(index.coverage_note, "index.json 缺少覆盖声明");
  assert.ok(index.built_at, "index.json 缺少构建时间——用户无法判断这份归档有多旧");
  const actual = readdirSync(join(SEED_ROOT, "chinadrugtrials")).filter((n) => n.startsWith("CTR")).length;
  assert.equal(actual, index.record_count, "index.json 的条数与实际文件数不符");
});

test("the ICTRP seed warns that criteria-derived fields are absent, not null-as-first-line", () => {
  // 上游 data/normalize.py 从自由文本「纳入/排除标准」里派生 line_of_therapy_hint，
  // 而随包瘦身恰好裁掉了那些文本列；离线路径 store.adopt() 原样采纳 snapshot.trials，
  // **不做** to_trial() 归一化。结果是离线查询该字段恒为 None —— 上游对 None 的定义是
  // 「我们所持标准里没写」，但模型极易读成「都是一线/未经治疗」。这条断言把「必须写明」
  // 变成契约，否则有人重跑生成器时很容易把这句说明删回去。
  const bundle = JSON.parse(readFileSync(SEEDS.find((s) => s.key === "ictrp").file, "utf8"));
  const note = String(bundle.snapshot?.field_note ?? "");
  assert.match(note, /line_of_therapy_hint/, "field_note 未提及自由文本派生字段的缺席");
  assert.match(note, /never .first-line.|不得.*一线/, "field_note 未声明缺失不等于 first-line");
  // 说明文字必须与实际数据一致：真的没有一条记录带着这个字段。
  const carries = bundle.trials.filter((t) => "line_of_therapy_hint" in t).length;
  assert.equal(carries, 0, `有 ${carries} 条记录带着 line_of_therapy_hint，与 field_note 的说法不符`);
  // 第三次 vendoring 漂移后（上游改为同时从 scientific_title 派生）这句说明必须
  // 变精确：criteria 文本确实不在随包里，但 scientific_title 在。若只笼统说
  // 「派生字段一律缺席」，一旦将来有人把归一化也接上离线路径，说明就成了假话。
  assert.match(note, /scientific_title/, "field_note 必须说明 scientific_title 在随包快照里（可派生）");
  assert.match(note, /carries_results_data/, "field_note 必须点名 carries_results_data");
  // 上面那句「可以派生」必须是真话：快照里确实带 scientific_title。
  const withTitle = bundle.trials.filter((t) => t.scientific_title).length;
  assert.ok(withTitle > 0, "field_note 声称 scientific_title 随包，但快照里一条都没有");
  assert.ok(bundle.snapshot?.built_at, "快照缺少 built_at");
});

test("every shipped seed declares the disease scope it actually covers", () => {
  // 三个种子都只覆盖胰腺癌。若某天有人把全量数据塞进来，或者反过来把覆盖
  // 声明删掉，用户就会把「归档里只有胰腺癌」读成「世上只有这些试验」——
  // 这正是「条数是下界」这条契约在**种子层面**的同一条要求。
  const declarations = [
    {
      label: "chictr",
      note: JSON.parse(readFileSync(join(SEED_ROOT, "chictr", "pancreatic_trials.json"), "utf8"))
        .coverage_note,
    },
    {
      label: "chinadrugtrials",
      note: JSON.parse(readFileSync(join(SEED_ROOT, "chinadrugtrials", "index.json"), "utf8"))
        .coverage_note,
    },
    {
      label: "ictrp",
      note: JSON.parse(readFileSync(join(SEED_ROOT, "ictrp", "pancreatic-cancer.json"), "utf8"))
        .snapshot?.coverage_note,
    },
  ];
  for (const { label, note } of declarations) {
    assert.ok(note, `${label}: 缺少 coverage_note——用户无从知道这份归档只覆盖一个癌种`);
    assert.match(String(note), /胰腺癌|pancreatic/i, `${label}: coverage_note 未声明关键词范围`);
    assert.match(String(note), /仍须联网|不代表|联网查询/, `${label}: coverage_note 未说明其余范围需要联网`);
  }
});
