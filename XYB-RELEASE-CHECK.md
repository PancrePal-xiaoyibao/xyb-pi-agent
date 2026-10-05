# 发布前验收报告（exe / dmg）

日期：2026-09-30
触发：打包发布前，逐个插件实测，重点验证临床检索（避免此前「报错不可用」的问题）。
方法：不读文档、不看代码推断——**真打数据源**。检索题用「B7-H3 在中国有哪些在招募的临床试验」。

工具（都已收进 `scripts/`，下次发布可复现）：

```bash
# 1. 契约测试：按 SDK 声明重建「会挑错的 pi」，静态形状 + 真跑 onLoad/命令/工具
node scripts/xyb-check-plugin-contract.mjs            # 离线
node scripts/xyb-check-plugin-contract.mjs --online   # 联网，真打数据源

# 2. 直连 MCP 服务，看握手与工具返回
#    ChiCTR 3.0.1 起走 Python sidecar 通道，需先 npx 拉包并确认 CHICTR_USE_SIDECAR=1
node scripts/xyb-probe-mcp.mjs chictr npx -y chictr-mcp-server@3.0.2 -- \
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_trials","arguments":{"keyword":"胰腺癌","max_results":5}}}'

# 3. 用「真实网络 + 真实磁盘」跑插件工具与命令（不是假 fetch）
node scripts/xyb-probe-plugin.mjs apps/desktop/resources/plugins/xyb.trials \
  xyb_trials_search '{"terms":"B7-H3"}'
PROBE_VAULT=/path/to/测试资料库 node scripts/xyb-probe-plugin.mjs \
  apps/desktop/resources/plugins/xyb.records xyb.records.import '{}'
```

第 3 个是真跑的关键：`xyb-check-plugin-contract.mjs` 用假 fetch 只验参数形状，
要回答「患者按下去会发生什么」必须打真接口。它的域名白名单按 manifest 的
`net.domains` 做 fail-closed 校验，与宿主一致；设了 `PROBE_VAULT` 时，
文件操作全部限定在该目录内，越界即抛。

---

## 一、总体结论

| 层 | 结果 |
|---|---|
| 插件加载 | **8 / 8 通过**（启动日志 `load.success` 全绿，零 error） |
| 技能注册 | **17 个全部注册**（assistants 9 / skillpack 4 / trial-sources 2 / trials 1 / records 1） |
| MCP 服务 | **3 / 3 握手成功**（chictr 9 工具、veeva-ctv 12 工具、chinadrugtrials 8 工具） |
| 临床检索 | **可用**，已实现的四个来源全部实测有响应（WHO ICTRP 是第 5 个来源，**尚未实现**，不在本次实测范围） |
| 契约测试 | 离线 6/6、联网 6/6 通过 |

**没有出现此前那类「插件启用了但工具报错」的情况。**

---

## 二、逐插件实测

| 插件 | 测试内容 | 实测结果 | 判定 |
|---|---|---|---|
| `xyb.records` 我的资料 | 造 10 份测试资料（含 2 层子目录、dcm/jpg/pdf/xlsx/csv/docx）跑 `import` | 递归扫描 10 份，分类 `化验数据 2 / 报告 6 / 影像 1 / 图片 1`，清单写入成功，26 ms | **可用** |
| `xyb.trials` 找试验 | 真打 ClinicalTrials.gov，4 组参数 | HTTP 200，见第三节 | **可用**（有一处能力缺口，见第五节） |
| `xyb.news` 看进展 | 真打 PubMed E-utilities | HTTP 200 ×2，`count=20`，1.57 s | **可用** |
| `xyb.assistants` 智能助手 | 命令 | `ok=true`，9 个助手 | **可用** |
| `xyb.skillpack` 外部技能 | 命令 | `ok=true`，4 个技能 | **可用** |
| `xyb.trial-sources` 试验来源 | 命令 + 三个 MCP 直连检索 | 见第四节 | **可用**（两处前置条件见第五节） |
| `pi.file-manager` | 启动加载 | `load.success` | **可用**（上游插件，无小胰宝业务逻辑） |
| `pi.browser` | 启动加载 | `load.success` | **可用**（同上） |

### 未配置时的行为（专门验证，防止误导）

`xyb.records.summary` 在没选资料库时返回 `{ok:false, reason:"NO_VAULT"}` 并提示
「请先在插件设置里选择『资料库位置』」——**守卫正确，不是崩溃**。

`chinadrugtrials` 在没配置会话时，4 ms 内返回
「还没有配置会话。请先调用 update_cookie」——**没有假称「没有相关试验」**。

这两条是此前最容易被误读成「插件坏了」的场景，现在都是明确指引。

---

## 三、B7-H3 检索实测（ClinicalTrials.gov）

| 参数 | 返回 | 含中国 | 转译结果 | 耗时 |
|---|---|---|---|---|
| `terms="B7-H3"`（默认 pancreatic cancer） | 6 | 3 | `B7-H3` | 1.35 s |
| `terms="B7-H3 China"` | 4 | 3 | `B7-H3 China` | 0.93 s |
| `condition="solid tumor"` + `terms="B7-H3"` | **20** | **11** | `B7-H3` | 1.60 s |
| `terms="胰腺癌 B7-H3"`（中文） | 6 | 3 | `pancreatic cancer B7-H3` | 1.02 s |

**中文转译工作正常**：「胰腺癌」正确转成 `pancreatic cancer`，零丢弃。

### 中国范围内 B7-H3 相关试验（合并去重）

**招募中（RECRUITING）**

| 登记号 | 试验 | 地点 |
|---|---|---|
| NCT06426680 | ILB-3101 用于晚期实体瘤 | 上海 |
| NCT05991583 | IBB0979 | 上海 |
| NCT04842812 | 工程化 TIL / CAR-TIL 治疗晚期实体瘤 | 广州 |
| NCT07502287 | GD2/B7-H3 双靶 CAR-NK | 深圳 |
| NCT07256782 | QLC5508 联合治疗 | 上海 |
| NCT06332170 | ARTEMIS-101：HS-20093 联合 | 上海 |
| NCT07541534 | HLX316 I 期 | 重庆 · 济南 |
| NCT06454955 | B7-H3 靶向亲和体放射性配体探针 | 北京 |
| NCT07231081 | TX103 CAR-T I 期 | 北京 |
| NCT07523529 | 生物标志物引导的双靶 CAR-T（胰腺癌） | 深圳 |

**尚未开始招募（NOT_YET_RECRUITING）**

| 登记号 | 试验 | 地点 |
|---|---|---|
| NCT04432649 | CD276(B7-H3) 阳性实体瘤 4-1BB | 深圳 |
| NCT07136558 | ICP-B794 | 广州 |
| NCT07736612 | Pan-RAS 抑制剂联合抗肿瘤 T | 杭州 |
| NCT07803783 | YL201 疗效与安全性对比 | 上海 |

> 以上为登记信息整理，**不构成入组建议**。是否适合由研究医生结合病情判断；
> 招募状态会变，以登记页面最新状态为准。

---

## 四、三个 MCP 数据源实测

| MCP | 握手 | 工具 | 检索验证 | 判定 |
|---|---|---|---|---|
| `chictr` | ✓ 7.0 s（npx 首次拉包） | 9 | 「胰腺癌」→ **5 条真实结果**（ChiCTR2600133371 等，2026/09 注册）；「B7-H3」→ 0 条 | **可用** |
| `veeva-ctv` | ✓ 2.1 s | 12 | 「pancreatic」→ **177 条**；China+Recruiting → **126 条**；「B7-H3」→ 0 条 | **可用**（覆盖有限，见下） |
| `chinadrugtrials` | ✓ 0.06 s | 8 | 未配置会话 → 明确报错并给指引 | **可用**（待配置会话） |

### 两点必须说清，否则会被误读

**1）ChiCTR 和 Veeva 对 B7-H3 返回 0 条，都不是故障。**

- ChiCTR 是中文注册平台，B7-H3 类试验多以药物名注册（如「阿得贝利单抗…」），
  用靶点名搜不到。用「胰腺癌」能返回 5 条真实结果，证明通道是活的。
- Veeva 查的是**本地索引**，当前索引只有 **193 条**（`get_index_stats` 实测）。
  193 条里没有 B7-H3 属于正常。**不能拿它的 0 条当结论。**

**2）`chinadrugtrials` 需要本人浏览器会话**，这是站点要求，不是缺陷。
Python 环境与依赖已就绪（`venv` + requests/beautifulsoup4），只差会话。

---

## 五、发布前需要知道的能力缺口

这些**不是 bug**，但会影响患者实际体验，建议发布说明里写清或后续补上。

### 1. 检索无法按国家筛选（影响最大）

`xyb_trials_search` 只支持 `condition` + `terms`，内部只发
`query.cond` + `query.term` + 状态过滤，**没有地理位置参数**。
患者问「中国有哪些」，只能靠返回结果里的 `locations` 自己看。

**建议**：给工具加一个 `country` 参数，映射到 CT.gov 的 `query.locn`
（`filter.geo` 已废弃）。这是一处小改动，但直接决定「中国范围」这类问题好不好用。

### 2. 默认病种锁死胰腺癌

`DEFAULT_CONDITION = "pancreatic cancer"`。对胰腺癌社区合理，
但查其他瘤种的 B7-H3 试验必须显式传 `condition`。
实测：默认条件 6 条，换成 `solid tumor` 变 20 条（中国 3 → 11）。
**助手在回答跨瘤种问题时必须记得改这个参数**，否则会漏一大半。

### 3. `terms` 里加地理词反而降低召回

`"B7-H3 China"` → 4 条，比 `"B7-H3"` → 6 条**更少**（`query.term` 是全文匹配，
加词等于加约束）。这条要写进「临床试验助手」技能，避免助手好心办坏事。

### 4. Veeva CTV 索引覆盖极小

193 条 vs 全球数十万。当前只能当补充，不能当主力。
需要的话用 `import_csv_export` 导入更大的 CSV，或 `sync_sitemap` 扩索引。

### 5. 抓取类操作是分钟级

`chinadrugtrials` 逐条抓取、每条间隔 1.5 秒。患者点下去要有等待预期，
发布说明里应写明。

---

## 六、发布前检查清单

**必须确认**

- [x] 8 个插件全部加载成功，零 error
- [x] 17 个技能全部注册
- [x] 3 个 MCP 全部握手成功
- [x] 临床检索四源全部有响应
- [x] 未配置时的引导正确（不误导、不崩溃）
- [x] 契约测试离线 + 联网全通过

**发布说明里要写的**

- [ ] `xyb.trial-sources` 需显式启用（授予本地进程权限）
- [ ] Veeva CTV 需本机安装 `ctv-mcp-server` 并建索引，否则 `INDEX_EMPTY`
- [ ] 中国药物临床试验登记平台需 Python 3 + 本人浏览器会话
- [ ] ChiCTR 首次使用要联网拉包 + Playwright Chromium（约 570MB）
- [ ] 按国家筛选暂不支持，需要自己看地点（或先补第 5 节的第 1 条）

**建议发布前补的**

- [ ] `xyb_trials_search` 增加 `country` 参数（改动小、收益直接）
- [ ] 把「`terms` 加地理词会降召回」写进临床试验助手技能
