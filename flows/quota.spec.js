'use strict';
// Weekly quota headlines every subscription card as percent remaining
// ("% left"): provider-reported shorter windows (Kimi 5h, Claude five hour)
// and model-specific weekly sub-limits (seven day sonnet) stay secondary even
// when flagged main or more consumed. Bars/gauges fill with what is left and
// are scarcity-colored (green plenty, red little), while machine
// CPU/memory/disk keep their utilization colors. Raw `used` values stay in
// state untouched for MCP consumers.
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

const LAYOUTS = ['radial', 'bars', 'numerals'];
const GREEN = 'rgb(63, 196, 138)', RED = 'rgb(224, 90, 79)', AMBER = 'rgb(232, 168, 56)';

test('weekly quota headlines with % left in all layouts', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    for (const layout of LAYOUTS) {
      await page.click(`[data-testid="layout-${layout}"]`);
      await expect(page.locator('#board')).toHaveClass(new RegExp(`lay-${layout}`));
      // Kimi: weekly (6 used -> 94 left) beats the hotter 5h window (23 used)
      const kimi = page.locator('[data-a="dictator-Kimi"]').first();
      await expect(kimi.locator('[data-f="usedN"]')).toHaveText('94% left');
      await expect(kimi).toContainText('5h 77% left'); // shorter window secondary, also % left
      // Claude: overall seven day (12 used -> 88 left) beats the main five
      // hour (91 used) and the model-specific seven day sonnet (55 used)
      const claude = page.locator('[data-a="dictator-Claude"]').first();
      await expect(claude.locator('[data-f="usedN"]')).toHaveText('88% left');
      await expect(claude).toContainText('seven day sonnet 45% left');
      await expect(claude).toContainText('five hour 9% left');
      // Codex weekly fully consumed -> 0 left; untouched reserve -> 100 left
      const codex = page.locator('[data-a="minis-Codex"]').first();
      await expect(codex.locator('[data-f="usedN"]')).toHaveText('0% left');
      await expect(codex).toContainText('gpt-reserve · weekly 100% left');
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('bars and gauges represent remaining with scarcity colors; machines keep utilization colors', async () => {
  const { app, page, errors } = await launch(baseFixture());
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.click('[data-testid="layout-bars"]');
    await expect(page.locator('#board')).toHaveClass(/lay-bars/);
    const readBar = (sel) => page.evaluate((s) => {
      const e = document.querySelector(s);
      return { width: e.style.width, color: getComputedStyle(e).backgroundColor };
    }, sel);
    let bar = await readBar('[data-a="minis-Codex"] [data-f="usedBar"]');
    expect(bar.width).toBe('0%'); // 100 used -> nothing left
    expect(bar.color).toBe(RED);
    bar = await readBar('[data-a="dictator-Kimi"] [data-f="usedBar"]');
    expect(bar.width).toBe('94%');
    expect(bar.color).toBe(GREEN);
    bar = await readBar('[data-a="dictator-Claude"] [data-f="usedBar"]');
    expect(bar.width).toBe('88%'); // weekly headline, not the 9%-left five hour
    expect(bar.color).toBe(GREEN);
    // machine bar/number still encode utilization (cpu 74 green, mem 82 amber)
    bar = await readBar('[data-m="minis"] [data-f="cpuBar"]');
    expect(bar.width).toBe('74%');
    expect(bar.color).toBe(GREEN);
    const memColor = await page.evaluate(() => getComputedStyle(document.querySelector('[data-m="minis"] [data-f="memN"]')).color);
    expect(memColor).toBe(AMBER);
    // radial layout: gauge arc fills with remaining and turns red when scarce
    await page.click('[data-testid="layout-radial"]');
    await expect(page.locator('#board')).toHaveClass(/lay-radial/);
    const arc = await page.evaluate(() => {
      const e = document.querySelector('[data-a="minis-Codex"] [data-f="arc"]');
      return { dash: e.getAttribute('stroke-dasharray'), stroke: getComputedStyle(e).stroke };
    });
    expect(parseFloat(arc.dash)).toBe(0); // nothing left -> empty gauge
    expect(arc.stroke).toBe(RED);
    const arcKimi = await page.evaluate(() => {
      const e = document.querySelector('[data-a="dictator-Kimi"] [data-f="arc"]');
      const [filled, total] = e.getAttribute('stroke-dasharray').split(' ').map(Number);
      return { pct: (filled / total) * 100, stroke: getComputedStyle(e).stroke };
    });
    expect(Math.round(arcKimi.pct)).toBe(94); // gauge fills with remaining
    expect(arcKimi.stroke).toBe(GREEN);
    // raw used stays in state for MCP consumers (never overwritten by % left)
    const raw = await page.evaluate(async () => {
      const s = await window.sysmon.snapshot();
      const codex = s.accounts.find((a) => a.id === 'minis-Codex');
      const kimi = s.accounts.find((a) => a.id === 'dictator-Kimi');
      return { codex: codex.windows.map((w) => w.used), kimi: kimi.windows.map((w) => w.used) };
    });
    expect(raw.codex).toEqual([100, 0]);
    expect(raw.kimi).toEqual([6, 23]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
