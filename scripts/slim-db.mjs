#!/usr/bin/env node
/**
 * 瘦身 ctv-mcp-server 的 SQLite 索引库。
 *
 *   node scripts/slim-db.mjs [--db <路径>] [--out <路径>] [--apply] [--json]
 *
 * ## 为什么需要这个脚本
 *
 * 上游的 `studies` 表把同一份位置数据存了两遍：
 *
 *   - `locations_json`  —— 由触发器 `trg_studies_china_*` 用来算 `is_china`
 *   - `detail_json.locations` —— `get_study_detail` 真正读取的那一份
 *
 * 实测抽样 300 条，其中 292 条的 `locations_json` 与
 * `detail_json.locations` **逐字节相同**，是纯粹的第二份副本，占 14.7MB
 * （全库 63.7MB 的 23%）。
 *
 * 本脚本把 `locations_json` 置为 NULL 并 VACUUM，回收这部分空间。
 * **不删列** —— 上游 `repository.js:210,337` 在每次 upsert 时都会写
 * `locations_json`，删列会让上游的 INSERT/UPDATE 直接报错；置 NULL 则
 * 保持 schema 兼容，上游写入时会照常填回（见下方「已知行为」）。
 *
 * ## 已知行为（不是缺陷，是设计取舍）
 *
 * 瘦身是**一次性**的，不是持续性的：
 *
 *   - 只读操作（`search_studies` / `get_study_detail` / `get_index_stats`）
 *     不会改变库体积 —— 已实测验证。
 *   - 但写操作（`import_csv_export` / `backfill_details` / `sync_sitemap`）
 *     会重新写入 `locations_json`，库体积**会涨回约 63MB**。
 *
 * 对分发场景这是可接受的：随安装包分发的是一份只读种子数据，用户日常查询
 * 不会让它变大。用户若主动跑全量同步，库涨回去属于预期，不影响正确性。
 * 需要重新瘦身时再跑一次本脚本即可（幂等：已瘦身的库再跑不会更小，也不会报错）。
 *
 * ## 正确性保证
 *
 * `locations_json` 置 NULL 后，`is_china` 列保留原值不动（实测 408 条
 * 中国试验数不变），`countries` 列也不动。所有位置信息在
 * `detail_json.locations` 里完整保留（实测两库都是 48558 条）。
 *
 * 脚本在写出前会跑一遍自检，任一项不符即**不写文件**并以非零码退出。
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const apply = flag("--apply");
const asJson = flag("--json");
const sourceDb = resolve(value("--db", join(homedir(), ".ctv-mcp", "ctv.db")));
const outDb = resolve(value("--out", join(dirname(sourceDb), "ctv.slim.db")));

/** 期望的中国试验数下限。低于这个数说明 is_china 被破坏了。 */
const MIN_CHINA_STUDIES = 300;

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function sqlite(dbPath, sql) {
  try {
    return execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    die(`sqlite3 执行失败：${detail}`);
  }
}

function scalar(dbPath, sql) {
  const out = sqlite(dbPath, sql);
  return out === "" ? null : out;
}

function number(dbPath, sql) {
  const raw = scalar(dbPath, sql);
  return raw === null ? 0 : Number(raw);
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── 前置检查 ────────────────────────────────────────────────────────────────

if (!existsSync(sourceDb)) {
  die(`找不到源库：${sourceDb}`);
}
if (sourceDb === outDb) {
  die("--out 不能与 --db 相同；本脚本不原地修改源库。");
}
try {
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
} catch {
  die("需要 sqlite3 命令行工具（macOS 自带；Linux 请装 sqlite3）。");
}

const beforeSize = statSync(sourceDb).size;

// 收集瘦身前的事实，用于自检和报告。
const facts = {
  studies: number(sourceDb, "SELECT COUNT(*) FROM studies;"),
  china: number(sourceDb, "SELECT COUNT(*) FROM studies WHERE is_china = 1;"),
  locationsJsonBytes: number(
    sourceDb,
    "SELECT COALESCE(SUM(LENGTH(COALESCE(locations_json,''))),0) FROM studies;",
  ),
  detailLocations: number(
    sourceDb,
    `SELECT COALESCE(SUM(json_array_length(json_extract(detail_json,'$.locations'))),0)
     FROM studies WHERE json_extract(detail_json,'$.locations') IS NOT NULL;`,
  ),
  alreadySlim: false,
};

if (facts.studies === 0) {
  die("源库里 studies 表是空的，拒绝瘦身（会产出一个无用的空库）。");
}

facts.alreadySlim = facts.locationsJsonBytes === 0;

// ── 复制 + 瘦身 ─────────────────────────────────────────────────────────────

console.log(`源库   ${sourceDb}`);
console.log(`       ${human(beforeSize)} · ${facts.studies} 条研究 · ${facts.china} 条中国试验`);
console.log(`locations_json ${human(facts.locationsJsonBytes)} · detail_json 位置 ${facts.detailLocations} 条`);

if (facts.alreadySlim) {
  console.log("\n该库的 locations_json 已经是空的 —— 无需瘦身。");
} else if (!apply) {
  console.log(`\n预演模式（未写文件）。加 --apply 生成 ${outDb}`);
}

if (apply) {
  if (existsSync(outDb)) unlinkSync(outDb);
  copyFileSync(sourceDb, outDb);
  // 去掉可能残留的 WAL/SHM，避免复制来的库带着别人的日志。
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(outDb + suffix)) unlinkSync(outDb + suffix);
  }

  // 置 NULL 而非 DROP COLUMN：上游 upsert 每次都会写这一列。
  //
  // 这一步必须临时摘掉 `trg_studies_fts_au`。SQLite 在「存在一个会写虚拟表的
  // 触发器」时会拒绝整条 UPDATE（报 `unsafe use of virtual table "studies_fts"`），
  // 哪怕该触发器的 WHEN 条件根本不看 locations_json、实际永远不会触发。
  //
  // 触发器本身是有用的（它维护 studies_fts 全文索引），所以改完必须原样装回。
  // 崩溃或中断时库会缺这个触发器，因此写入前先把 DDL 存下来，用 try/finally 兜底。
  const ftsTrigger = scalar(
    outDb,
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_studies_fts_au';",
  );
  if (!ftsTrigger) {
    die("源库缺少 trg_studies_fts_au 触发器，schema 与预期不符，拒绝瘦身。");
  }

  try {
    sqlite(outDb, "DROP TRIGGER trg_studies_fts_au;");
    sqlite(outDb, "UPDATE studies SET locations_json = NULL;");
  } finally {
    sqlite(outDb, `${ftsTrigger};`);
  }

  // is_china 保持不动 —— 置 NULL 会让维护它的触发器不再触发（条件里要求
  // new.locations_json IS NOT NULL），所以必须确认它没被连带改坏。
  sqlite(outDb, "VACUUM;");

  // ── 自检：任一不符就不交付 ──────────────────────────────────────────────
  const checks = [];
  const afterStudies = number(outDb, "SELECT COUNT(*) FROM studies;");
  const afterChina = number(outDb, "SELECT COUNT(*) FROM studies WHERE is_china = 1;");
  const afterDetailLocations = number(
    outDb,
    `SELECT COALESCE(SUM(json_array_length(json_extract(detail_json,'$.locations'))),0)
     FROM studies WHERE json_extract(detail_json,'$.locations') IS NOT NULL;`,
  );
  const afterLocationsJson = number(
    outDb,
    "SELECT COALESCE(SUM(LENGTH(COALESCE(locations_json,''))),0) FROM studies;",
  );
  const afterFts = number(outDb, "SELECT COUNT(*) FROM studies_fts;");

  checks.push(["研究条数不变", afterStudies === facts.studies, `${facts.studies} → ${afterStudies}`]);
  checks.push(["is_china 未被破坏", afterChina === facts.china, `${facts.china} → ${afterChina}`]);
  checks.push([
    "中国试验数不低于下限",
    afterChina >= MIN_CHINA_STUDIES,
    `${afterChina} ≥ ${MIN_CHINA_STUDIES}`,
  ]);
  checks.push([
    "detail_json 位置数据完整保留",
    afterDetailLocations === facts.detailLocations,
    `${facts.detailLocations} → ${afterDetailLocations}`,
  ]);
  checks.push(["locations_json 已清空", afterLocationsJson === 0, `${afterLocationsJson} 字节`]);
  // FTS 索引若是空的，全文检索会静默返回 0 条 —— 必须拦住。
  checks.push(["FTS 索引未丢行", afterFts === facts.studies, `${afterFts} 行`]);
  // 触发器没装回去的话，库看起来完全正常，但要等到用户下次同步才会发现
  // 全文索引不再更新 —— 是最难排查的一种损坏。
  const triggersRestored = number(
    outDb,
    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='trg_studies_fts_au';",
  );
  checks.push(["FTS 触发器已装回", triggersRestored === 1, `${triggersRestored} 个`]);

  const failures = checks.filter(([, ok]) => !ok);
  const afterSize = statSync(outDb).size;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: failures.length === 0,
          sourceDb,
          outDb,
          beforeBytes: beforeSize,
          afterBytes: afterSize,
          savedBytes: beforeSize - afterSize,
          facts,
          after: { studies: afterStudies, china: afterChina, detailLocations: afterDetailLocations, fts: afterFts },
          checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log("");
    for (const [name, ok, detail] of checks) {
      console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(22)} ${detail}`);
    }
    console.log(`\n${human(beforeSize)} → ${human(afterSize)}（省 ${human(beforeSize - afterSize)}）`);
    console.log(`输出 ${outDb}`);
  }

  if (failures.length) {
    unlinkSync(outDb);
    die(`自检未通过（${failures.map(([n]) => n).join("、")}），已删除输出文件。`);
  }
}
