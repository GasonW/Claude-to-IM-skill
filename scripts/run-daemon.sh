#!/usr/bin/env bash
# run-daemon.sh — wrapper invoked by launchd instead of daemon.mjs directly.
#
# Responsibilities:
#   1. Track consecutive fast exits (crash-loop detection)
#   2. After MAX_CRASHES consecutive fast crashes, restore the last stable build
#      and send a macOS notification so the user knows what happened
#   3. On a healthy run (survived >= CRASH_WINDOW seconds), reset the counter
#      and update the stable snapshot
#
# launchd handles process restart; this script runs once per launch.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
NODE="${NODE:-node}"

DAEMON="$SKILL_DIR/dist/daemon.mjs"
STABLE="$SKILL_DIR/dist/daemon.mjs.stable"
COUNTER_FILE="$CTI_HOME/runtime/crash-count"

# How long a run must last (seconds) to be considered "healthy"
CRASH_WINDOW=30
# Consecutive fast exits before automatic rollback
MAX_CRASHES=5

mkdir -p "$CTI_HOME/runtime"

read_count()  { cat "$COUNTER_FILE" 2>/dev/null || echo 0; }
write_count() { echo "$1" > "$COUNTER_FILE"; }
notify()      { osascript -e "display notification \"$1\" with title \"Claude-to-IM\"" 2>/dev/null || true; }
log()         { echo "[run-daemon] $*" >&2; }

count=$(read_count)

# ── Crash-loop rollback ──────────────────────────────────────────
if [ "$count" -ge "$MAX_CRASHES" ]; then
  if [ -f "$STABLE" ]; then
    log "Crash loop detected ($count fast exits). Restoring stable build..."
    cp "$STABLE" "$DAEMON"
    write_count 0
    count=0
    notify "Bridge rolled back to stable after $MAX_CRASHES consecutive crashes."
    log "Stable build restored. Restarting..."
  else
    log "Crash loop ($count fast exits) but no stable snapshot exists yet."
    log "Fix the code or run: daemon.sh stop"
    notify "Bridge is crash-looping ($count times). No stable snapshot — stopping may be needed."
    # Don't exit here — let it try again; launchd's ThrottleInterval limits the rate
  fi
fi

# ── Run the daemon ───────────────────────────────────────────────
START=$(date +%s)

# Disable set -e for the daemon invocation — the daemon exits non-zero on crash,
# which would cause set -e to kill this wrapper before we can update the counter.
set +e
"$NODE" "$DAEMON"
EXIT_CODE=$?
set -e

DURATION=$(( $(date +%s) - START ))

# ── Post-run: update counter and stable snapshot ─────────────────
if [ "$DURATION" -ge "$CRASH_WINDOW" ]; then
  # Healthy run — reset crash counter and update stable snapshot
  write_count 0
  if [ -f "$DAEMON" ]; then
    cp "$DAEMON" "$STABLE"
    log "Healthy run (${DURATION}s). Updated stable snapshot."
  fi
else
  # Fast exit — increment crash counter
  new_count=$((count + 1))
  write_count "$new_count"
  log "Fast exit after ${DURATION}s (exit code $EXIT_CODE). Crash count: $new_count/$MAX_CRASHES"
fi

exit "$EXIT_CODE"
