# XYB 审计 F5：许可证与分发风险记录

版本：v1.0
状态：**风险记录**（不构成合规结论；不得据此宣称"已合规"）
基线：`0a0223170e75f17b9747b82a046b03d076813cfe`（BASELINE_MAIN）
分支：`fix/xyb-records-audit-main`

## 一、审计声称

README 自述本仓基于 `vastsa/PI-Desktop`（LGPL-3.0），并引入来自 `opencare-skillhub` 的外置技能，其中 `graphify-xiaoyibao` 为 AGPL-3.0；README 说明该技能为独立重写、无上游内联代码，但"若公开分发 AGPL 条款将适用"。属合规注意点，非功能缺陷。

## 二、本次核验的事实（只读）

### 2.1 本仓许可证

- `LICENSE` 文件首行：`GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007`。
- `README.md:980-984`：「PI-Desktop is licensed under the **GNU Lesser General Public License v3.0**.」
- `README.md:19` 的 License 徽章链接指向上游 `vastsa/PI-Desktop`。

**含义：本仓以 LGPL-3.0 授权。** LGPL-3.0 对"库"允许以其他许可组合分发，但要求：保留许可证与版权声明、修改部分需说明、提供对应源码、不得限制接收方对库部分的反向工程/替换权利。**桌面应用整体静态链接 LGPL 组件的合规判断需由维护者与法律顾问确认。**

### 2.2 外部技能与上游许可（README 表格）

| README 行 | 组件 | 许可 |
|---|---|---|
| 272 | 上游基础 `vastsa/PI-Desktop` | LGPL-3.0 |
| 276 | `opencare-skillhub/clinical-trial-matching` | 见上游仓库 |
| 277 | `opencare-skillhub/Medical-Record-Organizer` | 见上游仓库 |
| 278 | `opencare-skillhub/skill-HADS-accessment` | 见上游仓库 |
| 279 | `opencare-skillhub/graphify-xiaoyibao` | **AGPL-3.0** |

`README.md:282-284` 自述：外部技能受各自仓库许可约束；`graphify-xiaoyibao` 为 AGPL-3.0（强 copyleft），此处技能为**独立重写、未内联上游代码**，但**若项目公开分发，AGPL 条款将适用**。

### 2.3 仓库内更详细的许可核查结论（`XYB-SKILLHUB.md`）

该文档记录了逐仓库许可核查（非依据仓库简介）：

- `XYB-SKILLHUB.md:55`：**AGPL-3.0** —— `graphify-xiaoyibao`、`openclaw-backup-restore-ops`、`wechat-article-downloader`。
- `XYB-SKILLHUB.md:56,60`：**18 个仓库无 LICENSE**，按默认即「保留所有权利」，严格讲**不满足再分发的明确授权**；其中包含最重要的患者向候选。
- `XYB-SKILLHUB.md:70-72`：AGPL-3.0 是强 copyleft；`wechat-article-downloader` 已排除；**AGPL 的传染性意味着分发含它的客户端，整体要按 AGPL 开源**。
- `XYB-SKILLHUB.md:217-220`：待办 —— 给无 LICENSE 的仓库补许可（尤其 `Medical-Record-Organizer`、`clinical-trial-matching`）；AGPL-3.0 的分发策略：`graphify-xiaoyibao` 已接入，**仓库当前是 PRIVATE，暂不构成分发；一旦转公开、或对外分发含此技能的产物，整体需按 AGPL 处理**。

### 2.4 插件目录的许可证文件现状

| 插件 | LICENSE 文件 |
|---|---|
| `pi.file-manager` | 有 |
| `pi.browser`、`xyb.assistants`、`xyb.news`、`xyb.records`、`xyb.skillpack`、`xyb.trial-sources`、`xyb.trials` | **无** |

注：插件缺独立 LICENSE 文件不等于违规（可被根 LICENSE 覆盖），但对外分发时**来源与许可的可追溯性**会因此减弱。`XYB-SKILLHUB.md:144` 已要求「每个技能头部写明上游仓库、许可、适配方式」，`xyb.skillpack` 采用 `source_license:` 字段标注。

## 三、风险条目

| # | 风险 | 影响 | 触发条件 |
|---|---|---|---|
| R1 | 根仓 LGPL-3.0 义务 | 需保留声明、提供对应源码、不得限制库部分替换 | 任何形式分发 |
| R2 | `graphify-xiaoyibao` AGPL-3.0 传染性 | 分发含该技能的产物**整体需按 AGPL 处理** | 转公开或对外分发 |
| R3 | 18 个上游仓库无 LICENSE | 默认「保留所有权利」，**不满足再分发明确授权** | 分发含这些技能的内容 |
| R4 | 7 个插件目录无独立 LICENSE | 来源许可可追溯性弱 | 对外分发 |
| R5 | `Medical-Record-Organizer` 已列入"待补许可" | 若后续集成需先确认其许可 | 集成前 |

## 四、F5 最终判定

- **状态：非阻断跟踪 / 风险记录**
- 本条**不是功能缺陷**，不阻断本次 F1／F2 修复与本地验证（用户已确认"未完成的许可审查不必须阻塞公开发布"）。
- **本记录不宣称合规**。R1–R5 的最终处置（许可证选择、AGPL 隔离策略、补许可、是否公开分发）**属项目维护者与法律顾问的决策**，不在本次实现范围。
- 未修改任何许可证文件，未改变分发形态。

## 五、解除风险所需的最小动作（供维护者决策）

1. 明确最终开源许可证与分发形态（决定 R1／R2 的适用性）。
2. 对 AGPL-3.0 技能做**进程/仓库隔离**或明确接受 AGPL 传染（R2）。
3. 为无 LICENSE 的上游补授权或替换为有明确许可的等价实现（R3）。
4. 统一在各插件目录补 `LICENSE` 或 `source_license` 标注（R4）。
5. 集成 `Medical-Record-Organizer` 前先确认其许可（R5，属 Amendment B-2 前置条件）。

## 六、复核命令（可原样执行）

```bash
head -3 LICENSE
sed -n '980,984p' README.md
sed -n '270,285p' README.md
grep -n -i "AGPL\|无 LICENSE\|保留所有权利\|PRIVATE" XYB-SKILLHUB.md
for f in apps/desktop/resources/plugins/*/; do echo "$(basename $f) -> $(ls $f | grep -i '^license' | head -1 || echo none)"; done
```

## 七、回滚

本记录为纯文档，回滚方式为删除本文件。未改动任何许可证、依赖或分发配置。
