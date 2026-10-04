/**
 * 小胰宝 · 五来源统一试验查询：规范化与保守合并（F2 契约实现）
 *
 * 设计文档：XYB-TRIAL-UNIFIED-QUERY.md（v1.0）、
 * docs/spec/xyb-unified-trial-host-orchestration.md（宿主编排 SPEC）
 *
 * 本模块**只做纯函数**：把各来源的返回压成同一种记录形状，并按可证明的规则保守合并。
 * 不联网、不读文件、不抛业务异常——调用方负责取数与错误呈现。
 *
 * 为什么不在这里直接查五个来源：宿主的插件权限模型不允许一个插件调用
 * 另一个插件的 MCP 工具（MCP 工具注册在**来源插件自己的**命名空间下）。
 * 因此"调用五个来源"这一步由助手按技能契约编排，本模块只保证
 * 「规范化 → 合并 → 去重」这一段是确定性的、可离线测试的。
 */

/** 五个来源的登记标识。顺序即默认展示顺序（与 SPEC §5.2 的按序键一致）。 */
const SOURCES = Object.freeze([
  "clinicaltrials_gov",
  "chictr",
  "veeva_ctv",
  "chinadrugtrials",
  "who_ictrp",
]);

const SOURCE_LABELS = Object.freeze({
  clinicaltrials_gov: "ClinicalTrials.gov",
  chictr: "ChiCTR（中国临床试验注册中心）",
  veeva_ctv: "Veeva CTV",
  chinadrugtrials: "药物临床试验登记与信息公示平台",
  who_ictrp: "WHO ICTRP",
});

/**
 * 来源按 kind 分类（SPEC §6.2）。kind 决定呈现方式，不是装饰字段：
 *   - remote_registry   ：实时远端注册库查询，结果即上游当前状态
 *   - aggregator_registry：权威聚合库，但**返回集是下界**（ICTRP CSV 静默不完整）
 *   - local_index       ：本地索引，必须暴露构建时间
 *   - archived_scrape   ：本地归档，随包冷启动数据
 */
const SOURCE_KINDS = Object.freeze({
  clinicaltrials_gov: "remote_registry",
  chictr: "remote_registry",
  veeva_ctv: "local_index",
  chinadrugtrials: "archived_scrape",
  who_ictrp: "aggregator_registry",
});

/**
 * 上游返回集系统性不完整的来源。这些来源的条数**永远是下界**，
 * 不得当作"符合条件的试验总数"呈现（SPEC §15.2 / §15.5）。
 *
 * 实测依据：ICTRP 门户自报 1243 条（`KRAS`）时 CSV 只给 882 条，缺 29.0%；
 * 逐页抓 HTML 得 108 个不同登记号，其中 8 个不在 CSV 里。
 */
const UPSTREAM_INCOMPLETE_SOURCES = Object.freeze(["who_ictrp"]);

/**
 * 系统性来源重叠（SPEC §15.5 合并规则）。
 *
 * WHO ICTRP 收录 `source_register = "ChiCTR"` 的记录且每周同步，因此同一条
 * 中国试验会从 chictr 与 who_ictrp 各进一次。重叠时保留**直连版**（chictr），
 * ICTRP 版本标注为「ChiCTR via WHO ICTRP」；三个数字（rows_returned /
 * upstream_reported_total / 合并后条数）禁止合并成一个。
 */
const SOURCE_OVERLAPS = Object.freeze({
  who_ictrp: ["chictr", "clinicaltrials_gov"],
});

/**
 * 合并时的**来源权威序**（SPEC §15.5 合并规则 1、2，越小越权威）。
 *
 * 规则不是"先到先得"也不是"字母序"，而是**一手来源优先于聚合库**：
 * ICTRP 是每周同步的聚合库，它收录的 ChiCTR/NCT 记录都比直连来源旧。
 * 因此同一登记号命中多个来源时，取权威序最高的那一条作为主记录
 * （标题、状态、主键都取自它），其余来源进 `mergedFrom` 与 `perSource`。
 *
 * 历史陷阱（2026-10-04）：此前主记录取的是 `source.localeCompare()` 的字典序第一，
 * 而 `chictr` 与 `clinicaltrials_gov` 恰好都排在 `who_ictrp` 之前，所以结果
 * **看起来**符合 SPEC。但那是巧合——任何新增来源的字母序都可能翻转结论。
 * 例如若某天加入 `aaa_registry`，字典序会把它选为主记录，而它可能是个聚合库。
 * 故显式列出权威序，并对未列出的来源回落到字典序（保持确定性，不崩）。
 */
const SOURCE_AUTHORITY = Object.freeze({
  // 一手注册库（用户提交试验的地方，最新）
  clinicaltrials_gov: 0,
  chictr: 0,
  chinadrugtrials: 0,
  // 本地索引（带自己的构建时间，介于两者之间）
  veeva_ctv: 10,
  // 聚合库（每周同步，最旧）—— 被同登记号的一手记录覆盖
  who_ictrp: 20,
});

/** 权威序比较；未登记来源按字典序排在已登记来源之后，保证确定性。 */
function compareSourceAuthority(a, b) {
  const rankA = SOURCE_AUTHORITY[a] ?? 100;
  const rankB = SOURCE_AUTHORITY[b] ?? 100;
  if (rankA !== rankB) return rankA - rankB;
  return a.localeCompare(b);
}

/** 来源级执行状态。绝不把"没跑/跑不起来"混成"没有结果"。 */
const STATES = Object.freeze([
  "SUCCESS",
  "NO_RESULTS",
  "NOT_ENABLED",
  "NEEDS_SETUP",
  "INDEX_EMPTY",
  "SESSION_EXPIRED",
  "CHALLENGE_REQUIRED",
  "TIMEOUT",
  "FAILED",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 登记号规范化。
 *
 * 只做**大小写与分隔符**层面的归一，不做任何模糊匹配：
 * NCT01234567 / nct01234567 视为同一个；ChiCTR-IPR-17012345 与
 * ChiCTRIPR17012345 视为同一个。其余一律保持原样，避免把不同试验
 * 因为"看起来像"而合并。
 */
function normalizeRegistryId(raw) {
  const value = text(raw);
  if (!value) return "";
  return value.toUpperCase().replace(/[\s_\-·/]/g, "");
}

/** 稳定主键：来源 + 规范化登记号。缺登记号时返回空串（不得参与自动合并）。 */
function sourceRecordKey(source, registryId) {
  const norm = normalizeRegistryId(registryId);
  if (!norm) return "";
  return `${source}:${norm}`;
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined);
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

/** 地点字段统一成对象，容忍来源给出的纯字符串。 */
function normalizeLocations(raw) {
  const out = [];
  for (const item of toArray(raw)) {
    if (typeof item === "string") {
      const value = item.trim();
      if (value) out.push({ site: value });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const loc = {};
    for (const key of ["country", "province", "city", "site"]) {
      const value = text(item[key]);
      if (value) loc[key] = value;
    }
    if (Object.keys(loc).length > 0) out.push(loc);
  }
  return out;
}

/** 地点是否在国内（用于排序与「国内结果优先展示」，不做匹配判断）。 */
function isDomestic(location) {
  if (!location || typeof location !== "object") return false;
  const country = text(location.country);
  if (!country) return false;
  return /中国|china|cn|taiwan|hong kong|macau|hongkong/i.test(country);
}

/**
 * 把单个来源的原始条目压成 UnifiedTrialRecord。
 *
 * 字段名可随来源变化，语义不得减少：没有的字段留空，**不推测**。
 */
function normalizeRecord(source, raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const registryId = text(
    item.registryId || item.registry_id || item.nctId || item.id || item.reg_no || item.regNo,
  );
  const extraIds = toArray(item.registryIds || item.crossReferences || item.cross_references)
    .map((v) => text(typeof v === "object" && v ? v.id || v.registryId : v))
    .filter(Boolean);

  const registryIds = [];
  for (const candidate of [registryId, ...extraIds]) {
    if (candidate && !registryIds.includes(candidate)) registryIds.push(candidate);
  }

  return {
    source,
    sourceRecordKey: sourceRecordKey(source, registryId),
    registryId,
    registryIds,
    title: text(item.title || item.briefTitle || item.name),
    sourceStatusRaw: text(item.sourceStatusRaw || item.status || item.overallStatus || item.state),
    phase: text(item.phase || (Array.isArray(item.phases) ? item.phases.join(" / ") : "")),
    conditions: toArray(item.conditions).map(text).filter(Boolean),
    interventions: toArray(item.interventions || item.drugs || item.drugs_name)
      .map((v) => text(typeof v === "object" && v ? v.name || v.interventionName : v))
      .filter(Boolean),
    locations: normalizeLocations(item.locations),
    sourceUrl: text(item.sourceUrl || item.url || item.link),
    fetchedAt: text(item.fetchedAt) || new Date().toISOString().slice(0, 10),
  };
}

/** 来源级状态：把适配器结果包成统一形状。 */
function sourceStatus(source, input) {
  const raw = input && typeof input === "object" ? input : {};
  const state = STATES.includes(raw.state) ? raw.state : "FAILED";
  const upstreamIncomplete =
    UPSTREAM_INCOMPLETE_SOURCES.includes(source) || raw.upstreamIncomplete === true;

  // 上游自报总数与本服务实得行数是**两个独立数字**，禁止合并
  // （SPEC §15.5 / §15.8：ICTRP 不存在 total_matched，只有这两者）。
  const upstreamReportedTotal = toFiniteInt(raw.upstreamReportedTotal);
  const matchedRowsReturned = toFiniteInt(raw.matchedRowsReturned);

  return {
    source,
    displayName: SOURCE_LABELS[source] || source,
    kind: SOURCE_KINDS[source] || "remote_registry",
    state,
    resultCount: state === "SUCCESS" ? toArray(raw.records).length : 0,
    explanation: text(raw.explanation) || defaultExplanation(state),
    fetchedAt: text(raw.fetchedAt) || undefined,
    // 下界契约：上游不完整的来源即使 SUCCESS，条数也只是下界。
    upstreamIncomplete: upstreamIncomplete || undefined,
    upstreamReportedTotal,
    matchedRowsReturned,
    // 与哪些来源系统性重叠（同一条试验可能各进一次）
    overlapWith: SOURCE_OVERLAPS[source] ? [...SOURCE_OVERLAPS[source]] : undefined,
  };
}

/**
 * 把上游数字压成非负整数；缺失/非数字一律返回 undefined，**不返回 0**。
 *
 * 理由（SPEC §5）：0 是一个有含义的断言（"确实没有"），而"没有这个数字"
 * 与"数字是 0"是两件事。用 0 兜底会把未知伪装成确定。
 */
function toFiniteInt(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}

/**
 * 状态是否代表"这一处真的查过了"。
 *
 * 只有 SUCCESS 与 NO_RESULTS 算查过（NO_RESULTS 是"查了、没有"，
 * 与"没查"是两件事）。其余状态一律归为"未取得结果"。
 */
function isQueried(state) {
  return state === "SUCCESS" || state === "NO_RESULTS";
}

/**
 * 「本次查询覆盖了哪几处」的汇总句，供助手与面板原样呈现。
 *
 * 存在的理由：2026-10-04 实测到助手只查了 CT.gov 与 ChiCTR 就结束回合，
 * Veeva 与中国药物登记平台一次都没调，且不报错——用户会拿到一个"看起来
 * 是当时全部来源的汇总、实际只有两个渠道"的答案。覆盖句强制把这件事说出来。
 * （当时是四渠道；加 who_ictrp 后同类沉默会说成"五渠道汇总"，故不再写死数字。）
 *
 * 约定：只要有没有查的来源，句子必须以「未覆盖」明确收尾，
 *      不得让读者把沉默读成"零结果"。
 */
function coverageSentence(statuses) {
  const list = toArray(statuses);
  const total = list.length;
  const queried = list.filter((s) => isQueried(s.state));
  const missing = list.filter((s) => !isQueried(s.state));

  if (total === 0) return "本次没有可汇总的来源。";

  const queriedNames = queried.map((s) => s.displayName || SOURCE_LABELS[s.source] || s.source);

  if (!missing.length) {
    return `本次已覆盖全部 ${total} 处来源（${queriedNames.join("、")}）。`;
  }

  const missingParts = missing.map((s) => {
    const name = s.displayName || SOURCE_LABELS[s.source] || s.source;
    return `${name}（${s.explanation || defaultExplanation(s.state)}）`;
  });

  return (
    `本次只覆盖 ${queried.length}/${total} 处来源：` +
    (queriedNames.length ? queriedNames.join("、") : "无") +
    `。未覆盖：${missingParts.join("；")}。` +
    `未覆盖不等于没有结果。`
  );
}

function defaultExplanation(state) {
  switch (state) {
    case "SUCCESS":
      return "已执行并返回结果";
    case "NO_RESULTS":
      return "该来源已执行，但没有匹配结果";
    case "NOT_ENABLED":
      return "尚未启用该来源，当前结果不含这一处";
    case "NEEDS_SETUP":
      return "该来源尚未完成初始化或缺少依赖";
    case "INDEX_EMPTY":
      return "本地索引为空，需要先建立索引";
    case "SESSION_EXPIRED":
      return "会话已失效，需要本人重新登录后再查";
    case "CHALLENGE_REQUIRED":
      return "来源要求人工验证，本次未能继续";
    case "TIMEOUT":
      return "查询超时，本次未取得结果";
    default:
      return "查询失败，本次未取得结果";
  }
}

function mergeLocations(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    for (const loc of record.locations || []) {
      const key = [loc.country, loc.province, loc.city, loc.site].filter(Boolean).join("|");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(loc);
    }
  }
  return out;
}

function mergeUnique(records, field) {
  const out = [];
  for (const record of records) {
    for (const value of record[field] || []) {
      if (!out.includes(value)) out.push(value);
    }
  }
  return out;
}

/**
 * 合并同一试验的多来源记录。
 *
 * 只做**保守合并**：同一试验只保留一条，但必须保留全部来源、全部登记号、
 * 全部原始链接，以及有冲突时的来源级取值。
 */
function mergeGroup(source_records) {
  // 主记录按**来源权威序**选（一手 > 本地索引 > 聚合库），不是字典序、不是先到先得。
  const records = source_records.slice().sort((a, b) => compareSourceAuthority(a.source, b.source));
  const primary = records[0];

  const registryIds = [];
  for (const record of records) {
    for (const id of record.registryIds || []) {
      if (!registryIds.includes(id)) registryIds.push(id);
    }
  }

  const statuses = {};
  const titles = {};
  const phases = {};
  for (const record of records) {
    if (record.sourceStatusRaw) statuses[record.source] = record.sourceStatusRaw;
    if (record.title) titles[record.source] = record.title;
    if (record.phase) phases[record.source] = record.phase;
  }

  return {
    merged: true,
    mergedFrom: records.map((r) => r.source),
    // 主键/标题/状态取自权威序最高的来源（SPEC §15.5：一手来源优先于聚合库）
    primarySource: primary.source,
    sourceRecordKey: primary.sourceRecordKey,
    registryIds,
    title: primary.title,
    sourceStatusRaw: primary.sourceStatusRaw,
    phase: primary.phase,
    conditions: mergeUnique(records, "conditions"),
    interventions: mergeUnique(records, "interventions"),
    locations: mergeLocations(records),
    linkedRecordKeys: records.map((r) => r.sourceRecordKey || `${r.source}:${r.registryId}`),
    sourceLinks: records
      .filter((r) => r.sourceUrl)
      .map((r) => ({ source: r.source, url: r.sourceUrl })),
    // 冲突不掩盖：逐来源列出原始取值，由用户与医生判断
    perSource: { title: titles, phase: phases, sourceStatusRaw: statuses },
  };
}

const RECRUITING_HINT =
  /recruit|招募|not yet|尚未|active, not|进行中|enrolling/i;

function sortKey(record) {
  const recruiting = RECRUITING_HINT.test(record.sourceStatusRaw || "") ? 0 : 1;
  const domestic = (record.locations || []).some(isDomestic) ? 0 : 1;
  const updated = record.fetchedAt || "";
  // 排序权重：招募状态 → 国内地点 → 更新时间（倒序）→ 主键（稳定兜底）
  return [recruiting, domestic, updated ? `~${updated}` : "~", record.sourceRecordKey || ""];
}

function compareRecords(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

/**
 * 保守去重。
 *
 * 自动合并**仅限**以下情形：
 *   1. 规范化后的官方登记号完全相同；
 *   2. 来源显式给出跨注册库交叉引用；
 *   3. 调用方提供可审计的官方映射。
 * 标题、药物、地点、申办方、疾病、日期、分期相似一律**不合并**。
 *
 * 返回 { records, groups, mergeCandidates }：
 *   - records：最终展示记录（合并后的与独立的混合）；
 *   - mergeCandidates：疑似同试验但缺少稳定证据的分组，只标注、不合并。
 */
function dedupe(records) {
  const withKey = [];
  const withoutKey = [];
  for (const record of records) {
    if (record.sourceRecordKey) withKey.push(record);
    else withoutKey.push(record);
  }

  const byRegistry = new Map();
  for (const record of withKey) {
    const key = normalizeRegistryId(record.registryId);
    if (!byRegistry.has(key)) byRegistry.set(key, []);
    byRegistry.get(key).push(record);
  }

  const groups = [];
  const merged = [];
  for (const [, group] of byRegistry) {
    if (group.length === 1) {
      merged.push({ ...group[0], merged: false, mergedFrom: [group[0].source] });
      groups.push(group);
      continue;
    }
    // 多来源命中同一个登记号 → 自动合并
    const combined = mergeGroup(group);
    merged.push(combined);
    groups.push(group);
  }

  // 缺登记号的记录：保留为独立结果，仅按规范化标题给出"可能相关"提示
  const mergeCandidates = [];
  const hintIndex = new Map();
  for (const record of withoutKey) {
    const hint = text(record.title).toLowerCase().replace(/\s+/g, "");
    if (hint && hintIndex.has(hint)) {
      mergeCandidates.push([hintIndex.get(hint), record]);
    } else if (hint) {
      hintIndex.set(hint, record);
    }
  }

  for (const record of withoutKey) {
    merged.push({ ...record, merged: false, mergedFrom: [record.source] });
  }

  merged.sort(compareRecords);

  return {
    records: merged,
    groups,
    // 仅提示，不合并：标题相似但没有稳定登记号
    mergeCandidates: mergeCandidates.map(([a, b]) => ({
      reason: "标题相似但缺少稳定登记号，未自动合并",
      sources: [a.source, b.source],
      titles: [a.title, b.title],
    })),
  };
}

/**
 * 统一查询结果组装：来源状态 + 合并后的记录。
 *
 * 未执行或失败的来源**不会**变成空结果：它保留自己的 state 与说明。
 */
function buildResult({ query, sourceResults }) {
  const statuses = [];
  const allRecords = [];

  for (const source of SOURCES) {
    const provided = sourceResults && sourceResults[source];
    if (!provided) {
      // 调用方没有为该来源提供任何结果 → 如实标记"未执行"，不假装没有结果
      statuses.push({
        source,
        displayName: SOURCE_LABELS[source],
        kind: SOURCE_KINDS[source] || "remote_registry",
        state: "NOT_ENABLED",
        resultCount: 0,
        explanation: "本次查询未包含该来源",
      });
      continue;
    }
    const status = sourceStatus(source, provided);
    statuses.push(status);
    for (const raw of toArray(provided.records)) {
      allRecords.push(normalizeRecord(source, raw));
    }
  }

  const { records, mergeCandidates } = dedupe(allRecords);

  // Layer 2 契约：覆盖率必须随结果一起返回，使"漏查"可见。
  // 助手与面板都必须原样呈现 coverage.sentence，不得只报条数。
  const coverage = {
    total: statuses.length,
    queried: statuses.filter((s) => isQueried(s.state)).length,
    missing: statuses.filter((s) => !isQueried(s.state)).length,
    complete: statuses.every((s) => isQueried(s.state)),
    queriedSources: statuses.filter((s) => isQueried(s.state)).map((s) => s.source),
    missingSources: statuses.filter((s) => !isQueried(s.state)).map((s) => s.source),
    sentence: coverageSentence(statuses),
  };

  // Layer 3 契约：条数意义的诚实标注。
  //
  // 「覆盖了全部来源」不等于「拿到了全部试验」——上游聚合库（ICTRP）的返回集
  // 系统性小于它自己声称的匹配数。两件事必须分开说，否则 SUCCESS + 全部覆盖
  // 会被读成"这就是全部符合条件的试验"。
  const incompleteSources = statuses
    .filter((s) => s.upstreamIncomplete && isQueried(s.state))
    .map((s) => s.source);

  const completeness = {
    // 本次是否每个来源都真的查过（与"数据是否完整"是两件事）
    coverageComplete: coverage.complete,
    // 查过的来源里，返回集是下界的那些
    upstreamIncompleteSources: incompleteSources,
    countsAreLowerBounds: incompleteSources.length > 0,
    sentence: completenessSentence(statuses, incompleteSources),
  };

  return {
    query: {
      keywords: text(query && (query.keywords || query.terms)),
      condition: text(query && query.condition),
    },
    statuses,
    coverage,
    completeness,
    sourcesQueried: statuses.filter((s) => s.state === "SUCCESS" || s.state === "NO_RESULTS").length,
    sourcesUnavailable: statuses.filter(
      (s) => s.state !== "SUCCESS" && s.state !== "NO_RESULTS",
    ).length,
    totalRecords: allRecords.length,
    records,
    mergeCandidates,
    disclaimer:
      "以下为公开试验信息整理，供参考，不构成医疗建议；是否符合入组条件需由研究医生判断。",
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

/**
 * 「这些条数是什么」的汇总句。
 *
 * 与 coverageSentence 分工明确：coverage 说**查了哪几处**，本函数说
 * **拿到的数字是什么性质**。上游不完整时必须以「下界」明确收尾并点出是哪个
 * 来源，且不得把两个数字合并。
 */
function completenessSentence(statuses, incompleteSources) {
  const list = toArray(statuses);
  const sources = toArray(incompleteSources);

  if (!sources.length) {
    // 没有已知的下界来源：只能说"未发现已知不完整来源"，不能说"数据完整"
    return "本次未发现已知返回集不完整的来源。这不等于结果是全部符合条件的试验。";
  }

  const names = sources.map((s) => SOURCE_LABELS[s] || s);
  const numbers = sources
    .map((source) => {
      const status = list.find((s) => s.source === source);
      if (!status) return "";
      const got = status.matchedRowsReturned ?? status.resultCount;
      const reported = status.upstreamReportedTotal;
      if (reported === undefined) return `${SOURCE_LABELS[source] || source}：实得 ${got} 条`;
      return `${SOURCE_LABELS[source] || source}：实得 ${got} 条、上游自报 ${reported} 条`;
    })
    .filter(Boolean);

  return (
    `${names.join("、")}的返回集是**下界**：这些来源的导出通道已实测会静默漏掉它自己` +
    `声称匹配的记录，因此条数不得当作符合条件的试验总数。` +
    (numbers.length ? `（${numbers.join("；")}）` : "") +
    `某条试验不在结果里，不构成它不存在的证据。`
  );
}

module.exports = {
  SOURCES,
  SOURCE_LABELS,
  SOURCE_KINDS,
  UPSTREAM_INCOMPLETE_SOURCES,
  SOURCE_OVERLAPS,
  STATES,
  normalizeRegistryId,
  sourceRecordKey,
  normalizeRecord,
  normalizeLocations,
  sourceStatus,
  dedupe,
  buildResult,
  compareRecords,
  isDomestic,
  isQueried,
  coverageSentence,
  completenessSentence,
};
