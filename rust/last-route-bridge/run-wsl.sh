#!/usr/bin/env bash
set -euo pipefail

# Compile outside a Windows-mounted worktree when needed, then run the Rust
# bridge against the existing LAST evidence and configured read RPC. Pass any
# bridge flags (for example --once) through unchanged.

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${LAST_ROUTE_ROOT:-$(cd "$SOURCE_DIR/../.." && pwd)}"
SOURCE="$ROOT/rust/last-route-bridge"
TARGET_DIR="${LAST_ROUTE_CARGO_TARGET_DIR:-$HOME/.cache/notarb-last-route-bridge-target}"
CARGO_BIN="${CARGO_BIN:-}"
if [[ -z "$CARGO_BIN" ]]; then
  CARGO_BIN="$(command -v cargo 2>/dev/null || true)"
fi
if [[ -z "$CARGO_BIN" && -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$CARGO_BIN" ]]; then
  echo '{"status":"rust_bridge_start_failed","reason":"cargo_not_found"}' >&2
  exit 127
fi

mkdir -p "$TARGET_DIR"
cd "$SOURCE"
CARGO_TARGET_DIR="$TARGET_DIR" "$CARGO_BIN" build --release
exec "$TARGET_DIR/release/last-route-bridge" --root="$ROOT" "$@"
