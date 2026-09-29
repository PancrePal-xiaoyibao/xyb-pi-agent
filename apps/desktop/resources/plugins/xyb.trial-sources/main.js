/**
 * 小胰宝 · 中国与区域试验来源（xyb.trial-sources）
 *
 * 职责：把**中国与区域临床试验数据源**以 MCP 服务的形式绑定进应用。
 * 边界：本插件自身不读写患者文件、不发网络请求。
 *       - 联网检索由 MCP 服务（chictr / veeva-ctv）在各自进程内完成；
 *       - 药品说明书、诊疗规范等由助手按技能文档自行处理。
 *       所以权限只要 ui.view + mcp.server.local，不申请 fs / net.fetch。
 *
 * 为什么单独成插件而不是并进 xyb.trials：
 *   mcp.server.local 属高风险权限（会拉起本地进程）。xyb.trials 是默认可用、
 *   零配置的核心来源，不应被高风险权限拖累。独立成插件后，
 *   **插件是否启用本身就是用户的授权动作**，不想要本地进程的患者永远不必接受。
 *
 * 前置条件（重要，未满足时对应来源不可用，界面与技能文档都如实标注）：
 *   - chictr    ：首次使用需联网拉取 npm 包 chictr-mcp-server@2.0.2（约数 MB），
 *                 并依赖 Playwright Chromium（约 570MB，缓存在 ~/Library/Caches/ms-playwright）。
 *   - veeva-ctv ：需本机已安装 ctv-mcp-server（`npm link` 或全局安装），
 *                 且**必须先建立本地索引**，否则检索返回 INDEX_EMPTY。
 */

const DISCLAIMER =
  "以下为公开试验登记信息的整理，供参考，不能替代医生判断，也不构成入组建议或用药建议。";

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
    need: "需本机安装 ctv-mcp-server，并先用 CSV 导入或 sitemap 枚举**建立本地索引**",
    limit: "检索走本地索引而非实时站点（站点 robots.txt 禁止抓 /study-search）",
  },
  {
    id: "chinadrugtrials",
    name: "中国药物临床试验登记与信息公示平台",
    scope: "中国药物注册临床试验",
    plugin: "本地采集器（非 MCP）",
    kind: "本地脚本 + 技能",
    ready: null,
    can: ["高级条件检索", "详情页归档", "RAG JSON 与原始 Word"],
    need: "需本人浏览器会话 Cookie；在助手会话中按技能文档调用本机脚本",
    limit: "需授权会话，凭据只留在本机，不进本插件、不入仓库",
  },
];

const CDE_NOTE =
  "另有国家药监局药品审评中心（CDE）药物临床试验登记平台，公开检索能力有限，药物研发进展以官方公示与企业公告为准。";

async function onLoad() {
  await pi.commands.register({
    id: "xyb.trial-sources.list",
    title: "小胰宝：看看有哪些试验来源",
    keywords: ["数据源", "来源", "中国", "ChiCTR", "Veeva", "CTV", "登记平台"],
    run: async () => {
      const names = SOURCES.map((s) => s.name).join("、");
      await pi.ui.showToast({ message: `试验来源：${names}` });
      return { ok: true, sources: SOURCES, cdeNote: CDE_NOTE, disclaimer: DISCLAIMER };
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("xyb.trial-sources.list");
}

/** 面板自定义通道：宿主未实现的 channel 会转发到这里。 */
async function onPanelInvoke(channel) {
  if (channel === "xyb.trial-sources.list") {
    return { ok: true, sources: SOURCES, cdeNote: CDE_NOTE, disclaimer: DISCLAIMER };
  }
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  _internals: { SOURCES, CDE_NOTE, DISCLAIMER },
};
