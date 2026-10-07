# SysMon telemetry daemon

Tiny dependency-free Node daemon that samples the local machine every ~3 s
(CPU, GPU, memory, disk, uptime, top process, 60 s CPU/GPU history) and serves it over
WebSocket. The SysMon app reaches it through an SSH tunnel; no LAN port is
ever exposed.

## Security

- Binds to **127.0.0.1:7737 only** — a non-loopback `SYSMON_HOST` override is
  refused.
- Rejects WebSocket upgrades that carry a browser `Origin` header, so
  unrelated websites cannot read local process data.
- Caps queued output for slow readers and drops them rather than growing
  memory.
- Read-only: it samples and serves metrics, nothing else.

## Install / uninstall

macOS (launchd) and Linux (systemd --user):

```sh
sh daemon/install.sh [path-to-node]
sh daemon/uninstall.sh
```

The installer copies the daemon to the durable location
`~/.local/share/sysmon/daemon` and points the service there, so the source
worktree can be cleaned up afterwards. If no Node path is given it probes
`~/.local/node/bin/node`, `/usr/bin/node` and `command -v node`.

- macOS: `~/Library/LaunchAgents/com.sysmon.daemon.plist` (starts at login).
- Linux: `~/.config/systemd/user/sysmon-daemon.service` (starts at login;
  `loginctl enable-linger` keeps it alive without a session).

Default port 7737 (`SYSMON_DAEMON_PORT` override), loopback only.

## Check

```sh
curl -s http://127.0.0.1:7737/health
```

Manual tunnel (what the app does automatically):

```sh
ssh -N -T -L 127.0.0.1:17380:127.0.0.1:7737 umac@umac.local
```

## Deployment note

Source deployments on the machines use dedicated git worktrees/branches;
`git status` before any change, never touch unrelated dirty projects. The
running copy is always the durable `~/.local/share/sysmon/daemon` install.
