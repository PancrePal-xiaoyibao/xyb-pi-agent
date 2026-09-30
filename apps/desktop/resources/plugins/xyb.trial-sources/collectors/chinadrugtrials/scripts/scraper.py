#!/usr/bin/env python3
"""
中国药物临床试验登记与信息公示平台 - 临床试验信息提取工具

功能：
  1. 支持关键词搜索 + 高级搜索（登记号/适应症/药物名称/试验状态等）
  2. 自动解析搜索结果列表，提取总页数、总记录数
  3. 支持多页翻页，逐条打开详情页
  4. 详情页优先下载 Word 文档，失败时从 <div class="paddingSide15"> 提取 JSON
  5. 实时动态显示提取进度日志
  6. 支持断点续抓（--resume）

用法示例：
  # 基本搜索
  python scraper.py --keywords "胰腺癌" --cookies "FSSBBIl1UgzbN7N80S=xxx; token=xxx"

  # 从配置文件加载
  python scraper.py --config config.json

  # 高级搜索
  python scraper.py --keywords "肺癌" --state "招募中" --drugs-type 2 --cookies "..."

  # 限制页数 + 断点续抓
  python scraper.py --keywords "胰腺癌" --max-pages 2 --resume --cookies "..."
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import logging
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup, Tag


# ──────────────────────────────────────────────
# 日志格式化
# ──────────────────────────────────────────────

class ColorFormatter(logging.Formatter):
    """带颜色的控制台日志格式化器"""

    COLORS = {
        'DEBUG':    '\033[36m',   # 青色
        'INFO':     '\033[32m',   # 绿色
        'WARNING':  '\033[33m',   # 黄色
        'ERROR':    '\033[31m',   # 红色
        'CRITICAL': '\033[35m',   # 紫色
        'RESET':    '\033[0m',
    }

    def format(self, record):
        color = self.COLORS.get(record.levelname, '')
        reset = self.COLORS['RESET']
        record.msg = f"{color}{record.msg}{reset}"
        return super().format(record)


# ──────────────────────────────────────────────
# 主抓取器
# ──────────────────────────────────────────────

class ChinaDrugTrialsScraper:
    """中国药物临床试验信息抓取器"""

    BASE_URL  = "https://www.chinadrugtrials.org.cn"
    SEARCH_URL = f"{BASE_URL}/clinicaltrials.searchlist.dhtml"
    DETAIL_URL = f"{BASE_URL}/clinicaltrials.searchlistdetail.dhtml"

    # 每页记录数（网站默认 20 条/页）
    PAGE_SIZE = 20

    # 试验状态选项（与页面 <select> 的 value 一致）
    STATES = [
        '', '进行中', '尚未招募', '招募中', '招募完成', '已完成',
        '主动暂停', '主动终止', 'IEC/IRB暂停', 'IEC/IRB终止',
        '责令暂停', '责令终止',
    ]

    # 药物类型
    DRUG_TYPES = {'1': '中药/天然药物', '2': '化学药物', '3': '生物制品'}

    # 高级搜索字段映射
    ADV_FIELDS = [
        'reg_no', 'indication', 'case_no', 'drugs_name', 'drugs_type',
        'appliers', 'communities', 'researchers', 'agencies', 'state',
    ]

    def __init__(self, cookies_str=None, cookies_file=None, output_dir='output',
                 delay=1.5, max_retries=3, debug=False, incremental=False):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': (
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/145.0.0.0 Safari/537.36'
            ),
            'Accept': (
                'text/html,application/xhtml+xml,application/xml;q=0.9,'
                'image/avif,image/webp,image/apng,*/*;q=0.8,'
                'application/signed-exchange;v=b3;q=0.7'
            ),
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Connection': 'keep-alive',
            'Origin': self.BASE_URL,
            'Referer': f'{self.BASE_URL}/index.html',
            'Upgrade-Insecure-Requests': '1',
        })

        self.output_dir = Path(output_dir)
        self.delay = delay
        self.max_retries = max_retries
        self.debug = debug
        self.incremental = incremental
        self.current_search_params = {}
        self.state_path = self.output_dir / 'state.json'
        self.state = {}

        # 先初始化日志和目录，再加载 cookies（_set_cookies 中需要 logger）
        self._setup_logging()
        self._setup_dirs()
        self._load_state()

        # 加载 cookies
        if cookies_file:
            self._load_cookies_from_file(cookies_file)
        elif cookies_str:
            self._set_cookies(cookies_str)
        else:
            raise ValueError("必须提供 cookies_str 或 cookies_file")

    # ── Cookies ───────────────────────────────

    def _set_cookies(self, cookies_str):
        """从字符串解析并设置 cookies"""
        count = 0
        for cookie in cookies_str.split(';'):
            cookie = cookie.strip()
            if '=' in cookie:
                name, value = cookie.split('=', 1)
                self.session.cookies.set(name.strip(), value.strip())
                count += 1
        self.logger.info(f"已加载 {count} 个 cookies")

    def _load_cookies_from_file(self, filepath):
        """从文件加载 cookies（支持纯文本或 JSON）"""
        with open(filepath, 'r', encoding='utf-8') as f:
            if filepath.endswith('.json'):
                data = json.load(f)
                cookies_str = data.get('cookies', '')
            else:
                cookies_str = f.read().strip()
        self._set_cookies(cookies_str)

    # ── 日志 & 目录 ───────────────────────────

    def _setup_logging(self):
        """配置日志：控制台 INFO + 文件 DEBUG"""
        self.logger = logging.getLogger('ChinaDrugTrials')
        self.logger.setLevel(logging.DEBUG)
        self.logger.handlers = []

        # 控制台
        console = logging.StreamHandler(sys.stdout)
        console.setLevel(logging.INFO)
        console.setFormatter(ColorFormatter(
            '%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S'
        ))
        self.logger.addHandler(console)

        # 文件
        log_dir = self.output_dir / 'logs'
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f'scrape_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log'
        fh = logging.FileHandler(log_file, encoding='utf-8')
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(logging.Formatter(
            '%(asctime)s [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S'
        ))
        self.logger.addHandler(fh)
        self.logger.info(f"日志文件: {log_file}")

    def _setup_dirs(self):
        """创建输出目录"""
        for sub in ['json', 'word', 'logs', 'raw']:
            (self.output_dir / sub).mkdir(parents=True, exist_ok=True)
        self.logger.info(f"输出目录: {self.output_dir.absolute()}")

    # ── 增量状态 ──────────────────────────────

    def _load_state(self):
        """读取按登记号存储的内容指纹，用于每日增量同步。"""
        if not self.state_path.exists():
            self.state = {'version': 1, 'trials': {}}
            return
        try:
            with open(self.state_path, 'r', encoding='utf-8') as f:
                self.state = json.load(f)
            self.state.setdefault('version', 1)
            self.state.setdefault('trials', {})
            self.logger.info(f"已加载增量状态: {len(self.state['trials'])} 条记录")
        except (OSError, json.JSONDecodeError) as e:
            self.logger.warning(f"增量状态不可读，将重建: {e}")
            self.state = {'version': 1, 'trials': {}}

    def _save_state(self):
        """原子保存增量状态，避免中断时损坏状态文件。"""
        self.state['updated_at'] = datetime.now().isoformat()
        temp_path = self.state_path.with_suffix('.tmp')
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(self.state, f, ensure_ascii=False, indent=2)
        temp_path.replace(self.state_path)

    @staticmethod
    def _content_hash(text):
        """规范化正文后生成稳定指纹，忽略 HTML 空白和无意义换行变化。"""
        normalized = re.sub(r'\s+', ' ', text or '').strip()
        return hashlib.sha256(normalized.encode('utf-8')).hexdigest()

    def _existing_json_hash(self, reg_no):
        """读取本地 JSON 的正文指纹，兼容此前未创建 state.json 的情况。"""
        json_path = self.output_dir / 'json' / f'{reg_no}.json'
        if not json_path.exists():
            return None
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return data.get('content_hash') or self._content_hash(data.get('full_text', ''))
        except (OSError, json.JSONDecodeError):
            return None

    # ── 表单构建 ──────────────────────────────

    def _build_form_data(self, keywords, currentpage=1, **advanced):
        """构建 POST 表单数据"""
        has_advanced = any(advanced.get(k, '') for k in self.ADV_FIELDS)
        form = {
            'keywords':     keywords,
            'sort':         'desc',
            'sort2':        '',
            'rule':         'CTR',
            'secondLevel':  '0' if has_advanced else '1',
            'currentpage':  str(currentpage),
            'id':           '',
            'ckm_index':    '',
        }
        for field in self.ADV_FIELDS:
            form[field] = advanced.get(field, '') or ''
        return form

    # ── HTTP 请求 ─────────────────────────────

    def _post(self, url, data, referer=None):
        """带重试的 POST 请求"""
        headers = {}
        if referer:
            headers['Referer'] = referer

        for attempt in range(self.max_retries):
            try:
                resp = self.session.post(url, data=data, headers=headers, timeout=30)
                resp.raise_for_status()
                resp.encoding = 'utf-8'

                # 检查是否被重定向到登录页
                if 'login' in resp.url.lower():
                    raise RuntimeError(
                        "Cookie 已过期，被重定向到登录页。"
                        "请重新从浏览器获取 cookies。"
                    )
                return resp
            except requests.RequestException as e:
                self.logger.warning(f"  请求失败 ({attempt+1}/{self.max_retries}): {e}")
                if attempt < self.max_retries - 1:
                    time.sleep(self.delay * (attempt + 1))
                else:
                    raise

    # ── 搜索列表 ──────────────────────────────

    def search(self, keywords, currentpage=1, **advanced):
        """搜索并解析列表页"""
        self.logger.info(f"搜索: keywords='{keywords}', page={currentpage}")
        if any(advanced.get(k) for k in self.ADV_FIELDS):
            active = {k: v for k, v in advanced.items() if v}
            self.logger.info(f"高级搜索: {active}")

        form = self._build_form_data(keywords, currentpage, **advanced)
        self.current_search_params = form.copy()

        resp = self._post(
            self.SEARCH_URL, form,
            referer=f'{self.BASE_URL}/clinicaltrials.prosearch.dhtml',
        )

        if self.debug:
            raw_path = self.output_dir / 'raw' / f'list_page{currentpage}.html'
            raw_path.write_text(resp.text, encoding='utf-8')

        soup = BeautifulSoup(resp.text, 'html.parser')

        # FSSBBI 反爬挑战页通常是空 body 加混淆 meta/script；它不能被当作“0 条结果”。
        # debug 模式已在上方保存原始响应，方便调用方更新浏览器会话后复核。
        body = soup.body
        body_text = body.get_text(strip=True) if body else ''
        if not body_text and len(soup.find_all('meta')) >= 2:
            raise RuntimeError(
                '站点返回反爬挑战页，当前 Cookie 缺少有效浏览器会话。'
                '请在浏览器完成访问后，从实际搜索请求复制完整 cURL，并通过 Cookie 工具更新 config.json。'
            )

        # 检查是否有搜索结果
        table = soup.find('table', class_='searchTable')
        if not table:
            self.logger.warning("未找到结果表格，可能 cookie 过期或无搜索结果")
            return {
                'pagination': {'current_page': currentpage, 'total_pages': 0, 'total_records': 0},
                'trials': [],
            }

        pagination = self._parse_pagination(soup)
        trials = self._parse_trial_list(soup)

        self.logger.info(
            f"  第 {pagination['current_page']}/{pagination['total_pages']} 页, "
            f"本页 {len(trials)} 条, 共 {pagination['total_records']} 条记录"
        )
        return {'pagination': pagination, 'trials': trials}

    def _parse_pagination(self, soup):
        """解析分页信息：当前第 X 页，共 Y 页，共 Z 条记录"""
        result = {'current_page': 1, 'total_pages': 1, 'total_records': 0}

        page_info = soup.find('div', class_='pageInfo')
        if page_info:
            text = page_info.get_text()
            # 尝试正则匹配
            m = re.search(r'当前第\s*(\d+)\s*页.*?共\s*(\d+)\s*页.*?共\s*(\d+)\s*条', text)
            if m:
                result['current_page'] = int(m.group(1))
                result['total_pages']  = int(m.group(2))
                result['total_records'] = int(m.group(3))
            else:
                # 从 <i> 标签提取
                i_tags = page_info.find_all('i')
                if len(i_tags) >= 3:
                    try:
                        result['current_page']  = int(i_tags[0].get_text(strip=True))
                        result['total_pages']   = int(i_tags[1].get_text(strip=True))
                        result['total_records'] = int(i_tags[2].get_text(strip=True))
                    except ValueError:
                        pass
        return result

    def _parse_trial_list(self, soup):
        """解析试验列表，提取每条的 id / ckm_index / 基本信息"""
        trials = []
        table = soup.find('table', class_='searchTable')
        if not table:
            return trials

        for row in table.find_all('tr'):
            cells = row.find_all('td')
            if len(cells) < 6:
                continue  # 跳过标题行

            link = cells[1].find('a')
            if not link:
                continue

            trial = {
                'seq':        cells[0].get_text(strip=True).replace('\xa0', ''),
                'id':         link.get('id', ''),
                'ckm_index':  link.get('name', ''),
                'reg_no':     cells[1].get_text(strip=True),
                'state':      cells[2].get_text(strip=True).replace('\xa0', ' '),
                'drug_name':  cells[3].get_text(strip=True),
                'indication': cells[4].get_text(strip=True),
                'title':      cells[5].get_text(strip=True),
            }
            trials.append(trial)
        return trials

    # ── 详情页 ────────────────────────────────

    def get_detail(self, trial, source_page=1):
        """获取详情页，并固定输出 RAG JSON；Word 下载作为并行归档产物。"""
        reg_no = trial['reg_no']
        trial_id = trial['id']

        self.logger.info(
            f"  -> 详情: {reg_no} (id={trial_id})"
        )

        # 构建表单数据（复用搜索参数 + 设置 id/ckm_index）
        form = self.current_search_params.copy()
        form['id'] = trial_id
        form['ckm_index'] = trial['ckm_index']
        form['currentpage'] = str(source_page)

        # POST 获取详情页
        try:
            resp = self._post(
                self.DETAIL_URL, form,
                referer=self.SEARCH_URL,
            )
        except Exception as e:
            self.logger.error(f"  获取详情页失败: {e}")
            return {'reg_no': reg_no, 'success': False, 'error': str(e)}

        # raw 是 JSON 的可追溯来源，始终保存，避免与 --debug 标志耦合。
        raw_path = self.output_dir / 'raw' / f'{reg_no}_detail.html'
        raw_path.write_text(resp.text, encoding='utf-8')

        # JSON 严格从落盘后的 raw HTML 解析，确保 RAG 数据可追溯、可离线重建。
        raw_html = raw_path.read_text(encoding='utf-8')
        soup = BeautifulSoup(raw_html, 'html.parser')

        # JSON 为主数据集：不再只在 Word 下载失败时才执行。
        json_result = self._extract_json(soup, reg_no, trial, source_page=source_page)
        if not json_result:
            self.logger.error(f"  [FAIL] 未能提取 JSON 数据: {reg_no}")
            return {'reg_no': reg_no, 'trial_id': trial_id, 'success': False,
                    'error': '未能从详情页提取 JSON', 'raw_path': str(raw_path)}

        content_hash = json_result['content_hash']
        prior_hash = self.state['trials'].get(reg_no, {}).get('content_hash')
        prior_hash = prior_hash or self._existing_json_hash(reg_no)
        unchanged = self.incremental and prior_hash == content_hash

        result = {
            'reg_no': reg_no,
            'trial_id': trial_id,
            'success': True,
            'raw_path': str(raw_path),
            'json_path': str(json_result['path']),
            'content_hash': content_hash,
            'changed': not unchanged,
            'word_path': None,
        }

        # 已存在且正文未变化时，仅更新状态和 raw，不重复写 JSON / 下载 Word。
        if unchanged:
            result['method'] = 'unchanged'
            result['skipped'] = True
            self.logger.info('  [UNCHANGED] 内容指纹未变化，跳过 JSON 重写和 Word 下载')
        else:
            json_result['path'] = self._write_json(json_result['data'], reg_no)
            result['json_path'] = str(json_result['path'])
            result['method'] = 'json'
            self.logger.info(f"  [OK] JSON 数据已保存: {json_result['path'].name}")

            # Word 是附加归档；失败不影响 JSON/RAG 数据成功。
            word_path = self._try_download_word(soup, reg_no, form)
            if word_path:
                result['word_path'] = str(word_path)
                self.logger.info(f"  [OK] Word 文档已保存: {word_path.name}")
            else:
                self.logger.warning('  [WARN] Word 下载失败，但 JSON 已成功保存')

        self.state['trials'][reg_no] = {
            'content_hash': content_hash,
            'last_seen_at': datetime.now().isoformat(),
            'trial_id': trial_id,
            'json_path': str(json_result['path']),
        }
        return result

    # ── Word 下载 ─────────────────────────────

    def _try_download_word(self, soup, reg_no, form_data):
        """
        按详情页“下载”按钮所属 form 精确模拟浏览器提交。

        实际页面形式：
          <form action="...?_export=doc" method="post">
            <input type="hidden" name="id" value="...">
            <button class="download" type="submit">下载</button>
          </form>
        因此只发送此 form 中的成功控件，不混入搜索表单的 keywords、分页等字段。
        """
        word_dir = self.output_dir / 'word'
        download_elem = self._find_download_element(soup)
        candidates = []

        if download_elem:
            download_form = download_elem.find_parent('form')
            if download_form:
                action = download_form.get('action', '')
                method = download_form.get('method', 'post').lower()
                payload = self._extract_form_fields(download_form)
                if not payload.get('id'):
                    payload['id'] = form_data.get('id', '')
                if action and payload.get('id'):
                    candidates.append((action, method, payload, 'detail_download_form'))
                    self.logger.debug(
                        f"  按下载 form 提交: action={action}, method={method}, fields={list(payload)}"
                    )

        # 仅在下载 form 缺失或提交失败时才兜底；默认 id-only，仍贴近页面实际行为。
        fallback_payload = {'id': form_data.get('id', '')}
        candidates.append((f"{self.DETAIL_URL}?_export=doc", 'post', fallback_payload, 'id_only_fallback'))

        seen = set()
        for url, method, payload, source in candidates:
            full_url = self._normalize_url(url)
            request_key = (full_url, method, tuple(sorted(payload.items())))
            if request_key in seen:
                continue
            seen.add(request_key)
            try:
                if method == 'get':
                    resp = self.session.get(full_url, params=payload, timeout=30)
                else:
                    resp = self.session.post(full_url, data=payload, timeout=30)
                resp.raise_for_status()
                content_type = resp.headers.get('Content-Type', '')
                self.logger.debug(
                    f"  下载响应[{source}]: status={resp.status_code}, type={content_type}, bytes={len(resp.content)}"
                )
                if self._is_word_response(content_type, resp.content):
                    return self._save_word(resp, reg_no, word_dir)
                self.logger.warning(f"  下载响应不是 Word 文档: {source}, Content-Type={content_type}")
            except requests.RequestException as e:
                self.logger.debug(f"  下载尝试失败 ({source}): {e}")

        self.logger.debug(f"  Word 下载失败: {reg_no}")
        return None

    @staticmethod
    def _extract_form_fields(form):
        """提取 HTML form 会随提交发送的字段，含隐藏 input/select/textarea。"""
        fields = {}
        for control in form.find_all(['input', 'select', 'textarea']):
            if control.has_attr('disabled'):
                continue
            name = control.get('name')
            if not name:
                continue
            control_type = control.get('type', '').lower()
            if control_type in ('submit', 'button', 'reset', 'file'):
                continue
            if control_type in ('checkbox', 'radio') and not control.has_attr('checked'):
                continue
            if control.name == 'select':
                option = control.find('option', selected=True) or control.find('option')
                value = option.get('value', '') if option else ''
            elif control.name == 'textarea':
                value = control.get_text()
            else:
                value = control.get('value', '')
            fields[name] = value
        return fields

    def _find_download_element(self, soup):
        """在页面中查找下载按钮/链接"""
        # 优先查找 class="download" 的按钮（网站实际使用的模式）
        elem = soup.find('button', class_='download')
        if elem:
            return elem
        elem = soup.find('a', class_='download')
        if elem:
            return elem

        patterns = [
            ('button', {'string': re.compile('下载')}),
            ('a',      {'string': re.compile('下载')}),
            ('input',  {'value': re.compile('下载')}),
            ('button', {'onclick': re.compile(r'download|export|doc', re.I)}),
            ('a',      {'onclick': re.compile(r'download|export|doc', re.I)}),
            ('a',      {'href': re.compile(r'export|download|\.doc', re.I)}),
        ]
        for tag, attrs in patterns:
            elem = soup.find(tag, attrs=attrs)
            if elem:
                return elem

        # 查找包含 export action 的 form 中的提交按钮
        for form in soup.find_all('form'):
            action = form.get('action', '')
            if '_export' in action or 'download' in action.lower():
                btn = form.find('button')
                if btn:
                    return btn
        return None

    def _extract_download_url(self, elem, soup):
        """从元素的 onclick/href/父form action 提取下载 URL"""
        onclick = elem.get('onclick', '')
        href = elem.get('href', '')

        # 从父 form 的 action 属性提取（网站实际使用的模式）
        parent_form = elem.find_parent('form')
        if parent_form:
            action = parent_form.get('action', '')
            if action and '_export' in action:
                return action

        # 从 onclick 解析
        if onclick:
            # location.href='xxx' 或 location="xxx"
            m = re.search(r"""location(?:\.href)?\s*=\s*['"]([^'"]+)['"]""", onclick)
            if m:
                return m.group(1)

            # action='xxx' 或 action="xxx"
            m = re.search(r"""action\s*[=:]\s*['"]([^'"]+)['"]""", onclick)
            if m:
                return m.group(1)

            # functionName() - 查找函数定义中的 URL
            func_m = re.search(r'(\w+)\s*\(\)', onclick)
            if func_m:
                func_name = func_m.group(1)
                # 在 <script> 标签中查找函数定义
                for script in soup.find_all('script'):
                    text = script.string or script.get_text()
                    if text and func_name in text:
                        m = re.search(r"""action\s*[=:]\s*['"]([^'"]+)['"]""", text)
                        if m:
                            return m.group(1)
                        m = re.search(r"""location(?:\.href)?\s*=\s*['"]([^'"]+)['"]""", text)
                        if m:
                            return m.group(1)

        # 从 href 解析
        if href and href not in ('javascript:void(0)', '#', ''):
            return href

        return None

    def _normalize_url(self, url):
        """将相对 URL 转为绝对 URL"""
        if url.startswith('http'):
            return url
        if url.startswith('/'):
            return self.BASE_URL + url
        return f"{self.BASE_URL}/{url}"

    def _is_word_response(self, content_type, content):
        """判断响应是否为 Word 文档（含 Word 2003 XML）"""
        word_types = [
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/octet-stream',
            'application/xml',
            'text/xml',
        ]
        normalized_type = content_type.lower()
        if any(wt in normalized_type for wt in word_types):
            return (
                content[:4] == b'\xd0\xcf\x11\xe0' or
                content[:2] == b'PK' or
                b'<w:wordDocument' in content[:4096] or
                b'<?mso-application progid="Word.Document"?>' in content[:4096]
            )
        # 检查二进制 DOC、DOCX 和 Word 2003 XML 特征
        return (
            content[:4] == b'\xd0\xcf\x11\xe0' or
            content[:2] == b'PK' or
            b'<w:wordDocument' in content[:4096] or
            b'<?mso-application progid="Word.Document"?>' in content[:4096]
        )

    def _save_word(self, resp, reg_no, word_dir):
        """保存网页原始下载文件，并额外生成兼容用的 DOCX。"""
        content = resp.content
        content_type = resp.headers.get('Content-Type', '').lower()

        # 保留与浏览器点击“下载”得到的字节完全一致的文件，作为主交付物。
        # 当前平台返回 Word 2003 XML，但浏览器会按 .doc 文件名保存。
        browser_doc_path = word_dir / f"{reg_no}.doc"
        browser_doc_path.write_bytes(content)

        # 同时在 source/ 中保存一份明确标识为原始响应的副本，便于溯源与校验。
        source_dir = word_dir / 'source'
        source_dir.mkdir(parents=True, exist_ok=True)
        source_path = source_dir / f"{reg_no}.source.doc"
        source_path.write_bytes(content)

        # WordML 额外转换为标准 OOXML DOCX，供不接受 XML .doc 的客户端使用。
        is_wordml = (
            b'<w:wordDocument' in content[:4096] or
            b'<?mso-application progid="Word.Document"?>' in content[:4096]
        )
        if is_wordml:
            docx_path = word_dir / f"{reg_no}.docx"
            try:
                import subprocess
                proc = subprocess.run(
                    ['/usr/bin/textutil', '-convert', 'docx', str(browser_doc_path),
                     '-output', str(docx_path)],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                if proc.returncode == 0 and docx_path.exists() and docx_path.stat().st_size > 0:
                    self.logger.info(f"  原始网页文件: {browser_doc_path.name}; 兼容 DOCX: {docx_path.name}")
                    return browser_doc_path
                self.logger.warning(
                    f"  WordML 转 DOCX 失败，仍已保存网页原文件: {proc.stderr.strip() or '未知错误'}"
                )
            except Exception as e:
                self.logger.warning(f"  WordML 转 DOCX 异常，仍已保存网页原文件: {e}")
            return browser_doc_path

        # 二进制 DOC / OOXML DOCX：主交付物即服务端原始下载内容。
        is_docx = content[:2] == b'PK' or 'openxmlformats' in content_type
        if is_docx:
            docx_path = word_dir / f"{reg_no}.docx"
            docx_path.write_bytes(content)
            return docx_path
        return browser_doc_path

    # ── JSON 提取 ─────────────────────────────

    def _extract_json(self, soup, reg_no, trial_info, source_page=None):
        """从详情页提取 RAG 友好的结构化数据（不直接写文件）。"""
        # 页面可能有多个 paddingSide15 div，找到包含表格的那个
        content_div = None
        for div in soup.find_all('div', class_='paddingSide15'):
            if div.find('table'):
                content_div = div
                break

        if not content_div:
            self.logger.debug(f"  未找到含内容的 paddingSide15 div: {reg_no}")
            # 尝试其他容器
            content_div = soup.find('div', class_='padding15')
            if not content_div:
                content_div = soup.find('div', class_='container')
            if not content_div:
                return None

        data = {
            'schema_version': 2,
            'source': {
                'platform': '中国药物临床试验登记与信息公示平台',
                'detail_url': self.DETAIL_URL,
                'raw_html_path': str(self.output_dir / 'raw' / f'{reg_no}_detail.html'),
                'source_page': source_page,
            },
            'reg_no':      reg_no,
            'scrape_time': datetime.now().isoformat(),
            'list_info': {
                'seq':        trial_info.get('seq', ''),
                'state':      trial_info.get('state', ''),
                'drug_name':  trial_info.get('drug_name', ''),
                'indication': trial_info.get('indication', ''),
                'title':      trial_info.get('title', ''),
            },
            'details':    {},
            'sections':   {},
            'full_text':  '',
        }

        current_section = '基本信息'
        data['sections'][current_section] = {}

        # 遍历内容，按标题分节
        # 网站使用 searchDetailPartTit (大节标题) 和 sDPTit2 (小节标题) 作为分区
        for elem in content_div.descendants:
            if not isinstance(elem, Tag):
                continue

            # 标题元素 → 新 section
            if elem.name in ('h2', 'h3', 'h4', 'h5'):
                text = elem.get_text(strip=True)
                if text and len(text) < 50:
                    current_section = text
                    data['sections'].setdefault(current_section, {})

            # 网站特有的大节标题类名
            elif elem.get('class') and 'searchDetailPartTit' in elem.get('class', []):
                text = elem.get_text(strip=True)
                if text and len(text) < 80:
                    current_section = text
                    data['sections'].setdefault(current_section, {})

            # 网站特有的小节标题类名 → 作为子节
            elif elem.get('class') and 'sDPTit2' in elem.get('class', []):
                text = elem.get_text(strip=True)
                if text and len(text) < 80:
                    current_section = text
                    data['sections'].setdefault(current_section, {})

            # 表格 → 提取键值对
            elif elem.name == 'table':
                # 确保不重复处理嵌套表格
                if elem.find_parent('table') is None:
                    section_data = data['sections'].setdefault(current_section, {})
                    self._extract_table_kv(elem, section_data)
                    self._extract_table_kv(elem, data['details'])

        # 解析 dl/dt/dd 结构
        for dl in content_div.find_all('dl'):
            dt = dl.find('dt')
            dd = dl.find('dd')
            if dt and dd:
                key = dt.get_text(strip=True).rstrip('：: ')
                val = dd.get_text(strip=True)
                if key and val:
                    data['details'][key] = val
                    data['sections'].setdefault(current_section, {})[key] = val

        # 保存全文文本并生成稳定内容指纹；该指纹是每日增量判定依据。
        data['full_text'] = content_div.get_text(separator='\n', strip=True)

        # 如果没有提取到任何结构化数据，但有全文 → 仍然返回，供 RAG 使用。
        if not data['details'] and not data['full_text']:
            self.logger.warning(f"  详情页无有效内容: {reg_no}")
            return None

        # 为 RAG 提供按章节切分的文本块；超长章节再按约 4,000 字符拆分。
        chunks = []
        max_chunk_chars = 4000
        for section_name, fields in data['sections'].items():
            if not fields:
                continue
            lines = [f'{key}: {value}' for key, value in fields.items()]
            parts, current_lines, current_size = [], [], 0
            for line in lines:
                line_size = len(line) + 1
                if current_lines and current_size + line_size > max_chunk_chars:
                    parts.append('\n'.join(current_lines))
                    current_lines, current_size = [], 0
                current_lines.append(line)
                current_size += line_size
            if current_lines:
                parts.append('\n'.join(current_lines))
            for part_no, text in enumerate(parts, 1):
                chunks.append({
                    'chunk_id': f'{reg_no}::{section_name}::{part_no}',
                    'section': section_name,
                    'part': part_no,
                    'text': text,
                    'metadata': {'reg_no': reg_no, 'section': section_name, 'part': part_no},
                })
        data['rag_chunks'] = chunks
        data['content_hash'] = self._content_hash(data['full_text'])
        return {'data': data, 'content_hash': data['content_hash'], 'path': self.output_dir / 'json' / f'{reg_no}.json'}

    def _write_json(self, data, reg_no):
        """原子写入 RAG JSON，避免任务中断得到半写入文件。"""
        filepath = self.output_dir / 'json' / f'{reg_no}.json'
        temp_path = filepath.with_suffix('.tmp')
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        temp_path.replace(filepath)
        return filepath

    def _extract_table_kv(self, table, data_dict):
        """从表格中提取键值对"""
        for row in table.find_all('tr'):
            cells = row.find_all(['th', 'td'])
            if len(cells) < 2:
                continue

            # 两列：key | value
            if len(cells) == 2:
                key = cells[0].get_text(strip=True).rstrip('：: ')
                val = cells[1].get_text(strip=True)
                if key and val and key not in ('序号',):
                    data_dict[key] = val

            # 多列：key | value | key | value ...
            elif len(cells) >= 4 and len(cells) % 2 == 0:
                for i in range(0, len(cells), 2):
                    key = cells[i].get_text(strip=True).rstrip('：: ')
                    val = cells[i + 1].get_text(strip=True) if i + 1 < len(cells) else ''
                    if key and val:
                        data_dict[key] = val

    # ── 主流程 ────────────────────────────────

    def run(self, keywords, max_pages=None, resume=False, **advanced):
        """运行完整抓取流程；--incremental 时仅保存内容有变化的详情 JSON。"""
        self.logger.info("=" * 60)
        self.logger.info(f"开始抓取 | 关键词: '{keywords}'")
        if any(advanced.get(k) for k in self.ADV_FIELDS):
            active = {k: v for k, v in advanced.items() if v}
            self.logger.info(f"高级搜索条件: {active}")
        if resume:
            self.logger.info("断点续抓模式: 已存在的文件将跳过")
        if self.incremental:
            self.logger.info("增量模式: 每次仍读取详情页，但只写入正文内容发生变化的 JSON")
        self.logger.info("=" * 60)

        # 第一页搜索
        result = self.search(keywords, currentpage=1, **advanced)
        pagination = result['pagination']
        total_pages = pagination['total_pages']
        total_records = pagination['total_records']

        if total_records == 0:
            self.logger.warning("未找到任何记录，请检查关键词或 cookies")
            return {'total_records': 0, 'success_count': 0, 'fail_count': 0}

        if max_pages:
            total_pages = min(total_pages, max_pages)
            self.logger.info(f"限制抓取 {total_pages} 页（共 {total_records} 条记录）")
        else:
            self.logger.info(f"将抓取全部 {total_pages} 页，共 {total_records} 条记录")

        # 收集所有页的试验条目
        all_trials = []
        for page in range(1, total_pages + 1):
            if page > 1:
                time.sleep(self.delay)
                self.logger.info(f"\n--- 翻页: 第 {page}/{total_pages} 页 ---")
                result = self.search(keywords, currentpage=page, **advanced)

            for trial in result['trials']:
                trial['source_page'] = page
                all_trials.append(trial)

        total_trials = len(all_trials)
        self.logger.info(f"\n共收集 {total_trials} 条试验，开始逐条获取详情...")
        self.logger.info("=" * 60)

        # 逐条获取详情
        results = []
        success_count = 0
        fail_count = 0
        word_count = 0
        json_count = 0
        skip_count = 0

        for i, trial in enumerate(all_trials, 1):
            reg_no = trial['reg_no']
            title_short = trial['title'][:40] + ('...' if len(trial['title']) > 40 else '')

            self.logger.info(f"\n[{i}/{total_trials}] {reg_no} - {title_short}")

            # 断点续抓只适合“尚未取得详情”的中断恢复。
            # 增量模式必须请求详情页，计算正文指纹后才能判断是否发生变化。
            if resume and not self.incremental:
                existing_json = self.output_dir / 'json' / f'{reg_no}.json'
                if existing_json.exists():
                    skip_count += 1
                    json_count += 1
                    success_count += 1
                    results.append({
                        'reg_no': reg_no, 'success': True,
                        'method': 'json', 'json_path': str(existing_json),
                        'skipped': True,
                    })
                    self.logger.info(f"  [SKIP] JSON 已存在: {existing_json.name}")
                    continue

            # 获取详情
            try:
                detail = self.get_detail(trial, source_page=trial['source_page'])
                results.append(detail)

                if detail['success']:
                    success_count += 1
                    if detail.get('method') == 'unchanged':
                        skip_count += 1
                    else:
                        json_count += 1
                    if detail.get('word_path'):
                        word_count += 1
                else:
                    fail_count += 1
            except Exception as e:
                self.logger.error(f"  [FAIL] {e}")
                results.append({
                    'reg_no': reg_no, 'success': False, 'error': str(e),
                })
                fail_count += 1

            # 请求间隔
            if i < total_trials:
                time.sleep(self.delay)

        # 所有详情处理完成后保存内容指纹状态，供下次每日增量同步。
        self._save_state()

        # 保存汇总
        summary = {
            'keywords':       keywords,
            'advanced_search': {k: v for k, v in advanced.items() if v},
            'scrape_time':    datetime.now().isoformat(),
            'incremental_mode': self.incremental,
            'total_records':  total_records,
            'total_pages':    total_pages,
            'total_extracted': total_trials,
            'success_count':  success_count,
            'fail_count':     fail_count,
            'skip_count':     skip_count,
            'word_count':     word_count,
            'json_count':     json_count,
            'results':        results,
        }

        summary_path = self.output_dir / 'summary.json'
        with open(summary_path, 'w', encoding='utf-8') as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

        # 最终统计
        self.logger.info("\n" + "=" * 60)
        self.logger.info("抓取完成!")
        self.logger.info(f"  关键词:     {keywords}")
        self.logger.info(f"  总页数:     {total_pages}")
        self.logger.info(f"  总记录数:   {total_records}")
        self.logger.info(f"  成功处理:   {success_count} (Word: {word_count}, JSON新增/更新: {json_count})")
        if skip_count:
            label = '未变化跳过' if self.incremental else '续抓跳过'
            self.logger.info(f"  {label}: {skip_count}")
        self.logger.info(f"  失败:       {fail_count}")
        self.logger.info(f"  汇总文件:   {summary_path}")
        self.logger.info("=" * 60)

        return summary

    def _find_existing_output(self, reg_no):
        """检查是否已有输出文件（用于断点续抓）"""
        for ext in ['.doc', '.docx']:
            path = self.output_dir / 'word' / f"{reg_no}{ext}"
            if path.exists():
                return path
        path = self.output_dir / 'json' / f"{reg_no}.json"
        if path.exists():
            return path
        return None


# ──────────────────────────────────────────────
# 命令行入口
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='中国药物临床试验登记与信息公示平台 - 信息提取工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 基本搜索
  python scraper.py --keywords "胰腺癌" --cookies "FSSBBIl1UgzbN7N80S=xxx; token=xxx"

  # 从配置文件加载
  python scraper.py --config config.json

  # 高级搜索
  python scraper.py --keywords "肺癌" --state "招募中" --drugs-type 2 --cookies "..."

  # 限制页数 + 断点续抓
  python scraper.py --keywords "胰腺癌" --max-pages 2 --resume --cookies "..."

  # 每日增量同步（正文无变化时不重写 JSON、不重复下载 Word）
  python scraper.py --keywords "胰腺癌" --incremental --cookies "..."

  # 所有详情 raw HTML 均会保存，方便离线重建 JSON
  python scraper.py --keywords "胰腺癌" --cookies "..."
        """
    )

    # ── 搜索参数 ──
    s = parser.add_argument_group('搜索参数')
    s.add_argument('--keywords', '-k', type=str, default='胰腺癌',
                   help='搜索关键词 (默认: 胰腺癌)')
    s.add_argument('--reg-no', type=str, default='', help='登记号')
    s.add_argument('--indication', type=str, default='', help='适应症')
    s.add_argument('--case-no', type=str, default='', help='试验方案编号')
    s.add_argument('--drugs-name', type=str, default='', help='药物名称')
    s.add_argument('--drugs-type', type=str, default='',
                   choices=['', '1', '2', '3'],
                   help='药物类型 (1=中药/天然药物, 2=化学药物, 3=生物制品)')
    s.add_argument('--appliers', type=str, default='', help='申请人')
    s.add_argument('--communities', type=str, default='', help='伦理委员会')
    s.add_argument('--researchers', type=str, default='', help='主要研究者')
    s.add_argument('--agencies', type=str, default='', help='临床参加机构')
    s.add_argument('--state', type=str, default='',
                   choices=ChinaDrugTrialsScraper.STATES,
                   help='试验状态')

    # ── 连接参数 ──
    c = parser.add_argument_group('连接参数')
    c.add_argument('--cookies', type=str, default=None,
                   help='Cookie 字符串 (从浏览器开发者工具复制)')
    c.add_argument('--cookies-file', type=str, default=None,
                   help='Cookie 文件路径 (纯文本或 JSON)')
    c.add_argument('--config', type=str, default=None,
                   help='JSON 配置文件路径')

    # ── 运行参数 ──
    r = parser.add_argument_group('运行参数')
    r.add_argument('--output', '-o', type=str, default='output',
                   help='输出根目录 (默认: output)')
    r.add_argument('--max-pages', type=int, default=None,
                   help='最大翻页数 (默认: 全部)')
    r.add_argument('--delay', type=float, default=1.5,
                   help='请求间隔秒数 (默认: 1.5)')
    r.add_argument('--max-retries', type=int, default=3,
                   help='最大重试次数 (默认: 3)')
    r.add_argument('--resume', action='store_true',
                   help='断点续抓：跳过已有 JSON 的记录')
    r.add_argument('--incremental', action='store_true',
                   help='每日增量同步：按登记号+正文指纹，仅写入新增或变更的 JSON')
    r.add_argument('--debug', action='store_true',
                   help='兼容参数：详情 raw HTML 现在始终保存到 raw/ 目录')

    args = parser.parse_args()

    # 从配置文件加载
    if args.config:
        with open(args.config, 'r', encoding='utf-8') as f:
            config = json.load(f)
        args.cookies = args.cookies or config.get('cookies')
        args.cookies_file = args.cookies_file or config.get('cookies_file')
        args.keywords = config.get('keywords', args.keywords)
        args.output = config.get('output', args.output)
        args.max_pages = config.get('max_pages', args.max_pages)
        args.delay = config.get('delay', args.delay)
        args.incremental = args.incremental or bool(config.get('incremental', False))
        for field in ChinaDrugTrialsScraper.ADV_FIELDS:
            arg_name = field.replace('_', '_')  # already underscore
            if not getattr(args, arg_name):
                setattr(args, arg_name, config.get(field, ''))

    # 验证 cookies
    if not args.cookies and not args.cookies_file:
        parser.error("必须提供 --cookies 或 --cookies-file 或 --config")

    # 输出目录：output/<关键词>/
    safe_kw = re.sub(r'[^\w\u4e00-\u9fff]', '_', args.keywords)
    output_dir = os.path.join(args.output, safe_kw)

    # 创建抓取器
    scraper = ChinaDrugTrialsScraper(
        cookies_str=args.cookies,
        cookies_file=args.cookies_file,
        output_dir=output_dir,
        delay=args.delay,
        max_retries=args.max_retries,
        debug=args.debug,
        incremental=args.incremental,
    )

    # 构建高级搜索参数
    advanced = {
        'reg_no':      args.reg_no,
        'indication':  args.indication,
        'case_no':     args.case_no,
        'drugs_name':  args.drugs_name,
        'drugs_type':  args.drugs_type,
        'appliers':    args.appliers,
        'communities': args.communities,
        'researchers': args.researchers,
        'agencies':    args.agencies,
        'state':       args.state,
    }

    # 运行
    try:
        scraper.run(
            keywords=args.keywords,
            max_pages=args.max_pages,
            resume=args.resume,
            **advanced,
        )
        return 0
    except KeyboardInterrupt:
        scraper.logger.info("\n用户中断，已保存部分结果")
        return 130
    except Exception as e:
        scraper.logger.error(f"运行失败: {e}", exc_info=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
