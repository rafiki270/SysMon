#!/bin/sh
# SysMon telemetry daemon installer (macOS launchd / Linux systemd --user).
# Usage: sh install.sh [/path/to/node]
# The daemon listens on 127.0.0.1 only; reach it through an SSH tunnel.
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.sysmon.daemon"
PORT="${SYSMON_DAEMON_PORT:-7737}"

find_node() {
  if [ -n "${1:-}" ]; then printf '%s' "$1"; return; fi
  for c in "$HOME/.local/node/bin/node" /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    [ -x "$c" ] && { printf '%s' "$c"; return; }
  done
  command -v node
}
NODE="$(find_node "${1:-}")"
[ -x "$NODE" ] || { echo "No Node.js found; pass its path: sh install.sh /path/to/node" >&2; exit 1; }
echo "Using node: $NODE"

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/state/sysmon"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/sysmon-daemon.cjs</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>SYSMON_DAEMON_PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.local/state/sysmon/daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/.local/state/sysmon/daemon.err.log</string>
</dict></plist>
PLIST
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Installed and started via launchd: $PLIST"
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/sysmon-daemon.service"
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$UNIT" <<UNIT
[Unit]
Description=SysMon telemetry daemon (loopback only)

[Service]
ExecStart=$NODE $DIR/sysmon-daemon.cjs
Environment=SYSMON_DAEMON_PORT=$PORT
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now sysmon-daemon.service
    # Survive logout (user services stop at last logout without lingering).
    loginctl enable-linger "$USER" 2>/dev/null && echo "Lingering enabled for $USER" || \
      echo "Note: could not enable lingering (needs sudo); the daemon stops when you log out." >&2
    echo "Installed and started via systemd --user: $UNIT"
    ;;
  *) echo "Unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac
sleep 1
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && echo "Health check OK on 127.0.0.1:$PORT" || \
  echo "Health check pending; verify with: curl http://127.0.0.1:$PORT/health"
