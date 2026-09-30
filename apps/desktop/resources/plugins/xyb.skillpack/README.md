# 外部技能包（xyb.skillpack）

承载从 [opencare-skillhub](https://github.com/opencare-skillhub) 接入的**外部技能**。

完整的评估过程（37 个仓库的分类、许可矩阵、依赖画像、分批计划）见仓库根的
[`XYB-SKILLHUB.md`](../../../../XYB-SKILLHUB.md)。这里只写本插件自身。

## 为什么单独成包

不并进 `xyb.assistants` 的三个理由：

1. **来源可溯** —— 外部技能要跟着上游更新，混进自研技能里就追不回来
2. **可整包停用** —— 患者不需要时关掉一个插件即可，自研能力不受影响
3. **不稀释红线** —— 自研技能的红线（不做排名、不给入组建议、机制未披露就写未披露）
   由 `xyb.assistants` 统一保证；外部技能质量参差，混在一起会让患者分不清哪条约束管哪个技能

权限只要 `ui.view` + `agent.prompt.inject`。本插件**不发网络请求、不读写患者文件**。

## 已接入

| 技能 | 上游 | 许可 | 本机可用程度 |
|---|---|---|---|
| `trial-matching-advanced.md` | `clinical-trial-matching` v2.0.0 | 未声明 | **可完整使用** |
| `record-organizer.md` | `Medical-Record-Organizer` | 未声明 | 方法论层（需本机工具） |
| `distress-screening.md` | `skill-HADS-accessment` | 未声明 | **可完整使用**（已去公网发布） |
| `tumor-marker-trend.md` | `graphify-xiaoyibao` v0.1.0 | **AGPL-3.0** | 方法论层（上游需 `xyb` CLI） |

### 逐条说明改了什么

**trial-matching-advanced**

- 工具名改写：上游写 `mcp__chictr__search_trials` / `mcp__oncology_db__search_trials`，
  本机对应 chictr MCP 的 `search_trials` 与内置的 `xyb_trials_search`（ClinicalTrials.gov）；
  另接入了 `chinadrugtrials` MCP
- 补齐了「工具按需激活」的说明（先 `ToolSearch` 再调用）
- 8 维搜索计划、R1-R5 规则、Goals-of-Care 触发、0 匹配替代策略、输出红线**原样保留**

**record-organizer**

- 上游依赖 OCR / 语音转写脚本与 MinerU、SiliconFlow、DashScope 三个云服务密钥。
  客户端无执行外部脚本的权限，因此**只保留六步流程、11 类分类体系、时间线构建与缺口提示**，
  并在正文里写明「需要外接识别时如实说明暂不具备」
- 安全边界（不诊断、不给治疗建议、不替代医嘱）原样保留

**distress-screening**

- **移除了上游的公网发布环节**（EdgeOne 发布问卷 + PDF 导出），经确认「不发公网」。
  肿瘤患者的心理评估数据不该因为填个问卷就上网，改为全程本机、结果只留本机
- 补齐了自伤念头的**危机处理流程**（立刻停表、确认安全、给求助路径、危机指引排在最前）
- 量表结构、0-21 分口径、三档分级原样保留

**tumor-marker-trend**

- 上游靠 `xyb` CLI（`xyb process` → `graph.json` → `xyb markers-trend`）出 CSV/PNG。
  客户端无执行外部命令的权限，**本机版把趋势表整理改由对话完成**，
  并写明「上游那两条命令不要照抄给患者」——跑不起来
- 补齐解读边界：单点无意义看趋势、升高不等于进展（炎症/胆道梗阻可致假性升高）、
  CA19-9 在 Lewis 抗原阴性人群本就不表达（约 5%~10%）、AFP 也见于活动性肝病
- 明确哪些情况要**尽快联系主管医生**，不给「再观察看看」
- **许可 AGPL-3.0**：仓库当前 PRIVATE 暂不构成分发；转公开或对外分发含此技能的产物时，
  整体需按 AGPL 处理。本技能文档是独立改写，未内联上游代码与脚本
- 上游另有的 `patient-records-template-v2` 档案模板**未内联**（同属 AGPL 且体量不小）

## 加新技能时

1. 先读上游 `SKILL.md`，确认它是「纯提示」还是「要跑脚本/要密钥」
2. 要跑脚本的：**必须改写**，三选一——转成方法论 / 指向本项目已有工具 / 明确标注降级。
   绝不保留「照着跑 `scripts/xxx.py`」的原文，那是给用户一个用不了的承诺
3. `frontmatter` 只放 `name` + `description`（宿主只解析这两个字段）；
   来源、许可、可用程度写在**正文开头**
4. 加进 `manifest.json` 的 `contributes.skills`，并在 `main.js` 的 `SKILLS` 里补一条
   （面板要如实展示，不能让面板比实际更乐观）
5. 跑校验：

```bash
node scripts/xyb-check-plugins.mjs apps/desktop/resources/plugins/xyb.skillpack
pnpm pi-plugin check apps/desktop/resources/plugins/xyb.skillpack
```

## 不接的部分

- **开发基建类**（数学/美学大脑、Codex 编排、技能池、OpenClaw 运维）——与患者端功能无关
- **lark / 飞书类** ——按项目要求排除
- **ChiCTR 与中国药物临床试验登记平台** ——已由 `xyb.trial-sources` 承担，不重复接
- **运营/内容侧 10 个** ——无一例外依赖脚本与推送密钥（TG / 微信 / 飞书 / FastGPT），
  进客户端只能接方法论层，**经确认暂不接入**
- **需要把患者数据发布到公网的技能** ——与「患者数据不出本机」冲突，不接
- **AGPL-3.0**：`graphify-xiaoyibao` 已按决定接入（许可影响单独标注在该技能里）；
  仓库转公开前需先定整体分发策略
