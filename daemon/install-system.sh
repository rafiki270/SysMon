#!/bin/sh
# Install the loopback-only telemetry daemon as a persistent Linux system service.
# Run as root: sh daemon/install-system.sh [path-to-node]
set -eu

[ "$(id -u)" -eq 0 ] || { echo 'Run as root' >&2; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
NODE="${1:-$(command -v node)}"
[ -x "$NODE" ] || { echo "Node.js is not executable: $NODE" >&2; exit 1; }
DEST=/opt/sysmon-daemon
UNIT=/etc/systemd/system/sysmon-daemon.service

install -d -m 0755 "$DEST"
install -m 0644 "$SRC/sysmon-daemon.cjs" "$SRC/ws.cjs" "$DEST/"
cat > "$UNIT" <<EOF
[Unit]
Description=SysMon telemetry daemon (loopback only)
After=network.target

[Service]
Type=simple
DynamicUser=yes
ExecStart=$NODE $DEST/sysmon-daemon.cjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"
systemctl daemon-reload
systemctl enable sysmon-daemon.service
systemctl restart sysmon-daemon.service
curl -fsS --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:7737/health
