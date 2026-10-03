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

/**
 * 归档根目录（可配置）。
 *
 * 默认 ~/.xyb-chinadrugtrials，与采集器「--output 后再拼 /<关键词>/」的结构保持一致。
 * 允许用环境变量 XYB_CHINADRUCTRIALS_DATA_DIR 指到别处：既有用户手上往往已经有一份
 * 采集器跑出来的归档，硬编码会让 MCP 读到一个空目录并报「本机还没有归档记录」——
 * 那种「静默读空」会被患者读成「没有相关试验」，比报错更危险。
 */
const DATA_DIR = (() => {
  const override = process.env.XYB_CHINADRUCTRIALS_DATA_DIR;
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim(), "").replace(/[/\\]+$/, "");
  }
  return path.join(os.homedir(), ".xyb-chinadrugtrials");
})();
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

/**
 * 采集器脚本本身是否随包存在。
 *
 * 必须单独检查：`checkCollectorDeps` 只探测 venv 里的 Python 包能不能 import，
 * 它无法发现「采集器脚本不在磁盘上」——那种情况下依赖探测照样返回 ok，
 * 体检报告会说「一切就绪」，直到真正调用 search_trials 才以 ENOENT 失败。
 * 把 MCP 单独发布成 npm 包、或插件目录被裁剪时就会踩到这个坑。
 */
async function checkCollectorFiles() {
  const required = { scraper: SCRAPER, verifier: VERIFIER, requirements: REQUIREMENTS, cookie_tools: COOKIE_TOOLS };
  const missing = [];
  for (const [label, file] of Object.entries(required)) {
    try {
      await fsp.access(file, fs.constants.R_OK);
    } catch {
      missing.push(label);
    }
  }
  return { ok: missing.length === 0, missing, dir: COLLECTOR_DIR };
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

const COOKIE_TOOLS = path.join(COLLECTOR_DIR, "scripts", "cookie_tools.py");

/**
 * 让站点重新下发反爬 Cookie 并合并进本机 config.json。
 *
 * 只调用采集器自带的 cookie_tools.py（已测过的合并逻辑），不在这里重写解析：
 * 合并策略是「站点下发的同名字段覆盖」，浏览器登录态字段一律保留，
 * 因此不会把用户本人的会话清掉，也不生成、不猜测任何凭据。
 *
 * 失败一律降级为结果对象，不抛异常——刷新失败不该让 MCP 起不来；
 * 真正过期时由 runScrape 的挑战页分支给出可执行提示。
 */
async function refreshBootstrapCookie({ python } = {}) {
  const interpreter = python ?? (await resolvePython());
  if (!interpreter) return { ok: false, error: "本机没有可用的 python3。" };
  try {
    await fsp.access(COOKIE_TOOLS, fs.constants.R_OK);
  } catch {
    return { ok: false, error: "采集器里没有 cookie_tools.py，无法刷新。" };
  }

  const result = await run(
    interpreter.command,
    [COOKIE_TOOLS, "--config", CONFIG_PATH],
    { timeoutMs: 60000 },
  );
  const line = `${result.stdout}`
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("{"))
    .pop();
  if (!line) {
    return {
      ok: false,
      error: "刷新没有返回可解析结果。",
      log_tail: `${result.stdout}${result.stderr}`.trim().slice(-400),
    };
  }
  try {
    const parsed = JSON.parse(line);
    // 只回传字段名与掩码状态，绝不回传 Cookie 值。
    delete parsed.cookies;
    parsed.fields = parsed.merged_fields?.length ? parsed.merged_fields : parsed.fetched_fields ?? [];
    delete parsed.merged_fields;
    return parsed;
  } catch (err) {
    return { ok: false, error: `刷新结果解析失败：${err.message}` };
  }
}

/**
 * 启动时的静默刷新：只在已经配置过会话时才动 config.json。
 *
 * 没配置过就不该凭空写出一份「看起来已配置」的会话文件，否则 readiness 会失真。
 */
async function maybeRefreshCookieOnStart() {
  const config = await readConfig();
  const configured = typeof config.cookies === "string" && config.cookies.trim().length > 0;
  if (!configured) return { skipped: true, reason: "尚未配置会话，启动时不刷新。" };
  const result = await refreshBootstrapCookie();
  log(`startup cookie refresh: ${result.ok ? "ok" : "failed"} fields=${(result.fields ?? []).join(",")}`);
  return result;
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

/**
 * 从 full_text 里恢复「各参加机构信息」表。
 *
 * 为什么不能直接用 sections['2、各参加机构信息']：采集器的 _extract_table_kv
 * 对「列数为偶数」的行会按 (cells[0],cells[1])、(cells[2],cells[3])… 机械配对，
 * 这张表是 6 列（序号|机构名称|主要研究者|国家或地区|省（州）|城市），于是整表错位一格：
 * 表头变成 {'序号':'机构名称','主要研究者':'国家或地区','省（州）':'城市'}，
 * 数据行变成 {'1':'复旦大学附属肿瘤医院','虞先濬':'中国','上海市':'上海市'}……
 * 更糟的是字典键会互相覆盖（多个机构同省），38 家的省市只剩 19 个 —— 数据在 JSON 里已丢失。
 *
 * full_text 是单元格逐个按序拼接的纯文本，**没有去重也没有错位**，因此可以无损还原。
 * 这里按「表头 6 个已知列名」定位起点，再按 6 个一格切分。
 */
const INSTITUTION_HEADER = ["序号", "机构名称", "主要研究者", "国家或地区", "省（州）", "城市"];
const INSTITUTION_SECTION_LABEL = "各参加机构信息";
const INSTITUTION_STOP_LABELS = ["五、伦理委员会信息", "伦理委员会信息", "六、试验状态信息"];

function parseInstitutions(fullText) {
  const text = typeof fullText === "string" ? fullText : "";
  if (!text) return [];

  // 以「各参加机构信息」为锚点，避免命中其它含相同列名的表。
  const anchor = text.indexOf(INSTITUTION_SECTION_LABEL);
  const from = anchor >= 0 ? anchor : 0;

  // 表头出现的位置（按 6 个列名连续出现判定）。
  const headerIndex = text.indexOf(INSTITUTION_HEADER.join("\n"), from);
  let cells = null;
  if (headerIndex >= 0) {
    cells = text.slice(headerIndex + INSTITUTION_HEADER.join("\n").length).split("\n");
  } else {
    // 换行不规范时退回逐行匹配列名。
    const lines = text.slice(from).split("\n");
    const start = lines.findIndex((line) => INSTITUTION_HEADER.every((h) => text.includes(h)));
    if (start < 0) return [];
    const headerPos = lines.indexOf(INSTITUTION_HEADER[0], start);
    cells = lines.slice(headerPos + INSTITUTION_HEADER.length);
  }

  // 表头之后紧跟换行，split 会先产生一个空串，必须丢掉，否则第一格不是序号。
  const rows = [];
  const trimmedCells = (cells ?? []).map((s) => s.trim());
  const firstSeq = trimmedCells.findIndex((s) => /^\d+$/.test(s));
  if (firstSeq < 0) return [];
  for (
    let i = firstSeq;
    i + INSTITUTION_HEADER.length <= trimmedCells.length;
    i += INSTITUTION_HEADER.length
  ) {
    const chunk = trimmedCells.slice(i, i + INSTITUTION_HEADER.length);
    const [seq, name, researcher, country, province, city] = chunk;
    // 序号必须是纯数字，否则说明已经走出这张表了。
    if (!/^\d+$/.test(seq)) break;
    // 遇到下一章节标题就停（原文里紧跟在表尾）。
    if (INSTITUTION_STOP_LABELS.some((label) => chunk.some((c) => c.includes(label)))) break;
    if (!name) break;
    rows.push({
      seq: Number(seq),
      机构名称: name,
      主要研究者: researcher ?? "",
      国家或地区: country ?? "",
      省: province ?? "",
      城市: city ?? "",
    });
  }
  return rows;
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

  // 缺陷 1：details/各章节里的「申请人名称」可能是占位符（实测为 '1'）。
  // 真值在 sections['基本信息']['申请人名称']，占位符不能当成机构名返回给患者。
  const applicantCandidates = [
    sections["基本信息"]?.["申请人名称"],
    sections["二、申请人信息"]?.["申请人名称"],
    data.details?.["申请人名称"],
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v && !/^\d+$/.test(v) && v !== "1");
  const applicantName = applicantCandidates[0] ?? "";
  if (applicantName) flat["申请人名称"] = applicantName;
  else delete flat["申请人名称"];

  // 缺陷 2：机构表错位。优先用从 full_text 无损还原的结果；
  // 还原不出来就如实说明，绝不用错位数据糊弄。
  const institutions = parseInstitutions(data.full_text);
  const institutionNote = institutions.length
    ? `已从 full_text 还原 ${institutions.length} 家机构（结构化 sections 中的该表键值错位，未采用）。`
    : "未能从归档文本中还原参加机构表；结构化 sections 中的该表存在列错位，不可直接使用。";

  const out = {
    reg_no: data.reg_no ?? "",
    title: list.title ?? "",
    state: list.state ?? "",
    drug_name: list.drug_name ?? "",
    indication: list.indication ?? "",
    applicant_name: applicantName,
    scraped_applicant_name: data.details?.["申请人名称"] ?? "",
    scrape_time: data.scrape_time ?? "",
    detail_url: data.source?.detail_url ?? "",
    raw_html_path: data.source?.raw_html_path ?? "",
    section_names: sectionNames,
    institution_count: institutions.length,
    institution_note: institutionNote,
    institutions,
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
  const files = await checkCollectorFiles();
  // 采集器脚本缺失时不必再探依赖：装了包也没东西可跑，报「依赖 ok」只会误导。
  const deps = files.ok ? await checkCollectorDeps(python) : { ok: false, missing: [], skipped: "采集器脚本缺失，未探测依赖" };
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
  if (!files.ok) {
    nextSteps.push(
      `采集器脚本缺失（${files.missing.join("、")}），路径 ${files.dir}。` +
        "这个 MCP 需要同目录下的 collectors/chinadrugtrials/scripts/ 才能抓取；" +
        "只读已归档数据不受影响，但要联网同步必须先补齐采集器（重新安装插件或把插件目录完整取回）。",
    );
  }
  if (!python) {
    nextSteps.push(
      "本机没有可用的 python3。macOS 可执行 xcode-select --install 安装命令行工具；也可以从 python.org 安装后重试。",
    );
  } else if (files.ok && !deps.ok) {
    nextSteps.push("采集器依赖未装齐，调用 setup_environment 一次性安装（需要联网）。");
  }
  if (!configured) {
    nextSteps.push(
      "还没有配置会话。请在浏览器打开平台并完成正常访问，用开发者工具对站内请求「复制为 cURL」，再调用 update_cookie。",
    );
  }

  // 方案 C：归档为空时给出一次可执行的首次同步计划，但不自动抓取——抓取有归档副作用、
  // 有被站点判挑战页的风险，必须由人决定。
  //
  // 触发条件刻意放宽：只要求「归档为空 + 采集器在 + python 在」，**不要求已配置会话**。
  // 全新部署时恰恰还没有 cookie，若把 cookie 当门槛，最需要引导的新用户反而看不到提示。
  // 会话未配置时用 blockers 如实说明「先配会话」，而不是干脆不给计划。
  let bootstrapPlan = null;
  const canScrape = Boolean(python && files.ok);
  if (canScrape && archive.length === 0) {
    const defaultKeywords = ["胰腺癌", "实体瘤"];
    const blockers = [];
    if (!configured) blockers.push("尚未配置会话（cookies）");
    if (!deps.ok) blockers.push(`采集器依赖未装齐（缺少 ${deps.missing.join("、") || "未知"}）`);
    bootstrapPlan = {
      reason: "本机还没有任何归档，所以现在查询只会返回「没有归档」而不是试验结果。",
      ready_to_run: blockers.length === 0,
      blockers,
      suggested_call: {
        tool: "search_trials",
        arguments: { keywords: defaultKeywords.join(","), max_pages: 2, incremental: true },
      },
      keywords: defaultKeywords,
      estimated_note:
        "每个关键词独立翻页，站点限速约 1.5 秒/条；两个关键词、每词 2 页（约 20 条）通常几分钟内完成。",
      after: "同步完成后用 list_archived 看归档条目，再用 get_trial_detail 取单条详情。",
      important:
        "不会自动执行。抓取会在本机落盘原始 HTML/JSON/Word，请确认后再调用；换更宽或更窄的关键词由你决定。",
    };
    const lead = blockers.length
      ? `本机还没有归档，且还不能抓取（${blockers.join("；")}）。`
      : "本机还没有归档。";
    nextSteps.push(
      `${lead}补齐后调用 search_trials（keywords: ${defaultKeywords.join(",")}）做一次首次同步，否则任何查询都只会是「归档为空」。`,
    );
  }

  // ready 只表示「能立刻抓取」，语义收紧到与 bootstrap_plan.ready_to_run 一致，
  // 避免「ready: true 但一调 search_trials 就报错」这种自相矛盾的状态。
  const ready = Boolean(python && files.ok && deps.ok && configured);

  return {
    ok: true,
    ready,
    python: python
      ? { available: true, command: python.command, version: python.version, from_venv: python.fromVenv }
      : { available: false },
    collector_files: files,
    collector_deps: deps,
    cookie: {
      configured,
      updated_at: config.cookie_updated_at ?? null,
      note: configured
        ? "已配置。启动时会自动刷新站点下发的反爬字段；登录态本身过期后仍需你本人重新从浏览器复制 cURL，工具无法代替你登录。"
        : "未配置。",
    },
    data_dir: DATA_DIR,
    archive,
    bootstrap_plan: bootstrapPlan,
    // 只读可用性与抓取可用性分开说：归档非空时即便不能抓，查询/详情仍完全可用。
    quote_read_available: archive.length > 0,
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

/**
 * 把用户输入拆成关键词列表。
 *
 * 采集器一次只处理一个关键词，并且**用关键词拼目录名**（scraper.py 的 safe_kw），
 * 所以整串当参数传下去只会得到一个 `胰腺癌_实体瘤` 目录，而不是两份归档。
 * 这里必须逐个关键词分别调用采集器，才能得到「胰腺癌」「实体瘤」两个独立归档。
 */
function parseKeywords(input) {
  const parts = Array.isArray(input) ? input : String(input ?? "").split(/[,，、;；\s]+/);
  const out = [];
  for (const part of parts) {
    const value = String(part ?? "").trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

const MAX_KEYWORDS = 8;

async function toolSearchTrials(args) {
  const keywords = parseKeywords(args?.keywords);
  if (!keywords.length) keywords.push("胰腺癌");
  if (keywords.length > MAX_KEYWORDS) {
    return {
      ok: false,
      error: `一次最多同步 ${MAX_KEYWORDS} 个关键词，收到 ${keywords.length} 个。请分批调用。`,
      keywords,
    };
  }

  const incremental = Boolean(args?.incremental);
  const maxPages = args?.max_pages ?? 2;

  // 单关键词：保持原有返回形状，调用方不必区分。
  if (keywords.length === 1) {
    return runScrape({ keywords: keywords[0], args, incremental, maxPages });
  }

  const results = [];
  for (const keyword of keywords) {
    // 逐词串行：站点有频率限制，并发会更容易被判成挑战页。
    const result = await runScrape({ keywords: keyword, args, incremental, maxPages });
    results.push({
      keywords: keyword,
      ok: Boolean(result.ok),
      total_records: result.total_records ?? 0,
      archived_records: result.archived_records ?? 0,
      archive_dir: result.archive_dir ?? "",
      error: result.ok ? undefined : result.error,
      hint: result.ok ? undefined : result.hint,
    });
    // 某个词失败不中断其余词。
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    multi: true,
    keywords,
    succeeded: succeeded.length,
    failed: failed.length,
    total_records: results.reduce((sum, r) => sum + r.total_records, 0),
    archived_records: results.reduce((sum, r) => sum + r.archived_records, 0),
    results,
    notice:
      failed.length === 0
        ? `已逐个关键词归档到各关键词目录下（共 ${succeeded.length} 个）。`
        : `${succeeded.length} 个关键词成功、${failed.length} 个失败。失败的关键词本次没有归档，这${"不等于"}其中没有相关试验——请按各条 hint 处理后重试。`,
    disclaimer: DISCLAIMER,
  };
}

async function toolRefreshCookie() {
  const config = await readConfig();
  const configured = typeof config.cookies === "string" && config.cookies.trim().length > 0;
  if (!configured) {
    return {
      ok: false,
      error:
        "还没有配置会话，刷新无从下手。请先在浏览器正常访问平台，对站内请求「复制为 cURL」，用 update_cookie 存一次；之后再靠刷新维持。",
    };
  }
  const python = await resolvePython();
  const result = await refreshBootstrapCookie({ python });
  return {
    ok: Boolean(result.ok),
    fields: result.fields ?? [],
    preserved_fields: result.preserved_fields ?? [],
    written: Boolean(result.written),
    fetched_at: new Date().toISOString(),
    message: result.ok
      ? "已刷新站点下发的反爬字段，本人登录态字段保持不变。若检索仍返回空或跳验证页，说明登录态本身已过期，需要本人重新复制 cURL。"
      : "刷新失败。这不影响已保存的会话，也不代表没有相关试验。",
    error: result.error,
    disclaimer: DISCLAIMER,
  };
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
  const missingDirs = [];
  let total = 0;
  let returned = 0;
  for (const dir of dirs) {
    const { total: count, trials } = await readTrialsFromDir(dir, limit);
    // 「目录不存在」与「目录存在但 0 条」必须分开：前者说明关键词拼不出本机任何一个
    // 归档目录（如手抄了别的工具的目录名），后者才是真的空归档。混为一谈会让调用方
    // 把「路径根本不对」误读成「这个关键词确实没有试验」。
    if (keyword && count === 0 && !fs.existsSync(dir)) missingDirs.push(dir);
    total += count;
    returned += trials.length;
    result.push({ keyword: path.basename(dir), records: count, trials });
  }
  if (!result.length) {
    return { ok: false, error: "本机还没有归档记录。请先调用 search_trials。" };
  }
  const base = {
    ok: true,
    total_records: total,
    returned_records: returned,
    archives: result,
    disclaimer: DISCLAIMER,
  };
  if (missingDirs.length) {
    return {
      ...base,
      matched_archive: false,
      warning:
        `没有名为「${path.basename(missingDirs[0])}」的归档目录，所以这里返回的 0 条**不是**` +
        `「该关键词没有试验」。先用不带 keywords 的调用看本机实际有哪些归档目录，` +
        `再按目录名（而非你记忆中的关键词）过滤。`,
    };
  }
  // 截断必须说出来。此前只回 records/trials 两个数，调用方无法区分「总共就 50 条」
  // 与「139 条里只给了前 50 条」——实测 IBI343 的 CTR20252528 排在第 114 位，
  // 默认 limit=50 时患者按药名翻归档会得到「没有」这个错误结论。
  const truncated = returned < total;
  return {
    ...base,
    truncated,
    ...(truncated
      ? {
          truncation_note:
            `每个关键词只返回前 ${limit} 条，本次共 ${total} 条、已返回 ${returned} 条，` +
            `**还有 ${total - returned} 条没有显示**。不要据此判断「没有相关试验」；` +
            `请提高 limit（如 limit: ${total}）重取，或用 keywords 缩小到具体关键词。`,
          suggested_limit: total,
        }
      : {}),
  };
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
    description: `看这个来源现在能不能用：Python 环境、采集器脚本与依赖是否齐全、会话是否已配置、本机归档了多少条。排障时先调它，不要靠猜。
字段含义：ready 表示「现在就能抓取」；quote_read_available 表示「已归档数据可读」（两者独立——归档非空时即使不能抓，查询与详情仍完全可用）；collector_files 是采集器脚本是否随包存在；bootstrap_plan 在归档为空时给出首次同步计划及其 blockers（不会自动执行）。${DISCLAIMER}`,
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
        keywords: {
          type: "string",
          description:
            "关键词，例如「胰腺癌」「KRAS」。多个关键词用逗号分隔（如「胰腺癌,实体瘤」），会逐个关键词分别抓取并各自归档到一个目录。默认「胰腺癌」。",
        },
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
    name: "refresh_cookie",
    description: `刷新平台下发的反爬 Cookie（FSSBBIl 系）并合并进本机会话文件。只更新站点自己下发的字段，本人登录态字段一律保留，不生成、不猜测任何凭据，也不会绕过站点验证。会话彻底过期（被重定向到登录/验证页）时这个工具救不回来，仍需本人重新「复制为 cURL」再调 update_cookie。`,
    inputSchema: {
      type: "object",
      properties: {},
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
    description: `从本机归档里按登记号取一条试验的完整详情（含各章节字段）。归档里没有就明确说没有，不会去联网现抓——需要现抓请先调 search_trials。
返回里 applicant_name 是申请人（申办方）名称，已避开采集时可能写入的占位符；scraped_applicant_name 是归档原值，仅供排查。
institutions 是参加机构列表（序号/机构名称/主要研究者/国家或地区/省/城市），已从归档正文按列还原——结构化 sections 里那张表的键值存在列错位，不要直接引用 sections 中的该表。
注意：「主要研究者信息」里的电话/邮箱属于研究者本人，不是申办方联系人，引用时不要混为一谈。${DISCLAIMER}`,
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
    description:
      "列出本机已归档的试验记录（登记号、题目、状态、药物、适应症）。查本机有什么，不联网。" +
      "注意：每个关键词默认只返回前 50 条；被截断时结果含 truncated=true、truncation_note 与 suggested_limit，" +
      "**不得**把「没有显示」当作「没有相关试验」——务必按 suggested_limit 重取，或用 keywords 缩小到具体关键词。",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "只看某个检索关键词下的归档。" },
        limit: { type: "integer", description: "每个关键词最多返回多少条，默认 50。结果会如实标注是否被截断。" },
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
  refresh_cookie: toolRefreshCookie,
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
  // 先开会话再刷新：刷新可能耗时数秒，不能让它挡住 JSON-RPC 通道的可用性。
  startTransport();
  maybeRefreshCookieOnStart().catch((error) => log(`startup refresh error: ${error?.message ?? error}`));
}

/**
 * 纯函数出口，供回归测试直接调用（不含网络、磁盘与传输层副作用）。
 * 生产路径不读这个对象。
 */
export const _internals = {
  parseInstitutions,
  summarizeDetail,
  parseKeywords,
  INSTITUTION_HEADER,
};

// 只有作为 MCP 服务器直接运行时才启动传输层。被测试 import 时不启动，
// 否则一次 import 就会挂住 stdin 事件循环。
//
// 注意必须比较 realpath：macOS 的 /tmp 是 /private/tmp 的软链接，npm link、
// 符号链接安装、或经 /tmp 中转启动时，argv[1] 与 import.meta.url 只在字面上
// 不同（/tmp/x vs /private/tmp/x）。只比字面量会判定 isDirectRun=false，
// 结果是**进程静默退出、exit 0、没有任何报错**——宿主只看到 MCP 起不来。
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const samePath = (a, b) => {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return false;
    }
  };
  try {
    const entryPath = path.resolve(entry);
    if (import.meta.url === new URL(`file://${entryPath}`).href) return true;
    return samePath(entryPath, fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    log(`fatal: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
