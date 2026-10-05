/**
 * 公开离线语料的下载与安装。
 *
 * 这里的规则不可协商，三条：
 *
 *   1. **清单就是契约。** `bytes` 与 `sha256` 来自 `data/corpora/manifest.json`；
 *      不符则整个操作失败。
 *   2. **失败绝不破坏已装好的东西。** 先下到临时文件、校验、解压到临时目录，
 *      最后才把目标目录换过去。任何一步失败都让原有数据原封不动。
 *   3. **必须显式触发。** 这里没有任何东西跑在检索路径上；没要求下载的调用者
 *      不会得到下载。
 *
 * 下载边流边写盘，因为把 11 MB 的内容读进内存再哈希，是杀掉小内存机器的好办法。
 *
 * 本文件是 CommonJS（与插件里其它文件一致，见 package.json）。
 */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createWriteStream, createReadStream } = require("node:fs");
const fsp = require("node:fs/promises");
const { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } = fsp;
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

/**
 * 一个资产为何可以被再分发。两种依据不得混为一谈，否则「不需要凭证」会被
 * 误当成「可以再分发」。
 *   - `upstream_public`  - 数据集本身公开且可匿名下载；随包只是搬运，不是披露。
 *   - `community_owned`  - 社区自己的抓取成果，因作者持有该产物的权利而分发。
 *                          上游站点是否需要凭证会话，与**这条**依据无关。
 */
const CORPUS_BASES = ["upstream_public", "community_owned"];

/**
 * 每个语料要求：解压后树里必须存在这个条目，才算装成功。
 *
 * 多数是文件，但 CDE 的纯 JSON 种子要求的是 `json/` **目录**——那份归档就是
 * 「一个关键词目录」，它的身份体现在目录结构上。`findContentRoot` 对目录同样
 * 有效（`exists()` 用的是 `stat`）。
 */
/**
 * 除了 `REQUIRED_CONTENT` 之外，读取方还需要的**额外**条目。
 *
 * 只有 CDE 归档有这一条：`chinadrugtrials-mcp.mjs:309-333` 的 `listArchiveDirs()`
 * 只把「`json/` 里真的有 .json」的子目录当作数据包，所以少了 `json/` 的 CDE 包
 * 会被静默跳过。其它语料各有自己的读取方式（单文件 JSON / SQLite），没有这层。
 */
const REQUIRED_EXTRA = {
  xyb_cde_pancreatic: ["json"],
  cde_corpus_pancreatic: ["json"],
  cde_pancreatic: ["json"],
};

const REQUIRED_CONTENT = {
  xyb_cde_pancreatic: "summary.json",
  veeva_ctv: "ctv.db",
  chictr_pancreatic: "pancreatic_trials.json",
  ictrp_pancreatic_cancer: "pancreatic-cancer.json",
  cde_pancreatic: "json",
};

/**
 * 每个语料期望的解压布局。`nested` 表示归档里要有**包目录层级**。
 *
 * CDE 完整归档必须是 nested：MCP 的 `listArchiveDirs()` 扫描父目录下含
 * `summary.json` 的子目录。若把包内容直接装到 extractDir，读取方会往深一层找，
 * 于是下载报告成功、查询却不可用（`NO_ARCHIVE_PACKAGES`）。
 *
 * 其余三个是 `flat`：归档解出来就是目标目录的内容。它们各自的读取方（ChiCTR /
 * ICTRP 的快照加载、ctv-mcp-server 的库路径）直接指向那个**文件**，多一层目录
 * 会让它们找不到东西。
 */
const LAYOUT_BY_CORPUS = {
  xyb_cde_pancreatic: "nested",
  cde_corpus_pancreatic: "nested",
  veeva_ctv: "flat",
  chictr_pancreatic: "flat",
  ictrp_pancreatic_cancer: "flat",
  // 纯 JSON 种子虽然自带 `json/` 一层，但那一层**就是**它的根内容
  // （安装目标 `…/胰腺癌/` 下直接是 `json/`），所以按 flat 装：把解压内容
  // 整个放到 extractDir 下，`json/` 自然出现在正确的位置。标成 nested 会
  // 因为顶层没有「包名」目录而被 ARCHIVE_LAYOUT_UNEXPECTED 拒绝。
  cde_pancreatic: "flat",
};

/**
 * 语料 id 的新旧对照。
 *
 * `xyb_cde_pancreatic` 是随 v0.17.0 发布的资产名，已经写进 GitHub Release 的
 * URL 与标签里，改不动。后来的四个种子沿用了 `<来源>_<范围>` 这种短名字，于是
 * 清单里出现两个 CDE 条目、名字却不像一家人。这里保留旧 id 并让新 id 指向它，
 * 这样界面按新 id 取名，而下载仍然打得到已发布的那个资产。
 */
const CORPUS_ALIASES = {
  cde_corpus_pancreatic: "xyb_cde_pancreatic",
};

/** 把别名解析成清单里的真实键；没有别名就是它自己。 */
function resolveCorpusId(corpusId) {
  return CORPUS_ALIASES[corpusId] ?? corpusId;
}

/**
 * 这些语料**直接装进 destDir**，不再套一层 `extractDir` 子目录。
 *
 * CDE 完整归档是唯一需要那一层的：读取方（`--xyb-archive`）扫描 destDir 下
 * 含 `summary.json` 的**子目录**，所以包必须待在自己的目录里。其余四个的读取方
 * 指向的是 destDir 下的具体文件（`pancreatic_trials.json`、`ctv.db`、
 * `pancreatic-cancer.json`）或目录（`json/`），多套一层会让它们全都找不到东西
 * ——实测就是这样：ChiCTR 装成了 `~/.xyb-chictr/chictr_pancreatic/…`。
 */
const INSTALL_DIRECTLY = new Set([
  "chictr_pancreatic",
  "cde_pancreatic",
  "ictrp_pancreatic_cancer",
  "veeva_ctv",
]);

const DEFAULT_CORPUS_ID = "xyb_cde_pancreatic";
const DEFAULT_RETRIES = 3;

/**
 * 单次尝试的超时。Node 的 fetch 对跨慢速链路下载 11 MB 没有可用默认值，
 * 不设上界会让冷启动看起来像卡死。
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 注入点：单元测试永远不该开 socket 或调 tar。 */
const corpusDeps = {
  fetchImpl: undefined,
  sha256File: undefined,
  runTar: undefined,
  readManifest: undefined,
};

class CorpusError extends Error {
  constructor(reasonCode, message, fixHint) {
    super(message);
    this.name = "CorpusError";
    this.reasonCode = reasonCode;
    this.fixHint = fixHint;
  }
}

function requiredContentFor(corpusId) {
  return REQUIRED_CONTENT[resolveCorpusId(corpusId)] ?? "summary.json";
}

function manifestPath() {
  return path.join(__dirname, "data", "corpora", "manifest.json");
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    // 用 readFile() 哈希一个 11 MB 的文件会把整份内容留在内存里。
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    // argv 数组，绝不是 shell 字符串：归档名与路径都是数据。
    const child = spawn("tar", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", (error) =>
      reject(new CorpusError("TAR_UNAVAILABLE", `无法执行 tar：${error.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new CorpusError("TAR_FAILED", `tar 退出码 ${code}${stderr ? `：${stderr.trim()}` : ""}`));
    });
  });
}

async function readManifest(overrides = {}) {
  const reader = overrides.readManifest ?? corpusDeps.readManifest;
  if (reader) return reader();
  const raw = await readFile(manifestPath(), "utf8");
  return JSON.parse(raw);
}

function resolveEntry(manifest, corpusId) {
  // 先按原名找，再按别名找。别名让「描述符里的 id」与「已发布资产的名字」可以
  // 不同——前者是我们想怎么称呼它，后者已经写进 URL 里改不动了。
  const key = resolveCorpusId(corpusId);
  const entry = manifest && manifest.corpora ? manifest.corpora[key] : undefined;
  if (!entry) {
    const available = Object.keys((manifest && manifest.corpora) || {}).join(", ");
    throw new CorpusError(
      "CORPUS_NOT_IN_MANIFEST",
      `清单中没有语料：${key}`,
      `可用语料：${available || "（清单为空）"}。若尚未发布资产，请先运行 scripts/xyb-pack-corpus.mjs --write-manifest 并上传 Release。`,
    );
  }
  if (!entry.sha256 || !entry.bytes || !entry.url) {
    throw new CorpusError(
      "MANIFEST_ENTRY_INCOMPLETE",
      `清单条目缺少 url/bytes/sha256：${corpusId}`,
      "用 scripts/xyb-pack-corpus.mjs --write-manifest 重新生成，不要手工编辑 sha256。",
    );
  }
  // 没有声明分发依据的资产不得安装。放在这里强制，而不是只写在文档里：清单正是
  // 新资产被加进来的地方，一个没人校验的字段就是没人会填的字段。
  if (!CORPUS_BASES.includes(entry.basis)) {
    throw new CorpusError(
      "MANIFEST_BASIS_MISSING",
      `清单条目未声明分发依据（basis）：${corpusId}`,
      "每个语料必须声明 basis：upstream_public（上游公开可匿名下载）或 community_owned（社区自采成果，权利人确认可分发）。",
    );
  }
  return entry;
}

/**
 * 把 fetch 失败翻译成用户能据以行动的话。
 *
 * 顶层看到的往往是 `TypeError: fetch failed`，真正的原因（DNS 失败、连接被拒、
 * 超时、TLS、被网络策略拦截）在 `cause` 里，有时嵌套两层。只报外层消息会把每一种
 * 不同的网络问题变成同一句没用的话——所以要沿着链条走，包括某些 Node 失败携带的
 * 聚合 `errors` 列表，并对措辞去重。
 */
function describeFetchError(error) {
  const seen = new Set();
  const parts = [];
  const visit = (value, depth) => {
    if (!value || depth > 4) return;
    if (value instanceof AggregateError) {
      for (const inner of value.errors) visit(inner, depth + 1);
      return;
    }
    if (value instanceof Error) {
      const message = value.message ? value.message.trim() : "";
      // 拿到 cause 之后 "fetch failed" 不提供任何信息，丢掉这层包装。
      if (message && message !== "fetch failed" && !seen.has(message)) {
        seen.add(message);
        parts.push(message);
      }
      visit(value.cause, depth + 1);
      return;
    }
    const text = String(value).trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
  };
  visit(error, 0);
  return parts.length ? parts.join(" <- ") : String(error);
}

/** 下到 `destFile`，瞬时失败重试。绝不留下半个文件。 */
async function download(entry, destFile, overrides = {}) {
  const doFetch = overrides.fetchImpl ?? corpusDeps.fetchImpl ?? fetch;

  if (entry.url.startsWith("file://")) {
    // 本地镜像不是网络失败模式：复制一次，不重试。
    const { fileURLToPath } = require("node:url");
    try {
      await fsp.copyFile(fileURLToPath(entry.url), destFile);
    } catch (error) {
      // 仍然要给出 reasonCode：调用方按它分流（是否重试、展示哪句话），一个裸
      // ENOENT 会让「镜像路径写错」看起来像未知故障。
      throw new CorpusError(
        "DOWNLOAD_FAILED",
        `读取本地语料镜像失败：${error.message}`,
        "检查 urlOverride 指向的 file:// 路径是否存在且可读。",
      );
    }
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= DEFAULT_RETRIES; attempt += 1) {
    try {
      const response = await doFetch(entry.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        // 4xx 不会自己好；只有 5xx 与网络错误才重试。
        if (response.status < 500) {
          throw new CorpusError(
            "DOWNLOAD_HTTP_ERROR",
            `下载失败：HTTP ${response.status} ${response.statusText}`,
            "若为 404，说明该版本的 Release 资产尚未上传或已被删除；可用 urlOverride 指向镜像或本地文件。",
          );
        }
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("响应没有 body");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destFile));
      return;
    } catch (error) {
      lastError = error;
      await rm(destFile, { force: true });
      if (error instanceof CorpusError) throw error;
      if (attempt < DEFAULT_RETRIES) {
        // 线性退避：语料下载又大又少，短而可预测的等待胜过指数退避拖死冷启动。
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw new CorpusError(
    "DOWNLOAD_FAILED",
    `下载失败（已重试 ${DEFAULT_RETRIES} 次）：${describeFetchError(lastError)}`,
    "检查网络连通性（DNS、代理、是否有网络策略拦截）；" +
      "若默认 Release 不可达，可用 urlOverride 指向镜像或 file:// 本地路径。" +
      "注意本流程会跟随 GitHub 的 302 跳转，因此重定向目标也必须可达。",
  );
}

/**
 * 确认期望内容存在于解压根的**任意**层级下，并返回找到它的目录（即真正的包根）。
 *
 * 只查顶层是错的：CDE 归档把包放在 `胰腺癌/` 下，顶层检查会把一次完全正常的安装
 * 以令人困惑的 ENOENT 拒掉。归档可以合法地嵌套，所以检查要跟着走——但它仍然必须
 * 找到内容，这才是能抓住「打错包 / 下载被截断」的地方。
 */
async function findContentRoot(extractRoot, required) {
  const direct = path.join(extractRoot, required);
  if (await exists(direct)) return extractRoot;

  const children = await readdir(extractRoot, { withFileTypes: true });
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const candidate = path.join(extractRoot, child.name, required);
    if (await exists(candidate)) return path.join(extractRoot, child.name);
  }

  throw new CorpusError(
    "EXTRACTED_CONTENT_MISSING",
    `解压后未找到必需内容 ${required}（已检查归档顶层及其下一层目录）`,
    "归档可能打包了错误的目录，或下载不完整。已保留原有数据未做任何改动。",
  );
}

/**
 * 下载 → 校验 → 解压 → 内容自检 → 原子替换。
 *
 * `apply: false` 时是纯试运行：报告会发生什么（URL、预期大小、预期摘要），
 * 不碰网络也不碰磁盘。
 */
async function fetchCorpus(options = {}, overrides = {}) {
  const corpusId = options.corpusId ?? DEFAULT_CORPUS_ID;
  const manifest = await readManifest(overrides);
  const entry = resolveEntry(manifest, corpusId);
  const url = options.urlOverride ?? entry.url;

  const destDir = path.resolve(
    options.destDir ?? path.join(os.homedir(), ".xyb-chinadrugtrials", "corpora"),
  );
  // 装到哪：多数语料直接落在 destDir，CDE 完整归档落在 destDir/<extractDir>。
  const corpusDir = INSTALL_DIRECTLY.has(resolveCorpusId(corpusId))
    ? destDir
    : path.join(destDir, entry.extractDir);
  const required = requiredContentFor(corpusId);

  const steps = [
    `语料：${corpusId}（${entry.title}）`,
    `来源：${url}`,
    `预期大小：${entry.bytes} 字节`,
    `预期 sha256：${entry.sha256}`,
  ];
  const base = {
    corpusId,
    url,
    bytes: entry.bytes,
    sha256: entry.sha256,
    destDir,
    corpusDir,
    applied: Boolean(options.apply),
    steps,
  };

  if (!options.apply) {
    steps.push("dry-run：未下载任何内容。加 apply 才会实际下载。");
    return { ...base, ok: false, reason: "DRY_RUN" };
  }

  await mkdir(destDir, { recursive: true });
  const staging = await mkdtemp(path.join(destDir, ".staging-"));
  const archive = path.join(staging, `${corpusId}.tar.gz`);

  try {
    steps.push("下载中…");
    await download({ ...entry, url }, archive, overrides);

    const size = (await stat(archive)).size;
    if (size !== entry.bytes) {
      throw new CorpusError(
        "SIZE_MISMATCH",
        `下载大小不符：期望 ${entry.bytes} 字节，实际 ${size} 字节`,
        "这通常意味着下载被截断或资产已被替换。已保留原有数据未做任何改动，请重试。",
      );
    }
    steps.push(`大小校验通过：${size} 字节`);

    const digest = await (overrides.sha256File ?? corpusDeps.sha256File ?? sha256File)(archive);
    if (digest !== entry.sha256) {
      throw new CorpusError(
        "SHA256_MISMATCH",
        `sha256 校验失败：期望 ${entry.sha256}，实际 ${digest}`,
        "资产与清单不一致。已保留原有数据未做任何改动。若你信任该来源，请用 xyb-pack-corpus.mjs --write-manifest 重新生成清单。",
      );
    }
    steps.push(`sha256 校验通过：${digest}`);

    const extractRoot = path.join(staging, "extract");
    await mkdir(extractRoot, { recursive: true });
    await (overrides.runTar ?? corpusDeps.runTar ?? runTar)(["-xzf", archive, "-C", extractRoot], staging);
    steps.push("解压完成（临时目录）");

    // 在它能替换任何东西之前先验证解压出来的内容：一个归档可以通过它的校验和，
    // 却仍然是这份代码用不了的形状。
    const contentRoot = await findContentRoot(extractRoot, required);
    steps.push(`解压内容校验通过（${required} 存在）`);

    // 安装布局必须匹配这个语料期待的样子：
    //
    //   nested - 归档里有包目录层级，装的是**整个解压根**（它装着包目录）。
    //            若把包本身装成 corpusDir，读取方会往深一层找，于是以
    //            NO_ARCHIVE_PACKAGES 拒绝。
    //   flat   - 载荷直接落在 corpusDir 下。
    //
    // 这就是替换源随语料不同的原因。
    const layout = LAYOUT_BY_CORPUS[resolveCorpusId(corpusId)] ?? "flat";
    const installSource = layout === "nested" ? extractRoot : contentRoot;

    if (layout === "nested" && contentRoot === extractRoot) {
      throw new CorpusError(
        "ARCHIVE_LAYOUT_UNEXPECTED",
        `归档 ${corpusId} 顶层直接是数据包内容，缺少包目录层级（期望形如 <归档>/<包名>/${required}）`,
        "读取方需要指向数据包的父目录。请用 xyb-pack-corpus.mjs 重新打包并更新清单。",
      );
    }

    // 准原子替换：先造好 <destDir>/<extractDir>.new，再用 rename 盖过旧目录。
    // 同一文件系统内的 rename 是原子的，所以读取方要么看到完整的旧语料，要么看到
    // 完整的新语料——绝不会看到写了一半的目录。旧数据只在新数据就位之后才删除。
    const next = `${corpusDir}.new`;
    const previous = `${corpusDir}.old`;
    await rm(next, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });

    try {
      await rename(installSource, next);
    } catch (error) {
      // 跨设备 rename 会以 EXDEV 失败，退化为复制。
      if (error.code !== "EXDEV") throw error;
      await fsp.cp(installSource, next, { recursive: true });
    }

    let replaced = false;
    try {
      await rename(corpusDir, previous);
      replaced = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(next, corpusDir);
    } catch (error) {
      // 把旧语料放回去，而不是留给用户一个「什么都没有」。
      if (replaced) {
        await rename(previous, corpusDir).catch(() => undefined);
      }
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
    steps.push(`已替换目标目录：${corpusDir}`);

    // 只有这份代码**真的能读**它，语料才算「装好了」。对归档数据包来说，意味着
    // 读取方遍历的文件确实在。在这里验证，才能挡住一次损坏的安装被报成成功、
    // 到查询时才发现。
    //
    // 这里是**按语料**判定的，不是一律要求 `json/`：那个附加条件只属于 CDE。
    // ChiCTR 的快照是单个 JSON 文件、Veeva 是一个 SQLite 库、ICTRP 是一个导出
    // 快照——它们都没有也不该有 `json/`，把 CDE 的形状套到它们头上会让一次完全
    // 正常的安装以 INSTALLED_ARCHIVE_UNUSABLE 失败（实测如此）。
    const extra = REQUIRED_EXTRA[resolveCorpusId(corpusId)] ?? [];
    const isUsable = async (dir) => {
      if (!(await exists(path.join(dir, required)))) return false;
      for (const name of extra) {
        if (!(await exists(path.join(dir, name)))) return false;
      }
      return true;
    };

    const candidates = [];
    if (await isUsable(corpusDir)) candidates.push(corpusDir);
    const dirEntries = await readdir(corpusDir, { withFileTypes: true });
    for (const child of dirEntries) {
      if (!child.isDirectory()) continue;
      const nested = path.join(corpusDir, child.name);
      if (await isUsable(nested)) candidates.push(nested);
    }

    if (candidates.length === 0) {
      const wants = [required, ...extra].join(" 与 ");
      throw new CorpusError(
        "INSTALLED_ARCHIVE_UNUSABLE",
        `解压后没有可用数据包（每个包都需要 ${wants}）：${corpusDir}`,
        "归档可能打包了错误的目录。请报告该问题并暂时指向可信来源。",
      );
    }
    const readable = candidates.map((candidate) => path.basename(candidate));
    steps.push(`归档可读：${readable.length} 个可用数据包（${readable.join("、")}）`);

    return {
      ...base,
      ok: true,
      reason: "INSTALLED",
      steps,
      packageDirs: candidates,
    };
  } finally {
    // 暂存区装着一整份语料；失败时也绝不留下来。
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 把已安装语料里的数据包挂载到**读取方实际读取的路径**。
 *
 * 这一步不能省，也不该被当成「复制文件」。下载成功、校验通过、包结构正确，
 * 都只说明**归档**是好的；只要它不在 `listArchiveDirs()` 扫描的位置下，患者
 * 依然查不到任何东西——那正是「下载报成功、查询却不可用」的形态。
 *
 * 挂载 = 在 `<outputRoot>/<包名>` 处建一个**符号链接**指向语料里的包目录。
 *
 * 为什么是符号链接而不是复制：
 *   - 包里有 90 MB 的 `word/`，复制一份是纯粹的浪费，还可能把磁盘占满；
 *   - 符号链接是原子的（`symlink` + `rename`），不会留下「复制了一半」的目录，
 *     而 MCP 的 `listArchiveDirs()` 恰好会跳过 `json/` 里没有记录的目录——
 *     一次中断的复制会安静地表现为「胰腺癌 0 条」。
 *
 * 为什么不直接改 `XYB_CHINADRUCTRIALS_DATA_DIR` 指向语料目录：
 *   那个环境变量是该 MCP 的**全局**数据根，用户的 `config.json`（Cookie 凭据）、
 *   `venv/`、以及他自己抓的其它关键词归档都住在那里。把根指向语料目录等于把
 *   用户的凭据和抓取环境一起搬走，代价远大于收益。挂载只往读取路径里加一个条目。
 *
 * 返回结构化结果而不是抛错：挂载是优化路径，失败不能阻断插件加载。
 */
async function mountCorpusPackages(options) {
  const { packageDirs, outputRoot, label } = options;
  const mounted = [];
  const skipped = [];
  const failed = [];

  if (!Array.isArray(packageDirs) || packageDirs.length === 0) {
    return { ok: false, reason: "NO_PACKAGES", label, outputRoot, mounted, skipped, failed };
  }

  try {
    await mkdir(outputRoot, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason: "MOUNT_ROOT_FAILED",
      label,
      outputRoot,
      mounted,
      skipped,
      failed,
      error: error && error.message ? error.message : String(error),
    };
  }

  for (const packageDir of packageDirs) {
    const name = path.basename(packageDir);
    const target = path.join(outputRoot, name);
    try {
      // 已经挂好的（含用户自己抓的）一律不动。判断用 lstat：对断链的符号链接
      // stat 会失败，而 lstat 能看出「这里有个条目」，那种情况该报出来而不是
      // 悄悄覆盖。
      let existing = null;
      try {
        existing = await fsp.lstat(target);
      } catch {
        existing = null;
      }
      if (existing) {
        if (existing.isSymbolicLink()) {
          const current = await fsp.readlink(target).catch(() => "");
          if (path.resolve(path.dirname(target), current) === path.resolve(packageDir)) {
            skipped.push({ name, reason: "ALREADY_MOUNTED" });
            continue;
          }
          // 指向别处的链接：不覆盖，如实记下来。用户可能刻意换了数据源。
          skipped.push({ name, reason: "SYMLINK_ELSEWHERE", pointsTo: current });
          continue;
        }
        // 真实目录：用户自己抓的数据，或者上一次的复制结果。绝不覆盖。
        skipped.push({ name, reason: "REAL_DIRECTORY_PRESENT" });
        continue;
      }

      // 原子挂载：先在同一个父目录下建临时链接，再 rename。
      const tmp = `${target}.mount-tmp`;
      await fsp.rm(tmp, { force: true });
      await fsp.symlink(packageDir, tmp, "dir");
      try {
        await fsp.rename(tmp, target);
      } catch (error) {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      mounted.push({ name, packageDir, target });
    } catch (error) {
      failed.push({
        name,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  return {
    ok: failed.length === 0 && mounted.length + skipped.length > 0,
    reason: mounted.length > 0 ? "MOUNTED" : failed.length > 0 ? "MOUNT_FAILED" : "ALREADY_PRESENT",
    label,
    outputRoot,
    mounted,
    skipped,
    failed,
  };
}

/** 把 `<包名>/summary.json` 里的条数读出来，供界面如实标注，而不是假装是全量。 */
function readPackageMeta(packageDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(packageDir, "summary.json"), "utf8"));
    return {
      total: raw.total_records ?? raw.total ?? (Array.isArray(raw.records) ? raw.records.length : null),
      keyword: raw.keyword ?? path.basename(packageDir),
      dataCutoff: raw.data_cutoff ?? raw.last_updated ?? null,
    };
  } catch (error) {
    return { error: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  CORPUS_ALIASES,
  CORPUS_BASES,
  DEFAULT_CORPUS_ID,
  INSTALL_DIRECTLY,
  DEFAULT_RETRIES,
  DOWNLOAD_TIMEOUT_MS,
  LAYOUT_BY_CORPUS,
  REQUIRED_CONTENT,
  REQUIRED_EXTRA,
  CorpusError,
  corpusDeps,
  describeFetchError,
  fetchCorpus,
  manifestPath,
  mountCorpusPackages,
  readManifest,
  readPackageMeta,
  requiredContentFor,
  resolveCorpusId,
  resolveEntry,
  sha256File,
};
