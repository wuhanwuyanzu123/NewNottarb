#!/usr/bin/env bash
# Internal Linux live child runner for last-notarb-supervisor.mjs.
# Do not exec NotArb: the shell remains the managed process-group leader, so
# the supervisor can stop exactly this wrapper and its Java child together.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${1:-}"
MANAGED_MARKER="${2:-}"
OUT_LOG="$ROOT/notarb-last-target-live.stdout.log"
ERR_LOG="$ROOT/notarb-last-target-live.stderr.log"

if [[ "$MANAGED_MARKER" != "--managed-by-last-supervisor" ]]; then
  printf '%s\n' '{"status":"last_live_start_rejected","reason":"use_run-last-notarb-live-supervisor.sh"}' >>"$ERR_LOG"
  exit 2
fi
if [[ -z "$CONFIG" ]]; then
  printf '%s\n' '{"status":"last_live_start_rejected","reason":"missing_supervisor_config"}' >>"$ERR_LOG"
  exit 2
fi

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [[ -z "$NODE_BIN" ]]; then
  printf '%s\n' '{"status":"last_live_start_rejected","reason":"node_not_found"}' >>"$ERR_LOG"
  exit 127
fi
CONFIGURED_READ_RPC="$("$NODE_BIN" "$ROOT/last-live-reader-rpc.mjs" "$CONFIG")" || {
  printf '%s\n' '{"status":"last_live_start_rejected","reason":"invalid_reader_rpc"}' >>"$ERR_LOG"
  exit 2
}
# Do not inherit a stale reader from a systemd drop-in. The explicit override
# remains available only to local fixture work that deliberately opts in;
# production always uses the configured 82 reader.
if [[ "${LAST_ROUTE_ALLOW_RPC_OVERRIDE:-false}" == "true" && -n "${LAST_READ_RPC_URL:-}" ]]; then
  :
else
  LAST_READ_RPC_URL="$CONFIGURED_READ_RPC"
fi
export LAST_READ_RPC_URL
"$NODE_BIN" "$ROOT/assert-last-live.mjs" "$CONFIG" >>"$OUT_LOG" 2>>"$ERR_LOG"

# Diagnose an unfunded fee payer without holding up the active lease or the
# Java child.  The helper derives the public key from the configured local
# keypair and calls only [blockhash_updater].rpc_url; it never signs or sends.
# Do not wait for it: a transient reader failure must not stop NotArb.
"$NODE_BIN" "$ROOT/last-live-fee-payer-preflight.mjs" "$CONFIG" >>"$OUT_LOG" 2>>"$ERR_LOG" &

# Prefer an official Linux NotArb launcher when one is installed.  The 82.23
# deployment also carries the cross-platform NotArb JAR, so retain the same
# `create-cmd` bootstrap protocol used by the Windows launcher as a fallback.
NOTARB_BIN="${NOTARB_BIN:-notarb}"
USE_NOTARB_BIN=false
if [[ "$NOTARB_BIN" == */* ]]; then
  [[ -x "$NOTARB_BIN" ]] && USE_NOTARB_BIN=true
elif command -v "$NOTARB_BIN" >/dev/null 2>&1; then
  USE_NOTARB_BIN=true
fi

cd "$ROOT"
if [[ "$USE_NOTARB_BIN" == true ]]; then
  # Keep a shell statement after NotArb so bash does not optimize the final
  # command into an implicit exec; its stable PID is the supervisor's
  # ownership marker for the whole process group.
  set +e
  "$NOTARB_BIN" onchain-bot "$CONFIG" >>"$OUT_LOG" 2>>"$ERR_LOG"
  NOTARB_EXIT=$?
  set -e
  exit "$NOTARB_EXIT"
fi

NOTARB_JAVA_BIN="${NOTARB_JAVA_BIN:-java}"
NOTARB_JAR="${NOTARB_JAR:-$ROOT/.notarb-1.1.2.jar}"
NOTARB_HOME="${NOTARB_HOME:-$(dirname "$NOTARB_JAR")}"
if ! command -v "$NOTARB_JAVA_BIN" >/dev/null 2>&1 || [[ ! -f "$NOTARB_JAR" ]]; then
  printf '%s\n' '{"status":"last_live_start_rejected","reason":"notarb_launcher_and_java_jar_unavailable"}' >>"$ERR_LOG"
  exit 127
fi

# Match the official Windows launcher: ask the same Main class to generate
# the final Java command, then execute its one-argument-per-line output.  It
# preserves the NotArb-provided JVM flags; inject notarb.home if an older JAR
# does not generate it.  NOTARB_JAVA_OPTS is only used by the direct fallback.
COMMAND_FILE="$(mktemp "${TMPDIR:-/tmp}/notarb-last-cmd.XXXXXX")"
cleanup_command_file() { rm -f "$COMMAND_FILE"; }
trap cleanup_command_file EXIT
set +e
"$NOTARB_JAVA_BIN" -cp "$NOTARB_JAR" com.notarb.Main create-cmd \
  "$NOTARB_JAVA_BIN" "$NOTARB_JAR" "$NOTARB_HOME" "$COMMAND_FILE" onchain-bot "$CONFIG" \
  >>"$OUT_LOG" 2>>"$ERR_LOG"
CREATE_COMMAND_EXIT=$?
set -e

if [[ "$CREATE_COMMAND_EXIT" -eq 0 && -s "$COMMAND_FILE" ]]; then
  mapfile -t NOTARB_COMMAND <"$COMMAND_FILE"
  if [[ "${#NOTARB_COMMAND[@]}" -gt 0 ]]; then
    HAS_NOTARB_HOME=false
    for ARGUMENT in "${NOTARB_COMMAND[@]}"; do
      [[ "$ARGUMENT" == -Dnotarb.home=* ]] && HAS_NOTARB_HOME=true
    done
    if [[ "$HAS_NOTARB_HOME" != true ]]; then
      NOTARB_COMMAND=("${NOTARB_COMMAND[0]}" "-Dnotarb.home=$NOTARB_HOME" "${NOTARB_COMMAND[@]:1}")
    fi
    set +e
    "${NOTARB_COMMAND[@]}" >>"$OUT_LOG" 2>>"$ERR_LOG"
    NOTARB_EXIT=$?
    set -e
    exit "$NOTARB_EXIT"
  fi
fi

# This direct form keeps an emergency path for a JAR version whose bootstrap
# cannot create a command.  Supply any site-specific original JVM flags in
# NOTARB_JAVA_OPTS (space-separated) when that path is required.
read -r -a NOTARB_JAVA_OPTIONS <<<"${NOTARB_JAVA_OPTS:-}"
set +e
"$NOTARB_JAVA_BIN" "${NOTARB_JAVA_OPTIONS[@]}" "-Dnotarb.home=$NOTARB_HOME" \
  -cp "$NOTARB_JAR" com.notarb.Main onchain-bot "$CONFIG" >>"$OUT_LOG" 2>>"$ERR_LOG"
NOTARB_EXIT=$?
set -e
exit "$NOTARB_EXIT"
