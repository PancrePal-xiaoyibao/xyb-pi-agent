/**
 * xyb.news 数据源取数回归测试。
 *
 * 这个文件存在的理由：`xyb.news/main.js` 曾经按 web `Response` 的形态使用宿主的
 * `pi.net.fetch` —— `if (!res.ok)` + `return res.json()`。而宿主返回的是**普通对象**
 * `{ status, headers, bodyText }`（见 apps/desktop/electron/main/plugin-runtime.ts:339
 * 的服务签名与 :5612 的返回语句），既没有 `ok` 也没有 `.json()`。
 *
 * 后果：`res.ok` 恒为 `undefined`（falsy）→ **每一次**刷新都在同一行抛错，
 * 且被归因为 `NETWORK`「数据源请求失败」，看起来像断网。实测 PubMed 返回的是 HTTP 200。
 *
 * 因此这里的 fake `pi.net.fetch` **必须**复刻真实宿主形态。假体一旦比被测代码宽松，
 * 就等于没测——这正是本缺陷当初能通过测试的原因。
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "resources", "plugins", "xyb.news", "main.js");

/** 真实宿主形态：普通对象，无 ok、无 json()。 */
const hostReply = (status, body) => ({
  status,
  headers: { "content-type": "application/json" },
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

function loadPlugin(fetchReply) {
  const calls = { fetches: [] };
  const pi = {
    plugin: { getSettings: async () => ({}) },
    ui: { showToast: async () => {} },
    commands: { register: async () => {}, unregister: async () => {} },
    net: {
      fetch: async (input) => {
        calls.fetches.push(input);
        if (fetchReply instanceof Error) throw fetchReply;
        // 按 URL 分发，让「先 esearch 再 esummary」两步各自得到合适的响应。
        if (typeof fetchReply === "function") return fetchReply(input);
        return fetchReply;
      },
    },
  };
  const prev = globalThis.pi;
  globalThis.pi = pi;
  delete require.cache[require.resolve(MAIN)];
  const mod = require(MAIN);
  const restore = () => {
    if (prev === undefined) delete globalThis.pi;
    else globalThis.pi = prev;
    delete require.cache[require.resolve(MAIN)];
  };
  return { mod, calls, restore };
}

const ESEARCH_BODY = { esearchresult: { idlist: ["40123456"] } };
const ESUMMARY_BODY = {
  result: {
    uids: ["40123456"],
    "40123456": {
      title: "IBI343 in pancreatic cancer",
      pubdate: "2026 Sep",
      source: "J Clin Oncol",
      authors: [{ name: "Zhang Y" }],
    },
  },
};

/** 真实调用的两步响应：esearch 拿 id，esummary 拿条目。 */
const twoStepReply = (input) =>
  hostReply(200, /esummary/i.test(input.url) ? ESUMMARY_BODY : ESEARCH_BODY);

test("回归：宿主形态 {status,headers,bodyText} 下刷新成功并解析出条目", async () => {
  const { mod, restore } = loadPlugin(twoStepReply);
  try {
    const res = await mod._internals.fetchProgress({ days: 30, limit: 20 });
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].title, "IBI343 in pancreatic cancer");
    assert.match(res.disclaimer, /不构成医疗建议/);
  } finally {
    restore();
  }
});

test("回归：esearch 返回空 idlist 时不得抛错，应返回空清单", async () => {
  const { mod, restore } = loadPlugin(() => hostReply(200, { esearchresult: { idlist: [] } }));
  try {
    const res = await mod._internals.fetchProgress({});
    assert.deepEqual(res.items, []);
  } finally {
    restore();
  }
});

test("回归：fetchJson 必须真的读到 bodyText（不是靠 res.json()）", async () => {
  const { mod, restore } = loadPlugin(hostReply(200, { hello: "世界" }));
  try {
    const data = await mod._internals.fetchJson("https://eutils.ncbi.nlm.nih.gov/x");
    assert.deepEqual(data, { hello: "世界" });
  } finally {
    restore();
  }
});

test("HTTP 500：报 UPSTREAM_ERROR 并带状态码，不得谎报网络问题", async () => {
  const { mod, restore } = loadPlugin(hostReply(500, {}));
  try {
    await assert.rejects(
      () => mod._internals.fetchJson("https://eutils.ncbi.nlm.nih.gov/x"),
      (err) => {
        assert.equal(err.code, "UPSTREAM_ERROR");
        assert.equal(err.status, 500);
        assert.match(err.message, /HTTP 500/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("HTTP 429：报 RATE_LIMITED，提示指向限流而非断网", async () => {
  const { mod, restore } = loadPlugin(hostReply(429, {}));
  try {
    await assert.rejects(
      () => mod._internals.fetchJson("https://eutils.ncbi.nlm.nih.gov/x"),
      (err) => {
        assert.equal(err.code, "RATE_LIMITED");
        assert.equal(err.status, 429);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("没有响应（宿主重启/断网）：报 NETWORK 且状态码为 0", async () => {
  const { mod, restore } = loadPlugin(undefined);
  try {
    await assert.rejects(
      () => mod._internals.fetchJson("https://eutils.ncbi.nlm.nih.gov/x"),
      (err) => {
        assert.equal(err.code, "NETWORK");
        assert.equal(err.status, 0);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("bodyText 不是合法 JSON：报 UPSTREAM_ERROR，不得归因于网络", async () => {
  const { mod, restore } = loadPlugin(hostReply(200, "<html>nope</html>"));
  try {
    await assert.rejects(
      () => mod._internals.fetchJson("https://eutils.ncbi.nlm.nih.gov/x"),
      (err) => {
        assert.equal(err.code, "UPSTREAM_ERROR");
        assert.match(err.message, /不是合法 JSON/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("不同失败原因必须给出彼此不同的信息", async () => {
  const messages = [];
  for (const reply of [hostReply(500, {}), hostReply(429, {}), hostReply(404, {}), undefined]) {
    const { mod, restore } = loadPlugin(reply);
    try {
      await assert.rejects(
        () => mod._internals.fetchJson("https://eutils.ncbi.nlm.nih.gov/x"),
        (err) => {
          messages.push(err.message);
          return true;
        },
      );
    } finally {
      restore();
    }
  }
  assert.equal(new Set(messages).size, messages.length, "不同原因必须给出不同提示");
});
