#!/usr/bin/env node
/**
 * 把抓取好的 ChiCTR / CDE 结构化 JSON 打成随包分发的冷启动种子。
 *
 *   node scripts/xyb-sync-trial-json-seeds.mjs            # 预演，只报告将要发生什么
 *   node scripts/xyb-sync-trial-json-seeds.mjs --apply    # 实际写入种子
 *   node scripts/xyb-sync-trial-json-seeds.mjs --apply --force   # 覆盖已有种子
 *
 * ## 它在整条链路里的位置
 *
 *   ChiCTR：chictr-mcp-server sidecar + tools/chictr_crawl.py --export-json
 *        ↓  ~/Downloads/chictr_trials/data/pancreatic_trials.json（约 11MB）
 *   CDE  ：采集器按关键词抓取
 *        ↓  ~/Downloads/xyb-chinadrugtrials-data/output/<关键词>/json/*.json
 *   ICTRP：ictrp_search("pancreatic cancer") → ictrp_snapshot
 *        ↓  任意路径的快照文件（约 42MB）
 *   本脚本：瘦身 + 红线扫描 + 校验 + 写入
 *        ↓  apps/desktop/resources/plugins/xyb.trial-sources/data/
 *             chictr/pancreatic_trials.json
 *             chinadrugtrials/CTR*.json + index.json
 *             ictrp/pancreatic-cancer.json
 *   git commit → 下次 electron-builder 打包自动带进 dmg/exe
 *        ↓  extraResources: resources/plugins → plugins
 *   用户机器上的只读种子数据
 *
 * ## 与 ctv.db 的分工
 *
 *   ctv.db 由 `xyb-sync-trial-data.mjs` 单独处理（SQLite，需要瘦身脚本）。
 *   本脚本只处理 JSON 三个来源，互不覆盖。§7.9.2 的一键更新由两者共同构成。
 *
 * ## ICTRP 种子的特殊性（与另外两个不同）
 *
 *   另两个种子是**离线兜底**：在线来源查不到时，本地还能给出答案。
 *   ICTRP 种子是**加速 + 省上游负载**：`ictrp_search` 联网时本来就会物化整个
 *   结果集到本机缓存，快照只是把这份结果集预先算好。所以：
 *
 *   - 它**不改变契约**：命中快照时 `provenance.offline_snapshot=true`，
 *     `matched_rows_returned` / `upstream_reported_total` 照常分开返回，
 *     下界语义不变（实测 matched=6262 / upstream=6952）。
 *   - 它**必须自报陈旧**：超过 `ICTRP_BUNDLE_MAX_AGE_DAYS`（默认 28 天，
 *     WHO 每周更新）服务会标 `snapshot_stale` 并给出警告。所以这个种子
 *     有**保质期**，发布前要重跑本脚本。
 *
 *   ### WHO 条款（用户 2026-10-04 决策：随包分发）
 *
 *   ICTRP 数据受 WHO 条款约束：须标注来源为 WHO ICTRP、须显示 WHO 处理日期、
 *   不得主张专有权利、禁止营销/推广/商业用途、不得使用 WHO 名称徽标。
 *   上游集成文档原本判断「不得随包分发」，用户明确决策接受该风险并要求随包。
 *   因此这份种子**必须**自带归因（快照结构里已有 `attribution` 与
 *   `terms_notice`，本脚本原样保留，不裁剪），UI 侧也必须显示来源与处理日期。
 *   参见 SPEC §15.7。
 *
 * ## 为什么默认不覆盖
 *
 * 种子一旦提交就进了 git 历史，不可撤销。所以默认行为是**只在种子不存在时创建**；
 * 已经存在时必须显式加 `--force`。
 *
 * ## 瘦身规则（依据 SPEC §7.4 种子内容红线）
 *
 * 红线是**体量与结构化**，不是隐私 —— 用户 2026-10-04 已判定这些数据为各登记处的
 * 公开发布内容，**隐私不作为筛选条件**，且该判定适用于 ChiCTR / CDE / WHO ICTRP
 * 三个种子（见 §7.4 的「适用范围修订」）。所以联系人邮箱与手机号**保留**，以下
 * 数字是明确知情后的选择，不是遗漏：
 *
 *   - ChiCTR：468/468 条带 `申请注册联系人电子邮件` 与 `研究负责人电子邮件`，
 *     另有 417 条含手机号、`伦理委员会联系人邮箱` 133 条。
 *   - CDE：`联系人Email` / `Email` 约 970 个值。
 *
 * 被剔除的两类依据的是**安全**与**体量/结构化**，都不是隐私：
 *
 *   1. **原始响应留档**：ChiCTR 的 `raw_text`（整页拍平 HTML，含站点导航与页脚）、
 *      `html_sha256`/`content_sha256`（留档指纹）；CDE 的 `source.raw_html_path`。
 *      实测 ChiCTR `raw_text` 占 42%、CDE 的 raw/word 占 93%，且全都不可查询。
 *   2. **凭据**：`config.json` 内容、Cookie、会话材料。
 *      （依据**安全**：泄露凭据危及用户本人的站点会话，与数据是否公开无关。）
 *
 * 具体到 ChiCTR：`raw_text` 被剔除后 11.3MB → 2.0MB，而**可查询字段一个不少**
 * （`fields` 里的 76 个结构化键全部保留，纳入/排除标准也在其中）。
 * 因此种子只带结构化数据，原文仍可在用户本机的运行库中按需取。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");

/** 本仓库根目录（脚本位于 <repo>/scripts/）。 */
const repoRoot = resolve(import.meta.dirname, "..");
const pluginDataDir = join(
  repoRoot,
  "apps/desktop/resources/plugins/xyb.trial-sources/data",
);

const CHICTR_SRC = resolve(
  process.env.CHICTR_SEED_SOURCE ||
    join(homedir(), "Downloads", "chictr_trials", "data", "pancreatic_trials.json"),
);
const CDE_SRC_DIR = resolve(
  process.env.CDE_SEED_SOURCE ||
    join(homedir(), "Downloads", "xyb-chinadrugtrials-data", "output", "胰腺癌", "json"),
);
/**
 * ICTRP 快照源文件。
 *
 * 由 `ictrp_snapshot` 工具产出，不是抓取脚本直接给的。构建方式：
 *
 *   ICTRP_SNAPSHOT_SOURCE=/path/to/pancreatic-cancer.json \
 *     node scripts/xyb-sync-trial-json-seeds.mjs --apply
 *
 * 没有默认路径 —— 快照是构建产物，放哪由构建者决定，猜路径只会猜错。
 */
const ICTRP_SRC = process.env.ICTRP_SNAPSHOT_SOURCE
  ? resolve(process.env.ICTRP_SNAPSHOT_SOURCE)
  : null;

const chictrDestDir = join(pluginDataDir, "chictr");
const chictrDest = join(chictrDestDir, "pancreatic_trials.json");
const cdeDestDir = join(pluginDataDir, "chinadrugtrials");
const cdeIndex = join(cdeDestDir, "index.json");
const ictrpDestDir = join(pluginDataDir, "ictrp");
const ictrpDest = join(ictrpDestDir, "pancreatic-cancer.json");

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── Seed builders ───────────────────────────────────────────────────────────

/**
 * ChiCTR：剥掉留档与指纹，只留结构化字段。
 *
 * 每个顶层键的去留都在这里显式写明，**不用白名单过滤后再兜底** —— 因为
 * ChiCTR 的数据集 schema 会随版本演进（3.0.1 → 3.0.2 就新增了字段解析），
 * 静默丢掉一个未列出的新键比多带一个字段更糟。
 */
const CHICTR_DROP_KEYS = new Set([
  "raw_text", // 整页拍平原文，含站点导航/页脚，占 42%
  "html_sha256", // 留档指纹，种子不带留档，指纹无意义
  "content_sha256",
]);

function buildChictrSeed(srcPath) {
  const records = readJson(srcPath);
  if (!Array.isArray(records)) die(`ChiCTR 源文件的顶层不是数组：${srcPath}`);
  if (records.length === 0) die("ChiCTR 源文件没有任何记录，拒绝生成空种子。");

  const seen = new Set();
  const lean = [];
  for (const record of records) {
    const regNo = String(record.registration_number || "").trim();
    if (!regNo) die("ChiCTR 记录缺少 registration_number，拒绝生成种子。");
    // 同一注册号只保留一份；出现重复说明上游导出去重失效，要显式报错而不是静默丢。
    if (seen.has(regNo)) die(`ChiCTR 源文件含重复注册号 ${regNo}，请重跑导出。`);
    seen.add(regNo);

    const out = {};
    for (const [key, value] of Object.entries(record)) {
      if (CHICTR_DROP_KEYS.has(key)) continue;
      out[key] = value;
    }
    // fields 是真正可查询的结构化主体，必须存在且非空。
    if (!out.fields || typeof out.fields !== "object" || Array.isArray(out.fields)) {
      die(`ChiCTR 记录 ${regNo} 的 fields 不是对象，拒绝生成种子。`);
    }
    lean.push(out);
  }

  // 按注册号排序，保证同样的输入产出逐字节相同的输出（种子可复现）。
  lean.sort((a, b) =>
    String(a.registration_number).localeCompare(String(b.registration_number)),
  );

  return {
    seed: {
      schema_version: 1,
      source: "chictr",
      keyword: "胰腺癌",
      record_count: lean.length,
      built_at: new Date().toISOString(),
      // 覆盖范围如实声明：只抓了胰腺癌，其他癌种仍须联网查。
      coverage_note:
        "仅含胰腺癌相关试验的冷启动快照，不代表 ChiCTR 的全部收录。其他癌种仍须联网查询。",
      records: lean,
    },
    count: lean.length,
  };
}

/**
 * CDE：逐条 JSON 原样保留结构，只删掉指向留档的路径。
 *
 * CDE 的记录形状是 `{schema_version, source{...}, reg_no, ..., details{}}`，
 * `details` 里的中文键就是可查询主体。这里**不裁剪 `details`** —— 2405 个键里
 * 混杂着自由文本泄漏，但那是上游解析器的既有事实，种子应与线上归档一致，
 * 由 MCP 侧决定怎么呈现，而不是在打包阶段静默改写数据。
 */
function buildCdeSeed(srcDir) {
  if (!existsSync(srcDir)) die(`找不到 CDE 源目录：${srcDir}`);
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) die(`CDE 源目录没有 JSON：${srcDir}`);

  const records = [];
  const seen = new Set();
  for (const file of files) {
    const raw = readJson(join(srcDir, file));
    const regNo = String(raw.reg_no || "").trim();
    if (!regNo) die(`CDE 记录 ${file} 缺少 reg_no，拒绝生成种子。`);
    if (seen.has(regNo)) die(`CDE 源目录含重复注册号 ${regNo}（${file}）。`);
    seen.add(regNo);
    if (!raw.details || typeof raw.details !== "object") {
      die(`CDE 记录 ${regNo} 的 details 不是对象，拒绝生成种子。`);
    }

    const source = { ...(raw.source || {}) };
    // 指向 raw/ 留档的路径在种子环境下无意义（种子不带 raw/），删掉。
    delete source.raw_html_path;

    records.push({ ...raw, source });
  }

  records.sort((a, b) => String(a.reg_no).localeCompare(String(b.reg_no)));

  return {
    records,
    meta: {
      schema_version: 1,
      source: "chinadrugtrials",
      keyword: "胰腺癌",
      record_count: records.length,
      built_at: new Date().toISOString(),
      coverage_note:
        "仅含胰腺癌相关试验的冷启动快照，不代表平台的全部收录。其他适应症仍须联网查询。",
    },
  };
}

/**
 * ICTRP：裁剪每条试验字段，但**保留快照元数据与归因**。
 *
 * 与 CDE 的「原样保留」不同，ICTRP 快照单条记录有 78 个字段、41MB，其中
 * `inclusion_criteria` 一项就占 12.8MB。裁剪依据是**编排器实际消费哪些字段**
 * （见 `xyb.trials/lib/unified.js` 与 SPEC §15）：
 *
 *   - 保留：身份（trial_id / source_register）、标题、condition、干预、
 *     状态（含 normalized）、phase、日期、样本量、国家、来源注册库。
 *   - 剔除：入选/排除标准、终点指标的重复变体、结果数据、伦理联系人、
 *     桥接标志等 —— 这些在联网检索时仍可从上游取，且占体积的绝大部分。
 *
 * **归因不可裁。** `snapshot.attribution` 与 `snapshot.terms_notice` 原样保留：
 * WHO 条款要求标注来源并显示 WHO 处理日期，这是随包分发的前置条件（SPEC §15.7）。
 */
const ICTRP_KEEP_FIELDS = new Set([
  // 身份与来源
  "trial_id",
  "trialid",
  "source_register",
  "source_name",
  "secondary_id",
  "secondary_ids",
  "web_address",
  // 标题与病种
  "public_title",
  "scientific_title",
  "acronym",
  "condition",
  // 干预
  "intervention",
  "interventions",
  // 状态与分期
  "recruitment_status",
  "recruitment_status_normalized",
  "phase",
  "phase_code",
  // 日期
  "date_registration",
  "date_registration3",
  "registration_date",
  "registration_date_display",
  "registration_date_source",
  "date_enrollement",
  "last_refreshed_display",
  "last_refreshed_date",
  // 规模
  "target_size_total",
  "target_size_is_arm_split",
  // 范围
  "countries",
  "study_type",
  // 申办与关联
  "primary_sponsor",
  "other_records",
]);

function buildIctrpSeed(srcPath) {
  const bundle = readJson(srcPath);
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    die(`ICTRP 快照的顶层不是对象：${srcPath}`);
  }
  if (bundle.kind !== "ictrp-trial-set") {
    die(`ICTRP 快照的 kind 不是 ictrp-trial-set（实为 ${bundle.kind}）：${srcPath}`);
  }
  if (!Array.isArray(bundle.trials) || bundle.trials.length === 0) {
    die("ICTRP 快照没有任何试验，拒绝生成空种子。");
  }
  // 归因是随包分发的许可前提，缺了就不能发。
  const attribution = bundle.snapshot?.attribution;
  const termsNotice = bundle.snapshot?.terms_notice;
  if (!attribution || !termsNotice) {
    die("ICTRP 快照缺少 attribution 或 terms_notice，WHO 条款要求必须带归因。");
  }

  const seen = new Set();
  const trials = [];
  for (const trial of bundle.trials) {
    const id = String(trial.trial_id || "").trim();
    if (!id) die("ICTRP 试验缺少 trial_id，拒绝生成种子。");
    if (seen.has(id)) die(`ICTRP 快照含重复 trial_id ${id}，请重跑快照。`);
    seen.add(id);

    const out = {};
    for (const [key, value] of Object.entries(trial)) {
      if (ICTRP_KEEP_FIELDS.has(key)) out[key] = value;
    }
    trials.push(out);
  }

  // 按 trial_id 排序，保证同样的输入产出逐字节相同的输出（种子可复现）。
  trials.sort((a, b) => String(a.trial_id).localeCompare(String(b.trial_id)));

  const snapshot = { ...(bundle.snapshot || {}) };
  snapshot.trial_count = trials.length;
  snapshot.field_note =
    "Fields trimmed at packaging time to the subset the host orchestrator consumes. " +
    "Identity, titles, condition, intervention, status, phase, dates, size, countries " +
    "and registration source are preserved verbatim from the ICTRP export.";
  snapshot.built_at = new Date().toISOString();
  // WHO 条款：须显示 WHO 处理该数据的日期。上游导出日期单独留一份，
  // 不要与「我们打包的日期」混为一谈。
  snapshot.coverage_note =
    "仅含 pancreatic cancer 关键词的冷启动快照，不代表 ICTRP 的全部收录。其他关键词仍须联网查询。";

  return {
    seed: { ...bundle, snapshot, trials },
    count: trials.length,
    keyword: snapshot.keyword,
    upstreamReported: snapshot.provenance?.upstream_reported_total,
  };
}

// ── Red-line scan（SPEC §7.4） ───────────────────────────────────────────────
/**
 * 种子内容扫描：命中即拒绝发布（§10「随包分发与冷启动数据」第 6 条）。
 *
 * 扫的是**序列化后的文本**，因为红线特征可能出现在任意嵌套层级。
 * 两类特征：原始响应留档、凭据。
 */
const REDLINE_PATTERNS = [
  {
    id: "raw_archive",
    // 指向 raw/word 留档的路径或整页 HTML 残留
    test: (text) =>
      /raw_html_path|\.source\.doc\b/.test(text) ||
      /<html[\s>]|<!DOCTYPE\s+html|<div\s+class=["']?container/i.test(text),
    why: "原始响应留档（raw/、word/*.source.doc、整页 HTML）不得进种子",
  },
  {
    id: "credentials",
    test: (text) =>
      /\bcookie\b\s*[:=]|set-cookie|acw_sc__v2|sessionid\s*[:=]/i.test(text) ||
      /"(config|credentials?)"\s*:/.test(text),
    why: "Cookie / 会话凭据 / config.json 内容不得进种子",
  },
];

function scanRedlines(label, serialized) {
  const hits = [];
  for (const pattern of REDLINE_PATTERNS) {
    if (pattern.test(serialized)) hits.push(`${label}: ${pattern.id} — ${pattern.why}`);
  }
  return hits;
}

// ── Plan ────────────────────────────────────────────────────────────────────

console.log("ChiCTR 源  " + CHICTR_SRC);
console.log("CDE   源  " + CDE_SRC_DIR);
console.log("ICTRP 源  " + (ICTRP_SRC || "（未提供 ICTRP_SNAPSHOT_SOURCE，跳过）"));
console.log("种子目录  " + pluginDataDir);
console.log();

if (!existsSync(CHICTR_SRC)) die(`找不到 ChiCTR 源文件：${CHICTR_SRC}`);
if (!existsSync(CDE_SRC_DIR)) die(`找不到 CDE 源目录：${CDE_SRC_DIR}`);
if (ICTRP_SRC && !existsSync(ICTRP_SRC)) {
  die(`找不到 ICTRP 快照文件：${ICTRP_SRC}`);
}

const chictr = buildChictrSeed(CHICTR_SRC);
const cde = buildCdeSeed(CDE_SRC_DIR);
// ICTRP 是可选来源：没给源就跳过，不影响另外两个种子的更新。
const ictrp = ICTRP_SRC ? buildIctrpSeed(ICTRP_SRC) : null;

const chictrSerialized = JSON.stringify(chictr.seed);
const cdeSerialized = JSON.stringify({ meta: cde.meta, records: cde.records });
const ictrpSerialized = ictrp ? JSON.stringify(ictrp.seed) : null;

console.log(
  `ChiCTR    ${human(statSync(CHICTR_SRC).size)} · ${chictr.count} 条 → ` +
    `${human(Buffer.byteLength(chictrSerialized))} 种子`,
);
console.log(
  `CDE       ${cde.records.length} 条 → ${human(Buffer.byteLength(cdeSerialized))} 种子`,
);
if (ictrp) {
  console.log(
    `ICTRP     ${human(statSync(ICTRP_SRC).size)} · ${ictrp.count} 条 → ` +
      `${human(Buffer.byteLength(ictrpSerialized))} 种子` +
      `（关键词 ${ictrp.keyword}，上游自报 ${ictrp.upstreamReported} 条）`,
  );
}
console.log();

// 红线扫描在写盘**之前**跑，不通过就什么都不写。
const redlineHits = [
  ...scanRedlines("chictr", chictrSerialized),
  ...scanRedlines("chinadrugtrials", cdeSerialized),
  ...(ictrp ? scanRedlines("ictrp", ictrpSerialized) : []),
];
if (redlineHits.length) {
  console.error("✗ 种子内容红线扫描未通过：");
  for (const hit of redlineHits) console.error(`    ${hit}`);
  die("不得发布。请修正源数据或更新扫描规则（SPEC §7.4）。");
}
console.log("✓ 红线扫描通过（无原始留档、无凭据）");

const existing = [
  existsSync(chictrDest) ? chictrDest : null,
  existsSync(cdeIndex) ? cdeIndex : null,
  ictrp && existsSync(ictrpDest) ? ictrpDest : null,
].filter(Boolean);

if (existing.length && !force) {
  console.log(
    "\n种子已存在：\n" +
      existing.map((p) => `  ${p}`).join("\n") +
      "\n\n要覆盖，请显式加 --force\n" +
      "  （覆盖意味着下一次 git commit 会把新种子写进历史，且不可撤销）",
  );
  process.exit(0);
}

if (!apply) {
  console.log("\n预演（未写文件）。加 --apply 执行写入。");
  process.exit(0);
}

// ── Write ───────────────────────────────────────────────────────────────────

mkdirSync(chictrDestDir, { recursive: true });
mkdirSync(cdeDestDir, { recursive: true });

// 先写临时文件再 rename，避免半个种子冒充完整种子（与 ctv.db 同构）。
const chictrTmp = chictrDest + ".seed-tmp";
writeFileSync(chictrTmp, chictrSerialized + "\n");
if (existsSync(chictrDest)) rmSync(chictrDest);
copyFileSync(chictrTmp, chictrDest);
rmSync(chictrTmp);

// CDE 保持"一记录一文件"，与运行时归档目录结构一致，便于 MCP 逐条读。
for (const record of cde.records) {
  const dest = join(cdeDestDir, `${record.reg_no}.json`);
  const tmp = dest + ".seed-tmp";
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  if (existsSync(dest)) rmSync(dest);
  copyFileSync(tmp, dest);
  rmSync(tmp);
}
writeFileSync(cdeIndex, JSON.stringify(cde.meta, null, 2) + "\n");

if (ictrp) {
  mkdirSync(ictrpDestDir, { recursive: true });
  const ictrpTmp = ictrpDest + ".seed-tmp";
  writeFileSync(ictrpTmp, ictrpSerialized + "\n");
  if (existsSync(ictrpDest)) rmSync(ictrpDest);
  copyFileSync(ictrpTmp, ictrpDest);
  rmSync(ictrpTmp);
}

// ── Verify ──────────────────────────────────────────────────────────────────

const verifyChictr = readJson(chictrDest);
if (verifyChictr.records.length !== chictr.count) {
  die(`产物自检失败：ChiCTR 种子 ${verifyChictr.records.length} ≠ ${chictr.count}`);
}
if (verifyChictr.records.some((r) => "raw_text" in r)) {
  die("产物自检失败：ChiCTR 种子里仍有 raw_text。");
}
const verifyCde = readdirSync(cdeDestDir).filter(
  (f) => f.endsWith(".json") && f !== "index.json",
);
if (verifyCde.length !== cde.records.length) {
  die(`产物自检失败：CDE 种子 ${verifyCde.length} 个文件 ≠ ${cde.records.length} 条`);
}

if (ictrp) {
  const verifyIctrp = readJson(ictrpDest);
  if (verifyIctrp.trials.length !== ictrp.count) {
    die(`产物自检失败：ICTRP 种子 ${verifyIctrp.trials.length} ≠ ${ictrp.count}`);
  }
  // WHO 条款的归因是许可前提，产物里必须在。
  if (!verifyIctrp.snapshot?.attribution || !verifyIctrp.snapshot?.terms_notice) {
    die("产物自检失败：ICTRP 种子丢失 attribution 或 terms_notice。");
  }
  if (verifyIctrp.kind !== "ictrp-trial-set") {
    die(`产物自检失败：ICTRP 种子 kind 被改动（${verifyIctrp.kind}）。`);
  }
}

console.log(
  `\n✓ ChiCTR ${chictr.count} 条 → ${chictrDest} (${human(statSync(chictrDest).size)})`,
);
console.log(
  `✓ CDE    ${cde.records.length} 条 → ${cdeDestDir} (${human(
    readdirSync(cdeDestDir).reduce((sum, f) => sum + statSync(join(cdeDestDir, f)).size, 0),
  )})`,
);
if (ictrp) {
  console.log(
    `✓ ICTRP  ${ictrp.count} 条 → ${ictrpDest} (${human(statSync(ictrpDest).size)})`,
  );
  console.log(
    "\n  ⚠ ICTRP 种子有保质期：超过 28 天服务会标 snapshot_stale（WHO 每周更新）。" +
      "\n    发布前请重跑：ictrp_search → ictrp_snapshot → 本脚本。",
  );
}
console.log(
  "\n下一步：\n" +
    "  git add apps/desktop/resources/plugins/xyb.trial-sources/data/\n" +
    '  git commit -m "chore(data): refresh Chinadrugtrials/ChiCTR cold-start seeds"\n' +
    "  下次打包会自动带上这些种子。",
);
