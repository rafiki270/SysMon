# SysMon

Full-screen operations board (Electron) for three machines and six AI-account
quota cards. Dark green ops-board styling, three layouts (radial rows, bar
columns, big numerals with real 60 s CPU sparklines), date/clock header,
failing-CI panel, system tray.

## Architecture

- `app/` — Electron main process, preload bridge, monitor, collector, link.
  - `main.cjs` — window/display placement, tray, IPC, browser connection.
  - `monitor.cjs` — aggregates machine telemetry + account readings; failed
    reads preserve the last valid reading as **stale**; hosts never reached
    stay **offline**. No fabricated values.
  - `collector.cjs` — per-provider account readers and local machine metrics.
    Runs locally for the machine the app is on, or over SSH stdin on the
    remote hosts (no remote install needed for accounts).
  - `link.cjs` — SSH tunnel management to the remote telemetry daemons
    (loopback-to-loopback, reconnect/backoff, stale watchdog).
- `daemon/` — tiny dependency-free Node telemetry daemon (CPU/mem/disk/uptime/
  top process every ~3 s, 60 s CPU history) serving WebSocket on
  **127.0.0.1:7737 only**. See `daemon/README.md`.
- `app/renderer/` — the three layouts. Values are inserted with
  `textContent`/`createElement` only; remote strings are never treated as
  markup.

Machine telemetry for each non-local host comes from its daemon when one is
available, reached through SSH tunnels (local ports 17378 Minis / 17379
dictator / 17380 umac → remote 127.0.0.1:7737); otherwise the app falls back
to running the collector over SSH stdin. Minis has no daemon, so it always
uses the SSH collector. No unauthenticated LAN port is ever opened; the
daemon refuses non-loopback binds even if the host env var is overridden and
rejects WebSocket upgrades carrying a browser `Origin`.

## Hosts

| Host     | OS      | SSH (DNS first, IP fallback)                         | Metrics source     |
|----------|---------|------------------------------------------------------|--------------------|
| Minis    | Windows | `ondre@Minis.local` / `ondre@192.168.1.215`          | collector over SSH |
| dictator | macOS   | `dictator@dictator.local` / `dictator@192.168.1.229` | daemon (or local)  |
| umac     | Linux   | `umac@umac.local` / `umac@192.168.1.192`             | daemon (or local)  |

Ubuntu shares a subscription, so only machine metrics are shown for it — no
duplicate account card.

## Account providers (honest limitations)

Six cards: Codex and Claude on Minis, Codex and Claude on dictator, Kimi on
dictator, Grok (website subscription).

Every card headlines its **weekly** quota as **percent remaining**
("N% left"), with the gauge/bar filling with what is left and scarcity
colors (green plenty, amber/red little). Provider-reported shorter windows
(Kimi 5-hour, Claude five hour) and model-specific weekly sub-limits (seven
day sonnet/opus) stay as secondary "% left" details, and the headline reset
countdown is the weekly window's own reported reset. Nothing is invented:
when a provider reports no weekly window (Grok website), the most truthful
reported window headlines instead, and raw `used` values stay in state for
MCP consumers. The Kimi headline is the top-level `usage` block — the
official Kimi CLI labels it "Weekly limit" — preferred over the
compatibility 7d mirror. Machine CPU/memory/disk keep their utilization
semantics.

- **Codex** — read-only rate-limit RPC against the local Codex app-server.
  The RPC returns several buckets; the reserve bucket is not the headline —
  the main `codex` bucket is shown first, other buckets compactly. Windows are
  labelled from their actual span (minutes/hours/days/weekly). Codex is only
  ever used as an account-usage reader, never for inference.
- **Claude** — OAuth usage endpoint using the CLI's own stored credentials
  (file, then keychain fallback on macOS). Refresh is owned by the CLI; the
  app never rotates shared tokens. Expired credentials surface as an explicit
  **auth** state with a working **Sign in** control (see below).
- **Kimi** — `GET https://api.kimi.com/coding/v1/usages` (the endpoint the
  public Kimi CLI uses). Token order: valid native CLI OAuth credentials,
  then `KIMI_API_KEY`, then the local Kimix API key (`~/.kimix/token`), then
  a matching provider `api_key` in the native CLI config. The detailed
  `limits`/`usage` shapes are authoritative; the legacy `usages` ratios are a
  compatibility mirror and can disagree — on conflict the highest valid
  utilization wins, keeping that window's own reset. Malformed values are
  dropped, never coerced to 0.
- **Grok** — *website* subscription (not the xAI API). A persistent isolated
  Chrome/Edge profile holds the user's own sign-in; Connect opens a normal
  browser window supporting Google sign-in. Without a session the card
  shows an explicit **Connect** state and the app asks the user to sign in.
  Quota polling uses the site's private/internal `/rest/rate-limits` shape on
  a best-effort basis: it is undocumented, may change or be blocked, and is
  only claimed live after a real signed-in response. The app never sends an
  inference/chat request to measure usage, never copies Chrome cookies, and
  never invents reset times — unknown resets render as "unknown". The
  browser debug connection listens only on loopback and never exposes cookies
  through the monitor or MCP. Keep that browser open for quota updates.

Credentials are read locally and never logged, printed, or sent to the
renderer beyond derived quota numbers.

## Claude sign-in

Both Claude cards carry a functional **Sign in** (`auth`) / **Renew sign-in**
(`stale`) control. Clicking it renews the *owning machine's* Claude Code
subscription session through the official CLI — `claude auth login
--claudeai`, the CLI's default Claude.ai subscription OAuth flow (verified
against `claude auth login --help`; the `--console` Anthropic Console
API-billing flow is never used) — inside a platform-appropriate user-visible
terminal window:

- **Owning host is local** — the CLI runs directly: Terminal.app via
  AppleScript on macOS, a `cmd` window on Windows, the first available
  terminal emulator on Linux.
- **Owning host is remote** — an interactive `ssh -t <host>` session runs the
  CLI on the remote machine inside a local terminal window, so the OAuth
  browser/code step completes against the remote home directory (credentials
  file / keychain). No tokens ever cross to the app.

The CLI owns the entire OAuth flow and credential store; the app never reads,
prints, or logs tokens. Duplicate clicks never spawn a second login (a
per-host cooldown reports "already open" instead), a failed terminal launch
is reported on the card, and the host's quota is re-read promptly (at ~20 s,
60 s and 120 s) once sign-in has had time to complete; refresh requests are
serviced by the host's single existing poll chain (one pending timer, one
in-flight read per host — never parallel pollers). The IPC handler only
accepts the narrow allowlist of host ids that own a Claude card.

## CI panel

Shows open PRs authored by the signed-in `gh` user that have failing checks
(`gh api` search: `is:pr is:open author:@me status:failure`). It only lists
failures it actually found — stale data is shown as stale, never as
"all green".

## Controls

- Layout switch (top right, `1a` radial / `1b` bars / `1c` numerals) persists
  via IPC settings and survives restart.
- `Esc` / `F11` toggle fullscreen; tray menu offers display selection,
  "Show on second display", autostart (Login Item on macOS/Windows, XDG
  autostart file on Linux) and quit. Autostart opt-out is remembered.
- Display placement: prefers the non-primary display; an explicit choice
  persists across disconnection. One or no display uses a framed window;
  reconnecting the second display restores fullscreen there, including after
  sleep. Developed for the 1920x720 secondary above a
  1920x1080 primary; all three layouts fit six cards at 1920x720.

## MCP server + mDNS

The full monitor state (every machine metric and CPU history, every account
quota window, CI results) is served read-only over MCP Streamable HTTP at
`http://<lan-ip>:7738/mcp`, authenticated by a durable per-installation
bearer token in the protected userData `mcp-token` file, and advertised on
the LAN as `_sysmon._tcp` / `_mcp._tcp` via Bonjour (endpoint metadata only —
never stats or the token). Stdio-only MCP clients use the installed app's
`--mcp-stdio` adapter, which reads the token locally so client configs hold
no secrets. See [docs/MCP.md](docs/MCP.md).

## Development

```sh
npm ci
npm test              # unit tests (node --test)
npm run test:flows    # Playwright Electron flows (xvfb-run on Linux CI)
npm run pack          # electron-builder --dir
npm run dist          # Windows portable, macOS dmg+dir, Linux AppImage+dir
```

Native packaging verified: macOS arm64 dmg/dir and Linux x64 AppImage/dir
build unsigned (no signing certificate available in this environment);
Windows x64 directory packaging passes CI; the installed build was verified
fullscreen on Minis. The portable target is configured but was not validated.
`SYSMON_TEST=1` (with `SYSMON_USERDATA`
and optional `SYSMON_FIXTURE`) disables real polling, login windows and
autostart so tests never touch user settings or credentials.

## Telemetry daemon

Install once per macOS/Linux machine; the app tunnels to it over SSH:

```sh
sh daemon/install.sh [path-to-node]   # copies to ~/.local/share/sysmon/daemon
sh daemon/uninstall.sh
```

Details in `daemon/README.md`.
