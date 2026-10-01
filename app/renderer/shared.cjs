// Pure display helpers shared by the renderer and the unit tests.
// No DOM, no Electron — safe to require from node:test.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SysmonFmt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

  // Threshold colors from the handover design.
  function colorFor(v) {
    if (v == null || !Number.isFinite(v)) return 'var(--mute)';
    if (v >= 90) return 'var(--crit)';
    if (v >= 75) return 'var(--warn)';
    return 'var(--accent)';
  }

  // Quota cards headline remaining quota, so scarcity colors invert the
  // utilization thresholds: plenty left stays green, little left goes red.
  function remainingColor(left) {
    if (left == null || !Number.isFinite(left)) return 'var(--mute)';
    if (left <= 10) return 'var(--crit)';
    if (left <= 25) return 'var(--warn)';
    return 'var(--accent)';
  }

  // Percent remaining for a quota window; missing usage stays missing.
  function remaining(w) {
    return w && Number.isFinite(w.used) ? clamp(100 - w.used) : null;
  }

  // Countdown like the handover: "2h 14m", "37m 05s", "5d 2h", "now".
  function fmtCountdown(ms) {
    if (ms == null || !Number.isFinite(ms)) return null;
    if (ms <= 0) return 'now';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${m}m ${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}s`;
  }

  function fmtUptime(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return null;
    const m = Math.floor(seconds / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${String(h % 24).padStart(2, '0')}h`;
    if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${m}m`;
  }

  function fmtAgo(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  function fmtGB(v) {
    if (v == null || !Number.isFinite(v)) return null;
    return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  }

  // SVG polyline points for a 60s history, handover geometry (240x56 viewport).
  function sparkPoints(history, width = 240, height = 56) {
    const vals = (history || []).map((x) => x.cpu).filter((v) => Number.isFinite(v));
    if (vals.length < 2) return '';
    const n = vals.length;
    return vals.map((v, i) => `${((i / (n - 1)) * width).toFixed(1)},${(height - 1 - (clamp(v) / 100) * (height - 4)).toFixed(1)}`).join(' ');
  }

  // stroke-dasharray for a radial gauge of radius r.
  function dashFor(percent, r) {
    const c = 2 * Math.PI * r;
    const p = percent == null || !Number.isFinite(percent) ? 0 : clamp(percent);
    return `${(p / 100 * c).toFixed(2)} ${c.toFixed(2)}`;
  }

  function pct(v) {
    return v == null || !Number.isFinite(v) ? null : Math.round(v);
  }

  // Overall board health for the header indicator.
  function boardStatus(machines) {
    const s = (machines || []).map((m) => m.status);
    if (s.length && s.every((x) => x === 'live')) return 'live';
    if (s.some((x) => x === 'live' || x === 'stale')) return 'degraded';
    return 'offline';
  }

  // Weekly-shaped windows as named by the providers: Codex "· weekly",
  // Kimi "· weekly"/compat "7d", Claude "seven day" (and its *_sonnet etc.
  // variants). Label-based, so renamed buckets are still recognized.
  function isWeeklyWindow(label) {
    return /weekly|seven[\s_-]?day|\b7\s?d\b/i.test(String(label || ''));
  }

  // Among weekly windows the provider's overall bucket headlines; model-
  // specific weekly sub-limits ("seven day sonnet", "… opus") are extras.
  function weeklyTier(w) {
    if (!isWeeklyWindow(w.label)) return 0;
    return /sonnet|opus|haiku/i.test(String(w.label)) ? 1 : 2;
  }

  // Pick the primary window: the weekly quota always headlines; shorter
  // provider windows (5h etc.) stay secondary even when flagged main or
  // more consumed. Ties fall back to the main flag, then most used.
  function primaryWindow(windows) {
    const list = (windows || []).filter((w) => Number.isFinite(w.used));
    if (!list.length) return { primary: null, extras: [] };
    const sorted = list.slice().sort((a, b) => weeklyTier(b) - weeklyTier(a) || (b.main ? 1 : 0) - (a.main ? 1 : 0) || b.used - a.used);
    return { primary: sorted[0], extras: sorted.slice(1) };
  }

  return { clamp, colorFor, remainingColor, remaining, fmtCountdown, fmtUptime, fmtAgo, fmtGB, sparkPoints, dashFor, pct, boardStatus, isWeeklyWindow, weeklyTier, primaryWindow };
});
