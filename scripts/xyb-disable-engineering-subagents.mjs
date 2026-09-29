#!/usr/bin/env node
/**
 * 把 PI-Desktop 内置的 5 个软件工程角色子智能体默认关闭。
 *
 * 为什么是"写入状态文件"而不是改代码：
 *   host-core 的启用语义（agent_capabilities.rs:121-144）是——
 *   全局级「显式启用」= **删除记录**，落到默认值 true；「显式关闭」= 写入 false。
 *   也就是说状态文件无法表达"我主动打开过"。
 *   因此若在代码里并上一个恒定禁用集，用户手动打开后记录被删、恒定集仍然生效，
 *   开关就变成了假的。唯一能同时做到「默认关闭」与「可再打开」的办法，
 *   就是在首次运行时把 false 写进状态文件。
 *
 * 写入格式与 host-core 完全一致（serde_json::to_string 的紧凑形式作键）：
 *   {"values": { "{\"kind\":\"subagent-builtins\",\"level\":\"global\",\"id\":\"fixer\"}": false }}
 *
 * 用法：
 *   node scripts/xyb-disable-engineering-subagents.mjs              # 关闭 5 个
 *   node scripts/xyb-disable-engineering-subagents.mjs --enable     # 恢复（删掉这些记录）
 *   node scripts/xyb-disable-engineering-subagents.mjs --dry-run    # 只看会做什么
 *   node scripts/xyb-disable-engineering-subagents.mjs --data-dir <路径>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 内置的 5 个软件工程角色，与 BUILTIN_SUBAGENT_DOCUMENTS 的 name 一致。 */
const ENGINEERING_BUILTINS = [
  "explorer",
  "code-reviewer",
  "test-runner",
  "fixer",
  "ui-designer",
];

const KIND = "subagent-builtins";
const LEVEL = "global";

// ── 参数 ──
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const enable = argv.includes("--enable");
const dirFlag = argv.indexOf("--data-dir");
const explicitDir = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;

if (dirFlag >= 0 && !explicitDir) {
  console.error("--data-dir 需要一个路径参数");
  process.exit(2);
}

/** 与 host-core 的 StateKey 序列化保持一致：字段顺序 kind→level→id，project_path 省略。 */
function stateKey(id) {
  return JSON.stringify({ kind: KIND, level: LEVEL, id });
}

/** 候选数据目录：显式指定 > 开发态（xyb-pi Dev）> 打包态（xyb-pi）。 */
function resolveDataDir() {
  if (explicitDir) return explicitDir;
  const support = join(homedir(), "Library", "Application Support");
  const candidates = [join(support, "xyb-pi Dev"), join(support, "xyb-pi")];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

const dataDir = resolveDataDir();
const capDir = join(dataDir, "agent-capabilities");
const statePath = join(capDir, KIND + ".json");

console.log(`数据目录: ${dataDir}`);
console.log(`状态文件: ${statePath}`);
console.log(enable ? "模式: 恢复（删除这些禁用记录）" : "模式: 关闭");
console.log();

// ── 读现有状态（必须保留用户自己的其它开关）──
let values = {};
let existed = false;
if (existsSync(statePath)) {
  existed = true;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.values && typeof parsed.values === "object") {
      values = parsed.values;
    } else {
      console.error("状态文件结构不符合预期（缺少 values 对象），已中止以免覆盖。");
      process.exit(1);
    }
  } catch (error) {
    console.error(`状态文件不是合法 JSON（${error.message}），已中止以免覆盖。`);
    process.exit(1);
  }
}

console.log(existed ? `现有记录 ${Object.keys(values).length} 条（会保留）` : "状态文件尚不存在（会新建）");
console.log();

const touched = [];
for (const id of ENGINEERING_BUILTINS) {
  const key = stateKey(id);
  const current = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
  if (enable) {
    if (current === undefined) {
      touched.push(`  ${id.padEnd(15)} 无需改动（当前就是默认启用）`);
      continue;
    }
    delete values[key];
    touched.push(`  ${id.padEnd(15)} 已恢复为默认（启用）`);
  } else {
    if (current === false) {
      touched.push(`  ${id.padEnd(15)} 已是关闭状态`);
      continue;
    }
    values[key] = false;
    touched.push(`  ${id.padEnd(15)} 置为关闭`);
  }
}

console.log(touched.join("\n"));
console.log();

if (dryRun) {
  console.log("（演练模式，未写入任何文件）");
  console.log(`\n将写入 ${Object.keys(values).length} 条记录。`);
  process.exit(0);
}

// ── 写回：与 serde_json::to_string_pretty 一致（2 空格缩进）──
const ordered = {};
for (const key of Object.keys(values).sort()) ordered[key] = values[key];

try {
  mkdirSync(capDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ values: ordered }, null, 2) + "\n", "utf8");
} catch (error) {
  console.error(`写入失败：${error.message}`);
  process.exit(1);
}

console.log(`已写入 ${Object.keys(ordered).length} 条记录。`);
console.log();
console.log("接下来：");
console.log("  1. 新开一个会话（或重启应用）才会重新计算委派目录");
console.log("  2. 到「设置 → 子智能体」确认这 5 个已显示为关闭");
console.log("  3. 想临时启用某一个，直接在界面上打开即可——那是显式启用，会删掉这里的记录");
console.log();
console.log("恢复：node scripts/xyb-disable-engineering-subagents.mjs --enable");
