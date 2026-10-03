/**
 * 小胰宝 · 看进展（xyb.news）
 *
 * 职责：汇集胰腺癌相关的药物/研究进展条目，只列标题、来源、时间与原文链接。
 * 边界：不生成疗效结论、不推荐用药，条目一律可点回原文。
 * MVP：手动刷新；定时抓取留待后续版本（需 background.service）。
 */

const DISCLAIMER = "以下为公开文献与试验信息的标题整理，供参考，不构成医疗建议，也不代表疗效结论。";

const PUBMED_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

const QUERY = "(pancreatic cancer[Title/Abstract]) AND (KRAS[Title/Abstract] OR ADC[Title/Abstract] OR immunotherapy[Title/Abstract])";

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * 把宿主 `pi.net.fetch` 的返回体解析成 JSON。
 *
 * 宿主返回的是 `{ status, headers, bodyText }` —— 普通对象，**没有 `ok`，也没有 `.json()`**
 * （见 apps/desktop/electron/main/plugin-runtime.ts:339 与 :5612）。
 * 曾经按 web Response 写成 `if (!res.ok)` + `await res.json()`：`res.ok` 恒为 undefined
 * 导致**每次调用都在这里抛错**，还被归因成「网络问题」——实测 PubMed 明明是 HTTP 200。
 */
async function fetchJson(url) {
  // pi.net.fetch 只接受一个对象参数 { url, method?, headers?, body?, timeoutMs? }。
  // 写成 pi.net.fetch(url, {...}) 会让 input.url 为 undefined，
  // 宿主抛 "only http(s) URLs allowed"（实测踩过）。
  const res = await pi.net.fetch({
    url,
    method: "GET",
    headers: { Accept: "application/json" },
    timeoutMs: 20000,
  });
  const status = (res && (res.status || res.statusCode)) || 0;
  const ok = res && (typeof res.ok === "boolean" ? res.ok : status >= 200 && status < 400);
  if (!ok) {
    const err = new Error(
      status ? `数据源返回 HTTP ${status}` : "数据源请求失败（没有拿到响应）",
    );
    err.code = status === 429 ? "RATE_LIMITED" : status >= 500 ? "UPSTREAM_ERROR" : "NETWORK";
    err.status = status;
    throw err;
  }
  // 兼容两种返回形态：bodyText 是真实宿主，.json() 仅为历史/测试假体。
  if (typeof res.json === "function") return res.json();
  if (typeof res.bodyText === "string") {
    try {
      return JSON.parse(res.bodyText);
    } catch (e) {
      const err = new Error("数据源返回的内容不是合法 JSON");
      err.code = "UPSTREAM_ERROR";
      err.status = status;
      throw err;
    }
  }
  const err = new Error("数据源返回体无法解析（既没有 bodyText 也没有 json()）");
  err.code = "UPSTREAM_ERROR";
  err.status = status;
  throw err;
}

/** 拉取最近 N 天的文献条目。 */
async function fetchProgress({ days = 30, limit = 20 } = {}) {
  const searchUrl =
    PUBMED_ESEARCH +
    "?" +
    new URLSearchParams({
      db: "pubmed",
      term: QUERY,
      retmode: "json",
      retmax: String(limit),
      sort: "date",
      datetype: "pdat",
      mindate: daysAgoISO(days),
      maxdate: daysAgoISO(0),
    }).toString();

  const search = await fetchJson(searchUrl);
  const ids = (search && search.esearchresult && search.esearchresult.idlist) || [];
  if (!ids.length) return { items: [], fetchedAt: daysAgoISO(0), disclaimer: DISCLAIMER };

  const summaryUrl =
    PUBMED_ESUMMARY +
    "?" +
    new URLSearchParams({ db: "pubmed", id: ids.join(","), retmode: "json" }).toString();
  const summary = await fetchJson(summaryUrl);
  const result = (summary && summary.result) || {};

  const items = ids
    .map((id) => {
      const rec = result[id];
      if (!rec) return null;
      return {
        id,
        title: rec.title || "",
        source: rec.fulljournalname || rec.source || "",
        date: rec.pubdate || "",
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      };
    })
    .filter(Boolean);

  return { items, fetchedAt: daysAgoISO(0), disclaimer: DISCLAIMER };
}

async function onLoad() {
  await pi.commands.register({
    id: "xyb.news.refresh",
    title: "小胰宝：刷新进展",
    keywords: ["进展", "资讯", "新药", "研究", "news"],
    run: async () => {
      await pi.ui.showToast("正在汇集最新进展…");
      const data = await fetchProgress({});
      return { ok: true, count: data.items.length };
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("xyb.news.refresh");
}

async function onPanelInvoke(channel, payload) {
  if (channel === "xyb.news.refresh") return fetchProgress(payload || {});
  const err = new Error(`channel not supported: ${channel}`);
  err.code = "NOT_FOUND";
  throw err;
}

module.exports = { onLoad, onUnload, onPanelInvoke, _internals: { fetchProgress, fetchJson } };