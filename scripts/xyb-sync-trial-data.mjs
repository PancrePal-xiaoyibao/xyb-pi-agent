#!/usr/bin/env node
/**
 * 把刷新好的 CTV 试验索引同步进小胰宝插件，供发布包分发。
 *
 *   node scripts/xyb-sync-trial-data.mjs              # 预演，只报告将要发生什么
 *   node scripts/xyb-sync-trial-data.mjs --apply      # 实际复制并瘦身
 *   node scripts/xyb-sync-trial-data.mjs --apply --force   # 覆盖已有分发副本
 *
 * ## 它在整条链路里的位置
 *
 *   ctv-mcp-server 刷新索引（sync_sitemap / import_csv_export / backfill_details）
 *        ↓  产出 ~/.ctv-mcp/ctv.db（约 63MB）
 *   本脚本：瘦身 + 校验 + 复制
 *        ↓  apps/desktop/resources/plugins/xyb.trial-sources/data/ctv.db（约 50MB）
 *   git commit → 下次 electron-builder 打包自动带进 dmg/exe
 *        ↓  extraResources: resources/plugins → plugins
 *   用户机器上的只读种子数据
 *
 * 数据刷新是**按需**的（季度或重要试验更新），与发布次数无关 —— 文件内容
 * 不变时 git 不会产生新对象，发布多少次仓库都不涨。
 *
 * ## 为什么默认不覆盖
 *
 * 分发副本一旦提交就进了 git 历史（50MB 不可撤销）。所以默认行为是**只在
 * 分发副本不存在时创建**；已经存在时必须显式加 `--force` 才覆盖，避免顺手
 * 把一个未经确认的库推进历史。
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
const destDb = join(pluginDataDir, "ctv.db");
const srcDb = resolve(process.env.CTV_DATA_DIR || join(homedir(), ".ctv-mcp", "ctv.db"));
const slimTmp = join(pluginDataDir, ".ctv.slim.tmp.db");

/**
 * `slim-db.mjs` 在两个地方各放一份：小胰宝仓库的 `scripts/`（随代码版本化），
 * 以及 ctv-mcp-server 的 `scripts/`（数据源侧，方便那边独立跑）。这里按顺序
 * 找第一个存在的，也可以用 SLIM_DB_SCRIPT 显式指定。
 */
function findSlimScript() {
  const candidates = [
    process.env.SLIM_DB_SCRIPT,
    join(repoRoot, "scripts/slim-db.mjs"),
    resolve(process.env.CTV_MCP_SERVER_DIR || join(homedir(), "Downloads", "ctv-mcp-server"), "scripts/slim-db.mjs"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

const slimScript = findSlimScript();

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function sqlite(dbPath, sql) {
  return execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
}

// ── 前置检查 ────────────────────────────────────────────────────────────────

if (!existsSync(srcDb)) {
  die(
    `找不到源库：${srcDb}\n` +
      `  先让 ctv-mcp-server 建好索引，或用 CTV_DATA_DIR 指定别处。`,
  );
}

const srcSize = statSync(srcDb).size;
const srcStudies = Number(sqlite(srcDb, "SELECT COUNT(*) FROM studies;"));
if (srcStudies === 0) {
  die("源库的 studies 表是空的，拒绝分发一个空索引。");
}
const alreadySlim = Number(
  sqlite(srcDb, "SELECT COALESCE(SUM(LENGTH(COALESCE(locations_json,''))),0) FROM studies;"),
) === 0;

console.log(`源库     ${srcDb}`);
console.log(`         ${human(srcSize)} · ${srcStudies} 条研究${alreadySlim ? " · 已瘦身" : ""}`);
console.log(`分发位置 ${destDb}`);

if (existsSync(destDb)) {
  const destSize = statSync(destDb).size;
  const destStudies = Number(sqlite(destDb, "SELECT COUNT(*) FROM studies;"));
  console.log(`         已存在：${human(destSize)} · ${destStudies} 条研究`);
}

// ── 早退：什么都不会变 ──────────────────────────────────────────────────────

if (existsSync(destDb) && !force) {
  console.log(
    "\n分发副本已存在。要覆盖它，请显式加 --force\n" +
      "  （覆盖意味着下一次 git commit 会把 50MB 写进历史，且不可撤销）",
  );
  process.exit(0);
}

if (!apply) {
  console.log(
    `\n预演（未写文件）。加 --apply 执行：\n` +
      `  ${alreadySlim ? "复制" : "瘦身 + 校验 + 复制"} → ${destDb}`,
  );
  process.exit(0);
}

// ── 执行 ────────────────────────────────────────────────────────────────────

mkdirSync(pluginDataDir, { recursive: true });

/**
 * 瘦身脚本自己会做全套自检（条数 / is_china / FTS / 触发器），任一项不过就
 * 非零退出并删掉输出。这里直接透传它的退出码，不重复那套逻辑。
 */
if (alreadySlim) {
  copyFileSync(srcDb, slimTmp);
} else {
  if (!slimScript) {
    die(
      "源库尚未瘦身，但找不到 slim-db.mjs。\n" +
        "  放到 scripts/slim-db.mjs，或用 SLIM_DB_SCRIPT 指定路径。",
    );
  }
  console.log(`\n瘦身中…（${slimScript}）`);
  try {
    execFileSync(process.execPath, [slimScript, "--db", srcDb, "--out", slimTmp, "--apply"], {
      stdio: "inherit",
    });
  } catch {
    if (existsSync(slimTmp)) unlinkSync(slimTmp);
    die("瘦身失败，未改动分发副本。");
  }
}

// 复制过来的库不该带着别人的 WAL/SHM。
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(slimTmp + suffix)) unlinkSync(slimTmp + suffix);
}

// 最后一道闸：确认产物可读且条数对得上，再替换正式文件。
const tmpStudies = Number(sqlite(slimTmp, "SELECT COUNT(*) FROM studies;"));
if (tmpStudies !== srcStudies) {
  unlinkSync(slimTmp);
  die(`产物自检失败：条数 ${tmpStudies} ≠ 源库 ${srcStudies}，未改动分发副本。`);
}

if (existsSync(destDb)) unlinkSync(destDb);
copyFileSync(slimTmp, destDb);
unlinkSync(slimTmp);

// 上面那次 sqlite3 查询会重建 WAL/SHM，且它们叫 `<临时文件名>-wal`。必须在
// 查完之后再清一遍 —— 否则会把两个垃圾文件留在插件目录里。
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(slimTmp + suffix)) unlinkSync(slimTmp + suffix);
  // 同样清掉正式文件可能残留下来的。
  if (existsSync(destDb + suffix)) unlinkSync(destDb + suffix);
}

const destSize = statSync(destDb).size;
console.log(`\n✓ ${human(srcSize)} → ${human(destSize)} · ${srcStudies} 条研究`);
console.log(`  ${destDb}`);
console.log(
  "\n下一步：\n" +
    "  git add apps/desktop/resources/plugins/xyb.trial-sources/data/ctv.db\n" +
    '  git commit -m "chore(data): refresh CTV trial index"\n' +
    "  下次打包（pnpm dist / dist:mac / dist:win）会自动带上这份数据。",
);
