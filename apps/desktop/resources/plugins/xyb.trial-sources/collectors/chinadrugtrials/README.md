# 采集器：中国药物临床试验登记与信息公示平台

本目录是**内联的第三方采集器**，供 `xyb.trial-sources` 插件的 MCP 服务
（`mcp/chinadrugtrials-mcp.mjs`）调用，也可脱离应用单独用命令行跑。

## 来源与同步

| 项 | 值 |
|---|---|
| 上游项目 | `chinadrugtrials-collector`（GitHub: `PancrePal-xiaoyibao/chinadrugtrials-collector`） |
| 内联时间 | 2026-09-30 |
| 内联内容 | `scripts/`（scraper / main / cookie_tools / build_json_from_raw / verify_output）与 `references/platform-workflow.md` |
| **未**内联 | `config.json`（含会话，绝不入库）、`output/`（抓取产物）、`__pycache__/` |
| 数据目录 | 默认 `~/.xyb-chinadrugtrials/`（由 MCP 服务传入 `--output`），**不写本目录** |

上游更新时，用同样的白名单重新复制 `scripts/` 与 `references/`，然后跑一次本仓库的校验：

```bash
node scripts/xyb-check-plugins.mjs apps/desktop/resources/plugins/xyb.trial-sources
bash scripts/xyb-setup-chinadrugtrials.sh
```

## ⚠️ 许可状态（待处理）

上游仓库 `chinadrugtrials-collector` **没有 LICENSE 文件**。按默认规则这意味着
「保留所有权利」，严格讲不满足再分发的明确授权。该仓库同属小胰宝组织
（`PancrePal-xiaoyibao`），所以这里按「自有代码内联」处理，但**建议尽快补一个 LICENSE**，
否则对外分发（尤其公开仓库）时说不清楚。

在此之前：本目录内容不单独分发，只随小胰宝客户端整体发布。

## 用法

### 经应用（推荐）

助手通过 MCP 工具调用，见 `skills/china-drug-trials.md`。
首次需 `setup_environment` 准备 Python 环境，再 `update_cookie` 保存本人会话。

### 直接命令行

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt

python3 scripts/scraper.py --config <数据目录>/config.json --output <数据目录>/output --keywords "胰腺癌"
python3 scripts/scraper.py --config <数据目录>/config.json --output <数据目录>/output --keywords "胰腺癌" --incremental
python3 scripts/verify_output.py --output "<数据目录>/output/胰腺癌"
```

`main.py` 是交互式菜单入口（含 Cookie 更新向导），`config.json` 从**当前工作目录**读取——
直接跑菜单时请先 `cd` 到准备好的目录。

## 红线

- 会话（Cookie）只留在本机 `config.json`，**不得**写入日志、文档、回答或任何提交
- 只处理有权访问的信息；保持请求间隔（默认 1.5 秒），不并发轰击

