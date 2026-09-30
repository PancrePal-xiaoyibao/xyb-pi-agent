#!/usr/bin/env python3
"""将已保存的详情页 raw HTML 批量转换为 RAG JSON，无需重新访问网站。"""

import argparse
import json
import re
from datetime import datetime
from pathlib import Path

from bs4 import BeautifulSoup

from scraper import ChinaDrugTrialsScraper


def infer_list_info(soup, reg_no):
    """尽量从详情页首个表格恢复检索列表中的基础字段。"""
    text = soup.get_text(' ', strip=True)
    return {
        'seq': '',
        'state': '',
        'drug_name': '',
        'indication': '',
        'title': '',
        'source': 'raw_html_backfill',
        'reg_no_hint': reg_no,
        'page_text_preview': text[:300],
    }


def main():
    parser = argparse.ArgumentParser(
        description='将 raw/*.html 详情页批量补建为 RAG JSON（不访问网站）。'
    )
    parser.add_argument('--output', default='output/胰腺癌', help='目标检索输出目录')
    parser.add_argument('--force', action='store_true', help='覆盖已存在 JSON')
    args = parser.parse_args()

    output_dir = Path(args.output).expanduser().resolve()
    raw_dir = output_dir / 'raw'
    json_dir = output_dir / 'json'
    if not raw_dir.exists():
        raise SystemExit(f'未找到 raw 目录: {raw_dir}')

    # 此离线任务不走网络，仅借用统一解析和原子写入实现。
    scraper = ChinaDrugTrialsScraper.__new__(ChinaDrugTrialsScraper)
    scraper.output_dir = output_dir
    scraper.state_path = output_dir / 'state.json'

    # _extract_json / _load_state 需要 logger，使用轻量控制台日志。
    import logging
    scraper.logger = logging.getLogger('raw_backfill')
    if not scraper.logger.handlers:
        scraper.logger.addHandler(logging.StreamHandler())
    scraper.logger.setLevel(logging.INFO)

    # 复用已有增量状态，避免“仅跳过已存在 JSON”时将原 state.json 覆盖为空。
    scraper._load_state()

    json_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(raw_dir.glob('*_detail.html'))
    created, skipped, failed = 0, 0, 0

    for html_path in files:
        reg_no = re.sub(r'_detail$', '', html_path.stem)
        target = json_dir / f'{reg_no}.json'
        if target.exists() and not args.force:
            skipped += 1
            continue
        try:
            html = html_path.read_text(encoding='utf-8')
            soup = BeautifulSoup(html, 'html.parser')
            result = scraper._extract_json(
                soup=soup,
                reg_no=reg_no,
                trial_info=infer_list_info(soup, reg_no),
                source_page=None,
            )
            if not result:
                failed += 1
                print(f'[FAIL] {reg_no}: 未找到可提取正文')
                continue
            data = result['data']
            data['source']['backfilled_from_raw_at'] = datetime.now().isoformat()
            scraper._write_json(data, reg_no)
            scraper.state['trials'][reg_no] = {
                'content_hash': result['content_hash'],
                'last_seen_at': datetime.now().isoformat(),
                'json_path': str(target),
            }
            created += 1
            print(f'[OK] {reg_no}: {len(data["details"])} fields, {len(data["rag_chunks"])} RAG chunks')
        except Exception as e:
            failed += 1
            print(f'[FAIL] {reg_no}: {e}')

    scraper._save_state()
    manifest = {
        'created_at': datetime.now().isoformat(),
        'source': str(raw_dir),
        'created': created,
        'skipped': skipped,
        'failed': failed,
        'total_raw_files': len(files),
    }
    with open(output_dir / 'json_backfill_summary.json', 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f'完成: 新建 {created}, 跳过 {skipped}, 失败 {failed}, 共 {len(files)}')


if __name__ == '__main__':
    main()
