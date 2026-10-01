'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadCollector(home) {
  // Load a fresh copy of the collector with a patched homedir.
  const file = path.join(__dirname, '..', 'app', 'collector.cjs');
  delete require.cache[require.resolve(file)];
  const osStub = Object.create(os);
  osStub.homedir = () => home;
  const src = fs.readFileSync(file, 'utf8');
  const m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  const req = (id) => id === 'node:os' || id === 'os' ? osStub : require(id);
  m._compile('(function(require,module,exports){' + src + '\n})', file);
  const fn = new Function('require', 'module', 'exports', src);
  fn(req, m, m.exports);
  return m.exports;
}

const { kimiWindows } = require('../app/collector.cjs');

test('kimiWindows maps usage + limits shapes and never invents resets', () => {
  const w = kimiWindows({ usage: { limit: 100, used: 25, resetTime: '2026-10-05T00:00:00Z' } });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].used, 25);
  assert.strictEqual(w[0].resetAt, Date.parse('2026-10-05T00:00:00Z'));
  const w2 = kimiWindows({ limits: [{ name: '5h', detail: { limit: 50, remaining: 10 } }] });
  assert.strictEqual(w2[0].used, 80);
  assert.strictEqual(w2[0].resetAt, null); // no reset reported -> null, not guessed
  assert.deepStrictEqual(kimiWindows({}), []);
});

test('machine collector returns real local metrics', async () => {
  const { machine } = require('../app/collector.cjs');
  const r = await machine();
  assert.strictEqual(r.hostname, os.hostname());
  assert.ok(r.cores >= 1);
  assert.ok(r.cpu === null || (r.cpu >= 0 && r.cpu <= 100));
  assert.ok(r.mem > 0 && r.mem <= 100);
  assert.ok(r.disk === null || (r.disk > 0 && r.disk <= 100));
  assert.ok(r.uptime > 0);
  assert.ok(Number.isFinite(r.sampledAt));
});

test('claude with signed-out credentials file returns auth, not unavailable', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-test-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: 0 } }));
  const c = loadCollector(home);
  const accounts = await c.accounts();
  const claude = accounts.find((a) => a.vendor === 'Claude');
  assert.strictEqual(claude.status, 'auth');
  assert.match(claude.message, /sign in/i);
});

test('claude with expired token returns auth without calling the API', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-test-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() - 1000 } }));
  const c = loadCollector(home);
  const claude = (await c.accounts()).find((a) => a.vendor === 'Claude');
  assert.strictEqual(claude.status, 'auth');
});

test('kimi with expired token returns auth; missing credentials return unavailable', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-test-'));
  fs.mkdirSync(path.join(home, '.kimi-code', 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kimi-code', 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'x', expires_at: Math.floor(Date.now() / 1000) - 10 }));
  let c = loadCollector(home);
  let kimi = (await c.accounts()).find((a) => a.vendor === 'Kimi');
  assert.strictEqual(kimi.status, 'auth');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-test-'));
  c = loadCollector(empty);
  kimi = (await c.accounts()).find((a) => a.vendor === 'Kimi');
  assert.strictEqual(kimi.status, 'unavailable');
  assert.match(kimi.message, /credentials/i);
}, { timeout: 30000 });
