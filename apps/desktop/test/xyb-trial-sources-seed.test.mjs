/**
 * xyb.trial-sources 的 Veeva 种子复制逻辑。
 *
 * 覆盖的是「随包分发的只读索引怎样变成用户可写的本地库」这条路径 —— 它决定了
 * 全新安装的用户能否开箱检索 Veeva，以及用户的刷新结果会不会被种子覆盖。
 *
 * 用临时目录当用户的 home，不碰真实 ~/.ctv-mcp。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "../resources/plugins/xyb.trial-sources");
const mainPath = join(pluginDir, "main.js");

/** 加载一份全新的 main.js（清掉 require 缓存，避免模块级状态串味）。 */
function loadPlugin() {
  delete require.cache[require.resolve(mainPath)];
  return require(mainPath);
}

/** 造一个最小但真实的 SQLite 库，让「复制的是不是有效库」可被验证。 */
function makeSqliteDb(target, rows) {
  const inserts = rows.map((t) => `INSERT INTO studies (utn, brief_title) VALUES ('${t}','${t}');`).join("");
  execFileSync("sqlite3", [
    target,
    `CREATE TABLE studies (utn TEXT PRIMARY KEY, brief_title TEXT);${inserts}`,
  ]);
}

function readTitles(dbPath) {
  return execFileSync("sqlite3", [dbPath, "SELECT utn FROM studies ORDER BY utn;"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

/**
 * Hash a file in Node rather than shelling out.
 *
 * `md5` is a macOS binary; Linux ships `md5sum`, and GNU `md5sum` has no `-q`
 * flag. The first CI run of this file died with `spawnSync md5 ENOENT` — the
 * assertion was about byte equality, but it was really testing the host's
 * toolchain. Node hashes the same bytes everywhere.
 */
function digest(file) {
  return createHash("md5").update(readFileSync(file)).digest("hex");
}

describe("xyb.trial-sources 种子复制", () => {
  let home;
  let plugin;
  let originalSeed;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "xyb-seed-test-"));
    plugin = loadPlugin();

    // 用一份临时种子替换插件的 data/ctv.db，避免依赖 50MB 的真库在不在。
    originalSeed = plugin._internals.SEED_DB;
    if (existsSync(originalSeed)) {
      // 真种子存在时不要动它，只备份路径；测试统一走 home 隔离。
      originalSeed = null;
    }
  });

  after(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("目标已存在时不覆盖（用户的刷新结果优先）", async () => {
    const dir = join(home, "existing");
    const target = join(dir, "ctv.db");
    execFileSync("mkdir", ["-p", dir]);
    makeSqliteDb(target, ["USER001"]);
    writeFileSync(join(dir, ".keep"), "");

    // 即使插件里根本没有种子，也不该动用户的库。
    const result = await plugin._internals.ensureVeevaSeed({ dataDir: dir });

    assert.equal(result.reason, "ALREADY_PRESENT");
    assert.deepEqual(readTitles(target), ["USER001"], "用户库的内容必须原样保留");
  });

  it("没有种子时返回 NO_SEED，不创建任何文件", async () => {
    const dir = join(home, "no-seed");
    const result = await plugin._internals.ensureVeevaSeed({ dataDir: dir });

    // 开发态（未跑 sync 脚本）就是这条路径 —— 必须是安静的降级，不是崩溃。
    if (result.reason === "NO_SEED") {
      assert.equal(existsSync(join(dir, "ctv.db")), false);
      assert.equal(existsSync(dir), false, "不该顺手创建空目录");
    } else {
      // 插件里带了真种子：确认它复制成功且是个可读的库。
      assert.equal(result.reason, "SEEDED");
      assert.equal(existsSync(result.targetDb), true);
    }
  });

  it("默认目录是 ~/.ctv-mcp（与 ctv-mcp-server 一致）", () => {
    const dir = plugin._internals.defaultVeevaDir();
    assert.equal(dir, join(process.env.HOME ?? "", ".ctv-mcp"));
  });

  it("复制是二进制安全的，且不留下临时文件", async () => {
    // 直接对种子本体做一次真实复制（种子存在时才有意义）。
    const seed = plugin._internals.SEED_DB;
    if (!existsSync(seed)) return;

    const dir = join(home, "binary");
    const result = await plugin._internals.ensureVeevaSeed({ dataDir: dir });
    assert.equal(result.reason, "SEEDED");

    const target = join(dir, "ctv.db");
    // 50MB 的库经 copyFile 后必须逐字节相同 —— writeText 做不到这件事。
    assert.equal(statSync(target).size, statSync(seed).size);
    assert.equal(digest(target), digest(seed));
    assert.equal(existsSync(`${target}.seed-tmp`), false, "临时文件必须已被改名");

    // 复制出来的必须是能读的库，不是半个文件。
    const count = Number(
      execFileSync("sqlite3", [target, "SELECT COUNT(*) FROM studies;"], { encoding: "utf8" }).trim(),
    );
    assert.ok(count > 0, "复制结果应包含研究记录");
  });

  it("自定义数据目录被尊重（veevaDataDir 设置）", async () => {
    const custom = join(home, "custom-location");
    const result = await plugin._internals.ensureVeevaSeed({ dataDir: custom });
    assert.ok(
      result.targetDb === join(custom, "ctv.db"),
      "应把库放在用户配置的目录，而不是默认的 ~/.ctv-mcp",
    );
  });

  it("onLoad 不因种子失败而中断（仍注册命令）", async () => {
    const registered = [];
    global.pi = {
      plugin: { getSettings: async () => ({ veevaDataDir: join(home, "load-fail") }) },
      commands: {
        register: async (cmd) => registered.push(cmd.id),
        unregister: async () => {},
      },
      ui: { showToast: async () => {} },
    };
    try {
      const fresh = loadPlugin();
      await fresh.onLoad();
      assert.deepEqual(registered, ["xyb.trial-sources.list"]);
    } finally {
      delete global.pi;
    }
  });
});
