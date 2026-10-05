import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_PYTHON,
  RUNTIME_REASON_CODES,
  meetsMinPython,
  parsePythonVersion,
  probeIctrpRuntime,
  probePython,
  probePythonDeps,
} from "../electron/main/trial-runtime.ts";

/** A runner that answers from a scripted map, so no process is ever spawned. */
function runner(outcomes) {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args: [...args] });
    const key = `${command} ${args.join(" ")}`;
    const outcome = outcomes[key];
    if (outcome === undefined) throw new Error(`unscripted probe: ${key}`);
    return outcome;
  };
  return { run, calls, keys: () => calls.map((c) => `${c.command} ${c.args.join(" ")}`) };
}

const ok = (stdout) => ({ ok: true, stdout });
const missing = (code, message = "not found") => ({ ok: false, code, message });

// ---------------------------------------------------------------------------
// §15.9 criteria 2, 3 and 10 (second/third clause).
//
// The whole point of probing is that "Python is missing" and "the tool is not
// registered" are the *same observation* by the time dispatch happens: the
// server never started, so it never registered anything. The probe re-derives
// the cause. What these tests guard is the honesty of that re-derivation —
// never inventing a verdict, never promoting "unknown" into "missing", and
// never letting a missing interpreter be reported as missing dependencies.
// ---------------------------------------------------------------------------

test("parsePythonVersion reads both the full and the short form", () => {
  assert.deepEqual(parsePythonVersion("Python 3.11.6"), { major: 3, minor: 11 });
  assert.deepEqual(parsePythonVersion("Python 3.10"), { major: 3, minor: 10 });
  assert.deepEqual(parsePythonVersion("python 3.13.0b1"), { major: 3, minor: 13 });
});

test("parsePythonVersion refuses to guess at non-Python output", () => {
  // A shim, a wrapper, or a totally different program on PATH. Returning null
  // keeps this from being read as a version, which would then be silently
  // compared and could pass.
  for (const text of ["", "command not found", "Perl v5.36.0", "Python"]) {
    assert.equal(parsePythonVersion(text), null, `must not parse: ${JSON.stringify(text)}`);
  }
});

test("meetsMinPython rejects the version below the floor and accepts the floor", () => {
  assert.equal(meetsMinPython({ major: 3, minor: MIN_PYTHON.minor }), true);
  assert.equal(meetsMinPython({ major: 3, minor: MIN_PYTHON.minor - 1 }), false);
  assert.equal(meetsMinPython({ major: 2, minor: 99 }), false);
  assert.equal(meetsMinPython({ major: 4, minor: 0 }), true);
});

test("a missing interpreter is PYTHON_RUNTIME_MISSING, and the fix is runnable", async () => {
  const r = runner({ "python3 --version": missing("ENOENT", "spawn python3 ENOENT") });
  const result = await probePython(r.run);
  assert.equal(result.status, "missing");
  assert.equal(result.reasonCode, RUNTIME_REASON_CODES.PYTHON_RUNTIME_MISSING);
  // Criterion 3: the repair line must be something a user can actually run.
  assert.ok(result.fixCommand && result.fixCommand.length > 0, "需要给出一行可复制的修复命令");
  assert.match(result.explanation, /Python/);
});

test("an interpreter below the floor is also PYTHON_RUNTIME_MISSING but says so differently", async () => {
  const r = runner({ "python3 --version": ok("Python 3.9.18\n") });
  const result = await probePython(r.run);
  assert.equal(result.status, "missing");
  assert.equal(result.reasonCode, RUNTIME_REASON_CODES.PYTHON_RUNTIME_MISSING);
  // "too old" and "absent" need different actions, so the text must differ.
  assert.match(result.explanation, /过低/);
});

test("a slow probe is unknown, never missing", async () => {
  // The distinction that matters: telling someone to install Python they
  // already have is worse than saying nothing, and it hides a hung machine.
  const r = runner({ "python3 --version": missing("PROBE_TIMEOUT", "probe timed out") });
  const result = await probePython(r.run);
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, undefined, "unknown must not carry a reason code");
});

test("unrecognised version output is unknown, not missing", async () => {
  const r = runner({ "python3 --version": ok("some shim output\n") });
  const result = await probePython(r.run);
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, undefined);
});

test("missing dependencies are PYTHON_DEPS_MISSING with an install line", async () => {
  const r = runner({
    'python3 -c import mcp, httpx, pydantic': missing("EXIT_1", "ModuleNotFoundError: No module named 'mcp'"),
  });
  const result = await probePythonDeps(r.run);
  assert.equal(result.status, "missing");
  assert.equal(result.reasonCode, RUNTIME_REASON_CODES.PYTHON_DEPS_MISSING);
  assert.match(result.fixCommand, /pip install/);
});

test("deps probe does not blame dependencies when the interpreter itself is absent", async () => {
  const r = runner({
    'python3 -c import mcp, httpx, pydantic': missing("ENOENT", "spawn python3 ENOENT"),
  });
  const result = await probePythonDeps(r.run);
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, undefined);
});

test("the chain stops at a missing interpreter instead of blaming dependencies", async () => {
  // Ordering is load-bearing (§15.3.5). On a machine with no Python, every
  // later probe fails too; running them would report the *last* failure and
  // send the user to install pip packages for an interpreter they do not have.
  const r = runner({ "python3 --version": missing("ENOENT", "no python") });
  const result = await probeIctrpRuntime(r.run);
  assert.equal(result.status, "missing");
  assert.equal(result.reasonCode, RUNTIME_REASON_CODES.PYTHON_RUNTIME_MISSING);
  assert.deepEqual(r.keys(), ["python3 --version"], "探测链必须在第一步停止");
});

test("the chain proceeds to dependencies once the interpreter is usable", async () => {
  const r = runner({
    "python3 --version": ok("Python 3.11.6\n"),
    'python3 -c import mcp, httpx, pydantic': missing("EXIT_1", "ModuleNotFoundError: No module named 'mcp'"),
  });
  const result = await probeIctrpRuntime(r.run);
  assert.equal(result.reasonCode, RUNTIME_REASON_CODES.PYTHON_DEPS_MISSING);
  assert.equal(r.keys().length, 2);
});

test("a fully working runtime reports ok", async () => {
  const r = runner({
    "python3 --version": ok("Python 3.11.6\n"),
    'python3 -c import mcp, httpx, pydantic': ok(""),
  });
  const result = await probeIctrpRuntime(r.run);
  assert.equal(result.status, "ok");
  assert.equal(result.reasonCode, undefined);
});

test("an inconclusive step keeps the chain from claiming success", async () => {
  // If Python cannot be verified, the overall answer must not be "ok": the
  // caller uses `ok` to decide the tool is genuinely absent rather than
  // unconfigured, and a false `ok` restores the misleading NOT_QUERIED.
  const r = runner({
    "python3 --version": missing("PROBE_TIMEOUT", "slow"),
    'python3 -c import mcp, httpx, pydantic': ok(""),
  });
  const result = await probeIctrpRuntime(r.run);
  assert.equal(result.status, "unknown");
  assert.notEqual(result.status, "ok");
});

test("VENDOR_FILES_MISSING and SOURCE_LAUNCH_FAILED stay reserved", () => {
  // These two are named by the spec's reason-code table but belong to steps
  // this module does not perform (bundled-tree check, process launch). They
  // are declared so consumers share one spelling — but nothing here emits
  // them, and emitting one without doing the corresponding check would be a
  // fabricated diagnosis.
  assert.equal(RUNTIME_REASON_CODES.VENDOR_FILES_MISSING, "VENDOR_FILES_MISSING");
  assert.equal(RUNTIME_REASON_CODES.SOURCE_LAUNCH_FAILED, "SOURCE_LAUNCH_FAILED");
});

test("the deps probe imports every module upstream declares", async () => {
  // The probe's whole claim is "installed means this service can start". A
  // probe that imports a subset answers a different question: `mcp`, `httpx`
  // and `pydantic` are all in the upstream `pyproject.toml` dependency list,
  // so all three have to be imported for a pass to mean anything.
  const r = runner({ 'python3 -c import mcp, httpx, pydantic': ok("") });
  await probePythonDeps(r.run);
  const probed = r.keys()[0].split("import ")[1].split(",").map((name) => name.trim());
  for (const declared of ["mcp", "httpx", "pydantic"]) {
    assert.ok(probed.includes(declared), `依赖探测必须导入 ${declared}，实际导入 ${probed.join(", ")}`);
  }
});

test("a non-import failure is unknown, not a missing dependency", async () => {
  // Only "no module named X" is evidence about dependencies. A traceback from
  // inside the package, a syntax error or an ABI mismatch exits non-zero too,
  // and answering `missing` there tells the user to re-run the very command
  // that just failed — a fabricated diagnosis with a copy button.
  const r = runner({
    "python3 --version": ok("Python 3.11.6\n"),
    'python3 -c import mcp, httpx, pydantic': missing(
      "EXIT_1",
      "ImportError: cannot import name 'Client' from 'httpx' (broken install)",
    ),
  });
  const result = await probeIctrpRuntime(r.run);
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, undefined, "不是缺模块就不能报缺模块");
  assert.equal(result.fixCommand, undefined, "没有可执行修复时不得给出可复制的命令");
});

test("the fix line names the module that is actually missing", async () => {
  // A generic `pip install mcp httpx` when only pydantic is absent still
  // "works", but the user cannot tell whether it changed anything, and the
  // command contradicts the sentence above it.
  const r = runner({
    'python3 -c import mcp, httpx, pydantic': missing(
      "EXIT_1",
      "ModuleNotFoundError: No module named 'pydantic'",
    ),
  });
  const result = await probePythonDeps(r.run);
  assert.equal(result.status, "missing");
  assert.match(result.explanation, /pydantic/);
  assert.match(result.fixCommand, /pip install pydantic\b/);
  assert.doesNotMatch(result.fixCommand, /\bmcp\b/, "已装好的包不应出现在修复命令里");
});
