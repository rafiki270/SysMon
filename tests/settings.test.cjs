'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { layouts, loadSettings, saveSettings, chooseDisplay } = require('../app/settings.cjs');

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
