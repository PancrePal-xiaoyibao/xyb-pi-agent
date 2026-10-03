/**
 * chinadrugtrials MCP 解析层回归测试。
 *
 * 覆盖两个真实缺陷（对 CTR20252528 归档实测发现）：
 *  1. 申请人名称在 details 里是占位符（实测为 '1'），真值只在 sections['基本信息']；
 *     直接回显占位符会把申办方写成「1」。
 *  2. 参加机构表在结构化 sections 中列错位：采集器 _extract_table_kv 对 6 列表按
 *     (cells[0],cells[1])、(cells[2],cells[3])… 机械配对，导致表头自己变成一组键值，
 *     数据行整体错位一格，且字典键冲突会把同省机构互相覆盖（38 家只剩 19 个省市键）。
 *     full_text 是无损顺序文本，必须从它还原。
 *
 * 这两个函数是纯函数，不触网、不读盘、不依赖 MCP 传输层。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(
  here,
  "../resources/plugins/xyb.trial-sources/mcp",
);

// MCP 是 .mjs，但内部是纯函数 + 副作用式启动；这里只导入文件、不调用 main()。
const modUrl = path.join(pluginDir, "chinadrugtrials-mcp.mjs");
const require = createRequire(import.meta.url);
void require;

/** 直接把源文件当 ESM 导入，取其中的纯函数（模块顶层只有声明，不会自动启动）。 */
async function loadModule() {
  return import(`${new URL(`file://${modUrl}`).href}`);
}

/** 目标归档里实测的 full_text 片段（表头 + 3 行，含键冲突的江苏省）。 */
const FULL_TEXT_EXCERPT = [
  "2、各参加机构信息",
  "序号",
  "机构名称",
  "主要研究者",
  "国家或地区",
  "省（州）",
  "城市",
  "1",
  "复旦大学附属肿瘤医院",
  "虞先濬",
  "中国",
  "上海市",
  "上海市",
  "2",
  "西安交通大学第一附属医院",
  "吴胤瑛",
  "中国",
  "陕西省",
  "西安市",
  "4",
  "苏州大学附属第一医院",
  "李伟",
  "中国",
  "江苏省",
  "苏州市",
  "5",
  "南京大学医学院附属鼓楼医院",
  "杜娟",
  "中国",
  "江苏省",
  "南京市",
  "五、伦理委员会信息",
  "序号",
  "审查结论",
].join("\n");

test("parseInstitutions 从 full_text 还原机构表，不再错位", async () => {
  const { _internals } = await loadModule();
  const rows = _internals.parseInstitutions(FULL_TEXT_EXCERPT);

  assert.equal(rows.length, 4, "应还原 4 家机构");
  assert.deepEqual(rows[0], {
    seq: 1,
    机构名称: "复旦大学附属肿瘤医院",
    主要研究者: "虞先濬",
    国家或地区: "中国",
    省: "上海市",
    城市: "上海市",
  });

  // 关键回归点：同省的两个机构必须各自保留自己的城市（错位实现会互相覆盖）。
  const suzhou = rows.find((r) => r.seq === 4);
  const nanjing = rows.find((r) => r.seq === 5);
  assert.equal(suzhou.城市, "苏州市");
  assert.equal(nanjing.城市, "南京市");
  assert.equal(nanjing.机构名称, "南京大学医学院附属鼓楼医院");
  assert.equal(nanjing.主要研究者, "杜娟");
});

test("parseInstitutions 遇到下一章节标题即停止", async () => {
  const { _internals } = await loadModule();
  const rows = _internals.parseInstitutions(FULL_TEXT_EXCERPT);
  // 「五、伦理委员会信息」之后的「序号/审查结论」不得被当成机构行。
  assert.ok(
    rows.every((r) => Number.isInteger(r.seq)),
    "所有行的 seq 都应是数字",
  );
  assert.equal(
    rows.some((r) => r.机构名称 === "审查结论"),
    false,
    "不得把伦理审查表当作机构表",
  );
});

test("parseInstitutions 对空/无关文本返回空数组而不是抛错", async () => {
  const { _internals } = await loadModule();
  assert.deepEqual(_internals.parseInstitutions(""), []);
  assert.deepEqual(_internals.parseInstitutions(undefined), []);
  assert.deepEqual(_internals.parseInstitutions("没有任何表格的正文"), []);
});

test("summarizeDetail 用真实申请人名称覆盖占位符", async () => {
  const { _internals } = await loadModule();
  const data = {
    reg_no: "CTR20252528",
    list_info: { title: "T", state: "进行中", drug_name: "D", indication: "I" },
    details: { 申请人名称: "1", 试验状态: "进行中" },
    sections: {
      基本信息: { 申请人名称: "信达生物制药（苏州）有限公司" },
      "二、申请人信息": { 申请人名称: "信达生物制药（苏州）有限公司" },
    },
    full_text: FULL_TEXT_EXCERPT,
  };
  const out = _internals.summarizeDetail(data);

  assert.equal(out.applicant_name, "信达生物制药（苏州）有限公司");
  assert.equal(out.scraped_applicant_name, "1", "归档原值应保留以便排查");
  assert.equal(
    Object.values(out.fields).includes("1"),
    false,
    "fields 里不得留下占位符当机构名",
  );
  assert.equal(out.institution_count, 4);
  assert.match(out.institution_note, /full_text/);
});

test("summarizeDetail 对纯数字申请人名不冒充真实值", async () => {
  const { _internals } = await loadModule();
  const out = _internals.summarizeDetail({
    reg_no: "X",
    details: { 申请人名称: "42" },
    sections: {},
    full_text: "",
  });
  assert.equal(out.applicant_name, "", "纯数字一律不当作申请人名称");
  assert.equal(out.institution_count, 0);
  assert.match(out.institution_note, /未能|不可直接使用/);
});

test("parseKeywords 拆分中英文逗号、顿号与空格并去重", async () => {
  const { _internals } = await loadModule();
  assert.deepEqual(
    _internals.parseKeywords("胰腺癌,实体瘤"),
    ["胰腺癌", "实体瘤"],
  );
  assert.deepEqual(
    _internals.parseKeywords("胰腺癌，实体瘤、KRAS KRAS"),
    ["胰腺癌", "实体瘤", "KRAS"],
  );
  assert.deepEqual(_internals.parseKeywords(""), []);
  assert.deepEqual(_internals.parseKeywords(["A", "B"]), ["A", "B"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// get_collector_status 的可用性判定回归。
//
// 两个真实缺陷（对本项目自身布局实测发现）：
//  3. collector_deps 只探测 venv 里能不能 import requests/bs4，完全看不到
//     「采集器脚本不在磁盘上」——MCP 单独发布成 npm 包、或插件目录被裁剪时，
//     体检报告会打印 ready: true 与 collector_deps.ok: true，直到真正调用
//     search_trials 才以 ENOENT 失败。可用性必须同时来自文件存在性与依赖探测。
//  4. bootstrap_plan 原先要求「python + deps + cookie 全部就绪」，而全新部署
//     恰恰还没有 cookie，于是最需要引导的新用户反而看不到任何提示。触发条件
//     必须放宽到「归档为空 + 采集器在 + python 在」，缺什么用 blockers 如实列出。
//
// 这里直接对真实模块做黑盒调用：用子进程按真实 MCP 传输层（JSON-RPC over
// stdio）取 get_collector_status 的结果，避免把实现细节抄进测试。
// ─────────────────────────────────────────────────────────────────────────────

const MCP_PATH = path.join(pluginDir, "chinadrugtrials-mcp.mjs");

/**
 * 以真实 stdio 传输层调用一个 MCP 工具，返回解析后的 JSON 结果。
 *
 * serverPath 必须可指定：验证「采集器缺失」时必须启动**被复制到隔离目录的那一份**，
 * 否则 PLUGIN_DIR 仍会解析回真实插件目录、采集器当然找得到，测试就永远是绿的假阳性。
 */
/** 以真实 stdio 传输层调用任意 MCP 工具，返回解析后的 JSON 结果。 */
function callTool({ dataDir, name, args = {}, serverPath = MCP_PATH, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env, XYB_CHINADRUCTRIALS_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP 调用超时（10s）"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "regression", version: "1" },
      },
    });
    setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 200);
    setTimeout(
      () =>
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      500,
    );
    setTimeout(() => {
      clearTimeout(timer);
      child.kill();
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 2) continue;
        const text = msg.result?.content?.[0]?.text;
        if (!text) return reject(new Error("工具未返回文本内容"));
        try {
          return resolve(JSON.parse(text));
        } catch (error) {
          return reject(new Error(`工具返回不是 JSON：${error.message}`));
        }
      }
      reject(new Error(`未收到 id=2 的响应；stdout=${out.slice(0, 400)}`));
    }, 3500);
  });
}

/** get_collector_status 的便捷包装。 */
function callStatusTool(opts) {
  return callTool({ ...opts, name: "get_collector_status", args: {} });
}

test("get_collector_status 在采集器脚本缺失时不得报告 ready", async () => {
  // 指向一个只有 mcp/ 而没有 collectors/ 的目录：等价于 MCP 被单独安装。
  const isolated = await fsp.mkdtemp(path.join(os.tmpdir(), "cdt-isolated-"));
  await fsp.mkdir(path.join(isolated, "mcp"), { recursive: true });
  const isolatedServer = path.join(isolated, "mcp", "chinadrugtrials-mcp.mjs");
  await fsp.copyFile(MCP_PATH, isolatedServer);
  const dataDir = path.join(isolated, "data");
  const status = await callStatusTool({ dataDir, serverPath: isolatedServer });

  assert.equal(status.collector_files.ok, false, "必须能发现采集器脚本缺失");
  assert.deepEqual(
    status.collector_files.missing.sort(),
    ["cookie_tools", "requirements", "scraper", "verifier"],
  );
  assert.equal(
    status.ready,
    false,
    "脚本都不在就不能说「已就绪」，否则 search_trials 必然 ENOENT",
  );
  assert.equal(
    status.collector_deps.ok,
    false,
    "脚本缺失时不得报依赖 ok（会误导用户以为只差 cookie）",
  );
  assert.match(status.next_steps.join("\n"), /采集器脚本缺失/);
  await fsp.rm(isolated, { recursive: true, force: true });
});

test("get_collector_status 在全新部署（无归档无会话）仍给出 bootstrap_plan", async () => {
  // 用真实插件目录（采集器齐备），但把数据目录指向一个全新空目录。
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), "cdt-fresh-"));
  const status = await callStatusTool({ dataDir: fresh });

  assert.equal(status.archive.length, 0, "全新部署应为空归档");
  assert.equal(status.cookie.configured, false, "全新部署还没有会话");
  assert.ok(
    status.bootstrap_plan,
    "全新部署恰恰最需要引导，不能因为没有 cookie 就不给计划",
  );
  assert.equal(status.bootstrap_plan.ready_to_run, false);
  assert.ok(
    status.bootstrap_plan.blockers.some((b) => /会话/.test(b)),
    "阻塞原因要如实写出「尚未配置会话」",
  );
  assert.deepEqual(status.bootstrap_plan.keywords, ["胰腺癌", "实体瘤"]);
  assert.equal(
    status.bootstrap_plan.suggested_call.tool,
    "search_trials",
    "计划必须是可执行的具体调用，而不是一句「请先同步」",
  );
  assert.match(status.bootstrap_plan.important, /不会自动执行/);
  assert.equal(status.ready, false);
  await fsp.rm(fresh, { recursive: true, force: true });
});

test("MCP 经软链接路径启动时仍能建立传输层", async () => {
  // macOS 的 /tmp 是 /private/tmp 的软链接；npm link 与符号链接安装同理。
  // 只比较字面路径会让 isDirectRun 判定失败，进程静默退出、exit 0、无任何报错。
  const linkDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cdt-link-"));
  const linkPath = path.join(linkDir, "server.mjs");
  await fsp.symlink(MCP_PATH, linkPath);

  const started = await new Promise((resolve) => {
    const child = spawn(process.execPath, [linkPath], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    setTimeout(() => {
      child.kill();
      resolve(/started; plugin=/.test(err));
    }, 2000);
  });

  assert.equal(started, true, "经软链接启动必须照常打印启动横幅并监听 stdio");
  await fsp.rm(linkDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// list_archived 的截断与「目录不存在」语义（缺陷 5、6）。
//
//  5. limit 默认 50，且返回里只有 records/trials 两个数，调用方无法区分
//     「总共就 50 条」与「139 条里只给了前 50 条」。实测 IBI343 的 CTR20252528
//     排在第 114 位：患者按药名翻归档会得到「没有」这个错误结论。
//  6. 用 keywords 过滤一个本机不存在的目录时，返回 0 条却不说「目录不存在」，
//     与「归档确实为空」混为一谈，同样会被误读成「这个关键词没有试验」。
// ─────────────────────────────────────────────────────────────────────────────

test("list_archived 截断时必须给出 truncated 与 suggested_limit", async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), "cdt-trunc-"));
  const jsonDir = path.join(fresh, "output", "测试关键词", "json");
  await fsp.mkdir(jsonDir, { recursive: true });
  // 造 12 条归档记录。
  for (let i = 0; i < 12; i += 1) {
    await fsp.writeFile(
      path.join(jsonDir, `CTR9000${String(i).padStart(4, "0")}.json`),
      JSON.stringify({
        reg_no: `CTR9000${String(i).padStart(4, "0")}`,
        title: `试验 ${i}`,
        state: "进行中",
        drug_name: `药物-${i}`,
        indication: "测试",
      }),
      "utf8",
    );
  }
  const status = await callStatusTool({ dataDir: fresh });
  assert.equal(status.archive.length, 1, "应识别出 1 个归档目录");

  // 用小 limit 触发截断。
  const listed = await callTool({ dataDir: fresh, name: "list_archived", args: { limit: 5 } });
  assert.equal(listed.total_records, 12);
  assert.equal(listed.returned_records, 5);
  assert.equal(listed.truncated, true, "必须如实标注被截断");
  assert.equal(listed.suggested_limit, 12);
  assert.match(listed.truncation_note, /还有 7 条没有显示/);
  assert.match(listed.truncation_note, /不要据此判断/);

  // 不截断时不得误报。
  const full = await callTool({ dataDir: fresh, name: "list_archived", args: { limit: 50 } });
  assert.equal(full.returned_records, 12);
  assert.equal(full.truncated, false);
  assert.equal("truncation_note" in full, false, "没截断就不要出现截断提示");
  await fsp.rm(fresh, { recursive: true, force: true });
});

test("list_archived 过滤不存在的目录时必须说明「不是没有试验」", async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), "cdt-nodir-"));
  await fsp.mkdir(path.join(fresh, "output", "胰腺癌", "json"), { recursive: true });

  const missing = await callTool({
    dataDir: fresh,
    name: "list_archived",
    args: { keywords: "实体瘤" },
  });
  assert.equal(missing.matched_archive, false, "目录不存在要明确标出");
  assert.equal(missing.total_records, 0);
  assert.match(missing.warning, /没有名为/);
  assert.match(missing.warning, /不是.*没有试验/);

  const present = await callTool({
    dataDir: fresh,
    name: "list_archived",
    args: { keywords: "胰腺癌" },
  });
  assert.equal(
    "matched_archive" in present,
    false,
    "目录存在（即便为空）不应出现缺失告警",
  );
  await fsp.rm(fresh, { recursive: true, force: true });
});
