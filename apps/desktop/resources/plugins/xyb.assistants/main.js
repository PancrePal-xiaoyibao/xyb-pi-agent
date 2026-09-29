/**
 * 小胰宝 · 智能助手（xyb.assistants）
 *
 * 职责：把面向肿瘤患者的助手技能绑定进应用。
 * 边界：本插件只贡献**技能文档**（纯 Markdown，由助手按需加载），
 *       自身不读写患者文件、不联网——所以权限只要 agent.prompt.inject。
 *       患者资料由助手自己的文件工具读取；临床数据由 xyb.trials 的工具检索。
 */

const DISCLAIMER = "以下为信息整理，供参考，不能替代医生诊断，也不构成用药建议。";

/** 本插件贡献的助手清单，仅用于界面展示与命令输出。 */
const ASSISTANTS = [
  { id: "medical-record", name: "病历助手", desc: "把零散资料整理成结构化病情档案" },
  { id: "imaging", name: "影像助手", desc: "解读 CT / MRI / PET-CT 报告字段与疗效评价" },
  { id: "genomics", name: "基因解读助手", desc: "解读基因与分子检测结果及对应治疗方向" },
  { id: "decision-support", name: "决策辅助助手", desc: "按 MDT 框架整理候选方案与权衡维度" },
  { id: "nutrition", name: "营养支持助手", desc: "营养评估、治疗期饮食与症状营养应对" },
  { id: "psych-support", name: "心理支持助手", desc: "情绪陪伴、沟通策略与安宁疗护知识" },
  { id: "complications", name: "并发症助手", desc: "按红黄绿分级识别并发症与就医时机" },
  { id: "pathology", name: "病理助手", desc: "病理报告与免疫组化指标解读" },
];

async function onLoad() {
  await pi.commands.register({
    id: "xyb.assistants.list",
    title: "小胰宝：看看有哪些助手",
    keywords: ["助手", "智能体", "assistant", "病历", "营养", "心理"],
    run: async () => {
      const names = ASSISTANTS.map((a) => a.name).join("、");
      await pi.ui.showToast({ message: `可用助手：${names}` });
      return { ok: true, assistants: ASSISTANTS, disclaimer: DISCLAIMER };
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("xyb.assistants.list");
}

/** 面板自定义通道：宿主未实现的 channel 会转发到这里。 */
async function onPanelInvoke(channel) {
  if (channel === "xyb.assistants.list") {
    return { ok: true, assistants: ASSISTANTS, disclaimer: DISCLAIMER };
  }
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = { onLoad, onUnload, onPanelInvoke, _internals: { ASSISTANTS } };