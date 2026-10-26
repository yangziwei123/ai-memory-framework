#!/usr/bin/env bash
# 会话目录归档：把「很久没动」的会话目录打成 tar.gz 存到备份目录，然后删除原目录。
#
# 为什么需要：长期在线的 agent 每次重建会话都会在磁盘上留一个目录，
# 里面是**完整对话历史**——只增不减，既占空间也是隐私面。
#
# ⚠️ 三条铁律（2026-10-26 审查后重写）：
#   1. **tar 非 0 退出 或 包校验不过 → 一个目录都不删**
#   2. **按「目录里最新文件的 mtime」判断新旧**，不看目录自身 mtime
#      （很多运行时原地 append 文件，目录 mtime 永远不变 → 活跃会话被误判成 45 天没动）
#   3. 路径一律用数组 + -print0，空格/特殊字符不会把路径拆坏
#
# 用法：
#   SESSIONS_ROOT=~/path/to/sessions ARCHIVE_ROOT=/var/backups/sessions DAYS=45 ./archive-sessions.sh
#   ./archive-sessions.sh --dry-run
#   PROTECT_FILE=~/state/sessions.json ./archive-sessions.sh   # 额外保护在用会话
set -u

SESSIONS_ROOT="${SESSIONS_ROOT:-}"
ARCHIVE_ROOT="${ARCHIVE_ROOT:-$HOME/.agent-sessions-archive}"
DAYS="${DAYS:-45}"
KEEP="${KEEP:-12}"
PROTECT_FILE="${PROTECT_FILE:-}"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY=1

die() { echo "  ✗ $*" >&2; exit 2; }

[ -n "$SESSIONS_ROOT" ] || die "请指定 SESSIONS_ROOT（例如 SESSIONS_ROOT=~/path/to/sessions $0）"
[ -d "$SESSIONS_ROOT" ] || die "SESSIONS_ROOT 不存在：$SESSIONS_ROOT"

# 参数校验：KEEP 必须是正整数（否则 tail -n +0 会把刚生成的包也删掉）
case "$KEEP" in
  ''|*[!0-9]*) die "KEEP 必须是数字，当前：$KEEP" ;;
esac
[ "$KEEP" -ge 1 ] || die "KEEP 至少为 1（否则会删掉刚生成的归档），当前：$KEEP"

case "$DAYS" in
  ''|*[!0-9]*) die "DAYS 必须是数字，当前：$DAYS" ;;
esac

# 保护名单：当前在用的会话绝不能归档
PROTECTED_IDS=""
if [ -n "$PROTECT_FILE" ]; then
  [ -f "$PROTECT_FILE" ] || die "PROTECT_FILE 不存在：$PROTECT_FILE（要么修好，要么别传）"
  PROTECTED_IDS=$(python3 - "$PROTECT_FILE" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding='utf8'))
except Exception:
    sys.exit(0)
ids = []
if isinstance(d, dict):
    sessions = d.get('sessions') or {}
    if isinstance(sessions, dict):
        # key 和 value 都可能是 id，两种都收
        ids.extend(str(v) for v in sessions.values())
        ids.extend(str(k) for k in sessions.keys())
    elif isinstance(sessions, list):
        ids.extend(str(v) for v in sessions)
print('\n'.join(ids))
PY
)
fi

# ── 收集候选：目录里最新文件的 mtime 早于 DAYS 天 ──────────────────────
TARGETS=()
while IFS= read -r -d '' d; do
  name=$(basename "$d")
  skip=0
  for p in $PROTECTED_IDS; do
    # 保护名单里可能是 key（group:123）也可能是 session-id，两种都比一次
    [ "$name" = "$p" ] && skip=1
    [ "$name" = "session-${p#session-}" ] && skip=1
  done
  if [ "$skip" = "1" ]; then
    echo "  保护（仍在使用）: $name"
    continue
  fi
  newest=$(find "$d" -type f -newermt "-${DAYS} days" -print -quit 2>/dev/null)
  [ -n "$newest" ] && continue      # 里面还有新文件 → 不是旧会话
  TARGETS+=("$d")
done < <(find "$SESSIONS_ROOT" -maxdepth 2 -type d -name 'session-*' -print0 2>/dev/null)

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "  没有超过 ${DAYS} 天未动的会话，无需归档"
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$ARCHIVE_ROOT/sessions-$STAMP.tar.gz"

if [ -n "$DRY" ]; then
  echo "  [预演] 将归档 ${#TARGETS[@]} 个会话 -> $OUT"
  for d in "${TARGETS[@]}"; do echo "    $(basename "$d")  $(du -sh "$d" 2>/dev/null | cut -f1)"; done
  exit 0
fi

mkdir -p "$ARCHIVE_ROOT" || die "无法创建归档目录：$ARCHIVE_ROOT"

# ── 打包到临时文件；失败或校验不过 → 不删任何东西 ────────────────────
REL=()
for d in "${TARGETS[@]}"; do REL+=("${d#"$SESSIONS_ROOT"/}"); done

TMP="$OUT.part"
rm -f "$TMP"
if ! tar czf "$TMP" -C "$SESSIONS_ROOT" -- "${REL[@]}"; then
  rm -f "$TMP"
  echo "  ✗ tar 失败，未删除任何目录" >&2
  exit 1
fi
if [ ! -s "$TMP" ] || ! tar tzf "$TMP" >/dev/null 2>&1; then
  rm -f "$TMP"
  echo "  ✗ 归档校验失败（文件为空或无法读取），未删除任何目录" >&2
  exit 1
fi
mv "$TMP" "$OUT" || { rm -f "$TMP"; echo "  ✗ 归档改名失败，未删除任何目录" >&2; exit 1; }
chmod 600 "$OUT"

# 到这里包是好的，才允许删
for d in "${TARGETS[@]}"; do
  rm -rf -- "$d" || echo "  ⚠️ 删除失败（保留）: $d" >&2
done

# 只保留最近 KEEP 份
ls -1t "$ARCHIVE_ROOT"/sessions-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "  已归档 ${#TARGETS[@]} 个会话 -> $OUT（$(du -h "$OUT" | cut -f1)）"
logger -t archive-sessions "archived=${#TARGETS[@]} file=$OUT" 2>/dev/null || true
