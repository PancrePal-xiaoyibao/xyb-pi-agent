/**
 * 小胰宝 · 中国与区域试验来源（xyb.trial-sources）
 *
 * 职责：把**中国与区域临床试验数据源**以 MCP 服务的形式绑定进应用。
 * 边界：本插件自身不读写患者文件、不发网络请求。
 *       - 联网检索由 MCP 服务（chictr / veeva-ctv / chinadrugtrials）在各自进程内完成；
 *       - 药品说明书、诊疗规范等由助手按技能文档自行处理。
 *       所以权限只要 ui.view + mcp.server.local，不申请 fs / net.fetch；
 *       唯一例外是启动时把随包分发的 Veeva 种子索引复制到用户目录（见 ensureVeevaSeed），
 *       那是本机文件复制，不经宿主 fs API（二进制、50MB，宿主 API 只收字符串）。
 *
 * 为什么单独成插件而不是并进 xyb.trials：
 *   mcp.server.local 属高风险权限（会拉起本地进程）。xyb.trials 是默认可用、
 *   零配置的核心来源，不应被高风险权限拖累。独立成插件后，
 *   **插件是否启用本身就是用户的授权动作**，不想要本地进程的患者永远不必接受。
 *
 * 前置条件（重要，未满足时对应来源不可用，界面与技能文档都如实标注）：
 *   - chictr          ：`npx -y chictr-mcp-server@3.0.2`（注入 CHICTR_USE_SIDECAR=1）。
 *                       首次使用需联网拉取 npm 包，并需要 **Python 3.10+ 与约 1GB 运行时**
 *                       （Python 依赖装进自举 venv 约 325MB；浏览器内核约 557MB 在
 *                       ~/Library/Caches/ms-playwright）。服务自带 `check_environment`
 *                       只读体检，调用检索前应先看它。正常路径下站点挑战由 sidecar 自动
 *                       解开、无需人工；Node 侧 Playwright 内核不需要下载（仅回退路径用）。
 *   - veeva-ctv       ：用 `npx -y ctv-mcp-server@0.1.0` 拉起，**开箱即有本地索引**
 *                       （随包分发的种子索引在首次启动时复制到 ~/.ctv-mcp/ctv.db）。
 *                       用户可自行刷新；刷新结果保存在同一位置，不会被种子覆盖。
 *   - chinadrugtrials ：本插件自带采集器与 MCP 服务，但需要 ①本机 Python 3
 *                       ②采集器依赖（可由 setup_environment 工具一键准备）
 *                       ③**本人浏览器会话**（必须在浏览器里正常访问站点后复制 cURL）。
 *                       数据落在 ~/.xyb-chinadrugtrials/，凭据只在本机、权限 0600。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DISCLAIMER =
  "以下为公开试验登记信息的整理，供参考，不能替代医生判断，也不构成入组建议或用药建议。";

/**
 * Veeva CTV 种子数据。
 *
 * 应用随包分发一份只读的本地索引（`data/ctv.db`）。**不能直接用它**：安装到
 * `/Applications` 后普通用户对该目录没有写权限，用户一旦跑刷新（sync_sitemap
 * / backfill_details）就会失败。
 *
 * 所以首次启动时把种子复制到用户可写的 `~/.ctv-mcp/ctv.db`，之后 ctv-mcp-server
 * 一律读写那份。种子只在**目标不存在**时复制 —— 已经存在的库（用户的刷新结果）
 * 永远不被覆盖。
 *
 * 为什么可以 require("node:fs")：插件 main.js 由宿主用 createRequire 作为真实
 * Node 模块加载（plugin-host-process.mjs 的 loadPluginModule），pi.file-manager
 * 已有同样用法。复制 50MB 二进制走 pi.fs.writeText 是不可能的（它只收字符串）。
 */
const SEED_DB = path.join(__dirname, "data", "ctv.db");

function defaultVeevaDir() {
  return path.join(os.homedir(), ".ctv-mcp");
}

/**
 * 把随包分发的 Veeva 索引复制到用户数据目录。
 *
 * 只做「不存在才复制」，因此可以安全地在每次 onLoad 调用：
 *   - 已有本地库（用户刷新过）→ 什么都不做
 *   - 全新安装 → 复制种子，用户开箱即可检索
 *   - 没有种子（开发态 / 装包时未带 data）→ 静默跳过，不报错
 *
 * 失败不抛错：这是优化路径，不应阻断插件加载。返回结构化结果供面板展示。
 */
async function ensureVeevaSeed(options = {}) {
  const dirSetting = String(options.dataDir ?? "").trim();
  const targetDir = dirSetting || defaultVeevaDir();
  const targetDb = path.join(targetDir, "ctv.db");

  if (!fs.existsSync(SEED_DB)) {
    return { ok: false, reason: "NO_SEED", seedPath: SEED_DB, targetDb };
  }
  if (fs.existsSync(targetDb)) {
    return { ok: true, reason: "ALREADY_PRESENT", targetDb };
  }

  try {
    await fsp.mkdir(targetDir, { recursive: true });
    // 先写临时文件再改名：复制中途失败不会留下半个库冒充完整索引。
    const tmp = `${targetDb}.seed-tmp`;
    await fsp.copyFile(SEED_DB, tmp);
    await fsp.rename(tmp, targetDb);
    return { ok: true, reason: "SEEDED", targetDb };
  } catch (error) {
    return { ok: false, reason: "COPY_FAILED", targetDb, error: error?.message ?? String(error) };
  }
}

const CHICTR_PACKAGE = "chictr-mcp-server@3.0.2";
const CHICTR_SETUP_COMMAND = `npx -y -p ${CHICTR_PACKAGE} chictr-setup setup --browser`;

/**
 * ChiCTR 冷启动种子（`data/chictr/pancreatic_trials.json`）。
 *
 * 与 Veeva 种子同构：随包分发一份只读快照，首启复制到用户可写的
 * `~/.xyb-chictr/`，用户本机运行库永远优先。
 *
 * **这份种子只覆盖胰腺癌。** 抓取脚本 `tools/chictr_crawl.py` 的 `KEYWORD`
 * 固定为「胰腺癌」，468 条全部是胰腺癌相关登记。因此：
 *   - 命中时可以说「本地快照里有」；
 *   - 0 命中时**只能说「本地快照中未命中」**，绝不能说「没有相关试验」——
 *     其他癌种压根不在快照里，必须联网查。
 * 这条限制通过 `coverage_note` 随种子一起分发，并由技能文档强制表述。
 */
const SEED_CHICTR = path.join(__dirname, "data", "chictr", "pancreatic_trials.json");

/**
 * CDE 冷启动种子（`data/chinadrugtrials/`，一记录一 JSON + `index.json`）。
 *
 * 同上：只含胰腺癌，139 条。运行时目录 `~/.xyb-chinadrugtrials/archive/`，
 * 采集器写入、MCP 只读。种子只在目标不存在时复制。
 */
const SEED_CDE_DIR = path.join(__dirname, "data", "chinadrugtrials");

/**
 * WHO ICTRP 冷启动快照（`data/ictrp/pancreatic-cancer.json`，6262 条）。
 *
 * 与其他两个种子**性质不同**，必须说清楚：
 *
 *   - ChiCTR / CDE 的种子是**离线兜底**——联网查不到时本地还能给出东西。
 *   - ICTRP 的种子是**加速 + 省上游负载**：`ictrp_search` 联网时本来就会把整个
 *     结果集物化到本机缓存，这份快照只是预先算好的那一份。所以它**不改变契约**：
 *     命中快照时服务仍然区分 `matched_rows_returned`（实得）与
 *     `upstream_reported_total`（上游自报），下界语义照旧。
 *
 * **它有保质期。** 快照超过 28 天（`ICTRP_BUNDLE_MAX_AGE_DAYS`，WHO 每周更新）
 * 服务会把它标成 `snapshot_stale` 并附警告。这不是可以忽略的提示，是数据可信度
 * 的边界——界面与技能文档都要如实呈现。
 *
 * ## WHO 条款（用户 2026-10-04 决策：随包分发）
 *
 * WHO 条款第 4.b 要求标注来源并**清晰显示 WHO 处理该数据的日期**，第 4.c/4.d
 * 禁止主张专有权利与商业用途。上游集成文档原本判断不得随包分发，用户明确决策
 * 接受该风险。因此这份种子的 `attribution` / `terms_notice` / `ictrp_export_date`
 * **一个都不能裁**，UI 也必须显示来源与处理日期。见 SPEC §15.7。
 */
const SEED_ICTRP = path.join(__dirname, "data", "ictrp", "pancreatic-cancer.json");

/** ICTRP 快照的关键词。服务按 slug 匹配（`pancreatic-cancer`），不匹配就不服务。 */
const ICTRP_SEED_KEYWORD = "pancreatic cancer";

function defaultChictrDir() {
  return path.join(os.homedir(), ".xyb-chictr");
}

function defaultCdeDir() {
  // CDE MCP reads one keyword archive from
  // ~/.xyb-chinadrugtrials/output/<keyword>/json/.  The seed must land in that
  // exact reader path: copying it into a sibling `archive/` directory merely
  // makes the files exist without making a single cold-start result queryable.
  return path.join(os.homedir(), ".xyb-chinadrugtrials", "output", "胰腺癌", "json");
}

/**
 * ICTRP 快照的运行时目录。
 *
 * 快照不是「用户的数据」，是**随包资源**。服务通过 `ICTRP_BUNDLE_PATH` 指到它
 * 所在的位置读取；不复制到用户目录，因为快照是只读的构建产物，用户不会修改它，
 * 复制只是浪费几十 MB。
 *
 * 但用户可能想要一份自己的（比如换了关键词重跑），所以仍给一个可覆盖的目录：
 * 插件把它交给 `ictrpSeedDir` setting，运行时通过 `ICTRP_BUNDLE_DIR` 生效。
 */
function defaultIctrpDir() {
  return path.join(os.homedir(), ".xyb-ictrp");
}

/**
 * 通用种子复制：目录级、不存在才复制、失败不抛错。
 *
 * 与 `ensureVeevaSeed` 同构，但作用于「若干文件」而非单个二进制。复制前先写
 * `<目标>.seed-tmp` 再 rename —— 与 Veeva 一致，半个种子不得冒充完整种子。
 *
 * 返回结构化结果而不是抛错：种子复制是优化路径，失败不能阻断插件加载。
 */
async function ensureJsonSeed(options) {
  const { seedPath, targetDir, label } = options;

  if (!fs.existsSync(seedPath)) {
    return { ok: false, reason: "NO_SEED", label, seedPath, targetDir };
  }
  if (fs.existsSync(targetDir)) {
    // 目录已存在即视为「用户已有自己的数据」——可能是种子复制的，也可能是
    // 用户自己抓的更全的归档。两种情况都不覆盖。
    return { ok: true, reason: "ALREADY_PRESENT", label, targetDir };
  }

  try {
    await fsp.mkdir(targetDir, { recursive: true });
    const stat = await fsp.stat(seedPath);

    if (stat.isDirectory()) {
      const entries = await fsp.readdir(seedPath);
      for (const entry of entries) {
        const src = path.join(seedPath, entry);
        const dest = path.join(targetDir, entry);
        const tmp = `${dest}.seed-tmp`;
        await fsp.copyFile(src, tmp);
        await fsp.rename(tmp, dest);
      }
      return { ok: true, reason: "SEEDED", label, targetDir, files: entries.length };
    }

    const dest = path.join(targetDir, path.basename(seedPath));
    const tmp = `${dest}.seed-tmp`;
    await fsp.copyFile(seedPath, tmp);
    await fsp.rename(tmp, dest);
    return { ok: true, reason: "SEEDED", label, targetDir, files: 1 };
  } catch (error) {
    return {
      ok: false,
      reason: "COPY_FAILED",
      label,
      targetDir,
      error: error?.message ?? String(error),
    };
  }
}

/** ChiCTR 种子读取：给出条数与覆盖范围，供界面如实标注「只有胰腺癌」而不假装是全量。 */
function readChictrSeedMeta() {
  if (!fs.existsSync(SEED_CHICTR)) return null;
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_CHICTR, "utf8"));
    return {
      recordCount: seed.record_count ?? (Array.isArray(seed.records) ? seed.records.length : 0),
      keyword: seed.keyword ?? "",
      builtAt: seed.built_at ?? "",
      coverageNote: seed.coverage_note ?? "",
    };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

/**
 * ICTRP 种子元数据。
 *
 * 与 ChiCTR 的读取不同，这里**必须**把 WHO 归因与 WHO 处理日期一并取出：
 * 条款第 4.b 要求「清晰显示 WHO 处理该数据的日期」，界面没有这个字段就违规。
 * 同理 `upstream_reported_total`（6952）与实得条数（6262）都要带上——
 * 这两个数字分开呈现是这份数据的核心事实，不能被合并成一个「6262 条」。
 *
 * 年龄在读取时现算而不是用文件里的时间戳，因为「陈旧」是相对当下的判断。
 */
function readIctrpSeedMeta() {
  if (!fs.existsSync(SEED_ICTRP)) return null;
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_ICTRP, "utf8"));
    const snap = seed.snapshot ?? {};
    const prov = snap.provenance ?? {};
    const createdAt = snap.created_at ?? "";
    const createdMs = Date.parse(createdAt);
    const ageDays = Number.isFinite(createdMs)
      ? (Date.now() - createdMs) / 86_400_000
      : null;

    return {
      trialCount: Array.isArray(seed.trials) ? seed.trials.length : 0,
      keyword: snap.keyword ?? "",
      createdAt,
      // WHO 条款 4.b：来源归因与 WHO 处理日期都要能显示。
      attribution: snap.attribution ?? "",
      termsNotice: snap.terms_notice ?? "",
      whoProcessedDate: prov.ictrp_export_date ?? "",
      upstreamReportedTotal: prov.upstream_reported_total ?? null,
      // 实得条数**取快照本身**，不信 provenance.rows_returned ——
      // 上游写 provenance 时结果集还没物化完，那个字段实测值是 0（假的）。
      // 快照里 trials.length 才是这份数据真正有几条，也是「下界」的那个下界。
      matchedRowsReturned: Array.isArray(seed.trials) ? seed.trials.length : null,
      recordsIncomplete: prov.records_incomplete ?? null,
      coverageNote: snap.coverage_note ?? "",
      ageDays,
      // 与服务侧 DEFAULT_MAX_AGE_DAYS 保持一致；界面据此提前提示而非等服务报错。
      staleAfterDays: 28,
      stale: ageDays !== null && ageDays > 28,
    };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

/**
 * 本机 ChiCTR 运行时的**粗略**自检。
 *
 * 为什么是粗略的：插件侧**没有 shell / exec 能力**（`pi` 只有 ui / commands /
 * plugin / fs / desktop / agent / models / session / usage / services / shell.openExternal），
 * 所以既不能拉起 `chictr-setup`、也不能直接跑 sidecar。真正的四级探测是
 * MCP 服务自己暴露的 `check_environment` 工具（只读、30s 缓存），
 * 由助手在调用检索前执行 —— 那是权威结论，这里是**界面用的粗筛**。
 *
 * 这里只做一件事：看包自举的 venv 在不在。venv 在 = 大概率能用；
 * venv 不在 = 一定要先跑一次 setup。不下结论说「坏了」。
 *
 * 为什么不用 `xyb_check` 之类在插件进程里 net.fetch sidecar 健康端点：
 * 那会引入一个「看起来在探测、实际在猜端口」的伪信号，且 8848 可能属于
 * 另一个副本。宁可少说，不可说错。
 */
function probeChictrRuntime() {
  // 插件进程只继承宿主的白名单环境变量（见 mcp-stdio-launch.ts 的
  // MCP_STDIO_HOST_ENV_KEYS），所以 CHICTR_VENV / CHICTR_HOME 通常**读不到**。
  // 这里仍然查一次是为了开发态能给出结论；读不到就走兜底扫描。
  const candidates = [
    process.env.CHICTR_VENV,
    process.env.CHICTR_HOME ? path.join(process.env.CHICTR_HOME, ".venv") : "",
  ].filter(Boolean);

  for (const venv of candidates) {
    if (fs.existsSync(path.join(venv, "bin", "python3"))) {
      return { status: "likely-ready", venv };
    }
  }

  // 兜底：在 npx 缓存里找包自举的 venv。只扫一层，找不到就承认不知道。
  // 对应 /tmp/probe_ctl 这类真实布局：<npx-cache>/<hash>/node_modules/chictr-mcp-server/.venv
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  try {
    for (const entry of fs.readdirSync(npxRoot)) {
      const venv = path.join(npxRoot, entry, "node_modules", "chictr-mcp-server", ".venv");
      if (fs.existsSync(path.join(venv, "bin", "python3"))) {
        return { status: "likely-ready", venv };
      }
    }
  } catch {
    // npx 缓存不存在 / 不可读，正常情况，落到 unknown。
  }

  return { status: "unknown", setupCommand: CHICTR_SETUP_COMMAND };
}

/** 数据源目录，供界面与命令展示。statusNote 是「前置条件」而非探测结果，不假装已连接。 */
const SOURCES = [
  {
    id: "ctgov",
    name: "ClinicalTrials.gov",
    scope: "全球（含中国申办方在美国登记的试验）",
    plugin: "xyb.trials",
    kind: "内置直连",
    ready: true,
    can: ["按病种与关键词检索", "状态 / 分期 / 地点", "登记编号与原文链接"],
    need: "无需配置，开箱可用",
    limit: "以美国登记为准，部分仅在中国开展的试验不会出现在这里",
  },
  {
    id: "chictr",
    name: "ChiCTR 中国临床试验注册中心",
    scope: "中国注册试验（含研究者发起的 IIT）",
    plugin: "xyb.trial-sources",
    kind: "MCP 服务",
    ready: null,
    can: ["按关键词 / 注册号 / 年份检索", "按注册号取详情", "缓存与访问状态查询"],
    need: "首次使用需联网拉取 npm 包；需本机 Python 3.10+ 与约 1GB 运行时。**首次配置须由本人执行**：npx -y -p chictr-mcp-server@3.0.2 chictr-setup setup --browser（约 6 分钟）；调用前先用 check_environment 体检",
    seed: {
      path: "data/chictr/pancreatic_trials.json",
      runtimeDir: "~/.xyb-chictr",
      keyword: "胰腺癌",
      // 如实标注覆盖范围，不要让界面把它读成「ChiCTR 全量快照」
      coverageNote: "仅含胰腺癌相关试验的冷启动快照，不代表 ChiCTR 的全部收录。其他癌种仍须联网查询。",
    },
    limit:
      "站点有反爬与滑动验证；正常路径下挑战由 sidecar 自动解开、无需人工（异常时才需本人完成验证，工具不绕过）。未满足 Python 前置条件时本来源不可用，须记 NEEDS_SETUP，不得记成「没查到」。**冷启动快照只覆盖胰腺癌**：快照 0 命中只能说「本地快照中未命中」，不能说「没有相关试验」",
  },
  {
    id: "veeva-ctv",
    name: "Veeva CTV",
    scope: "全球临床研究库（可筛 China）",
    plugin: "xyb.trial-sources",
    kind: "MCP 服务（本地索引）",
    ready: null,
    can: ["组合条件检索", "37 字段详情", "变更订阅巡检", "RAG 导出与报告"],
    need: "开箱可用：随应用分发的本地索引会在首次启动时复制到 ~/.ctv-mcp/（本机索引，非实时站点）",
    limit:
      "检索走本地索引而非实时站点（站点 robots.txt 禁止抓 /study-search）。**已知检索缺口**：graphql 途径入库的记录可能未写入 FTS 索引，表现为「库里明明有该药名却 0 命中」；0 命中时须查看 coverage 并如实说明「本地索引中未命中」，不得表述为「没有相关研究」",
  },
  {
    id: "chinadrugtrials",
    name: "中国药物临床试验登记与信息公示平台",
    scope: "中国药物注册临床试验（可按适应症、药物类型、申办方、参加机构等条件筛）",
    plugin: "xyb.trial-sources",
    kind: "MCP 服务（本机采集器）",
    ready: null,
    can: [
      "关键词与高级条件检索",
      "按登记号取详情",
      "详情页原始 HTML 与 RAG JSON 归档",
      "平台原样 Word 下载",
      "按正文指纹做增量同步",
    ],
    need: "需本人浏览器会话；首次要准备 Python 环境（可在会话里让助手一键准备）。**胰腺癌有随包冷启动归档**，无需先配置会话即可查",
    seed: {
      path: "data/chinadrugtrials/",
      runtimeDir: "~/.xyb-chinadrugtrials/archive",
      keyword: "胰腺癌",
      coverageNote: "仅含胰腺癌相关试验的冷启动快照，不代表平台的全部收录。其他适应症仍须联网查询。",
    },
    limit:
      "站点校验浏览器会话，会话由本人维护、工具不绕过验证；逐条抓取较慢；凭据只留在本机，不进本插件、不入仓库。**冷启动归档只覆盖胰腺癌**：归档 0 命中只能说「本地归档中未命中」",
  },
  {
    id: "who-ictrp",
    name: "WHO ICTRP",
    scope: "全球多注册库汇总（含 ChiCTR，另有 ClinicalTrials.gov / ISRCTN / EU CTIS / JPRN 等）",
    plugin: "xyb.trial-sources",
    kind: "MCP 服务（聚合库）",
    ready: null,
    can: [
      "按关键词 / 病种 / 药物检索",
      "结果本地物化后反复筛选与统计（不重复联网）",
      "跨注册库查重",
      "导出 CSV / JSON / Markdown",
    ],
    need: "随包自带服务源码，需本机 Python 3.10+ 与 mcp / httpx / pydantic 三个依赖；缺依赖时给出一行可复制的安装命令",
    limit:
      "**返回集是下界**：导出通道已实测会静默漏掉它自己声称匹配的记录（实测 KRAS 门户自报 1243 条、导出只得 882 条，缺 29.0%），因此条数**不得**当作符合条件的试验总数。某条试验不在结果里，不构成它不存在的证据。数据受 WHO ICTRP 条款约束：须标注来源与 WHO 处理日期，不得主张专有权利，禁止商业用途",
  },
];

const CDE_NOTE =
  "另有国家药监局药品审评中心（CDE）药物临床试验登记平台，公开检索能力有限，药物研发进展以官方公示与企业公告为准。";

/** 最近一次种子复制的结果，供面板展示（onLoad 里赋值）。 */
let seedStatus = null;

/** ChiCTR / CDE 的冷启动种子复制结果与覆盖范围，供面板展示（onLoad 里赋值）。 */
let chictrSeedStatus = null;
let cdeSeedStatus = null;

/**
 * ICTRP 快照**不复制**，所以这里不是「复制结果」而是「可用性」。
 *
 * 理由：快照是只读构建产物，用户不会改它，复制 11MB 只是浪费。服务通过
 * `ICTRP_BUNDLE_PATH` 直接读随包位置。用户若想用自己的一份，改 `ictrpSeedDir`
 * setting，运行时以 `ICTRP_BUNDLE_DIR` 生效（那里按 `<slug>.json` 找）。
 */
let ictrpSeedStatus = null;

/** 最近一次 ChiCTR 运行时粗筛结果，供面板展示（onLoad 里赋值）。 */
let chictrProbe = null;

async function onLoad() {
  // 把随包分发的 Veeva 索引放到用户可写的目录。失败不阻断加载 —— 用户仍可
  // 用渠道 1/2/4，Veeva 只是暂时没有本地索引。
  try {
    const settings = (await pi.plugin.getSettings()) ?? {};
    seedStatus = await ensureVeevaSeed({ dataDir: settings.veevaDataDir });
  } catch (error) {
    seedStatus = { ok: false, reason: "COPY_FAILED", error: error?.message ?? String(error) };
  }

  // ChiCTR 与 CDE 的结构化 JSON 种子。同样只补不覆盖、失败不阻断。
  try {
    const settings = (await pi.plugin.getSettings()) ?? {};
    chictrSeedStatus = await ensureJsonSeed({
      seedPath: SEED_CHICTR,
      targetDir: String(settings.chictrSeedDir ?? "").trim() || defaultChictrDir(),
      label: "chictr",
    });
    cdeSeedStatus = await ensureJsonSeed({
      seedPath: SEED_CDE_DIR,
      targetDir: String(settings.cdeSeedDir ?? "").trim() || defaultCdeDir(),
      label: "chinadrugtrials",
    });
  } catch (error) {
    const failure = { ok: false, reason: "COPY_FAILED", error: error?.message ?? String(error) };
    chictrSeedStatus = failure;
    cdeSeedStatus = failure;
  }

  // ICTRP 快照：不复制，只确认它在不在、有多旧。同样不阻断加载。
  try {
    const meta = readIctrpSeedMeta();
    ictrpSeedStatus = meta
      ? { ok: true, reason: meta.stale ? "STALE" : "PRESENT", seedPath: SEED_ICTRP }
      : { ok: false, reason: "NO_SEED", seedPath: SEED_ICTRP };
  } catch (error) {
    ictrpSeedStatus = {
      ok: false,
      reason: "READ_FAILED",
      seedPath: SEED_ICTRP,
      error: error?.message ?? String(error),
    };
  }

  // ChiCTR 环境粗筛。同样失败不阻断加载：结论只是界面提示，
  // 权威判定在 MCP 服务自己的 check_environment。
  try {
    chictrProbe = probeChictrRuntime();
  } catch (error) {
    chictrProbe = { status: "unknown", error: error?.message ?? String(error) };
  }

  await pi.commands.register({
    id: "xyb.trial-sources.list",
    title: "小胰宝：看看有哪些试验来源",
    keywords: ["数据源", "来源", "中国", "ChiCTR", "Veeva", "CTV", "登记平台"],
    run: async () => {
      const names = SOURCES.map((s) => s.name).join("、");
      await pi.ui.showToast(`试验来源：${names}`);
      return panelPayload();
    },
  });
}

/** 面板/命令共用的载荷，避免两处各写一份而漂移。 */
function panelPayload() {
  return {
    ok: true,
    sources: SOURCES,
    cdeNote: CDE_NOTE,
    seed: seedStatus,
    chictr: chictrProbe,
    chictrSeed: chictrSeedStatus,
    cdeSeed: cdeSeedStatus,
    chictrSeedMeta: readChictrSeedMeta(),
    ictrpSeed: ictrpSeedStatus,
    ictrpSeedMeta: readIctrpSeedMeta(),
    disclaimer: DISCLAIMER,
  };
}

async function onUnload() {
  await pi.commands.unregister("xyb.trial-sources.list");
}

/** 面板自定义通道：宿主未实现的 channel 会转发到这里。 */
async function onPanelInvoke(channel) {
  if (channel === "xyb.trial-sources.list") {
    return panelPayload();
  }
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  _internals: {
    SOURCES,
    CDE_NOTE,
    DISCLAIMER,
    ensureVeevaSeed,
    SEED_DB,
    defaultVeevaDir,
    probeChictrRuntime,
    CHICTR_SETUP_COMMAND,
    ensureJsonSeed,
    readChictrSeedMeta,
    readIctrpSeedMeta,
    SEED_CHICTR,
    SEED_CDE_DIR,
    SEED_ICTRP,
    ICTRP_SEED_KEYWORD,
    defaultChictrDir,
    defaultCdeDir,
    defaultIctrpDir,
    get seedStatus() {
      return seedStatus;
    },
    get chictrProbe() {
      return chictrProbe;
    },
    get chictrSeedStatus() {
      return chictrSeedStatus;
    },
    get cdeSeedStatus() {
      return cdeSeedStatus;
    },
    get ictrpSeedStatus() {
      return ictrpSeedStatus;
    },
  },
};
