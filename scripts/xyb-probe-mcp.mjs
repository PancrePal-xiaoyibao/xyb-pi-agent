#!/usr/bin/env node
/**
 * 最小 MCP stdio 客户端：给「发布前验收」用来直接打数据源。
 *
 * 用法：
 *   node mcp-probe.mjs <label> <command> [args...] -- <json-rpc 请求，可多个，每行一个>
 *
 * 例：
 *   node mcp-probe.mjs chictr npx -y chictr-mcp-server@3.0.2 -- \
 *     '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
 *
 * 行为：启动服务 → initialize → 依次发送请求 → 打印结果 → 退出。
 * 超时默认 120 秒（抓取类工具慢）。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 2) {
  console.error("用法: node mcp-probe.mjs <label> <command> [args...] -- <request>...");
  process.exit(2);
}
const label = argv[0];
const command = argv[1];
const cmdArgs = argv.slice(2, sep);
const requests = argv.slice(sep + 1);
const timeoutMs = Number(process.env.MCP_PROBE_TIMEOUT_MS || 120000);

const child = spawn(command, cmdArgs, { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let nextId = 1000;
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

createInterface({ input: child.stdout }).on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  const id = msg.id;
  if (id != null && pending.has(id)) {
    pending.get(id)(msg);
    pending.delete(id);
  }
});

let stderr = "";
child.stderr.on("data", (c) => {
  stderr += c.toString("utf8");
});

const timer = setTimeout(() => {
  console.log(JSON.stringify({ probe: label, timeout: true, stderr: stderr.slice(-800) }));
  child.kill("SIGKILL");
  process.exit(0);
}, timeoutMs);

const started = Date.now();
const init = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "xyb-release-probe", version: "1.0.0" },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });

console.log(
  JSON.stringify({
    probe: label,
    connected: Boolean(init?.result),
    serverInfo: init?.result?.serverInfo ?? null,
    connectMs: Date.now() - started,
  }),
);

for (const raw of requests) {
  const req = JSON.parse(raw);
  const t0 = Date.now();
  const res = await call(req.method, req.params);
  console.log(
    JSON.stringify({
      probe: label,
      request: req.params?.name || req.method,
      ms: Date.now() - t0,
      response: res,
    }),
  );
}

clearTimeout(timer);
child.kill("SIGTERM");
process.exit(0);
