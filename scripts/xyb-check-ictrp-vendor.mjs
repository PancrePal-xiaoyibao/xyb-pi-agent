#!/usr/bin/env node
/**
 * 校验随包 vendored 的 ICTRP Python 服务树的完整性与一致性。
 *
 * 存在理由（SPEC §15.10 / §15.3.8）：vendored 源码是**复制品**，它与上游
 * `/Users/.../ictrp-mcp-service/src/ictrp_mcp/` 之间没有任何机制保证同步，
 * 也不会因上游变更而报错。错误会以「某个工具神秘消失」的形式在运行时才暴露。
 * 本脚本把这个缺口变成构建期失败。
 *
 * 检查三件事：
 *   1. 必需的模块文件都在（少一个 → MCP 服务器直接起不来）
 *   2. 没有 Python 编译产物（__pycache__ / *.pyc）——vendoring 规则明确排除，
 *      它们会在安装时把 156K 的源码树变成无关字节，且可能带本机绝对路径
 *   3. 可选：与上游源码树逐字节比对（上游存在时）
 *
 * 用法：
 *   node scripts/xyb-check-ictrp-vendor.mjs                 # 只做本地校验
 *   node scripts/xyb-check-ictrp-vendor.mjs --upstream <dir> # 同时比对上游
 *   ICTRP_UPSTREAM=<dir> node scripts/xyb-check-ictrp-vendor.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = resolve(HERE, "..");
const VENDOR = join(
  ROOT,
  "apps/desktop/resources/plugins/xyb.trial-sources/mcp/ictrp/ictrp_mcp",
);

/** 少了任何一个，MCP 服务器都无法 import 或无法提供某个工具。 */
const REQUIRED_FILES = [
  "__init__.py",
  "server.py",
  "tools.py",
  "provenance.py",
  "offline.py",
  "errors.py",
  "cache/__init__.py",
  "cache/store.py",
  "data/__init__.py",
  "data/columns.py",
  "data/jsonio.py",
  "data/normalize.py",
  "data/query.py",
  "ictrp/__init__.py",
  "ictrp/export_guard.py",
  "ictrp/htmlstate.py",
  "ictrp/session.py",
];

/** python 编译产物不得进包：一是无关字节，二是 .pyc 可能嵌入本机绝对路径。 */
const FORBIDDEN_PATTERNS = [/\.pyc$/, /\.pyo$/, /__pycache__/];

let failures = 0;
let warnings = 0;

function fail(message) {
  failures += 1;
  console.error(`  ✗ ${message}`);
}

function warn(message) {
  warnings += 1;
  console.warn(`  ! ${message}`);
}

function gather(dir, prefix = "", out = new Map()) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(path).isDirectory()) {
      gather(path, rel, out);
    } else {
      out.set(rel, path);
    }
  }
  return out;
}

console.log("ICTRP vendored 服务树校验");
console.log("=".repeat(50));
console.log(`目标：${relative(ROOT, VENDOR) || VENDOR}\n`);

// —— 1. 存在性与必需文件 ——
if (!existsSync(VENDOR)) {
  fail(`vendored 目录不存在：${VENDOR}`);
  console.error("\n结果：失败（目录缺失）");
  process.exit(1);
}
console.log("1) 必需模块");
for (const file of REQUIRED_FILES) {
  const path = join(VENDOR, file);
  if (!existsSync(path)) {
    fail(`缺少必需文件：${file}`);
    continue;
  }
  // `__init__.py` 是包标记，**惯例上就是空文件**——不得把它的空判为损坏。
  // 其余文件为空则意味着复制中断或被误清空，属于必须拦下的打包事故。
  if (basename(file) !== "__init__.py" && statSync(path).size === 0) {
    fail(`必需文件为空（非 __init__.py）：${file}`);
  }
}
if (!failures) console.log(`   ✓ ${REQUIRED_FILES.length} 个必需模块齐全`);

// —— 2. 禁止编译产物 ——
console.log("\n2) 禁止 Python 编译产物");
const files = gather(VENDOR);
let artifacts = 0;
for (const [rel, path] of files) {
  if (FORBIDDEN_PATTERNS.some((p) => p.test(basename(path)) || p.test(rel))) {
    artifacts += 1;
    if (artifacts <= 5) fail(`发现编译产物：${rel}`);
  }
}
if (artifacts > 5) fail(`…另有 ${artifacts - 5} 个编译产物未被列出`);
if (!artifacts) console.log("   ✓ 无 __pycache__ / *.pyc（vendoring 规则已遵守）");

// —— 3. 所有 .py 文件语法非空且可 UTF-8 解码 ——
console.log("\n3) 源码可读性");
let pyCount = 0;
for (const [rel, path] of files) {
  if (!rel.endsWith(".py")) continue;
  pyCount += 1;
  try {
    readFileSync(path, "utf8");
  } catch (error) {
    fail(`无法以 UTF-8 读取：${rel} —— ${error.message}`);
  }
}
console.log(`   ✓ ${pyCount} 个 .py 文件全部可读`);

// —— 4. 可选：与上游比对 ——
const upstreamArgIdx = process.argv.indexOf("--upstream");
const upstream =
  process.env.ICTRP_UPSTREAM ||
  (upstreamArgIdx !== -1 ? process.argv[upstreamArgIdx + 1] : null);

console.log("\n4) 与上游源码树比对");
const upstreamExpected = join(upstream || "", "src", "ictrp_mcp");
if (!upstream) {
  console.log("   – 未指定上游（用 --upstream <repo> 或 ICTRP_UPSTREAM 启用）");
} else if (!existsSync(upstreamExpected)) {
  console.log(`   – 上游路径不存在，跳过：${upstreamExpected}`);
} else {
  const mine = gather(VENDOR);
  const theirs = gather(upstreamExpected);
  const ignore = (rel) => FORBIDDEN_PATTERNS.some((p) => p.test(basename(rel)) || p.test(rel));

  const mineFiltered = new Map([...mine].filter(([rel]) => !ignore(rel)));
  const theirsFiltered = new Map([...theirs].filter(([rel]) => !ignore(rel)));

  const onlyMine = [...mineFiltered.keys()].filter((k) => !theirsFiltered.has(k));
  const onlyTheirs = [...theirsFiltered.keys()].filter((k) => !mineFiltered.has(k));

  // 漂移用 fail 而非 warn：vendored 树按定义必须是**逐字复制**。
  // 任何差异只有两种可能——(a) 有人就地改了随包副本（重跑 vendoring 就会丢），
  // (b) 上游变了而本仓库没跟上。两者都需要人来裁决，用警告会被滑过去。
  let driftCount = 0;
  for (const rel of mineFiltered.keys()) {
    if (!theirsFiltered.has(rel)) continue;
    try {
      const a = readFileSync(mineFiltered.get(rel), "utf8");
      const b = readFileSync(theirsFiltered.get(rel), "utf8");
      if (a !== b) {
        driftCount += 1;
        if (driftCount <= 5) fail(`内容漂移：${rel}（vendored 副本与上游不一致）`);
      }
    } catch {
      fail(`比对失败：${rel}`);
    }
  }
  if (driftCount > 5) fail(`…另有 ${driftCount - 5} 个文件存在漂移`);

  for (const rel of onlyTheirs) fail(`上游新增、本仓库缺失：${rel}`);
  for (const rel of onlyMine) fail(`本仓库独有（上游已删或本地擅自新增）：${rel}`);

  if (!driftCount && !onlyMine.length && !onlyTheirs.length) {
    console.log(`   ✓ 与上游逐字节一致（${mineFiltered.size} 个文件）`);
  }
}

console.log("\n" + "=".repeat(50));
if (failures) {
  console.error(`结果：失败（${failures} 项错误，${warnings} 项提示）`);
  process.exit(1);
}
console.log(`结果：通过（${warnings} 项提示）`);
