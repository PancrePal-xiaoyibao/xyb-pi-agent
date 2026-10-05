import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostSrc = await readFile(path.join(here, "../electron/main/runtime/host.ts"), "utf8");

/**
 * 生产事故回归：应用内调用 `xyb_trials_fanout` 立即失败（durationMs 0、零子调用），
 * 因为 `tools.execute` 先按全名查插件目录，查不到就直接回 TOOL_NOT_FOUND，
 * 根本没走到下方的合成工具拦截分支。
 *
 * 原缺陷形状（必须永不再出现）：
 *   } else if (!tool) { ... TOOL_NOT_FOUND ... }
 * 修复后形状：
 *   const compositeFromHost = isTrialCompositeTool(q.toolName)
 *     && plugins.getTools().some((t) => t.pluginId === TRIAL_PLUGIN_ID);
 *   } else if (!tool && !compositeFromHost) { ... TOOL_NOT_FOUND ... }
 *
 * 这些断言刻意做在源码结构上：单元测试直接调 runTrialComposite，永远绕开这条
 * 分发路径，只有结构断言能挡住这类「测试全绿但功能全死」的回归。
 */

test("合成工具缺席判定必须带 compositeFromHost 逃生口", () => {
  assert.match(
    hostSrc,
    /const compositeFromHost = isTrialCompositeTool\(q\.toolName\)[\s\S]{0,160}TRIAL_PLUGIN_ID/,
    "缺席判定必须由 isTrialCompositeTool 与「所属插件已加载」共同决定",
  );
  assert.ok(
    hostSrc.includes("} else if (!tool && !compositeFromHost) {"),
    "TOOL_NOT_FOUND 分支必须同时要求合成工具不适用",
  );
});

test("不得残留无条件把缺目录条目判成 TOOL_NOT_FOUND 的分支", () => {
  assert.doesNotMatch(
    hostSrc,
    /else if \(!tool\) \{\s*payload = \{\s*executionId[\s\S]{0,120}TOOL_NOT_FOUND/,
    "旧的 `!tool` 分支会吞掉扇出，必须已删除",
  );
});

test("合成工具拦截位于 TOOL_NOT_FOUND 之后、且先于普通工具执行", () => {
  const lookupIdx = hostSrc.indexOf("const tool = plugins.getTools().find");
  const guardIdx = hostSrc.indexOf("!tool && !compositeFromHost");
  const interceptIdx = hostSrc.indexOf("} else if (isTrialCompositeTool(q.toolName)) {");
  const plainExecIdx = hostSrc.indexOf("const result = await tool!.execute(q.args");

  assert.ok(lookupIdx > 0, "宿主应先查目录");
  assert.ok(guardIdx > lookupIdx, "缺席判定应在目录查找之后");
  assert.ok(interceptIdx > guardIdx, "拦截分支应在缺席判定之后，否则不可达");
  assert.ok(
    plainExecIdx > interceptIdx,
    "普通工具执行必须排在拦截之后，否则合成工具会落到会抛错的桩上",
  );
});

test("合成工具被拦截时不再执行插件里的抛错桩", async () => {
  const pluginSrc = await readFile(
    path.join(here, "../resources/plugins/xyb.trials/main.js"),
    "utf8",
  );
  assert.match(
    pluginSrc,
    /xyb_trials_fanout 由宿主执行/,
    "插件侧桩仍应存在：宿主是唯一实现，桩只用来暴露拦截失效",
  );
  // 宿主侧不应出现桩文案；但源码注释里会引用这句以便排查，故只检查可执行代码
  const hostCode = hostSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    hostCode.includes("由宿主执行"),
    false,
    "宿主的可执行代码不得包含桩文案，也不得把桩当实现",
  );
});

test("TRIAL_COMPOSITE_TOOL 由 pluginToolName 推导，而非手写字符串", async () => {
  const fanoutSrc = await readFile(path.join(here, "../electron/main/trial-fanout.ts"), "utf8");
  assert.match(
    fanoutSrc,
    /export const TRIAL_COMPOSITE_TOOL = pluginToolName\(TRIAL_PLUGIN_ID, "xyb_trials_fanout"\)/,
    "全名必须由与目录相同的函数推导，避免点号转下划线类错配",
  );
  assert.doesNotMatch(
    fanoutSrc,
    /export const TRIAL_COMPOSITE_TOOL = "plugin_/,
    "不得手写字面量：插件 id 中的 . 会被 sanitize 成 _",
  );
});

// ---------------------------------------------------------------------------
// `childToolName` 全名口径（同一类生产事故的第二处）
// ---------------------------------------------------------------------------
// `plugin_${pluginId}_${serverId}_${toolName}` 手拼看起来对、实际全错：
// 目录经 `pluginToolName` 登记，会把 [^a-zA-Z0-9_] 换成 `_`，于是
// `xyb.trial-sources` → `xyb_trial_sources`，`veeva-ctv` → `veeva_ctv`。
// 五个来源因此全部匹配不到，扇出把「工具已加载且可用」报成
// `TOOL_UNAVAILABLE / 当前会话中不可用`（生产实测 0/5 覆盖）。
// 测试当年没挡住，是因为假目录用同一个错字符串构造，两个错误互相印证。
test("childToolName 必须与目录登记口径一致（pluginToolName）", async () => {
  const { childToolName } = await import("../electron/main/trial-sources.ts");
  const { pluginToolName } = await import("@pi-desktop/plugin-sdk");

  const pluginId = "xyb.trial-sources";
  const cases = [
    { source: { pluginId, serverId: null, toolName: "clinicaltrials_gov_search" } },
    { source: { pluginId, serverId: "chictr", toolName: "search_trials" } },
    { source: { pluginId, serverId: "veeva-ctv", toolName: "search_trials" } },
    { source: { pluginId, serverId: "chinadrugtrials", toolName: "search_trials" } },
    { source: { pluginId, serverId: "who-ictrp", toolName: "ictrp_search" } },
  ];

  for (const { source } of cases) {
    // 目录侧的真实算法：pluginMcpToolKey(serverId, toolName) → pluginToolName
    const localKey = source.serverId
      ? `${source.serverId}_${source.toolName}`
      : source.toolName;
    const catalogName = pluginToolName(pluginId, localKey);
    assert.equal(
      childToolName(source),
      catalogName,
      `${source.serverId ?? "(builtin)"} 的全名必须等于目录登记名`,
    );
    assert.doesNotMatch(
      childToolName(source),
      /[.\-]/,
      "登记名里不得残留点号或连字符：它们已被 sanitize 成下划线",
    );
  }

  // 明确的负例：旧的手拼形状必须不再产生
  assert.notEqual(
    childToolName({ pluginId, serverId: "who-ictrp", toolName: "ictrp_search" }),
    "plugin_xyb.trial-sources_who-ictrp_ictrp_search",
    "不得回到手拼（点号/连字符未转义）的旧形状",
  );
});
