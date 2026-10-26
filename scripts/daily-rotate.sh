#!/usr/bin/env bash
# 每日记忆轮转：**先备份，再 apply**。
#
# 为什么要包装而不是直接跑 memory_rotate.py：
#   · --apply 会 shutil.move 把过期日记移进 archive/
#   · 它**任何模式**都会重写 short-memory.md / review-due.md / preferences.log
#   · 先打一份 tar，脚本哪天出 bug 也能回滚
#
# 用法：
#   MEMORY_DIR=~/.ai-memory BACKUP_DIR=/var/backups/ai-memory ./daily-rotate.sh
#   KEEP_DAYS=7 KEEP_BACKUPS=7 ./daily-rotate.sh
set -u

MEMORY_DIR="${MEMORY_DIR:-$HOME/.ai-memory}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.ai-memory-backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
KEEP_BACKUPS="${KEEP_BACKUPS:-7}"
STAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/memory-$STAMP.tar.gz"

# 1) 备份（排除缓存/大文件）
tar czf "$OUT" -C "$MEMORY_DIR" \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='archive' . 2>/dev/null || true
if [ -s "$OUT" ]; then
  chmod 600 "$OUT"
else
  echo "  ⚠️ 备份失败，继续执行（但请检查磁盘权限）"
fi

# 2) 只留最近 N 份备份
ls -1t "$BACKUP_DIR"/memory-*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

# 3) 轮转
cd "$MEMORY_DIR" || exit 1
RESULT=$(python3 memory_rotate.py --keep-days "$KEEP_DAYS" --apply 2>&1)
RC=$?
echo "$RESULT"
logger -t ai-memory-rotate "rc=$RC | $(echo "$RESULT" | tr '\n' ';' | cut -c1-300)" 2>/dev/null || true
exit $RC
