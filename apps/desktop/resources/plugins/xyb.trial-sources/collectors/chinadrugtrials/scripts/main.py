#!/usr/bin/env python3
"""中国药物临床试验抓取工具 - 交互式入口。"""

import json
import subprocess
import sys
from pathlib import Path

from cookie_tools import (
    extract_cookie_from_curl,
    extract_cookie_from_response_headers,
    fetch_bootstrap_cookie,
    load_config,
    mask_cookie,
    save_cookie_to_config,
)

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
DEFAULT_CONFIG = SKILL_ROOT / 'config.json'
EXAMPLE_CONFIG = SCRIPT_DIR / 'config.example.json'
PYTHON = sys.executable


def line(char='=', width=64):
    print(char * width)


def prompt(label, default=''):
    suffix = f' [{default}]' if default not in (None, '') else ''
    value = input(f'{label}{suffix}: ').strip()
    return value if value else default


def ensure_config(config_path):
    """创建本地配置骨架，但绝不将示例 Cookie 当作真实凭证使用。"""
    if config_path.exists():
        return
    config = {}
    if EXAMPLE_CONFIG.exists():
        config = load_config(EXAMPLE_CONFIG)
    config['cookies'] = ''
    config.setdefault('keywords', '胰腺癌')
    config.setdefault('output', 'output')
    config.setdefault('delay', 1.5)
    config.setdefault('max_pages', None)
    config.setdefault('max_retries', 3)
    config.setdefault('incremental', True)
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'已创建配置文件: {config_path}')


def read_multiline(prompt_text):
    """读取多行粘贴内容，以单独一行 END 结束。"""
    print(prompt_text)
    print('粘贴完成后，请在单独一行输入 END 并回车。')
    lines = []
    while True:
        try:
            line_text = input()
        except EOFError:
            break
        if line_text == 'END':
            break
        lines.append(line_text)
    return '\n'.join(lines)


def update_cookie(config_path):
    line()
    print('Cookie 更新')
    print('1. 粘贴浏览器“复制为 cURL”的完整命令（推荐，含完整登录态）')
    print('2. 粘贴 curl -i / curl -D 的响应头内容（提取 Set-Cookie）')
    print('3. 请求站点入口页，自动提取 Set-Cookie（更新反爬 Cookie）')
    print('0. 返回')
    method = input('选择: ').strip()
    if method == '0':
        return
    if method not in ('1', '2', '3'):
        print('无效选择。')
        return

    if method == '1':
        text = read_multiline('请粘贴完整 cURL 命令：')
        cookie = extract_cookie_from_curl(text)
        source = 'cURL 请求中的 -b/--cookie'
    elif method == '2':
        text = read_multiline('请粘贴包含 Set-Cookie 的 HTTP 响应头：')
        cookie = extract_cookie_from_response_headers(text)
        source = 'HTTP 响应头 Set-Cookie'
    else:
        try:
            cookie, status = fetch_bootstrap_cookie()
            source = f'站点入口页响应 Set-Cookie（HTTP {status}）'
        except Exception as e:
            print(f'请求站点入口页失败: {e}')
            return

    if not cookie:
        print('没有提取到 Cookie；请确认粘贴内容中包含 -b/--cookie 或 Set-Cookie。')
        return

    config = save_cookie_to_config(config_path, cookie, merge=True)
    print(f'已从 {source} 更新 {len(cookie.split("; "))} 个 Cookie 字段。')
    print(f'当前 Cookie（脱敏）: {mask_cookie(config["cookies"])}')


def build_run_command(config_path, incremental):
    return [PYTHON, str(SCRIPT_DIR / 'scraper.py'), '--config', str(config_path)] + (['--incremental'] if incremental else [])


def run_scraper(config_path, incremental):
    config = load_config(config_path)
    if not config.get('cookies'):
        print('尚未配置 Cookie。请先在菜单中选择“更新 Cookie”。')
        return

    mode = '增量同步' if incremental else '全量同步'
    print(f'\n即将执行{mode}：关键词={config.get("keywords", "")!r}')
    if incremental:
        print('规则：详情页正文指纹不变时，仅保留最新 raw HTML，不重写 JSON/Word。')
    else:
        print('规则：重新保存每条详情 JSON、网页原样 DOC 和兼容 DOCX。')
    if input('确认执行？[y/N]: ').strip().lower() not in ('y', 'yes'):
        print('已取消。')
        return
    try:
        completed = subprocess.run(build_run_command(config_path, incremental), cwd=SKILL_ROOT)
        if completed.returncode:
            print(f'抓取任务结束，返回码: {completed.returncode}')
        else:
            print('抓取任务完成。')
    except KeyboardInterrupt:
        print('\n已中断。')


def edit_search_config(config_path):
    config = load_config(config_path)
    line()
    print('设置查询条件（直接回车保留原值；留空并输入 - 可清空字段）')
    fields = [
        ('keywords', '关键词'), ('reg_no', '登记号'), ('indication', '适应症'),
        ('case_no', '试验方案编号'), ('drugs_name', '药物名称'),
        ('drugs_type', '药物类型 [1中药/2化药/3生物制品]'), ('appliers', '申请人'),
        ('communities', '伦理委员会'), ('researchers', '主要研究者'),
        ('agencies', '临床参加机构'), ('state', '试验状态'),
    ]
    for key, label in fields:
        current = config.get(key, '')
        value = input(f'{label} [{current}]: ').strip()
        if value == '-':
            config[key] = ''
        elif value:
            config[key] = value

    max_pages = input(f'最大页数 [{config.get("max_pages") or "全部"}]: ').strip()
    if max_pages == '-':
        config['max_pages'] = None
    elif max_pages:
        try:
            config['max_pages'] = int(max_pages)
        except ValueError:
            print('页数不是整数，保留原值。')
    delay = input(f'请求间隔秒数 [{config.get("delay", 1.5)}]: ').strip()
    if delay:
        try:
            config['delay'] = float(delay)
        except ValueError:
            print('间隔不是数字，保留原值。')

    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
    print('查询条件已保存。')


def show_status(config_path):
    config = load_config(config_path)
    output_root = SKILL_ROOT / config.get('output', 'output') / config.get('keywords', '胰腺癌')
    state_path = output_root / 'state.json'
    summary_path = output_root / 'summary.json'
    line()
    print(f'配置文件: {config_path}')
    print(f'关键词: {config.get("keywords", "")}')
    print(f'Cookie: {mask_cookie(config.get("cookies", "")) or "未配置"}')
    print(f'Cookie 更新时间: {config.get("cookie_updated_at", "未知")}')
    print(f'输出目录: {output_root}')
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding='utf-8'))
        print(f'已记录内容指纹: {len(state.get("trials", {}))} 条')
        print(f'状态更新时间: {state.get("updated_at", "未知")}')
    else:
        print('尚未创建增量状态。')
    if summary_path.exists():
        summary = json.loads(summary_path.read_text(encoding='utf-8'))
        print(f'最近一次抓取: {summary.get("scrape_time", "未知")}')
        print(f'最近一次处理: 成功 {summary.get("success_count", 0)} / 失败 {summary.get("fail_count", 0)}')


def rebuild_json(config_path):
    config = load_config(config_path)
    output_root = SKILL_ROOT / config.get('output', 'output') / config.get('keywords', '胰腺癌')
    if input('从 raw HTML 离线重建缺失 JSON，确认？[y/N]: ').strip().lower() not in ('y', 'yes'):
        return
    subprocess.run([
        PYTHON, str(SCRIPT_DIR / 'build_json_from_raw.py'), '--output', str(output_root)
    ], cwd=SKILL_ROOT)


def main():
    config_path = DEFAULT_CONFIG
    ensure_config(config_path)

    while True:
        line()
        print('中国药物临床试验信息提取工具')
        print(f'配置: {config_path.name}')
        print('1. 设置查询条件')
        print('2. 更新 Cookie（粘贴 cURL 或响应头）')
        print('3. 全量同步（重抓并重写所有结果）')
        print('4. 增量同步（仅保存新增或内容变化记录）')
        print('5. 从 raw HTML 离线补建 JSON')
        print('6. 查看状态')
        print('7. 切换配置文件')
        print('0. 退出')
        choice = input('选择: ').strip()

        if choice == '1':
            edit_search_config(config_path)
        elif choice == '2':
            update_cookie(config_path)
        elif choice == '3':
            run_scraper(config_path, incremental=False)
        elif choice == '4':
            run_scraper(config_path, incremental=True)
        elif choice == '5':
            rebuild_json(config_path)
        elif choice == '6':
            show_status(config_path)
        elif choice == '7':
            value = prompt('配置文件路径', str(config_path))
            config_path = Path(value).expanduser().resolve()
            ensure_config(config_path)
        elif choice == '0':
            print('已退出。')
            return
        else:
            print('无效选择。')


if __name__ == '__main__':
    main()
