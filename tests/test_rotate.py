#!/usr/bin/env python3
"""memory_rotate.py 的回归测试（只用标准库）。

    python3 tests/test_rotate.py

守两条真机上踩过的坑：

1. **「第 7 天」复习项**：默认保留 7 天时 `today-7` 的日记已被归档，
   只能从长期总库取；若按「天数 <= 保留期」判断来源，第 7 天永远缺失。
2. **区间块**：总库里可能是 `### 2026-10-19 ~ 2026-10-24`（手工/早期迁移格式），
   `find_day_block` 必须能按区间命中，否则同样取不到。
"""
import datetime as dt
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

# Windows 控制台默认 GBK，打不出勾叉 —— 强制 UTF-8 输出
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'memory_rotate.py'

passed = 0
failed = 0


def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  [PASS] {name}')
    else:
        failed += 1
        print(f'  [FAIL] {name}' + (f' -- {detail}' if detail else ''))


def day(n):
    return (dt.date.today() - dt.timedelta(days=n)).isoformat()


def run_rotate(base, extra=()):
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'}
    return subprocess.run(
        [sys.executable, str(SCRIPT), '--base', str(base), *extra],
        capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)


def main():
    base = pathlib.Path(tempfile.mkdtemp(prefix='memtest-'))
    try:
        (base / 'diary').mkdir()
        (base / 'memory-bank' / '2026' / '2026.10').mkdir(parents=True)

        # 最近 6 天各一篇日记（保留期内）
        for i in range(6):
            (base / 'diary' / f'{day(i)}.md').write_text(
                f'# {day(i)}\n\n## [私聊]\n- 第 {i} 天的事\n', encoding='utf-8')

        # 第 7 天：不在 diary 里（模拟已被归档），只在总库的**区间块**里
        (base / 'memory-bank' / '2026' / '2026.10' / 'range.md').write_text(
            f'# 长期记忆\n\n### {day(10)} ~ {day(7)}\n\n## [私聊]\n- 第 7 天区间块里的事\n',
            encoding='utf-8')

        r = run_rotate(base, ('--apply',))
        check('轮转能跑通', r.returncode == 0, ((r.stderr or '') + (r.stdout or ''))[-300:])

        review = (base / 'review-due.md').read_text(encoding='utf-8')
        check('复习队列含「第 1 天」', '第 1 天' in review)
        check('复习队列含「第 7 天」（按文件存在性兜底）', '第 7 天' in review, review[:400])
        check('第 7 天内容来自区间块', '区间块里的事' in review, review[:400])

        short = (base / 'short-memory.md').read_text(encoding='utf-8')
        check('短期记忆按分区块生成', '## [私聊]' in short)
        check('短期记忆不含已归档的第 7 天', '区间块里的事' not in short)

        r2 = run_rotate(base)
        check('预演（不带 --apply）也能跑', r2.returncode == 0, (r2.stderr or '')[-200:])
    finally:
        shutil.rmtree(base, ignore_errors=True)

    print(f'\n结果：{passed} 通过 / {failed} 失败\n')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
