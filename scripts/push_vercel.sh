#!/bin/bash
# 把 data/board-data.json 推到公开看板。
# 和上次成功推送的内容一样时，不发请求。
# 令牌只放进请求头，成功或失败的日志都不打印它。
#
# 需要：
#   MINION_INGEST_URL          例如 https://你的域名/api/ingest
#   MINION_INGEST_TOKEN        或者
#   MINION_INGEST_TOKEN_FILE   默认 ~/.secrets/minion_ingest_token
#
# 心跳会带上 MINION_PUSH_MIN_INTERVAL=60，这样最多一分钟推一次。
# 你自己手动跑这个脚本时，默认不限间隔。

set -u
set -o pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
JSON="${MINION_BOARD_JSON:-$ROOT/data/board-data.json}"
URL="${MINION_INGEST_URL:-}"
INTERVAL="${MINION_PUSH_MIN_INTERVAL:-0}"
TOKEN_FILE="${MINION_INGEST_TOKEN_FILE:-$HOME/.secrets/minion_ingest_token}"

log() {
  printf '%s\n' "$*" >&2
}

if [[ -z "$URL" ]]; then
  log "推送失败：没有 MINION_INGEST_URL"
  exit 1
fi

TOKEN="${MINION_INGEST_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  if [[ -r "$TOKEN_FILE" ]]; then
    TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
  fi
fi
if [[ -z "$TOKEN" ]]; then
  log "推送失败：没有读到令牌"
  exit 1
fi

if [[ ! -f "$JSON" ]]; then
  log "推送失败：找不到看板 JSON"
  exit 1
fi

# 哈希和间隔记在 JSON 旁边，这样 data/ 以外的测试也不会写进仓库。
STATE_DIR="$(CDPATH= cd -- "$(dirname "$JSON")" && pwd)"
STAMP="$STATE_DIR/push-vercel.stamp"
HASH_FILE="$STATE_DIR/push-vercel.sha256"
mkdir -p "$STATE_DIR"

now="$(date +%s)"
if [[ "$INTERVAL" =~ ^[0-9]+$ ]] && [[ "$INTERVAL" -gt 0 ]] && [[ -f "$STAMP" ]]; then
  last="$(tr -d '[:space:]' < "$STAMP" || true)"
  if [[ "$last" =~ ^[0-9]+$ ]]; then
    elapsed="$((now - last))"
    if [[ "$elapsed" -lt "$INTERVAL" ]]; then
      log "还没到推送间隔，跳过。"
      exit 0
    fi
  fi
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash="$(sha256sum "$JSON" | awk 'NR==1 { print $1 }')"
else
  hash="$(shasum -a 256 "$JSON" | awk 'NR==1 { print $1 }')"
fi

if [[ -f "$HASH_FILE" ]]; then
  prev="$(tr -d '[:space:]' < "$HASH_FILE" || true)"
  if [[ -n "$prev" && "$prev" == "$hash" ]]; then
    log "内容和上次成功推送一样，跳过。"
    exit 0
  fi
fi

# 先记下这次尝试。失败了也要等满间隔，避免每隔 30 秒打一次。
if [[ "$INTERVAL" =~ ^[0-9]+$ ]] && [[ "$INTERVAL" -gt 0 ]]; then
  printf '%s\n' "$now" > "$STAMP"
fi

body="$(mktemp)"
hdr="$(mktemp)"
cleanup() {
  rm -f "$body" "$hdr"
}
trap cleanup EXIT
umask 077
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$hdr"

http="$(
  curl --silent --show-error \
    --header @"$hdr" \
    --request POST \
    --header "Content-Type: application/json" \
    --data-binary @"$JSON" \
    --output "$body" \
    --write-out "%{http_code}" \
    --max-time 30 \
    --max-redirs 0 \
    "$URL" || true
)"

if [[ "$http" != "200" ]]; then
  log "推送失败：HTTP ${http:-000}"
  exit 1
fi

printf '%s\n' "$hash" > "$HASH_FILE"
log "已推送。"
exit 0
