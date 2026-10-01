'use strict';
// Truthful state handling: stale keeps last values, auth/offline are explicit,
// unknown resets are "unknown", countdowns tick locally, remote strings never
// become DOM/HTML.
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

test('stale machine keeps last valid reading with elapsed-time badge', async () => {
  const fixture = baseFixture();
  fixture.frames = [{ after: 600, patch: { machines: [{ id: 'dictator', status: 'stale' }] } }];
  const { app, page, errors } = await launch(fixture);
  try {
    const row = page.locator('[data-m="dictator"]').first();
    await expect(row).toContainText(/stale/i, { timeout: 5000 });
    await expect(row).toContainText('21'); // preserved reading, not zeroed
    await expect(row.locator('[data-f="badge"]')).toContainText(/stale .+ ago/);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('reset countdown ticks down locally every second', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    const reset = page.locator('[data-a="dictator-Kimi"] [data-f="reset"]').first();
    await expect(reset).toContainText(/1m \d{2}s/);
    const before = await reset.textContent();
    await page.waitForTimeout(2200);
    const after = await reset.textContent();
    expect(after).toMatch(/1m \d{2}s/);
    expect(after).not.toBe(before);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('missing reset time renders unknown, never a guessed time', async () => {
  const fixture = baseFixture();
  fixture.initial.accounts[2].windows[0].resetAt = null;
  const { app, page, errors } = await launch(fixture);
  try {
    await expect(page.locator('[data-a="dictator-Codex"] [data-f="reset"]').first()).toHaveText('unknown');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('grok stale keeps readings and offers Reconnect; auth offers Connect', async () => {
  const fixture = baseFixture();
  const now = Date.now();
  fixture.initial.accounts[5] = { id: 'grok', status: 'stale', message: 'Grok HTTP 502 · open connection', windows: [{ label: 'Grok web', used: 40, resetAt: null, main: true }], sampledAt: now - 90000, lastSuccessAt: now - 90000 };
  const { app, page, errors } = await launch(fixture);
  try {
    const grok = page.locator('[data-a="grok"]').first();
    await expect(grok).toContainText('40'); // stale reading preserved
    await expect(grok.locator('[data-testid="connect-grok"]')).toHaveText('Reconnect');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
  const { app: app2, page: page2, errors: errors2 } = await launch(baseFixture());
  try {
    await expect(page2.locator('[data-a="grok"] [data-testid="connect-grok"]')).toHaveText('Connect');
    expect(errors2).toEqual([]);
  } finally {
    await app2.close();
  }
});

test('hostile strings from providers are inert text, never markup', async () => {
  const fixture = baseFixture();
  const payload = '<img src=x onerror="window.__pwned=1"> not markup';
  fixture.initial.accounts[1].message = payload;
  const { app, page, errors } = await launch(fixture);
  try {
    const msg = page.locator('[data-a="minis-Claude"] [data-f="msg"]').first();
    await expect(msg).toContainText(payload);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.locator('[data-a="minis-Claude"] img').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('board header reflects degraded state and CI panel is truthful', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    await expect(page.locator('[data-f="dotLabel"]').first()).toHaveText('degraded'); // umac offline
    await expect(page.locator('[data-f="ciCount"]')).toHaveText('1');
    await expect(page.locator('[data-f="ciList"]')).toContainText('rafiki270/SysMon');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
