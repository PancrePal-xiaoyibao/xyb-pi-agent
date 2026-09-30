#!/usr/bin/env node
/**
 * 插件 API 面门禁。
 *
 * 为什么需要它
 * ------------
 * 插件的 main.js 是**纯 CommonJS 资源，不参与 TypeScript 类型检查**：
 * 它们不在任何 tsconfig 的 include 里。所以上游一旦重命名或删除插件 API
 * （例如把 `pi.fs.requestDirectory` 改名），
 *
 *   · pnpm build:js / typecheck —— 全绿（根本没检查这些文件）
 *   · pnpm test —— 全绿（没有插件的运行时测试）
 *   · 应用的其它功能 —— 正常
 *
 * 结果就是：**编译和测试都说没事，患者点下去才报错**。这类静默失效必须靠门禁挡。
 *
 * 做法
 * ----
 *   1. 从我们插件的 main.js 里抽出实际调用的 `pi.<命名空间>.<方法>`。
 *   2. 逐个在 `packages/plugin-sdk/src/**` 里找声明。找不到 → 失败（上游改了 API）。
 *   3. 顺带检查视图里的 `bridge.invoke("<通道>")`：非本 fork 命名空间（xyb.*）的通道
 *      必须在插件 SDK 或主进程源码里出现过，否则给出告警（不失败，避免误报）。
 *
 * 用法：
 *   node scripts/xyb-check-plugin-api.mjs
 *   node scripts/xyb-check-plugin-api.mjs --verbose
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(ROOT, "apps", "desktop", "resources", "plugins");
const SDK_SRC = join(ROOT, "packages", "plugin-sdk", "src");
const MAIN_SRC = join(ROOT, "apps", "desktop", "electron");

/** 本 fork 自己的命名空间，视图通道不受 SDK 约束 */
const OWN_CHANNEL_PREFIX = "xyb.";

function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...walk(p, filter));
    } else if (filter(name)) {
      out.push(p);
    }
  }
  return out;
}

function readAll(files) {
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

function ourPluginDirs() {
  if (!statSync(PLUGINS_DIR, { throwIfNoEntry: false })) return [];
  return readdirSync(PLUGINS_DIR)
    .filter((n) => n.startsWith("xyb."))
    .map((n) => join(PLUGINS_DIR, n))
    .filter((p) => statSync(p).isDirectory());
}

function main() {
  const verbose = process.argv.includes("--verbose");
  const errors = [];
  const warnings = [];

  const sdkFiles = walk(SDK_SRC, (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
  if (!sdkFiles.length) {
    console.error(`error: 找不到插件 SDK 源码：${SDK_SRC}`);
    process.exit(2);
  }
  const sdkText = readAll(sdkFiles);
  const harnessText = readAll(walk(MAIN_SRC, (n) => n.endsWith(".ts")));

  const plugins = ourPluginDirs();
  if (!plugins.length) {
    console.error(`error: 在 ${PLUGINS_DIR} 找不到 xyb.* 插件`);
    process.exit(2);
  }

  const allApiCalls = new Map(); // api -> Set(plugin)
  const allChannels = new Map(); // channel -> Set(plugin)

  for (const dir of plugins) {
    const plugin = dir.split("/").pop();
    const mains = walk(dir, (n) => n === "main.js");
    const views = walk(dir, (n) => n.endsWith(".html"));

    for (const file of [...mains, ...views]) {
      const text = readFileSync(file, "utf8");

      for (const m of text.matchAll(/\bpi\.([a-zA-Z]+)\.([a-zA-Z]+)\b/g)) {
        const api = `pi.${m[1]}.${m[2]}`;
        if (!allApiCalls.has(api)) allApiCalls.set(api, new Set());
        allApiCalls.get(api).add(plugin);
      }

      for (const m of text.matchAll(/bridge\.invoke\(\s*["']([^"']+)["']/g)) {
        const ch = m[1];
        if (ch.startsWith(OWN_CHANNEL_PREFIX)) continue;
        if (!allChannels.has(ch)) allChannels.set(ch, new Set());
        allChannels.get(ch).add(plugin);
      }
    }
  }

  // ── 1. pi.* API 是否仍被 SDK 声明 ──
  for (const [api, usedBy] of [...allApiCalls].sort()) {
    const method = api.split(".").pop();
    // 允许 `method(` / `method:` / `method?:` / `method<` 等声明形式
    const re = new RegExp(`(^|[^\\w$])${method}\\s*[?:(<]`, "m");
    if (!re.test(sdkText)) {
      errors.push(`${api} —— 插件 SDK 里已找不到该方法（用于：${[...usedBy].join(", ")}）`);
    } else if (verbose) {
      console.log(`  ok   ${api}`);
    }
  }

  // ── 2. 视图里的宿主通道（告警级）──
  for (const [ch, usedBy] of [...allChannels].sort()) {
    const bare = ch.split(".").pop();
    const re = new RegExp(`["'\`]${ch.replace(/\./g, "\\.")}["'\`]`);
    if (!re.test(sdkText)) {
      const loose = new RegExp(`(^|[^\\w$])${bare}\\s*[?:(<]`, "m");
      if (!loose.test(sdkText) && !harnessText.includes(ch)) {
        warnings.push(
          `${ch} —— 插件 SDK 与主进程源码里都未见该通道（用于：${[...usedBy].join(", ")}）`,
        );
      }
    }
  }

  console.log(`检查插件：${plugins.length} 个`);
  console.log(`pi.* API 调用：${allApiCalls.size} 种`);
  console.log(`视图宿主通道：${allChannels.size} 种`);

  if (warnings.length) {
    console.log("\n告警（不阻塞，但请确认上游是否改了通道名）：");
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  if (errors.length) {
    console.log("\n✗ 插件 API 面已被上游改动，插件会在运行时失败：");
    for (const e of errors) console.log(`    ${e}`);
    console.log(
      "\n处理：对照 packages/plugin-sdk/ 的新 API 改插件，或在文档里记录该破坏性变更。",
    );
    process.exit(1);
  }

  console.log(
    `\n✓ 插件 API 面完好（${allApiCalls.size} 个 API 全部仍在插件 SDK 中声明）`,
  );
}

main();
