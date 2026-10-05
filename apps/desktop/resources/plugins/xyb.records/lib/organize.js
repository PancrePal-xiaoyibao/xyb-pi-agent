/**
 * 小胰宝 · 病案整理核心（xyb.records/lib/organize.js）
 *
 * 对应 SPEC B-2（病案整理助手接入）的 B-2.1 层：**纯函数、无网络、无 IO**。
 *
 * 设计来源：`opencare-skillhub/Medical-Record-Organizer`（上游 name: `patient-record-organizer`）。
 * 本文件**不内联上游源码**，只独立实现其「六步流程 + 分类体系 + 缺口提示」的方法论，
 * 并在此基础上加入可追溯的来源标注（provenance）。上游未声明 LICENSE，因此：
 *   · 不复制上游代码或文案；
 *   · 只保留分类类目名称与流程步骤这类功能性事实；
 *   · 许可补办前不得对外分发本能力的产物（见 XYB-AUDIT-F5-LICENSE-RISK.md）。
 *
 * 明确不做（与 SPEC 非目标一致）：
 *   · 不做诊断、分期、疗效判断；
 *   · 不推断资料里没写明的内容；
 *   · 不把「没找到某项资料」说成「没做过这项检查」；
 *   · 不自动安装 OCR / 云端依赖，不外发任何数据。
 */

/** 七大类目（对应上游 11 类体系的上位归并，便于本地无 OCR 场景使用）。 */
const CATEGORIES = [
  "基本信息",
  "检验指标",
  "影像检查",
  "病理报告",
  "用药方案",
  "诊疗记录",
  "其他资料",
];

const CATEGORY_LABELS = {
  基本信息: "主诉 / 现病史 / 既往史 / 过敏史 / 家族史",
  检验指标: "血常规 / 生化 / 肿瘤标志物 / 凝血",
  影像检查: "CT / MRI / PET-CT / 超声 / X 线 / 内镜",
  病理报告: "组织病理 / 细胞学 / 分子病理 / 基因检测",
  用药方案: "处方 / 化疗 / 靶向 / 免疫治疗",
  诊疗记录: "出院小结 / 门诊记录 / 手术记录 / 治疗小结",
  其他资料: "医保 / 费用 / 营养 / 护理 / 健康教育",
};

/**
 * 关键词规则表：先按文件名判断，文件名不足以判断时再看正文前若干字符。
 * 顺序有意义——越具体的类别放前面，避免「CT 报告」被泛化的「报告」抢走。
 *
 * 注意：「基本信息」必须排在「诊疗记录」之前——否则「基本病情报告」会被
 * 「记录」这类泛化词抢先命中；同时它要覆盖「病情报告 / 病情介绍 / 病史」
 * 这类患者自己写的综述性文件（这类文件名里通常不含专科关键词）。
 */
const CATEGORY_RULES = [
  {
    category: "基本信息",
    pattern:
      /基本信息|病情介绍|病情报告|病情摘要|病情说明|病史|主诉|现病史|既往史|过敏史|家族史|个人史|病案首页|身份|一般情况|入院情况/i,
  },
  {
    category: "病理报告",
    pattern: /病理|细胞学|组织学|免疫组化|基因检测|基因突变|NGS|分子检测|KRAS|BRCA|MSI|PD-?L1/i,
  },
  { category: "影像检查", pattern: /影像|CT|MRI|PET|超声|彩超|B超|X线|X光|内镜|胃镜|MRCP|增强扫描/i },
  { category: "检验指标", pattern: /化验|检验|血常规|生化|肝功|肾功|电解质|凝血|肿标|肿瘤标志物|CA19|CA72|CA125|CEA|AFP|淀粉酶|脂肪酶/i },
  { category: "用药方案", pattern: /处方|用药|化疗|靶向|免疫治疗|方案|医嘱|药品|白蛋白紫杉醇|吉西他滨|奥沙利铂|氟尿嘧啶/i },
  { category: "诊疗记录", pattern: /出院|入院|门诊|急诊|手术|病程|小结|记录|会诊|复诊|住院/i },
  { category: "其他资料", pattern: /医保|费用|发票|营养|护理|健康教育|须知|同意书|保险/i },
];

/** 能被本地直接读出文本的扩展名；其余只登记为「未解析」。 */
const TEXT_EXT = [".txt", ".md"];
const KNOWN_BINARY_EXT = [
  ".pdf",
  ".doc",
  ".docx",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".bmp",
  ".tif",
  ".tiff",
  ".dcm",
  ".dicom",
  ".csv",
  ".xlsx",
  ".xls",
];

/** 提取状态：只有「已解析」才有正文，其余都必须如实标注，不得假装读过。 */
const EXTRACTION_STATUS = {
  PARSED: "已解析",
  UNSUPPORTED_FORMAT: "未解析（当前版本不支持的格式）",
  EMPTY: "未解析（文件为空或无可用文本）",
  READ_ERROR: "未解析（读取失败）",
  TRUNCATED: "已解析（内容过长已截断）",
};

function extOf(name) {
  const lower = String(name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

/** 该文件能否在本地直接读出文本。 */
function isParseable(name) {
  return TEXT_EXT.includes(extOf(name));
}

/**
 * 按文件名 + 可选正文摘要判定类目。
 *
 * 优先级（重要）：**文件名先于正文**。
 * 文件名是用户/医院给出的显式归类意图（「基本病情报告」「CT报告」），
 * 正文关键词只是补充证据——一份综合病情报告里顺带提到「病理结果」，
 * 不应该让整份报告（连同它的全部时间线日期）被归成病理报告。
 *
 * 只有当文件名无法判定时，才退回看正文前若干字符。
 * 两轮都按规则表顺序取最先命中者，越具体的类别越靠前。
 *
 * 只做关键词归类，读不出内容时归入「其他资料」——绝不做语义猜测。
 */
function categorize(name, contentHint) {
  const byName = matchCategory(String(name || ""));
  if (byName) return byName;
  const hint = typeof contentHint === "string" ? contentHint.slice(0, 2000) : "";
  return matchCategory(hint) || "其他资料";
}

/** 在给定文本里按规则表顺序找第一个命中的类目；没有命中返回 null。 */
function matchCategory(haystack) {
  if (!haystack) return null;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  return null;
}

/**
 * 从文本中抽取日期，统一成 YYYY-MM-DD。
 * 支持 2024-03-15 / 2024年3月15日 / 2024/03/15 / 2024.03.15 四种写法。
 * 只做格式识别，不做时序推断。
 */
function extractDates(text) {
  if (typeof text !== "string" || !text) return [];
  const found = new Set();
  const push = (y, m, d) => {
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (year < 1900 || year > 2999) return;
    if (month < 1 || month > 12) return;
    if (day < 1 || day > 31) return;
    const pad = (n) => String(n).padStart(2, "0");
    found.add(`${year}-${pad(month)}-${pad(day)}`);
  };

  const dashLike = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g;
  let m;
  while ((m = dashLike.exec(text)) !== null) push(m[1], m[2], m[3]);

  return [...found];
}

/** 最早/最晚日期，用于时间线排序；无日期返回 null。 */
function sortKeyOf(date) {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "9999-99-99";
}

/**
 * 构造一条带来源标注的资料记录（provenance）。
 *
 * 关键约束：
 *   · `sourceName` 只能是**相对文件名**，不得是绝对路径（隐私 + 可移植）；
 *   · `extractionStatus` 必须如实反映有没有真正读到正文；
 *   · 正文缺失时 `text` 为空串，且 `dates` 为空——不得用文件名日期冒充内容日期。
 */
function makeRecord(input) {
  const {
    sourceName,
    category,
    text = "",
    extractionStatus,
    dates,
    truncated = false,
    readError = null,
  } = input || {};

  const name = typeof sourceName === "string" ? sourceName : "";
  const body = typeof text === "string" ? text : "";
  const status =
    extractionStatus ||
    (readError ? EXTRACTION_STATUS.READ_ERROR : body.trim() ? (truncated ? EXTRACTION_STATUS.TRUNCATED : EXTRACTION_STATUS.PARSED) : EXTRACTION_STATUS.EMPTY);

  return {
    sourceName: name,
    category: CATEGORIES.includes(category) ? category : CATEGORIES[CATEGORIES.length - 1],
    extractionStatus: status,
    parsed: status === EXTRACTION_STATUS.PARSED || status === EXTRACTION_STATUS.TRUNCATED,
    truncated: Boolean(truncated),
    readError: readError ? String(readError) : null,
    charCount: body.length,
    dates: Array.isArray(dates) ? dates : extractDates(body),
    text: body,
  };
}

/**
 * 把「原始文件名列表」转成记录集合。
 * `reader` 由调用方注入（真实环境是 pi.fs.readText，测试环境是内存实现），
 * 因此本函数保持纯逻辑、可离线测试。
 *
 * @param {Array<{name: string, path: string}>} files
 * @param {{read?: (path: string) => Promise<string>, maxFileChars?: number}} [options]
 */
async function buildRecords(files, options = {}) {
  const read = options.read;
  const maxFileChars = options.maxFileChars > 0 ? options.maxFileChars : 20000;
  const records = [];
  const readErrors = [];

  for (const file of files || []) {
    const name = (file && file.name) || "";

    if (!isParseable(name)) {
      records.push(
        makeRecord({
          sourceName: name,
          category: categorize(name),
          text: "",
          extractionStatus: EXTRACTION_STATUS.UNSUPPORTED_FORMAT,
        }),
      );
      continue;
    }

    let raw = "";
    try {
      raw = typeof read === "function" ? await read(file.path) : "";
    } catch (err) {
      readErrors.push(name);
      records.push(
        makeRecord({
          sourceName: name,
          category: categorize(name),
          text: "",
          extractionStatus: EXTRACTION_STATUS.READ_ERROR,
          readError: (err && err.message) || err,
        }),
      );
      continue;
    }

    const body = typeof raw === "string" ? raw : "";
    let text = body;
    let truncated = false;
    if (text.length > maxFileChars) {
      text = `${text.slice(0, maxFileChars)}\n…（此文件过长，已截断）`;
      truncated = true;
    }

    records.push(
      makeRecord({
        sourceName: name,
        category: categorize(name, text),
        text,
        truncated,
      }),
    );
  }

  return { records, readErrors };
}

/**
 * 生成时间线：按日期升序，同日按类目稳定排序。
 * 只收录能在正文里找到日期的记录，且**不做任何病情推断**。
 */
function buildTimeline(records) {
  const entries = [];
  for (const record of records || []) {
    if (!record || !record.parsed) continue;
    for (const date of record.dates || []) {
      entries.push({ date, category: record.category, sourceName: record.sourceName });
    }
  }
  entries.sort(
    (a, b) =>
      sortKeyOf(a.date).localeCompare(sortKeyOf(b.date)) ||
      a.category.localeCompare(b.category, "zh-Hans-CN") ||
      a.sourceName.localeCompare(b.sourceName, "zh-Hans-CN"),
  );
  return entries;
}

/**
 * 缺口提示：列出没有任何资料落入的类目。
 *
 * 措辞纪律（对应上游「不要做」章节）：只能说「资料里没看到这一类」，
 * 绝不能说「没做过这项检查」。
 */
function findGaps(records) {
  const present = new Set();
  for (const record of records || []) {
    if (record && record.parsed) present.add(record.category);
  }
  return CATEGORIES.filter((c) => !present.has(c)).map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    note: `资料中未见「${category}」类内容（不代表没有做过相关检查）。`,
  }));
}

/** 统计类目分布，含未解析数量。 */
function summarizeCategories(records) {
  const buckets = {};
  for (const category of CATEGORIES) buckets[category] = { parsed: 0, unparsed: 0 };
  for (const record of records || []) {
    if (!record) continue;
    const bucket = buckets[record.category] || (buckets[record.category] = { parsed: 0, unparsed: 0 });
    if (record.parsed) bucket.parsed += 1;
    else bucket.unparsed += 1;
  }
  return buckets;
}

/** 汇总整理结果，供上层（命令 / 界面 / 模型）消费。 */
function buildArchive(records) {
  const list = records || [];
  const parsed = list.filter((r) => r.parsed);
  const unparsed = list.filter((r) => !r.parsed);
  return {
    categories: CATEGORIES,
    categoryLabels: CATEGORY_LABELS,
    buckets: summarizeCategories(list),
    timeline: buildTimeline(list),
    gaps: findGaps(list),
    totalCount: list.length,
    parsedCount: parsed.length,
    unparsedCount: unparsed.length,
    // 未解析的必须能被用户看见，否则会误以为「全都读过了」
    unparsedFiles: unparsed.map((r) => ({ sourceName: r.sourceName, extractionStatus: r.extractionStatus })),
  };
}

/** 渲染成 Markdown 档案（不含模型输出，纯结构化归档）。 */
function renderMarkdown(archive, options = {}) {
  const a = archive || buildArchive([]);
  const title = (options && options.title) || "小胰宝 · 病案整理";
  const lines = [`# ${title}`, ""];

  lines.push("> 以下信息供参考，不能替代医生诊断。", "");
  lines.push(`- 资料总数：${a.totalCount} 份`);
  lines.push(`- 已解析：${a.parsedCount} 份`);
  lines.push(`- 未解析：${a.unparsedCount} 份`);
  lines.push("");

  lines.push("## 一、分类归档", "");
  lines.push("| 类目 | 已解析 | 未解析 |", "| --- | --- | --- |");
  for (const category of a.categories) {
    const bucket = a.buckets[category] || { parsed: 0, unparsed: 0 };
    lines.push(`| ${category} | ${bucket.parsed} | ${bucket.unparsed} |`);
  }
  lines.push("");

  lines.push("## 二、时间线", "");
  if (!a.timeline.length) {
    lines.push("资料中未见可识别的日期。", "");
  } else {
    for (const entry of a.timeline) {
      lines.push(`- ${entry.date}　${entry.category}　（${entry.sourceName}）`);
    }
    lines.push("");
  }

  lines.push("## 三、缺口提示", "");
  if (!a.gaps.length) {
    lines.push("七类资料均有内容。", "");
  } else {
    for (const gap of a.gaps) {
      lines.push(`- ${gap.category}：${gap.label}`);
    }
    lines.push("");
  }

  if (a.unparsedFiles.length) {
    lines.push("## 四、未能解析的资料", "");
    lines.push("以下资料本次没有读取到正文，需要人工确认：", "");
    for (const file of a.unparsedFiles) {
      lines.push(`- ${file.sourceName}——${file.extractionStatus}`);
    }
    lines.push("");
  }

  lines.push("---", "");
  lines.push("> 本档案是资料索引，原件始终以医院出具的为准。", "");
  return lines.join("\n");
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_RULES,
  TEXT_EXT,
  KNOWN_BINARY_EXT,
  EXTRACTION_STATUS,
  extOf,
  isParseable,
  categorize,
  extractDates,
  makeRecord,
  buildRecords,
  buildTimeline,
  findGaps,
  summarizeCategories,
  buildArchive,
  renderMarkdown,
};
