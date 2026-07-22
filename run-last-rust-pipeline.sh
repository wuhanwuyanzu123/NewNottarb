#!/usr/bin/env bash
set -euo pipefail

# WSL/Linux LAST pipeline: the Yellowstone observer is append-only, while the
# compiled Rust bridge owns target market generation and the small lease state.
# LAST_READ_RPC_URL supports either a local development forward or a direct
# server-side read RPC.

ROOT="${LAST_ROUTE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
READ_RPC_URL="${LAST_READ_RPC_URL:-http://127.0.0.1:18899}"
# NotArb needs time to load the user, prices, markets, and ALT set before it
# can quote. Retain the last validated LAST route while confirmed
# LAST-signed activity continues, then publish `held` two minutes after that
# activity stops and let the supervisor stop its child.
OBSERVER_STALENESS_SECONDS="${LAST_OBSERVER_STALENESS_SECONDS:-120}"
# The bridge consumes a compact atomic route receipt, so a short polling
# interval does not repeatedly scan the historical JSONL while idle.
BRIDGE_INTERVAL_MS="${LAST_ROUTE_BRIDGE_INTERVAL_MS:-250}"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "$NODE_BIN" && -x "$HOME/.local/bin/node" ]]; then
  NODE_BIN="$HOME/.local/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo '{"status":"rust_pipeline_start_failed","reason":"node_not_found"}' >&2
  exit 127
fi
OBSERVER_LOG="$ROOT/last-grpc-rust-runtime.stdout.log"
OBSERVER_ERR="$ROOT/last-grpc-rust-runtime.stderr.log"
BRIDGE_LOG="$ROOT/last-route-rust.stdout.log"
BRIDGE_ERR="$ROOT/last-route-rust.stderr.log"

cleanup() {
  [[ -n "${OBSERVER_PID:-}" ]] && kill "$OBSERVER_PID" 2>/dev/null || true
  [[ -n "${BRIDGE_PID:-}" ]] && kill "$BRIDGE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"$NODE_BIN" "$ROOT/grpc-last.mjs" --root="$ROOT" --no-state >>"$OBSERVER_LOG" 2>>"$OBSERVER_ERR" &
OBSERVER_PID=$!
bash "$ROOT/rust/last-route-bridge/run-wsl.sh" --interval="$BRIDGE_INTERVAL_MS" --max-observer-staleness-seconds="$OBSERVER_STALENESS_SECONDS" --rpc="$READ_RPC_URL" >>"$BRIDGE_LOG" 2>>"$BRIDGE_ERR" &
BRIDGE_PID=$!

wait -n "$OBSERVER_PID" "$BRIDGE_PID"
exit $?
