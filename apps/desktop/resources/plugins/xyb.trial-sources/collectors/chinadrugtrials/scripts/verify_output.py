#!/usr/bin/env python3
"""核验中国药物临床试验抓取输出是否覆盖最近一次检索结果。"""

import argparse
import json
from pathlib import Path


ARTIFACTS = {
    "raw HTML": ("raw", lambda p: p.name.removesuffix("_detail.html"), "*_detail.html"),
    "RAG JSON": ("json", lambda p: p.stem, "*.json"),
    "网页原样 DOC": ("word", lambda p: p.stem, "*.doc"),
    "兼容 DOCX": ("word", lambda p: p.stem, "*.docx"),
    "原始响应留档": ("word/source", lambda p: p.name.removesuffix(".source.doc"), "*.source.doc"),
}


def collect_reg_nos(summary: dict) -> set[str]:
    """从抓取汇总中取得成功记录的唯一登记号。"""
    return {
        item["reg_no"].strip()
        for item in summary.get("results", [])
        if item.get("success") and isinstance(item.get("reg_no"), str) and item["reg_no"].strip()
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="核对 summary.json 中成功登记号的归档覆盖情况。"
    )
    parser.add_argument(
        "--output",
        required=True,
        help="抓取输出目录，例如 output/胰腺癌",
    )
    parser.add_argument(
        "--allow-missing-docx",
        action="store_true",
        help="允许非 macOS 环境未生成 DOCX，但仍核验 raw、JSON、DOC 和原始响应",
    )
    args = parser.parse_args()

    root = Path(args.output).expanduser().resolve()
    summary_path = root / "summary.json"
    if not summary_path.exists():
        raise SystemExit(f"未找到抓取汇总: {summary_path}")

    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"无法读取汇总 JSON: {exc}") from exc

    expected = collect_reg_nos(summary)
    if not expected:
        raise SystemExit("summary.json 未包含可核验的成功登记号。")

    print(f"输出目录: {root}")
    print(f"检索关键词: {summary.get('keywords', '')}")
    print(f"预期登记号: {len(expected)}")
    print(f"汇总状态: 成功 {summary.get('success_count', 0)}，失败 {summary.get('fail_count', 0)}，未变化跳过 {summary.get('skip_count', 0)}")

    incomplete = False
    for label, (relative_dir, normalizer, glob_pattern) in ARTIFACTS.items():
        if label == "兼容 DOCX" and args.allow_missing_docx:
            continue
        folder = root / relative_dir
        actual = {normalizer(path) for path in folder.glob(glob_pattern)} if folder.exists() else set()
        missing = sorted(expected - actual)
        extra_count = len(actual - expected)
        print(f"{label}: 覆盖 {len(expected & actual)}/{len(expected)}，缺失 {len(missing)}，额外 {extra_count}")
        if missing:
            incomplete = True
            for reg_no in missing:
                print(f"  缺失: {reg_no}")

    if incomplete:
        print("核验失败：存在缺失产物。可使用 --resume 补齐详情，或先检查 Cookie、下载响应与日志。")
        return 1

    print("核验通过：所有成功登记号均具有要求的归档产物。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
