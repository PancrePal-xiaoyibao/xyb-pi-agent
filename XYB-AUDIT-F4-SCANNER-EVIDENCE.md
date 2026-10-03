# XYB 审计 F4：gitleaks / semgrep 证据核验记录

版本：v1.0
状态：**待证据核验**（既不得称"扫描已通过"，也不得推断"存在泄露"）
基线：`0a0223170e75f17b9747b82a046b03d076813cfe`（BASELINE_MAIN）
分支：`fix/xyb-records-audit-main`

## 一、审计声称

确定性检查中 `gitleaks detect` 返回 **exit 1**（可能检出密钥类内容），`semgrep` 返回 **exit 2**。具体命中项无法从平台工件读取，因此无法确认真实泄露还是误报。另：仓库内 `AGENTS.md`／`CLAUDE.md` 等代理指令文件应视为不可信输入。

## 二、本次核验（只读，未运行任何扫描器）

### 2.1 仓库是否存在 gitleaks / semgrep 入口

```bash
grep -rIl "gitleaks\|semgrep" . --exclude-dir=node_modules --exclude-dir=.git
# → 无任何输出

grep -rIn "gitleaks\|semgrep\|trufflehog\|detect-secrets" .github/ scripts/ package.json
# → 无任何输出

ls -d .gitleaks* .semgrep*          # → 不存在
```

**结论：本仓库不含 gitleaks／semgrep 的任何配置、规则、脚本或 CI 调用入口。**

### 2.2 CI 工作流实际包含的检查

`.github/workflows/` 共 8 个文件：`ci.yml`、`docs-check.yml`、`linux-package.yml`、`mirror-to-cnb.yml`、`pr-base.yml`、`release.yml`、`xyb-fork-guards.yml`、`xyb-upstream-autosync.yml`。

- `ci.yml` 的 `js` 作业：Node 24、`pnpm install --frozen-lockfile`、`pnpm build:js`、typecheck、lint、check-architecture、`pnpm -r --if-present test`。
- `ci.yml` 的 `rust` 作业：`cargo fmt` / `clippy` / `cargo test -p host-core --locked`。
- `xyb-fork-guards.yml`：`scripts/xyb-check-plugins.mjs`、`scripts/xyb-check-plugin-api.mjs`、`scripts/xyb-check-plugin-contract.mjs` 等零依赖校验。

**两个工作流均未引用 gitleaks 或 semgrep。**

### 2.3 可能的误报来源（仅说明，不构成结论）

- `.env.example` 为 git 跟踪文件，内容全部是**空值占位**：

  ```text
  # Used only by scripts/e2e-smoke.mjs — never commit real keys
  PI_DESKTOP_TEST_BASE_URL=
  PI_DESKTOP_TEST_MODEL=
  PI_DESKTOP_TEST_API_KEY=
  ```

  空值不可能被 gitleaks 判为真实密钥；但**规则宽松的扫描器**对 `.env*` 文件名本身可能告警。
- `AGENTS.md`／`CLAUDE.md`／`XYB-*.md` 中含 `API_KEY`、`cookie`、`token` 等**说明性字符串**与文档示例，是秘密扫描的常见噪音源。
- 仓库含 `patches/` 与 `pnpm-lock.yaml`，也可能触发规则噪音。

以上均为**假设**，本记录**不宣称**它们就是审计命中的原因。

## 三、为什么无法给出"是否真实泄露"的结论

1. 审计的 gitleaks／semgrep 运行**不是由本仓库配置驱动的**（2.1 已确证无入口），因此必然来自外部平台或人工调用，其规则集、版本、扫描范围均未知。
2. 审计报告中**没有命中详情**（规则 ID、文件、行号、指纹），平台工件亦不可读。
3. 在没有以上任一信息的情况下：
   - **不得**宣布"扫描通过"或"无泄露"；
   - **不得**推断"存在真实密钥泄露"；
   - **不得**据此修改规则、加白名单或轮换密钥。

## 四、F4 最终判定

- **状态：待证据核验**
- 已确证：仓库**不存在** gitleaks／semgrep 自有入口；`.env.example` 为纯占位空值；CI 未接入这两个扫描器。
- 未确证：审计命中的具体内容、规则与范围。
- **不新增**扫描器、规则、忽略文件或密钥轮换；这些属需单独 amendment 的动作。

## 五、解除"待证据核验"所需的最小证据

请提供以下任一即可推进：

1. gitleaks／semgrep 的**完整输出**（含规则 ID 与被命中文件；密钥值可打码但需保留前后若干字符与行号）；
2. 触发这两个检查的**平台配置**（工作流文件、扫描器版本与命令行）；
3. 明确说明这是**外部平台默认扫描**而非本仓库配置。

## 六、复核命令（可原样执行）

```bash
grep -rIl "gitleaks\|semgrep" . --exclude-dir=node_modules --exclude-dir=.git   # 期望：无输出
grep -rIn "gitleaks\|semgrep\|trufflehog\|detect-secrets" .github/ scripts/ package.json   # 期望：无输出
ls -d .gitleaks* .semgrep* 2>/dev/null    # 期望：不存在
git ls-files | grep -E "\.env"            # 期望：仅 .env.example
cat .env.example                          # 期望：全部空值占位
```

## 七、回滚

本记录为纯文档，回滚方式为删除本文件。不涉及代码、规则、白名单或凭据变更。
