#!/usr/bin/env python3
"""三层记忆维护（short-term / raw diary / long-term bank）。

设计目标：让长期在线的 AI 人格"记得住"，同时**不让记忆无限膨胀**。

    short-term  <MEMORY_DIR>/short-memory.md          每轮注入的短期记忆（按分区块聚合）
    raw diary   <MEMORY_DIR>/diary/YYYY-MM-DD.md      日记原料（只留最近 N 天）
    long-term   <MEMORY_DIR>/memory-bank/<年>/<年.月>/<日期范围>.md   按天留块，不写周总结
    archive     <MEMORY_DIR>/diary/archive/YYYY-MM-DD.md              归档原文
    review      <MEMORY_DIR>/review-due.md            艾宾浩斯复习队列（1/2/4/7/15 天）
    pref log    <MEMORY_DIR>/preferences.log          从日记抽出的偏好候选（待人工确认）

用法：
    python3 memory_rotate.py                 # 预演：只重建短期记忆/复习队列，过期归档不落地
    python3 memory_rotate.py --apply         # 真正归档过期日记并写入长期总库
    python3 memory_rotate.py --base ~/mem --keep-days 5 --apply

⚠️ 注意：`--apply` 会 `shutil.move` 把过期日记移进 archive/。
   包装脚本（scripts/daily-rotate.sh）会先打 tar 备份再调用它。
"""
import argparse
import datetime as dt
import os
import pathlib
import re
import shutil
import sys

BASE = pathlib.Path(os.environ.get('MEMORY_DIR') or (pathlib.Path.home() / '.ai-memory'))
DIARY = BASE / 'diary'
ARCHIVE = DIARY / 'archive'
BANK = BASE / 'memory-bank'
SHORT = BASE / 'short-memory.md'
REVIEW = BASE / 'review-due.md'
PREF_LOG = BASE / 'preferences.log'

KEEP_DAYS = 7

# ── 分区（块状）────────────────────────────────────────────────
# 为什么按分区而不是按日期聚合：注入时不同会话要看到不同分区
# （群聊只能看 [群] + [通用]，私聊全看），按日期分组会让两个来源混在一块，无法过滤。
BLOCK_ORDER = ('[群]', '[私聊]', '[通用]')
# (块内总字数上限, 单条字数上限) —— 群块最紧，避免群里堆细节
BLOCK_LIMITS = {'[群]': (240, 50), '[私聊]': (480, 70), '[通用]': (180, 60)}

REVIEW_DAYS = (1, 2, 4, 7, 15)
PREF_TRIGGERS = ('喜欢', '讨厌', '烦', '不想', '雷区', '受不了')


def parse_date(p: pathlib.Path):
    m = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})\.md', p.name)
    if not m:
        return None
    try:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def week_range(d: dt.date):
    start = d - dt.timedelta(days=d.weekday())
    return start, start + dt.timedelta(days=6)


def fmt(d: dt.date) -> str:
    return f'{d.year}.{d.month}.{d.day}'


def range_name(start: dt.date, end: dt.date) -> str:
    return f'{fmt(start)}-{fmt(end)}.md'


def bullets(text: str):
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('- ') and len(s) > 4:
            out.append(s[2:].strip())
        elif s.startswith('## '):
            out.append(f'[{s[3:]}]')
    return out


def _block_of_heading(title):
    """小节标题 -> 分区。新格式直接认 [群]/[私聊]/[通用]；旧格式按关键词迁移。"""
    t = (title or '').strip()
    for b in BLOCK_ORDER:
        if t.startswith(b):
            return b
    if any(k in t for k in ('心情', '感想', '偏好', '结论', '备忘')):
        return '[通用]'
    return '[私聊]'


def _parse_diary_blocks(p):
    """把一篇日记解析成 {分区: [条目]}。裸 bullet 归 [私聊]（日记通常只在私聊里写）。"""
    out = {b: [] for b in BLOCK_ORDER}
    cur = '[私聊]'
    for raw in p.read_text(encoding='utf-8').splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.startswith('## '):
            cur = _block_of_heading(line[3:]) or cur
            continue
        if line.startswith('# '):
            continue
        s = line.lstrip()
        if not s.startswith('- '):
            continue
        item = s[2:].strip()
        if item:
            out[cur].append(item)
    return out


def build_short(today: dt.date, keep_days: int):
    """块状分区短期记忆：跨最近 N 天按分区聚合，各块独立限字。"""
    collected = {b: [] for b in BLOCK_ORDER}
    for i in range(keep_days):
        d = today - dt.timedelta(days=i)
        p = DIARY / f'{d.isoformat()}.md'
        if not p.exists():
            continue
        blocks = _parse_diary_blocks(p)
        for b in BLOCK_ORDER:
            for item in blocks.get(b, []):
                collected[b].append(item)

    parts = [f'# 短期记忆（最近 {keep_days} 天）', '']
    for b in BLOCK_ORDER:
        max_chars, per_line = BLOCK_LIMITS[b]
        lines, used = [], 0
        for item in collected[b]:
            text = item if len(item) <= per_line else item[: per_line - 1].rstrip() + '…'
            cost = len(text) + 3
            if lines and used + cost > max_chars:
                break
            lines.append('- ' + text)
            used += cost
        if not lines:
            continue
        parts.append('## ' + b)
        parts.extend(lines)
        parts.append('')

    return '\n'.join(parts).strip() + '\n'


def find_day_block(d: dt.date):
    """从长期总库里取某一天的块。

    支持两种标题格式：
      · `### 2026-10-19`                —— 按天留块（本脚本自己写的格式）
      · `### 2026-10-19 ~ 2026-10-24`   —— 区间块（手工/早期迁移留下的格式）

    只认第一种会让区间块里的日期永远取不到。这个 bug 在真机上表现为
    「第 7 天复习项永远缺失」：默认保留 7 天，today-7 的日记已被归档，
    只剩总库能取，而总库里恰好是区间块 → find_day_block 返回 None。
    """
    for f in sorted(BANK.rglob('*.md')):
        try:
            txt = f.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            continue
        for m in re.finditer(r'^### (\d{4}-\d{2}-\d{2})(?:\s*~\s*(\d{4}-\d{2}-\d{2}))?\s*$', txt, re.M):
            try:
                start = dt.date.fromisoformat(m.group(1))
                end = dt.date.fromisoformat(m.group(2)) if m.group(2) else start
            except ValueError:
                continue
            if not (start <= d <= end):
                continue
            body = txt[m.end():]
            nxt = re.search(r'^### ', body, re.M)
            return (body[:nxt.start()] if nxt else body).strip()
    return None


def build_review(today: dt.date, keep_days: int):
    """艾宾浩斯复习队列：1/2/4/7/15 天前的内容，今天该再提一次。"""
    parts = ['# 今日要复习的旧记忆（艾宾浩斯）', '']
    for n in REVIEW_DAYS:
        d = today - dt.timedelta(days=n)
        # 不能按「天数 <= 保留期」判断去哪读：默认保留 7 天时 cutoff = today-6，
        # today-7 的日记在本次 --apply 已被移进 archive/，src.exists() 为 False。
        # 若仍按天数判断，就永远不会去总库兜底 → 「第 7 天」复习项永远缺失
        # （15 天项反而正常，因为本来就走 else 分支）。
        # 正确做法：按文件是否存在决定来源。
        src = DIARY / f'{d.isoformat()}.md'
        text = src.read_text(encoding='utf-8') if src.exists() else find_day_block(d)
        if not text:
            continue
        pts = [x for x in bullets(text) if not x.startswith('[')]
        if not pts:
            continue
        parts.append(f'## {d.isoformat()}（第 {n} 天）')
        parts.extend(f'- {x}' for x in pts[:3])
        parts.append('')
    if len(parts) <= 2:
        REVIEW.write_text('# 今日要复习的旧记忆（艾宾浩斯）\n\n今天没有到期的。\n', encoding='utf-8')
    else:
        REVIEW.write_text('\n'.join(parts).strip() + '\n', encoding='utf-8')


def scan_preferences(today: dt.date):
    """扫当天日记里带偏好信号的句子，列成**待确认**条目，不直接改偏好库。

    偏好是"倾向"，需要人确认后才进 preferences.md——机器猜出来的偏好会把人格带偏。
    """
    src = DIARY / f'{today.isoformat()}.md'
    if not src.exists():
        return
    existing = PREF_LOG.read_text(encoding='utf-8') if PREF_LOG.exists() else ''
    added = []
    for line in src.read_text(encoding='utf-8').splitlines():
        s = line.strip()
        if not s.startswith('- ') or len(s) < 8:
            continue
        if not any(t in s for t in PREF_TRIGGERS):
            continue
        entry = f'- {today.isoformat()} [待确认] 源=diary：{s[2:]}'
        if entry in existing:
            continue
        added.append(entry)
    if added:
        with PREF_LOG.open('a', encoding='utf-8') as f:
            f.write('\n'.join(added) + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='真正归档过期日记并写长期记忆')
    ap.add_argument('--keep-days', type=int, default=KEEP_DAYS)
    ap.add_argument('--base', type=str, default=None, help='记忆目录（默认 $MEMORY_DIR 或 ~/.ai-memory）')
    args = ap.parse_args()

    global BASE, DIARY, ARCHIVE, BANK, SHORT, REVIEW, PREF_LOG
    if args.base:
        BASE = pathlib.Path(args.base).expanduser()
        DIARY = BASE / 'diary'
        ARCHIVE = DIARY / 'archive'
        BANK = BASE / 'memory-bank'
        SHORT = BASE / 'short-memory.md'
        REVIEW = BASE / 'review-due.md'
        PREF_LOG = BASE / 'preferences.log'

    keep_days = max(1, args.keep_days)
    today = dt.date.today()
    cutoff = today - dt.timedelta(days=keep_days - 1)
    DIARY.mkdir(parents=True, exist_ok=True)
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    BANK.mkdir(parents=True, exist_ok=True)

    expired = []
    for p in sorted(DIARY.glob('*.md')):
        d = parse_date(p)
        if d and d < cutoff:
            expired.append((d, p))

    # 按周分组；这一周跨月就在边界处切开，别把两天塞进一个范围文件
    groups = {}
    for d, p in expired:
        ws, we = week_range(d)
        seg_start = max(ws, d.replace(day=1))
        nxt = (d.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
        seg_end = min(we, nxt - dt.timedelta(days=1))
        groups.setdefault((seg_start, seg_end), []).append((d, p))

    for (ws, we), items in sorted(groups.items()):
        bank_file = BANK / str(ws.year) / f'{ws.year}.{ws.month:02d}' / range_name(ws, we)
        bank_file.parent.mkdir(parents=True, exist_ok=True)
        blocks = []
        for d, p in items:
            lines = []
            for s in p.read_text(encoding='utf-8').splitlines():
                if not s.strip():
                    continue
                if s.startswith('# ') and not s.startswith('## '):
                    continue
                lines.append(s.rstrip())
            blocks.append(f'### {d.isoformat()}\n\n' + ('\n'.join(lines) if lines else '（空）') + '\n')
            print(f'{"归档" if args.apply else "将归档"}: {p.name}')
        if args.apply:
            if not bank_file.exists():
                bank_file.write_text(
                    f'# 长期记忆 · {range_name(ws, we)[:-3]}\n\n按天留块，不写周总结。\n',
                    encoding='utf-8')
            with bank_file.open('a', encoding='utf-8') as f:
                f.write('\n' + '\n'.join(blocks))
            for d, p in items:
                shutil.move(str(p), str(ARCHIVE / p.name))
            print(f'已写入 {bank_file.name}：{len(blocks)} 天')

    scan_preferences(today)
    build_review(today, keep_days)
    short = build_short(today, keep_days)
    SHORT.write_text(short, encoding='utf-8')
    print(f'已重建 {SHORT.name}（{len(short)} 字）')
    print(f'已更新 {REVIEW.name}')
    print(f'已扫描偏好候选 -> {PREF_LOG.name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
