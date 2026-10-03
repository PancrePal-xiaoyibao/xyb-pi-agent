/**
 * 试验检索的失败语义与面板提示回归测试。
 *
 * 背景（真实故障，2026-10-03）：ClinicalTrials.gov 返回异常时，插件只抛一句
 * 「试验数据源请求失败」，面板又把它显示成「请检查网络」，于是 5xx、限流、
 * 宿主进程刚重启看起来都和断网一模一样，用户无法判断该做什么。
 *
 * 本测试锁定两点：
 *   1. main.js 抛出失败时必须带可区分的原因码（NETWORK / RATE_LIMITED /
 *      UPSTREAM_ERROR）与状态码；
 *   2. 面板的 failureText() 对不同原因给出不同且可执行的提示，未知错误也
 *      不得退回成笼统的「请检查网络」。
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "resources", "plugins", "xyb.trials");
const MAIN = join(PLUGIN_DIR, "main.js");
const VIEW = join(PLUGIN_DIR, "views", "trials.html");

/**
 * 用严格 fake pi 加载真实 main.js。fetchResponse 决定 pi.net.fetch 的行为，
 * 从而分别命中成功、HTTP 错误、限流与「没有响应」四条路径。
 */
function loadPlugin(fetchResponse) {
  const calls = { fetches: [] };
  const pi = {
    plugin: { getSettings: async () => ({}) },
    ui: { showToast: async () => {} },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async () => {}, unregisterTool: async () => {} },
    net: {
      fetch: async (input) => {
        calls.fetches.push(input);
        if (fetchResponse instanceof Error) throw fetchResponse;
        return fetchResponse;
      },
    },
  };
  const prev = globalThis.pi;
  globalThis.pi = pi;
  // 每次重新加载，避免各用例之间互相污染。
  delete require.cache[require.resolve(MAIN)];
  const mod = require(MAIN);
  const restore = () => {
    if (prev === undefined) delete globalThis.pi;
    else globalThis.pi = prev;
  };
  return { mod, calls, restore };
}

/** 取 main.js 内「搜索」工具，直接执行以获得真实的抛错语义。 */
async function searchWith(fetchResponse, args = { terms: "ibi343" }) {
  const { mod, calls, restore } = loadPlugin(fetchResponse);
  try {
    await mod.onLoad();
    // onLoad 注册的工具被 fake pi 吞掉，改为直接调用内部实现。
    const internal = mod._internals || {};
    const fn = internal.searchTrials;
    assert.equal(typeof fn, "function", "main.js 必须通过 _internals 暴露 searchTrials 以便测试");
    return await fn.call(null, args);
  } finally {
    restore();
    void mod;
    void calls;
  }
}

/** 从面板 HTML 中取出 failureText 的行为，而不是复制一份容易失同步的实现。 */
function panelFailureText() {
  const html = readFileSync(VIEW, "utf8");
  const match = html.match(/function failureText\(err\)\s*\{[\s\S]*?\n      \}/);
  assert.ok(match, "trials.html 必须保留 failureText() 供测试提取");
  // failureText 是纯函数，不引用外部状态，可安全求值。
  const factory = new Function(`${match[0]}; return failureText;`);
  return factory();
}

/**
 * 真实宿主的 `pi.net.fetch` 返回形态：**普通对象 { status, headers, bodyText }**，
 * 没有 `ok`，也没有 `.json()`。见 apps/desktop/electron/main/plugin-runtime.ts:339
 * （服务签名 `Promise<{status, headers, bodyText}>`）与 :5612（`return { status, headers, bodyText }`）。
 *
 * 这里必须用真实形态。历史上测试用的是 web `Response` 形态（`{ok, status, json()}`），
 * 于是插件里 `if (!res.ok)` + `await res.json()` 的错误写法在测试里全部通过，
 * 在应用里却 100% 失败——测试假体比被测代码更宽松，就等于没测。
 */
const hostReply = (status, body) => ({
  status,
  headers: { "content-type": "application/json" },
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

const okJson = (body) => hostReply(200, body);

test("成功响应：正常返回条目，并如实带上转译与默认病种", async () => {
  const data = {
    studies: [
      {
        protocolSection: {
          identificationModule: { nctId: "NCT07066098", briefTitle: "IBI343 Phase 3" },
          statusModule: { overallStatus: "RECRUITING" },
          designModule: { phases: ["PHASE3"] },
          conditionsModule: { conditions: ["Pancreatic Cancer"] },
          contactsLocationsModule: { locations: [{ country: "China", city: "Shanghai" }] },
        },
      },
    ],
  };
  const res = await searchWith(okJson(data));
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].id, "NCT07066098");
  assert.equal(res.items[0].url, "https://clinicaltrials.gov/study/NCT07066098");
  assert.match(res.disclaimer, /不构成医疗建议/);
});

test("HTTP 500：报 UPSTREAM_ERROR 并带上状态码，不与断网混淆", async () => {
  await assert.rejects(
    () => searchWith(hostReply(500, {})),
    (err) => {
      assert.equal(err.code, "UPSTREAM_ERROR");
      assert.equal(err.status, 500);
      assert.match(err.message, /HTTP 500/);
      return true;
    },
  );
});

test("HTTP 429：报 RATE_LIMITED，提示应指向限流而非网络", async () => {
  await assert.rejects(
    () => searchWith(hostReply(429, {})),
    (err) => {
      assert.equal(err.code, "RATE_LIMITED");
      return true;
    },
  );
});

test("没有响应（宿主重启/断网）：报 NETWORK 且说明可能原因", async () => {
  await assert.rejects(
    () => searchWith(undefined),
    (err) => {
      assert.equal(err.code, "NETWORK");
      assert.equal(err.status, 0);
      assert.match(err.message, /插件进程刚重启|网络不通/);
      return true;
    },
  );
});

test("面板提示：不同失败原因给出不同且可执行的文案", () => {
  const failureText = panelFailureText();

  const network = failureText({ code: "NETWORK" });
  assert.match(network, /连不上|网络/);

  const limited = failureText({ code: "RATE_LIMITED" });
  assert.match(limited, /限制|频率/);

  const upstream = failureText({ code: "UPSTREAM_ERROR" });
  assert.match(upstream, /不是你的网络问题/);

  const crashed = failureText({ code: "PLUGIN_CRASHED" });
  assert.match(crashed, /重启|再点一次/);

  const noSource = failureText({ code: "NO_SOURCE" });
  assert.match(noSource, /设置/);

  // 关键回归：四类失败的文案必须彼此不同，否则又回到「都一样」的旧问题。
  const all = [network, limited, upstream, crashed, noSource];
  assert.equal(new Set(all).size, all.length, "不同失败原因必须给出不同提示");
});

test("面板提示：未知错误也要暴露原因，不得退回笼统的「请检查网络」", () => {
  const failureText = panelFailureText();
  const unknown = failureText({ code: "SOMETHING_NEW", message: "boom-detail" });
  assert.match(unknown, /SOMETHING_NEW/, "未知错误码必须显示出来");
  assert.match(unknown, /boom-detail/, "原始信息必须保留，便于排查");
  assert.doesNotMatch(unknown, /请检查网络/);
});

test("面板提示：没有任何信息时也不撒谎说是网络问题", () => {
  const failureText = panelFailureText();
  const bare = failureText({});
  assert.match(bare, /检索失败/);
  assert.doesNotMatch(bare, /请检查网络/);
});

test("面板：调用检索时显式传病种，不依赖插件默认值", () => {
  const html = readFileSync(VIEW, "utf8");
  assert.match(html, /xyb\.trials\.search/, "面板必须调用检索通道");
  assert.match(html, /condition:\s*"pancreatic cancer"/, "面板必须显式传病种");
  // 旧实现只传 terms，且把 res.ok === false 当成成功渲染。
  assert.match(html, /res\.ok === false/, "面板必须检查失败结构");
});

// —— 回归：宿主 net.fetch 的真实返回形态 ——
// 这一组用例专门锁死曾经的「假体比被测代码更宽松」缺陷：
// 宿主返回 { status, headers, bodyText }（无 ok、无 .json()），
// 插件若按 web Response 写 `if (!res.ok)` + `await res.json()`，
// 就会在**每一次**调用上抛错，并被误报成 NETWORK。

test("回归：宿主形态 {status,headers,bodyText} 且 HTTP 200 必须解析成功", async () => {
  const body = {
    studies: [
      {
        protocolSection: {
          identificationModule: { nctId: "NCT07415525", briefTitle: "IBI343 胰腺癌" },
          statusModule: { overallStatus: "NOT_YET_RECRUITING" },
          designModule: { phases: ["PHASE2"] },
        },
      },
    ],
  };
  const res = await searchWith(hostReply(200, body));
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].id, "NCT07415525");
  assert.equal(res.items[0].status, "NOT_YET_RECRUITING");
});

test("回归：宿主返回体必须真的被读一次（不得因缺少 ok 就提前抛错）", async () => {
  const { mod, restore } = loadPlugin(hostReply(200, { studies: [] }));
  try {
    const tool = mod._internals.searchTrials;
    const res = await tool({ condition: "pancreatic cancer", terms: "ibi343" });
    assert.deepEqual(res.items, [], "HTTP 200 + 空 studies 应返回空数组而不是抛错");
  } finally {
    restore();
  }
});

test("回归：bodyText 不是合法 JSON 时报 UPSTREAM_ERROR，不得谎报网络问题", async () => {
  await assert.rejects(
    () => searchWith(hostReply(200, "<html>not json</html>")),
    (err) => {
      assert.equal(err.code, "UPSTREAM_ERROR");
      assert.match(err.message, /不是合法 JSON/);
      assert.notEqual(err.code, "NETWORK");
      return true;
    },
  );
});

test("回归：既无 bodyText 也无 json() 时报 UPSTREAM_ERROR 并说明原因", async () => {
  await assert.rejects(
    () => searchWith({ status: 200, headers: {} }),
    (err) => {
      assert.equal(err.code, "UPSTREAM_ERROR");
      assert.match(err.message, /无法解析/);
      return true;
    },
  );
});

test("回归：读取失败原因必须带状态码，200 与 500 不得给出同一句提示", async () => {
  const seen = [];
  for (const status of [500, 429, 404]) {
    await assert.rejects(
      () => searchWith(hostReply(status, {})),
      (err) => {
        seen.push(err.message);
        assert.equal(err.status, status);
        assert.match(err.message, new RegExp(`HTTP ${status}`));
        return true;
      },
    );
  }
  assert.equal(new Set(seen).size, seen.length, "不同状态码必须给出不同信息");
});
