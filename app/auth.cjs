// Claude Code subscription sign-in launcher.
//
// Clicking "Sign in" on a Claude card renews the OWNING machine's Claude Code
// subscription session through the official CLI (`claude auth login`), run in
// a user-visible terminal window. `--claudeai` is the CLI's default Claude.ai
// subscription OAuth flow (verified via `claude auth login --help`); the
// `--console` Anthropic Console API-billing flow is never used.
//
// The CLI owns the whole OAuth flow and the credential store: tokens land in
// the owning host's home directory (credentials file / macOS keychain) and
// are never read, printed, or logged by the app. Remote hosts are reached
// over an interactive SSH session (`ssh -t`) shown in a local terminal
// window, so the browser/code step completes against the remote home.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LOGIN = 'claude auth login --claudeai';
// claude is a user-level install on macOS/Linux; a fresh terminal on a remote
// host may not have it on PATH yet.
const PATH_PREFIX = 'export PATH=$HOME/.local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH; ';

function innerCommand(host) {
  if (host.local) return host.os === 'WINDOWS' ? LOGIN : PATH_PREFIX + LOGIN;
  const remote = host.os === 'WINDOWS' ? LOGIN : PATH_PREFIX + LOGIN;
  return `ssh -o ConnectTimeout=10 -t ${host.ssh} "${remote}"`;
}

const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

// Platform-appropriate, user-visible terminal on the machine running the app.
// Returns { command, args } for spawn; may be async (Windows writes a .cmd).
function loginSpec(host, platform, deps) {
  const inner = innerCommand(host);
  if (platform === 'darwin') {
    const esc = inner.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    return { command: 'osascript', args: ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script "${esc}"`] };
  }
  if (platform === 'win32') {
    // A .cmd file avoids start/cmd/ssh quoting loss; no secrets inside.
    const file = deps.scriptPath(host.id);
    return deps.writeFile(file, `@echo off\r\n${inner}\r\npause\r\n`).then(() => ({ command: 'cmd.exe', args: ['/c', 'start', 'SysMon Claude sign-in', file] }));
  }
  // Linux: first available terminal emulator, detached from this process.
  const hold = `${inner}; echo; read -r -p "Press Enter to close" _`;
  const script = 'for t in x-terminal-emulator gnome-terminal konsole xterm; do '
    + 'command -v "$t" >/dev/null 2>&1 || continue; '
    + `case "$t" in gnome-terminal) "$t" -- bash -c ${shq(hold)} & ;; *) "$t" -e bash -c ${shq(hold)} & ;; esac; `
    + 'exit 0; done; echo "no terminal emulator found" >&2; exit 1';
  return { command: 'sh', args: ['-c', script] };
}

function launch(spec, spawnImpl) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawnImpl(spec.command, spec.args, { detached: true, stdio: 'ignore', windowsHide: true }); }
    catch (e) { reject(e); return; }
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${spec.command} exited with code ${code}`))));
    if (p.unref) p.unref();
  });
}

// hosts: [{ id, os, ssh, local }]; claudeHosts: allowlisted host ids owning a
// Claude account card. onLaunched(hostId) schedules a prompt quota refresh.
function createClaudeAuth({ hosts, claudeHosts, platform = process.platform, spawnImpl = spawn, writeFile, scriptPath, onLaunched = null, cooldownMs = 120000, now = () => Date.now() } = {}) {
  const deps = {
    writeFile: writeFile || ((file, content) => fs.promises.writeFile(file, content, { mode: 0o600 })),
    scriptPath: scriptPath || ((hostId) => path.join(os.tmpdir(), `sysmon-claude-login-${hostId}.cmd`)),
  };
  const launched = new Map(); // hostId -> timestamp of last successful launch
  return {
    async connect(hostId) {
      if (typeof hostId !== 'string' || !claudeHosts.includes(hostId)) throw new Error('Host is not eligible for Claude sign-in');
      const host = hosts.find((h) => h.id === hostId);
      if (!host) throw new Error('Unknown host');
      const last = launched.get(hostId) || 0;
      if (now() - last < cooldownMs) return { ok: false, message: 'Sign-in window is already open — finish it there' };
      let spec;
      try { spec = await loginSpec(host, platform, deps); }
      catch { return { ok: false, message: 'Could not prepare the sign-in window' }; }
      try { await launch(spec, spawnImpl); }
      catch { return { ok: false, message: 'Could not open a terminal window for sign-in' }; }
      launched.set(hostId, now());
      if (onLaunched) onLaunched(hostId);
      return { ok: true, message: 'Sign-in opened in a terminal — finish it there; quota refreshes automatically' };
    },
  };
}

module.exports = { createClaudeAuth, innerCommand, LOGIN, PATH_PREFIX };
