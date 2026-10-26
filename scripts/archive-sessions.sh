#!/usr/bin/env bash
# 会话目录归档：把「很久没动」的会话目录打成 tar.gz 存到备份目录，然后删除原目录。
#
# 为什么需要：长期在线的 agent 每次重建会话都会在磁盘上留一个目录，
# 里面是**完整对话历史**——只增不减，既占空间也是隐私面。
# 只压缩不直接删：归档后仍可解压恢复。
#
# 用法：
#   SESSIONS_ROOT=~/.dsh/sessions Archive=/var/backups/dsh-sessions DAYS=45 ./archive-sessions.sh
#   ./archive-sessions.sh --dry-run
set -u

SESSIONS_ROOT="${SESSIONS_ROOT:-$HOME/.dsh/sessions}"
ARCHIVE_ROOT="${ARCHIVE_ROOT:-$HOME/.dsh-sessions-archive}"
DAYS="${DAYS:-45}"
KEEP="${KEEP:-12}"
DRY="${1:-}"

mkdir -p "$ARCHIVE_ROOT"

# 可选：保护正在使用的会话（如果你的程序有映射文件，在这里读出来）
PROTECT="${PROTECT_FILE:-}"
PROTECTED_IDS=""
if [ -n "$PROTECT" ] && [ -f "$PROTECT" ]; then
  PROTECTED_IDS=$(python3 - "$PROTECT" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding='utf8'))
    vals = (d.get('sessions') or {}).values() if isinstance(d, dict) else []
    print(' '.join(str(v) for v in vals))
except Exception:
    print('')
PY
)
fi

TARGETS=""
for d in $(find "$SESSIONS_ROOT" -maxdepth 2 -type d -name 'session-*' -mtime +"$DAYS" 2>/dev/null); do
  name=$(basename "$d")
  skip=0
  for p in $PROTECTED_IDS; do [ "$name" = "$p" ] && skip=1; done
  [ "$skip" = "1" ] && { echo "  保护（仍在使用）: $name"; continue; }
  TARGETS="$TARGETS $d"
done

if [ -z "$TARGETS" ]; then
  echo "  没有超过 ${DAYS} 天未动的会话，无需归档"
  exit 0
fi

COUNT=$(echo $TARGETS | wc -w)
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$ARCHIVE_ROOT/sessions-$STAMP.tar.gz"

if [ "$DRY" = "--dry-run" ]; then
  echo "  [预演] 将归档 $COUNT 个会话 -> $OUT"
  for d in $TARGETS; do echo "    $(basename "$d")  $(du -sh "$d" | cut -f1)"; done
  exit 0
fi

# 注意 -- ：会话目录名常以 -- 开头（hash 路径），不加会被 tar 当成选项
tar czf "$OUT" -C "$SESSIONS_ROOT" -- $(for d in $TARGETS; do echo "${d#$SESSIONS_ROOT/}"; done) 2>/dev/null

# 关键保护：tar 失败就**不删任何东西**
if [ ! -s "$OUT" ]; then
  echo "  ✗ 归档失败，未删除任何目录"
  exit 1
fi
chmod 600 "$OUT"

for d in $TARGETS; do rm -rf "$d"; done
ls -1t "$ARCHIVE_ROOT"/sessions-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "  已归档 $COUNT 个会话 -> $OUT（$(du -h "$OUT" | cut -f1)）"
logger -t archive-sessions "archived=$COUNT file=$OUT" 2>/dev/null || true
