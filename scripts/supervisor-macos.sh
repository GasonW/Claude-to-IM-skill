#!/usr/bin/env bash
# macOS supervisor — launchd-based process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

LAUNCHD_LABEL="com.claude-to-im.bridge"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LAUNCHD_LABEL.plist"

# ── launchd helpers ──

# Collect env vars that should be forwarded into the plist.
# We honour clean_env() logic by reading *after* clean_env runs.
build_env_dict() {
  local indent="            "
  local dict=""

  # Always forward basics
  for var in HOME PATH USER SHELL LANG TMPDIR; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
  done

  # Forward NODE path explicitly so run-daemon.sh can find it even in a
  # stripped launchd environment where PATH may not include Homebrew/nvm/fnm.
  local node_bin
  node_bin=$(command -v node 2>/dev/null || true)
  if [ -n "$node_bin" ]; then
    dict+="${indent}<key>NODE</key>\n${indent}<string>${node_bin}</string>\n"
  fi

  # Forward CTI_* vars
  while IFS='=' read -r name val; do
    case "$name" in CTI_*)
      dict+="${indent}<key>${name}</key>\n${indent}<string>${val}</string>\n"
      ;; esac
  done < <(env)

  # Forward runtime-specific API keys
  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  case "$runtime" in
    codex|auto)
      for var in OPENAI_API_KEY CODEX_API_KEY CTI_CODEX_API_KEY CTI_CODEX_BASE_URL; do
        local val="${!var:-}"
        [ -z "$val" ] && continue
        dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
      done
      ;;
  esac
  case "$runtime" in
    claude|auto)
      # Auto-forward all ANTHROPIC_* env vars (sourced from config.env by daemon.sh).
      # Third-party API providers need these to reach the CLI subprocess.
      while IFS='=' read -r name val; do
        case "$name" in ANTHROPIC_*)
          dict+="${indent}<key>${name}</key>\n${indent}<string>${val}</string>\n"
          ;; esac
      done < <(env)
      ;;
  esac

  echo -e "$dict"
}

generate_plist() {
  local node_path
  node_path=$(command -v node)

  mkdir -p "$PLIST_DIR"
  local env_dict
  env_dict=$(build_env_dict)

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <!-- run-daemon.sh wraps the node process with crash-loop detection and
         automatic rollback to the last stable build after MAX_CRASHES fast exits. -->
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SKILL_DIR}/scripts/run-daemon.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>

    <!-- RunAtLoad=true: auto-start when user logs in after reboot -->
    <key>RunAtLoad</key>
    <true/>

    <!-- KeepAlive=true: unconditional restart on any exit (crash, kill, or clean).
         Intentional stops use `launchctl bootout` which removes the service entirely,
         preventing launchd from restarting. This fixes the bug where daemon.exit(0)
         after SIGTERM was treated as a "successful exit" and not restarted. -->
    <key>KeepAlive</key>
    <true/>

    <!-- 15s throttle prevents tight crash loops from spinning CPU -->
    <key>ThrottleInterval</key>
    <integer>15</integer>

    <key>EnvironmentVariables</key>
    <dict>
${env_dict}    </dict>
</dict>
</plist>
PLIST
}

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  generate_plist
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

supervisor_stop() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" &>/dev/null
}

supervisor_status_extra() {
  if supervisor_is_managed; then
    echo "Bridge is registered with launchd ($LAUNCHD_LABEL)"
    # Extract PID from launchctl as the authoritative source
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      echo "launchd reports PID: $lc_pid"
    fi
  fi
}

# Override: on macOS, check launchctl first, then fall back to PID file
supervisor_is_running() {
  # Primary: launchctl knows the process
  if supervisor_is_managed; then
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      return 0
    fi
  fi
  # Fallback: PID file
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
