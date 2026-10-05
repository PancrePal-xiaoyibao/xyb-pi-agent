# XYB 审计 F3：build / test 复现记录

版本：v2.2（v1.0 结论已被授权安装后的实测取代；v2.1 追加已知偶发测试记录；v2.2 追加渠道 3 本地索引 FTS 漏收的缺陷定位）
状态：**已复现，未再现 exit 134；全部 CI 门禁本机通过**
基线：`0a0223170e75f17b9747b82a046b03d076813cfe`（BASELINE_MAIN）
分支：`fix/xyb-records-audit-main`

## 零、v2.0 结论摘要（最重要）

在**用户授权安装依赖**后，审计声称的三个失败全部**未再现**：

| 审计声称 | 本次实测 | 退出码 |
|---|---|---|
| `build` exit 134 | `pnpm build:js` **构建成功**（Vite 产物输出完成） | **0** |
| `test` exit 134 | `pnpm test` **全绿** | **0** |
| `start` 被跳过 | 未执行 GUI 启动（不在本次验证范围） | — |

并进一步确证：**本仓 `apps/desktop` 全量 JS 测试 3203 个用例全部通过（# pass 3203 / # fail 0）**。

**因此 v1.0 中"168 个基线既有失败"的结论已被推翻**：那 168 个失败是**隔离 worktree 缺少 `node_modules`** 导致的产物（测试无法解析依赖），**不是代码缺陷，也不是既有债务**。

---

## 一、审计原文

确定性检查中 `build` 与 `test` 均以 **exit 134** 失败（通常为 SIGABRT／崩溃／OOM 类信号失败），`start` 被跳过。无法从 CI 证据确认项目能从源码完整构建运行。

## 二、环境

| 项 | 值 |
|---|---|
| Node | v22.19.0（满足 `engines.node >= 22.19.0`） |
| pnpm（PATH 默认） | 9.12.2 —— **不满足** `engines.pnpm >= 10` |
| pnpm（本次实际使用） | **10.34.5**（corepack 缓存 `~/.cache/node/corepack/v1/pnpm/10.34.5/bin/pnpm.cjs`，经 PATH 前置 shim 调用） |
| cargo / rustc | 1.98.1 |
| `node_modules` | 已安装（`pnpm install --frozen-lockfile`，exit 0） |

### 关键操作：如何让构建真正跑起来

`package.json` 的脚本内部**再次调用 `pnpm`**（如 `build:js` = `pnpm -r --if-present build`），因此 `corepack pnpm@10.34.5 run build:js` 这类写法仍会让**子进程**解析到 PATH 上的 9.12.2 并触发引擎校验。正确做法是把固定版本放到 PATH 最前：

```bash
mkdir -p /tmp/pnpm10
cat > /tmp/pnpm10/pnpm <<'EOF'
#!/bin/sh
exec node /Users/qinxiaoqiang/.cache/node/corepack/v1/pnpm/10.34.5/bin/pnpm.cjs "$@"
EOF
chmod +x /tmp/pnpm10/pnpm
PATH="/tmp/pnpm10:$PATH" pnpm -v      # → 10.34.5
```

**这不是代码问题，是工具链前置条件问题。**

## 三、逐项实测结果

### 3.1 安装

```text
$ PATH="/tmp/pnpm10:$PATH" pnpm install --frozen-lockfile
Done in 9.7s using pnpm v10.34.5
```

退出码：**0**。
（两条非阻断 WARN：`pi-plugin`/`pi-host` bin 创建失败——其 `dist/cli.js` 需先构建；`koffi@3.3.1` 构建脚本被 pnpm 默认忽略。均不影响后续构建与测试。）

### 3.2 `pnpm build:js` → **exit 0**

```text
$ PATH="/tmp/pnpm10:$PATH" pnpm build:js
apps/desktop build: ✓ built in 10.69s
apps/desktop build: Done
```

退出码：**0**。产物写入 `apps/desktop/out/renderer/assets/`。仅有一条 chunk >500 kB 的体积提示，属既有构建告警。

### 3.3 `pnpm test` → **exit 0**

```text
$ PATH="/tmp/pnpm10:$PATH" pnpm test
test result: ok. 671 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 56.82s
```

退出码：**0**。构成：`pnpm build:js`（0）→ `pnpm -r --if-present test`（0）→ `cargo test -p host-core`（0，671 passed）。
**注意：不得把嵌套步骤重复计作独立失败。**

### 3.4 各包测试明细

| 包 | 结果 |
|---|---|
| `apps/desktop` | **3203 pass / 0 fail** |
| `packages/agent-runtime` | 75 files / **1111 pass** |
| `packages/host-runtime` | 13 files / **75 pass** |
| `packages/racp` | 2 files / **21 pass** |
| `apps/pi-host` | 2 files / **6 pass** |
| `crates/host-core`（cargo） | **671 pass / 0 fail** |

`pnpm -r --if-present test` 退出码：**0**。

### 3.5 其余 CI 门禁（全部 exit 0）

| 门禁 | 命令（按 `ci.yml` 原样） | 退出码 |
|---|---|---|
| 类型检查（桌面） | `pnpm --filter @pi-desktop/desktop typecheck` | **0** |
| 类型检查（全仓） | `pnpm typecheck` | **0** |
| Lint | `pnpm lint`（biome 99 files + style tokens） | **0** |
| 架构预算 | `node scripts/check-architecture.mjs` | **0**（Architecture check passed） |
| Rust 测试 | `cargo test -p host-core --locked` | **0**（671 passed） |

### 3.6 本机**无法**执行的门禁（环境缺组件，非代码问题）

| 门禁 | 现象 |
|---|---|
| `cargo fmt -p host-core --check` | `'cargo-fmt' is not installed for the toolchain 'stable-aarch64-apple-darwin'` |
| `cargo clippy -p host-core --locked -- -D warnings` | `'cargo-clippy' is not installed ...` |

需 `rustup component add rustfmt clippy` 后复跑；本机未安装，**不得据此判断 Rust 格式/lint 通过或失败**。

## 四、对 v1.0 结论的更正

| v1.0 结论 | v2.0 更正 |
|---|---|
| 「apps/desktop 全量测试存在 168 个基线既有失败」 | **错误**。真实原因是隔离 worktree 无 `node_modules`，测试无法解析依赖。安装后 **3203 pass / 0 fail**。 |
| 「168 个是既有债务，需要单独立项」 | **不成立**，无需立项。 |
| 「多出一条 npm-executable 失败是环境不稳定」 | 同一根因；安装后不再出现。 |
| 「build/test 无法运行，退因为 pnpm 引擎校验」 | 部分正确（引擎校验确实是退因），但**可通过 PATH 前置固定版本解决**，并非不可逾越。 |

**教训记录**：在缺少依赖安装的隔离 worktree 中运行测试会产生大量**假失败**，绝不能把这种结果当作代码缺陷或"既有债务"上报。v1.0 的记录违反了这一原则，本次予以更正。

## 四之二、已知偶发测试（flake，如实记录）

在 B-2 变更后的回归过程中，全量测试出现过 **1 次非确定性失败**（11 次全量运行中 1 次）：

| 项 | 内容 |
|---|---|
| 用例 | `not ok 754 - first snapshot is written immediately and a burst collapses to one trailing write` |
| 文件 | `apps/desktop/test/inflight-checkpoint.test.mjs:30-48` |
| 性质 | 定时/防抖测试：`new InflightCheckpointer(..., 30)` + `await sleep(0)` / `await sleep(60)`，断言节流窗口内外的时间边界 |
| 失败原因 | 30ms 窗口与 `sleep(60)` 之间的墙钟边界在负载高时被压缩，属**时序敏感**而非逻辑错误 |
| 与本改动关系 | **无关**。该文件未被我改动（`git status` 中 `apps/desktop/test/` 仅新增三个 `xyb-*.test.mjs` 未跟踪文件）；单独重复运行 10 次全部通过 |
| 复现统计 | 全量运行 11 次 → 1 次失败；单文件运行 10 次 → 0 次失败；后续连续 5 次全量运行 → 全部通过 |
| 处置 | **不修改**（超出本次授权范围，且属既有测试的时序健壮性问题）。如后续需要稳定化，应单独立项收紧该用例的时间断言（例如注入可控时钟） |

记录此条的目的：避免把偶发失败偶发地当成"通过"，也避免把既有 flake 误登记为本次改动引入的缺陷。

## 五、F3 最终判定

- **状态：待证据核验 → 已复现，未再现**
- 审计的 `build` / `test` **exit 134 在本机未能复现**；实测三条命令全部 exit 0。
- 审计未提供环境、命令输出或堆栈，**不能据此认定代码缺陷**。
- 可确证：在本环境（Node v22.19.0 + pnpm 10.34.5 + 已安装依赖）下，构建、全量测试、类型检查、lint、架构预算、Rust 测试**全部门禁通过**。
- **未验证**：GUI `start`（需要图形环境与打包流程，不在本次范围）；`cargo fmt` / `clippy`（本机缺组件）。

## 六、复核命令（可原样执行）

```bash
# 固定 pnpm 版本（必须放 PATH 最前，否则脚本内的 pnpm 会回落到 9.12.2）
mkdir -p /tmp/pnpm10
printf '#!/bin/sh\nexec node %s/bin/pnpm.cjs "$@"\n' \
  "$HOME/.cache/node/corepack/v1/pnpm/10.34.5" > /tmp/pnpm10/pnpm
chmod +x /tmp/pnpm10/pnpm
export PATH="/tmp/pnpm10:$PATH"
pnpm -v                                    # 期望 10.34.5

# 安装
pnpm install --frozen-lockfile             # 期望 exit 0

# 三条审计声称失败的命令
pnpm build:js                              # 期望 exit 0
pnpm test                                  # 期望 exit 0
pnpm --filter @pi-desktop/desktop typecheck # 期望 exit 0

# 其余 CI 门禁
pnpm lint                                  # 期望 exit 0
node scripts/check-architecture.mjs        # 期望 Architecture check passed
cargo test -p host-core --locked           # 期望 671 passed
```

## 七、回滚

本记录为纯文档，回滚方式为删除本文件。
`pnpm install` 产生的 `node_modules/` 与构建产物 `apps/desktop/out/` 均为**可再生产物**，且被 `.gitignore` 覆盖（不在改动清单中）；如需彻底还原，删除这些目录即可。
未改动任何代码、依赖声明或锁文件（`pnpm-lock.yaml` 未变更）。

---

## 附：渠道 3（Veeva CTV）本地索引 FTS 漏收入库记录的缺陷定位（2026-10-03）

### 现象

`search_studies {keyword:"YL201"}` 返回 `total_matched: 0`，而同一库中直接查询确有该药名 8 条。

### 定位过程与证据

| 检查项 | 结果 |
|---|---|
| `npm view ctv-mcp-server version` | `0.1.0`（已发布；早先 E404 记录作废） |
| `npx -y ctv-mcp-server@0.1.0` | 启动成功，暴露 12 个工具 |
| `get_index_stats` | `total_studies: 210`，`db_path: ~/.ctv-mcp/ctv.db` |
| `studies` 表行数 | 210 |
| `studies_fts` 表行数 | **193**（缺 17） |
| `source='csv'` | 190 条 / 进 FTS 190 ✓ |
| `source='graphql'` | 20 条 / **进 FTS 仅 3**（缺 17）✗ |
| `studies_fts` 建表 | `fts5(utn UNINDEXED, brief_title, official_title, conditions, keywords, treatments, lead_sponsor, about, eligibility_criteria, tokenize='porter unicode61')` —— **含 `treatments`** |
| FTS 可用性对照 | `Irinotecan` = 10、`pancreatic` = 177 —— FTS 本身工作正常 |
| 缺失行是否在库中 | 在，`treatments` 有值（如 `NCT07803783` 的 `["5 Fluorouracil","Liposomal irinotecan",...]`） |
| `get_study_detail {study_id:"NCT07803783"}` | **能取到完整详情** —— 数据完好，仅 FTS 看不见 |

### 根因（源码级）

`ctv-mcp-server@0.1.0` 有两条写入 `studies` 的路径，**都**调用了 `reindexFts`：

- `dist/store/repository.js:135` `upsertCsvRows(rows)` —— 列清单 **含** `treatments`（:141），行内调用 `this.reindexFts(r.utn)`（:214）
- `dist/store/repository.js:225` `upsertDetail(detail)` —— 列清单 **不含** `treatments`（INSERT 列表见 :261-279，只有 `interventions_json`），随后调用 `this.reindexFts(detail.utn)`（:344）

而 `reindexFts`（:357-367）是回读 `studies` 表来写 FTS：

```sql
INSERT INTO studies_fts (utn, brief_title, official_title, conditions, keywords, treatments, lead_sponsor, about, eligibility_criteria)
SELECT utn, brief_title, official_title,
       COALESCE(conditions,'') || ' ' || COALESCE(condition_tags,''),
       COALESCE(keywords,''), COALESCE(treatments,'') || ' ' || COALESCE(interventions_json,''),
       ...
FROM studies WHERE utn = ?
```

### 实测修复

对 17 条缺失行执行上述同款 SQL 重建：

- `studies_fts` **193 → 210**
- `studies_fts match 'YL201'` 由 0 → 8
- 经**真实 MCP** 复验：`search_studies {keyword:"YL201"}` → `total_matched: 8`（NCT05434234 / NCT06057922 / NCT06241846 / NCT06612151 等）

验证后已把用户库**恢复原状**（`studies=210 / fts=193`），备份保留在 `~/.ctv-mcp/ctv.db.orig-before-fix`。

### 归属

该缺陷属**上游 `ctv-mcp-server@0.1.0`**，不在本仓代码内。本仓侧的处理是在文档与技能里写明该约束
（0 命中须说「本地索引中未命中」并附 coverage、可用 `get_study_detail` 绕行），**不在客户端改数据库**。
