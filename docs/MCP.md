# SysMon MCP server + mDNS discovery

SysMon exposes its **entire live monitor state** — every machine metric, every
quota window, CI results — over a read-only [Model Context
Protocol](https://modelcontextprotocol.io) server, discoverable on the LAN via
mDNS/DNS-SD. MCP clients (Claude Desktop, Codex, Cursor, any SDK client) can
then load the stats directly from the running app.

Everything is read from the app's exact shared `Monitor.state` — the same
object the tray window renders. The MCP server never re-polls providers,
never mutates anything, and never sends inference requests.

## Endpoint

- **Transport:** MCP Streamable HTTP (spec 2025-11-25), single endpoint
  supporting POST, GET (SSE), and DELETE.
- **URL:** `http://<machine-lan-ip>:7738/mcp` (port `7738`, all interfaces).
  The telemetry daemon stays loopback-only on port `7737` as before.
- **Security:** plain HTTP on the trusted LAN (no TLS is implemented or
  claimed), guarded by a bearer token (below). Requests carrying a browser
  `Origin` header are rejected `403` (DNS-rebinding protection per the MCP
  spec); missing/wrong tokens get `401`. Request bodies are size-bounded,
  sessions are capped (16) and reaped after 30 min idle.
- **Failure isolation:** if port 7738 is unavailable the app logs a sanitized
  line and continues without MCP; nothing crashes and nothing is advertised.

The tray menu shows the live endpoint URL and can copy it (never the token).

## Authentication token

Read-only LAN access uses a durable, per-installation random bearer token.
It is generated on first run and stored owner-only (`chmod 600`) in:

| Platform | Token file |
|---|---|
| macOS | `~/Library/Application Support/SysMon/mcp-token` |
| Windows | `%APPDATA%\SysMon\mcp-token` |
| Linux | `~/.config/SysMon/mcp-token` |

(Dev checkouts run under the package name, i.e. `.../sysmon/mcp-token`.)

The token is **never** printed to logs, never shown in the UI, never
advertised over mDNS, and never committed. Direct HTTP clients send it as:

```
Authorization: Bearer <token from the file above>
```

## Tools and resources

Tools (all annotated read-only):

- `get_stats` — complete snapshot: all machines (every metric, raw
  percentages and GB, 60 s CPU history, sampled/last-success times,
  live/stale/offline state), all accounts (every quota window with resets and
  staleness), CI results, `updatedAt`.
- `get_machines` — machine telemetry, optional `id` filter.
- `get_accounts` — quota windows, optional `id` / `host` / `vendor` filters.
- `get_ci` — failing-check PRs and CI sampling state.

Resources: `sysmon://snapshot`, `sysmon://machines`, `sysmon://machines/{id}`,
`sysmon://accounts`, `sysmon://accounts/{id}`, `sysmon://ci`.

No mutation, auth-control, or browser-opening tools exist. Provider cookies,
sessions, and credentials are never part of the state; a defensive filter
additionally strips any sensitively-named key before anything leaves the app.

## mDNS discovery

The app advertises via Bonjour/DNS-SD (`bonjour-service`) on all interfaces:

- `_sysmon._tcp` (instance `SysMon Monitor`) — primary service
- `_mcp._tcp` (instance `SysMon MCP`)

Both point at the actual bound port with TXT records `path=/mcp`,
`transport=streamable-http`, `version=<app version>`, `auth=bearer` — endpoint
metadata only, never stats or the token. Advertisement starts only after the
listener is verified up, and `unpublishAll` on quit sends mDNS goodbye
packets. Browse with `dns-sd -B _sysmon._tcp local.` (macOS), `avahi-browse
-r _sysmon._tcp` (Linux), or any Bonjour browser (Windows).

**Firewall:** on Windows, allow SysMon on *Private* networks when prompted
(or via Windows Defender Firewall settings) so LAN clients can reach 7738 and
receive mDNS; on macOS accept the incoming-connections prompt. The app never
creates firewall rules itself.

## stdio adapter (for stdio-only MCP clients)

Most desktop MCP clients only spawn stdio servers. The installed app ships an
adapter that bridges stdio to the running app's HTTP endpoint, reading the
token from the local userData file — so **client configs contain no secrets**:

| Platform | Command |
|---|---|
| Windows | `C:\Users\<you>\AppData\Local\SysMon\SysMon.exe --mcp-stdio` |
| macOS | `/Applications/SysMon.app/Contents/MacOS/SysMon --mcp-stdio` |
| Linux | `<install dir>/sysmon --mcp-stdio` (or the AppImage path) |

The `--mcp-stdio` dispatch runs before the single-instance lock, windows, and
provider pollers — it never opens a second GUI. For fully headless use (e.g.
an SSH session), run the binary as plain Node against the bundled asar:

```
ELECTRON_RUN_AS_NODE=1 <binary> <resources/app.asar/app/main.cjs> --mcp-stdio
```

Example client configuration (durable installed paths, no token embedded):

```json
{
  "mcpServers": {
    "sysmon": {
      "command": "C:\\Users\\ondre\\AppData\\Local\\SysMon\\SysMon.exe",
      "args": ["--mcp-stdio"]
    }
  }
}
```

Run the adapter on the same machine/OS user as the app. For a LAN client on
another machine, point any Streamable-HTTP-capable client at
`http://<sysmon-host>:7738/mcp` with the bearer token copied out-of-band, or
set `SYSMON_MCP_URL` for the adapter. SysMon never writes other tools' config
files automatically.

Environment overrides (adapter and tests): `SYSMON_MCP_URL`,
`SYSMON_MCP_TOKEN_FILE`, `SYSMON_USERDATA`.

## Test mode

With `SYSMON_TEST=1` the LAN listener and mDNS advertisement are disabled, so
flows never touch the production port or the network. `SYSMON_MCP=1` re-enables
the server inside the isolated test userData on an ephemeral port (or
`SYSMON_MCP_PORT`).
