'use strict';
// Secondary display selection and hotplug. Fully host-portable: the primary
// stub reuses the host's real primary display id, the secondary is synthetic.
// Window placement policy is asserted via the persisted settings.displayId;
// physical size assertions are intentionally omitted: synthetic geometry never
// matches a real OS window manager (macOS clamps to workArea minus menu
// bar/dock, Windows frameless windows may exceed workArea). chooseDisplay
// preference order is covered by unit tests in settings.test.cjs, and root's
// live native test validates physical placement at 0,-720 1920x720.
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

const SYNTH_SECONDARY_ID = 990000720;

async function hostScreen(app) {
  return app.evaluate(({ screen }) => {
    const p = screen.getPrimaryDisplay();
    return { primaryId: p.id };
  });
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

    // Explicit selection of the primary display persists.
    await page.evaluate((id) => window.sysmon.selectDisplay(id), primary.id);
    settings = await page.evaluate(() => window.sysmon.settings());
    expect(settings.displayId).toBe(primary.id);

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
