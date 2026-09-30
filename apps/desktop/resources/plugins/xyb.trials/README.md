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

`manifest.net.domains` 白名单：**仅 `clinicaltrials.gov`**。
未列入白名单的域名一律访问不到（fail closed）。

> **为什么只有这一个**：本插件只做 ClinicalTrials.gov 直连。
> 中国来源（ChiCTR、Veeva CTV、中国药物临床试验登记平台）由 `xyb.trial-sources`
> 插件以 MCP 服务形式承担，各有自己的出网边界，不共用本插件的白名单。
> 早先版本曾在清单里声明 `chictr.org.cn` / `chinadrugtrials.org.cn` 与一个未实现的
> `sourceChiCTR` 设置，看起来能查中国注册试验、实际什么都没发生，已删除。

## 边界（产品红线）

- 只做**信息检索与结构化呈现**，不做"参加/不参加"的建议
- 每条结果必须带来源链接与抓取日期
- 必须提示"是否符合入组条件由研究医生判断"

## 开发

```bash
pnpm pi-plugin check apps/desktop/resources/plugins/xyb.trials
```

## 后续（不在 MVP）

- 本插件自身仍只直连 CT.gov；中国来源已由 `xyb.trial-sources` 以 MCP 服务承担
- 与 `xyb.records` 联动：档案条件自动带入检索
- 匹配评分与推理过程可视化