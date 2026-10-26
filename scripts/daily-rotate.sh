#!/usr/bin/env bash
# 每日记忆轮转：**先备份，再 apply**。
#
# 为什么要包装而不是直接跑 memory_rotate.py：
#   · `--apply` 会 shutil.move 把过期日记移进 archive/
#   · 它**任何模式**都会重写 short-memory.md / review-due.md 并追加 preferences.log
#   · 先打一份 tar，脚本哪天出 bug 也能回滚
#
# ⚠️ 2026-10-26 审查后改的两条：
#   1. **备份失败 → 中止，不轮转**（旧版只 echo 一句警告就继续 apply，
#      而磁盘满/权限错正是最需要备份的时刻）
#   2. 路径先解析成绝对路径再 cd，并显式 `--base` 传参
#      （旧版用相对 MEMORY_DIR 会叠成 MEMORY_DIR/MEMORY_DIR）
#
# 用法：
#   MEMORY_DIR=~/.ai-memory BACKUP_DIR=/var/backups/ai-memory ./daily-rotate.sh
#   KEEP_DAYS=7 KEEP_BACKUPS=7 ./daily-rotate.sh
#   ALLOW_NO_BACKUP=1 ./daily-rotate.sh     # 明确接受"没备份也轮转"（不推荐）
set -u

MEMORY_DIR="${MEMORY_DIR:-$HOME/.ai-memory}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.ai-memory-backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
KEEP_BACKUPS="${KEEP_BACKUPS:-7}"
ALLOW_NO_BACKUP="${ALLOW_NO_BACKUP:-0}"

die() { echo "  ✗ $*" >&2; exit 1; }

# 解析为绝对路径：必须先 cd -P 再取 pwd，之后所有操作都用绝对路径
[ -d "$MEMORY_DIR" ] || die "MEMORY_DIR 不存在：$MEMORY_DIR"
MEMORY_DIR="$(cd "$MEMORY_DIR" && pwd -P)" || die "无法解析 MEMORY_DIR"
ROTATE="${ROTATE_SCRIPT:-$MEMORY_DIR/memory_rotate.py}"
[ -f "$ROTATE" ] || die "找不到轮转脚本：$ROTATE（可用 ROTATE_SCRIPT 指定）"

case "$KEEP_DAYS" in ''|*[!0-9]*) die "KEEP_DAYS 必须是数字，当前：$KEEP_DAYS" ;; esac
case "$KEEP_BACKUPS" in ''|*[!0-9]*) die "KEEP_BACKUPS 必须是数字，当前：$KEEP_BACKUPS" ;; esac
[ "$KEEP_BACKUPS" -ge 1 ] || die "KEEP_BACKUPS 至少为 1（否则会删掉刚做的备份），当前：$KEEP_BACKUPS"

STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR" || die "无法创建备份目录：$BACKUP_DIR"
OUT="$BACKUP_DIR/memory-$STAMP.tar.gz"

# ── 1) 备份：失败就中止 ───────────────────────────────────────────────
TMP="$OUT.part"
rm -f "$TMP"
if ! tar czf "$TMP" -C "$MEMORY_DIR" \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='archive' . ; then
  rm -f "$TMP"
  if [ "$ALLOW_NO_BACKUP" = "1" ]; then
    echo "  ⚠️ 备份失败，但 ALLOW_NO_BACKUP=1，继续轮转" >&2
  else
    die "备份失败，已中止（未做任何轮转）。确实要跳过备份请设 ALLOW_NO_BACKUP=1"
  fi
else
  if [ ! -s "$TMP" ]; then
    rm -f "$TMP"
    [ "$ALLOW_NO_BACKUP" = "1" ] || die "备份为空，已中止（未做任何轮转）"
  else
    mv "$TMP" "$OUT" || die "备份改名失败，已中止"
    chmod 600 "$OUT"
  fi
fi

# ── 2) 只留最近 N 份（KEEP_BACKUPS 已校验过 ≥1）─────────────────────────
ls -1t "$BACKUP_DIR"/memory-*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

# ── 3) 轮转 ───────────────────────────────────────────────────────────
RESULT=$(python3 "$ROTATE" --base "$MEMORY_DIR" --keep-days "$KEEP_DAYS" --apply 2>&1)
RC=$?
echo "$RESULT"
logger -t ai-memory-rotate "rc=$RC backup=$OUT | $(echo "$RESULT" | tr '\n' ';' | cut -c1-300)" 2>/dev/null || true
exit $RC
