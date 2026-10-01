'use strict';
// Claude sign-in control: both Claude cards (auth and stale) expose a real
// sign-in action. In SYSMON_TEST the main process records the allowlisted
// launch instead of spawning a terminal — no real auth, browser, or SSH.
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

test('both Claude cards sign in via allowlisted hosts, deduped and validated', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    // auth card offers Sign in, stale card offers Renew sign-in
    const minisBtn = page.locator('[data-a="minis-Claude"] [data-testid="connect-claude-minis"]').first();
    const dictatorBtn = page.locator('[data-a="dictator-Claude"] [data-testid="connect-claude-dictator"]').first();
    await expect(minisBtn).toHaveText('Sign in');
    await expect(dictatorBtn).toHaveText('Renew sign-in');

    // remote host (Minis): recorded action must be an interactive ssh -t login
    await minisBtn.click();
    await expect(page.locator('[data-a="minis-Claude"] [data-f="msg"]').first()).toContainText('Sign-in opened in a terminal');
    let log = await page.evaluate(() => window.sysmon.testClaudeLogins());
    expect(log.length).toBe(1);
    const remoteScript = JSON.stringify(log[0]);
    expect(remoteScript).toContain('ssh -o ConnectTimeout=10 -t ondre@Minis.local');
    expect(remoteScript).toContain('claude auth login --claudeai');
    expect(remoteScript).not.toContain('--console');

    // local host (dictator on macOS test runner): CLI subscription flow, no ssh
    await dictatorBtn.click();
    await expect(page.locator('[data-a="dictator-Claude"] [data-f="msg"]').first()).toContainText('Sign-in opened in a terminal');
    log = await page.evaluate(() => window.sysmon.testClaudeLogins());
    expect(log.length).toBe(2);
    const localScript = JSON.stringify(log[1]);
    expect(localScript).toContain('claude auth login --claudeai');
    expect(localScript).not.toContain('ssh');
    expect(localScript).not.toContain('--console');

    // duplicate clicks never spawn a second login child
    const dup = await page.evaluate(() => window.sysmon.connectClaude('minis'));
    expect(dup.ok).toBe(false);
    expect(dup.message).toMatch(/already open/);
    expect((await page.evaluate(() => window.sysmon.testClaudeLogins())).length).toBe(2);

    // allowlist is narrow: non-Claude hosts are rejected at the IPC boundary
    await expect(page.evaluate(() => window.sysmon.connectClaude('umac'))).rejects.toThrow();
    await expect(page.evaluate(() => window.sysmon.connectClaude('grok'))).rejects.toThrow();
    expect((await page.evaluate(() => window.sysmon.testClaudeLogins())).length).toBe(2);
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
