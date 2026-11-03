#!/bin/bash
# 每 30 秒构建一次看板快照。适合 nohup 放后台。
# 已经有一份在跑时，这次直接退出，不会开第二份。
#
#   nohup /home/box/shared/helpers/minion-board/scripts/heartbeat.sh \
#     >>/home/box/shared/helpers/minion-board/data/heartbeat.log 2>&1 &

set -u
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-python3}"
mkdir -p "$ROOT/data"
LOCK="$ROOT/data/heartbeat.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "心跳已在运行，这次不再另开。" >&2
  exit 0
fi
echo "$$" > "$ROOT/data/heartbeat.pid"
cleanup() {
  rm -f "$ROOT/data/heartbeat.pid"
  exit 0
}
trap cleanup INT TERM

while true; do
  TZ=Asia/Shanghai date '+%Y-%m-%dT%H:%M:%S+08:00' > "$ROOT/data/heartbeat.stamp"
  "$PY" "$ROOT/scripts/build_snapshot.py" --refresh-mode watch || true
  # 只有设了 MINION_INGEST_URL 才推。推送失败不能把心跳弄停。
  # 间隔默认 60 秒，避免每 30 秒的构建都打一次存储。
  if [[ -n "${MINION_INGEST_URL:-}" && -f "$ROOT/scripts/push_vercel.sh" ]]; then
    MINION_PUSH_MIN_INTERVAL="${MINION_PUSH_MIN_INTERVAL:-60}" bash "$ROOT/scripts/push_vercel.sh" \
      || echo "推送到 Vercel 失败，心跳继续。" >&2
  fi
  if [[ "${MINION_HEARTBEAT_ONCE:-}" == "1" ]]; then
    rm -f "$ROOT/data/heartbeat.pid"
    exit 0
  fi
  sleep 30
done
