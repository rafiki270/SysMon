'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Monitor, reconcileAccount, hosts } = require('../app/monitor.cjs');

test('six account cards: Codex+Claude on Minis and dictator, Kimi on dictator, Grok web; none for umac or Maxis', () => {
  const m = new Monitor();
  const ids = m.state.accounts.map((a) => a.id);
  assert.deepStrictEqual(ids.sort(), ['dictator-Claude', 'dictator-Codex', 'dictator-Kimi', 'grok', 'minis-Claude', 'minis-Codex'].sort());
  assert.ok(!m.state.accounts.some((a) => a.host === 'umac' || a.host === 'maxis'));
  assert.deepStrictEqual(m.state.machines.map((x) => x.id), ['minis', 'dictator', 'umac', 'maxis']);
});

test('applyMetrics stores real values and daemon history; never fabricates', () => {
  const m = new Monitor();
  const host = hosts.find((h) => h.id === 'dictator');
  m.applyMetrics(host, { type: 'metrics', source: 'daemon', cpu: 42.4, mem: 55, disk: 70, uptime: 100, history: [{ at: 1, cpu: 1 }, { at: 2, cpu: null }], sampledAt: Date.now() });
  const s = m.machine('dictator');
  assert.strictEqual(s.status, 'live');
  assert.strictEqual(s.cpu, 42.4);
  assert.strictEqual(s.history.length, 1); // null cpu samples filtered
});

test('collector-source metrics build a local 60s ring', () => {
  const m = new Monitor();
  const host = hosts.find((h) => h.id === 'umac');
  const now = Date.now();
  m.applyMetrics(host, { source: 'collector', cpu: 10, sampledAt: now - 61000 });
  m.applyMetrics(host, { source: 'collector', cpu: 20, gpu: 35, sampledAt: now });
  const s = m.machine('umac');
  assert.strictEqual(s.cpu, 20);
  assert.strictEqual(s.history.length, 1); // older than 60s trimmed
  assert.strictEqual(s.history[0].cpu, 20);
  assert.strictEqual(s.history[0].gpu, 35);
});

test('degrade preserves last valid reading as stale instead of zeroing', () => {
  const m = new Monitor();
  const host = hosts.find((h) => h.id === 'dictator');
  m.applyMetrics(host, { source: 'daemon', cpu: 33, mem: 44, sampledAt: Date.now() });
  m.degrade(host, 'offline');
  const s = m.machine('dictator');
  assert.strictEqual(s.status, 'stale');
  assert.strictEqual(s.cpu, 33);
  assert.strictEqual(s.mem, 44);
});

test('degrade on never-reached host is offline, not stale', () => {
  const m = new Monitor();
  m.degrade(hosts.find((h) => h.id === 'umac'), 'offline');
  assert.strictEqual(m.machine('umac').status, 'offline');
  assert.strictEqual(m.machine('umac').cpu, undefined);
});

test('reconcileAccount keeps last good windows when provider fails', () => {
  const live = reconcileAccount(null, { vendor: 'Codex', status: 'live', windows: [{ label: 'x', used: 40, resetAt: 1 }], sampledAt: 100 });
  const stale = reconcileAccount(live, { vendor: 'Codex', status: 'unavailable', windows: [] });
  assert.strictEqual(stale.status, 'stale');
  assert.strictEqual(stale.windows.length, 1);
  assert.strictEqual(stale.lastSuccessAt, 100);
  const again = reconcileAccount(stale, { vendor: 'Codex', status: 'live', windows: [{ label: 'x', used: 41, resetAt: 2 }], sampledAt: 200 });
  assert.strictEqual(again.status, 'live');
  assert.strictEqual(again.lastSuccessAt, 200);
});

test('reconcileAccount without history stays explicit unavailable/auth', () => {
  const r = reconcileAccount(null, { vendor: 'Kimi', status: 'auth', message: 'sign in', windows: [] });
  assert.strictEqual(r.status, 'auth');
  const u = reconcileAccount(null, { vendor: 'Kimi', status: 'unavailable', windows: [] });
  assert.strictEqual(u.status, 'unavailable');
});

test('setGrok updates the web card', () => {
  const m = new Monitor();
  m.setGrok({ vendor: 'Grok', status: 'live', sampledAt: Date.now(), windows: [{ label: 'Grok auto · 2h', used: 12, resetAt: null }] });
  const g = m.state.accounts.find((a) => a.id === 'grok');
  assert.strictEqual(g.status, 'live');
  assert.strictEqual(g.windows[0].used, 12);
});

test('watchdog marks silent live machines stale', () => {
  const m2 = new Monitor();
  m2.applyMetrics(hosts[0], { source: 'local', cpu: 5, sampledAt: Date.now() - 20000 });
  m2.watchdog();
  m2.stop();
  assert.strictEqual(m2.machine(hosts[0].id).status, 'stale');
});

test('refreshAccounts is serviced by the single existing chain — never parallel chains', async () => {
  const reads = [];
  const m = new Monitor({ readAccounts: async (host) => { reads.push(host.id); return []; } });
  m.started = true;
  const host = hosts.find((h) => h.id === 'dictator');
  await m.accounts(host); // the one chain start() would create
  assert.strictEqual(m.timers.size, 1);
  assert.strictEqual(m.accountTimers.size, 1);
  // Repeated sign-in refreshes (e.g. 20s/60s/120s timers) must not add chains.
  m.refreshAccounts('dictator');
  m.refreshAccounts('dictator');
  m.refreshAccounts('dictator');
  assert.strictEqual(m.timers.size, 1);
  assert.strictEqual(m.accountTimers.size, 1);
  await new Promise((r) => setTimeout(r, 30)); // let the nudge tick run
  assert.ok(reads.length >= 2, 'refresh was serviced promptly');
  assert.strictEqual(m.timers.size, 1, 'still exactly one chain after servicing');
  m.stop();
  assert.strictEqual(m.timers.size, 0);
});

test('a completed requested refresh advances to the normal deadline — no 5s polling', async () => {
  const reads = [];
  const m = new Monitor({ readAccounts: async (host) => { reads.push(host.id); return []; } });
  m.started = true;
  const host = hosts.find((h) => h.id === 'minis');
  await m.accounts(host);
  m.refreshAccounts('minis');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(reads.length, 2, 'one initial read + one requested refresh');
  // The refresh marker is consumed at read start: the deadline must advance
  // to the normal interval, never stick at 0 (which would poll every 5s).
  assert.ok(m.accountNext.minis > Date.now() + 60000, `deadline advanced, got ${m.accountNext.minis - Date.now()}ms`);
  await m.accounts(host); // chain tick: future deadline -> no further read
  assert.strictEqual(reads.length, 2);
  m.stop();
});

test('a refresh queued during an in-flight read causes exactly one extra read, then advances', async () => {
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const m = new Monitor({ readAccounts: async () => { calls += 1; if (calls === 1) await gate; return []; } });
  m.started = true;
  const host = hosts.find((h) => h.id === 'minis');
  const inflight = m.accounts(host); // read parks on the gate
  m.refreshAccounts('minis'); // queued while busy: marker set, no new chain
  assert.strictEqual(m.timers.size, 1);
  release();
  await inflight;
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(calls, 2, 'exactly one extra read for the queued refresh');
  assert.ok(m.accountNext.minis > Date.now() + 60000, 'deadline advanced after the extra read');
  await m.accounts(host); // future deadline -> no third read
  assert.strictEqual(calls, 2);
  assert.strictEqual(m.timers.size, 1);
  assert.strictEqual(m.accountTimers.size, 1);
  m.stop();
});
