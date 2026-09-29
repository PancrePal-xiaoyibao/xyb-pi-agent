# 小胰宝 MVP 规格（最小闭环 · 纯患者）

> 决策基线（2026-09-29 锁定）：**纯患者**用户 · **最小闭环**范围 · 纯本地优先 · Logo 已获授权
> 基线框架：PI-Desktop `v0.15.10`（已改造品牌，见 [`XYB-REBRAND.md`](./XYB-REBRAND.md)）
> 目标版本：`v0.1.0-beta`

---

## 1. 一句话定义

> **患者把资料交给小胰宝 → 看得懂自己的病情 → 找得到可能适合的临床试验 → 跟得上最新进展。**

闭环判据：这四步能在一台电脑上、不登录任何账号、不依赖后端服务地走通。

---

## 2. MVP 范围（做什么 / 不做什么）

### 做（3 个插件 + 1 层基础）

| # | 能力 | 交付形态 | 验收判据 |
|---|---|---|---|
| 1 | **我的资料** | 右侧「我的资料」视图 + 归档命令 | 能把一个文件夹里的报告 PDF/照片导入本地仓库，生成一份患者可读的病情摘要（含检查指标与日期），全程不联网 |
| 2 | **找试验** | 右侧「找试验」视图 + Agent 工具 | 依据档案生成候选试验清单，每条含：试验编号、名称、招募状态、入组要点、匹配理由、来源链接与更新时间 |
| 3 | **看进展** | 右侧「看进展」视图 | 能拉取胰腺癌药物/研究进展条目，展示标题、来源、时间、原文链接 |
| 4 | **安全底座** | 全局组件 + 插件约定 | 每条 AI 医学输出带「不能替代医生诊断」标识；高风险动作（改档案/删资料）需二次确认；不采集、不上传用户资料 |

### 不做（明确划出边界，避免范围蔓延）

- ❌ 用药提醒、康复营养、心理量表（→ v0.3）
- ❌ 医生端/家属端专属功能、多角色权限
- ❌ 账号体系、云同步、远程后端
- ❌ 医院/医生推荐排名
- ❌ 任何"替代就医决策"的结论式输出

---

## 3. 三个插件的技术规格

> 全部按 PI-Desktop 官方插件规范编写（`docs/plugin-development.md`），落在
> `apps/desktop/resources/plugins/`（与内置 `pi.file-manager`、`pi.browser` 同级，随应用分发，患者零配置）。

### 3.1 `xyb.records` — 我的资料

```jsonc
// manifest 要点
{
  "id": "xyb.records",
  "contributes": {
    "views": [{ "id": "records", "title": {"zh-CN":"我的资料"}, "icon": "folder", "entry": "views/records.html" }],
    "commands": [{ "id": "xyb.records.import", "title": "小胰宝：导入资料" }],
    "skills": ["skills/patient-summary.md"],
    "settings": [
      { "key": "vaultDir", "title": "资料库位置", "type": "string", "default": "" },
      { "key": "redactBeforeAi", "title": "发给 AI 前自动隐藏姓名/电话", "type": "boolean", "default": true }
    ]
  },
  "permissions": ["ui.view", "fs.read", "fs.write", "agent.prompt.inject", "notify"],
  "fs": { "read": ["**/*"], "write": ["**/*"] }   // 根限定在用户自选 vaultDir
}
```

**最小功能**：导入（选目录/拖入）→ 本地索引（按日期+类型归类）→ 生成摘要（本地可选，接 AI 时先脱敏）。
**不做**：OCR 全量解析（MVP 用文件名/可选文本层）、自动上传。

### 3.2 `xyb.trials` — 找试验

```jsonc
{
  "id": "xyb.trials",
  "contributes": {
    "views": [{ "id": "trials", "title": {"zh-CN":"找试验"}, "icon": "target", "entry": "views/trials.html" }],
    "commands": [{ "id": "xyb.trials.search", "title": "小胰宝：按我的情况找试验" }],
    "skills": ["skills/trial-match.md"],
    "agentTools": [{ "id": "xyb_trials_search", "title": "检索临床试验", "description": "按病种与既往治疗检索 ClinicalTrials.gov / ChiCTR" }],
    "mcpServers": []
  },
  "permissions": ["ui.view", "agent.tool.register", "agent.prompt.inject", "net.fetch", "notify"],
  "net": { "domains": ["clinicaltrials.gov", "chinadrugtrials.org.cn", "www.chictr.org.cn"] }
}
```

**最小功能**：输入/继承档案条件 → 调数据源 → 出候选清单（编号/状态/入组要点/匹配理由/来源链接+更新时间）。
**硬约束**：必须展示来源与更新时间；必须提示"是否符合入组条件需由研究医生判断"；不得给"你应该参加 X"式结论。

### 3.3 `xyb.news` — 看进展

```jsonc
{
  "id": "xyb.news",
  "contributes": {
    "views": [{ "id": "news", "title": {"zh-CN":"看进展"}, "icon": "book", "entry": "views/news.html" }],
    "commands": [{ "id": "xyb.news.refresh", "title": "小胰宝：刷新进展" }],
    "services": [{ "id": "fetcher", "label": "进展抓取服务" }],
    "bus": { "publish": ["xyb.news.updated"], "subscribe": [] }
  },
  "permissions": ["ui.view", "net.fetch", "notify", "background.service", "bus.publish"],
  "net": { "domains": ["pubmed.ncbi.nlm.nih.gov", "clinicaltrials.gov"] }
}
```

**最小功能**：进来 → 抓取/读取缓存 → 列表（标题/来源/时间/链接）→ 点开原文。
**MVP 可先做「手动刷新」，定时任务留 v0.2。**
**硬约束**：只列来源条目，不生成"疗效结论"；每条必须可点回原文。

---

## 4. 安全底座（患者产品的生命线）

| 项 | 做法 | 落点 |
|---|---|---|
| 免责声明 | 所有医学输出的固定前缀："以下信息供参考，不能替代医生诊断" | 插件共享组件 `views/_shared/disclaimer.html` + 技能文档约定 |
| 本地优先 | 档案只存本地目录；MVP 无账号、无云端 | 插件 `fs` 作用域限定在用户自选目录 |
| 发送前脱敏 | 姓名/电话/身份证/医院名在送模型前替换为占位符 | `settings.redactBeforeAi`，默认开 |
| 高风险确认 | 删资料、覆盖摘要、清空索引 | 走 `agent.tool.register` 时标注需确认 + UI 二次弹窗 |
| 来源可溯 | 试验/资讯每条带来源 URL + 更新时间 | 视图与技能输出格式强制字段 |
| 不越界 | 不出诊断、不给用药建议、不做医院排名 | 技能文档 `skills/*.md` 里写明禁止项 |

---

## 5. 目录骨架（✅ 已生成并通过本地校验）

```
apps/desktop/resources/plugins/
├── xyb.records/
│   ├── manifest.json          权限/贡献点/设置
│   ├── main.js                生命周期 + 命令 + onPanelInvoke
│   ├── views/records.html     右侧「我的资料」视图
│   ├── skills/patient-summary.md   给 Agent 的摘要技能
│   └── README.md
├── xyb.trials/
│   ├── manifest.json
│   ├── main.js                含 agentTool 注册 + net.fetch 检索
│   ├── views/trials.html
│   ├── skills/trial-match.md
│   └── README.md
└── xyb.news/
    ├── manifest.json
    ├── main.js                PubMed E-utilities 抓取
    ├── views/news.html
    └── README.md
```

**本地校验（零依赖，可立即运行）**：

```bash
node scripts/xyb-check-plugins.mjs          # 检查全部 xyb.* 插件
node scripts/xyb-check-plugins.mjs apps/desktop/resources/plugins/xyb.trials   # 单个
```

检查项：必需字段、权限名合法性、视图 icon token、入口文件存在性、`net.fetch` 是否配了域名白名单。
当前结果：**3/3 通过**（提示项为高风险权限告警，属预期）。

装好依赖后还需跑官方校验：`pnpm pi-plugin check <插件目录>`（需先 `pnpm install` + 构建 devkit）。

---

## 6. 验收清单（v0.1.0-beta 出门条件）

- [ ] 三个视图能从右侧工作面板打开，界面无 emoji、配色沿用薄荷绿
- [ ] 「我的资料」能把一个测试文件夹导入并生成摘要（断网可完成索引）
- [ ] 「找试验」能返回 ≥1 条真实试验，含编号/状态/来源链接
- [ ] 「看进展」能列出条目并可点回原文
- [ ] 每条 AI 医学输出带免责声明
- [ ] 删资料有二次确认
- [ ] `pnpm pi-plugin check` 对三个插件全部通过
- [ ] 卸载插件后本地资料不被删除（数据归用户）

---

## 7. 待验证的技术不确定项（诚实标注）

1. **新增内置插件的自动加载**：`apps/desktop/resources/plugins/` 下现有 `pi.file-manager`、`pi.browser` 两个，未在 TS 源码里找到硬编码注册，推测按目录扫描——**落地时需先跑通"新目录能被识别"再往里填功能**。
2. **Agent 工具与 MCP 的 namespace**：插件工具遵循 Agent-only 策略与命名空间规则，需实测工具名冲突行为。
3. **`fs` 作用域到用户自选目录**：`manifest.fs` 是相对 mode root 的路径，患者自选任意目录的能力需用 `pi.fs.requestDirectory` 组合实现，需实测。
4. **打包**：`.piplug` 打包与签名流程（`pi-plugin pack`）尚未在此仓库实操。

> 建议第一步：先用 `pnpm pi-plugin check apps/desktop/resources/plugins/xyb.records` 验证骨架合法，再启动应用看视图是否出现。