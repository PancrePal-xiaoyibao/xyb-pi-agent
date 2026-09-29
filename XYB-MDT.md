# MDT 视角子智能体：设计与边界

对应 `subagents/` 目录、`scripts/xyb-install-subagents.sh`、
`scripts/xyb-check-subagents.mjs` 与 `xyb.assistants` 的「MDT 视角会诊准备」技能。

状态：已实现并安装到本机，7/7 通过 PI-Desktop 官方解析器校验。

---

## 一、可以，而且 MDT 恰好是子智能体最正当的用法

上一轮结论是「8 个助手保持技能形态」，因为患者对话是连续、带本人病例上下文的。
但 MDT 是另一类任务，它要的是**意见互相独立**：

- 如果让一个 Agent 在同一个上下文里依次扮演外科、内科、影像、病理，
  **后写的会被前面的判断锚定**——那样得到的不是多学科视角，而是同一个观点的七种复述
- 子智能体的上下文是**隔离**的，七份意见确实是各自独立得出的
- 可以并行派发；每个专科只拿到自己相关的资料切片
- 不需要写文件、不需要跑命令，所以工具只给 `Read`

同理，「多源试验检索」也是子智能体的正当用法（见 `XYB-TRIAL-SOURCES.md`）。

## 二、但绝不能做成「会诊意见」

这是本设计最重要的约束。

真实的 MDT 是**多位医生一起看原片、看切片、看检验，共同署名负责**。
这里的七个是软件角色，没看原片、没看切片、不承担任何责任。
把它包装成「五位专家会诊意见」，对癌症患者是**危险的**——会给出虚假的权威感。

因此整套设计做了三个硬性选择：

**1. 措辞用「视角」，不用「专家」。** 输出统一 `【影像视角】`，不写「影像专家认为」。

**2. 产出是「问题清单」，不是「结论」。** 每个专科返回：

| 产出 | 患者拿到能做什么 |
|---|---|
| 该专科还需要哪些资料 | 知道下一步要补什么检查/报告 |
| 该专科判断时看什么维度 | 理解医生在看什么 |
| **可以问该专科医生的具体问题 3–5 条** | 直接照着问，这是最有用的部分 |
| 依据与不确定性（共识/有争议/数据缺失） | 知道哪些话不能当定论 |

不是：诊断、分期结论、治疗方案、用药建议、能不能手术、预后多久。

**3. 汇总时呈现分歧，不平均成结论。** 编排技能（`mdt-round.md`）明确禁止
「综合各位专家意见，建议……」这类等于会诊结论的写法，并要求单独列一段
**「各视角的分歧点及其原因」**——分歧恰恰是患者最该拿去问医生的东西。

## 三、交付内容

| 交付物 | 说明 |
|---|---|
| `subagents/mdt-surgery.md` | 外科视角：可切除性依据、血管因素、围手术期风险与准备 |
| `subagents/mdt-oncology.md` | 肿瘤内科视角：治疗线梳理、方案类别选择维度、分子分型对应方向 |
| `subagents/mdt-imaging.md` | 影像视角：SMA/SMV/PV/CHA 关系、分档依据、检查技术要求 |
| `subagents/mdt-pathology.md` | 病理视角：取材方式对结论的限制、免疫组化与分子检测 |
| `subagents/mdt-interventional.md` | 介入与内镜视角：胆道减黄、疼痛控制、局部与血管介入、急症 |
| `subagents/mdt-radiation.md` | 放疗视角：适用情形、技术维度、剂量与危及器官、与化疗顺序 |
| `subagents/mdt-nutrition.md` | 营养视角：体重与进食评估、胰酶不足（PERT）、血糖、进食路径 |
| `scripts/xyb-install-subagents.sh` | 安装/卸载，幂等，覆盖前备份，只动本套装文件 |
| `scripts/xyb-check-subagents.mjs` | 用**官方解析器**校验 + 项目自己的工具护栏 |
| `xyb.assistants/skills/mdt-round.md` | 编排技能：齐料 → 选视角 → 并行派发 → 汇总成分歧+问题清单 |

用户给的 5 个（病理/肿瘤内科/影像/营养/介入）全做了；**外科与放疗是我补的**——
胰腺癌的 MDT 通常都有这两科，缺了会在"能不能切"这个最核心的问题上留下缺口。不要可以删。

## 四、为什么必须用安装脚本（技术事实）

**插件无法贡献子智能体。** 插件清单 `contributes` 的字段里没有 `subagents`：

```
agentExtensions, agentTools, bus, commands, globalShortcuts, mcpServers,
providers, scenicThemes, services, sessionSources, settings, skills,
themes, views, windowAppearance
```

这是**刻意的设计**。源码注释：

> Project workspaces never provide subagents; a repository cannot silently add a delegate
> to a user's agent catalog.

因为子智能体是**能行动的委派者**（内置 `fixer` 手里有 Write 和 Bash）。
若插件能贡献，装一个插件就等于静默获得了能力。所以子智能体是**用户级资产**，
只有两个来源：宿主随附的内置定义 + 用户自己放进 `~/.agents/subagents/` 的 Markdown。

本套定义因此放在仓库的 `subagents/`（**定义源**，可评审可回滚），
装机由用户显式运行一次安装脚本。这恰好也符合上面那条原则。

## 五、技术规格（与源码规则对齐）

| 项 | 值 | 依据 |
|---|---|---|
| 命名 | `^[a-z0-9][a-z0-9-]{0,39}$` | `NAME_RE` |
| 工具可选项 | `Read / Glob / Grep / BrowserPreview / Bash / Edit / Write`；省略默认 `[Read, Glob, Grep]` | `SUBAGENT_ASSIGNABLE_TOOLS` / `DEFAULT_SUBAGENT_TOOLS` |
| 本套工具 | **一律 `[Read]`** | 医学意见不需要写文件或跑命令 |
| 模型 | **不固定** | 固定了但 provider 不存在会**报错而不是回退**（`resolveSubagentProviders`） |
| 思考档位 | **不声明** | 档位与模型相关，声明不支持的值只会被忽略 |
| 权限 | 不声明（默认 `inherit`） | 工具只有 `Read`，本身就不可能触发需授权操作 |
| 目录上限 | 16（内置占 5；本套 + 内置 = 12，未超） | `MAX_SUBAGENT_DEFINITIONS` |
| 并行上限 | 10 | `MAX_SUBAGENT_CONCURRENCY` |

**校验器里的项目护栏**：`xyb-check-subagents.mjs` 在官方解析之外，额外检查
**这些定义不得申请 `Bash` / `Edit` / `Write` / `BrowserPreview` / `*`**。
即便以后有人改了定义，这条检查也会拦住把写权限发给医学视角的情况。

## 六、已知限制

1. **显示名只能是 ASCII handle**：设置页显示 `name`（`mdt-pathology`），
   因为 `id == name` 且 `NAME_RE` 不允许中文。改不了，患者版里这一页本身就不该暴露。
2. **需要新开会话或重启应用**才加载（定义在会话启动时读入）。
3. **成本是 7 次模型调用**（若全开）。所以编排技能要求**按问题选 2–4 个视角**，
   只有患者明确要求「从头到尾理一遍」才全开。
4. 内置的 5 个工程类子智能体需要**手动在设置页关掉**——开关状态存在
   `<数据目录>/agent-capabilities/subagent-builtins.json`，其内部键格式不适合手写脚本，
   所以没做成脚本（界面上点 5 次更稳）。

## 七、待决

1. 本套 7 个是否**默认全部启用**，还是让患者按需开（设置页可逐个开关）
2. 是否给某些视角**固定更强的推理模型**（如外科/肿瘤内科）。当前不固定，
   因为固定了但 provider 未配置会直接报错
3. 患者版是否**从导航里去掉「子智能体」这一页**（需改 Core），
   或只保留开关、不暴露定义编辑
4. 是否再补 **心理/姑息视角**（现有 7 个偏诊疗，缺情绪与安宁疗护这一维）
