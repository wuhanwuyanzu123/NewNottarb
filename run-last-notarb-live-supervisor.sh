#!/usr/bin/env bash
# Linux entry point for the activity-gated LAST live runner.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${LAST_LIVE_CONFIG:-$ROOT/notarb-last-grpc-live.toml}"
IDLE_SECONDS="${LAST_IDLE_SECONDS:-120}"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [[ -z "$NODE_BIN" ]]; then
  printf '%s\n' '{"status":"last_live_supervisor_start_failed","reason":"node_not_found"}' >&2
  exit 127
fi

exec "$NODE_BIN" "$ROOT/last-notarb-supervisor.mjs" \
  --config="$CONFIG_PATH" \
  --assert="$ROOT/assert-last-live.mjs" \
  --runner="$ROOT/run-notarb-last-target-live.sh" \
  --state="$ROOT/.last-notarb-live-supervisor-state.json" \
  --idle-seconds="$IDLE_SECONDS" \
  "$@" >>"$ROOT/last-notarb-live-supervisor.stdout.log" 2>>"$ROOT/last-notarb-live-supervisor.stderr.log"
