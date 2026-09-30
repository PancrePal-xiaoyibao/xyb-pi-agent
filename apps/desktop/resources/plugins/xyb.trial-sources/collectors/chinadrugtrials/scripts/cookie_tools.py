#!/usr/bin/env python3
"""Cookie 提取与保存工具。

支持两条途径：
1. 从浏览器“复制为 cURL”的命令中提取 -b / --cookie 参数；
2. 从 curl -i / -D 输出中提取 Set-Cookie 响应头。

注意：站点未必会在每次响应中下发完整反爬 Cookie。最可靠来源仍是浏览器
已通过验证后的请求 cURL（其 -b 参数包含浏览器当前有效 Cookie）。
"""

import json
import re
import shlex
from datetime import datetime
from pathlib import Path

import requests

DEFAULT_BOOTSTRAP_URL = 'https://www.chinadrugtrials.org.cn/clinicaltrials.prosearch.dhtml'
BROWSER_UA = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/145.0.0.0 Safari/537.36'
)


def parse_cookie_string(cookie_text):
    """解析 Cookie 字符串并去重，保留首次出现的字段顺序。"""
    cookies = {}
    for part in (cookie_text or '').split(';'):
        part = part.strip()
        if '=' not in part:
            continue
        name, value = part.split('=', 1)
        name, value = name.strip(), value.strip()
        if name:
            cookies[name] = value
    return cookies


def cookie_dict_to_string(cookies):
    """将 cookie 字典序列化为 HTTP Cookie 请求头格式。"""
    return '; '.join(f'{name}={value}' for name, value in cookies.items())


def extract_cookie_from_curl(curl_text):
    """从“复制为 cURL”命令解析 -b/--cookie 的 Cookie 字符串。"""
    if not curl_text or not curl_text.strip():
        return ''

    # shlex 优先处理单/双引号、多行反斜杠；失败时使用正则兜底。
    try:
        tokens = shlex.split(curl_text.replace('\\\n', ' '))
        for index, token in enumerate(tokens):
            if token in ('-b', '--cookie') and index + 1 < len(tokens):
                return cookie_dict_to_string(parse_cookie_string(tokens[index + 1]))
            if token.startswith('--cookie='):
                return cookie_dict_to_string(parse_cookie_string(token.split('=', 1)[1]))
    except ValueError:
        pass

    patterns = [
        r"(?:-b|--cookie)\s+'([^']+)'",
        r'(?:-b|--cookie)\s+"([^"]+)"',
        r"(?:-b|--cookie)\s+([^\s]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, curl_text, flags=re.S)
        if match:
            return cookie_dict_to_string(parse_cookie_string(match.group(1)))
    return ''


def extract_cookie_from_response_headers(response_text):
    """从 curl -i 或 curl -D 输出的多个 Set-Cookie 头中提取请求 Cookie。"""
    cookies = {}
    for line in (response_text or '').splitlines():
        match = re.match(r'^Set-Cookie:\s*([^=;\s]+)=([^;]*)', line, flags=re.I)
        if match:
            cookies[match.group(1).strip()] = match.group(2).strip()
    return cookie_dict_to_string(cookies)


def fetch_bootstrap_cookie(url=DEFAULT_BOOTSTRAP_URL, timeout=30):
    """请求站点入口页并提取其 Set-Cookie，返回（cookie字符串, 状态码）。

    此方式能更新站点下发的 FSSBBIl...S/T Cookie；若接口还要求 token 等
    登录态字段，则需保留浏览器 cURL 中已有的 Cookie，并由 merge 逻辑合并。
    """
    response = requests.get(
        url,
        headers={'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9'},
        timeout=timeout,
    )
    response.raise_for_status()
    cookies = {cookie.name: cookie.value for cookie in response.cookies}
    return cookie_dict_to_string(cookies), response.status_code


def merge_cookie_strings(existing, incoming):
    """以 incoming 覆盖 existing 的同名 Cookie。"""
    merged = parse_cookie_string(existing)
    merged.update(parse_cookie_string(incoming))
    return cookie_dict_to_string(merged)


def load_config(config_path):
    """读取配置，不存在时返回空配置。"""
    config_path = Path(config_path)
    if not config_path.exists():
        return {}
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_cookie_to_config(config_path, cookie_text, merge=True):
    """保存 Cookie 至 JSON 配置，同时写入更新时间；返回新配置。"""
    config_path = Path(config_path)
    config = load_config(config_path)
    normalized = cookie_dict_to_string(parse_cookie_string(cookie_text))
    if not normalized:
        raise ValueError('未解析到有效 Cookie')
    config['cookies'] = merge_cookie_strings(config.get('cookies', ''), normalized) if merge else normalized
    config['cookie_updated_at'] = datetime.now().isoformat()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = config_path.with_suffix('.tmp')
    with open(temp_path, 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    temp_path.replace(config_path)
    return config


def mask_cookie(cookie_text):
    """仅用于菜单显示，防止在日志/终端完整泄露 Cookie。"""
    masked = []
    for name, value in parse_cookie_string(cookie_text).items():
        if len(value) <= 10:
            shown = '*' * len(value)
        else:
            shown = f'{value[:4]}...{value[-4:]}'
        masked.append(f'{name}={shown}')
    return '; '.join(masked)
