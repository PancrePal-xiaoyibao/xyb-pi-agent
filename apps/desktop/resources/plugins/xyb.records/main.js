/**
 * 小胰宝 · 我的资料（xyb.records）
 *
 * 职责：把患者资料归到本地资料库，并生成患者可读的病情摘要。
 * 设计原则：纯本地优先——索引在本地完成，不联网；接 AI 前先脱敏。
 */

const DISCLAIMER = "以下信息供参考，不能替代医生诊断。";

/** 支持的资料类型（按扩展名）。 */
const DOC_EXT = [".pdf", ".doc", ".docx", ".txt", ".md"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp", ".tif", ".tiff"];
const DICOM_EXT = [".dcm", ".dicom"];
const TABULAR_EXT = [".csv", ".xlsx", ".xls"];

function classify(name) {
  const lower = String(name || "").toLowerCase();
  const hit = (list) => list.some((e) => lower.endsWith(e));
  if (hit(DICOM_EXT)) return "影像";
  if (hit(IMAGE_EXT)) return "图片";
  if (hit(DOC_EXT)) return "报告";
  if (hit(TABULAR_EXT)) return "化验数据";
  return "其他";
}

/**
 * 脱敏：送出模型前隐藏姓名、手机号、身份证、医院名。
 * MVP 用规则脱敏；后续可升级为更完整的实体识别。
 */
function redact(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/1[3-9]\d{9}/g, "[电话]")
    .replace(/\d{17}[\dXx]/g, "[身份证]")
    .replace(/([\u4e00-\u9fa5]{2,4})(先生|女士|同志)/g, "$2")
    .replace(/[\u4e00-\u9fa5]{2,10}(医院|医学中心|肿瘤医院|人民医院|医学院)/g, "[医院]");
}

/** 扫描并归类一个目录，返回统计结果。命令与面板共用。 */
async function scanDirectory(dir) {
  const entries = await pi.fs.list(dir, { recursive: true, maxDepth: 4 });
  const files = (entries || []).filter((e) => !e.isDirectory);
  const buckets = {};
  for (const f of files) {
    const kind = classify(f.name);
    buckets[kind] = (buckets[kind] || 0) + 1;
  }
  return { total: files.length, buckets };
}

async function runImport() {
  // 由用户亲自选择目录，插件不自行扩大读取范围。
  const dir = await pi.fs.requestDirectory({ title: "选择要导入的资料文件夹" });
  if (!dir) return { cancelled: true };

  const { total, buckets } = await scanDirectory(dir);
  const summary = Object.entries(buckets)
    .map(([k, v]) => `${k} ${v} 份`)
    .join("，");

  // 把清单写进资料库，患者不依赖插件也能自己看到整理结果。
  // 路径相对于用户所选目录（root: userSelected）。
  let indexWritten = false;
  try {
    const rows = Object.entries(buckets)
      .map(([k, v]) => `| ${k} | ${v} |`)
      .join("\n");
    const content = [
      "# 小胰宝 · 资料清单",
      "",
      `- 整理时间：${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      `- 资料总数：${total} 份`,
      "",
      "| 类别 | 数量 |",
      "| --- | --- |",
      rows,
      "",
      "> 这份清单由小胰宝自动生成，用于帮你确认资料是否都放进来了。",
      "> 以下信息供参考，不能替代医生诊断。",
      "",
    ].join("\n");
    await pi.fs.writeText("小胰宝-资料清单.md", content);
    indexWritten = true;
  } catch (err) {
    // 写清单失败不影响导入本身，仅记录状态。
    indexWritten = false;
  }

  await pi.ui.showToast({
    message: total ? `已扫描 ${total} 份资料（${summary}）` : "这个文件夹里没有找到可识别的资料",
  });
  return { total, buckets, indexWritten, disclaimer: DISCLAIMER };
}

async function runSummary() {
  const settings = await pi.plugin.getSettings();
  const vault = (settings && settings.vaultDir) || "";
  if (!vault) {
    await pi.ui.showToast({ message: "请先在插件设置里选择「资料库位置」" });
    return { ok: false, reason: "NO_VAULT" };
  }
  return { ok: true, vault, disclaimer: DISCLAIMER };
}

async function onLoad() {
  await pi.commands.register({
    id: "xyb.records.import",
    title: "小胰宝：导入资料",
    keywords: ["导入", "资料", "病历", "报告", "import"],
    run: () => runImport(),
  });

  await pi.commands.register({
    id: "xyb.records.summary",
    title: "小胰宝：生成病情摘要",
    keywords: ["摘要", "总结", "summary"],
    run: () => runSummary(),
  });
}

async function onUnload() {
  await pi.commands.unregister("xyb.records.import");
  await pi.commands.unregister("xyb.records.summary");
}

/**
 * 面板自定义通道：宿主未实现的 channel 会转发到这里，
 * 让视图能与自己的插件进程通信。
 */
async function onPanelInvoke(channel, _payload) {
  if (channel === "xyb.records.import") return runImport();
  if (channel === "xyb.records.summary") return runSummary();
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = { onLoad, onUnload, onPanelInvoke, _internals: { classify, redact } };