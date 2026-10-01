'use strict';
// Shared launch helper for Electron flows. SYSMON_TEST disables real polling,
// logins and autostart; every run gets an isolated userData dir so user
// settings are never touched. Any renderer exception or console error is
// collected and must be asserted empty — a launching window is not a
// rendering board.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');

function history(now, base) {
  const out = [];
  for (let i = 24; i >= 0; i--) out.push({ at: now - i * 2500, cpu: base + Math.round(Math.sin(i / 3) * 8) });
  return out;
}

function baseFixture(now = Date.now()) {
  return {
    initial: {
      machines: [
        { id: 'minis', status: 'live', source: 'local', cores: 16, cpu: 74, mem: 82, memUsed: 52.4, memTotal: 64, disk: 54, diskFree: 460, uptime: 302400, load: null, topProc: 'Code.exe', topPct: 44, sampledAt: now, history: history(now, 70) },
        { id: 'dictator', status: 'live', source: 'daemon', cores: 10, cpu: 21, mem: 47, memUsed: 16.1, memTotal: 34.3, disk: 88, diskFree: 127, uptime: 852000, load: 2.1, topProc: 'node', topPct: 12, sampledAt: now, history: history(now, 22) },
        { id: 'umac', status: 'offline', sampledAt: null, history: [] },
      ],
      accounts: [
        { id: 'minis-Codex', status: 'live', windows: [{ label: 'Codex · weekly', used: 100, resetAt: now + 4.5 * 86400000, main: true }, { label: 'gpt-reserve · weekly', used: 0, resetAt: now + 86400000 }], sampledAt: now },
        { id: 'minis-Claude', status: 'auth', message: 'Open Claude Code to sign in', windows: [] },
        { id: 'dictator-Codex', status: 'live', windows: [{ label: 'Codex · weekly', used: 85, resetAt: now + 4.5 * 86400000, main: true }], sampledAt: now },
        { id: 'dictator-Claude', status: 'stale', windows: [{ label: 'five hour', used: 91, resetAt: now + 7200000, main: true }, { label: 'seven day sonnet', used: 55, resetAt: now + 2 * 86400000 }, { label: 'seven day', used: 12, resetAt: now + 3 * 86400000 }], sampledAt: now - 400000, lastSuccessAt: now - 400000 },
        { id: 'dictator-Kimi', status: 'live', windows: [{ label: 'Kimi · weekly', used: 6, resetAt: now + 5 * 86400000, main: true }, { label: '5h', used: 23, resetAt: now + 95000 }], sampledAt: now },
        { id: 'grok', status: 'auth', message: 'Connect Grok', windows: [] },
      ],
      ci: { status: 'live', sampledAt: now, scope: 'Open PRs authored by you with failing checks', jobs: [{ repo: 'rafiki270/SysMon', number: 12, url: 'https://github.com/rafiki270/SysMon/pull/12', title: 'x' }] },
    },
  };
}

async function launch(fixture, { userdata } = {}) {
  const dir = userdata || fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-flow-'));
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, SYSMON_TEST: '1', SYSMON_USERDATA: dir };
  if (fixture) {
    const fixtureFile = path.join(dir, 'fixture.json');
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
    env.SYSMON_FIXTURE = fixtureFile;
  }
  const app = await _electron.launch({ args: [ROOT], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.waitForSelector('[data-m]', { timeout: 20000 });
  return { app, page, errors, dir };
}

module.exports = { launch, baseFixture, ROOT };
