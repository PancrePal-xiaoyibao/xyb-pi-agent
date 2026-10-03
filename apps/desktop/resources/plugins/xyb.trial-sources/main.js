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
 *   - chictr          ：首次使用需联网拉取 npm 包 chictr-mcp-server@2.0.2（约数 MB），
 *                       并依赖 Playwright Chromium（约 570MB，缓存在 ~/Library/Caches/ms-playwright）。
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
    need: "首次使用需联网拉取 npm 包；依赖 Playwright Chromium",
    limit: "站点有反爬与滑动验证；触发时需人工验证后恢复，工具不得绕过",
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
    need: "需本人浏览器会话；首次要准备 Python 环境（可在会话里让助手一键准备）",
    limit:
      "站点校验浏览器会话，会话由本人维护、工具不绕过验证；逐条抓取较慢；凭据只留在本机，不进本插件、不入仓库",
  },
];

const CDE_NOTE =
  "另有国家药监局药品审评中心（CDE）药物临床试验登记平台，公开检索能力有限，药物研发进展以官方公示与企业公告为准。";

/** 最近一次种子复制的结果，供面板展示（onLoad 里赋值）。 */
let seedStatus = null;

async function onLoad() {
  // 把随包分发的 Veeva 索引放到用户可写的目录。失败不阻断加载 —— 用户仍可
  // 用渠道 1/2/4，Veeva 只是暂时没有本地索引。
  try {
    const settings = (await pi.plugin.getSettings()) ?? {};
    seedStatus = await ensureVeevaSeed({ dataDir: settings.veevaDataDir });
  } catch (error) {
    seedStatus = { ok: false, reason: "COPY_FAILED", error: error?.message ?? String(error) };
  }

  await pi.commands.register({
    id: "xyb.trial-sources.list",
    title: "小胰宝：看看有哪些试验来源",
    keywords: ["数据源", "来源", "中国", "ChiCTR", "Veeva", "CTV", "登记平台"],
    run: async () => {
      const names = SOURCES.map((s) => s.name).join("、");
      await pi.ui.showToast(`试验来源：${names}`);
      return {
        ok: true,
        sources: SOURCES,
        cdeNote: CDE_NOTE,
        seed: seedStatus,
        disclaimer: DISCLAIMER,
      };
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("xyb.trial-sources.list");
}

/** 面板自定义通道：宿主未实现的 channel 会转发到这里。 */
async function onPanelInvoke(channel) {
  if (channel === "xyb.trial-sources.list") {
    return {
      ok: true,
      sources: SOURCES,
      cdeNote: CDE_NOTE,
      seed: seedStatus,
      disclaimer: DISCLAIMER,
    };
  }
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  _internals: { SOURCES, CDE_NOTE, DISCLAIMER, ensureVeevaSeed, SEED_DB, defaultVeevaDir },
};
