/**
 * 小胰宝 · 外部技能包（xyb.skillpack）
 *
 * 职责：承载从 opencare-skillhub 接入的**外部技能**，并把每个技能的
 *       上游仓库、许可、以及「在本机到底能用到什么程度」如实摆出来。
 *
 * 为什么单独成包，不并进 xyb.assistants：
 *   1. 来源可溯 —— 外部技能日后要跟着上游更新，混进自研技能里就没法追
 *   2. 可整包停用 —— 这批是外部内容，患者不需要时关掉一个插件即可
 *   3. 不稀释红线 —— xyb.assistants 的硬约束（不做排名、不给入组建议、
 *      机制未披露就写未披露）由自研技能统一保证；外部技能质量参差，
 *      混在一起会让患者分不清哪条约束适用于哪个技能
 *
 * 本插件不发网络请求、不读写患者文件 —— 所以权限只要 ui.view + agent.prompt.inject。
 *
 * readiness 是个诚实的字段，不是装饰：
 *   原文里写「执行 scripts/xxx.py」的技能，在客户端里没有 shell 权限可跑。
 *   这类技能我们只接「方法论层」，并明确标注，绝不让患者以为
 *   「技能出现在列表里 = 功能已就绪」。
 */

const DISCLAIMER =
  "以下内容为公开信息与公开技能的整理，供参考，不能替代医生判断，也不构成入组建议或用药建议。";

/** 已接入的外部技能。license 一栏照上游实际情况写，未声明就写未声明。 */
const SKILLS = [
  {
    id: "trial-matching-advanced",
    name: "试验匹配（进阶版）",
    from: "opencare-skillhub/clinical-trial-matching",
    upstreamName: "clinical-trial-matching v2.0.0",
    license: "上游未声明 LICENSE（仓库归属本组织）",
    readiness: "可完整使用",
    what: [
      "8 维搜索计划（疾病+突变 / 泛实体瘤 / 联合靶点 / 通路耐药 / 药物名 / 细胞治疗 / 免疫 / 中文单 token）",
      "双源检索：ClinicalTrials.gov + ChiCTR，与本机已有数据源衔接",
      "R1-R5 合规规则（同类药物史 / 线数错配 / 适应症错配 / 器官功能边界 / 信息缺失）逐条显式输出",
      "0 匹配时的替代策略：篮子试验、罕见肿瘤中心、文献检索路径",
      "Goals-of-Care 触发时必须先给缓和护理选项",
    ],
    note:
      "上游把工具名写成 mcp__chictr__ / mcp__oncology_db__，本机对应的是 chictr MCP 与 xyb_trials_search，正文已改写。",
  },
  {
    id: "record-organizer",
    name: "病案整理",
    from: "opencare-skillhub/Medical-Record-Organizer",
    upstreamName: "patient-record-organizer",
    license: "上游未声明 LICENSE（仓库归属本组织）",
    readiness: "分类体系与流程已由 xyb.records 本机落地；OCR/语音转写仍未具备",
    what: [
      "六步流程：接收扫描 → 内容提取 → 自动分类 → 时间线 → 生成档案 → 增量持久化",
      "11 类分类体系（基本信息 / 检验 / 影像 / 病理 / 用药 / 诊疗记录 / 其他）",
      "信息缺口提示：自动指出缺哪类资料、建议补什么",
    ],
    note:
      "上游原文依赖 OCR/ASR 脚本与多个云服务密钥（MinerU、SiliconFlow、DashScope）。" +
      "客户端没有执行外部脚本的权限，因此 OCR 与语音转写仍不具备。" +
      "但**分类、时间线、缺口提示已由 xyb.records 的「整理病案」在本机确定性实现**" +
      "（纯本地、不联网、不调用模型），无需助手参与即可运行；" +
      "本技能保留为方法论与流程说明，遇到需要 OCR/语音转写的环节时如实说明暂不具备。" +
      "实现为独立重写，未内联上游代码，仅沿用其流程命名与分类名称。",
  },
  {
    id: "distress-screening",
    name: "焦虑抑郁量表评估",
    from: "opencare-skillhub/skill-HADS-accessment",
    upstreamName: "HADS 心理量表评估助手",
    license: "上游未声明 LICENSE（仓库归属本组织）",
    readiness: "可完整使用（本地版）",
    what: [
      "HADS 焦虑 / 抑郁两维评估的完整流程与计分口径（各 0-21 分）",
      "分级解读与转介建议（何时该找心理科、何时该告诉主管医生）",
      "结果结构化输出，可与病案整理串联",
    ],
    note:
      "**已移除上游的「发布问卷到公网」环节**（经确认：不发公网）。上游用 EdgeOne 把问卷发布到公网，" +
      "对肿瘤患者的心理评估数据来说这条路径不合适——本机完成、结果留在本机。" +
      "量表题目以临床通用版本为准，本技能提供流程、计分与解读框架。",
  },
  {
    id: "tumor-marker-trend",
    name: "肿瘤标志物趋势",
    from: "opencare-skillhub/graphify-xiaoyibao",
    upstreamName: "xyb-tumor-markers-trend v0.1.0",
    license: "AGPL-3.0",
    readiness: "方法论层（需本机对等工具）",
    what: [
      "CA19-9 / CEA / AFP / CA50 / CA72-4 / CA125 历次数值整理成趋势表",
      "趋势方向与同期治疗、影像事件对照呈现",
      "可说的与不能说的分界（如 CA19-9 在 Lewis 抗原阴性人群本就不表达）",
      "哪些变化需要尽快联系主管医生",
    ],
    note:
      "上游靠 `xyb` CLI 生成 graph.json 再出 CSV/PNG，客户端没有执行外部命令的权限，" +
      "本机版把趋势表整理改由对话完成，上游那两条命令不照抄给患者。" +
      "**许可是 AGPL-3.0（强 copyleft）**：仓库当前 PRIVATE 暂不构成分发，" +
      "转公开或对外分发含此技能的产物时，整体需按 AGPL 处理。",
  },
];

const OUT_OF_SCOPE = [
  "开发基建类（数学/美学大脑、Codex 编排、技能池、OpenClaw 运维等）不接：与患者端功能无关。",
  "lark / 飞书类不接：按项目要求排除。",
  "ChiCTR 与中国药物临床试验登记平台不重复接：已由 xyb.trial-sources 承担。",
  "运营/内容侧 10 个（公众号生成、去 AI 腔、白皮书、RAG 处理、试验情报推送）暂不接入：",
  "  它们无一例外依赖脚本与推送密钥（TG / 微信 / 飞书 / FastGPT），进客户端只能接方法论层。",
  "需要把患者数据发布到公网的技能不接：与「患者数据不出本机」冲突。",
  "AGPL-3.0 的 graphify-xiaoyibao 已接入，许可影响单独标注在该技能里。",
];

async function onLoad() {
  await pi.commands.register({
    id: "xyb.skillpack.list",
    title: "小胰宝：看看接入了哪些外部技能",
    keywords: ["外部技能", "技能包", "skillpack", "skillhub", "来源"],
    run: async () => {
      await pi.ui.showToast(`外部技能 ${SKILLS.length} 个：${SKILLS.map((s) => s.name).join("、")}`);
      return { ok: true, skills: SKILLS, outOfScope: OUT_OF_SCOPE, disclaimer: DISCLAIMER };
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("xyb.skillpack.list");
}

/** 面板自定义通道：宿主未实现的 channel 会转发到这里。 */
async function onPanelInvoke(channel) {
  if (channel === "xyb.skillpack.list") {
    return { ok: true, skills: SKILLS, outOfScope: OUT_OF_SCOPE, disclaimer: DISCLAIMER };
  }
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  _internals: { SKILLS, OUT_OF_SCOPE, DISCLAIMER },
};
