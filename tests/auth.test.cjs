'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClaudeAuth, innerCommand, LOGIN } = require('../app/auth.cjs');

const HOSTS = [
  { id: 'minis', os: 'WINDOWS', ssh: 'ondre@Minis.local', fallback: 'ondre@192.168.1.215', local: false },
  { id: 'dictator', os: 'MAC', ssh: 'dictator@dictator.local', fallback: 'dictator@192.168.1.229', local: false },
  { id: 'umac', os: 'LINUX', ssh: 'umac@umac.local', fallback: 'umac@192.168.1.192', local: false },
];
const CLAUDE_HOSTS = ['minis', 'dictator'];

function fakeSpawn(log, code = 0) {
  return (command, args, opts) => {
    log.push({ command, args, opts });
    return { on(ev, cb) { if (ev === 'exit') setImmediate(() => cb(code)); return this; }, unref() {} };
  };
}

function make(overrides = {}) {
  const log = [];
  const writes = [];
  const launched = [];
  const auth = createClaudeAuth({
    hosts: HOSTS, claudeHosts: CLAUDE_HOSTS,
    spawnImpl: fakeSpawn(log, overrides.exitCode ?? 0),
    writeFile: async (p, content) => { writes.push({ p, content }); },
    scriptPath: (id) => `C:\\Temp\\sysmon-claude-login-${id}.cmd`,
    onLaunched: (id) => launched.push(id),
    now: () => 1000000,
    ...overrides,
  });
  return { auth, log, writes, launched };
}

test('allowlist is narrow: only hosts owning a Claude card may sign in', async () => {
  const { auth, log, writes, launched } = make();
  for (const bad of ['umac', 'grok', 'web', '', '../etc', 42, null, undefined, 'Minis', 'minis ']) {
    await assert.rejects(() => auth.connect(bad), /not eligible/);
  }
  assert.deepStrictEqual(log, []);
  assert.deepStrictEqual(writes, []);
  assert.deepStrictEqual(launched, []);
});

test('local macOS sign-in opens Terminal with the official CLI subscription flow', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'dictator' }));
  const { auth, log, launched } = make({ hosts, platform: 'darwin' });
  const r = await auth.connect('dictator');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].command, 'osascript');
  const script = log[0].args.join('\n');
  assert.match(script, /tell application "Terminal" to do script/);
  assert.match(script, /claude auth login --claudeai/);
  assert.ok(!script.includes('--console'), 'never the Console API billing flow');
  assert.deepStrictEqual(launched, ['dictator']);
});

test('remote Mac sign-in from Windows writes a .cmd running interactive ssh -t to the Mac home', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'minis' }));
  const { auth, log, writes } = make({ hosts, platform: 'win32' });
  const r = await auth.connect('dictator');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(writes.length, 1);
  assert.match(writes[0].content, /ssh -o ConnectTimeout=10 -t dictator@dictator\.local "export PATH=[^"]*; claude auth login --claudeai"/);
  assert.match(writes[0].content, /if "%errorlevel%"=="255" ssh -o ConnectTimeout=10 -t dictator@192\.168\.1\.229/);
  assert.ok(!writes[0].content.includes('--console'));
  assert.match(writes[0].content, /pause/); // window stays so the user sees the result
  assert.deepStrictEqual(log[0].args, ['/c', 'start', 'SysMon Claude sign-in', 'C:\\Temp\\sysmon-claude-login-dictator.cmd']);
});

test('local Windows sign-in runs the CLI directly, remote Windows goes over ssh -t', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'minis' }));
  const { auth, writes } = make({ hosts, platform: 'win32' });
  await auth.connect('minis');
  assert.match(writes[0].content, /\r\nclaude auth login --claudeai\r\n/);
  assert.ok(!writes[0].content.includes('ssh'));
  const remote = make({ hosts: HOSTS.map(h => ({ ...h, local: h.id === 'dictator' })), platform: 'darwin' });
  await remote.auth.connect('minis');
  const script = remote.log[0].args.join('\n');
  assert.match(script, /ssh -o ConnectTimeout=10 -t ondre@Minis\.local 'claude auth login --claudeai'/);
  assert.match(script, /if \[ \$\? -eq 255 \]; then ssh -o ConnectTimeout=10 -t ondre@192\.168\.1\.215/);
});

test('linux prefers xfce4-terminal --execute, then emulators, with a hold-open prompt', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'umac' }));
  const { auth, log } = make({ hosts, platform: 'linux' });
  const r = await auth.connect('dictator');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(log[0].command, 'sh');
  const script = log[0].args[1];
  for (const t of ['xfce4-terminal', 'gnome-terminal', 'konsole', 'x-terminal-emulator', 'xterm']) assert.ok(script.includes(t));
  assert.match(script, /xfce4-terminal\) "\$t" --execute bash -c/);
  assert.match(script, /ssh -o ConnectTimeout=10 -t dictator@dictator\.local/);
  assert.match(script, /Press Enter to close/);
});

test('linux surfaces the launcher error when no terminal emulator exists', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'umac' }));
  const stderrText = 'SysMon: no terminal emulator found (tried xfce4-terminal, gnome-terminal, konsole, x-terminal-emulator, xterm)';
  const spawnImpl = () => ({
    stderr: { on(ev, cb) { if (ev === 'data') setImmediate(() => cb(stderrText)); return this; } },
    on(ev, cb) { if (ev === 'exit') setImmediate(() => cb(1)); return this; },
    unref() {},
  });
  const { auth, launched } = make({ hosts, platform: 'linux', spawnImpl });
  const r = await auth.connect('dictator');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Could not open a terminal window for sign-in/);
  assert.match(r.message, /no terminal emulator found/); // real reason reaches the card
  assert.deepStrictEqual(launched, []);
});

test('duplicate sign-in clicks never spawn a second login child', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'dictator' }));
  const { auth, log, launched } = make({ hosts, platform: 'darwin' });
  const first = await auth.connect('dictator');
  const second = await auth.connect('dictator');
  assert.strictEqual(first.ok, true);
  assert.deepStrictEqual(second, { ok: false, message: 'Sign-in window is already open — finish it there' });
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual(launched, ['dictator']);
});

test('failed terminal launch is reported clearly and can be retried', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'dictator' }));
  const { auth, log, launched } = make({ hosts, platform: 'darwin', exitCode: 1 });
  const r = await auth.connect('dictator');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Could not open a terminal window for sign-in \(osascript exited with code 1\)/);
  assert.deepStrictEqual(launched, []); // no quota refresh scheduled for a failed launch
  const retry = make({ hosts, platform: 'darwin' });
  assert.strictEqual((await retry.auth.connect('dictator')).ok, true); // not blocked by the failure
  assert.strictEqual(log.length, 1);
});

test('concurrent connect calls spawn exactly one login window per host', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'dictator' }));
  let release;
  const gate = new Promise((r) => { release = r; });
  let spawns = 0;
  const spawnImpl = () => { spawns++; return { on(ev, cb) { if (ev === 'exit') gate.then(() => cb(0)); return this; }, unref() {} }; };
  const launched = [];
  const auth = createClaudeAuth({ hosts, claudeHosts: CLAUDE_HOSTS, platform: 'darwin', spawnImpl, onLaunched: (id) => launched.push(id), now: () => 1000000 });
  const first = auth.connect('dictator');
  const second = auth.connect('dictator'); // overlaps the in-flight launch
  release();
  const [r1, r2] = await Promise.all([first, second]);
  assert.strictEqual(spawns, 1);
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r2, { ok: false, message: 'Sign-in window is already opening — finish it there' });
  assert.deepStrictEqual(launched, ['dictator']);
  // after the successful window, the cooldown still blocks further spawns
  const third = await auth.connect('dictator');
  assert.strictEqual(third.ok, false);
  assert.strictEqual(spawns, 1);
});

test('innerCommand keeps remote auth on the owning host home, never BatchMode', () => {
  assert.strictEqual(innerCommand({ id: 'dictator', os: 'MAC', ssh: 'dictator@dictator.local', local: true }), `export PATH=$HOME/.local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH; ${LOGIN}`);
  const remote = innerCommand({ id: 'minis', os: 'WINDOWS', ssh: 'ondre@Minis.local', local: false }, 'darwin');
  assert.strictEqual(remote, `ssh -o ConnectTimeout=10 -t ondre@Minis.local '${LOGIN}'`);
  assert.ok(!remote.includes('BatchMode')); // interactive OAuth needs prompts
});

// Execute the generated commands through a real shell with a fake ssh that
// records what the REMOTE side would receive — quoting bugs that expand
// $HOME locally only show up here, not in string matching.
function fakeSsh(log, { failDns = false, exitCode = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-fakessh-'));
  const capture = path.join(dir, 'capture');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> "${capture}"`,
    'target=""; for a in "$@"; do case "$a" in *@*) target="$a";; esac; done',
    failDns ? 'case "$target" in *.local) exit 255;; esac' : ':',
    `exit ${exitCode}`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'ssh'), script, { mode: 0o755 });
  return { dir, capture };
}
function runShell(command, binDir) {
  execFileSync('sh', ['-c', command], { env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: '/LOCAL-HOME-MUST-NOT-LEAK' } });
}
function remoteCommands(capture) {
  // one line per recorded ssh argv; remote command is the last token group
  return fs.readFileSync(capture, 'utf8').trim().split('\n').filter(l => l.includes('claude'));
}
const NO_SH = { skip: process.platform === 'win32' }; // shell-execution tests need sh

test('remote command reaches ssh with $HOME unexpanded (owning host home)', NO_SH, () => {
  const { dir, capture } = fakeSsh();
  const host = { id: 'dictator', os: 'MAC', ssh: 'dictator@dictator.local', fallback: 'dictator@192.168.1.229', local: false };
  runShell(innerCommand(host, 'darwin'), dir);
  const [remote] = remoteCommands(capture);
  assert.ok(remote.includes('$HOME/.local/bin'), `local shell must not expand $HOME: ${remote}`);
  assert.ok(!remote.includes('/LOCAL-HOME-MUST-NOT-LEAK'));
  assert.ok(remote.endsWith('claude auth login --claudeai'));
});

test('linux shq-wrapped command survives bash -c with remote quoting intact', NO_SH, () => {
  const { dir, capture } = fakeSsh();
  const host = { id: 'dictator', os: 'MAC', ssh: 'dictator@dictator.local', fallback: 'dictator@192.168.1.229', local: false };
  const inner = innerCommand(host, 'linux');
  const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
  runShell(`bash -c ${shq(inner)}`, dir);
  const [remote] = remoteCommands(capture);
  assert.ok(remote.includes('$HOME/.local/bin'), `bash -c quoting must preserve remote expansion: ${remote}`);
  assert.ok(!remote.includes('/LOCAL-HOME-MUST-NOT-LEAK'));
});

test('DNS transport failure (255) retries on IP; auth cancel (1) does not', NO_SH, () => {
  const host = { id: 'dictator', os: 'MAC', ssh: 'dictator@dictator.local', fallback: 'dictator@192.168.1.229', local: false };
  const failing = fakeSsh(null, { failDns: true });
  runShell(innerCommand(host, 'darwin'), failing.dir);
  const attempts = fs.readFileSync(failing.capture, 'utf8');
  assert.ok(attempts.includes('dictator@dictator.local'));
  assert.ok(attempts.includes('dictator@192.168.1.229'), 'exit 255 must fall back to the IP');
  const cancel = fakeSsh(null, { exitCode: 1 }); // user cancelled the remote flow
  execFileSync('sh', ['-c', innerCommand(host, 'darwin')], { env: { ...process.env, PATH: `${cancel.dir}:${process.env.PATH}` } });
  const once = fs.readFileSync(cancel.capture, 'utf8');
  assert.ok(!once.includes('192.168.1.229'), 'no fallback when the first ssh session ran');
});
