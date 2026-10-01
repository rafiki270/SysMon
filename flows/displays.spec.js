'use strict';
// Secondary display selection and hotplug. Fully host-portable: the primary
// stub reuses the host's real primary display id, the secondary is synthetic.
// Window bounds are clamped by the OS to the physical screen (macOS CI runner
// shrinks a 1080p request to ~677), so placement is asserted via the persisted
// settings.displayId and size only when the host screen can actually fit it.
// chooseDisplay preference order is covered by unit tests in settings.test.cjs.
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

const SYNTH_SECONDARY_ID = 990000720;

async function hostScreen(app) {
  return app.evaluate(({ screen }) => {
    const p = screen.getPrimaryDisplay();
    return { primaryId: p.id, workAreaH: p.workArea.height };
  });
}

async function windowBounds(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
}

// macOS menu bar / dock shrink the usable area, and CI runners clamp a window
// that exceeds it (a 1080p request became ~677). Assert exact size only when
// the host work area can actually fit the target.
function expectHeight(bounds, target, host) {
  if (host.workAreaH >= target) expect(bounds.height).toBe(target);
  else expect(bounds.height).toBeLessThanOrEqual(host.workAreaH);
}

test('secondary display is the default target, explicit selection and hotplug follow', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    const host = await hostScreen(app);
    const primary = { id: host.primaryId, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 } };
    const secondary = { id: SYNTH_SECONDARY_ID, bounds: { x: 0, y: -720, width: 1920, height: 720 }, size: { width: 1920, height: 720 } };

    // Default (no saved choice): the non-primary display wins. Startup already
    // placed the window on the real displays, so reset the saved selection
    // (test-only option) before asserting the default-selection rule.
    await page.evaluate((list) => window.sysmon.testDisplays(list, { reset: true }), [primary, secondary]);
    let settings = await page.evaluate(() => window.sysmon.settings());
    expect(settings.displayId).toBe(SYNTH_SECONDARY_ID);
    let bounds = await windowBounds(app);
    expectHeight(bounds, 720, host);

    // Explicit selection of the primary display persists.
    await page.evaluate((id) => window.sysmon.selectDisplay(id), primary.id);
    settings = await page.evaluate(() => window.sysmon.settings());
    expect(settings.displayId).toBe(primary.id);
    bounds = await windowBounds(app);
    expectHeight(bounds, 1080, host);

    // Explicit selection back to the 720p secondary persists too.
    await page.evaluate((id) => window.sysmon.selectDisplay(id), secondary.id);
    settings = await page.evaluate(() => window.sysmon.settings());
    expect(settings.displayId).toBe(SYNTH_SECONDARY_ID);

    // Hotplug removal: saved display gone -> land on the remaining display.
    await page.evaluate((list) => window.sysmon.testDisplays(list), [primary]);
    settings = await page.evaluate(() => window.sysmon.settings());
    expect(settings.displayId).toBe(primary.id);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('board fits six account cards and three machines within the actual viewport', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    // Ask for the real secondary-monitor geometry; the OS may clamp smaller.
    await page.setViewportSize({ width: 1920, height: 720 });
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    for (const layout of ['radial', 'bars', 'numerals']) {
      await page.click(`[data-testid="layout-${layout}"]`);
      await expect(page.locator('[data-a]')).toHaveCount(6);
      await expect(page.locator('[data-m]')).toHaveCount(3);
      const offenders = await page.evaluate(() => {
        const bad = [];
        for (const e of document.querySelectorAll('[data-a], [data-m], .ci, .hdr, .ci-hdr')) {
          const r = e.getBoundingClientRect();
          if (r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.top < -1) {
            bad.push(`${e.dataset.a || e.dataset.m || e.className} ${Math.round(r.right)}x${Math.round(r.bottom)}`);
          }
        }
        return bad;
      });
      expect(offenders, `layout ${layout} at ${view.w}x${view.h}`).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
