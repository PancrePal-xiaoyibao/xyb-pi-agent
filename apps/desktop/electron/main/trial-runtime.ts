/**
 * Runtime probes for sources that need something installed before they can
 * answer at all — currently the vendored WHO ICTRP Python service.
 *
 * SPEC: docs/spec/xyb-unified-trial-host-orchestration.md §15.3.5, §15.3.6.1,
 * §15.9 criteria 2, 3 and 10.
 *
 * Why this exists as a separate step rather than "let the dispatch fail":
 *
 * An MCP server whose interpreter is missing never registers its tools. The
 * child dispatch then fails with `NOT_FOUND`, which the broker correctly reads
 * as *this tool is not in the catalog* → `NOT_QUERIED` + `TOOL_UNAVAILABLE`.
 * That answer is true but useless: it says "the tool is absent" when the user
 * needs to hear "Python is absent, here is the line to run". The two are
 * different states with different fixes (SPEC §15.3.5), and only the probe can
 * tell them apart — by the time dispatch fails, the cause is gone.
 *
 * A probe answers exactly one question: *is the prerequisite satisfiable right
 * now?* It never guesses why a call failed, and it never reports success on
 * incomplete evidence — an unprobeable prerequisite returns `unknown`, not
 * `ok`, because "we could not check" and "we checked and it is fine" lead to
 * opposite user actions.
 */

import { spawn } from "node:child_process";

/** Reason codes for the ICTRP runtime chain (SPEC §15.3.5, the sole authority). */
export const RUNTIME_REASON_CODES = Object.freeze({
  PYTHON_RUNTIME_MISSING: "PYTHON_RUNTIME_MISSING",
  VENDOR_FILES_MISSING: "VENDOR_FILES_MISSING",
  PYTHON_DEPS_MISSING: "PYTHON_DEPS_MISSING",
  SOURCE_LAUNCH_FAILED: "SOURCE_LAUNCH_FAILED",
});

/** Python versions older than this cannot run the vendored service. */
export const MIN_PYTHON = Object.freeze({ major: 3, minor: 10 });

/** How long a probe may take before it is treated as inconclusive. */
export const PROBE_TIMEOUT_MS = 5_000;

export type ProbeStatus = "ok" | "missing" | "unknown";

export type ProbeResult = {
  status: ProbeStatus;
  /** One of `RUNTIME_REASON_CODES`, only when `status === "missing"`. */
  reasonCode?: string;
  /** Shown to the user. For `missing`, this must be actionable on its own. */
  explanation: string;
  /** A single copy-pasteable command that fixes it, when one exists. */
  fixCommand?: string;
};

/** Injectable executor so tests never spawn a real process. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ ok: true; stdout: string } | { ok: false; code?: string; message: string }>;

const defaultRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: { ok: true; stdout: string } | { ok: false; code?: string; message: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // A synchronous throw is a missing/unusable executable, not a timeout.
      finish({ ok: false, message: (error as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      // Inconclusive, not missing: a hung interpreter may still be installed.
      finish({ ok: false, code: "PROBE_TIMEOUT", message: "probe timed out" });
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ ok: false, code: error.code, message: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, stdout });
      else finish({ ok: false, code: `EXIT_${code ?? 0}`, message: stderr.trim() || `exited ${code}` });
    });
  });

/** Parse `Python 3.11.6` (or `Python 3.11`) into its numeric parts. */
export function parsePythonVersion(output: string): { major: number; minor: number } | null {
  const match = /Python\s+(\d+)\.(\d+)/i.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** True when `version` is at least `MIN_PYTHON`. */
export function meetsMinPython(version: { major: number; minor: number }): boolean {
  if (version.major !== MIN_PYTHON.major) return version.major > MIN_PYTHON.major;
  return version.minor >= MIN_PYTHON.minor;
}

/**
 * Probe the Python interpreter.
 *
 * Distinguishes three outcomes that a single failure would blur together: a
 * missing executable (`missing`, with an install line), an interpreter that is
 * present but too old (`missing`, with an upgrade line — a different fix), and
 * a probe that could not reach a verdict (`unknown`).
 */
export async function probePython(
  runner: CommandRunner = defaultRunner,
  command = "python3",
): Promise<ProbeResult> {
  const result = await runner(command, ["--version"], PROBE_TIMEOUT_MS);
  if (!result.ok) {
    if (result.code === "ENOENT") {
      return {
        status: "missing",
        reasonCode: RUNTIME_REASON_CODES.PYTHON_RUNTIME_MISSING,
        explanation: `未找到 ${command}。WHO ICTRP 渠道由一段随包 Python 服务提供，需要 Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor} 或更高版本。`,
        fixCommand: "python3 --version",
      };
    }
    if (result.code === "PROBE_TIMEOUT") {
      // Slow, not absent. Reporting `missing` here would tell the user to
      // install something they already have, and would hide a hung system.
      return {
        status: "unknown",
        explanation: `检测 ${command} 超时，无法判断运行时是否可用。`,
      };
    }
    return {
      status: "unknown",
      explanation: `检测 ${command} 失败：${result.message}`,
    };
  }
  const version = parsePythonVersion(result.stdout);
  if (!version) {
    // The command ran but did not look like Python. Could be a shim, a wrapper,
    // or a different program on PATH — not enough to call it missing.
    return {
      status: "unknown",
      explanation: `${command} 有响应，但无法识别其版本输出。`,
    };
  }
  if (!meetsMinPython(version)) {
    return {
      status: "missing",
      reasonCode: RUNTIME_REASON_CODES.PYTHON_RUNTIME_MISSING,
      explanation: `Python ${version.major}.${version.minor} 版本过低，WHO ICTRP 渠道需要 ${MIN_PYTHON.major}.${MIN_PYTHON.minor} 或更高版本。`,
      fixCommand: "python3 --version",
    };
  }
  return { status: "ok", explanation: `Python ${version.major}.${version.minor} 可用。` };
}

/**
 * Probe the vendored service's third-party dependencies.
 *
 * Imports the modules upstream declares in `pyproject.toml` (`mcp`, `httpx`,
 * `pydantic`) and that the service's own sources import, so "installed" means
 * "this service can start", not "some package with a similar name exists".
 * `mcp.types` re-exports pydantic types, so importing it proves the transitive
 * dependency too — but probing it by name reports *which* one is missing, and
 * the fix line the user is told to run must name what actually failed.
 */
export async function probePythonDeps(
  runner: CommandRunner = defaultRunner,
  command = "python3",
  env: Record<string, string> = {},
): Promise<ProbeResult> {
  const result = await runner(
    command,
    ["-c", "import mcp, httpx, pydantic"],
    PROBE_TIMEOUT_MS,
  );
  if (result.ok) return { status: "ok", explanation: "Python 依赖已就绪。" };
  if (result.code === "ENOENT" || result.code === "PROBE_TIMEOUT") {
    // The interpreter itself is the problem; do not blame the dependencies.
    return { status: "unknown", explanation: "无法检测 Python 依赖：解释器不可用。" };
  }
  void env;
  // Only a *missing module* is evidence about dependencies. A syntax error, a
  // broken wheel, an ABI mismatch or a traceback from inside the package all
  // exit non-zero too, and telling the user to `pip install mcp httpx pydantic`
  // when they are already installed sends them to re-run the command that
  // failed. So: say which modules the probe could not import, and when the
  // failure is not about missing modules at all, say that instead.
  const missing = [...result.message.matchAll(/(?:ModuleNotFoundError: No module named|ImportError: No module named)\s+'?([A-Za-z0-9_.]+)'?/gi)]
    .map((match) => match[1].split(".")[0]);
  if (missing.length === 0) {
    return {
      status: "unknown",
      explanation: `检测 Python 依赖失败，但原因不是缺少某个模块：${result.message}`,
    };
  }
  const unique = [...new Set(missing)];
  return {
    status: "missing",
    reasonCode: RUNTIME_REASON_CODES.PYTHON_DEPS_MISSING,
    explanation: `随包 WHO ICTRP 服务缺少 Python 依赖：${unique.join("、")}。`,
    fixCommand: `python3 -m pip install ${unique.join(" ")}`,
  };
}

/**
 * Run the full ICTRP prerequisite chain, stopping at the first hard failure.
 *
 * Order matters (SPEC §15.3.5): a missing interpreter makes every later probe
 * meaningless, so reporting "dependencies missing" on a machine with no Python
 * would send the user to fix the wrong thing. Stops at the first `missing`;
 * carries `unknown` forward, because an inconclusive probe must not be
 * promoted into a confirmed pass.
 */
export async function probeIctrpRuntime(
  runner: CommandRunner = defaultRunner,
  command = "python3",
): Promise<ProbeResult> {
  const python = await probePython(runner, command);
  if (python.status === "missing") return python;
  const deps = await probePythonDeps(runner, command);
  if (deps.status === "missing") return deps;
  if (python.status === "unknown" || deps.status === "unknown") {
    return {
      status: "unknown",
      explanation: python.status === "unknown" ? python.explanation : deps.explanation,
    };
  }
  return { status: "ok", explanation: "WHO ICTRP 运行环境已就绪。" };
}
