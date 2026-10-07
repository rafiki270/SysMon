'use strict';
// Every layout must boot without renderer exceptions, show real fixture
// values for 4 machines + 6 account cards, and keep all content inside the
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
  await expect(page.locator('[data-m]')).toHaveCount(4);
  await expect(page.locator('[data-a]')).toHaveCount(6);
  // Windows PCs are labelled by name beside the Windows icon, never "WINDOWS".
  for (const [id, label] of [['minis', 'MINIS'], ['maxis', 'MAXIS']]) {
    await expect(page.locator(`[data-m="${id}"] .os`).first()).toHaveText(label);
    await expect(page.locator(`[data-m="${id}"] .computer-icon`).first()).toHaveAttribute('data-icon', 'windows');
  }
  await expect(page.locator('#board')).not.toContainText('WINDOWS');
  await expect(page.locator('[data-m="dictator"] .os').first()).toHaveText('MAC');
  await expect(page.locator('[data-a="dictator-Kimi"] .vendor').first()).toContainText('Kimi');
  const cpuText = await page.locator('[data-m="minis"]').first().textContent();
  expect(cpuText).toMatch(/74/);
}

// GPU sits beside CPU in every layout (1a second gauge, 1b second bar, 1c
// second line + smaller value); VRAM shows under RAM only where reported.
async function expectGpu(page, layout) {
  const gpu = { minis: 12, dictator: 68, maxis: 38 };
  for (const [id, v] of Object.entries(gpu)) {
    const row = page.locator(`[data-m="${id}"]`).first();
    if (layout === 'radial') {
      await expect(row.locator('.gauge')).toHaveCount(2);
      await expect(row.locator('[data-f="gpuGaugeN"]')).toHaveText(String(v));
      expect(parseFloat((await row.locator('[data-f="gpuArc"]').getAttribute('stroke-dasharray')).split(' ')[0])).toBeGreaterThan(0);
    } else {
      await expect(row.locator('[data-f="gpuN"]')).toHaveText(`${v}%`);
    }
    if (layout === 'bars') {
      const bars = await row.locator('.bar').evaluateAll((els) => els.map((e) => ({ top: e.getBoundingClientRect().top, fill: e.firstElementChild.style.width })));
      expect(bars.length).toBe(2);
      expect(bars[1].top).toBeGreaterThan(bars[0].top); // GPU bar below the CPU bar
      expect(bars[1].fill).toBe(`${v}%`);
    }
    if (layout === 'numerals') {
      expect((await row.locator('[data-f="gpuSpark"]').getAttribute('points')).split(' ').length).toBeGreaterThan(2);
      const sizes = await row.evaluate((r) => ['gpuN', 'cpuN'].map((k) => parseFloat(getComputedStyle(r.querySelector(`[data-f="${k}"]`)).fontSize)));
      expect(sizes[0]).toBeLessThan(sizes[1]);
    }
  }
  // offline host: no invented GPU value
  const umac = page.locator('[data-m="umac"]').first();
  await expect(umac.locator(layout === 'radial' ? '[data-f="gpuGaugeN"]' : '[data-f="gpuN"]')).toHaveText('—');
  // VRAM directly under the RAM figures, only on Maxis
  const maxisMem = page.locator('[data-m="maxis"] .mstat').first();
  await expect(maxisMem.locator('[data-f="vramPct"]')).toHaveText('VRAM 85%');
  await expect(maxisMem.locator('[data-f="vramGB"]')).toHaveText('20.3 / 24.0 GB');
  const order = await maxisMem.evaluate((d) => [d.querySelector('[data-f="memSub"]').getBoundingClientRect().bottom, d.querySelector('[data-f="vramPct"]').getBoundingClientRect().top]);
  expect(order[1]).toBeGreaterThanOrEqual(order[0] - 1);
  for (const id of ['minis', 'dictator', 'umac']) await expect(page.locator(`[data-m="${id}"] [data-f="vramPct"]`).first()).toHaveText('');
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
        await expectGpu(page, layout);
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
    await expect(minis.locator('[data-f="usedN"]')).toHaveText('0% left'); // fully used weekly quota
    await expect(minis).toContainText('gpt-reserve · weekly 100% left'); // real zero used = everything left
    const claude = page.locator('[data-a="minis-Claude"]').first();
    await expect(claude).toContainText('—'); // auth: no invented percentage
    await expect(claude).not.toContainText('% left');
    const umac = page.locator('[data-m="umac"]').first();
    await expect(umac).toContainText('offline');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
