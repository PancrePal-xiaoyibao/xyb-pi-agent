#!/usr/bin/env node
/**
 * 把离线数据包打成 Release 资产，并更新 `corpora/manifest.json`（`fetch-corpus` 据此校验）。
 *
 * 清单就是契约：`fetch-corpus` 拒绝安装 sha256 或字节数不符的资产。这样一次中断的
 * 下载、一个被截断的文件、一个被替换的资产都会变成硬失败，并**保持原有数据原封不动**
 * ——而不是装进一个半坏的包，让检索给出错误的结论。
 *
 * 本脚本必须保证两件事：
 *
 *   1. 可复现。同一份数据打两次必须得到同一个 sha256，否则清单与已上传的资产会
 *      悄悄漂移。GNU tar 并非处处可用（macOS 的 `bsdtar` 拒绝 `--mtime`），所以这里
 *      用 node:zlib 自己写归档，不调 shell。确定性来自 gzip 头（mtime 0）加**排序**
 *      目录遍历——readdir 的顺序取决于文件系统，未排序的归档在另一台机器上哈希不同。
 *
 *   2. 不谎报时间。gzip 头被清零，但每个 tar 条目保留真实 mtime。数据截点是从数据
 *      **内部**读出的（记录里的 `scrape_time`），所以并不依赖这里——但用户手工核对
 *      文件与文档中的截点时，靠的就是这些真实时间戳。
 *
 * 用法：
 *   node scripts/xyb-pack-corpus.mjs --corpus xyb_cde_pancreatic --source <数据目录>
 *        [--out <目录>] [--write-manifest]
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DATA = path.join(ROOT, "apps", "desktop", "resources", "plugins", "xyb.trial-sources", "data");
const MANIFEST_PATH = path.join(PLUGIN_DATA, "corpora", "manifest.json");

/**
 * 每个语料显式声明源目录里的哪些路径进归档。逐个列出（而不是把整个目录打进去）
 * 才能把游离文件——`.DS_Store`、编辑器备份——挡在发布资产之外。
 *
 * `source` 是打包**来源**目录，仅在打包时用到（指向本机抓取树，可用 `--source` 覆盖）；
 * 它**故意不写进清单**，因为那会泄漏打包者的机器布局，对接装方毫无意义。
 */
const CORPORA = {
  xyb_cde_pancreatic: {
    title: "小胰宝 CDE 胰腺癌社区归档",
    // 整包：结构化 JSON、CDE 原始页面快照、以及站点导出的 DOC/DOCX。
    // `word/` 占了约 109 MB 源目录里的 90 MB，服务从不内联它（只作为路径报告），
    // 但权利人选择分发全部内容，所以它随包发出。
    //
    // 条目是**数据包目录本身**（`胰腺癌`），所以归档保持 `output/` 那样的形状：
    // 解压出来的树把包作为子目录，这正是 `--xyb-archive` 期待的（它扫描该目录下
    // 含 summary.json 的子目录）。若把包**内容**打进去，装出来的目录会被适配器
    // 以 NO_ARCHIVE_PACKAGES 拒绝。
    entries: ["胰腺癌"],
    extractDir: "xyb_cde_pancreatic",
    basis: "community_owned",
    note:
      "小胰宝社区自行抓取并整理的 CDE 胰腺癌数据包（结构化 JSON + 原始 HTML 快照 + 网页导出 DOC/DOCX）；" +
      "分发依据是社区对该抓取成果自身拥有分发权。上游站点为受控来源，" +
      "本包不是上游官方数据集，登记信息可能被随时修订。",
  },

  /**
   * 以下四个是「可独立更新的种子包」。它们与 `xyb_cde_pancreatic` 的区别只在于
   * **更新频率**：那一个是完整归档（含证据文件，体积大、发布少），这四个是各来源
   * 的检索快照，随上游数据变化可以单独重发。
   *
   * 每个都用 `entries` 显式列出进归档的路径，理由与上面相同：把游离文件挡在
   * 发布资产之外。下面的 `flat` 布局意味着**解压出来的就是目标目录的内容**——
   * 对应地，`entries` 通常指向源树里的一个目录，打包器会把它**内容**铺平
   * （见 `--flatten`）。读取方（ChiCTR / ICTRP 的快照加载、ctv-mcp-server）
   * 直接指向那个文件，多一层目录会让它们找不到东西。
   */
  chictr_pancreatic: {
    title: "小胰宝 ChiCTR 胰腺癌快照",
    // 源树里 ChiCTR 种子是 `data/chictr/pancreatic_trials.json`，归档里要直接
    // 铺在顶层，所以条目指向**那个文件**并 flatten（其 archiveRoot 即条目目录）。
    entries: ["chictr"],
    extractDir: "chictr_pancreatic",
    flatten: true,
    basis: "community_owned",
    note:
      "小胰宝社区抓取的 ChiCTR（中国临床试验注册中心）胰腺癌结构化快照，468 条。" +
      "分发依据是社区对该抓取成果自身拥有分发权。**只覆盖胰腺癌**：本地 0 命中" +
      "只能说明「快照里没有」，不能说明「没有相关试验」。",
  },
  cde_pancreatic: {
    title: "小胰宝 CDE 胰腺癌纯 JSON 种子",
    // 纯 JSON 那一份（139 条 + index.json），不含 raw/ 与 word/。
    //
    // 安装目标是 MCP 的 `<关键词>/json/` 那一层，所以归档里必须有 `json/`。
    // 源树是平铺的（`data/chinadrugtrials/*.json`），因此用一个**目录包装**：
    // 条目是 `data/chinadrugtrials`，`wrap` 声明「把这些文件装进 json/ 下」。
    // 这样源树的形状与归档要的形状分开描述，而不是把映射写死在某一侧。
    entries: ["chinadrugtrials"],
    extractDir: "cde_pancreatic",
    wrap: "json",
    basis: "community_owned",
    note:
      "小胰宝社区抓取的 CDE 胰腺癌结构化 JSON（139 条，不含原始页面与 DOC 导出）。" +
      "这是「没网也能查」的兜底数据；需要证据文件时请装完整归档。",
  },
  ictrp_pancreatic_cancer: {
    title: "WHO ICTRP 胰腺癌快照",
    entries: ["ictrp"],
    extractDir: "ictrp_pancreatic_cancer",
    flatten: true,
    basis: "upstream_public",
    note:
      "WHO ICTRP 导出的胰腺癌检索结果快照（6262 条命中；上游自报 6952，本包是下界）。" +
      "WHO 条款要求标注来源并显示 WHO 处理该数据的日期，且不得主张专有权利或用于商业用途；" +
      "界面必须随数据一并显示 attribution 与 ictrp_export_date。",
  },
  veeva_ctv: {
    title: "Veeva CTV 本地索引",
    // 单个 SQLite 库，源树里就在 data/ 顶层。
    entries: ["ctv.db"],
    extractDir: "veeva_ctv",
    flatten: true,
    basis: "upstream_public",
    note:
      "Veeva CTV（Clinical Trials Veeva）公开试验索引的本地 SQLite 副本。" +
      "上游为公开站点地图数据；刷新请用 ctv-mcp-server 的 sync_sitemap / backfill_details。",
  },
};

/** 各语料在本机打包时的默认数据位置。 */
const DEFAULT_SOURCES = {
  xyb_cde_pancreatic: path.join(homedir(), "Downloads", "xyb-chinadrugtrials-data", "output"),
  // 其余四个从插件的随包种子目录重新打包：那已经是经过同步脚本瘦身、校验过的
  // 形状，直接以它为源可以保证「发布的资产」与「随包分发的种子」是同一份数据。
  // 注意源根是 `data/` 本身，所以上面的 entries 都带 `data/` 前缀。
  chictr_pancreatic: PLUGIN_DATA,
  cde_pancreatic: PLUGIN_DATA,
  ictrp_pancreatic_cancer: PLUGIN_DATA,
  veeva_ctv: PLUGIN_DATA,
};

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(token.slice(2), true);
    } else {
      flags.set(token.slice(2), next);
      i += 1;
    }
  }
  return flags;
}

/** tar 头：512 字节，ustar 格式。 */
function tarHeader(name, size, mode, typeflag, mtime) {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) =>
    header.write(value.slice(0, length).padEnd(length, "\0"), offset, length, "utf8");

  // 超长路径：直接报错而不是静默截断——截断的路径会解压出错误的树。
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`路径超出 ustar 单条目上限（${name}）；请重新划分语料`);
  }

  write(name, 0, 100);
  write(mode.toString(8).padStart(7, "0"), 100, 8);
  write("0000000", 108, 8); // uid
  write("0000000", 116, 8); // gid
  write(size.toString(8).padStart(11, "0"), 124, 12);
  write(mtime.toString(8).padStart(11, "0"), 136, 12);
  header.write("        ", 148, 8, "utf8"); // 校验和占位
  write(typeflag, 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2); // 不写 uname/gname：跨机器可复现

  let sum = 0;
  for (const byte of header) sum += byte;
  write(sum.toString(8).padStart(6, "0"), 148, 7);
  header.write(" ", 154, 1, "utf8");
  return header;
}

function pad512(size) {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

/**
 * 这些文件从来不属于数据，只属于采集它的那台机器。声明 `entries` 只挡住了**顶层**
 * 杂物，而它们会出现在我们确实归档的目录深处（小胰宝数据包带两个 `.DS_Store`，
 * 其中一个在 `word/` 里），发布资产不该带上打包者的操作系统簿记。
 *
 * 排除它们会改变 sha256，所以这张表是资产身份的一部分：旧打包器写出的清单将不再
 * 匹配新归档。
 */
const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function isIgnored(name) {
  return IGNORED_NAMES.has(name) || name.endsWith(".swp") || name.endsWith("~");
}

/**
 * 归档里的路径该以什么为根。
 *
 * 三种布局：
 *   - nested（默认） 条目自身为根 → `胰腺癌/…`。读取方扫描父目录下含
 *                    `summary.json` 的子目录，所以**包目录层级必须在**。
 *   - flatten       条目**内容**铺到顶层 → `pancreatic_trials.json` 在根。
 *                    读取方直接指向那个文件名，多一层就找不到。
 *   - wrap          条目内容装进一个指定名字的目录 → `json/*.json`。
 *                    用于「源树平铺、但读取方要一层目录」的情况（CDE 纯 JSON）。
 */
function entryRoots(real, spec) {
  // 关键：`strip` 是**要从归档路径里去掉的前缀**，`prefix` 是要加上的目录。
  //
  // nested 时两者相同（条目名既在源路径里出现，也应该是归档里的顶层目录）。
  // flatten / wrap 时条目名必须被**去掉**——否则 `data/chictr/` 会变成
  // `chictr/`，读取方直接指向 `pancreatic_trials.json` 就找不到东西。
  if (spec.wrap) return { archiveRoot: real, strip: real, prefix: spec.wrap };
  if (spec.flatten) return { archiveRoot: real, strip: real, prefix: "" };
  // nested：条目自身就是归档里的顶层目录（`胰腺癌/…`）。
  return { archiveRoot: real, strip: "", prefix: path.basename(real) };
}

/**
 * 按稳定顺序（排序、深度优先）遍历声明的条目。
 *
 * 排序很重要：readdir 的顺序取决于文件系统，不稳定的顺序会在另一台机器上产生
 * 不同的归档——因而不同的 sha256。
 */
async function collect(sourceDir, entries, options = {}) {
  const files = [];

  for (const entry of entries) {
    const full = path.join(sourceDir, entry);
    const info = await stat(full);
    // 条目在**源树里**的相对路径。文件条目要用它的父目录作为归档基准。
    const realPath = entry;
    const { archiveRoot, strip, prefix } = entryRoots(entry, options);

    if (info.isDirectory()) {
      const walk = async (dir) => {
        const children = await readdir(dir, { withFileTypes: true });
        children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const child of children) {
          if (isIgnored(child.name)) continue;
          const childPath = path.join(dir, child.name);
          if (child.isDirectory()) await walk(childPath);
          else if (child.isFile()) files.push({ file: childPath, archiveRoot, strip, prefix });
        }
      };
      await walk(full);
    } else if (info.isFile()) {
      // 文件条目：**它自己就是归档里的那一个文件**，所以基准必须是它的父目录。
      //
      // `archiveRoot` 来自 `entryRoots`，对文件条目而言那是文件自身的路径，
      // 两相相减得到空字符串——会写出一个没有名字、tar 无法解压的条目（实测
      // `tar: Archive entry has empty or unreadable filename`）。这里覆盖成
      // 父目录，并且不加任何 prefix：`ctv.db` 在归档里就叫 `ctv.db`。
      files.push({ file: full, archiveRoot: path.dirname(realPath), strip: "", prefix: "" });
    } else {
      throw new Error(`不支持的条目类型：${entry}`);
    }
  }
  return files;
}

async function buildArchive(sourceDir, files, assetPath) {
  const chunks = async function* () {
    for (const item of files) {
      const info = await stat(item.file);
      // 归档内的路径以 `archiveRoot` 为基准，而不是 sourceDir——flatten 的语料
      // 正是靠这一点把条目内容铺到顶层。
      let relative = path
        .relative(path.join(sourceDir, item.archiveRoot), item.file)
        .split(path.sep)
        .join("/");
      // 去掉条目名本身：flatten / wrap 要的是条目**内容**，不是条目。
      if (item.strip) {
        const prefixWithSlash = `${item.strip.replace(/\/$/, "")}/`;
        if (relative.startsWith(prefixWithSlash)) relative = relative.slice(prefixWithSlash.length);
      }
      // `prefix` 是「归档里该有的那层目录」——CDE 纯 JSON 的读取方要 `json/`，
      // 而源树是平铺的。不设时直接是文件名。
      const name = item.prefix ? `${item.prefix}/${relative}` : relative;
      // 保留文件真实 mtime。离线适配器从数据内部读截点，但用户手工核对时会与
      // 文件系统比对——把它们钉成假日期会主动误导。确定性来自 gzip 头（mtime 0）
      // 与排序遍历，不是靠伪造文件时间。
      yield tarHeader(name, info.size, 0o644, "0", Math.floor(info.mtimeMs / 1000));
      yield* createReadStream(item.file);
      const padding = pad512(info.size);
      if (padding) yield Buffer.alloc(padding);
    }
    // tar 以两个零块结束，再补齐到 gzip 块大小。
    yield Buffer.alloc(1024);
    yield Buffer.alloc(pad512(1024));
  };

  await pipeline(
    Readable.from(chunks()),
    // mtime: 0 把打包时刻从 gzip 头里去掉。不这么做，同一份数据每次运行哈希都不同，
    // 清单就永远无法被信任为与已发布资产一致。
    createGzip({ level: 9, mtime: 0 }),
    createWriteStream(assetPath),
  );
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const corpusId = typeof flags.get("corpus") === "string" ? flags.get("corpus") : undefined;
  const explicitSource = typeof flags.get("source") === "string" ? flags.get("source") : undefined;

  if (!corpusId || !CORPORA[corpusId]) {
    process.stderr.write(
      `用法：node scripts/xyb-pack-corpus.mjs --corpus <${Object.keys(CORPORA).join("|")}> [--source <数据目录>] [--out <目录>] [--write-manifest]\n`,
    );
    return 2;
  }

  const spec = CORPORA[corpusId];
  // 保留 --source：换台机器打包（或从备份重建）的人不必改这个文件；默认值只是
  // 发布者本机上数据通常所在的位置。
  const source = explicitSource ?? DEFAULT_SOURCES[corpusId];
  if (!source) {
    process.stderr.write(`${corpusId} 需要 --source <数据目录>\n`);
    return 2;
  }
  const sourceDir = path.resolve(source);
  const outDir = path.resolve(
    typeof flags.get("out") === "string" ? flags.get("out") : path.join(ROOT, "dist-release"),
  );

  // 开始前每个声明的条目都必须存在：缺一个 html/ 目录会产出一个「成功」但静默
  // 不完整的归档。
  for (const entry of spec.entries) {
    const full = path.join(sourceDir, entry);
    try {
      await stat(full);
    } catch {
      process.stderr.write(`源目录中缺少条目：${entry}（解析为 ${full}）\n`);
      return 1;
    }
  }

  await mkdir(outDir, { recursive: true });
  const assetName = `${corpusId}.tar.gz`;
  const assetPath = path.join(outDir, assetName);

  const files = await collect(sourceDir, spec.entries, spec);
  process.stdout.write(
    `正在打包 ${files.length} 个文件，来自 ${sourceDir}（布局：${spec.flatten ? "flat" : "nested"}）\n`,
  );
  await buildArchive(sourceDir, files, assetPath);

  const info = await stat(assetPath);
  const digest = await sha256(assetPath);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const version = new Date().toISOString().slice(0, 10);
  const entry = {
    url: `https://github.com/PancrePal-xiaoyibao/xyb-pi-agent/releases/download/${corpusId}-${version}/${assetName}`,
    bytes: info.size,
    sha256: digest,
    extractDir: spec.extractDir,
    version,
    title: spec.title,
    // basis 刻意流入清单：fetch-corpus 拒绝没有它的条目，这样谁也不能悄悄加一个
    // 「看起来可分发」的资产而不声明分发依据。
    basis: spec.basis,
    note: spec.note,
  };

  process.stdout.write(
    `\n${assetName}\n  文件  : ${files.length}\n  字节  : ${info.size}\n  sha256: ${digest}\n  依据  : ${spec.basis}\n`,
  );

  if (flags.get("write-manifest")) {
    manifest.corpora[corpusId] = entry;
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`\n清单已更新：${path.relative(ROOT, MANIFEST_PATH)}\n`);
    process.stdout.write(
      `\n后续步骤（顺序重要——清单必须与已上传的资产一致）：\n` +
        `  1. gh release create ${corpusId}-${version} "${assetPath}" --title "${spec.title} ${version}"\n` +
        `  2. git add ${path.relative(ROOT, MANIFEST_PATH)} && git commit -m "data: 发布 ${corpusId} ${version}"\n`,
    );
  } else {
    process.stdout.write(`\n（试运行：清单未写入；加 --write-manifest 才会更新）\n`);
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
