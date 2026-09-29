# 小胰宝 · 看进展（`xyb.news`）

汇集胰腺癌药物与研究进展的公开条目，只列标题、来源、时间与原文链接。

## 患者视角它解决什么

- 信息太多太杂，不知道哪些跟自己有关
- 想看原文又不知道从哪进
- 治疗期间没精力追文献，只想快速扫一眼有没有新东西

## 能力

| 能力 | 形态 | 依赖 |
|---|---|---|
| 列出近期进展条目 | 视图「看进展」+ 命令 `xyb.news.refresh` | PubMed E-utilities |
| 点开原文 | 视图内链接 | `shell.openExternal` |

## 权限说明

| 权限 | 用途 | 风险级 |
|---|---|---|
| `ui.view` | 右侧「看进展」视图 | 低 |
| `net.fetch` | 访问 PubMed E-utilities | 高 |
| `notify` | 刷新状态提示 | 低 |

`manifest.net.domains` 白名单：`eutils.ncbi.nlm.nih.gov`、`clinicaltrials.gov`。

## 边界（产品红线）

- **只列标题与来源**，不生成疗效结论、不做药物推荐
- 每条必须可点回原文
- 必须展示抓取日期，避免用户把旧闻当新闻

## 开发

```bash
pnpm pi-plugin check apps/desktop/resources/plugins/xyb.news
```

## 后续（不在 MVP）

- 定时抓取（需 `background.service` + `bus.publish`，配合 PI-Desktop 的 automations）
- 接入 `pancreatic-cancer-dailynews-skill` 的日报产出格式
- 条目按主题分类（新药 / 试验结果 / 指南更新）