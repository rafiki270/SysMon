'use strict';
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

test('Grok Connect launches a browser executable with a regular website tab', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    await page.locator('[data-testid="connect-grok"]').first().click();
    await expect.poll(async () => (await page.evaluate(() => window.sysmon.testGrokLaunches())).length).toBe(1);
    const [event] = await page.evaluate(() => window.sysmon.testGrokLaunches());
    expect(event.command).toMatch(/chrome|chromium|msedge|microsoft-edge/i);
    expect(event.args).toContain('https://grok.com');
    expect(event.args.some(a => a.startsWith('--app'))).toBe(false);
    await expect(page.locator('[data-a="grok"] [data-f="msg"]').first()).toContainText('Could not open');
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
