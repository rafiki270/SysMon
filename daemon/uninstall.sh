#!/bin/sh
# Removes the SysMon telemetry daemon service (does not delete this directory).
set -eu
LABEL="com.sysmon.daemon"
case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "launchd agent removed"
    ;;
  Linux)
    systemctl --user disable --now sysmon-daemon.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/sysmon-daemon.service"
    systemctl --user daemon-reload
    echo "systemd user service removed"
    ;;
  *) echo "Unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac
