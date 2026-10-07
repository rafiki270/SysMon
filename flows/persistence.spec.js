'use strict';
// Layout choice must survive a full app restart (settings.json via IPC).
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, baseFixture } = require('./helpers.cjs');

test('layout switch persists after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-persist-'));
  const first = await launch(baseFixture(), { userdata: dir });
  try {
    await first.page.click('[data-testid="layout-numerals"]');
    await expect(first.page.locator('#board')).toHaveClass(/lay-numerals/);
    const saved = await first.page.evaluate(() => window.sysmon.settings());
    expect(saved.layout).toBe('numerals');
    expect(first.errors).toEqual([]);
  } finally {
    await first.app.close();
  }
  const second = await launch(baseFixture(), { userdata: dir });
  try {
    await expect(second.page.locator('#board')).toHaveClass(/lay-numerals/);
    await expect(second.page.locator('[data-testid="layout-numerals"]')).toHaveClass(/active/);
    expect(second.errors).toEqual([]);
  } finally {
    await second.app.close();
  }
});

test('invalid stored layout falls back to radial without crashing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-persist-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ layout: 'bogus', displayId: null }));
  const { app, page, errors } = await launch(baseFixture(), { userdata: dir });
  try {
    await expect(page.locator('#board')).toHaveClass(/lay-radial/);
    await expect(page.locator('[data-m]')).toHaveCount(4);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
