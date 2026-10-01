'use strict';
// Claude sign-in control: both Claude cards (auth and stale) expose a real
// sign-in action. In SYSMON_TEST the main process records the allowlisted
// launch instead of spawning a terminal — no real auth, browser, or SSH.
//
// Platform-agnostic: which host is local comes from the live snapshot
// (macOS runner -> dictator local, Windows -> minis local, Linux -> both
// remote). Windows records TWO events per click (script write + spawn), so
// every assertion counts only actual spawn events (entries with `command`).
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

const SSH = {
  minis: { dns: 'ondre@Minis.local', ip: 'ondre@192.168.1.215' },
  dictator: { dns: 'dictator@dictator.local', ip: 'dictator@192.168.1.229' },
};

test('both Claude cards sign in via allowlisted hosts, deduped and validated', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    const snap = await page.evaluate(() => window.sysmon.snapshot());
    const localOf = Object.fromEntries(snap.machines.map((m) => [m.id, m.local]));
    const log = () => page.evaluate(() => window.sysmon.testClaudeLogins());
    const spawnCount = async () => (await log()).filter((e) => e.command).length;

    // auth card offers Sign in, stale card offers Renew sign-in
    const minisBtn = page.locator('[data-a="minis-Claude"] [data-testid="connect-claude-minis"]').first();
    const dictatorBtn = page.locator('[data-a="dictator-Claude"] [data-testid="connect-claude-dictator"]').first();
    await expect(minisBtn).toHaveText('Sign in');
    await expect(dictatorBtn).toHaveText('Renew sign-in');

    for (const [host, btn, card] of [['minis', minisBtn, 'minis-Claude'], ['dictator', dictatorBtn, 'dictator-Claude']]) {
      const before = (await log()).length;
      const spawnsBefore = await spawnCount();
      await btn.click();
      await expect(page.locator(`[data-a="${card}"] [data-f="msg"]`).first()).toContainText('Sign-in opened in a terminal');
      const events = (await log()).slice(before); // all new record events for this click
      expect(events.filter((e) => e.command).length).toBe(1); // exactly one spawned launcher
      expect(await spawnCount()).toBe(spawnsBefore + 1);
      const text = JSON.stringify(events);
      expect(text).toContain('claude auth login --claudeai');
      expect(text).not.toContain('--console');
      if (localOf[host]) {
        expect(text).not.toContain('ssh -o ConnectTimeout'); // local host runs the CLI directly
      } else {
        expect(text).toContain(`ssh -o ConnectTimeout=10 -t ${SSH[host].dns}`); // DNS first
        expect(text).toContain(SSH[host].ip); // IP fallback present
      }
    }

    // duplicate clicks never spawn a second login child
    const dup = await page.evaluate(() => window.sysmon.connectClaude('minis'));
    expect(dup.ok).toBe(false);
    expect(dup.message).toMatch(/already open/);
    expect(await spawnCount()).toBe(2);

    // allowlist is narrow: non-Claude hosts are rejected at the IPC boundary
    await expect(page.evaluate(() => window.sysmon.connectClaude('umac'))).rejects.toThrow();
    await expect(page.evaluate(() => window.sysmon.connectClaude('grok'))).rejects.toThrow();
    expect(await spawnCount()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Claude sign-in buttons render in all three layouts', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    for (const layout of ['radial', 'bars', 'numerals']) {
      await page.click(`[data-testid="layout-${layout}"]`);
      await expect(page.locator('[data-testid="connect-claude-minis"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="connect-claude-dictator"]')).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
