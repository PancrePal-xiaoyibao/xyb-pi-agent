# 小胰宝 · 找试验（`xyb.trials`）

按患者自身情况检索公开临床试验，给出候选清单、匹配理由与来源链接。

## 患者视角它解决什么

- 确诊后最常问的一句是"有没有新药、有没有试验"，但公开渠道分散、术语难懂
- 网上信息鱼龙混杂，无法判断哪条跟自己有关
- 想知道"为什么这条跟我有关"，而不只是拿到一堆编号

## 能力

| 能力 | 形态 | 依赖 |
|---|---|---|
| 检索公开试验 | 视图「找试验」+ 命令 | ClinicalTrials.gov API v2 |
| 助手可调工具 | `xyb_trials_search` | `agent.tool.register` |
| 匹配工作法 | 技能 `skills/trial-match.md` | `agent.prompt.inject` |

## 权限说明

| 权限 | 用途 | 风险级 |
|---|---|---|
| `ui.view` | 右侧「找试验」视图 | 低 |
| `agent.tool.register` | 注册 `xyb_trials_search` 工具供助手调用 | 高 |
| `agent.prompt.inject` | 加载"临床试验匹配"技能 | 高 |
| `net.fetch` | 访问已声明白名单域名 | 高 |
| `notify` | 检索状态提示 | 低 |

`manifest.net.domains` 白名单：`clinicaltrials.gov`、`www.chictr.org.cn`、`chinadrugtrials.org.cn`。
未列入白名单的域名一律访问不到（fail closed）。

## 边界（产品红线）

- 只做**信息检索与结构化呈现**，不做"参加/不参加"的建议
- 每条结果必须带来源链接与抓取日期
- 必须提示"是否符合入组条件由研究医生判断"

## 开发

```bash
pnpm pi-plugin check apps/desktop/resources/plugins/xyb.trials
```

## 后续（不在 MVP）

- ChiCTR 与药物临床试验登记平台的检索适配（当前仅 CT.gov 直连）
- 与 `xyb.records` 联动：档案条件自动带入检索
- 匹配评分与推理过程可视化