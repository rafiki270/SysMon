'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { layouts, loadSettings, saveSettings, chooseDisplay, resolvePlacement, fitWindowBounds } = require('../app/settings.cjs');

test('layouts are the three handover designs', () => {
  assert.deepStrictEqual(layouts, ['radial', 'bars', 'numerals']);
});

test('loadSettings defaults to radial and null display on missing/corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-set-'));
  assert.deepStrictEqual(loadSettings(path.join(dir, 'none.json')), { layout: 'radial', displayId: null });
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, 'not json');
  assert.deepStrictEqual(loadSettings(bad), { layout: 'radial', displayId: null });
  const wrong = path.join(dir, 'wrong.json');
  fs.writeFileSync(wrong, JSON.stringify({ layout: 'bogus', displayId: 'x' }));
  assert.deepStrictEqual(loadSettings(wrong), { layout: 'radial', displayId: null });
});

test('save/load roundtrip persists layout and displayId atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-set-'));
  const file = path.join(dir, 'settings.json');
  saveSettings(file, { layout: 'numerals', displayId: 7 });
  assert.deepStrictEqual(loadSettings(file), { layout: 'numerals', displayId: 7 });
  assert.ok(!fs.existsSync(file + '.tmp'));
  if (process.platform !== 'win32') assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600'); // POSIX-only; Windows stat reports 666
});

test('chooseDisplay prefers saved, then non-primary, then first', () => {
  const displays = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.strictEqual(chooseDisplay(displays, 1, 3).id, 3);
  assert.strictEqual(chooseDisplay(displays, 1, 99).id, 2); // saved gone (hotplug) -> secondary
  assert.strictEqual(chooseDisplay(displays, 1, null).id, 2);
  assert.strictEqual(chooseDisplay([{ id: 1 }], 1, null).id, 1); // single display
});

test('resolvePlacement: zero displays is a normal window with no target', () => {
  const p = resolvePlacement([], null, 7);
  assert.deepStrictEqual(p, { mode: 'normal', display: null, remember: false }); // preference 7 survives untouched
});

test('resolvePlacement: a single display is always a normal window, never fullscreen', () => {
  const only = { id: 1 };
  assert.deepStrictEqual(resolvePlacement([only], 1, null), { mode: 'normal', display: only, remember: false });
  assert.deepStrictEqual(resolvePlacement([only], 1, 1), { mode: 'normal', display: only, remember: false });
  assert.deepStrictEqual(resolvePlacement([only], 1, 99), { mode: 'normal', display: only, remember: false }); // remembered absent display is not overwritten
});

test('resolvePlacement: multiple displays fullscreen the saved, else first non-primary', () => {
  const displays = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepStrictEqual(resolvePlacement(displays, 1, 3), { mode: 'fullscreen', display: displays[2], remember: false });
  assert.deepStrictEqual(resolvePlacement(displays, 1, 99), { mode: 'fullscreen', display: displays[1], remember: false }); // absent preference survives a temporary fallback
  assert.deepStrictEqual(resolvePlacement(displays, 1, null), { mode: 'fullscreen', display: displays[1], remember: true });
  assert.deepStrictEqual(resolvePlacement(displays, 1, 1), { mode: 'fullscreen', display: displays[0], remember: false }); // explicit primary choice is honored
});

test('fitWindowBounds centers within the work area and clamps oversized windows', () => {
  assert.deepStrictEqual(fitWindowBounds({ x: 1920, y: 0, width: 1920, height: 1040 }, 1600, 900), { x: 2080, y: 70, width: 1600, height: 900 });
  assert.deepStrictEqual(fitWindowBounds({ x: 0, y: 0, width: 1280, height: 800 }, 1600, 900), { x: 0, y: 0, width: 1280, height: 800 }); // stays inside the work area
  assert.deepStrictEqual(fitWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 100, 50), { x: 800, y: 440, width: 320, height: 200 }); // sane minimum size
});
