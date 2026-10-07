'use strict';
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

test('all Font Awesome icons load and provider icons sit left of percentages in every layout', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    await page.setViewportSize({ width: 1920, height: 720 });
    for (const layout of ['radial', 'bars', 'numerals']) {
      await page.getByTestId(`layout-${layout}`).click();
      await expect(page.locator('.computer-icon')).toHaveCount(4);
      await expect(page.locator('.provider-icon')).toHaveCount(6);
      await expect.poll(() => page.locator('.fa-icon').evaluateAll(images => images.every(i => i.complete && i.naturalWidth > 0))).toBe(true);
      const overlap = await page.locator('[data-a]').evaluateAll(cards => cards.filter(c => {
        const icon = c.querySelector('.provider-icon').getBoundingClientRect();
        const value = c.querySelector(c.classList.contains('nacct') ? '[data-f="reset"]' : '[data-f="usedN"]').getBoundingClientRect();
        return icon.right > value.left || icon.left < c.getBoundingClientRect().left;
      }).map(c => c.dataset.a));
      expect(overlap, layout).toEqual([]);
      if (layout === 'radial') {
        const offsets = await page.locator('.gauge-logo').evaluateAll(logos => logos.map(l => {
          const g = l.parentElement.getBoundingClientRect(), i = l.querySelector('img').getBoundingClientRect();
          return Math.abs(g.x + g.width / 2 - i.x - i.width / 2) + Math.abs(g.y + g.height / 2 - i.y - i.height / 2);
        }));
        expect(offsets.every(v => v < 1)).toBe(true);
      }
    }
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
