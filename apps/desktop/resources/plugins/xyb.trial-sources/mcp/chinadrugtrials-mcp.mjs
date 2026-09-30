#!/usr/bin/env node
/**
 * 小胰宝 · 中国药物临床试验登记与信息公示平台（MCP 服务）
 *
 * 职责：把本机已有的人工采集器（collectors/chinadrugtrials，Python）包装成 MCP 工具，
 *       让助手在会话里能直接检索、取详情、做增量同步与归档核对。
 *
 * 为什么是 MCP 而不是直接跑脚本：
 *   插件权限表里不存在「执行外部进程」这一项，本地工具的唯一正规通道是 contributes.mcpServers。
 *
 * 为什么本文件零依赖（只用 Node 内置模块）：
 *   患者机器上不该为了一个数据源再装 npm 包。真正需要第三方库的只有 Python 采集器
 *   （requests + beautifulsoup4），那一层由 setup_environment 单独准备，缺了也只影响抓取。
 *
 * 凭证红线：
 *   Cookie 只写在本机 <数据目录>/config.json（权限 0600），不写入任何日志、返回值或提交。
 *   传给采集器时走 --config 文件，不走命令行参数——命令行会出现在进程列表里，会被别的进程读到。
 *
 * 数据目录：~/.xyb-chinadrugtrials/
 *   ├── config.json    会话 Cookie 与上次检索条件
 *   └── output/<关键词>/   raw/ json/ word/ summary.json state.json
 *
 * 传输：stdio，行分隔 JSON-RPC 2.0（同时兼容 Content-Length 帧，以防宿主用旧式分帧）。
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 插件根目录：本文件在 <plugin>/mcp/ 下。 */
const PLUGIN_DIR = path.dirname(HERE);
const COLLECTOR_DIR = path.join(PLUGIN_DIR, "collectors", "chinadrugtrials");
const SCRAPER = path.join(COLLECTOR_DIR, "scripts", "scraper.py");
const VERIFIER = path.join(COLLECTOR_DIR, "scripts", "verify_output.py");
const REQUIREMENTS = path.join(COLLECTOR_DIR, "scripts", "requirements.txt");

const DATA_DIR = path.join(os.homedir(), ".xyb-chinadrugtrials");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const OUTPUT_ROOT = path.join(DATA_DIR, "output");
const VENV_DIR = path.join(DATA_DIR, "venv");

const PROTOCOL_FALLBACK = "2024-11-05";
const DISCLAIMER =
  "以上为公开试验登记信息的整理，供参考，不能替代医生判断，也不构成入组建议或用药建议。";

/** 抓取相关工具的统一提醒：这是逐条抓取，不是查缓存。 */
const PACING_NOTE =
  "本工具会逐条打开详情页并按 1.5 秒间隔请求，不是查缓存；条数多时请留出时间，不要重复触发。";

// ──────────────────────────────────────────────
// 基础工具
// ──────────────────────────────────────────────

function log(...args) {
  // stdout 是 JSON-RPC 通道，任何日志都必须走 stderr。
  process.stderr.write(`[chinadrugtrials-mcp] ${args.join(" ")}\n`);
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(OUTPUT_ROOT, { recursive: true });
}

async function readConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写配置。含 Cookie 时落到 0600——同机其他用户读不到。
 * 注意：config.json 里**不能**写采集器认识的 output / keywords / max_pages 等键，
 * 否则 --config 会覆盖命令行传的值（采集器是 config 优先）。所以只放 cookies 与自定义键。
 */
async function writeConfig(config) {
  await ensureDirs();
  const tmp = `${CONFIG_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, CONFIG_PATH);
  await fsp.chmod(CONFIG_PATH, 0o600).catch(() => {});
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? DATA_DIR,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const limit = options.maxBuffer ?? 8 * 1024 * 1024;
    child.stdout.on("data", (chunk) => {
      if (stdout.length < limit) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < limit) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.timeoutMs) {
      setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* 已经退出 */
        }
      }, options.timeoutMs).unref?.();
    }
  });
}

/** 解释器优先级：专用 venv → PATH 上的 python3 → 系统路径。 */
async function resolvePython() {
  const candidates = [
    path.join(VENV_DIR, "bin", "python3"),
    path.join(VENV_DIR, "Scripts", "python.exe"), // Windows
    "python3",
    "/usr/bin/python3",
  ];
  for (const candidate of candidates) {
    const isPath = candidate.includes("/") || candidate.includes("\\");
    if (isPath) {
      try {
        await fsp.access(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
    }
    const probe = await run(candidate, ["-c", "import sys;print(sys.version.split()[0])"], {
      timeoutMs: 10000,
    });
    if (probe.code === 0) {
      return { command: candidate, version: probe.stdout.trim(), fromVenv: candidate.includes(VENV_DIR) };
    }
  }
  return null;
}

/** 采集器依赖检查（requests + beautifulsoup4 + 标准库 urllib 之外的用法）。 */
async function checkCollectorDeps(python) {
  if (!python) return { ok: false, missing: ["python3"] };
  const probe = await run(
    python.command,
    ["-c", "import requests, bs4;print('ok')"],
    { timeoutMs: 20000 },
  );
  if (probe.code === 0) return { ok: true, missing: [] };
  const text = `${probe.stdout}${probe.stderr}`;
  const missing = [];
  if (/requests/.test(text)) missing.push("requests");
  if (/bs4|beautifulsoup/i.test(text)) missing.push("beautifulsoup4");
  return { ok: false, missing: missing.length ? missing : ["requests", "beautifulsoup4"] };
}

// ──────────────────────────────────────────────
// Cookie 处理
// ──────────────────────────────────────────────

/**
 * 从三处取 Cookie：优先 cURL 的 -b/--cookie，其次 cURL 的 -H 'Cookie: ...'，最后整串当 Cookie。
 * 只做提取与合并，不生成、不猜测、不复用他人会话。
 */
function extractCookie(input) {
  const text = String(input ?? "").trim();
  if (!text) return { cookie: "", fields: [] };

  let cookie = "";
  const quoted = (re) => {
    const match = text.match(re);
    return match ? match[1] : "";
  };

  cookie = quoted(/(?:^|\s)-b\s+'([^']+)'/m) || quoted(/(?:^|\s)-b\s+"([^"]+)"/m);
  if (!cookie) cookie = quoted(/(?:^|\s)--cookie\s+'([^']+)'/m) || quoted(/(?:^|\s)--cookie\s+"([^"]+)"/m);
  if (!cookie) {
    cookie =
      quoted(/-H\s+'Cookie:\s*([^']+)'/im) || quoted(/-H\s+"Cookie:\s*([^"]+)"/im);
  }
  if (!cookie) cookie = quoted(/^\s*cookie:\s*(.+)$/im);
  if (!cookie && /[=;]/.test(text) && !/^(curl|GET|POST)\b/i.test(text)) cookie = text;

  const fields = cookie
    .split(";")
    .map((part) => part.split("=")[0].trim())
    .filter(Boolean);

  return { cookie: cookie.trim(), fields };
}

function cookieLooksLikeChallenge(cookie) {
  // 平台关键会话字段。缺了通常就是没登录/验证页的会话。
  return !/(^|;\s*)(FSSBBIl1UgzbN7N80S|token|JSESSIONID|SESSION)=/i.test(cookie);
}

// ──────────────────────────────────────────────
// 归档读取
// ──────────────────────────────────────────────

/**
 * 归档目录 = json/ 里真的有记录文件的目录。
 * 采集器建对象时就把 json/ word/ logs/ raw/ 都建好，会话失效时会留下一个
 * 全空的目录；那种目录不能算成归档，否则患者会看到「胰腺癌 0 条」这种像是结论的东西。
 */
async function listArchiveDirs() {
  try {
    const entries = await fsp.readdir(OUTPUT_ROOT, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(OUTPUT_ROOT, entry.name);
      try {
        const names = await fsp.readdir(path.join(dir, "json"));
        if (names.some((name) => name.endsWith(".json"))) dirs.push(dir);
      } catch {
        // 没有 json/：抓取没跑完，不计入归档
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

/** 在归档里找某登记号的详情 JSON；不确定关键词时全量搜一遍。 */
async function findArchiveJson(regNo, keywordDir) {
  const dirs = keywordDir ? [keywordDir] : await listArchiveDirs();
  for (const dir of dirs) {
    const candidate = path.join(dir, "json", `${regNo}.json`);
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/** 把详情 JSON 压成给助手看的形状：字段名保持原样，长文本截断。 */
function summarizeDetail(data, { includeText = false } = {}) {
  const list = data.list_info ?? {};
  const sections = data.sections ?? {};
  const sectionNames = Object.keys(sections);
  const flat = {};
  for (const [name, kv] of Object.entries(sections)) {
    if (kv && typeof kv === "object") {
      for (const [key, value] of Object.entries(kv)) {
        if (!(key in flat) && typeof value === "string") flat[key] = value;
      }
    }
  }
  const out = {
    reg_no: data.reg_no ?? "",
    title: list.title ?? "",
    state: list.state ?? "",
    drug_name: list.drug_name ?? "",
    indication: list.indication ?? "",
    scrape_time: data.scrape_time ?? "",
    detail_url: data.source?.detail_url ?? "",
    raw_html_path: data.source?.raw_html_path ?? "",
    section_names: sectionNames,
    fields: flat,
  };
  if (includeText) out.full_text = data.full_text ?? "";
  return out;
}

async function readSummary(keywordDir) {
  try {
    const raw = await fsp.readFile(path.join(keywordDir, "summary.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readTrialsFromDir(keywordDir, limit = 30) {
  const jsonDir = path.join(keywordDir, "json");
  let files = [];
  try {
    files = (await fsp.readdir(jsonDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { total: 0, trials: [] };
  }
  const trials = [];
  for (const name of files.slice(0, limit)) {
    try {
      const data = JSON.parse(await fsp.readFile(path.join(jsonDir, name), "utf8"));
      const list = data.list_info ?? {};
      trials.push({
        reg_no: data.reg_no ?? name.replace(/\.json$/, ""),
        title: list.title ?? "",
        state: list.state ?? "",
        drug_name: list.drug_name ?? "",
        indication: list.indication ?? "",
      });
    } catch {
      /* 单条坏了不影响整体 */
    }
  }
  return { total: files.length, trials };
}

function safeKeywordDir(keywords) {
  const safe = String(keywords ?? "").replace(/[^\w\u4e00-\u9fff]/g, "_") || "未命名";
  return path.join(OUTPUT_ROOT, safe);
}

// ──────────────────────────────────────────────
// 工具实现
// ──────────────────────────────────────────────

async function toolGetCollectorStatus() {
  const python = await resolvePython();
  const deps = await checkCollectorDeps(python);
  const config = await readConfig();
  const configured = typeof config.cookies === "string" && config.cookies.trim().length > 0;

  const dirs = await listArchiveDirs();
  const archive = [];
  for (const dir of dirs) {
    const summary = await readSummary(dir);
    const { total } = await readTrialsFromDir(dir, 0);
    archive.push({
      keyword: path.basename(dir),
      path: dir,
      records: total,
      last_scrape: summary?.scrape_time ?? null,
    });
  }

  const nextSteps = [];
  if (!python) {
    nextSteps.push(
      "本机没有可用的 python3。macOS 可执行 xcode-select --install 安装命令行工具；也可以从 python.org 安装后重试。",
    );
  } else if (!deps.ok) {
    nextSteps.push("采集器依赖未装齐，调用 setup_environment 一次性安装（需要联网）。");
  }
  if (!configured) {
    nextSteps.push(
      "还没有配置会话。请在浏览器打开平台并完成正常访问，用开发者工具对站内请求「复制为 cURL」，再调用 update_cookie。",
    );
  }

  return {
    ok: true,
    ready: Boolean(python && deps.ok && configured),
    python: python
      ? { available: true, command: python.command, version: python.version, from_venv: python.fromVenv }
      : { available: false },
    collector_deps: deps,
    cookie: {
      configured,
      updated_at: config.cookie_updated_at ?? null,
      note: configured
        ? "已配置。会话过期后需要重新从浏览器复制 cURL 更新，工具无法代替你登录。"
        : "未配置。",
    },
    data_dir: DATA_DIR,
    archive,
    next_steps: nextSteps,
    disclaimer: DISCLAIMER,
  };
}

async function toolSetupEnvironment() {
  const python = await resolvePython();
  if (!python) {
    return {
      ok: false,
      error:
        "本机没有可用的 python3，无法准备采集环境。macOS 可执行 xcode-select --install；也可以从 python.org 安装后重试。",
    };
  }
  if (python.fromVenv) {
    const deps = await checkCollectorDeps(python);
    if (deps.ok) return { ok: true, already_ready: true, python: python.command, version: python.version };
  }

  const base = python.fromVenv ? "/usr/bin/python3" : python.command;
  await ensureDirs();

  const venv = await run(base, ["-m", "venv", VENV_DIR], { timeoutMs: 120000 });
  if (venv.code !== 0) {
    return {
      ok: false,
      stage: "create_venv",
      error: `${venv.stdout}${venv.stderr}`.trim().slice(-1200),
    };
  }

  const pip = path.join(VENV_DIR, "bin", "pip");
  const install = await run(
    pip,
    ["install", "--disable-pip-version-check", "-r", REQUIREMENTS],
    { timeoutMs: 300000 },
  );
  if (install.code !== 0) {
    return {
      ok: false,
      stage: "pip_install",
      error: `${install.stdout}${install.stderr}`.trim().slice(-1200),
      hint: "多为网络问题，可换用国内镜像后重试。",
    };
  }

  const after = await resolvePython();
  const deps = await checkCollectorDeps(after);
  return {
    ok: deps.ok,
    venv: VENV_DIR,
    python: after?.command ?? "",
    version: after?.version ?? "",
    deps,
  };
}

async function toolUpdateCookie(args) {
  const raw = args?.curl || args?.cookie || "";
  const { cookie, fields } = extractCookie(raw);
  if (!cookie) {
    return {
      ok: false,
      error:
        "没能从输入里取到 Cookie。请粘贴浏览器「复制为 cURL」的完整命令，或粘 Cookie 字符串（形如 a=1; b=2）。",
    };
  }
  const config = await readConfig();
  config.cookies = cookie;
  config.cookie_updated_at = new Date().toISOString();
  await writeConfig(config);

  const challenged = cookieLooksLikeChallenge(cookie);
  return {
    ok: true,
    fields,
    field_count: fields.length,
    note: challenged
      ? "已保存。但这串里没看到平台常见的会话字段，可能不是站内请求的完整 Cookie；若检索返回空或跳到验证页，请重新复制一次。"
      : "已保存到本机会话文件，权限 0600。Cookie 值不会写入日志、回答或提交。",
    reminder: "会话过期是常态，过期后需要你本人重新从浏览器复制一次，工具不会代替你登录。",
  };
}

const ADVANCED_FLAGS = {
  reg_no: "--reg-no",
  indication: "--indication",
  case_no: "--case-no",
  drugs_name: "--drugs-name",
  drugs_type: "--drugs-type",
  appliers: "--appliers",
  communities: "--communities",
  researchers: "--researchers",
  agencies: "--agencies",
  state: "--state",
};

async function runScrape({ keywords, args, incremental, maxPages }) {
  const config = await readConfig();
  if (!config.cookies) {
    return { ok: false, error: "还没有配置会话。请先调用 update_cookie，把浏览器里复制到的 cURL 粘进来。" };
  }
  const python = await resolvePython();
  if (!python) return { ok: false, error: "本机没有可用的 python3，请先调用 setup_environment。" };
  const deps = await checkCollectorDeps(python);
  if (!deps.ok) {
    return {
      ok: false,
      error: `采集器依赖未装齐（缺 ${deps.missing.join("、")}）。请先调用 setup_environment。`,
    };
  }

  await ensureDirs();
  const cli = [
    SCRAPER,
    "--config",
    CONFIG_PATH,
    "--output",
    OUTPUT_ROOT,
    "--keywords",
    keywords,
  ];
  for (const [field, flag] of Object.entries(ADVANCED_FLAGS)) {
    const value = args?.[field];
    if (typeof value === "string" && value.trim()) cli.push(flag, value.trim());
  }
  if (maxPages && Number.isFinite(maxPages)) cli.push("--max-pages", String(Math.max(1, Math.trunc(maxPages))));
  if (incremental) cli.push("--incremental");

  log(`run scraper: keywords=${keywords} incremental=${Boolean(incremental)} maxPages=${maxPages ?? "all"}`);
  const started = Date.now();
  const result = await run(python.command, cli, { timeoutMs: 30 * 60 * 1000 });
  const elapsed = Math.round((Date.now() - started) / 1000);

  const keywordDir = safeKeywordDir(keywords);
  const summary = await readSummary(keywordDir);
  const { total, trials } = await readTrialsFromDir(keywordDir, 40);

  // 采集器的日志走 stdout（它在子进程里，不会污染本服务的 JSON-RPC 通道），
  // 未捕获异常的 traceback 走 stderr。诊断必须把两股都看，否则会漏掉唯一那句人话。
  const combined = `${result.stdout}\n${result.stderr}`;
  const tail = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n");
  const challengeHit = /反爬|挑战页|验证|有效浏览器会话|challenge/i.test(combined);
  // 采集器最后一条 [ERROR] 是它自己的结论，比 traceback 有用。
  const errorLine =
    combined
      .split("\n")
      .filter((line) => /\[ERROR\]/.test(line))
      .pop()
      ?.replace(/^.*\[ERROR\]\s*/, "")
      .trim() ?? "";

  if (result.code !== 0 && !summary) {
    return {
      ok: false,
      error: errorLine || "采集没有跑完，也没有拿到汇总文件。",
      exit_code: result.code,
      elapsed_seconds: elapsed,
      log_tail: tail,
      hint: challengeHit
        ? "站点把这次请求判成了验证/挑战页，说明会话已失效或不是站内请求的完整 Cookie。请本人重新在浏览器正常访问该平台，对实际搜索请求「复制为 cURL」，再用 update_cookie 更新；工具不会也不能绕过站点验证。这不是「没有相关试验」。"
        : "请核对关键词与会话是否有效，然后重试。",
    };
  }

  // 记下本次条件，供 sync_incremental 复用。
  const config2 = await readConfig();
  config2.last_search = {
    keywords,
    advanced: Object.fromEntries(
      Object.entries(args ?? {}).filter(([, v]) => typeof v === "string" && v.trim()),
    ),
    max_pages: maxPages ?? null,
    at: new Date().toISOString(),
  };
  await writeConfig(config2);

  const nothingFound = (summary?.total_records ?? 0) === 0;
  return {
    ok: !nothingFound,
    keywords,
    total_records: summary?.total_records ?? 0,
    total_pages: summary?.total_pages ?? 0,
    success_count: summary?.success_count ?? 0,
    fail_count: summary?.fail_count ?? 0,
    skip_count: summary?.skip_count ?? 0,
    word_count: summary?.word_count ?? 0,
    archived_records: total,
    archive_dir: keywordDir,
    elapsed_seconds: elapsed,
    trials,
    notice: nothingFound
      ? "平台上没有匹配到记录。这不等于「没有相关研究」——也可能是关键词太窄或会话失效，必要时换关键词或更新会话后重试。"
      : `每条记录的详情页原始 HTML、结构化 JSON 与平台原样 Word 已归档到 ${keywordDir}。`,
    log_tail: tail,
    disclaimer: DISCLAIMER,
  };
}

async function toolSearchTrials(args) {
  const keywords = String(args?.keywords ?? "").trim() || "胰腺癌";
  return runScrape({
    keywords,
    args,
    incremental: Boolean(args?.incremental),
    maxPages: args?.max_pages ?? 2,
  });
}

async function toolSyncIncremental() {
  const config = await readConfig();
  const last = config.last_search;
  if (!last?.keywords) {
    return {
      ok: false,
      error: "还没有可复用的检索条件。请先调用 search_trials 跑一次，之后再增量同步。",
    };
  }
  return runScrape({
    keywords: last.keywords,
    args: last.advanced ?? {},
    incremental: true,
    maxPages: last.max_pages ?? null,
  });
}

async function toolGetTrialDetail(args) {
  const regNo = String(args?.reg_no ?? "").trim();
  if (!regNo) return { ok: false, error: "需要提供登记号（reg_no）。" };
  const keyword = typeof args?.keywords === "string" && args.keywords.trim() ? args.keywords.trim() : "";
  const file = await findArchiveJson(regNo, keyword ? safeKeywordDir(keyword) : null);
  if (!file) {
    return {
      ok: false,
      error: `归档里没有 ${regNo} 的详情。请先用 search_trials 检索并归档，再取详情。`,
    };
  }
  const data = JSON.parse(await fsp.readFile(file, "utf8"));
  return {
    ok: true,
    path: file,
    trial: summarizeDetail(data, { includeText: Boolean(args?.include_full_text) }),
    disclaimer: DISCLAIMER,
  };
}

async function toolListArchived(args) {
  const keyword = typeof args?.keywords === "string" && args.keywords.trim() ? args.keywords.trim() : "";
  const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.trunc(args.limit)) : 50;
  const dirs = keyword ? [safeKeywordDir(keyword)] : await listArchiveDirs();
  const result = [];
  let total = 0;
  for (const dir of dirs) {
    const { total: count, trials } = await readTrialsFromDir(dir, limit);
    total += count;
    result.push({ keyword: path.basename(dir), records: count, trials });
  }
  if (!result.length) {
    return { ok: false, error: "本机还没有归档记录。请先调用 search_trials。" };
  }
  return { ok: true, total_records: total, archives: result, disclaimer: DISCLAIMER };
}

async function toolVerifyArchive(args) {
  const keyword = typeof args?.keywords === "string" && args.keywords.trim() ? args.keywords.trim() : "";
  const python = await resolvePython();
  if (!python) return { ok: false, error: "本机没有可用的 python3。" };
  const dir = keyword ? safeKeywordDir(keyword) : (await listArchiveDirs())[0];
  if (!dir) return { ok: false, error: "本机还没有归档记录。" };
  const cli = [VERIFIER, "--output", dir];
  if (process.platform !== "darwin") cli.push("--allow-missing-docx");
  const result = await run(python.command, cli, { timeoutMs: 120000 });
  return {
    ok: result.code === 0,
    keywords: path.basename(dir),
    archive_dir: dir,
    exit_code: result.code,
    output: `${result.stdout}${result.stderr}`.trim().slice(-3000),
  };
}

// ──────────────────────────────────────────────
// MCP 工具表
// ──────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_collector_status",
    description: `看这个来源现在能不能用：Python 环境、采集器依赖、会话是否已配置、本机归档了多少条。排障时先调它，不要靠猜。${DISCLAIMER}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "setup_environment",
    description:
      "一次性准备本机采集环境：在数据目录下建 Python 虚拟环境并安装采集器依赖（requests、beautifulsoup4）。需要联网，可能要一两分钟。已就绪时直接返回。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_cookie",
    description:
      "保存中国药物临床试验登记与信息公示平台的本人会话。把浏览器里对该站请求「复制为 cURL」的完整命令粘进 curl 字段即可（也可以直接粘 Cookie 字符串）。Cookie 只写在本机文件，不会回显、不会写日志。会话过期后必须由本人重新复制，工具不代替你登录、不绕过验证。",
    inputSchema: {
      type: "object",
      properties: {
        curl: {
          type: "string",
          description: "浏览器开发者工具里对站内请求「复制为 cURL」得到的完整命令。",
        },
        cookie: { type: "string", description: "直接给 Cookie 字符串时用这个字段。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_trials",
    description: `在中国药物临床试验登记与信息公示平台上检索，并把每条记录的详情页原始 HTML、结构化 JSON 与平台原样 Word 归档到本机。需要先配置会话（update_cookie）。${PACING_NOTE}${DISCLAIMER}`,
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "关键词，例如「胰腺癌」「KRAS」。默认「胰腺癌」。" },
        state: { type: "string", description: "试验状态，例如「招募中」「已完成」。" },
        indication: { type: "string", description: "适应症。" },
        reg_no: { type: "string", description: "登记号。" },
        case_no: { type: "string", description: "试验方案编号。" },
        drugs_name: { type: "string", description: "药物名称。" },
        drugs_type: { type: "string", description: "药物类型：1=中药/天然药物，2=化学药物，3=生物制品。" },
        appliers: { type: "string", description: "申请人。" },
        communities: { type: "string", description: "伦理委员会。" },
        researchers: { type: "string", description: "主要研究者。" },
        agencies: { type: "string", description: "临床参加机构。" },
        max_pages: {
          type: "integer",
          description: "最多翻几页，默认 2。每页约 10 条，页数越大越慢。",
        },
        incremental: {
          type: "boolean",
          description: "增量模式：正文没变化的记录不重写 JSON、不重复下载 Word。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sync_incremental",
    description: `按上次 search_trials 用的条件做一次增量同步：逐条比对正文指纹，只保存新增或内容有变化的记录。每日巡检用这个，不要每次全量重抓。${PACING_NOTE}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_trial_detail",
    description: `从本机归档里按登记号取一条试验的完整详情（含各章节字段）。归档里没有就明确说没有，不会去联网现抓——需要现抓请先调 search_trials。${DISCLAIMER}`,
    inputSchema: {
      type: "object",
      properties: {
        reg_no: { type: "string", description: "登记号，例如 CTR20231234。" },
        keywords: { type: "string", description: "该记录所属的检索关键词目录，可省略（省略时全量查找）。" },
        include_full_text: { type: "boolean", description: "是否附带全文（较长，默认不带）。" },
      },
      required: ["reg_no"],
      additionalProperties: false,
    },
  },
  {
    name: "list_archived",
    description: "列出本机已归档的试验记录（登记号、题目、状态、药物、适应症）。查本机有什么，不联网。",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "只看某个检索关键词下的归档。" },
        limit: { type: "integer", description: "每个关键词最多返回多少条，默认 50。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "verify_archive",
    description:
      "核对归档完整性：逐条检查登记号是否都有原始 HTML、结构化 JSON、平台原样 Word 与响应留档。抓取收尾或怀疑缺文件时用。",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "要核对的关键词目录，省略则取第一个归档目录。" },
      },
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  get_collector_status: toolGetCollectorStatus,
  setup_environment: toolSetupEnvironment,
  update_cookie: toolUpdateCookie,
  search_trials: toolSearchTrials,
  sync_incremental: toolSyncIncremental,
  get_trial_detail: toolGetTrialDetail,
  list_archived: toolListArchived,
  verify_archive: toolVerifyArchive,
};

// ──────────────────────────────────────────────
// JSON-RPC over stdio
// ──────────────────────────────────────────────

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      sendResult(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "chinadrugtrials-mcp", version: "0.1.0" },
        instructions:
          "中国药物临床试验登记与信息公示平台的本地采集与归档。抓取需要本人浏览器会话（update_cookie）。" +
          "参考：本来源覆盖中国药物注册临床试验，与 ChiCTR、Veeva CTV、ClinicalTrials.gov 口径不同，结果不可混算。",
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return;
    case "ping":
      if (!isNotification) sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) {
        sendError(id, -32602, `unknown tool: ${name}`);
        return;
      }
      try {
        const payload = await handler(params?.arguments ?? {});
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          isError: payload?.ok === false,
        });
      } catch (error) {
        log(`tool ${name} failed: ${error?.stack ?? error}`);
        sendResult(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: String(error?.message ?? error) },
                null,
                2,
              ),
            },
          ],
          isError: true,
        });
      }
      return;
    }
    default:
      if (!isNotification) sendError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * 分帧：MCP 标准是行分隔 JSON；少数客户端用 Content-Length 头。
 * 这里同时支持两种，避免因为分帧差异被当成「服务起不来」。
 */
function startTransport() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let framed = null; // null=未判定, true=Content-Length 帧, false=行分隔
  let buffer = Buffer.alloc(0);
  // 抓取类工具要跑几十秒到几分钟。输入流先关时必须等这些任务收尾，
  // 否则会把「结果还没写出去」当成正常退出——表现就是调用方收到空响应。
  let pending = 0;
  let inputClosed = false;
  const maybeExit = () => {
    if (inputClosed && pending === 0) process.exit(0);
  };

  const deliver = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      log("dropped malformed message");
      return;
    }
    pending += 1;
    handle(message)
      .catch((error) => log(`handler error: ${error?.stack ?? error}`))
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
  };

  rl.on("line", (line) => {
    if (framed === null) framed = /^content-length:/i.test(line);
    if (!framed) {
      deliver(line);
      return;
    }
    buffer = Buffer.concat([buffer, Buffer.from(`${line}\n`, "utf8")]);
    const asText = buffer.toString("utf8");
    const match = asText.match(/content-length:\s*(\d+)\r?\n\r?\n/i);
    if (!match) return;
    const headerEnd = match.index + match[0].length;
    const length = Number(match[1]);
    const body = Buffer.from(asText.slice(headerEnd), "utf8");
    if (body.length < length) return;
    deliver(body.subarray(0, length).toString("utf8"));
    buffer = Buffer.from(body.subarray(length), "utf8");
  });

  rl.on("close", () => {
    inputClosed = true;
    maybeExit();
  });
}

async function main() {
  await ensureDirs();
  log(`started; plugin=${PLUGIN_DIR}; data=${DATA_DIR}`);
  startTransport();
}

main().catch((error) => {
  log(`fatal: ${error?.stack ?? error}`);
  process.exit(1);
});
