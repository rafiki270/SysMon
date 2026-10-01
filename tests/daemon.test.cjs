'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
process.env.SYSMON_DAEMON_PORT = '17399';
const { Daemon, memory, disk } = require('../daemon/sysmon-daemon.cjs');
const ws = require('../daemon/ws.cjs');

test('memory and disk return real positive numbers', () => {
  const m = memory();
  assert.ok(m.total > 0 && m.used >= 0 && m.used <= m.total);
  const d = disk();
  assert.ok(d.total > 0 && d.free >= 0);
});

test('daemon sample produces truthful metric shape without fabricating cpu', async () => {
  const d = new Daemon({ interval: 250 });
  const s = await d.sample();
  assert.ok(['MAC', 'LINUX', 'WINDOWS'].includes(s.os) || typeof s.os === 'string');
  assert.strictEqual(s.hostname, os.hostname());
  assert.ok(s.cores >= 1);
  assert.ok(s.mem > 0 && s.mem <= 100);
  assert.ok(s.uptime > 0);
  assert.ok(s.sampledAt > 0);
  // cpu is a real delta; first sample may legitimately be null
  assert.ok(s.cpu === null || (s.cpu >= 0 && s.cpu <= 100));
  const s2 = await d.sample();
  assert.ok(s2.cpu === null || (s2.cpu >= 0 && s2.cpu <= 100));
  assert.ok(s2.sampledAt >= s.sampledAt);
});

test('history ring trims to 60s window', async () => {
  const d = new Daemon({ interval: 100, historyMs: 60000 });
  const old = Date.now() - 120000;
  d.history = [{ at: old, cpu: 50 }, { at: Date.now() - 500, cpu: 10 }];
  await d.sample();
  assert.ok(d.history.every((x) => x.at > Date.now() - 60000));
  assert.ok(!d.history.some((x) => x.at === old));
});

test('daemon serves hello on connect and broadcasts ticks', async () => {
  const d = new Daemon({ interval: 300 });
  await d.start();
  try {
    await d.sample();
    const c = await ws.connect({ port: 17399 });
    const first = JSON.parse(await new Promise((r) => c.on('message', r)));
    assert.strictEqual(first.type, 'metrics');
    assert.ok(Array.isArray(first.history));
    const pushed = JSON.parse(await new Promise((r) => c.on('message', r)));
    assert.ok(pushed.sampledAt >= first.sampledAt);
    c.close();
  } finally { d.stop(); }
});

test('health endpoint answers on loopback', async () => {
  const d = new Daemon({ interval: 5000 });
  await d.start();
  try {
    const body = await new Promise((resolve, reject) => {
      require('node:http').get('http://127.0.0.1:17399/health', (res) => {
        let b = ''; res.on('data', (x) => b += x); res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    assert.strictEqual(JSON.parse(body).ok, true);
  } finally { d.stop(); }
});
