import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateMcpServer } from "../../../packages/plugin-sdk/src/mcp-config.ts";
import { MCP_CALL_TIMEOUT_MS, MCP_CONNECT_TIMEOUT_MS, McpServerClient } from "../electron/main/plugin-mcp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, "../resources/plugins/xyb.trial-sources/manifest.json"), "utf8"),
);

const server = (over) => ({ id: "who-ictrp", transport: "stdio", command: "python3", ...over });

// ---------------------------------------------------------------------------
// §15.9 criterion 10, first clause.
//
// The ICTRP child must carry its own call budget. The shared default is sized
// for local processes answering from memory; ICTRP walks a multi-megabyte
// export, and inheriting the default would cut a working call off mid-flight
// and report it as a failure. The test pins the *manifest obligation* and the
// independent value, not merely that some number is present.
// ---------------------------------------------------------------------------

test("who-ictrp declares its own call timeout", () => {
  const ictrp = manifest.contributes.mcpServers.find((s) => s.id === "who-ictrp");
  assert.ok(ictrp, "manifest must declare who-ictrp");
  assert.equal(ictrp.callTimeoutMs, 60000);
});

test("the declared timeout is identical to the descriptor the host fans out with", () => {
  // Two places encode this number: the manifest (how the MCP client is built)
  // and the source descriptor (what the orchestrator budgets). If they drift,
  // the orchestrator's deadline is computed against a timeout the client does
  // not honour.
  // Anchor on the descriptor, not the first mention of the key: `"who_ictrp"`
  // also appears earlier in `UPSTREAM_INCOMPLETE_SOURCES`, and slicing from
  // there would happily assert against the wrong region.
  const src = readFileSync(join(here, "../electron/main/trial-sources.ts"), "utf8");
  const descriptorStart = src.indexOf('key: "who_ictrp"');
  assert.ok(descriptorStart > 0, "who_ictrp descriptor must exist");
  const who = src.slice(descriptorStart, src.indexOf("})", descriptorStart));
  assert.match(who, /toolName:\s*"ictrp_search"/, "sliced the wrong descriptor");
  assert.match(who, /timeoutMs:\s*60_?000/, "who_ictrp descriptor timeout must be 60000ms");
});

test("the declared timeout differs from the shared default, so the declaration is load-bearing", () => {
  const ictrp = manifest.contributes.mcpServers.find((s) => s.id === "who-ictrp");
  assert.notEqual(
    ictrp.callTimeoutMs,
    MCP_CALL_TIMEOUT_MS,
    "若两者相等，这条声明就什么都没改变，测试也就没有在守护任何东西",
  );
});

// ---------------------------------------------------------------------------
// §15.9 criterion 10, third clause: the handshake must not be cut off at the
// 10s connect bound.
//
// The first two clauses are pinned above. The third was registered un-built
// (§15.10 item 3) because `connectTimeoutMs` is a runtime option rather than a
// manifest key, so the manifest could not be made to carry the widened bound —
// there was nothing to assert against.
//
// Measured instead (real client, real bundled server, three cold runs):
// handshake completes in 1.27s / 1.28s / 1.33s against the 10s default, a ~7x
// margin. The clause therefore holds by measurement, not by configuration, and
// what needs guarding is that the margin does not quietly disappear: the
// bundled server must start and answer inside the default budget.
// ---------------------------------------------------------------------------

test("the bundled ICTRP server handshakes well inside the shared connect bound", async (t) => {
  const root = join(here, "../resources/plugins/xyb.trial-sources");
  const started = Date.now();
  const client = new McpServerClient({
    pluginId: "xyb.trial-sources",
    rootPath: root,
    serverId: "who-ictrp",
    server: { id: "who-ictrp", transport: "stdio", command: "python3", args: ["-m", "ictrp_mcp.server"] },
    values: {
      PYTHONPATH: join(root, "mcp/ictrp"),
      ICTRP_BUNDLE_PATH: join(root, "data/ictrp/pancreatic-cancer.json"),
    },
    // Deliberately NOT widened: the point is that the default is enough. If
    // this ever needs a larger number, the clause has regressed and the SPEC
    // must say so rather than the test absorbing it.
    connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
  });
  t.after(() => client.close());
  let tools;
  try {
    tools = await client.connect();
  } catch (error) {
    // Environment facts are not regressions in this clause: no interpreter at
    // all, and an interpreter that cannot import the vendored module's
    // dependencies. CI has python3 but installs no `mcp`/`httpx`/`pydantic`,
    // so the child exits with `ModuleNotFoundError: No module named 'mcp.server'`
    // — a first CI run reported that as a failure because the pattern only
    // covered a missing binary. Either way the timing claim is untested, so say
    // so rather than passing silently; a genuine timeout still fails.
    if (
      /ENOENT|not found|spawn python3/i.test(String(error)) ||
      /ModuleNotFoundError|No module named/i.test(String(error))
    ) {
      t.skip("python3 or its ICTRP dependencies unavailable in this environment");
      return;
    }
    throw error;
  }
  const elapsedMs = Date.now() - started;
  assert.equal(tools.length, 9, "the catalogue is nine tools (SPEC §15.3.3)");
  assert.ok(
    tools.some((tool) => tool.name === "ictrp_search"),
    "handshake must discover ictrp_search",
  );
  assert.ok(
    elapsedMs < MCP_CONNECT_TIMEOUT_MS,
    `handshake took ${elapsedMs}ms; the shared connect bound is ${MCP_CONNECT_TIMEOUT_MS}ms, ` +
      "and §15.9 criterion 10 clause 3 requires a slow-but-usable service not be read as SOURCE_LAUNCH_FAILED",
  );
});

test("only the slow channel declares a timeout", () => {
  // A generous per-server budget is a deliberate exception, not a new default.
  // npx-launched aggregators answer quickly and should keep the shared budget,
  // otherwise a hung npm process occupies a fan-out slot for a full minute.
  const withTimeout = manifest.contributes.mcpServers.filter(
    (s) => s.callTimeoutMs !== undefined,
  );
  assert.deepEqual(withTimeout.map((s) => s.id), ["who-ictrp"]);
});

test("validateMcpServer accepts a positive integer timeout", () => {
  const result = validateMcpServer(server({ callTimeoutMs: 60000 }));
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(result.server.callTimeoutMs, 60000);
});

test("validateMcpServer accepts an absent timeout", () => {
  const result = validateMcpServer(server({}));
  assert.equal(result.ok, true, result.ok ? "" : result.error);
});

test("validateMcpServer rejects a timeout that is not a positive integer", () => {
  // Each of these would either disable the guard or fire before the process
  // could plausibly answer. Rejecting at load time turns a mystifying runtime
  // failure into a manifest error naming the field.
  for (const bad of [0, -1, 1.5, Number.NaN, "60000", null, {}]) {
    const result = validateMcpServer(server({ callTimeoutMs: bad }));
    assert.equal(result.ok, false, `callTimeoutMs=${JSON.stringify(bad)} must be rejected`);
    assert.match(result.ok ? "" : result.error, /callTimeoutMs must be a positive integer/);
  }
});
