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

test('primaryWindow headlines the weekly quota over main/more-used short windows', () => {
  // Kimi: official weekly summary beats the flagged 5h window.
  const kimi = F.primaryWindow([
    { label: '5h', used: 95, main: true },
    { label: 'Kimi · weekly', used: 6, main: true },
  ]);
  assert.strictEqual(kimi.primary.label, 'Kimi · weekly');
  assert.strictEqual(kimi.extras[0].label, '5h');
  // Claude: "seven day" variants beat a main five-hour window.
  const claude = F.primaryWindow([
    { label: 'five hour', used: 91, main: true },
    { label: 'seven day', used: 40 },
  ]);
  assert.strictEqual(claude.primary.label, 'seven day');
  // Claude: the overall seven-day bucket headlines over model-specific
  // weekly sub-limits, which stay visible as secondary details.
  const claudeModels = F.primaryWindow([
    { label: 'five hour', used: 91, main: true },
    { label: 'seven day sonnet', used: 96 },
    { label: 'seven day opus', used: 70 },
    { label: 'seven day', used: 40 },
  ]);
  assert.strictEqual(claudeModels.primary.label, 'seven day');
  assert.deepStrictEqual(claudeModels.extras.map((w) => w.label), ['seven day sonnet', 'seven day opus', 'five hour']);
  // Codex: weekly main beats a hypothetical hotter short reserve.
  const codex = F.primaryWindow([
    { label: 'Codex · 5h', used: 88 },
    { label: 'Codex · weekly', used: 12, main: true },
  ]);
  assert.strictEqual(codex.primary.label, 'Codex · weekly');
  // No weekly reported (Grok website): truthful fallback, nothing invented.
  const grok = F.primaryWindow([{ label: 'Grok web', used: 40, main: true }]);
  assert.strictEqual(grok.primary.label, 'Grok web');
});

test('remaining math: 0 used -> 100 left, 100 used -> 0 left, missing stays null', () => {
  assert.strictEqual(F.remaining({ used: 0 }), 100);
  assert.strictEqual(F.remaining({ used: 100 }), 0);
  assert.strictEqual(F.remaining({ used: 23 }), 77);
  assert.strictEqual(F.remaining({ used: 140 }), 0); // clamped, never negative
  assert.strictEqual(F.remaining({ used: null }), null);
  assert.strictEqual(F.remaining(null), null);
});

test('remainingColor is scarcity-colored: green plenty, red little', () => {
  assert.strictEqual(F.remainingColor(100), 'var(--accent)');
  assert.strictEqual(F.remainingColor(26), 'var(--accent)');
  assert.strictEqual(F.remainingColor(25), 'var(--warn)');
  assert.strictEqual(F.remainingColor(11), 'var(--warn)');
  assert.strictEqual(F.remainingColor(10), 'var(--crit)');
  assert.strictEqual(F.remainingColor(0), 'var(--crit)');
  assert.strictEqual(F.remainingColor(null), 'var(--mute)');
});

test('boardStatus reflects worst truthful state', () => {
  assert.strictEqual(F.boardStatus([{ status: 'live' }, { status: 'live' }]), 'live');
  assert.strictEqual(F.boardStatus([{ status: 'live' }, { status: 'stale' }]), 'degraded');
  assert.strictEqual(F.boardStatus([{ status: 'offline' }, { status: 'offline' }]), 'offline');
});
