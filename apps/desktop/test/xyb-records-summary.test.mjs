/**
 * xyb.records 摘要链路契约测试（F1 修复的回归保障，SPEC v8 M1）。
 *
 * 覆盖：
 *  1. runSummary() 必须真实产出摘要文本，不再是 {ok:true} 占位对象；
 *  2. 无授权目录 / 无可读文本 / 无可用模型 / 用户取消时返回结构化原因，
 *     绝不调用 agent.complete（未确认 → 零模型请求）；
 *  3. 送入模型的内容先经 redact() 脱敏，且不携带绝对路径；
 *  4. 只读取文本类资料（.txt/.md），二进制/图片只计为「未解析」；
 *  5. 单文件与总字符预算生效，截断如实标注；
 *  6. 模型返回文本原样进入结果，附 sourceCount/skippedCount/modelKey。
 *
 * 不依赖任何第三方包，只用 node: 内置模块，可在无 node_modules 的
 * 独立 worktree 中运行。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = join(process.cwd(), "resources/plugins/xyb.records");

/** 每次重新加载 main.js，避免模块缓存干扰。 */
function loadPlugin(pi) {
  globalThis.pi = pi;
  const entry = join(PLUGIN_DIR, "main.js");
  delete require.cache[require.resolve(entry)];
  return require(entry);
}

/** 构造记录所有宿主调用的严格 fake pi。 */
function makeFakePi(options = {}) {
  const {
    vaultFiles = {},
    settings = {},
    models,
    completeResult,
    completeError,
    directory = { path: "/vault", name: "vault" },
  } = options;
  const calls = { complete: [], list: [], readText: [], writeText: [], toast: [] };

  const pi = {
    plugin: { getSettings: async () => settings },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: {
      registerTool: async () => {},
      unregisterTool: async () => {},
      complete: async (input) => {
        calls.complete.push(input);
        if (completeError) throw completeError;
        return (
          completeResult || {
            text: "以下信息供参考，不能替代医生诊断。\n\n① 现状：资料有限。",
            modelKey: input.modelKey,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        );
      },
    },
    models: { list: async () => models },
    ui: {
      showToast: async (message, level) => {
        calls.toast.push({ message, level });
      },
    },
    fs: {
      // 扁平 + 一层目录的虚拟文件树，够本测试用。
      list: async (pathFromRoot) => {
        calls.list.push(pathFromRoot);
        const prefix = pathFromRoot === "" ? "" : `${pathFromRoot}/`;
        const names = new Set();
        for (const key of Object.keys(vaultFiles)) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (rest) names.add(rest.split("/")[0]);
        }
        return [...names].map((name) => {
          const full = prefix + name;
          const isDirectory = !(full in vaultFiles);
          const entry = { name, path: full, isDirectory };
          if (!isDirectory) entry.size = vaultFiles[full].length;
          return entry;
        });
      },
      readText: async (pathFromRoot) => {
        calls.readText.push(pathFromRoot);
        if (!(pathFromRoot in vaultFiles)) throw new Error(`ENOENT: ${pathFromRoot}`);
        return vaultFiles[pathFromRoot];
      },
      writeText: async (path, content) => {
        calls.writeText.push({ path, content });
      },
      requestDirectory: async () => directory,
    },
  };
  return { pi, calls };
}

const DEFAULT_MODELS = [
  { key: "prov/other", label: "Other", isDefault: false },
  { key: "prov/default", label: "Default", isDefault: true },
];

test("未授权资料库时返回 NO_VAULT 且不调用模型", async () => {
  const { pi, calls } = makeFakePi({ settings: {} });
  const mod = loadPlugin(pi);
  const res = await mod._internals.runSummary();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NO_VAULT");
  assert.equal(calls.complete.length, 0, "未确认前不得发起任何模型请求");
});

test("用户取消选择目录时返回 CANCELLED 且不调用模型", async () => {
  const { pi, calls } = makeFakePi({
    settings: { vaultDir: "/vault" },
    models: DEFAULT_MODELS,
    vaultFiles: { "a.txt": "内容" },
    directory: null,
  });
  const mod = loadPlugin(pi);
  const res = await mod._internals.runSummary();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "CANCELLED");
  assert.equal(calls.complete.length, 0);
});

test("真实生成摘要：默认模型、内容脱敏、不含绝对路径、统计未解析类型", async () => {
  const { pi, calls } = makeFakePi({
    settings: { vaultDir: "/vault" },
    models: DEFAULT_MODELS,
    vaultFiles: {
      "报告.md": "患者张三 13812345678 在北京协和医院就诊",
      "化验.txt": "CA19-9 45 U/mL (2024-01-02)",
      "影像.png": "\u0000\u0001binarydata",
      "扫描件.pdf": "%PDF-1.4 fake",
    },
  });
  const mod = loadPlugin(pi);
  const res = await mod._internals.runSummary();

  assert.equal(res.ok, true, "必须真正产出摘要");
  assert.equal(typeof res.text, "string");
  assert.ok(res.text.length > 0, "摘要文本不能为空");
  assert.equal(res.modelKey, "prov/default", "必须选 isDefault 模型");
  assert.equal(res.sourceCount, 2, "只读取 2 个文本资料");
  assert.equal(res.skippedCount, 2, "png+pdf 计为未解析");
  assert.ok(res.disclaimer && res.disclaimer.length > 0, "必须带免责声明");

  assert.equal(calls.complete.length, 1);
  const sent = calls.complete[0];
  assert.equal(sent.modelKey, "prov/default");
  const payload = sent.messages.map((m) => m.content).join("\n");
  assert.ok(!payload.includes("13812345678"), "手机号必须脱敏");
  assert.ok(payload.includes("[电话]"), "手机号应替换为占位符");
  assert.ok(!payload.includes("协和医院"), "医院名必须脱敏");
  assert.ok(payload.includes("[医院]"), "医院名应替换为占位符");
  assert.ok(!payload.includes("/vault"), "不得向模型暴露绝对路径");
  assert.ok(payload.includes("CA19-9"), "正常指标内容应保留");
  assert.ok(typeof sent.system === "string" && sent.system.length > 0, "必须带固定系统提示");
});

test("无文本资料时返回 EMPTY_VAULT 且不调用模型", async () => {
  const { pi, calls } = makeFakePi({
    settings: { vaultDir: "/vault" },
    models: DEFAULT_MODELS,
    vaultFiles: { "x.png": "\u0000" },
  });
  const mod = loadPlugin(pi);
  const res = await mod._internals.runSummary();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "EMPTY_VAULT");
  assert.equal(calls.complete.length, 0);
});

test("无可用模型时返回 NO_MODEL 且不调用模型", async () => {
  const { pi, calls } = makeFakePi({
    settings: { vaultDir: "/vault" },
    models: [],
    vaultFiles: { "a.txt": "内容" },
  });
  const mod = loadPlugin(pi);
  const res = await mod._internals.runSummary();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NO_MODEL");
  assert.equal(calls.complete.length, 0);
});

test("模型调用失败时返回结构化错误而非吞掉", async () => {
  const { pi } = makeFakePi({
    settings: { vaultDir: "/vault" },
    models: DEFAULT_MODELS,
    vaultFiles: { "a.txt": "内容" },
    completeError: Object.assign(new Error("provider down"), { code: "PROVIDER_ERROR" }),
  });
  const mod = loadPlugin(pi);
  const res = await mod._internals.runSummary();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "MODEL_ERROR");
  assert.match(String(res.error), /provider down/);
});

test("超预算内容被截断并如实标注", async () => {
  const { pi } = makeFakePi({
    settings: { vaultDir: "/vault" },
    models: DEFAULT_MODELS,
    vaultFiles: { "big.txt": "x".repeat(5000) },
  });
  const mod = loadPlugin(pi);
  const res = await mod._internals.runSummary({ maxFileChars: 100, maxTotalChars: 150 });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true, "必须标注发生截断");
});

test("保存摘要：仅凭显式调用写入，文件名带时间戳", async () => {
  const { pi, calls } = makeFakePi({ settings: { vaultDir: "/vault" } });
  const mod = loadPlugin(pi);
  const empty = await mod._internals.saveSummary({ text: "   " });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "EMPTY_TEXT");
  assert.equal(calls.writeText.length, 0, "空内容不得写文件");

  const saved = await mod._internals.saveSummary({ text: "# 摘要\n内容" });
  assert.equal(saved.ok, true);
  assert.match(saved.path, /^小胰宝-病情摘要-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
  assert.equal(calls.writeText.length, 1);
  assert.equal(calls.writeText[0].content, "# 摘要\n内容");
});

test("扫描深度受限：过深目录不计入，导入行为保持兼容", async () => {
  // MAX_SCAN_DEPTH=4，实测覆盖到 3 层目录（d0/d1/d2 内的文件），第 4 层不再进入。
  const { pi, calls } = makeFakePi({
    settings: { vaultDir: "/vault" },
    models: DEFAULT_MODELS,
    vaultFiles: {
      "top.txt": "顶层",
      "d0/f1.txt": "第一层",
      "d0/d1/f2.txt": "第二层",
      "d0/d1/d2/f3.txt": "第三层",
      "d0/d1/d2/d3/f4.txt": "第四层（应被深度上限截断）",
    },
  });
  const mod = loadPlugin(pi);
  const files = await mod._internals.collectFiles();
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("top.txt"), "顶层文件必须扫描到");
  assert.ok(paths.includes("d0/d1/d2/f3.txt"), "深度上限内的文件必须扫描到");
  assert.ok(
    !paths.some((p) => p.includes("d3/")),
    `超过 MAX_SCAN_DEPTH 的文件不应被扫描到，实际：${paths.join(", ")}`,
  );

  const res = await mod._internals.runImport();
  assert.equal(typeof res.total, "number");
  assert.equal(calls.writeText.length, 1, "导入仍只写清单文件");
  assert.match(calls.writeText[0].path, /资料清单/);
});

test("脱敏：显式姓名字段被替换，且不误伤『姓名不详』这类临床表述", () => {
  const mod = loadPlugin(makeFakePi());
  const redact = mod._internals.redact;

  // 真实病历里的显式字段必须脱敏（回归：裸姓名「柏万秀」曾原样外发）
  assert.equal(redact("姓名：柏万秀"), "姓名：[姓名]");
  assert.equal(redact("姓名 柏万秀"), "姓名 [姓名]");
  assert.equal(redact("患者姓名：柏万秀"), "患者姓名：[姓名]");
  assert.equal(redact("病人姓名:柏万秀"), "病人姓名:[姓名]");
  assert.equal(redact("柏万秀女士"), "[姓名]");
  assert.equal(redact("患者：柏万秀"), "患者：[姓名]");
  assert.equal(redact("姓名：柏万秀 性别：女"), "姓名：[姓名] 性别：女");

  // 取值不是姓名时必须原样保留，否则会破坏临床语义
  assert.equal(redact("患者姓名不详"), "患者姓名不详");
  assert.equal(redact("患者姓名未知"), "患者姓名未知");
  assert.equal(redact("姓名：不详"), "姓名：不详");
  assert.equal(redact("姓名：无"), "姓名：无");
  assert.equal(redact("姓名：未提供"), "姓名：未提供");
  assert.equal(redact("姓名：保密"), "姓名：保密");
  // 「患者：」后排常是临床描述而非姓名，宁可漏脱敏也不能改坏正文
  assert.equal(redact("患者：术后第3天"), "患者：术后第3天");
  assert.equal(redact("患者：目前精神可"), "患者：目前精神可");
  assert.equal(redact("患者：无过敏史"), "患者：无过敏史");
  assert.equal(redact("患者：男，57岁"), "患者：男，57岁");
  // 正常医学文本不受影响
  assert.equal(redact("胰腺癌肺转移、腹膜转移"), "胰腺癌肺转移、腹膜转移");
  assert.equal(redact("免疫组化结果：CK(+)"), "免疫组化结果：CK(+)");
});

test("脱敏：电话/身份证/医院名仍按原规则生效", () => {
  const mod = loadPlugin(makeFakePi());
  const redact = mod._internals.redact;
  assert.equal(redact("13812345678"), "[电话]");
  assert.equal(redact("手机：13812345678"), "手机：[电话]");
  assert.equal(redact("320583198901011234"), "[身份证]");
  assert.equal(redact("昆山市中医医院"), "[医院]");
});

test("脱敏：18 位身份证不得被手机号规则抢先截断（回归）", () => {
  const mod = loadPlugin(makeFakePi());
  const redact = mod._internals.redact;
  // 身份证里含 11 位手机号形状的子串，规则顺序错了会打成「320583[电话]4」，
  // 既没遮住证件号又泄漏前 6 位地区码。
  assert.equal(redact("320583198901011234"), "[身份证]");
  assert.equal(redact("身份证：320583198901011234"), "身份证：[身份证]");
  assert.equal(redact("110101199003071234"), "[身份证]");
  assert.equal(redact("32058319890101123X"), "[身份证]");
  // 单独手机号不受影响
  assert.equal(redact("13812345678"), "[电话]");
});
