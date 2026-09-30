#!/usr/bin/env node
/**
 * 发布前验收：用「真实网络」的模拟 pi 跑插件工具。
 *
 * 与 scripts/xyb-check-plugin-contract.mjs 的区别：那个用假 fetch 只验参数形状，
 * 这个真打数据源，用来回答「发布后患者按下去会发生什么」。
 *
 * 用法：
 *   node plugin-probe.mjs <插件目录> <工具名> '<JSON 参数>'
 *
 * 例：
 *   node plugin-probe.mjs apps/desktop/resources/plugins/xyb.trials xyb_trials_search '{"terms":"B7-H3"}'
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const [dirArg, toolName, argsJson] = process.argv.slice(2);
if (!dirArg || !toolName) {
  console.error("用法: node plugin-probe.mjs <插件目录> <工具名> '<JSON 参数>'");
  process.exit(2);
}
const dir = resolve(dirArg);
const input = argsJson ? JSON.parse(argsJson) : {};

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const domains = (manifest.net && manifest.net.domains) || [];
const allowed = (host) => domains.some((d) => host === d || host.endsWith("." + d));

const registered = { commands: [], tools: [] };
const events = [];

// 可选：PROBE_VAULT 指向一个真实目录，用来测 xyb.records 这类要读写资料库的插件。
// 所有路径限定在该目录内，越界即抛——与宿主「插件只能在自己授权的目录里动作」一致。
const VAULT = process.env.PROBE_VAULT ? resolve(process.env.PROBE_VAULT) : "";
const inVault = (p) => {
  const full = resolve(VAULT, p || "");
  if (!VAULT || (full !== VAULT && !full.startsWith(VAULT + "/"))) {
    throw new Error(`probe: 路径越出资料库：${p}`);
  }
  return full;
};

globalThis.pi = {
  plugin: {
    getSettings: async () => (VAULT ? { vaultDir: VAULT } : {}),
    setSettings: async () => {},
    getDataPath: async () => join(dir, "..", "..", "..", "..", "..", ".probe-data"),
  },
  commands: {
    register: async (c) => registered.commands.push(c),
    unregister: async () => {},
  },
  agent: {
    registerTool: async (t) => registered.tools.push(t),
    unregisterTool: async () => {},
  },
  ui: {
    showToast: async (m, level) => events.push({ type: "toast", message: String(m), level }),
  },
  log: {
    info: async (m) => events.push({ type: "log", message: String(m) }),
    warn: async (m) => events.push({ type: "warn", message: String(m) }),
    error: async (m) => events.push({ type: "error", message: String(m) }),
  },
  fs: {
    list: async (p) => {
      if (!VAULT) throw new Error("probe: 未设置 PROBE_VAULT，无法列目录");
      const entries = await readdir(inVault(p), { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        path: [p, e.name].filter(Boolean).join("/"),
        isDirectory: e.isDirectory(),
      }));
    },
    read: async (p) => readFileSync(inVault(p), "utf8"),
    writeText: async (name, content) => {
      const full = inVault(name);
      await mkdir(resolve(full, ".."), { recursive: true });
      await writeFile(full, content, "utf8");
      return { path: name };
    },
    write: async (name, content) => {
      await writeFile(inVault(name), content, "utf8");
      return { path: name };
    },
    exists: async (p) => {
      try {
        await readdir(inVault(resolve(p, "..")));
        return true;
      } catch {
        return false;
      }
    },
    requestDirectory: async () => VAULT,
  },
  // 关键：真实网络。域名白名单按 manifest 的 net.domains 做 fail-closed 校验，
  // 与宿主行为一致——越界域名抛错，而不是静默放行。
  net: {
    fetch: async ({ url, method = "GET", headers, body, timeoutMs } = {}) => {
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        throw new Error(`probe: only http(s) URLs allowed (got ${typeof url})`);
      }
      const u = new URL(url);
      if (!allowed(u.hostname)) {
        throw new Error(`probe: domain not in net.domains allowlist: ${u.hostname}`);
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs || 30000);
      const started = Date.now();
      try {
        const res = await fetch(url, { method, headers, body, signal: ac.signal });
        const text = await res.text();
        events.push({ type: "http", url, status: res.status, ms: Date.now() - started });
        return {
          ok: res.ok,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          text: async () => text,
          json: async () => JSON.parse(text),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  },
};

delete require.cache[require.resolve(join(dir, "main.js"))];
const mod = require(join(dir, "main.js"));
await mod.onLoad();

const tool = registered.tools.find((t) => t.name === toolName);
const command = registered.commands.find((c) => c.id === toolName);
if (!tool && !command) {
  console.error(
    JSON.stringify({
      error: `未找到工具或命令 ${toolName}`,
      tools: registered.tools.map((t) => t.name),
      commands: registered.commands.map((c) => c.id),
    }),
  );
  process.exit(1);
}

const t0 = Date.now();
let out, err;
try {
  out = tool ? await tool.execute(input) : await command.run(input);
} catch (e) {
  err = { message: e.message, code: e.code };
}
console.log(JSON.stringify({ plugin: manifest.id, target: toolName, input, ms: Date.now() - t0, error: err, result: out, events }, null, 2));
process.exit(0);
