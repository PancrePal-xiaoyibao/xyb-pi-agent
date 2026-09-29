# 小胰宝 · PI-Desktop 改造清单

> 基于 `vastsa/PI-Desktop v0.15.10`（LGPL-3.0）改造：把通用 AI Agent 桌面工作台，变成面向**肿瘤患者及家属**的「小胰宝」桌面工作台。
>
> 状态：**Phase 0 已启动**（克隆 + 品牌资产 + 品牌名替换）；其余阶段为待办清单。
> 基线：`git clone https://github.com/vastsa/PI-Desktop.git`（本地已克隆于本目录）。

---

## 0. 已完成（Phase 0：骨架与品牌）

### 0.1 框架克隆
- 仓库：`git@github.com:vastsa/PI-Desktop.git`（HTTPS 隧道 502，已改用 SSH 成功）
- 版本：`0.15.10`（Early Preview）
- 结构：Electron + Rust host-core（`crates/host-core`）、pnpm workspace、`packages/{shared,i18n,plugin-sdk,...}`

### 0.2 Logo 适配（本次已完成 ✅）
**源图**：`https://picgo-1302991947.cos.ap-guangzhou.myqcloud.com/images/Pop%20Mart%20Character%20Front%20View%20(2).png`
- 512×512 PNG、RGBA 透明底、主色墨绿青 `#008080` 系 + 白色/浅灰、内容主体 (108,46)-(414,459)、不贴边

**适配处理**：按 macOS/Windows 图标规范，以内容 bbox 为中心做 **6% 安全留白**的正方形裁剪后，用 **LANCZOS** 高质量缩放；输出前清除边缘半透明噪点。

**已生成资产**（源在 `build/xyb/`，已复制到框架正确位置）：

| 产物 | 尺寸 | 落盘位置 |
|---|---|---|
| `icon_1024.png` | 1024×1024 | `apps/desktop/build/icon_1024.png` |
| `icon.png` | 512×512 | `apps/desktop/build/icon.png` |
| `logo_dark.png` | 512×512 | `apps/desktop/build/logo_dark.png` |
| `tray-icon-mac.png` | 1024×1024 | `apps/desktop/build/tray-icon-mac.png` |
| `icon.icns` | 16→1024 全套 10 档 | `apps/desktop/build/icon.icns` |
| `icon.ico` | 16/32/48/64/128/256 | `apps/desktop/build/icon.ico` |
| `logo-light.png` | 192×192 | `apps/desktop/src/assets/brand/logo-light.png` |
| `logo-dark.png` | 192×192 | `apps/desktop/src/assets/brand/logo-dark.png` |

**一键重跑脚本**（换正式商标时用）：
```bash
python3 scripts/xyb-generate-icons.py <母版.png>          # 生成并写入工程
python3 scripts/xyb-generate-icons.py <母版.png> --no-install  # 只看产物不覆盖
```
支持 `--padding` 调整安全留白比例（默认 0.06）。自动完成 bbox 居中裁剪 → LANCZOS 缩放 → 清边缘噪点 → 输出 PNG/icns/ico → 写入工程路径。

**适配预览页**：`.logo-src/preview/index.html`（各尺寸梯度 + 深浅主题模拟）。

> ⚠️ 注意：当前用同一张卡通 logo 同时作为 桌面图标 与 UI 品牌区 logo。若后续 UI 区需要"图标+小胰宝文字"的横版商标，需另制 192×192 横版 png，替换 `assets/brand/` 两份即可，无需动 build/ 图标。

### 0.3 品牌名替换（已完成 ✅）

| 文件 | 改动 |
|---|---|
| `apps/desktop/index.html` | `<title>PI-Desktop` → `<title>小胰宝` |
| `apps/desktop/src/features/settings/SettingsPage.tsx` | about 页版本 fallback `"PI-Desktop"` → `"小胰宝"` |
| `apps/desktop/package.json` | `appId: net.aiuo.pi-desktop` → `org.xiaoyibao.desktop`；`productName` → `小胰宝`；`name` → `@xiaoyibao/desktop`；`description` → 小胰宝文案 |
| `README.md` / `README.zh-CN.md` | 标题与首屏品牌改为小胰宝（徽章/链接保留原仓库，待替换域名后统一更新） |

**刻意不改**：`@pi-desktop/shared`、`@pi-desktop/i18n` 等包名/IPC 通道/插件 ID 属内部标识符，改动会破坏 `packages/` 之间的引用与 plug 协议，留到 Phase 4（独立发布）整体重命名。

---

## 1. 现状盘点（已核实）

### 1.1 PI-Desktop 能力
- **模型**：pi-ai 支持的 Provider 全覆盖（OpenAI 兼容 / Anthropic / 本地 / 自定义网关），模型可替换
- **工作区**：Projects + Sessions + Review(Diff) + Preview + Composer + 上下文用量检查
- **扩展**：Skills / MCP / Subagents / Plugins（插件可扩展 Panels、Agent Tools、Skills、MCP、Commands、Theme、后台 Service、插件消息总线）
- **安全**：本地优先，凭据走系统钥匙串，无强制云中继；`PI_DESKTOP_MCP_CONTROL` 回环 MCP 控制（默认关）

### 1.2 opencare-skillhub 可复用资产（35 仓库，已抽查 13 个 README）

| 层 | 技能仓库 | 类型 | 说明 |
|---|---|---|---|
| **资讯** | `pancreatic-cancer-dailynews-skill` | TS | 小胰宝 2.0 日报引擎（v5 MCP-first），临床试验/研究/营养心理/社区，多推送渠道 |
| **试验** | `clinicaltrials-intel-skill` | Py | 多癌种试验情报自动化，GeWe微信/TG/飞书/FastGPT 推送 |
| **试验** | `clinical-trial-matching` | Skill | CancerDAO 双源（CT.gov+ChiCTR）匹配 + 结构化入组分析，产出决策级报告 |
| **试验** | `chictr-trials-collector` | TS | ChiCTR 公开信息采集（关键词/注册号/年份），结构化 JSON |
| **试验** | `chinadrugtrials-collector` | Py | 中国药物临床试验登记平台采集 → 原始HTML/Word/RAG JSON |
| **病案** | `Medical-Record-Organizer` | Py | OCR(MinerU/DeepSeek) → 脱敏 → LLM结构化 → HTML/MD/DOCX/XLSX 病情档案 |
| **病案** | `aura_health_profile` | Py | 慢性病健康档案 build/update/brief 三模式，阿里百炼 Qwen+Wan |
| **病案** | `graphify-xiaoyibao` | Py | 病情资料知识图谱 CLI（scan/extract/process/query，含 DICOM 元数据、标志物趋势） |
| **指南** | `nccn-guideline-downloader` | Py | NCCN 65 癌种指南/支持护理/患者指南 PDF 下载 |
| **心理** | `skill-HADS-accessment` | Py | HADS 焦虑抑郁量表评估（交互问卷+自动计分+JSON 输出） |
| **影像** | `xyb_dicom_download_skills` | Py | Playwright 批量下载 DICOM（禁商用收费） |
| **RAG** | `RAG-content-processor` | Py | FastGPT 知识库管理 + 公众号文章下载/清洗/上传 |
| **写作** | `xyb-wechat-article-generator` | HTML | 小胰宝科普文章生成（135 编辑器 source 规范、紫色 template3） |
| **写作** | `xyb-humanizer` | Py | 去除 AI 腔（医学科普向） |
| **翻译** | `pdf-translate` | Sh | 英文 PDF → 中文（pdf2zh，保留版式公式图表） |

另有：`xyb-whitepaper-writer`、`xyb_dicom_download_skills`、`inkstone-studio`（心理写作）、`llm-wiki-pancrepal`、`pancrepal-wechat-news-board` 等。

---

## 2. 阶段规划

### Phase 1 — 医疗安全与隐私（必须最先做）
- [ ] 加密存储模块：`packages/xyb-security`（本地 SQLite + 系统钥匙串 + 字段级加密）
- [ ] 脱敏中间层：发给模型前，用 `Medical-Record-Organizer` 的脱敏步骤做 PII 剥离（姓名/手机号/身份证/医院/医生）
- [ ] 审计日志：所有"报告解读 / 用药建议 / 症状建议"落审计日志（谁/何时/何种输入）
- [ ] 免责声明组件：所有 AI 报告头部固定"不能替代医生诊断"横幅，高风险操作二次确认

### Phase 2 — 核心插件

**MVP 只做 3 个（最小闭环）**，已在 `apps/desktop/resources/plugins/` 建好骨架：

| 插件 ID | 名称 | 患者价值 | 依赖 skillhub 资产 |
|---|---|---|---|
| `xyb.records` | 我的资料 | 把散落的报告/照片归到一个本地仓库，生成患者友好摘要 | `Medical-Record-Organizer`、`aura_health_profile` |
| `xyb.trials` | 找试验 | 按自己的情况匹配临床试验，给评分 + 推理 + 来源 | `clinical-trial-matching`、`chictr-trials-collector`、`clinicaltrials-intel-skill` |
| `xyb.news` | 看进展 | 胰腺癌药物/研究进展日报，按需订阅 | `pancreatic-cancer-dailynews-skill` |

**后置到 v0.3**（不在 MVP）：
- `xyb.medication` 用药管理与提醒
- `xyb.recovery` 康复与营养指导
- `xyb.support` 心理支持（`skill-HADS-accessment` 量表）

### Phase 3 — Skills/MCP 集成
- 建立 `docs/xyb-source-registry.md`（Source Registry）：列出可复用的 skill/MCP 仓库、安装方式、API key 需求
- 通过 PI-Desktop 原生扩展机制注入（不动 Core）：Skills 目录挂载 + MCP server 配置
- 首批 MCP：ClinicalTrials.gov、ChiCTR、PubMed、FastGPT 知识库

### Phase 4 — 发布
- [ ] 包名/标识整体重命名（`@pi-desktop/*` → `@xiaoyibao/*`，含 IPC/插件 ID）
- [ ] electron-builder 发布配置（appId 已改，补 icons、公证、自动更新）
- [ ] 医疗合规文案（隐私政策、免责声明、数据说明）落 `docs/privacy-policy.md`
- [ ] v0.1.0-beta

---

## 3. 已锁定决策（2026-09-29）

| 项 | 决策 | 影响 |
|---|---|---|
| **Logo 版权** | ✅ 已获授权，可直接用于产品品牌 | 无需替换；`scripts/xyb-generate-icons.py` 留作备用 |
| **目标用户** | **纯患者**（不含医生/家属专属角色） | 工作台必须大幅简化，"工程师视角"（Projects/Diff/Preview/Subagent）需隐藏或降级；术语全白话；不做专业级参数面板 |
| **首批范围** | **最小闭环**：病案整理 + 试验检索 + 资讯 | 6 插件砍到 3 个；不出康复/营养/心理插件（留 v0.3） |
| **后端** | 暂不引入（沿用**纯本地优先**） | 档案存本地，模型调用前脱敏；无账号体系 |

> 详细 MVP 规格见 [`XYB-MVP.md`](./XYB-MVP.md)。

### 关键推论：纯患者 ≠ 缩小版工程师工作台

PI-Desktop 的默认心智模型是「项目 → 会话 → Diff → 预览 → 子代理」。患者用不到 `git diff`、终端、文件树，也不该看到 commit、branch、子代理拓扑。因此 MVP 的产品形态是：

**一个入口（问一句）→ 三个能力（我的资料 / 找试验 / 看进展）→ 每条回答带来源与免责声明。**

工程侧对应动作：内置一组「患者视图」插件视图（`views`，挂右侧工作面板），把 Coding 相关的默认入口收起（`activationEvents` + 视图白名单控制），而非改 Core 源码。

---

## 4. 附录：已改文件清单
```
apps/desktop/index.html                                  (title → 小胰宝)
apps/desktop/src/features/settings/SettingsPage.tsx      (about fallback → 小胰宝)
apps/desktop/package.json                                (name/appId/productName/description)
README.md / README.zh-CN.md                               (品牌首屏)
apps/desktop/build/icon_1024.png / icon.png / logo_dark.png / tray-icon-mac.png
apps/desktop/build/icon.icns / icon.ico
apps/desktop/src/assets/brand/logo-light.png / logo-dark.png
build/xyb/                                                (源资产暂存，可删)
.logo-src/                                                (原始下载，可删)
```

> 技术说明：`apps/desktop/build/*` 是 electron-builder 安装图标；`apps/desktop/src/assets/brand/*` 是 UI 内 logo。两者都换到位。