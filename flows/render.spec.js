'use strict';
// Every layout must boot without renderer exceptions, show real fixture
// values for 3 machines + 6 account cards, and keep all content inside the
// viewport at the actual target resolutions (1920x720 secondary monitor,
// 1920x1080 primary, 1366x768 small laptop).
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

const RESOLUTIONS = [
  { width: 1920, height: 720 },
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
];
const LAYOUTS = ['radial', 'bars', 'numerals'];

async function expectVisibleText(page) {
  // Nonempty machine and account text — an empty shell is not a render.
  await expect(page.locator('[data-m]')).toHaveCount(3);
  await expect(page.locator('[data-a]')).toHaveCount(6);
  await expect(page.locator('[data-m="minis"] .host').first()).toContainText('Minis');
  await expect(page.locator('[data-a="dictator-Kimi"] .vendor').first()).toContainText('Kimi');
  const cpuText = await page.locator('[data-m="minis"]').first().textContent();
  expect(cpuText).toMatch(/74/);
}

async function expectWithinViewport(page, width, height) {
  const offenders = await page.evaluate(([w, h]) => {
    const bad = [];
    const sels = ['.hdr', '.ci', '.switch', '.clock', '[data-m]', '[data-a]', '[data-f="reset"]'];
    for (const sel of sels) {
      for (const e of document.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.left < -1 || r.top < -1 || r.right > w + 1 || r.bottom > h + 1) {
          bad.push(`${sel} "${(e.textContent || '').trim().slice(0, 24)}" ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
    }
    // Horizontal clipping hidden by overflow:hidden still shows in scrollWidth.
    for (const e of document.querySelectorAll('#board > *')) {
      if (e.scrollWidth > e.clientWidth + 2) bad.push(`scroll-clip ${e.className} ${e.scrollWidth}>${e.clientWidth}`);
    }
    return bad;
  }, [width, height]);
  expect(offenders).toEqual([]);
}

for (const res of RESOLUTIONS) {
  test(`all layouts render within ${res.width}x${res.height}`, async () => {
    const { app, page, errors } = await launch(baseFixture());
    try {
      await page.setViewportSize(res);
      for (const layout of LAYOUTS) {
        await page.click(`[data-testid="layout-${layout}"]`);
        await expect(page.locator('#board')).toHaveClass(new RegExp(`lay-${layout}`));
        await expectVisibleText(page);
        await expectWithinViewport(page, res.width, res.height);
        // compact switch stays at the top right corner with a readable clock
        const sw = await page.locator('.switch').first().boundingBox();
        expect(sw.x + sw.width).toBeLessThanOrEqual(res.width);
        await expect(page.locator('.clock').first()).toContainText(/\d{2}:\d{2}:\d{2}/);
      }
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
}

test('no fake zeros: unavailable values render as em-dash, real zero stays 0', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    const minis = page.locator('[data-a="minis-Codex"]').first();
    await expect(minis).toContainText('100'); // real live value
    await expect(minis).toContainText('gpt-reserve · weekly 0%'); // real zero preserved
    const claude = page.locator('[data-a="minis-Claude"]').first();
    await expect(claude).toContainText('—'); // auth: no invented percentage
    await expect(claude).not.toContainText('0%');
    const umac = page.locator('[data-m="umac"]').first();
    await expect(umac).toContainText('offline');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
