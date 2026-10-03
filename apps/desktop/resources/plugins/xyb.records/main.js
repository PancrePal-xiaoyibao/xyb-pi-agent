/**
 * 小胰宝 · 我的资料（xyb.records）
 *
 * 职责：把患者资料归到本地资料库，并生成患者可读的病情摘要。
 * 设计原则：纯本地优先——索引在本地完成，不联网；接 AI 前先脱敏。
 *
 * 摘要链路（F1）：
 *   1. 用户先在设置里指定资料库位置；
 *   2. 点「生成病情摘要」→ 用户再次亲自选择资料库目录（授权只随本次进程存活，
 *      设置里的字符串不是持续授权，不能当路径用）；
 *   3. 只读取文本类资料（.txt/.md），其余类型只计为「未解析」，如实告知；
 *   4. 全部内容与文件名先经 redact() 脱敏，且不向模型暴露绝对路径；
 *   5. 用用户默认模型生成摘要，返回结构化结果，由界面预览后再决定是否保存。
 */

const organize = require("./lib/organize.js");

const DISCLAIMER = "以下信息供参考，不能替代医生诊断。";

/** 支持的资料类型（按扩展名）。 */
const DOC_EXT = [".pdf", ".doc", ".docx", ".txt", ".md"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp", ".tif", ".tiff"];
const DICOM_EXT = [".dcm", ".dicom"];
const TABULAR_EXT = [".csv", ".xlsx", ".xls"];

/** 能直接读出文本、可送入模型的扩展名。其余一律算「未解析」。 */
const TEXT_EXT = [".txt", ".md"];

/** 预算：宿主对单次 complete 的 messages 有 200k 字符上限，这里留足余量。 */
const MAX_SUMMARY_FILE_CHARS = 20000;
const MAX_SUMMARY_TOTAL_CHARS = 120000;

const SUMMARY_SYSTEM_PROMPT = [
  "你是帮患者整理本地医疗资料的助手。只能依据用户提供的资料文本作答，不得引入外部知识。",
  "",
  "输出结构固定为四节：",
  "① 一句话现状",
  "② 关键检查（按时间倒序，列出指标、数值、参考范围、日期）",
  "③ 治疗经过（按时间线陈述，不推断未写明的内容）",
  "④ 待办与疑问",
  "",
  "硬性规则：",
  "1. 第一行必须是：「以下信息供参考，不能替代医生诊断。」",
  "2. 资料中没有的信息写「资料中未见」，不要猜测、不要补全。",
  "3. 不做诊断，不给治疗建议，不推荐医院或医生。",
  "4. 数值、单位与日期照抄资料原文，不得换算或改写。",
  "5. 资料中的 [电话]、[身份证]、[医院] 等占位符保持原样。",
].join("\n");

function classify(name) {
  const lower = String(name || "").toLowerCase();
  const hit = (list) => list.some((e) => lower.endsWith(e));
  if (hit(DICOM_EXT)) return "影像";
  if (hit(IMAGE_EXT)) return "图片";
  if (hit(DOC_EXT)) return "报告";
  if (hit(TABULAR_EXT)) return "化验数据";
  return "其他";
}

function isTextSource(name) {
  const lower = String(name || "").toLowerCase();
  return TEXT_EXT.some((e) => lower.endsWith(e));
}

/**
 * 脱敏：送出模型前隐藏姓名、手机号、身份证、医院名。
 * MVP 用规则脱敏；后续可升级为更完整的实体识别。
 *
 * 诚实边界（重要）：规则脱敏只能覆盖固定格式与显式字段，**不能**保证去标识。
 * 已覆盖：手机号、身份证、带称谓姓名、显式姓名字段（「姓名：张三」「患者 张三」）、
 *         医院名、常见称谓+姓名组合。
 * 未覆盖：正文里无任何标记的自由人名（如「张三今天复查」）、地址、病历号、
 *         邮箱、职业、罕见的少数民族姓名等。
 * 因此 UI 与 README 不得宣称「已完全去标识」，只能说明「已按规则隐藏常见标识」。
 */
function redact(text) {
  if (typeof text !== "string") return text;
  return (
    text
      // 身份证必须先于手机号：18 位号码里含有 11 位手机号形状的子串，
      // 若先跑手机号规则，会把 320583198901011234 打成「320583[电话]4」，
      // 既没真正遮住证件号，又泄漏了前 6 位地区码与末位。
      .replace(/\d{17}[\dXx]/g, "[身份证]")
      .replace(/1[3-9]\d{9}/g, "[电话]")
      // 显式姓名字段：「姓名：张三」「姓名 张三」「患者姓名:张三」「病人：张三」
      // 先于带称谓规则执行，避免「姓名：柏万秀」这类无称谓字段漏网。
      //
      // 设计要点：字段标签用**最长优先**的枚举（可选「患者/病人/患儿」前缀 + 必选
      // 「姓名/名字/就诊人」核心词），并要求后面跟显式分隔符或空白，最后才是姓名。
      // 这样「患者姓名不详」里的「患者姓名」会被当作完整标签，后面「不详」被
      // 负向断言挡下，而不会退化成「患者」+ 人名「姓名」这种荒谬切分。
      .replace(
        /((?:(?:患者|病人|患儿)\s*)?(?:姓\s*名|名\s*字|就诊人)\s*[:：]?\s*)(?!不详|未知|无|未提供|未填|略|保密)([\u4e00-\u9fa5]{2,4})(?![一-龥])/g,
        "$1[姓名]",
      )
      // 只有「患者/病人」而无「姓名」字样的写法：「患者：柏万秀」（必须带分隔符，
      // 否则「患者柏万秀」这类无分隔写法会误伤普通句子）。
      // 这里的歧义最大——「患者：术后第3天」也是合法临床文本，因此用停用词表
      // 排除常见非姓名取值（术后/入院/目前/今日/无/男/女 等），宁可漏脱敏也不误伤语义。
      .replace(
        /((?:患者|病人|患儿)\s*[:：]\s*)(?!(?:术后|入院|出院|目前|今日|今|昨日|现|既往|无|未|不|男|女|年龄|诊断|主诉|病史|治疗|检查|情况|恢复|一般|精神|饮食|睡眠|大小便|体重|血压|体温|心率|呼吸|神志|查体|生命体征|过敏|家族|个人|婚育|职业|籍贯|住址|联系))([\u4e00-\u9fa5]{2,4})(?![一-龥0-9])/g,
        "$1[姓名]",
      )
      // 「张三先生 / 李四女士」这类带称谓的姓名整体替换，避免只删掉称谓
      .replace(/([\u4e00-\u9fa5]{2,4})(先生|女士|同志)/g, "[姓名]")
      .replace(/[\u4e00-\u9fa5]{2,10}(医院|医学中心|肿瘤医院|人民医院|医学院)/g, "[医院]")
  );
}

/**
 * 扫描并归类资料。
 *
 * fs 路径语义（以宿主实现为准，别照直觉写）：
 *   · `requestDirectory()` 选中的目录**就是** root（manifest 声明 root: "userSelected"），
 *     所以从空路径起算，路径一律是 root 相对路径；
 *   · `fs.list(path)` **每次只列一层**（宿主刻意如此，便于界面懒展开），
 *     不接受递归参数——早先传 `{ recursive: true }` 会被静默忽略，只扫到第一层；
 *   · 递归与深度上限要自己控制。
 */
const MAX_SCAN_DEPTH = 4;

/**
 * 递归收集文件条目（含相对路径）。目录读不到就跳过，不中断整次扫描。
 * @returns {Promise<Array<{name: string, path: string}>>}
 */
async function collectFiles() {
  const files = [];
  let level = [""];
  let depth = 0;

  while (level.length && depth < MAX_SCAN_DEPTH) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await pi.fs.list(dir);
      } catch (err) {
        // 无权限或已消失的目录跳过，不中断整次扫描
        continue;
      }
      for (const e of entries || []) {
        if (e.isDirectory) {
          next.push(e.path);
          continue;
        }
        files.push({ name: e.name, path: e.path });
      }
    }
    level = next;
    depth += 1;
  }

  return files;
}

async function scanDirectory() {
  const files = await collectFiles();
  const buckets = {};
  for (const f of files) {
    const kind = classify(f.name);
    buckets[kind] = (buckets[kind] || 0) + 1;
  }
  return { total: files.length, buckets };
}

async function runImport() {
  // 由用户亲自选择目录，插件不自行扩大读取范围。
  // 注意：requestDirectory() 不接受参数（早先传 { title } 会被忽略）。
  const picked = await pi.fs.requestDirectory();
  if (!picked) return { cancelled: true };

  const { total, buckets } = await scanDirectory();
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

  // showToast 的第一个参数是**字符串**（签名 showToast(message, level?)）；
  // 早先传 { message } 对象，界面会显示 "[object Object]"。
  await pi.ui.showToast(
    total ? `已扫描 ${total} 份资料（${summary}）` : "这个文件夹里没有找到可识别的资料",
  );
  return { total, buckets, indexWritten, disclaimer: DISCLAIMER };
}

/** 选一个可用于一次性补全的模型：优先宿主默认模型，否则第一个可用模型。 */
async function pickModel() {
  let models = [];
  try {
    models = (await pi.models.list()) || [];
  } catch (err) {
    return { error: "NO_MODEL", message: String((err && err.message) || err) };
  }
  if (!models.length) return { error: "NO_MODEL" };
  return { model: models.find((m) => m && m.isDefault) || models[0] };
}

/**
 * 生成病情摘要：真实读取文本资料 → 脱敏 → 调用配置的模型。
 * @param {{maxFileChars?: number, maxTotalChars?: number}} [options] 便于测试注入预算
 */
async function runSummary(options) {
  const maxFileChars =
    (options && options.maxFileChars) > 0 ? options.maxFileChars : MAX_SUMMARY_FILE_CHARS;
  const maxTotalChars =
    (options && options.maxTotalChars) > 0 ? options.maxTotalChars : MAX_SUMMARY_TOTAL_CHARS;

  const settings = await pi.plugin.getSettings();
  const vault = (settings && settings.vaultDir) || "";
  if (!vault) {
    await pi.ui.showToast("请先在插件设置里选择「资料库位置」", "warn");
    return { ok: false, reason: "NO_VAULT" };
  }

  // 设置里的 vaultDir 只是提示文本，不是持续授权：必须由用户本次亲自选目录。
  const picked = await pi.fs.requestDirectory();
  if (!picked) {
    await pi.ui.showToast("已取消生成病情摘要");
    return { ok: false, reason: "CANCELLED" };
  }

  const files = await collectFiles();
  const textFiles = files.filter((f) => isTextSource(f.name));
  const skippedCount = files.length - textFiles.length;

  if (!textFiles.length) {
    await pi.ui.showToast("资料库里还没有可读取的文本文档（.txt/.md）", "warn");
    return {
      ok: false,
      reason: "EMPTY_VAULT",
      totalFiles: files.length,
      skippedCount,
      disclaimer: DISCLAIMER,
    };
  }

  const modelPick = await pickModel();
  if (modelPick.error) {
    await pi.ui.showToast("没有可用的模型，请先在设置里配置模型", "warn");
    return { ok: false, reason: modelPick.error, error: modelPick.message };
  }

  let usedChars = 0;
  let truncated = false;
  const readErrors = [];
  const sections = [];

  for (const file of textFiles) {
    if (usedChars >= maxTotalChars) {
      truncated = true;
      break;
    }
    let text;
    try {
      text = await pi.fs.readText(file.path);
    } catch (err) {
      readErrors.push(file.name);
      continue;
    }
    if (typeof text !== "string" || !text.trim()) continue;

    let body = text;
    if (body.length > maxFileChars) {
      body = `${body.slice(0, maxFileChars)}\n…（此文件过长，已截断）`;
      truncated = true;
    }
    const remaining = maxTotalChars - usedChars;
    if (body.length > remaining) {
      body = `${body.slice(0, remaining)}\n…（资料总量已达上限，已截断）`;
      truncated = true;
    }
    usedChars += body.length;

    // 文件名与正文都脱敏；只给文件名，不给绝对路径。
    sections.push(`### 资料：${redact(file.name)}\n\n${redact(body)}`);
  }

  if (!sections.length) {
    await pi.ui.showToast("读不到可用的文本内容", "warn");
    return {
      ok: false,
      reason: "EMPTY_VAULT",
      totalFiles: files.length,
      skippedCount,
      readErrors,
      disclaimer: DISCLAIMER,
    };
  }

  let result;
  try {
    result = await pi.agent.complete({
      modelKey: modelPick.model.key,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            "以下是从我的资料库中提取并已脱敏的资料文本，请据此生成病情摘要：",
            "",
            sections.join("\n\n"),
          ].join("\n"),
        },
      ],
    });
  } catch (err) {
    const code = (err && err.code) || "MODEL_ERROR";
    await pi.ui.showToast(`生成摘要失败：${(err && err.message) || code}`, "error");
    return {
      ok: false,
      reason: "MODEL_ERROR",
      code,
      error: String((err && err.message) || err),
      disclaimer: DISCLAIMER,
    };
  }

  const text = (result && result.text) || "";
  if (!text.trim()) {
    await pi.ui.showToast("模型没有返回内容，请稍后重试", "warn");
    return { ok: false, reason: "MODEL_ERROR", error: "empty completion" };
  }

  await pi.ui.showToast(`已生成病情摘要（依据 ${sections.length} 份文本资料）`);
  return {
    ok: true,
    text,
    modelKey: (result && result.modelKey) || modelPick.model.key,
    sourceCount: sections.length,
    skippedCount,
    totalFiles: files.length,
    truncated,
    readErrors,
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
}

/** 把摘要保存到资料库（界面预览后由用户显式触发）。 */
async function saveSummary(payload) {
  const text = payload && typeof payload.text === "string" ? payload.text : "";
  if (!text.trim()) {
    await pi.ui.showToast("没有可保存的摘要内容", "warn");
    return { ok: false, reason: "EMPTY_TEXT" };
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const path = `小胰宝-病情摘要-${stamp}.md`;
  try {
    await pi.fs.writeText(path, text);
  } catch (err) {
    await pi.ui.showToast(`保存失败：${(err && err.message) || err}`, "error");
    return { ok: false, reason: "WRITE_FAILED", error: String((err && err.message) || err) };
  }
  await pi.ui.showToast(`已保存到资料库：${path}`);
  return { ok: true, path, disclaimer: DISCLAIMER };
}

/**
 * 整理病案（B-2.1）：
 *   读取本地资料 → 分类归档 + 时间线 + 缺口提示 → 返回结构化结果。
 *
 * 与摘要链路的区别：**不调用模型、不外发任何数据**，纯本地确定性整理。
 * 因此本命令不需要用户二次确认即可生成结果，但保存档案仍需用户显式确认。
 *
 * 诚实边界：只有 .txt/.md 能读到正文；PDF/Word/图片/DICOM 只登记文件名，
 * 标记为「未解析」并如实呈现在结果里，绝不假装读过。
 */
async function runOrganize(options) {
  const maxFileChars =
    (options && options.maxFileChars) > 0 ? options.maxFileChars : MAX_SUMMARY_FILE_CHARS;

  const settings = await pi.plugin.getSettings();
  const vault = (settings && settings.vaultDir) || "";
  if (!vault) {
    await pi.ui.showToast("请先在插件设置里选择「资料库位置」", "warn");
    return { ok: false, reason: "NO_VAULT" };
  }

  // 与摘要一致：设置里的字符串不是持续授权，必须由用户本次亲自选目录。
  const picked = await pi.fs.requestDirectory();
  if (!picked) {
    await pi.ui.showToast("已取消整理病案");
    return { ok: false, reason: "CANCELLED" };
  }

  const files = await collectFiles();
  if (!files.length) {
    await pi.ui.showToast("这个文件夹里没有找到资料", "warn");
    return { ok: false, reason: "EMPTY_VAULT", totalFiles: 0 };
  }

  const { records, readErrors } = await organize.buildRecords(files, {
    // 文件名与正文都脱敏；不给模型也不给界面绝对路径。
    read: async (path) => redact(await pi.fs.readText(path)),
    maxFileChars,
  });

  const archive = organize.buildArchive(records);
  const markdown = organize.renderMarkdown(archive);

  await pi.ui.showToast(
    `已整理 ${archive.totalCount} 份资料（可读 ${archive.parsedCount} 份，未解析 ${archive.unparsedCount} 份）`,
  );

  return {
    ok: true,
    archive: {
      ...archive,
      // 记录级文本不出界面：界面只需要可读列表，避免整份资料在渲染层反复出现
      records: records.map((r) => ({ ...r, text: undefined })),
    },
    markdown,
    totalFiles: files.length,
    readErrors,
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
}

/** 把整理出的档案写入资料库（用户显式确认后）。 */
async function saveArchive(payload) {
  const markdown = payload && typeof payload.markdown === "string" ? payload.markdown : "";
  if (!markdown.trim()) {
    await pi.ui.showToast("没有可保存的档案内容", "warn");
    return { ok: false, reason: "EMPTY_TEXT" };
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const path = `小胰宝-病案整理-${stamp}.md`;
  try {
    await pi.fs.writeText(path, markdown);
  } catch (err) {
    await pi.ui.showToast(`保存失败：${(err && err.message) || err}`, "error");
    return { ok: false, reason: "WRITE_FAILED", error: String((err && err.message) || err) };
  }
  await pi.ui.showToast(`已保存到资料库：${path}`);
  return { ok: true, path, disclaimer: DISCLAIMER };
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

  await pi.commands.register({
    id: "xyb.records.organize",
    title: "小胰宝：整理病案",
    keywords: ["整理", "病案", "归档", "分类", "organize"],
    run: () => runOrganize(),
  });
}

async function onUnload() {
  await pi.commands.unregister("xyb.records.import");
  await pi.commands.unregister("xyb.records.summary");
  await pi.commands.unregister("xyb.records.organize");
}

/**
 * 面板自定义通道：宿主未实现的 channel 会转发到这里，
 * 让视图能与自己的插件进程通信。
 */
async function onPanelInvoke(channel, payload) {
  if (channel === "xyb.records.import") return runImport();
  if (channel === "xyb.records.summary") return runSummary();
  if (channel === "xyb.records.summary.save") return saveSummary(payload);
  if (channel === "xyb.records.organize") return runOrganize();
  if (channel === "xyb.records.organize.save") return saveArchive(payload);
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  _internals: {
    classify,
    redact,
    runImport,
    runSummary,
    saveSummary,
    runOrganize,
    saveArchive,
    collectFiles,
    organize,
  },
};
