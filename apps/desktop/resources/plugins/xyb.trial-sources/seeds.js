/**
 * 四个随包种子的「安装 / 更新」统一入口。
 *
 * ## 为什么需要这个文件
 *
 * 这四个种子原先只在 `onLoad` 里各写一段「存在就跳过」的复制代码：
 *
 *   - `ensureVeevaSeed`   → `~/.ctv-mcp/ctv.db`（50 MB 二进制索引）
 *   - `ensureJsonSeed`    → ChiCTR / CDE（逐文件合并）
 *   - `ensureCdeCorpus`   → CDE 完整语料（下载 + 校验 + 解压 + 挂载）
 *
 * 它们各自正确，但**没有任何一个是「更新」**：全都是「缺了才补」。随包数据只
 * 随应用版本走，用户想知道「我这份快照是不是最新的」、想主动换一份，都没有入口。
 * 本文件把四者收敛成一张声明表 + 一条共享的安装流程，于是：
 *
 *   - 「安装」与「更新」是同一段代码，差别只在**是否允许覆盖同名文件**；
 *   - 覆盖永远要用户先同意（见 `planInstall` 与 `applyInstall` 的分工）。
 *
 * ## 三条不可协商的规则
 *
 * 1. **清单就是契约。** `bytes` 与 `sha256` 来自 `data/corpora/manifest.json`，
 *    不符则整个操作失败。<b>绝不手工编辑 sha256。</b>
 *
 * 2. **失败绝不破坏已装好的数据。** 先下到临时目录、校验、解压、自检，最后才
 *    动目标目录。任何一步失败，原有数据原封不动。
 *
 * 3. **覆盖之前必须问。** 三个种子的目标目录**同时是用户自己抓取数据的落盘位置**
 *    （CDE 的 `output/胰腺癌/json/`、Veeva 的 `~/.ctv-mcp/ctv.db`、ChiCTR 的
 *    `~/.xyb-chictr/`）。在这些目录里盲目覆盖就是删用户的抓取结果。所以流程被
 *    刻意拆成两步：`planInstall` 探测冲突并**只报告**，`applyInstall` 才写入，
 *    且必须由调用方显式带上用户同意（`consent: true`）。
 *
 *    为什么拆成两个函数而不是加一个 `overwrite` 布尔：布尔很容易在某次重构里
 *    被顺手传成 `true`，而「先问」是一个**必须发生的交互**，不是参数默认值。
 *
 * ## 联网
 *
 * 资产托管在 GitHub Releases。**中国大陆直连大概率超时**，界面必须提前说明，
 * 而不是等 120 秒超时后报一句「下载失败」。见 `SEED_NETWORK_NOTICE`。
 *
 * 本文件是 CommonJS（与插件里其它文件一致，见 package.json）。
 */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CorpusError, fetchCorpus, readManifest } = require("./corpus.js");

/**
 * GitHub 下载的网络提示。
 *
 * 用户 2026-10-06 明确要求：「提醒用户用 github 需要 vpn」。这句话要出现在**发起
 * 下载之前**——下载失败后才说，等于把已经浪费掉的两分钟连同重试一起送给用户。
 */
const SEED_NETWORK_NOTICE =
  "这些数据包托管在 GitHub Releases。中国大陆直连 github.com 大概率超时，" +
  "请先开启 VPN 或代理再下载；若公司网络有策略拦截，下载同样不会成功。";

/**
 * 一个种子包的声明。
 *
 * 字段分工（这份表就是四者的全部差异，流程本身不再分支）：
 *
 *   - `corpusId`   清单里的键，也是 Release 资产名（`<corpusId>.tar.gz`）。
 *   - `title`      界面显示名。**必须让用户看懂「这一路是哪个来源」**。
 *   - `source`     本插件里哪一路数据源（用于和 MCP 服务对应起来）。
 *   - `installDir` 解压后的落点（不含包名）。默认在用户 home 下。
 *   - `runtimeDir` 界面提示用：这份数据**实际被读取**的位置。与 `installDir`
 *                  不一定相同（CDE 语料装到 `corpora/`，再挂到 `output/`）。
 *   - `required`   解压后必须存在的文件，否则视为打错包。
 *   - `probe`      「本地现在是什么状态」的探测函数，返回 `{ installed, records, detail }`。
 *                 探测必须**只读**，且宁可少说不可说错（说不准就报 `null`）。
 *   - `targets`    安装会写入的具体文件/目录，用于**冲突检测**。每个 target 声明：
 *                   - `path`       绝对路径
 *                   - `kind`       `file` 或 `directory`
 *                   - `userData`   true 表示「这里也可能是用户自己抓的数据」
 *
 * `targets` 是这份设计里最要紧的一栏：它把「覆盖什么」变成可列举、可核对、
 * 可展示给用户的清单，而不是一句「会覆盖目标目录」。
 */
const SEEDS = [
  {
    corpusId: "chictr_pancreatic",
    title: "ChiCTR 中国临床试验注册中心",
    source: "chictr",
    // 4 MB 结构化快照；468 条全部是胰腺癌相关登记。
    required: "pancreatic_trials.json",
    installDir: () => path.join(os.homedir(), ".xyb-chictr"),
    runtimeDir: () => path.join(os.homedir(), ".xyb-chictr"),
    targets: () => [
      {
        path: path.join(os.homedir(), ".xyb-chictr", "pancreatic_trials.json"),
        kind: "file",
        // 用户也可以自己构建一份快照放这里，所以同名文件可能不是种子。
        userData: true,
      },
    ],
    probe: () => probeChictrSeed(),
  },
  {
    corpusId: "cde_pancreatic",
    title: "CDE 药物临床试验登记与信息公示平台",
    source: "chinadrugtrials",
    // 139 条纯 JSON（+ index.json）。这是**离线兜底**那份，不含 raw/word。
    required: "json",
    installDir: () => path.join(os.homedir(), ".xyb-chinadrugtrials", "output", "胰腺癌"),
    runtimeDir: () => path.join(os.homedir(), ".xyb-chinadrugtrials", "output", "胰腺癌", "json"),
    targets: () => [
      {
        path: path.join(os.homedir(), ".xyb-chinadrugtrials", "output", "胰腺癌", "json"),
        kind: "directory",
        userData: true,
      },
    ],
    probe: () => probeCdeSeed(),
  },
  {
    corpusId: "cde_corpus_pancreatic",
    title: "CDE 完整归档（含原始页面与 DOC 导出）",
    source: "chinadrugtrials",
    // 约 11 MB，比上面那份多 raw/ 与 word/ 证据文件。
    required: "summary.json",
    installDir: () => path.join(os.homedir(), ".xyb-chinadrugtrials", "corpora"),
    runtimeDir: () => path.join(os.homedir(), ".xyb-chinadrugtrials", "output"),
    targets: () => [
      {
        path: path.join(os.homedir(), ".xyb-chinadrugtrials", "corpora"),
        kind: "directory",
        // 这个目录**只**放语料，用户抓取的数据不落这里，所以覆盖它不碰用户数据。
        userData: false,
      },
    ],
    probe: () => probeCdeCorpus(),
  },
  {
    corpusId: "ictrp_pancreatic_cancer",
    title: "WHO ICTRP 全球试验汇总",
    source: "who_ictrp",
    // 6262 条（上游自报 6952，本包是下界）。
    required: "pancreatic-cancer.json",
    installDir: () => path.join(os.homedir(), ".xyb-ictrp"),
    runtimeDir: () => path.join(os.homedir(), ".xyb-ictrp"),
    targets: () => [
      {
        path: path.join(os.homedir(), ".xyb-ictrp", "pancreatic-cancer.json"),
        kind: "file",
        userData: true,
      },
    ],
    probe: () => probeIctrpSeed(),
  },
  {
    corpusId: "veeva_ctv",
    title: "Veeva CTV 本地索引",
    source: "veeva_ctv",
    required: "ctv.db",
    installDir: () => path.join(os.homedir(), ".ctv-mcp"),
    runtimeDir: () => path.join(os.homedir(), ".ctv-mcp"),
    targets: () => [
      {
        path: path.join(os.homedir(), ".ctv-mcp", "ctv.db"),
        kind: "file",
        // 用户跑 sync_sitemap / backfill_details 刷新后就写在这里，覆盖等于
        // 扔掉用户的刷新结果。
        userData: true,
      },
    ],
    probe: () => probeVeevaSeed(),
  },
];

/** 按 id 取种子声明。未知 id 抛错而不是返回 undefined——静默无操作最难查。 */
function seedById(corpusId) {
  const seed = SEEDS.find((s) => s.corpusId === corpusId);
  if (!seed) {
    throw new CorpusError(
      "SEED_UNKNOWN",
      `未知的种子包：${corpusId}`,
      `可用：${SEEDS.map((s) => s.corpusId).join(", ")}`,
    );
  }
  return seed;
}

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

function sha256FileSync(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 目录里有多少个 `.json` 记录（不含 `index.json` 那种清单文件）。 */
function countJsonRecords(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== "index.json").length;
  } catch {
    return null;
  }
}

/**
 * 各来源的**只读**本地状态探测。
 *
 * 统一的规矩：拿不准就返回 `records: null` / `detail` 说明拿不准的原因，绝不猜。
 * 界面上一个错的「已装 139 条」比「无法确认」有害得多——后者只是不够好，前者会让
 * 用户据此以为数据在。
 */
function probeChictrSeed() {
  const file = path.join(os.homedir(), ".xyb-chictr", "pancreatic_trials.json");
  if (!fs.existsSync(file)) return { installed: false, records: null, detail: "" };
  try {
    const seed = JSON.parse(fs.readFileSync(file, "utf8"));
    const records =
      seed.record_count ?? (Array.isArray(seed.records) ? seed.records.length : null);
    return {
      installed: true,
      records,
      builtAt: seed.built_at ?? "",
      keyword: seed.keyword ?? "",
      detail: seed.coverage_note ?? "",
    };
  } catch (error) {
    return { installed: true, records: null, detail: `种子无法解析：${error.message}` };
  }
}

function probeCdeSeed() {
  const dir = path.join(os.homedir(), ".xyb-chinadrugtrials", "output", "胰腺癌", "json");
  if (!fs.existsSync(dir)) return { installed: false, records: null, detail: "" };
  return { installed: true, records: countJsonRecords(dir), detail: "" };
}

function probeCdeCorpus() {
  const dir = path.join(os.homedir(), ".xyb-chinadrugtrials", "corpora");
  if (!fs.existsSync(dir)) return { installed: false, records: null, detail: "" };
  // 语料装好后是 `<根>/<包名>/胰腺癌/`，所以条数要从包里的 summary.json 读。
  let packages = [];
  try {
    packages = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return { installed: true, records: null, detail: "无法读取语料目录" };
  }
  for (const name of packages) {
    const summary = path.join(dir, name, "summary.json");
    if (!fs.existsSync(summary)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(summary, "utf8"));
      return {
        installed: true,
        records: raw.total_records ?? raw.total ?? null,
        builtAt: raw.scrape_time ?? "",
        keyword: raw.keywords ?? "",
        detail: `已装数据包：${name}`,
      };
    } catch {
      /* 换下一个包 */
    }
  }
  return { installed: true, records: null, detail: `目录存在但未找到完整数据包：${dir}` };
}

function probeIctrpSeed() {
  const file = path.join(os.homedir(), ".xyb-ictrp", "pancreatic-cancer.json");
  if (!fs.existsSync(file)) return { installed: false, records: null, detail: "" };
  try {
    const seed = JSON.parse(fs.readFileSync(file, "utf8"));
    // 快照本身（snapshot.created_at）才是这份数据的年龄，文件 mtime 不是。
    const createdAt = seed.snapshot?.created_at ?? "";
    const createdMs = Date.parse(createdAt);
    const ageDays = Number.isFinite(createdMs) ? (Date.now() - createdMs) / 86_400_000 : null;
    return {
      installed: true,
      records: Array.isArray(seed.trials) ? seed.trials.length : null,
      builtAt: createdAt,
      // WHO 每周更新；超过 28 天服务会标 snapshot_stale，界面要提前说。
      stale: ageDays !== null && ageDays > 28,
      ageDays,
      detail: "",
    };
  } catch (error) {
    return { installed: true, records: null, detail: `快照无法解析：${error.message}` };
  }
}

function probeVeevaSeed() {
  const file = path.join(os.homedir(), ".ctv-mcp", "ctv.db");
  if (!fs.existsSync(file)) return { installed: false, records: null, detail: "" };
  let size = null;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* 拿不到大小就只报存在 */
  }
  return {
    installed: true,
    // 条数要开 SQLite 才知道，而插件侧没有 sqlite 绑定。
    // **不猜**：报 null 并在界面写「大小」，让用户有个可核对的量。
    records: null,
    bytes: size,
    detail: "本地索引存在。条数需由 ctv-mcp-server 查询，本面板不臆测。",
  };
}

/**
 * 安装**之前**的探测：会写什么、哪些现成文件会被覆盖。
 *
 * 这一步必须在下载之前跑完，理由有两个：
 *   1. 冲突要在用户点「更新」之前就讲清楚，而不是下载完 11 MB 再问；
 *   2. 无冲突时（全新安装）根本不需要征求同意，直接装即可。
 *
 * 返回的 `conflicts` 是**将要被覆盖**的具体路径。空数组 = 不需要同意。
 */
async function planInstall(corpusId, options = {}) {
  const seed = seedById(corpusId);
  const targets = options.targets ?? seed.targets();
  const conflicts = [];

  for (const target of targets) {
    const present = await exists(target.path);
    if (!present) continue;
    conflicts.push({
      path: target.path,
      kind: target.kind,
      // 「这里也可能有你自己抓的数据」——这一栏决定界面用什么语气问。
      userData: Boolean(target.userData),
    });
  }

  return {
    corpusId,
    title: seed.title,
    conflicts,
    // 冲突里只要有 `userData` 的，就不能自动往下走。
    needsConsent: conflicts.some((c) => c.userData),
    networkNotice: SEED_NETWORK_NOTICE,
  };
}

/**
 * 真正执行安装 / 更新。
 *
 * `consent: true` 是**调用方对「用户已同意覆盖」的断言**。没有它而存在冲突时，
 * 直接以 `NEEDS_CONSENT` 拒绝——这条检查是这件事的最后一个安全阀，不能只靠界面
 * 记得先问。
 *
 * `onProgress` 用于把步骤流式报给界面：下载 11 MB 期间没有反馈，用户会以为卡死。
 */
async function applyInstall(corpusId, options = {}) {
  const seed = seedById(corpusId);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  const plan = await planInstall(corpusId, options);
  if (plan.needsConsent && options.consent !== true) {
    return {
      ok: false,
      reason: "NEEDS_CONSENT",
      corpusId,
      plan,
      message: "目标位置已有数据，且可能是你自己抓取的。需要你确认后才会覆盖。",
    };
  }

  onProgress({ phase: "start", corpusId, message: `准备安装 ${seed.title}` });

  const fetched = await fetchCorpus(
    {
      corpusId,
      destDir: options.destDir ?? seed.installDir(),
      // 覆盖语义由 fetchCorpus 的原子替换保证：先装到临时目录，校验通过后再换。
      // 所以这里不需要（也不应该）自己先删旧目录。
      apply: true,
      urlOverride: options.urlOverride,
    },
    options.overrides ?? {},
  );

  if (!fetched.ok) {
    // fetchCorpus 已经保证失败时原数据未动；这里只把失败如实往上带。
    onProgress({ phase: "failed", corpusId, message: fetched.reason ?? "FETCH_FAILED" });
    return { ok: false, reason: fetched.reason ?? "FETCH_FAILED", corpusId, plan, fetched };
  }

  onProgress({ phase: "done", corpusId, message: "安装完成" });
  return { ok: true, reason: "INSTALLED", corpusId, plan, fetched };
}

/** 面板要展示的完整状态：每个种子现在是什么样、能否更新。 */
function describeSeeds() {
  return SEEDS.map((seed) => {
    let state;
    try {
      state = seed.probe();
    } catch (error) {
      state = { installed: null, records: null, detail: `探测失败：${error.message}` };
    }
    return {
      corpusId: seed.corpusId,
      title: seed.title,
      source: seed.source,
      // 两个位置都给界面：`installDir` 是**写入**的地方（也是冲突发生的
      // 地方），`runtimeDir` 是**读取**的地方。CDE 完整归档两者不同——
      // 装进 corpora/ 再挂到 output/——只说一个会让用户找不到文件到底在哪。
      installDir: seed.installDir(),
      runtimeDir: seed.runtimeDir(),
      state,
    };
  });
}

module.exports = {
  SEEDS,
  SEED_NETWORK_NOTICE,
  applyInstall,
  describeSeeds,
  planInstall,
  seedById,
};
