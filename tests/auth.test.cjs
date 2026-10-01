'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createClaudeAuth, innerCommand, LOGIN } = require('../app/auth.cjs');

const HOSTS = [
  { id: 'minis', os: 'WINDOWS', ssh: 'ondre@Minis.local', local: false },
  { id: 'dictator', os: 'MAC', ssh: 'dictator@dictator.local', local: false },
  { id: 'umac', os: 'LINUX', ssh: 'umac@umac.local', local: false },
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
  assert.match(script, /ssh -o ConnectTimeout=10 -t ondre@Minis\.local \\"claude auth login --claudeai\\"/);
});

test('linux falls back through terminal emulators with a hold-open prompt', async () => {
  const hosts = HOSTS.map(h => ({ ...h, local: h.id === 'umac' }));
  const { auth, log } = make({ hosts, platform: 'linux' });
  const r = await auth.connect('dictator');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(log[0].command, 'sh');
  const script = log[0].args[1];
  for (const t of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) assert.ok(script.includes(t));
  assert.match(script, /ssh -o ConnectTimeout=10 -t dictator@dictator\.local/);
  assert.match(script, /Press Enter to close/);
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
  assert.deepStrictEqual(r, { ok: false, message: 'Could not open a terminal window for sign-in' });
  assert.deepStrictEqual(launched, []); // no quota refresh scheduled for a failed launch
  const retry = make({ hosts, platform: 'darwin' });
  assert.strictEqual((await retry.auth.connect('dictator')).ok, true); // not blocked by the failure
  assert.strictEqual(log.length, 1);
});

test('innerCommand keeps remote auth on the owning host home, never BatchMode', () => {
  assert.strictEqual(innerCommand({ id: 'dictator', os: 'MAC', ssh: 'dictator@dictator.local', local: true }), `export PATH=$HOME/.local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH; ${LOGIN}`);
  const remote = innerCommand({ id: 'minis', os: 'WINDOWS', ssh: 'ondre@Minis.local', local: false });
  assert.strictEqual(remote, `ssh -o ConnectTimeout=10 -t ondre@Minis.local "${LOGIN}"`);
  assert.ok(!remote.includes('BatchMode')); // interactive OAuth needs prompts
});
