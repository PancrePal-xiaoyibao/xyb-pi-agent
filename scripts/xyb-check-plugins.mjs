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
 *   6. 模块格式：插件目录必须有 package.json {"type":"commonjs"}
 *   7. MCP 服务：id/transport/command/url/env/headers 规则，以及
 *      远端 MCP 域名必须列入 net.domains、stdio/http 与 mcp.server.local/remote 权限互相匹配
 *   8. 虚假声明：settings 里声明了却没有任何文件引用的键
 *
 * 用法：
 *   node scripts/xyb-check-plugins.mjs                       # 检查全部 xyb.* 插件
 *   node scripts/xyb-check-plugins.mjs apps/desktop/resources/plugins/xyb.trials
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { basename, join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(REPO, "apps", "desktop", "resources", "plugins");

// docs/plugin-development.md §7 权限表 + 宿主 plugin-runtime.ts 中已实现的
// 模型/补全权限（models.list 中风险、agent.complete 高风险）。
const VALID_PERMISSIONS = new Set([
  // 低
  "ui.panel", "ui.view", "ui.theme", "notify",
  // 中
  "clipboard.read", "clipboard.write", "fs.read", "shell.openExternal",
  "background.service", "bus.publish", "bus.subscribe",
  "audio.playback.background", "keyboard.globalShortcut", "models.list",
  // 高
  "fs.write", "fs.delete", "agent.tool.register", "agent.prompt.inject",
  "net.fetch", "mcp.server.local", "mcp.server.remote",
  "audio.capture.background", "net.websocket", "agent.complete",
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
  const dirName = basename(dir);
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

  // ── MCP 服务（docs/plugin-development.md §6.9）──
  // 规则与 packages/plugin-sdk/src/mcp-config.ts 的 validateMcpServer 对齐。
  const MCP_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
  const MCP_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const MCP_HEADER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
  const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
  const servers = (m.contributes && m.contributes.mcpServers) || [];
  const seenIds = new Set();
  let hasStdio = false;
  let hasHttp = false;

  const checkRefs = (record, keyRe, label) => {
    if (record === undefined) return;
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      errors.push(`${label} 必须是对象`);
      return;
    }
    for (const [k, v] of Object.entries(record)) {
      if (!keyRe.test(k)) errors.push(`${label} 的键名 "${k}" 不合法`);
      const okValue =
        typeof v === "string" ||
        (v && typeof v === "object" && typeof v.setting === "string" && v.setting.length > 0);
      if (!okValue) errors.push(`${label}.${k} 必须是字符串或 { setting: "<key>" }`);
    }
  };

  for (const s of servers) {
    if (!s || typeof s !== "object") {
      errors.push("mcpServers 条目必须是对象");
      continue;
    }
    const sid = s.id;
    if (typeof sid !== "string" || !MCP_ID.test(sid)) {
      errors.push(`mcpServer id "${sid}" 不合法（需匹配 [a-zA-Z][a-zA-Z0-9_-]{0,63}）`);
      continue;
    }
    if (seenIds.has(sid)) errors.push(`mcpServer id "${sid}" 重复`);
    seenIds.add(sid);

    if (s.transport !== "stdio" && s.transport !== "http") {
      errors.push(`mcpServer "${sid}" 的 transport 必须是 "stdio" 或 "http"`);
      continue;
    }

    if (s.transport === "stdio") {
      hasStdio = true;
      if (s.url !== undefined || s.headers !== undefined) {
        errors.push(`mcpServer "${sid}" 是 stdio，不得设置 url / headers`);
      }
      if (typeof s.command !== "string" || !s.command.trim()) {
        errors.push(`mcpServer "${sid}" 缺少 command`);
      } else {
        const cmd = s.command.trim();
        // 绝对路径会被宿主拒绝 —— 这是最容易静默失效的一类
        if (/^[a-zA-Z]:[\\/]/.test(cmd) || cmd.startsWith("/") || cmd.startsWith("\\")) {
          errors.push(`mcpServer "${sid}" 的 command 不能是绝对路径（宿主只接受 PATH 裸命令或插件内相对可执行文件）`);
        } else if (cmd.split(/[\\/]/).includes("..")) {
          errors.push(`mcpServer "${sid}" 的 command 不能包含 ".."`);
        } else if (!/[\\/]/.test(cmd) && !BARE_COMMAND.test(cmd)) {
          errors.push(`mcpServer "${sid}" 的 command "${cmd}" 不是合法的可执行文件名`);
        } else if (/[\\/]/.test(cmd) && !existsSync(join(dir, cmd))) {
          // 插件内相对可执行文件必须真实存在，否则启动即失败
          errors.push(`mcpServer "${sid}" 声明了插件内命令 ${cmd}，但该文件不存在`);
        } else if (/[\\/]/.test(cmd) && process.platform !== "win32") {
          // 宿主是直接 exec 这个文件的。缺执行位会在拉起时 EACCES，
          // 表现是「插件看着启用了，工具一个都没有」——最难定位的一类。
          try {
            if ((statSync(join(dir, cmd)).mode & 0o111) === 0) {
              errors.push(
                `mcpServer "${sid}" 的插件内命令 ${cmd} 没有执行位，宿主拉起时会失败（chmod +x）`,
              );
            }
          } catch {
            // 存在性上面已判定，这里读不到就当不存在处理
          }
        }
      }
      if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) {
        errors.push(`mcpServer "${sid}" 的 args 必须是字符串数组`);
      }
      checkRefs(s.env, MCP_ENV_KEY, `mcpServer "${sid}" env`);
    } else {
      hasHttp = true;
      if (s.command !== undefined || s.args !== undefined || s.env !== undefined) {
        errors.push(`mcpServer "${sid}" 是 http，不得设置 command / args / env`);
      }
      let host = null;
      if (typeof s.url !== "string" || !s.url.trim()) {
        errors.push(`mcpServer "${sid}" 缺少 url`);
      } else {
        try {
          const u = new URL(s.url);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            errors.push(`mcpServer "${sid}" 的 url 必须是 http/https`);
          } else {
            host = u.hostname;
            if (u.protocol === "http:" && !/^(localhost|127\.|\[?::1\]?)/.test(host)) {
              warnings.push(`mcpServer "${sid}" 使用非回环 http，请求不加密`);
            }
          }
        } catch {
          errors.push(`mcpServer "${sid}" 的 url 不是合法绝对地址`);
        }
      }
      // 远端 MCP 端点同样受 net.domains 约束，漏配会静默连不上
      if (host) {
        const domains = (m.net && m.net.domains) || [];
        const allowed = domains.some((d) => host === d || host.endsWith("." + d));
        if (!allowed) {
          errors.push(`mcpServer "${sid}" 的域名 ${host} 未列入 manifest.net.domains（远端 MCP 也受出网白名单约束）`);
        }
      }
      checkRefs(s.headers, MCP_HEADER_KEY, `mcpServer "${sid}" headers`);
    }
  }

  // 权限与 MCP 声明要互相匹配：两侧任一为空都是「声明了却不生效」
  const perms = m.permissions || [];
  if (hasStdio && !perms.includes("mcp.server.local")) {
    errors.push("声明了 stdio 型 mcpServer，但 permissions 缺少 mcp.server.local");
  }
  if (hasHttp && !perms.includes("mcp.server.remote")) {
    errors.push("声明了 http 型 mcpServer，但 permissions 缺少 mcp.server.remote");
  }
  if (perms.includes("mcp.server.local") && !hasStdio) {
    warnings.push("声明了 mcp.server.local 但没有 stdio 型 mcpServer");
  }
  if (perms.includes("mcp.server.remote") && !hasHttp) {
    warnings.push("声明了 mcp.server.remote 但没有 http 型 mcpServer");
  }

  // ── 虚假声明：settings 声明了却没有代码引用 ──
  // 这类问题患者侧表现为「开关拨了没反应」，且不会有任何报错。
  const settings = (m.contributes && m.contributes.settings) || [];
  if (settings.length) {
    let corpus = "";
    const collect = (p) => {
      try {
        corpus += readFileSync(p, "utf8");
      } catch {
        /* 读不到就跳过 */
      }
    };
    for (const f of need) collect(join(dir, f));
    for (const sub of ["main.js", "index.js", "plugin.js"]) collect(join(dir, sub));
    const walk = (d) => {
      let entries = [];
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
        } else if (/\.(js|mjs|cjs|html|md)$/.test(e.name)) {
          collect(p);
        }
      }
    };
    walk(dir);
    for (const s of settings) {
      if (!s || typeof s.key !== "string") {
        warnings.push("settings 条目缺少 key");
        continue;
      }
      if (!corpus.includes(s.key)) {
        warnings.push(`setting "${s.key}" 声明了但没有任何文件引用它（患者拨了这个开关不会有任何反应）`);
      }
    }
  }

  return { dir, id: m.id, errors, warnings };
}

// 路径一律用 node:path 拆：Windows 上 join/resolve 给的是反斜杠，按 "/" 切
// 拿到的是整条路径，于是一个插件都筛不出来，门禁以 0 退出——空跑却显示通过。
function isXybPlugin(path) {
  return basename(path).startsWith("xyb.");
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
  const rel = relative(REPO, dir);
  const r = checkPlugin(dir);
  const name = r.id || basename(dir);
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