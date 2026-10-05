/**
 * 种子包的「安装 / 更新」流程（`seeds.js` + `corpus.js` 的协作）。
 *
 * 这个文件的重点是三件**用户会真的遇到**的事，而不是覆盖率：
 *
 *   1. 五个种子必须各装到**读取方真正去看的位置**。这一条尤其要紧——CDE 的
 *      MCP 只扫 `output/<关键词>/json/`，ChiCTR 只读一个快照文件，Veeva 直接
 *      打开一个 SQLite 库。装错一层不会报错，只会让查询永远「没有数据」。
 *      本文件用真实的归档（本地 `file://` 夹具）跑完整链路，不打桩。
 *
 *   2. **覆盖之前必须问。** 三个种子的目标同时是用户自己抓取数据的落点，所以
 *      流程被拆成「探测」与「执行」两步，且执行必须带用户同意。
 *
 *   3. **失败绝不破坏已有数据。** 下载被截断、资产被替换、tar 失败——任何一种
 *      都必须让用户原来那份数据原封不动，而不是留下一个半坏的包。
 *
 * 夹具用的是**真正打包出来的归档**（`makeArchive` 走与 `xyb-pack-corpus.mjs`
 * 相同的形状），因为这一整套流程的价值就在于形状对不对——用手写的假 tar 测，
 * 恰好会把「装错了一层」这种事漏过去。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { after, before, beforeEach, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "../resources/plugins/xyb.trial-sources");

const sandbox = mkdtempSync(join(tmpdir(), "xyb-seeds-"));
const fakeHome = join(sandbox, "home");
const archiveDir = join(sandbox, "archives");
mkdirSync(fakeHome, { recursive: true });
mkdirSync(archiveDir, { recursive: true });

/**
 * 让 `os.homedir()` 指到沙箱。
 *
 * `seeds.js` 与 `corpus.js` 都用 `os.homedir()` 求路径，而它在模块加载时就可能
 * 被读走——所以必须在 require 之前改掉，并且之后每个用例都重新清缓存加载。
 */
const realHomedir = require("node:os").homedir;
require("node:os").homedir = () => fakeHome;

// ── 归档构造：与 xyb-pack-corpus.mjs 相同的形状 ──────────────────────────────

function tarHeader(name, size, mode, mtime) {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) =>
    header.write(value.slice(0, length).padEnd(length, "\0"), offset, length, "utf8");
  write(name, 0, 100);
  write(mode.toString(8).padStart(7, "0"), 100, 8);
  write("0000000", 108, 8);
  write("0000000", 116, 8);
  write(size.toString(8).padStart(11, "0"), 124, 12);
  write(mtime.toString(8).padStart(11, "0"), 136, 12);
  header.write("        ", 148, 8, "utf8");
  write("0", 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(sum.toString(8).padStart(6, "0"), 148, 7);
  header.write(" ", 154, 1, "utf8");
  return header;
}

function pad512(size) {
  return (512 - (size % 512)) % 512;
}

/**
 * 打一个 tar.gz。`entries` 是 `[[归档内路径, 内容], …]`。
 *
 * 确定性（gzip mtime 0、条目按路径排序）与 `xyb-pack-corpus.mjs` 一致，这样
 * 「同一份数据产生同一个 sha256」这条保证在测试里也成立。
 */
async function makeArchive(name, entries) {
  const { createWriteStream } = require("node:fs");
  const { Readable } = require("node:stream");
  const { pipeline } = require("node:stream/promises");

  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const chunks = async function* () {
    for (const [entryName, content] of sorted) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      yield tarHeader(entryName, buf.length, 0o644, 0);
      yield buf;
      const padding = pad512(buf.length);
      if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(1024);
    yield Buffer.alloc(pad512(1024));
  };

  const target = join(archiveDir, `${name}.tar.gz`);
  await pipeline(Readable.from(chunks()), createGzip({ level: 9, mtime: 0 }), createWriteStream(target));
  const bytes = readFileSync(target);
  return {
    path: target,
    url: `file://${target}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * 造一份清单，把所有语料都指向本地夹具归档。
 *
 * 不打桩 `fetch`：`file://` 分支本来就走 `copyFile`，比 mock 更接近真实行为，
 * 也顺带覆盖了那条分支的错误处理。
 */
function writeManifest(entries) {
  const manifestPath = join(pluginDir, "data", "corpora", "manifest.json");
  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  for (const [corpusId, info] of Object.entries(entries)) {
    manifest.corpora[corpusId] = {
      url: info.url,
      bytes: info.bytes,
      sha256: info.sha256,
      extractDir: corpusId,
      version: "2026-10-06",
      title: corpusId,
      basis: "community_owned",
      note: "测试夹具",
    };
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return () => writeFileSync(manifestPath, original, "utf8");
}

/** 清掉 require 缓存后重新加载，拿到干净的模块级状态。 */
function freshSeeds() {
  for (const f of ["seeds.js", "corpus.js"]) {
    delete require.cache[require.resolve(join(pluginDir, f))];
  }
  return require(join(pluginDir, "seeds.js"));
}

// ── 夹具归档 ────────────────────────────────────────────────────────────────

let fixtures = {};
let restoreManifest = () => {};

before(async () => {
  // 每个归档都做成「读取方真正期待的形状」：
  //   chictr   → 顶层单个快照文件
  //   cde      → 顶层 json/ 目录（MCP 扫的是 <关键词>/json/）
  //   ictrp    → 顶层单个导出文件
  //   veeva    → 顶层一个 SQLite 库
  fixtures.chictr = await makeArchive("chictr_pancreatic", [
    ["pancreatic_trials.json", JSON.stringify({ record_count: 468, built_at: "2026-10-05", keyword: "胰腺癌", records: [] })],
  ]);
  fixtures.cde = await makeArchive("cde_pancreatic", [
    ["json/CTR20130061.json", JSON.stringify({ reg_no: "CTR20130061" })],
    ["json/CTR20131232.json", JSON.stringify({ reg_no: "CTR20131232" })],
    ["json/index.json", JSON.stringify({ record_count: 2 })],
  ]);
  fixtures.ictrp = await makeArchive("ictrp_pancreatic_cancer", [
    ["pancreatic-cancer.json", JSON.stringify({ snapshot: { created_at: new Date().toISOString() }, trials: [{}, {}] })],
  ]);
  fixtures.veeva = await makeArchive("veeva_ctv", [["ctv.db", Buffer.from("SQLite format 3\0fake")]]);

  // 清单键必须是 corpusId：`resolveEntry` 按 corpusId 查清单，键写错会得到
  // CORPUS_NOT_IN_MANIFEST 或者（更糟）命中一个大小对不上的旧条目。
  restoreManifest = writeManifest({
    chictr_pancreatic: fixtures.chictr,
    cde_pancreatic: fixtures.cde,
    ictrp_pancreatic_cancer: fixtures.ictrp,
    veeva_ctv: fixtures.veeva,
  });
});

after(() => {
  restoreManifest();
  require("node:os").homedir = realHomedir;
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例都从「什么都没装」开始，否则前一个用例留下的文件会改变冲突探测结果。
  for (const dir of [".xyb-chictr", ".xyb-chinadrugtrials", ".xyb-ictrp", ".ctv-mcp"]) {
    rmSync(join(fakeHome, dir), { recursive: true, force: true });
  }
});

// ── 用例 ────────────────────────────────────────────────────────────────────

describe("种子注册表", () => {
  it("五个种子都在，且各自声明了来源与读取位置", () => {
    const seeds = freshSeeds();
    const ids = seeds.SEEDS.map((s) => s.corpusId).sort();
    assert.deepEqual(ids, [
      "cde_corpus_pancreatic",
      "cde_pancreatic",
      "chictr_pancreatic",
      "ictrp_pancreatic_cancer",
      "veeva_ctv",
    ]);

    for (const seed of seeds.SEEDS) {
      // 读取位置必须能被界面上写出来——用户需要知道自己装到哪了。
      assert.ok(seed.runtimeDir(), `${seed.corpusId} 缺少 runtimeDir`);
      assert.ok(seed.title, `${seed.corpusId} 缺少 title`);
      // 每个种子至少要声明一个会被写入的位置，否则冲突检测形同虚设。
      assert.ok(seed.targets().length > 0, `${seed.corpusId} 没有声明 targets`);
    }
  });

  it("未知的种子 id 抛错，而不是静默什么都不做", () => {
    const seeds = freshSeeds();
    assert.throws(() => seeds.seedById("nope"), /未知的种子包/);
  });
});

describe("安装落到读取方真正去看的位置", () => {
  it("ChiCTR 快照落在 ~/.xyb-chictr/pancreatic_trials.json", async () => {
    const seeds = freshSeeds();
    const result = await seeds.applyInstall("chictr_pancreatic", {
      consent: true,
      urlOverride: fixtures.chictr.url,
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    const target = join(fakeHome, ".xyb-chictr", "pancreatic_trials.json");
    assert.ok(existsSync(target), `期望 ${target} 存在`);
    // 不能多套一层目录——读取方直接打开这个文件。
    assert.ok(!existsSync(join(fakeHome, ".xyb-chictr", "chictr_pancreatic")));
  });

  it("CDE 纯 JSON 落在 <关键词>/json/ 下，MCP 才扫得到", async () => {
    const seeds = freshSeeds();
    const result = await seeds.applyInstall("cde_pancreatic", {
      consent: true,
      urlOverride: fixtures.cde.url,
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    const jsonDir = join(fakeHome, ".xyb-chinadrugtrials", "output", "胰腺癌", "json");
    assert.ok(existsSync(jsonDir), `期望 ${jsonDir} 存在`);
    assert.equal(readdirSync(jsonDir).filter((n) => n.endsWith(".json")).length, 3);
  });

  it("ICTRP 快照落在 ~/.xyb-ictrp/", async () => {
    const seeds = freshSeeds();
    await seeds.applyInstall("ictrp_pancreatic_cancer", {
      consent: true,
      urlOverride: fixtures.ictrp.url,
    });
    assert.ok(existsSync(join(fakeHome, ".xyb-ictrp", "pancreatic-cancer.json")));
  });

  it("Veeva 库落在 ~/.ctv-mcp/ctv.db", async () => {
    const seeds = freshSeeds();
    await seeds.applyInstall("veeva_ctv", { consent: true, urlOverride: fixtures.veeva.url });
    assert.ok(existsSync(join(fakeHome, ".ctv-mcp", "ctv.db")));
  });
});

describe("覆盖之前必须征求同意", () => {
  it("目标已存在时 planInstall 报告冲突并要求同意", async () => {
    const seeds = freshSeeds();
    // 先造出「用户已经有一份」的局面。
    mkdirSync(join(fakeHome, ".xyb-chictr"), { recursive: true });
    writeFileSync(join(fakeHome, ".xyb-chictr", "pancreatic_trials.json"), "user data", "utf8");

    const plan = await seeds.planInstall("chictr_pancreatic");
    assert.equal(plan.needsConsent, true);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].userData, true, "必须标明这可能是用户自己抓的数据");
    // 网络提示要出现在**用户决定之前**，而不是下载失败之后。
    assert.match(plan.networkNotice, /VPN/);
  });

  it("没有同意时拒绝执行，且不碰磁盘", async () => {
    const seeds = freshSeeds();
    const target = join(fakeHome, ".xyb-chictr", "pancreatic_trials.json");
    mkdirSync(join(fakeHome, ".xyb-chictr"), { recursive: true });
    writeFileSync(target, "user data", "utf8");

    const result = await seeds.applyInstall("chictr_pancreatic", { urlOverride: fixtures.chictr.url });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "NEEDS_CONSENT");
    // 最关键的一条：用户的数据一个字节都没动。
    assert.equal(readFileSync(target, "utf8"), "user data");
  });

  it("带同意时覆盖成功", async () => {
    const seeds = freshSeeds();
    const target = join(fakeHome, ".xyb-chictr", "pancreatic_trials.json");
    mkdirSync(join(fakeHome, ".xyb-chictr"), { recursive: true });
    writeFileSync(target, "user data", "utf8");

    const result = await seeds.applyInstall("chictr_pancreatic", {
      consent: true,
      urlOverride: fixtures.chictr.url,
    });
    assert.equal(result.ok, true);
    assert.match(readFileSync(target, "utf8"), /record_count/);
  });

  it("全新安装无需同意（没有东西可覆盖）", async () => {
    const seeds = freshSeeds();
    const plan = await seeds.planInstall("ictrp_pancreatic_cancer");
    assert.equal(plan.needsConsent, false);
    assert.equal(plan.conflicts.length, 0);

    const result = await seeds.applyInstall("ictrp_pancreatic_cancer", {
      urlOverride: fixtures.ictrp.url,
    });
    assert.equal(result.ok, true, "无冲突时应能直接装");
  });

  it("语料目录不是用户数据落点，因此不要求同意", async () => {
    const seeds = freshSeeds();
    const cdeCorpus = seeds.seedById("cde_corpus_pancreatic");
    assert.equal(
      cdeCorpus.targets().every((t) => t.userData === false),
      true,
      "~/.xyb-chinadrugtrials/corpora 只放语料，覆盖它不碰用户抓取的数据",
    );
  });
});

describe("失败绝不破坏已有数据", () => {
  it("资产被篡改（sha256 不符）时保留原数据", async () => {
    const seeds = freshSeeds();
    const target = join(fakeHome, ".xyb-ictrp", "pancreatic-cancer.json");
    mkdirSync(join(fakeHome, ".xyb-ictrp"), { recursive: true });
    writeFileSync(target, "precious user snapshot", "utf8");

    // 清单里声明的是真摘要，喂一个被改过的文件。
    const tampered = join(archiveDir, "tampered.tar.gz");
    const buf = readFileSync(fixtures.ictrp.path);
    buf[buf.length - 50] ^= 0xff;
    writeFileSync(tampered, buf);

    const result = await seeds
      .applyInstall("ictrp_pancreatic_cancer", { consent: true, urlOverride: `file://${tampered}` })
      .catch((error) => ({ ok: false, reason: error.reasonCode }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "SHA256_MISMATCH");
    assert.equal(readFileSync(target, "utf8"), "precious user snapshot");
  });

  it("下载被截断（大小不符）时保留原数据", async () => {
    const seeds = freshSeeds();
    const target = join(fakeHome, ".xyb-ictrp", "pancreatic-cancer.json");
    mkdirSync(join(fakeHome, ".xyb-ictrp"), { recursive: true });
    writeFileSync(target, "precious user snapshot", "utf8");

    const truncated = join(archiveDir, "truncated.tar.gz");
    const whole = readFileSync(fixtures.ictrp.path);
    // 取一半：固定 200 字节会随夹具归档大小变化而偶然「刚好够大」，
    // 那样就变成了 sha256 失败而不是这里要测的大小失败。
    writeFileSync(truncated, whole.subarray(0, Math.max(1, Math.floor(whole.length / 2))));

    const result = await seeds
      .applyInstall("ictrp_pancreatic_cancer", { consent: true, urlOverride: `file://${truncated}` })
      .catch((error) => ({ ok: false, reason: error.reasonCode }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "SIZE_MISMATCH");
    assert.equal(readFileSync(target, "utf8"), "precious user snapshot");
  });

  it("本地镜像不存在时给出 DOWNLOAD_FAILED 而不是裸 ENOENT", async () => {
    const seeds = freshSeeds();
    const result = await seeds
      .applyInstall("ictrp_pancreatic_cancer", {
        consent: true,
        urlOverride: `file://${join(archiveDir, "does-not-exist.tar.gz")}`,
      })
      .catch((error) => ({ ok: false, reason: error.reasonCode, message: error.message }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "DOWNLOAD_FAILED");
    assert.match(result.message, /本地语料镜像失败/);
  });
});

describe("面板通道契约", () => {
  /** 造一个够用的 pi 桩，只为驱动 onPanelInvoke。 */
  async function panel() {
    for (const f of ["main.js", "seeds.js", "corpus.js"]) {
      delete require.cache[require.resolve(join(pluginDir, f))];
    }
    global.pi = {
      plugin: { id: "xyb.trial-sources", dataDir: pluginDir },
      ui: { showToast: async () => {} },
      commands: { register: async () => {}, unregister: async () => {} },
      fs: {},
    };
    return require(join(pluginDir, "main.js"));
  }

  it("list 通道带出五个种子与网络提示", async () => {
    const plugin = await panel();
    const res = await plugin.onPanelInvoke("xyb.trial-sources.list", {});
    assert.equal(res.seeds.length, 5);
    // VPN 提示必须在列表里就有——用户要在点按钮**之前**看到它。
    assert.match(res.seedNetworkNotice, /VPN/);
  });

  it("seed-plan 只探测，不下载", async () => {
    const plugin = await panel();
    const result = await plugin.onPanelInvoke("xyb.trial-sources.seed-plan", {
      corpusId: "chictr_pancreatic",
    });
    assert.equal(typeof result.needsConsent, "boolean");
    assert.ok(Array.isArray(result.conflicts));
    assert.match(result.networkNotice, /VPN/);
  });

  it("缺 corpusId 时抛 INVALID_ARGUMENT，而不是拿 undefined 去查", async () => {
    const plugin = await panel();
    await assert.rejects(
      () => plugin.onPanelInvoke("xyb.trial-sources.seed-install", {}),
      (error) => error.code === "INVALID_ARGUMENT",
    );
  });

  it("未实现的通道仍然抛 NOT_FOUND", async () => {
    const plugin = await panel();
    await assert.rejects(
      () => plugin.onPanelInvoke("xyb.trial-sources.nope", {}),
      (error) => error.code === "NOT_FOUND",
    );
  });

  it("seed-install 不接受非 true 的 consent", async () => {
    const plugin = await panel();
    // 界面若把 consent 传成字符串 "true"，也必须按「未同意」处理。
    const target = join(fakeHome, ".xyb-chictr", "pancreatic_trials.json");
    mkdirSync(join(fakeHome, ".xyb-chictr"), { recursive: true });
    writeFileSync(target, "user data", "utf8");

    const result = await plugin.onPanelInvoke("xyb.trial-sources.seed-install", {
      corpusId: "chictr_pancreatic",
      consent: "true",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "NEEDS_CONSENT");
    assert.equal(readFileSync(target, "utf8"), "user data");
  });
});

describe("安装后的状态探测", () => {
  it("describeSeeds 如实报告未装与已装，不臆测条数", () => {
    const seeds = freshSeeds();
    let described = seeds.describeSeeds();
    const cde = described.find((d) => d.corpusId === "cde_pancreatic");
    assert.equal(cde.state.installed, false);
    assert.equal(cde.state.records, null);

    // 装一份真的进去，再探测一次。
    mkdirSync(join(fakeHome, ".xyb-chinadrugtrials", "output", "胰腺癌", "json"), { recursive: true });
    writeFileSync(join(fakeHome, ".xyb-chinadrugtrials", "output", "胰腺癌", "json", "CTR1.json"), "{}", "utf8");
    writeFileSync(join(fakeHome, ".xyb-chinadrugtrials", "output", "胰腺癌", "json", "index.json"), "{}", "utf8");

    described = freshSeeds().describeSeeds();
    const cde2 = described.find((d) => d.corpusId === "cde_pancreatic");
    assert.equal(cde2.state.installed, true);
    // index.json 是清单不是记录，不该被算成一条试验。
    assert.equal(cde2.state.records, 1);
  });

  it("Veeva 的条数不猜，只报可核对的大小", async () => {
    const seeds = freshSeeds();
    await seeds.applyInstall("veeva_ctv", { consent: true, urlOverride: fixtures.veeva.url });
    const veeva = freshSeeds()
      .describeSeeds()
      .find((d) => d.corpusId === "veeva_ctv");
    assert.equal(veeva.state.installed, true);
    // 开 SQLite 需要绑定；拿不准就不报数字，只说存在与大小。
    assert.equal(veeva.state.records, null);
    assert.ok(veeva.state.bytes > 0);
  });

  it("ICTRP 快照超过 28 天会被标成过期", () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    mkdirSync(join(fakeHome, ".xyb-ictrp"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".xyb-ictrp", "pancreatic-cancer.json"),
      JSON.stringify({ snapshot: { created_at: old }, trials: [{}] }),
      "utf8",
    );
    const ictrp = freshSeeds()
      .describeSeeds()
      .find((d) => d.corpusId === "ictrp_pancreatic_cancer");
    assert.equal(ictrp.state.stale, true);
    assert.equal(ictrp.state.records, 1);
  });
});
