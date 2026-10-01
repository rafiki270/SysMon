'use strict';
// Secondary display selection and hotplug, using the test display stub.
// Real desktop: primary 1920x1080 (id 3840750596), secondary 1920x720 above.
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

const PRIMARY = { id: 3840750596, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 } };
const SECONDARY = { id: 1554589279, bounds: { x: 0, y: -720, width: 1920, height: 720 }, size: { width: 1920, height: 720 } };

async function windowBounds(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
}

test('selects the secondary display and follows hotplug removal', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    await page.evaluate((list) => window.sysmon.testDisplays(list), [PRIMARY, SECONDARY]);
    let bounds = await windowBounds(app);
    expect(bounds.width).toBe(1920);
    expect(bounds.height).toBe(1080); // first non-primary in stub order is primary-like here; explicit select next

    await page.evaluate((id) => window.sysmon.selectDisplay(id), SECONDARY.id);
    bounds = await windowBounds(app);
    // macOS clamps off-screen y coordinates; size is what proves placement.
    expect(bounds).toMatchObject({ width: 1920, height: 720 });
    const settings = await page.evaluate(() => window.sysmon.settings());
    expect(settings.displayId).toBe(SECONDARY.id);

    // Board must fit six accounts + three machines at the real 720p geometry.
    await page.setViewportSize({ width: 1920, height: 720 });
    await expect(page.locator('[data-a]')).toHaveCount(6);
    for (const id of ['minis-Codex', 'minis-Claude', 'dictator-Codex', 'dictator-Claude', 'dictator-Kimi', 'grok']) {
      const box = await page.locator(`[data-a="${id}"]`).first().boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(721);
    }

    // Hotplug: secondary disappears, window must land on the remaining display.
    await page.evaluate((list) => window.sysmon.testDisplays(list), [PRIMARY]);
    bounds = await windowBounds(app);
    expect(bounds).toMatchObject({ width: 1920, height: 1080 });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
