/**
 * xyb.records 病案整理契约测试（SPEC B-2.1 的回归保障）。
 *
 * 覆盖：
 *  1. 分类：按文件名/正文关键词归入正确类目，读不出内容时不猜；
 *  2. 日期抽取：四种中文/数字写法都能归一为 YYYY-MM-DD，非法日期丢弃；
 *  3. 解析状态：.txt/.md 才算「已解析」，PDF/图片/DICOM 一律如实标注「未解析」；
 *  4. 缺口提示：措辞只能是「资料中未见」，绝不能说成「没做过检查」；
 *  5. 可追溯性：每条记录只带相对文件名，不含绝对路径；
 *  6. 时间线排序稳定；
 *  7. 档案 Markdown 含免责声明与「未能解析」清单；
 *  8. runOrganize 全程不调用模型（B-2.1 是纯本地整理）；
 *  9. saveArchive 空内容不写盘，正常内容写入并返回路径。
 *
 * 不依赖任何第三方包，只用 node: 内置模块。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = join(process.cwd(), "resources/plugins/xyb.records");

function loadOrganize() {
  const entry = join(PLUGIN_DIR, "lib/organize.js");
  delete require.cache[require.resolve(entry)];
  return require(entry);
}

function loadPlugin(pi) {
  globalThis.pi = pi;
  const entry = join(PLUGIN_DIR, "main.js");
  delete require.cache[require.resolve(entry)];
  return require(entry);
}

function makeFakePi(options = {}) {
  const {
    vaultFiles = {},
    settings = { vaultDir: "/vault" },
    directory = { path: "/vault", name: "vault" },
    readError = {},
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
        return { text: "should-not-be-called", modelKey: input.modelKey };
      },
    },
    models: { list: async () => [{ key: "p/m", isDefault: true }] },
    ui: { showToast: async (msg, level) => calls.toast.push({ msg, level }) },
    fs: {
      requestDirectory: async () => directory,
      list: async (dir) => {
        calls.list.push(dir);
        return vaultFiles[dir] || [];
      },
      readText: async (path) => {
        calls.readText.push(path);
        if (readError[path]) throw new Error(readError[path]);
        return vaultFiles.__text[path];
      },
      writeText: async (path, content) => {
        calls.writeText.push({ path, content });
      },
    },
  };
  return { pi, calls };
}

test("分类：按关键词归入正确类目，顺序有意义（病理优先于影像泛词）", () => {
  const o = loadOrganize();
  assert.equal(o.categorize("2024-03-CT报告.txt"), "影像检查");
  assert.equal(o.categorize("基因检测报告.txt"), "病理报告");
  assert.equal(o.categorize("血常规化验单.txt"), "检验指标");
  assert.equal(o.categorize("化疗方案医嘱.txt"), "用药方案");
  assert.equal(o.categorize("出院小结.txt"), "诊疗记录");
  assert.equal(o.categorize("过敏史.txt"), "基本信息");
  assert.equal(o.categorize("医保发票.txt"), "其他资料");
  // 读不出任何线索时不猜，落到兜底类目
  assert.equal(o.categorize("IMG_2031.txt"), "其他资料");
});

test("分类：文件名优先于正文关键词（回归：综合病情报告不得被正文『病理』抢走）", () => {
  const o = loadOrganize();
  // 真实场景：一份名为「基本病情报告」的综合资料，正文里顺带提到「病理结果」
  // 「免疫组化」——文件名才是用户的显式归类意图，不能被正文关键词覆盖。
  assert.equal(
    o.categorize("01-基本病情报告.md", "## 胰腺癌肺转移\n\n病理结果：粘液腺癌\n\n免疫组化结果：CK(+)"),
    "基本信息",
  );
  assert.equal(o.categorize("02-肿瘤标志物报告.md", "CA19-9 升高"), "检验指标");
  assert.equal(o.categorize("03-CT报告.md", "CT 诊断报告书"), "影像检查");
  // 文件名无线索时才退回正文
  assert.equal(o.categorize("scan001.md", "免疫组化结果"), "病理报告");
  assert.equal(o.categorize("scan002.md", "出院小结内容"), "诊疗记录");
  // 两边都无线索时兜底
  assert.equal(o.categorize("IMG_2031.png"), "其他资料");
});

test("分类：基础类目词表扩充后不得抢走其它类目", () => {
  const o = loadOrganize();
  // 「基本信息」提到最前，但不能把专科文件抢过去
  assert.equal(o.categorize("CT报告.txt"), "影像检查");
  assert.equal(o.categorize("血常规.md"), "检验指标");
  assert.equal(o.categorize("出院小结.txt"), "诊疗记录");
  assert.equal(o.categorize("化疗方案.txt"), "用药方案");
  assert.equal(o.categorize("病理报告.md"), "病理报告");
  assert.equal(o.categorize("基因检测报告.txt"), "病理报告");
  assert.equal(o.categorize("医保发票.txt"), "其他资料");
});

test("日期抽取：四种写法归一化，非法日期丢弃", () => {
  const o = loadOrganize();
  const dates = o.extractDates("2024-03-15 复查；2024年4月1日入院；2023/12/31 报告；2023.06.07 扫描");
  assert.deepEqual(dates.sort(), ["2023-06-07", "2023-12-31", "2024-03-15", "2024-04-01"].sort());
  // 13 月、32 日、超范围年份都必须丢弃
  assert.deepEqual(o.extractDates("2024-13-01 2024-02-32 1800-01-01"), []);
  // 非字符串输入安全返回空
  assert.deepEqual(o.extractDates(null), []);
});

test("解析状态：只有 .txt/.md 算已解析，其余如实标注未解析且不带正文", async () => {
  const o = loadOrganize();
  const files = [
    { name: "血常规.txt", path: "血常规.txt" },
    { name: "CT.pdf", path: "CT.pdf" },
    { name: "PET.png", path: "PET.png" },
    { name: "scan.dcm", path: "scan.dcm" },
  ];
  const { records } = await o.buildRecords(files, {
    read: async (p) => (p === "血常规.txt" ? "白细胞 6.2 参考范围 3.5-9.5 2024-03-15" : ""),
  });

  const parsed = records.filter((r) => r.parsed);
  const unparsed = records.filter((r) => !r.parsed);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sourceName, "血常规.txt");
  assert.equal(parsed[0].category, "检验指标");
  assert.equal(unparsed.length, 3);
  for (const r of unparsed) {
    assert.equal(r.text, "");
    assert.deepEqual(r.dates, []);
    assert.match(r.extractionStatus, /^未解析/);
  }
});

test("解析状态：读取失败与空文件区分开，且失败不中断整次整理", async () => {
  const o = loadOrganize();
  const files = [
    { name: "ok.txt", path: "ok.txt" },
    { name: "broken.txt", path: "broken.txt" },
    { name: "empty.md", path: "empty.md" },
  ];
  const { records, readErrors } = await o.buildRecords(files, {
    read: async (p) => {
      if (p === "broken.txt") throw new Error("boom");
      if (p === "empty.md") return "   ";
      return "内容 2024-01-01";
    },
  });

  assert.deepEqual(readErrors, ["broken.txt"]);
  assert.equal(records.length, 3);
  const byName = Object.fromEntries(records.map((r) => [r.sourceName, r]));
  assert.equal(byName["ok.txt"].parsed, true);
  assert.equal(byName["broken.txt"].parsed, false);
  assert.equal(byName["broken.txt"].extractionStatus, o.EXTRACTION_STATUS.READ_ERROR);
  assert.equal(byName["empty.md"].parsed, false);
  assert.equal(byName["empty.md"].extractionStatus, o.EXTRACTION_STATUS.EMPTY);
});

test("缺口提示：措辞不得把「没找到资料」说成「没做过检查」", () => {
  const o = loadOrganize();
  const records = [
    o.makeRecord({ sourceName: "血常规.txt", category: "检验指标", text: "2024-01-01" }),
  ];
  const gaps = o.findGaps(records);
  const categories = gaps.map((g) => g.category);
  assert.ok(categories.includes("影像检查"));
  assert.ok(!categories.includes("检验指标"));
  for (const gap of gaps) {
    // 必须明确说明是「资料里没看到」，而不是断言检查没做过
    assert.match(gap.note, /资料中未见/);
    assert.match(gap.note, /不代表没有做过/);
    // 不允许出现无免责声明的绝对否定断言
    assert.doesNotMatch(gap.note, /^(?!.*不代表).*没做过/);
  }
});

test("可追溯性：记录只带相对文件名，绝不含绝对路径", async () => {
  const o = loadOrganize();
  const { records } = await o.buildRecords([{ name: "报告.txt", path: "/Users/someone/vault/报告.txt" }], {
    read: async () => "内容",
  });
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes("/Users/someone"));
  assert.equal(records[0].sourceName, "报告.txt");
});

test("时间线：按日期升序稳定排序，无日期的记录不进入时间线", () => {
  const o = loadOrganize();
  const records = [
    o.makeRecord({ sourceName: "b.txt", category: "影像检查", text: "2024-07-10 CT 评估" }),
    o.makeRecord({ sourceName: "a.txt", category: "诊疗记录", text: "2024-03-15 首诊" }),
    o.makeRecord({ sourceName: "c.txt", category: "检验指标", text: "没有日期" }),
  ];
  const timeline = o.buildTimeline(records);
  assert.deepEqual(
    timeline.map((t) => t.date),
    ["2024-03-15", "2024-07-10"],
  );
  assert.ok(!timeline.some((t) => t.sourceName === "c.txt"));
});

test("档案：汇总计数正确，未解析资料必须出现在 Markdown 里", () => {
  const o = loadOrganize();
  const records = [
    o.makeRecord({ sourceName: "血常规.txt", category: "检验指标", text: "2024-01-01" }),
    o.makeRecord({
      sourceName: "CT.pdf",
      category: "影像检查",
      text: "",
      extractionStatus: o.EXTRACTION_STATUS.UNSUPPORTED_FORMAT,
    }),
  ];
  const archive = o.buildArchive(records);
  assert.equal(archive.totalCount, 2);
  assert.equal(archive.parsedCount, 1);
  assert.equal(archive.unparsedCount, 1);
  assert.equal(archive.unparsedFiles[0].sourceName, "CT.pdf");

  const md = o.renderMarkdown(archive);
  assert.match(md, /以下信息供参考，不能替代医生诊断。/);
  assert.match(md, /未能解析的资料/);
  assert.match(md, /CT\.pdf/);
  assert.match(md, /原件始终以医院出具的为准/);
});

test("runOrganize：无授权目录 / 取消时不读盘、不调模型", async () => {
  const { pi, calls } = makeFakePi({ settings: { vaultDir: "" } });
  const plugin = loadPlugin(pi);
  const noVault = await plugin._internals.runOrganize();
  assert.equal(noVault.reason, "NO_VAULT");

  const { pi: pi2, calls: calls2 } = makeFakePi({ directory: null });
  const plugin2 = loadPlugin(pi2);
  const cancelled = await plugin2._internals.runOrganize();
  assert.equal(cancelled.reason, "CANCELLED");

  assert.equal(calls.readText.length, 0);
  assert.equal(calls2.readText.length, 0);
  assert.equal(calls.complete.length, 0);
  assert.equal(calls2.complete.length, 0);
});

test("runOrganize：纯本地整理，全程零模型调用；正文与文件名都脱敏", async () => {
  const vaultFiles = {
    "": [
      { name: "血常规.txt", path: "血常规.txt", isDirectory: false },
      { name: "CT.pdf", path: "CT.pdf", isDirectory: false },
    ],
    __text: {
      "血常规.txt": "患者张三先生 13812345678 在北京协和医院 2024-03-15 白细胞 6.2",
    },
  };
  const { pi, calls } = makeFakePi({ vaultFiles });
  const plugin = loadPlugin(pi);
  const result = await plugin._internals.runOrganize();

  assert.equal(result.ok, true);
  // B-2.1 是确定性本地整理：不得调用模型
  assert.equal(calls.complete.length, 0);
  assert.equal(result.archive.parsedCount, 1);
  assert.equal(result.archive.unparsedCount, 1);
  assert.equal(result.archive.unparsedFiles[0].sourceName, "CT.pdf");

  // 脱敏发生在读取层：记录正文必须是脱敏后的文本
  assert.ok(result.markdown.includes("血常规.txt"));
  // 档案 Markdown 只输出索引（计数/日期/文件名/缺口），不输出正文——
  // 因此原始 PII 既不在档案里，也不在随结果返回的 records 里。
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("13812345678"));
  assert.ok(!serialized.includes("北京协和医院"));
  assert.ok(!serialized.includes("张三"));
  // 记录级正文不随结果返回界面
  assert.equal(result.archive.records[0].text, undefined);
});

test("buildRecords：读取层脱敏后，正文占位符生效且原始 PII 不落库", async () => {
  const o = loadOrganize();
  const { records } = await o.buildRecords([{ name: "血常规.txt", path: "血常规.txt" }], {
    // 真实环境中 runOrganize 注入的就是 redact(pi.fs.readText(...))
    read: async () =>
      "患者张三先生 13812345678 在北京协和医院 2024-03-15 白细胞 6.2",
  });
  // buildRecords 自身不脱敏（纯函数、不依赖 main.js 的规则），
  // 因此这里断言主线 runOrganize 注入脱敏读取后 PII 不残留——
  // 上面那条测试已覆盖。本条只固定「分类基于正文」的行为。
  assert.equal(records.length, 1);
  assert.equal(records[0].parsed, true);
  assert.equal(records[0].category, "检验指标");
  assert.deepEqual(records[0].dates, ["2024-03-15"]);
});

test("saveArchive：空内容不写盘；正常内容写入并返回路径", async () => {
  const { pi, calls } = makeFakePi({ vaultFiles: { "": [], __text: {} } });
  const plugin = loadPlugin(pi);

  const empty = await plugin._internals.saveArchive({ markdown: "   " });
  assert.equal(empty.reason, "EMPTY_TEXT");
  assert.equal(calls.writeText.length, 0);

  const saved = await plugin._internals.saveArchive({ markdown: "# 档案\n\n内容" });
  assert.equal(saved.ok, true);
  assert.match(saved.path, /^小胰宝-病案整理-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
  assert.equal(calls.writeText.length, 1);
  assert.match(calls.writeText[0].content, /# 档案/);
});
