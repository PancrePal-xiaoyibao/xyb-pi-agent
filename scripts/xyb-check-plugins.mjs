#!/usr/bin/env node
/**
 * 小胰宝插件清单校验（轻量本地版）
 *
 * 为什么需要它：官方 `pnpm pi-plugin check` 需要先 `pnpm install` 并构建 devkit。
 * 这个脚本零依赖、可立即运行，按 docs/plugin-development.md 的规则做前置体检，
 * 用来在填功能之前先确认骨架合法。
 *
 * 检查项：
 *   1. 必需字段：schemaVersion / id / name / version / main
 *   2. permissions 是否为文档中列出的合法权限名
 *   3. views[].icon 是否为宿主支持的固定 token
 *   4. 声明的入口文件是否真实存在（main / views.entry / skills）
 *   5. 目录名与 manifest.id 是否一致（内置插件按目录识别）
 *
 * 用法：
 *   node scripts/xyb-check-plugins.mjs                       # 检查全部 xyb.* 插件
 *   node scripts/xyb-check-plugins.mjs apps/desktop/resources/plugins/xyb.trials
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(REPO, "apps", "desktop", "resources", "plugins");

// docs/plugin-development.md §7 权限表
const VALID_PERMISSIONS = new Set([
  // 低
  "ui.panel", "ui.view", "ui.theme", "notify",
  // 中
  "clipboard.read", "clipboard.write", "fs.read", "shell.openExternal",
  "background.service", "bus.publish", "bus.subscribe",
  "audio.playback.background", "keyboard.globalShortcut",
  // 高
  "fs.write", "fs.delete", "agent.tool.register", "agent.prompt.inject",
  "net.fetch", "mcp.server.local", "mcp.server.remote",
  "audio.capture.background", "net.websocket",
]);

// docs/plugin-development.md §6.8 固定图标 token
const VALID_ICONS = new Set([
  "bell", "book", "bot", "branch", "browser", "chat", "clock", "diff", "files",
  "folder", "image", "key", "link", "list-checks", "palette", "plug",
  "pull-request", "search", "server", "shield", "sparkles", "target",
  "terminal", "workflow", "wrench",
]);

const REQUIRED = ["schemaVersion", "id", "name", "version", "main"];

function checkPlugin(dir) {
  const errors = [];
  const warnings = [];
  const manifestPath = join(dir, "manifest.json");

  if (!existsSync(manifestPath)) {
    return { dir, errors: ["缺少 manifest.json"], warnings };
  }

  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { dir, errors: [`manifest.json 不是合法 JSON: ${e.message}`], warnings };
  }

  for (const k of REQUIRED) {
    if (m[k] === undefined) errors.push(`缺少必需字段: ${k}`);
  }

  // 目录名 vs id
  const dirName = dir.split("/").pop();
  if (m.id && m.id !== dirName) {
    warnings.push(`目录名(${dirName}) 与 manifest.id(${m.id}) 不一致`);
  }

  // 权限合法性
  for (const p of m.permissions || []) {
    if (!VALID_PERMISSIONS.has(p)) errors.push(`未知权限: ${p}`);
  }

  // 视图图标
  for (const v of (m.contributes && m.contributes.views) || []) {
    if (v.icon && !VALID_ICONS.has(v.icon)) {
      errors.push(`视图 "${v.id}" 的 icon "${v.icon}" 不在宿主支持的 token 列表内`);
    }
    if (!v.entry) errors.push(`视图 "${v.id}" 缺少 entry`);
  }

  // 入口文件存在性
  const need = [];
  if (m.main) need.push(m.main);
  for (const v of (m.contributes && m.contributes.views) || []) if (v.entry) need.push(v.entry);
  for (const s of (m.contributes && m.contributes.skills) || []) need.push(s);
  if (m.ui && m.ui.panel) need.push(m.ui.panel);
  for (const f of need) {
    if (!existsSync(join(dir, f))) errors.push(`声明的文件不存在: ${f}`);
  }

  // 模块格式：上层 apps/desktop/package.json 声明了 "type": "module"，
  // 若插件目录没有自己的 package.json 覆盖为 commonjs，main.js 会被当 ESM 解析，
  // `module.exports` 静默失效 → 插件加载后无任何生命周期钩子，且不报明显错误。
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.type !== "commonjs") {
        warnings.push(`package.json 的 type 为 "${pkg.type}"，若入口用 module.exports 需设为 "commonjs"`);
      }
    } catch (e) {
      errors.push(`package.json 不是合法 JSON: ${e.message}`);
    }
  } else {
    errors.push('缺少 package.json（需写入 {"type":"commonjs"}，否则 main.js 被当 ESM 解析，module.exports 静默失效）');
  }

  // 高风险权限提示
  const high = ["fs.write", "fs.delete", "net.fetch", "agent.tool.register",
                "agent.prompt.inject", "mcp.server.local", "mcp.server.remote"];
  const used = (m.permissions || []).filter((p) => high.includes(p));
  if (used.length) warnings.push(`含高风险权限: ${used.join(", ")}`);

  // net.fetch 但没有 net.domains → 白名单为空，等于访问不到任何站点
  if ((m.permissions || []).includes("net.fetch")) {
    const domains = (m.net && m.net.domains) || [];
    if (!domains.length) errors.push("声明了 net.fetch 但没有 manifest.net.domains 白名单（会访问不到任何域名）");
  }

  return { dir, id: m.id, errors, warnings };
}

function isXybPlugin(path) {
  return path.split("/").pop().startsWith("xyb.");
}

function targets() {
  const arg = process.argv[2];
  if (arg) return [resolve(arg)];
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR)
    .map((n) => join(PLUGINS_DIR, n))
    .filter((p) => statSync(p).isDirectory() && isXybPlugin(p));
}

const list = targets();
if (!list.length) {
  console.log("没有找到待检查的插件目录。");
  process.exit(0);
}

let failed = 0;
for (const dir of list) {
  const rel = dir.replace(REPO + "/", "");
  const r = checkPlugin(dir);
  const name = r.id || dir.split("/").pop();
  if (r.errors.length) {
    failed++;
    console.log(`\n✗ ${name}  (${rel})`);
    for (const e of r.errors) console.log(`    错误: ${e}`);
  } else {
    console.log(`\n✓ ${name}  (${rel})`);
  }
  for (const w of r.warnings) console.log(`    提示: ${w}`);
}

console.log(`\n结果：${list.length - failed}/${list.length} 通过`);
process.exit(failed ? 1 : 0);