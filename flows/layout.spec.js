'use strict';
// Durable geometry assertions:
//  - 1a/1c: each memory/disk metric block is horizontally centered within its
//    own grid track (computed track geometry, not hard-coded pixels) and never
//    touches the CPU block next to it.
//  - 1b: the machine section is shortened so the six accounts get a real two
//    row × three column grid, ordered by vendor pairs, under one row of four
//    machine columns, at every target resolution.
const { test, expect } = require('@playwright/test');
const { launch, baseFixture } = require('./helpers.cjs');

const RESOLUTIONS = [
  { width: 1920, height: 720 },
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
];

// Resolve the used pixel geometry of a grid track from computed styles.
function trackBox(sel, index) {
  const row = document.querySelector(sel);
  const cs = getComputedStyle(row);
  const cols = cs.gridTemplateColumns.split(' ').map(parseFloat);
  const gap = parseFloat(cs.columnGap) || 0;
  let left = row.getBoundingClientRect().left + parseFloat(cs.paddingLeft);
  for (let k = 0; k < index; k++) left += cols[k] + gap;
  return { left, width: cols[index], center: left + cols[index] / 2 };
}

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, center: r.left + r.width / 2 };
}

for (const res of RESOLUTIONS) {
  test(`1a/1c metric blocks centered with cpu gap at ${res.width}x${res.height}`, async () => {
    const { app, page, errors } = await launch(baseFixture());
    try {
      await page.setViewportSize(res);
      for (const layout of ['radial', 'numerals']) {
        await page.click(`[data-testid="layout-${layout}"]`);
        await expect(page.locator('#board')).toHaveClass(new RegExp(`lay-${layout}`));
        for (const m of ['minis', 'dictator', 'umac', 'maxis']) {
          const rowSel = `[data-m="${m}"]`;
          const stats = page.locator(`${rowSel} .mstat`);
          await expect(stats).toHaveCount(2);
          const measured = await page.evaluate(([sel, trackFn, centerFn]) => {
            const track = eval(`(${trackFn})`);
            const center = eval(`(${centerFn})`);
            const row = document.querySelector(sel);
            const [mem, disk] = row.querySelectorAll('.mstat');
            const cpu = row.children[1];
            return {
              mem: center(mem), disk: center(disk), cpu: center(cpu),
              memLbl: center(mem.querySelector('.lbl')), diskLbl: center(disk.querySelector('.lbl')),
              memTrack: track(sel, 2), diskTrack: track(sel, 3),
            };
          }, [rowSel, trackBox.toString(), centerOf.toString()]);
          // whole block centered within its grid track
          expect(Math.abs(measured.mem.center - measured.memTrack.center)).toBeLessThanOrEqual(2);
          expect(Math.abs(measured.disk.center - measured.diskTrack.center)).toBeLessThanOrEqual(2);
          // and the block's own label centered within the block
          expect(Math.abs(measured.memLbl.center - measured.mem.center)).toBeLessThanOrEqual(2);
          expect(Math.abs(measured.diskLbl.center - measured.disk.center)).toBeLessThanOrEqual(2);
          // CPU block and memory never touch
          expect(measured.mem.left - measured.cpu.right).toBeGreaterThanOrEqual(4);
        }
        expect(errors).toEqual([]);
      }
    } finally {
      await app.close();
    }
  });

  test(`1b machine/account height split and 3x2 account rows at ${res.width}x${res.height}`, async () => {
    const { app, page, errors } = await launch(baseFixture());
    try {
      await page.setViewportSize(res);
      await page.click('[data-testid="layout-bars"]');
      await expect(page.locator('#board')).toHaveClass(/lay-bars/);
      const cards = page.locator('.bacct');
      await expect(cards).toHaveCount(6);
      // vendor-paired rows
      const order = await page.evaluate(() => [...document.querySelectorAll('.bacct')].map(c => c.dataset.a));
      expect(order).toEqual(['minis-Codex', 'dictator-Codex', 'dictator-Kimi', 'minis-Claude', 'dictator-Claude', 'grok']);
      const geo = await page.evaluate(() => {
        const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
        return {
          cards: [...document.querySelectorAll('.bacct')].map(box),
          cols: [...document.querySelectorAll('.bcol')].map(box),
          machines: box(document.querySelector('.bars-machines')),
          accounts: box(document.querySelector('.bars-accounts')),
          left: box(document.querySelector('.bars-left')),
        };
      });
      // two rows of three: tops cluster into two bands, lefts into three
      const tops = [...new Set(geo.cards.map(c => Math.round(c.top)))];
      const lefts = [...new Set(geo.cards.map(c => Math.round(c.left)))];
      expect(tops.length).toBe(2);
      expect(lefts.length).toBe(3);
      expect(tops[1]).toBeGreaterThan(tops[0]);
      // each account row gets meaningful vertical space
      expect(geo.accounts.height / 2).toBeGreaterThanOrEqual(100);
      // machine section shortened: accounts take a real share of the column
      expect(geo.accounts.height).toBeGreaterThanOrEqual(geo.left.height * 0.4);
      expect(geo.machines.height).toBeLessThanOrEqual(geo.left.height * 0.58);
      // four equal machine columns in one row, spanning the same width as the accounts
      expect(geo.cols.length).toBe(4);
      expect(new Set(geo.cols.map(c => Math.round(c.top))).size).toBe(1);
      for (const c of geo.cols) expect(Math.abs(c.width - geo.machines.width / 4)).toBeLessThanOrEqual(2);
      expect(Math.abs(geo.cards[0].left - geo.cols[0].left)).toBeLessThanOrEqual(2);
      expect(Math.abs(geo.machines.width - geo.accounts.width)).toBeLessThanOrEqual(2);
      // no machine column clips its name, address or numbers
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.bcol')].filter(c => c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1).map(c => c.dataset.m));
      expect(clipped).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
}
