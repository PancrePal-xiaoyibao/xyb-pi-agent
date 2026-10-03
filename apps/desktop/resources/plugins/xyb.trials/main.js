/**
 * 小胰宝 · 找试验（xyb.trials）
 *
 * 职责：按患者情况检索公开临床试验，返回候选清单（编号 / 状态 / 入组要点 / 来源）。
 * 边界：只做"信息检索 + 结构化呈现"，不给"你应该参加哪一项"的结论。
 *
 * 重要：ClinicalTrials.gov 只认英文关键词（实测中文 query.cond 返回 0 条），
 * 因此插件内置中文→英文术语映射，把患者输入的口语词转成可检索的英文。
 */

const unified = require("./lib/unified.js");

const DISCLAIMER = "以下为公开试验信息整理，供参考，不构成医疗建议；是否符合入组条件需由研究医生判断。";

const CTGOV_SEARCH = "https://clinicaltrials.gov/api/v2/studies";

/** 默认病种：胰腺癌（小胰宝的主场景）。 */
const DEFAULT_CONDITION = "pancreatic cancer";

/**
 * 中文 → 英文检索词映射。
 * 顺序有意义：更具体的词组必须排在更宽泛的词前面（药物名优先，再病种，再治疗线）。
 * 替换值统一前后加空格，避免"晚期胰腺癌"拼成 "advancedpancreatic"。
 */
const ZH_MAP = [
  // —— 药物名（患者最常直接输入） ——
  [/帕博利珠单抗|K药/gi, "pembrolizumab"],
  [/纳武利尤单抗|O药/gi, "nivolumab"],
  [/度伐利尤单抗|德瓦鲁单抗/gi, "durvalumab"],
  [/伊匹木单抗|伊匹单抗/gi, "ipilimumab"],
  [/替雷利珠单抗/gi, "tislelizumab"],
  [/信迪利单抗/gi, "sintilimab"],
  [/卡瑞利珠单抗/gi, "camrelizumab"],
  [/特瑞普利单抗/gi, "toripalimab"],
  [/斯鲁利单抗/gi, "serplulimab"],
  [/恩沃利单抗/gi, "envafolimab"],
  [/曲美木单抗/gi, "tremelimumab"],
  [/吉西他滨/gi, "gemcitabine"],
  [/白蛋白紫杉醇|白紫/gi, "nab-paclitaxel"],
  [/紫杉醇/gi, "paclitaxel"],
  [/奥沙利铂/gi, "oxaliplatin"],
  [/伊立替康/gi, "irinotecan"],
  [/卡培他滨/gi, "capecitabine"],
  [/替吉奥/gi, "S-1"],
  [/氟尿嘧啶|5-FU/gi, "fluorouracil"],
  [/顺铂/gi, "cisplatin"],
  [/厄洛替尼/gi, "erlotinib"],
  [/奥拉帕利/gi, "olaparib"],
  [/尼拉帕利/gi, "niraparib"],
  [/索托拉西布|索托雷塞/gi, "sotorasib"],
  [/阿达格拉西布/gi, "adagrasib"],
  // —— 病种 ——
  [/胰腺导管腺癌|胰腺导管癌/gi, "pancreatic ductal adenocarcinoma"],
  [/胰腺癌|胰腺恶性肿瘤|胰腺肿瘤/gi, "pancreatic cancer"],
  [/胰腺/gi, "pancreatic"],
  [/腺癌/gi, "adenocarcinoma"],
  // —— 分期与治疗线 ——
  [/局部晚期/gi, "locally advanced"],
  [/不可切除/gi, "unresectable"],
  [/可切除/gi, "resectable"],
  [/新辅助/gi, "neoadjuvant"],
  [/辅助化疗|辅助治疗/gi, "adjuvant"],
  [/一线治疗|一线/gi, "first line"],
  [/二线治疗|二线/gi, "second line"],
  [/三线治疗|三线/gi, "third line"],
  [/后线/gi, "later line"],
  [/晚期/gi, "advanced"],
  [/转移/gi, "metastatic"],
  [/复发/gi, "recurrent"],
  [/耐药/gi, "resistance"],
  // —— 治疗方式 ——
  [/化疗/gi, "chemotherapy"],
  [/免疫治疗|免疫疗法|免疫/gi, "immunotherapy"],
  [/靶向治疗|靶向/gi, "targeted therapy"],
  [/放疗|放射治疗/gi, "radiotherapy"],
  [/抗体偶联药物|抗体偶联|ADC/gi, "antibody drug conjugate"],
  [/双特异性抗体|双抗/gi, "bispecific antibody"],
  [/细胞治疗|细胞疗法/gi, "cell therapy"],
  [/基因治疗/gi, "gene therapy"],
  [/溶瘤病毒/gi, "oncolytic virus"],
  [/疫苗/gi, "vaccine"],
  [/基因突变|突变/gi, "mutation"],
  [/实体瘤|实体肿瘤/gi, "solid tumor"],
  [/中国|国内/gi, "China"],
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 把患者输入（常含中文）转成 CT.gov 能检索的英文关键词。
 * 返回转译后的文本，以及被丢弃、无法映射的残余中文，便于前端如实告知用户。
 */
function translateTerms(input) {
  if (input == null || input === "") return { text: "", translated: false, dropped: "" };

  let text = String(input);
  let translated = false;

  for (const [re, en] of ZH_MAP) {
    if (re.test(text)) {
      // 前后补空格，避免相邻中文词替换后粘连（如"晚期胰腺癌"→"advancedpancreatic"）
      text = text.replace(re, ` ${en} `);
      translated = true;
    }
  }

  const leftover = text.match(/[\u4e00-\u9fa5]+/g) || [];
  const dropped = leftover.join("");
  if (dropped) {
    text = text.replace(/[\u4e00-\u9fa5]+/g, " ");
  }

  text = text.replace(/\s+/g, " ").trim();
  return { text, translated, dropped };
}

function buildQuery({ condition, terms }) {
  const params = new URLSearchParams();
  params.set("query.cond", condition || DEFAULT_CONDITION);
  if (terms) params.set("query.term", terms);
  params.set("filter.overallStatus", "RECRUITING,NOT_YET_RECRUITING,ACTIVE_NOT_RECRUITING");
  params.set("pageSize", "20");
  params.set("format", "json");
  return params.toString();
}

/** 把 CT.gov v2 返回压成患者需要的最小字段。 */
function normalizeStudy(study) {
  const p = (study && study.protocolSection) || {};
  const id = (p.identificationModule && p.identificationModule.nctId) || "";
  const title =
    (p.identificationModule &&
      (p.identificationModule.briefTitle || p.identificationModule.officialTitle)) ||
    "";
  const status = (p.statusModule && p.statusModule.overallStatus) || "";
  const phase = ((p.designModule && p.designModule.phases) || []).join(" / ");
  const conditions = (p.conditionsModule && p.conditionsModule.conditions) || [];
  const locations = ((p.contactsLocationsModule && p.contactsLocationsModule.locations) || [])
    .map((l) => [l.country, l.city].filter(Boolean).join("·"))
    .filter(Boolean)
    .slice(0, 5);
  return {
    id,
    title,
    status,
    phase,
    conditions,
    locations,
    url: id ? `https://clinicaltrials.gov/study/${id}` : "",
    fetchedAt: todayISO(),
  };
}

async function searchTrials(input) {
  const raw = (input && (input.terms || input.keywords || input.query)) || "";
  const { text: terms, translated, dropped } = translateTerms(raw);
  const condition = (input && input.condition) || DEFAULT_CONDITION;

  // 注意签名：pi.net.fetch 只接受**一个对象参数** { url, method?, headers?, body?, timeoutMs? }。
  // 写成 pi.net.fetch(url, {...}) 会让 input.url 为 undefined，
  // 宿主随即抛 "only http(s) URLs allowed"（实测踩过）。
  const res = await pi.net.fetch({
    url: CTGOV_SEARCH + "?" + buildQuery({ condition, terms }),
    method: "GET",
    headers: { Accept: "application/json" },
    timeoutMs: 20000,
  });
  // 关键：宿主返回的是 { status, headers, bodyText } —— 普通对象，**没有 ok，也没有 .json()**。
  // 详见 apps/desktop/electron/main/plugin-runtime.ts:339（服务签名）与 :5612（返回体）。
  // 曾经按 web Response 写成 `if (!res.ok)` + `await res.json()`：
  // res.ok 恒为 undefined（falsy）导致**每次调用都在这里抛错**，
  // 且错误被归因成 NETWORK，看起来像网络问题；实测 CT.gov 明明返回 HTTP 200。
  const status = (res && (res.status || res.statusCode)) || 0;
  const ok = res && (typeof res.ok === "boolean" ? res.ok : status >= 200 && status < 400);
  if (!ok) {
    // 曾经只抛一句「试验数据源请求失败」，面板也把它显示成「请检查网络」，
    // 于是一次 5xx、限流或宿主重启看起来都和断网一样。断言里带上状态码，
    // 让调用方（助手或面板）能区分「站点出错」和「本机网络不通」。
    const err = new Error(
      status
        ? `试验数据源返回 HTTP ${status}`
        : "试验数据源请求失败（没有拿到响应，可能是网络不通或插件进程刚重启）",
    );
    err.code = status === 429 ? "RATE_LIMITED" : status >= 500 ? "UPSTREAM_ERROR" : "NETWORK";
    err.status = status;
    throw err;
  }

  // 兼容两种宿主返回形态：{ bodyText } 是真实宿主，.json() 仅为历史/测试假体。
  let data;
  if (typeof res.json === "function") {
    data = await res.json();
  } else if (typeof res.bodyText === "string") {
    try {
      data = JSON.parse(res.bodyText);
    } catch (e) {
      const err = new Error("试验数据源返回的内容不是合法 JSON");
      err.code = "UPSTREAM_ERROR";
      err.status = status;
      throw err;
    }
  } else {
    const err = new Error("试验数据源返回体无法解析（既没有 bodyText 也没有 json()）");
    err.code = "UPSTREAM_ERROR";
    err.status = status;
    throw err;
  }
  const studies = (data && data.studies) || [];
  return {
    items: studies.map(normalizeStudy),
    translated,
    dropped,
    usedTerms: terms,
    disclaimer: DISCLAIMER,
    fetchedAt: todayISO(),
  };
}

async function onLoad() {
  await pi.commands.register({
    id: "xyb.trials.search",
    title: "小胰宝：按我的情况找试验",
    keywords: ["临床试验", "入组", "试验", "trial", "NCT", "ChiCTR"],
    run: async () => {
      const settings = await pi.plugin.getSettings();
      if (!settings || settings.sourceCtGov === false) {
        await pi.ui.showToast("请在插件设置中至少开启一个试验数据源", "warn");
        return { ok: false, reason: "NO_SOURCE" };
      }
      await pi.ui.showToast("开始检索公开试验信息…");
      return { ok: true };
    },
  });

  // 交给助手调用的工具：参数为病种与关键词。
  // 注意：正确的 API 是 pi.agent.registerTool（不是 agentTools.register），
  // 且必须在 manifest.contributes.agentTools 里先声明同名工具。
  await pi.agent.registerTool({
    name: "xyb_trials_search",
    description:
      "检索 ClinicalTrials.gov 上的公开临床试验，返回试验编号、状态、分期与来源链接。支持中文关键词（内部会转成英文检索词）。" +
      "凡是查临床试验（含「有多少个试验」「按渠道汇总数量」）都优先用本工具，不要用浏览器抓 clinicaltrials.gov/search 这类检索页——" +
      "那是 JS 渲染的，抓取会失败，而本工具实测稳定返回结果。浏览器只适合在已拿到具体 NCT 号后打开详情页补看。" +
      "仅返回公开信息，不构成医疗建议。",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        condition: {
          type: "string",
          description: "病种，英文更准，例如 pancreatic cancer。只填病种，不要把药名填在这里。",
        },
        terms: {
          type: "string",
          description: "关键词，可中文，例如「胰腺癌 KRAS 免疫治疗」；药物名/靶点填这里，例如 IBI343。",
        },
      },
    },
    execute: async (args) => searchTrials(args),
  });

  // —— F2：四来源统一查询 ——
  // 助手按「四来源统一检索」技能逐源取数后，把各来源原始结果交给本工具做
  // 规范化、保守合并与去重。合并逻辑是纯函数（lib/unified.js），可离线验证。
  await pi.agent.registerTool({
    name: "xyb_trials_unify",
    description:
      "把多个试验来源（ClinicalTrials.gov / ChiCTR / Veeva CTV / 中国药物临床试验登记平台）的原始结果合并成统一清单。" +
      "只按规范化登记号做保守去重，标题或药物相似不会被合并；" +
      "未执行或失败的来源会保留自己的状态，不会被当作「没有结果」。" +
      "调用前请先分别调用各来源工具取数——每个来源都要真的调用一次它的渠道工具，" +
      "不要用网页抓取去替代渠道工具（ChiCTR 与 CDE 的检索页是 JS 渲染的，抓取会失败；" +
      "这两家请用各自的 search_trials，取详情用 get_trial_detail）。" +
      "本工具只做合并，不取数。仅整理公开信息，不构成医疗建议。",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        condition: { type: "string", description: "病种（可选）" },
        keywords: { type: "string", description: "本次使用的关键词（可选）" },
        sourceResults: {
          type: "object",
          description:
            "逐来源结果。键为 clinicaltrials_gov / chictr / veeva_ctv / chinadrugtrials。" +
            "值为 { state, records?, explanation?, fetchedAt? }；" +
            "state 取 SUCCESS / NO_RESULTS / NOT_ENABLED / NEEDS_SETUP / INDEX_EMPTY / " +
            "SESSION_EXPIRED / CHALLENGE_REQUIRED / TIMEOUT / FAILED。" +
            "某个来源没跑就不要填它，或明确填 NOT_ENABLED——不要用空数组假装「没有结果」。",
        },
      },
      required: ["sourceResults"],
    },
    execute: async (args) => unified.buildResult(args || {}),
  });
}

async function onUnload() {
  await pi.commands.unregister("xyb.trials.search");
  await pi.agent.unregisterTool("xyb_trials_search");
  await pi.agent.unregisterTool("xyb_trials_unify");
}

async function onPanelInvoke(channel, payload) {
  if (channel === "xyb.trials.search") return searchTrials(payload);
  if (channel === "xyb.trials.unify") return unified.buildResult(payload || {});
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  _internals: { normalizeStudy, buildQuery, translateTerms, searchTrials },
};