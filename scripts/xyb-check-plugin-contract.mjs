#!/usr/bin/env node
/**
 * 插件契约测试：用「与宿主同等严格」的模拟 `pi` 跑一遍插件。
 *
 * 为什么要有它
 * ------------
 * `xyb-check-plugin-api.mjs` 只能证明「用到的 API 名字还在」，**证明不了调用形状对**。
 * 2026-09-30 实测就吃过这个亏：
 *
 *   · `pi.net.fetch(url, { method })` —— 真实签名是 `fetch({ url, method })`，
 *     input.url 因此是 undefined，宿主抛 "only http(s) URLs allowed"；
 *   · `pi.ui.showToast({ message })` —— 真实签名是 `showToast(message: string, level?)`，
 *     界面显示 "[object Object]"；
 *   · `pi.fs.list(dir, { recursive: true })` —— `list` 每次只列一层、不接受递归参数，
 *     于是只扫到第一层。
 *
 * 三种都「编译通过、类型不报错」（插件是纯 JS，不参与类型检查），只有真跑才暴露。
 * 所以这里按 `packages/plugin-sdk/src/index.ts` 的声明重建一个会**挑错**的 `pi`：
 * 参数形状不对就抛，模拟真实宿主的失败方式。
 *
 * 用法：
 *   node scripts/xyb-check-plugin-contract.mjs            # 离线：只跑不联网的部分
 *   node scripts/xyb-check-plugin-contract.mjs --online   # 联网：实际打一次数据源
 */

import { createRequire } from "node:module";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(ROOT, "apps", "desktop", "resources", "plugins");
const ONLINE = process.argv.includes("--online");

const failures = [];
const notes = [];

function fail(plugin, msg) {
  failures.push(`${plugin}: ${msg}`);
}
function note(plugin, msg) {
  notes.push(`${plugin}: ${msg}`);
}

/** 读取插件的 net.domains 白名单，模拟宿主的出口校验。 */
function domainsOf(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    return ((m.net && m.net.domains) || []).map((d) => String(d).replace(/^\*\./, ""));
  } catch {
    return [];
  }
}

function hostAllowed(url, domains) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith("." + d));
}

/**
 * 造一个「会挑错」的 pi 对象。签名一律以 packages/plugin-sdk/src/index.ts 为准。
 */
function makePi(plugin, dir, log) {
  const domains = domainsOf(dir);
  return {
    plugin: {
      getSettings: async () => ({}),
      // 签名：setSettings(partial: Record<string, unknown>)
      setSettings: async (partial) => {
        if (partial === null || typeof partial !== "object") {
          fail(plugin, "plugin.setSettings 需要一个对象参数");
        }
      },
      getDataPath: async () => dir,
    },
    commands: {
      // 签名：register(command: PluginCommand)，必须有 id / title / run
      register: async (command) => {
        if (!command || typeof command !== "object") {
          fail(plugin, "commands.register 需要一个对象参数");
          return;
        }
        for (const k of ["id", "title"]) {
          if (typeof command[k] !== "string") fail(plugin, `commands.register 缺少字符串字段 ${k}`);
        }
        if (typeof command.run !== "function") fail(plugin, "commands.register 缺少 run()");
        log.commands.push(command);
      },
      unregister: async (id) => {
        if (typeof id !== "string") fail(plugin, "commands.unregister 需要字符串 id");
      },
    },
    agent: {
      // 签名：registerTool(tool: PluginTool) -> { name, description, execute, risk?, schema? }
      registerTool: async (tool) => {
        if (!tool || typeof tool !== "object") {
          fail(plugin, "agent.registerTool 需要一个对象参数");
          return;
        }
        for (const k of ["name", "description"]) {
          if (typeof tool[k] !== "string") fail(plugin, `agent.registerTool 缺少字符串字段 ${k}`);
        }
        if (typeof tool.execute !== "function") fail(plugin, "agent.registerTool 缺少 execute()");
        log.tools.push(tool);
      },
      unregisterTool: async (name) => {
        if (typeof name !== "string") fail(plugin, "agent.unregisterTool 需要字符串 name");
      },
      // 签名：complete({ modelKey, system?, messages?, thinkingLevel?, includeSessionContext? })
      // 真实宿主约束（apps/desktop/electron/main/plugin-runtime.ts:4071-4155）：
      //   modelKey 必须是 "providerId/modelId"；system ≤32KiB；messages ≤200k 字符；
      //   需要 agent.complete 权限且每窗口最多 8 次。
      complete: async (input) => {
        if (!input || typeof input !== "object") {
          fail(plugin, "agent.complete 需要一个对象参数");
          return { text: "" };
        }
        if (typeof input.modelKey !== "string" || !input.modelKey.includes("/")) {
          fail(
            plugin,
            `agent.complete 的 modelKey 必须是 "providerId/modelId"，收到：${String(input.modelKey)}`,
          );
        }
        if (input.system !== undefined && typeof input.system !== "string") {
          fail(plugin, "agent.complete 的 system 必须是字符串");
        }
        if (input.messages !== undefined) {
          if (!Array.isArray(input.messages)) {
            fail(plugin, "agent.complete 的 messages 必须是数组");
          } else {
            for (const m of input.messages) {
              if (!m || typeof m.content !== "string" || !["user", "assistant"].includes(m.role)) {
                fail(plugin, "agent.complete 的 messages 元素必须是 { role: user|assistant, content: string }");
              }
            }
          }
        }
        log.completes.push(input);
        if (!ONLINE) return { text: "" };
        // 离线时返回空文本，让调用方的「模型返回空内容」分支被真实走到。
        return { text: "" };
      },
    },
    models: {
      // 签名：list() -> PluginModelInfo[]
      list: async () => [],
    },
    ui: {
      // 签名：showToast(message: string, level?: "info"|"warn"|"error")
      showToast: async (message, level) => {
        if (typeof message !== "string") {
          fail(
            plugin,
            `ui.showToast 第一个参数必须是字符串，收到 ${message === null ? "null" : typeof message}` +
              (typeof message === "object" ? "（常见错误：传了 { message } 对象）" : ""),
          );
        }
        if (level !== undefined && !["info", "warn", "error"].includes(level)) {
          fail(plugin, `ui.showToast 的 level 取值非法：${level}`);
        }
      },
    },
    fs: {
      // 签名：list(pathFromRoot) —— 只列一层，不接受递归参数
      list: async (pathFromRoot, ...rest) => {
        if (typeof pathFromRoot !== "string") {
          fail(plugin, "fs.list 的第一个参数必须是字符串路径");
        }
        if (rest.length > 0) {
          fail(
            plugin,
            "fs.list 只接受一个参数（每次只列一层）；多余的参数会被静默忽略，" +
              "传 { recursive: true } 之类不会递归",
          );
        }
        return [];
      },
      writeText: async (pathFromRoot, content) => {
        if (typeof pathFromRoot !== "string" || typeof content !== "string") {
          fail(plugin, "fs.writeText(pathFromRoot, content) 两个参数都必须是字符串");
        }
      },
      // 签名：requestDirectory() —— 无参数
      requestDirectory: async (...args) => {
        if (args.length > 0) {
          fail(plugin, "fs.requestDirectory 不接受参数（选中目录即成为 root）");
        }
        return null;
      },
      glob: async (pattern) => {
        if (typeof pattern !== "string") fail(plugin, "fs.glob 需要一个字符串模式");
        return [];
      },
    },
    net: {
      // 签名：fetch({ url, method?, headers?, body?, timeoutMs? })
      fetch: async (input) => {
        if (!input || typeof input !== "object") {
          fail(
            plugin,
            `net.fetch 只接受一个对象参数 { url, ... }，收到 ${typeof input}` +
              (typeof input === "string" ? "（常见错误：写成了 fetch(url, options)）" : ""),
          );
          return { ok: false, status: 0, json: async () => ({}) };
        }
        if (typeof input.url !== "string" || !/^https?:\/\//i.test(input.url)) {
          fail(plugin, `net.fetch 的 url 必须是 http(s) 字符串，收到：${String(input.url)}`);
          return { ok: false, status: 0, json: async () => ({}) };
        }
        if (!hostAllowed(input.url, domains)) {
          note(plugin, `net.fetch 目标不在 manifest.net.domains 内（宿主会拒绝）：${input.url}`);
        }
        if (!ONLINE) return { ok: false, status: 0, json: async () => ({}) };
        const res = await fetch(input.url, {
          method: input.method || "GET",
          headers: input.headers,
        });
        const body = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          headers: res.headers,
          json: async () => JSON.parse(body),
          text: async () => body,
        };
      },
    },
    browser: {},
    workspace: { get: async () => null },
  };
}

function pluginDirs() {
  return readdirSync(PLUGINS_DIR)
    .filter((n) => n.startsWith("xyb."))
    .map((n) => join(PLUGINS_DIR, n))
    .filter((p) => statSync(p).isDirectory());
}

/**
 * 静态形状检查。
 *
 * 为什么不能只靠「跑一遍」：坏调用常常在命令处理函数或异常分支里，
 * 跑不到就发现不了（实测：把 showToast 写成对象后，动态检查仍然全绿）。
 * 所以对几个签名最容易写错的 API 直接查源码形状。
 */
const SHAPE_RULES = [
  {
    re: /pi\.net\.fetch\(\s*[`'"]/,
    msg: "net.fetch 的第一个参数写成了字符串；真实签名是 fetch({ url, method?, ... })",
  },
  {
    re: /pi\.ui\.showToast\(\s*\{/,
    msg: "showToast 的第一个参数必须是字符串；传对象会在界面显示 [object Object]",
  },
  {
    re: /pi\.fs\.requestDirectory\(\s*[^)\s]/,
    msg: "requestDirectory() 不接受参数；选中目录即成为 root",
  },
  {
    re: /pi\.fs\.list\([^);]*,[^);]*\)/,
    msg: "fs.list 只接受一个路径参数（每次只列一层）；第二个参数会被静默忽略，不会递归",
  },
];

function staticShapeLint(plugin, source) {
  for (const rule of SHAPE_RULES) {
    const m = rule.re.exec(source);
    if (m) {
      const line = source.slice(0, m.index).split("\n").length;
      fail(plugin, `main.js:${line} ${rule.msg}`);
    }
  }
}

async function run() {
  let checked = 0;

  for (const dir of pluginDirs()) {
    const plugin = dir.split("/").pop();
    const log = { commands: [], tools: [], completes: [] };
    const pi = makePi(plugin, dir, log);

    // 先做静态形状检查：坏调用常在异常分支或命令处理里，跑不到就发现不了
    staticShapeLint(plugin, readFileSync(join(dir, "main.js"), "utf8"));

    // 插件的 main.js 通过全局 `pi` 取宿主 API
    globalThis.pi = pi;

    delete require.cache[require.resolve(join(dir, "main.js"))];
    let mod;
    try {
      mod = require(join(dir, "main.js"));
    } catch (err) {
      fail(plugin, `main.js 加载失败：${err.message}`);
      continue;
    }

    if (typeof mod.onLoad !== "function") {
      fail(plugin, "未导出 onLoad()");
      continue;
    }

    try {
      await mod.onLoad();
    } catch (err) {
      fail(plugin, `onLoad() 抛错：${err.message}`);
      continue;
    }

    checked += 1;
    console.log(
      `  ${plugin.padEnd(20)} 命令 ${log.commands.length} 个，工具 ${log.tools.length} 个`,
    );

    // 跑一遍注册好的命令与工具，让参数形状问题暴露在动态路径上
    for (const command of log.commands) {
      try {
        await command.run();
      } catch (err) {
        // fs / 网络在这套 fake 下必然失败；这里只关心参数形状，已在 fake 里记为失败
        note(plugin, `命令 ${command.id} 执行时抛错（离线时正常）：${err.message}`);
      }
    }

    for (const tool of log.tools) {
      try {
        await tool.execute({ terms: "胰腺癌", condition: "pancreatic cancer" });
      } catch (err) {
        // 联网失败（离线、403）不算契约问题；参数形状问题已在 fake 里记为失败
        note(plugin, `工具 ${tool.name} 执行时抛错（离线时正常）：${err.message}`);
      }
    }

    if (typeof mod.onUnload === "function") {
      try {
        await mod.onUnload();
      } catch (err) {
        fail(plugin, `onUnload() 抛错：${err.message}`);
      }
    }
  }

  console.log();
  if (notes.length) {
    console.log("提示（不阻塞）：");
    for (const n of notes) console.log(`  ! ${n}`);
    console.log();
  }

  if (failures.length) {
    console.log("✗ 插件与宿主 API 的契约不符（在应用里会失败或显示错乱）：");
    for (const f of failures) console.log(`    ${f}`);
    console.log(
      "\n签名以 packages/plugin-sdk/src/index.ts 为准；" +
        "改完再跑一次：node scripts/xyb-check-plugin-contract.mjs",
    );
    process.exit(1);
  }

  console.log(`✓ ${checked} 个插件的契约测试通过${ONLINE ? "（含联网）" : "（离线）"}`);
}

run().catch((err) => {
  console.error("契约测试自身出错：", err);
  process.exit(2);
});
