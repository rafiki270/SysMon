'use strict';
// Deterministic tests: all providers run with injected stubs. No live account,
// network, or credential reads happen here (CI-safe on every platform).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { machine, accounts, claude, kimi, codex, kimiWindows, codexWindows } = require('../app/collector.cjs');

test('kimiWindows maps all three live schema shapes; malformed never becomes 0', () => {
  const w = kimiWindows({
    usage: { limit: 100, used: 25, remaining: 75, resetTime: '2026-10-05T00:00:00Z' },
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 50, used: 40, remaining: 10, resetTime: '2026-10-01T20:00:00Z' } }],
    usages: { limit_5h: { used_ratio: 0.8, reset_time: '2026-10-01T20:00:00Z' }, limit_7d: { used_ratio: 0.25, reset_time: '2026-10-05T00:00:00Z' }, junk: { used_ratio: 7 }, also_junk: { used_ratio: 'x' } },
  });
  const byLabel = Object.fromEntries(w.map((x) => [x.label, x]));
  assert.strictEqual(Math.round(byLabel['5h'].used), 80);
  assert.strictEqual(Math.round(byLabel['7d'].used), 25);
  assert.strictEqual(byLabel['5h'].resetAt, Date.parse('2026-10-01T20:00:00Z'));
  assert.ok(!('junk' in byLabel) && !('also_junk' in byLabel));
  assert.strictEqual(byLabel['Overall'].used, 25);
  assert.strictEqual(byLabel['5h (dup)'], undefined);
  // limits entry labelled 5h from duration
  assert.strictEqual(Math.round(byLabel['5h'].used), 80);
  assert.deepStrictEqual(kimiWindows({}), []);
  // missing reset stays null, never guessed
  assert.strictEqual(kimiWindows({ usages: { limit_5h: { used_ratio: 0.1 } } })[0].resetAt, null);
});

test('kimiWindows prefers authoritative detailed limits over conflicting compat ratios', () => {
  // Exact conflict observed live: usages.limit_5h.used_ratio is 0 while the
  // detailed limits entry for the same 5h window reports 24% used.
  const detailReset = '2026-10-01T23:00:00Z';
  const w = kimiWindows({
    usage: { limit: 500, used: 55, remaining: 445, resetTime: '2026-10-08T00:00:00Z' },
    limits: [
      { name: '5h', window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, used: 24, remaining: 76, resetTime: detailReset } },
      { name: '7d', window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: 200, used: 0, remaining: 200, resetTime: '2026-10-07T00:00:00Z' } },
    ],
    usages: { limit_5h: { used_ratio: 0, reset_time: '2026-10-01T20:00:00Z' }, limit_7d: { used_ratio: 0, reset_time: '2026-10-07T00:00:00Z' } },
  });
  const byLabel = Object.fromEntries(w.map((x) => [x.label, x]));
  // Main/primary window is the detailed 5h quota at 24%, never the bogus 0.
  assert.strictEqual(w[0].label, '5h');
  assert.strictEqual(w[0].used, 24);
  assert.strictEqual(w[0].resetAt, Date.parse(detailReset)); // reset of the selected detailed window
  assert.strictEqual(byLabel['5h'].used, 24);
  assert.strictEqual(byLabel['5h'].resetAt, Date.parse(detailReset));
  assert.strictEqual(byLabel['7d'].used, 0); // genuine 0 stays 0
  assert.strictEqual(byLabel['Overall'].used, 11);
});

test('kimiWindows drops null/empty/boolean ratios instead of coercing to 0', () => {
  const w = kimiWindows({ usages: {
    a: { used_ratio: null }, b: { used_ratio: '' }, c: { used_ratio: true }, d: { used_ratio: 0 },
  } });
  assert.strictEqual(w.length, 1); // only the real 0 survives
  assert.strictEqual(w[0].label, 'd');
  assert.strictEqual(w[0].used, 0);
});

test('kimiWindows: used-null falls back to remaining; corrupt pairs are dropped', () => {
  const w = kimiWindows({ limits: [
    { name: 'fromRemaining', detail: { limit: 100, used: null, remaining: 25 } },
    { name: 'usedBeyondLimit', detail: { limit: 100, used: 150 } },
    { name: 'negativeRemaining', detail: { limit: 100, used: null, remaining: -5 } },
    { name: 'boolUsed', detail: { limit: 100, used: false, remaining: null } },
    { name: 'realZero', detail: { limit: 100, used: 0, remaining: 100 } },
  ] });
  const byLabel = Object.fromEntries(w.map((x) => [x.label, x]));
  assert.strictEqual(byLabel.fromRemaining.used, 75);
  assert.strictEqual(byLabel.realZero.used, 0);
  assert.ok(!('usedBeyondLimit' in byLabel) && !('negativeRemaining' in byLabel) && !('boolUsed' in byLabel));
  // usage block: malformed usage yields no Overall window, never 0
  assert.deepStrictEqual(kimiWindows({ usage: { limit: 100, used: null, remaining: null } }), []);
  assert.strictEqual(kimiWindows({ usage: { limit: 200, remaining: 50 } })[0].used, 75);
});

test('codexWindows labels window spans accurately (no 0h, no fake weekly)', () => {
  const w = codexWindows({ rateLimitsByLimitId: {
    a: { limitId: 'a', primary: { usedPercent: 10, windowDurationMins: 15 } },
    b: { limitId: 'b', primary: { usedPercent: 10, windowDurationMins: 90 } },
    c: { limitId: 'c', primary: { usedPercent: 10, windowDurationMins: 300 } },
    d: { limitId: 'd', primary: { usedPercent: 10, windowDurationMins: 1440 } },
    e: { limitId: 'e', primary: { usedPercent: 10, windowDurationMins: 10080 } },
  } });
  const spans = w.map((x) => x.label.split('·')[1].trim());
  assert.deepStrictEqual(spans, ['15m', '1h 30m', '5h', '1d', 'weekly']);
});

test('codexWindows leads with the main bucket and drops malformed entries', () => {
  const w = codexWindows({ rateLimitsByLimitId: {
    base_model_inference: { limitId: 'base_model_inference', limitName: 'gpt-reserve', primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1790950962 } },
    codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1791320391 } },
    broken: { limitId: 'broken', primary: { usedPercent: 'nope', windowDurationMins: 60 } },
  } });
  assert.strictEqual(w.length, 2);
  assert.strictEqual(w[0].main, true);
  assert.strictEqual(w[0].used, 85);
  assert.strictEqual(w[0].resetAt, 1791320391 * 1000);
  assert.strictEqual(w[1].main, false);
  assert.strictEqual(w[1].label, 'gpt-reserve · weekly');
  assert.deepStrictEqual(codexWindows(null), []);
  assert.deepStrictEqual(codexWindows({ rateLimits: { primary: { usedPercent: null } } }), []);
});

// Fake codex app-server: speaks the JSON-RPC handshake from injected lines.
function fakeSpawn(lines, { errorOn2 = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdin = { write(x) { const v = JSON.parse(x); if (v.id === 1) reply(1); if (v.id === 2) reply(2); }, on() {} };
    child.stderr = { resume() {} };
    child.kill = () => {};
    function reply(id) {
      const payload = id === 1 ? { id: 1, result: {} } : (errorOn2 ? { id: 2, error: { message: errorOn2 } } : { id: 2, result: lines });
      setImmediate(() => child.stdout.emit('data', Buffer.from(JSON.stringify(payload) + '\n')));
    }
    child.stdout = new EventEmitter();
    return child;
  };
}

test('codex provider parses RPC result with injected spawn (no real app-server)', async () => {
  const result = await codex({ spawn: fakeSpawn({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1791000000 } } } }), command: '/nonexistent' });
  assert.strictEqual(result.status, 'live');
  assert.strictEqual(result.windows[0].used, 42);
  assert.strictEqual(result.windows[0].label, 'Codex · 5h');
});

test('codex provider maps revoked/401 RPC errors to auth through accounts()', async () => {
  const res = await accounts({ codex: { spawn: fakeSpawn(null, { errorOn2: 'GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized' }), command: '/nonexistent' }, claude: { readJson: () => null }, kimi: { readJson: () => null, tokenFor: () => null } });
  const cx = res.find((a) => a.vendor === 'Codex');
  assert.strictEqual(cx.status, 'auth');
  assert.match(cx.message, /sign in/i);
});

test('claude signed-out file (empty token, expiresAt 0) is auth without network', async () => {
  const r = await claude({ readJson: () => ({ claudeAiOauth: { accessToken: '', expiresAt: 0 } }), fetchJson: () => { throw new Error('must not fetch'); } });
  assert.strictEqual(r.status, 'auth');
  const expired = await claude({ readJson: () => ({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() - 1000 } }), fetchJson: () => { throw new Error('must not fetch'); } });
  assert.strictEqual(expired.status, 'auth');
});

test('claude live shape maps utilization windows; resets parsed, never guessed', async () => {
  const r = await claude({
    readJson: () => ({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() + 3600e3 } }),
    fetchJson: async () => ({ five_hour: { utilization: 62, resets_at: '2026-10-01T20:00:00Z' }, seven_day: { utilization: 12 }, junk: { utilization: 'x' } }),
  });
  assert.strictEqual(r.status, 'live');
  assert.strictEqual(r.windows.length, 2);
  assert.strictEqual(r.windows[0].used, 62);
  assert.strictEqual(r.windows[0].resetAt, Date.parse('2026-10-01T20:00:00Z'));
  assert.strictEqual(r.windows[1].resetAt, null);
});

test('kimi expired OAuth falls back to injected kimix token; missing everything is unavailable', async () => {
  const expiredCred = { access_token: 'x', expires_at: Math.floor(Date.now() / 1000) - 10 };
  const live = await kimi({
    readJson: (p) => p.includes('kimi-code.json') ? expiredCred : null,
    tokenFor: () => ({ token: 'stubbed', via: 'kimix' }),
    fetchJson: async () => ({ usages: { limit_5h: { used_ratio: 0.5, reset_time: '2026-10-01T20:00:00Z' } } }),
  });
  assert.strictEqual(live.status, 'live');
  assert.strictEqual(live.windows[0].used, 50);
  await assert.rejects(kimi({ readJson: () => null, tokenFor: () => null, readFile: () => { throw new Error('none'); } }), /missing/);
  const viaAccounts = await accounts({ kimi: { readJson: () => null, tokenFor: () => null, readFile: () => { throw new Error('none'); } }, codex: { spawn: fakeSpawn(null, { errorOn2: '401' }), command: '/x' }, claude: { readJson: () => null } });
  assert.strictEqual(viaAccounts.find((a) => a.vendor === 'Kimi').status, 'unavailable');
});

test('machine collector returns real local metrics (host resources only)', async () => {
  const r = await machine();
  assert.strictEqual(r.hostname, os.hostname());
  assert.ok(r.cores >= 1);
  assert.ok(r.cpu === null || (r.cpu >= 0 && r.cpu <= 100));
  assert.ok(r.mem > 0 && r.mem <= 100);
  assert.ok(r.uptime > 0);
});
