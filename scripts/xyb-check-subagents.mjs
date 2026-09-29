#!/usr/bin/env node
/**
 * 小胰宝 MDT 子智能体定义校验
 *
 * 用 PI-Desktop **官方解析器**（packages/shared 的 parseSubagentDefinition）校验
 * subagents/*.md，而不是自己重写一遍规则——规则一改，自写校验就会悄悄说谎。
 *
 * 额外加一条项目自己的护栏：**这些定义不得申请写或执行类工具**。
 * 医学视角的委派者只需要读资料，永远不该能改文件或跑命令。
 *
 * 前置：先 `pnpm build:js`（需要 packages/shared/dist）。
 *
 * 用法：
 *   node scripts/xyb-check-subagents.mjs
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFINITIONS_DIR = join(REPO, "subagents");
const SHARED_DIST = join(REPO, "packages", "shared", "dist", "subagent-definition.js");

/** 允许给医学视角子智能体的工具。只读，且不包含 BrowserPreview。 */
const ALLOWED_TOOLS = new Set(["Read", "Glob", "Grep"]);
/** 一旦出现就报错：能改动文件或执行命令。 */
const FORBIDDEN_TOOLS = new Set(["Bash", "Edit", "Write", "BrowserPreview", "*"]);

if (!existsSync(SHARED_DIST)) {
  console.error(
    `找不到官方解析器：${SHARED_DIST}\n先跑 pnpm build:js 生成 packages/shared/dist。`,
  );
  process.exit(2);
}

let shared;
try {
  shared = await import(pathToFileURL(SHARED_DIST).href);
} catch (error) {
  console.error(`加载官方解析器失败：${error.message}`);
  process.exit(2);
}

const { parseSubagentDefinition, MAX_SUBAGENT_DEFINITIONS, BUILTIN_COUNT } = shared;
if (typeof parseSubagentDefinition !== "function") {
  console.error("官方解析器未导出 parseSubagentDefinition，接口可能已变更。");
  process.exit(2);
}

if (!existsSync(DEFINITIONS_DIR)) {
  console.error(`找不到定义目录：${DEFINITIONS_DIR}`);
  process.exit(2);
}

const files = readdirSync(DEFINITIONS_DIR)
  .filter((name) => /\.md$/i.test(name) && name.startsWith("mdt-"))
  .sort();

if (!files.length) {
  console.error("subagents/ 下没有 mdt-*.md");
  process.exit(2);
}

let failed = 0;
const names = new Set();

for (const file of files) {
  const path = join(DEFINITIONS_DIR, file);
  const raw = readFileSync(path, "utf8");
  const result = parseSubagentDefinition(raw, {
    source: "user",
    fallbackName: file.replace(/\.md$/i, ""),
    filePath: path,
  });

  const errors = [];
  const warnings = [];

  if (!result.ok) {
    errors.push(...result.errors);
  } else {
    const def = result.definition;
    if (names.has(def.name)) errors.push(`名称重复：${def.name}`);
    names.add(def.name);

    // 文件名应与 name 一致，否则设置页显示与文件名对不上
    const expected = file.replace(/\.md$/i, "");
    if (def.name !== expected) {
      warnings.push(`name "${def.name}" 与文件名 "${expected}" 不一致`);
    }

    // 护栏：工具授权
    for (const tool of def.tools) {
      if (FORBIDDEN_TOOLS.has(tool)) {
        errors.push(`申请了禁止的工具 "${tool}"（医学视角不得写文件或执行命令）`);
      } else if (!ALLOWED_TOOLS.has(tool)) {
        warnings.push(`工具 "${tool}" 不在推荐集内（推荐 ${[...ALLOWED_TOOLS].join(" / ")}）`);
      }
    }
    if (!def.tools.length) errors.push("没有可用工具（解析后为空）");

    // 护栏：不应固定模型（固定了但 provider 不存在会直接报错，不回退）
    if (def.model) {
      warnings.push(
        `固定了模型 ${def.model.providerId}/${def.model.modelId}；若该 provider 未配置，委派会报错而不是回退`,
      );
    }
  }
  warnings.push(...(result.warnings ?? []));

  if (errors.length) {
    failed++;
    console.log(`\n✗ ${file}`);
    for (const e of errors) console.log(`    错误: ${e}`);
  } else {
    const def = result.definition;
    console.log(`\n✓ ${file}`);
    console.log(`    name=${def.name}  tools=[${def.tools.join(", ")}]`);
  }
  for (const w of warnings) console.log(`    提示: ${w}`);
}

// 目录上限：内置 + 本套不能超过 MAX_SUBAGENT_DEFINITIONS
const total = files.length + (typeof BUILTIN_COUNT === "number" ? BUILTIN_COUNT : 5);
if (typeof MAX_SUBAGENT_DEFINITIONS === "number" && total > MAX_SUBAGENT_DEFINITIONS) {
  console.log(
    `\n✗ 目录上限：本套 ${files.length} + 内置 5 = ${total}，超过 MAX_SUBAGENT_DEFINITIONS=${MAX_SUBAGENT_DEFINITIONS}`,
  );
  failed++;
} else {
  console.log(
    `\n本套 ${files.length} 个 + 内置 5 个 = ${total} 个` +
      (typeof MAX_SUBAGENT_DEFINITIONS === "number"
        ? `，上限 ${MAX_SUBAGENT_DEFINITIONS}（未超）`
        : ""),
  );
}

console.log(`\n结果：${files.length - failed}/${files.length} 通过`);
process.exit(failed ? 1 : 0);
