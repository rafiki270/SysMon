'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../app/renderer/shared.cjs');

test('fmtCountdown matches handover format and never fabricates', () => {
  assert.strictEqual(F.fmtCountdown((2 * 60 + 14) * 60000), '2h 14m');
  assert.strictEqual(F.fmtCountdown(37 * 60000 + 5000), '37m 05s');
  assert.strictEqual(F.fmtCountdown(31 * 3600000 + 8 * 60000), '1d 7h');
  assert.strictEqual(F.fmtCountdown(0), 'now');
  assert.strictEqual(F.fmtCountdown(-5), 'now');
  assert.strictEqual(F.fmtCountdown(null), null);
  assert.strictEqual(F.fmtCountdown(NaN), null);
});

test('fmtUptime / fmtAgo format or return null', () => {
  assert.strictEqual(F.fmtUptime(41 * 86400 + 6 * 3600), '41d 06h');
  assert.strictEqual(F.fmtUptime(3 * 86400 + 12 * 3600), '3d 12h');
  assert.strictEqual(F.fmtUptime(null), null);
  assert.strictEqual(F.fmtAgo(12000), '12s ago');
  assert.strictEqual(F.fmtAgo(5 * 60000), '5m ago');
});

test('colorFor thresholds from the design', () => {
  assert.strictEqual(F.colorFor(10), 'var(--accent)');
  assert.strictEqual(F.colorFor(75), 'var(--warn)');
  assert.strictEqual(F.colorFor(90), 'var(--crit)');
  assert.strictEqual(F.colorFor(null), 'var(--mute)');
});

test('sparkPoints needs two real samples and stays inside the viewport', () => {
  assert.strictEqual(F.sparkPoints([]), '');
  assert.strictEqual(F.sparkPoints([{ cpu: 10 }]), '');
  const pts = F.sparkPoints(Array.from({ length: 24 }, (_, i) => ({ at: i, cpu: i * 4 })));
  const coords = pts.split(' ').map((p) => p.split(',').map(Number));
  assert.strictEqual(coords.length, 24);
  assert.ok(coords.every(([x, y]) => x >= 0 && x <= 240 && y >= 0 && y <= 56));
  // null cpu samples are dropped, not drawn as zero
  const withNull = F.sparkPoints([{ cpu: null }, { cpu: 50 }, { cpu: 60 }]);
  assert.strictEqual(withNull.split(' ').length, 2);
});

test('dashFor clamps and treats missing as empty gauge', () => {
  const c = 2 * Math.PI * 40;
  assert.strictEqual(F.dashFor(50, 40), `${(c / 2).toFixed(2)} ${c.toFixed(2)}`);
  assert.strictEqual(F.dashFor(null, 40), `0.00 ${c.toFixed(2)}`);
  assert.strictEqual(F.dashFor(140, 40), `${c.toFixed(2)} ${c.toFixed(2)}`);
});

test('primaryWindow prefers the flagged main bucket over a bigger reserve', () => {
  const { primary, extras } = F.primaryWindow([
    { label: 'gpt-reserve · weekly', used: 0, main: false },
    { label: 'Codex · weekly', used: 85, main: true },
  ]);
  assert.strictEqual(primary.label, 'Codex · weekly');
  assert.strictEqual(extras.length, 1);
  assert.deepStrictEqual(F.primaryWindow([]), { primary: null, extras: [] });
});

test('boardStatus reflects worst truthful state', () => {
  assert.strictEqual(F.boardStatus([{ status: 'live' }, { status: 'live' }]), 'live');
  assert.strictEqual(F.boardStatus([{ status: 'live' }, { status: 'stale' }]), 'degraded');
  assert.strictEqual(F.boardStatus([{ status: 'offline' }, { status: 'offline' }]), 'offline');
});
