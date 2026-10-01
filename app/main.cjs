'use strict';
const { app, BrowserWindow, ipcMain, screen, session, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Monitor } = require('./monitor.cjs');
const { loadSettings, saveSettings, layouts, chooseDisplay } = require('./settings.cjs');

let win, tray, monitor, grokWindow, settings, file, grokTimer, quitting = false;
// Test mode (SYSMON_TEST=1): no real polling, no login items, isolated userData,
// deterministic fixture states from SYSMON_FIXTURE. Used by Playwright flows.
const TEST = process.env.SYSMON_TEST === '1';
let displayStub = null; // test-only override for hotplug simulation

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { win?.show(); win?.focus(); });

function allDisplays() { return displayStub || screen.getAllDisplays(); }
function placeWindow() {
  if (!win) return;
  const d = chooseDisplay(allDisplays(), screen.getPrimaryDisplay().id, settings.displayId);
  if (!d) return;
  if (TEST) { win.setBounds(d.bounds); settings.displayId = d.id; saveSettings(file, settings); return; }
  win.setFullScreen(false);
  win.setBounds(d.bounds);
  win.setFullScreen(true);
  settings.displayId = d.id;
  saveSettings(file, settings);
}
function trusted(event) { return win && event.sender === win.webContents && event.senderFrame?.url === win.webContents.getURL(); }
function handle(name, fn) { ipcMain.handle(name, (event, ...args) => { if (!trusted(event)) throw new Error('Untrusted sender'); return fn(...args); }); }

// Login items: native API on macOS/Windows; XDG autostart file on Linux
// (Electron's getLoginItemSettings is unsupported there).
const xdgAutostart = () => path.join(app.getPath('home'), '.config', 'autostart', 'sysmon.desktop');
function loginItemState() {
  if (process.platform === 'linux') { try { return fs.existsSync(xdgAutostart()); } catch { return false; } }
  return app.getLoginItemSettings().openAtLogin;
}
function setLoginItem(enabled) {
  if (process.platform === 'linux') {
    const p = xdgAutostart();
    try {
      if (!enabled) { fs.rmSync(p, { force: true }); return; }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const exe = (process.env.APPIMAGE || process.execPath).replaceAll('"', '\\"');
      fs.writeFileSync(p, `[Desktop Entry]\nType=Application\nName=SysMon\nExec="${exe}"\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o644 });
    } catch {}
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
}

// Learn the site's own rate-limits request shape (requestKind/modelName) from
// the isolated grok session; read-only observation, no inference is ever sent.
function observeGrokQuotaShape() {
  try {
    session.fromPartition('persist:grok').webRequest.onBeforeRequest(
      { urls: ['https://grok.com/rest/rate-limits*'] },
      (details, cb) => {
        try {
          const raw = details.uploadData?.[0]?.bytes?.toString('utf8');
          if (raw) { const p = JSON.parse(raw); if (p && typeof p.requestKind === 'string') grokParams = { requestKind: p.requestKind, ...(typeof p.modelName === 'string' ? { modelName: p.modelName } : {}) }; }
        } catch {}
        cb({});
      });
  } catch {}
}

// Grok website subscription quota via the app's own isolated browser session.
// Private/undocumented endpoint: best-effort, every failure is explicit.
// Never sends inference requests; never guesses reset times.
let grokParams = null; // requestKind/modelName observed from the site's own calls
let grokPolling = false;
async function pollGrok() {
  if (grokPolling) return; // never overlap polls
  grokPolling = true;
  try {
    const s = session.fromPartition('persist:grok');
    const cookies = await s.cookies.get({ url: 'https://grok.com' });
    if (!cookies.some(c => /^(sso|sso-rw)$/.test(c.name))) return monitor.setGrok({ vendor: 'Grok', status: 'auth', message: 'Connect Grok', windows: [] });
    const params = grokParams || { requestKind: 'DEFAULT', modelName: 'grok-4-auto' };
    const response = await s.fetch('https://grok.com/rest/rate-limits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000) });
    if (!response.ok) return monitor.setGrok({ vendor: 'Grok', status: response.status === 401 || response.status === 403 ? 'auth' : 'unavailable', message: `Grok HTTP ${response.status} · open connection`, windows: [] });
    const r = await response.json();
    const limit = Number(r.totalRequests), remaining = Number(r.remainingQueries ?? r.remainingRequests);
    // Reset only when the website actually reports one; window size is not a reset time.
    const reset = r.resetTime ? Date.parse(r.resetTime) : r.resetAt ? Number(r.resetAt) * 1000 : null;
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return monitor.setGrok({ vendor: 'Grok', status: 'unavailable', message: 'Website quota format changed', windows: [] });
    monitor.setGrok({ vendor: 'Grok', status: 'live', sampledAt: Date.now(), windows: [{ label: 'Grok web', used: 100 * (limit - remaining) / limit, resetAt: Number.isFinite(reset) ? reset : null, main: true }], message: reset ? null : 'Website does not report a reset time' });
  } catch { monitor.setGrok({ vendor: 'Grok', status: 'unavailable', message: 'Open Grok connection to sign in', windows: [] }); }
  finally { grokPolling = false; }
}
// Self-scheduling (not setInterval): a slow poll can never overlap the next one.
function scheduleGrok(ms = 120000) {
  clearTimeout(grokTimer);
  grokTimer = setTimeout(async () => { await pollGrok(); if (!quitting) scheduleGrok(); }, ms);
}
function connectGrok() {
  if (grokWindow) { grokWindow.show(); return; }
  // Isolated partition, sandboxed, no preload/IPC: the provider page is untrusted.
  grokWindow = new BrowserWindow({ width: 1100, height: 800, title: 'Connect Grok — SysMon', webPreferences: { partition: 'persist:grok', nodeIntegration: false, contextIsolation: true, sandbox: true } });
  grokWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  grokWindow.webContents.on('will-navigate', (event, url) => { try { if (!['grok.com', 'accounts.x.ai', 'auth.x.ai', 'x.com', 'twitter.com'].includes(new URL(url).hostname)) event.preventDefault(); } catch { event.preventDefault(); } });
  grokWindow.loadURL('https://grok.com');
  grokWindow.on('closed', () => { grokWindow = null; pollGrok(); });
}

function applyFixture(fixtureFile) {
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  const merge = (patch) => {
    if (patch.machines) for (const pm of patch.machines) {
      const m = monitor.state.machines.find(x => x.id === pm.id);
      if (m) Object.assign(m, pm);
    }
    if (patch.accounts) for (const pa of patch.accounts) {
      const a = monitor.state.accounts.find(x => x.id === pa.id);
      if (a) Object.assign(a, pa);
    }
    if (patch.ci) Object.assign(monitor.state.ci, patch.ci);
    monitor.publish();
  };
  if (fixture.initial) merge(fixture.initial);
  for (const frame of fixture.frames || []) setTimeout(() => merge(frame.patch), frame.after || 0);
}

app.whenReady().then(() => {
  if (TEST && process.env.SYSMON_USERDATA) app.setPath('userData', process.env.SYSMON_USERDATA);
  file = path.join(app.getPath('userData'), 'settings.json');
  const firstRun = !fs.existsSync(file);
  settings = loadSettings(file);
  monitor = new Monitor({ log: () => {} });
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({ show: false, frame: false, width: TEST ? 1600 : undefined, height: TEST ? 900 : undefined, backgroundColor: '#0a0d0b', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') win.setFullScreen(false);
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  handle('snapshot', () => monitor.state);
  handle('settings', () => settings);
  handle('layout', layout => { if (!layouts.includes(layout)) throw new Error('Invalid layout'); settings.layout = layout; saveSettings(file, settings); return settings; });
  handle('displays', () => allDisplays().map(d => ({ id: d.id, bounds: d.bounds, primary: d.id === screen.getPrimaryDisplay().id })));
  handle('display', id => { if (!allDisplays().some(d => d.id === id)) throw new Error('Unknown display'); settings.displayId = id; placeWindow(); win.show(); return settings; });
  handle('connect-grok', () => connectGrok());
  handle('open-ci', url => { if (typeof url === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) return shell.openExternal(url); });
  if (TEST) {
    handle('test:displays', list => { displayStub = list; placeWindow(); return allDisplays().map(d => d.id); });
    handle('test:real-displays', () => { displayStub = null; placeWindow(); return true; });
  }
  monitor.on('update', s => { if (!win.isDestroyed()) win.webContents.send('update', s); });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.once('ready-to-show', () => { placeWindow(); win.show(); });
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABGElEQVQ4T6WTwQ3CMAxF/0xgB8AAmIAJMAEmYAImwARsgAkwAROwAWwAjEAH4BkHJIpDUuoBkSxn8X/fjgPgKwkIJD3Pd0KIIZM9SZA0A3CH+AEoqQNwBTDT3CSAfYG6qXMF1fmsPF8awDnASERpwJsCGNUteDWAsgATGaBLsjZWGPHMpPWg6X+CJAFo64Qlaz2lrZ+A/PpTk+ZqXAHcAGxuIOOu1SVPvsm89MPMmqMwAHZwnwNUbi99/f4HsCtOgdKaBFRmi0EjXDkUPSpByQuBQCVJeBxIGcqhAGVpMoMssoB8KTIJPBGEDqwLD+nDTngXofIdcaDpSCNsZKUCRmvauvcBV4KNhgUdCI93EF+/IPTVHX3+8WcNVa6XD/WG0evAKI1LGNRDgvBAAAAAElFTkSuQmCC');
  tray = new Tray(icon);
  tray.setToolTip('SysMon');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Show on second display', click: () => { settings.displayId = null; placeWindow(); win.show(); } },
    { label: 'Displays', submenu: allDisplays().map((d, i) => ({ label: `Display ${i + 1} · ${d.size.width} × ${d.size.height}`, type: 'radio', checked: d.id === settings.displayId, click: () => { settings.displayId = d.id; placeWindow(); win.show(); } })) },
    { label: 'Connect Grok', click: connectGrok },
    { label: 'Start at login', type: 'checkbox', checked: loginItemState(), click: item => setLoginItem(item.checked) },
    { type: 'separator' },
    { label: 'Quit SysMon', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', () => win.show());
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  screen.on('display-added', placeWindow);
  screen.on('display-removed', placeWindow);
  if (!TEST) {
    // Enable autostart by default only on first run; a saved opt-out is never re-enabled.
    if (app.isPackaged && firstRun && !loginItemState()) setLoginItem(true);
    observeGrokQuotaShape();
    monitor.start();
    pollGrok();
    scheduleGrok();
  } else if (process.env.SYSMON_FIXTURE) {
    applyFixture(process.env.SYSMON_FIXTURE);
  }
});
app.on('before-quit', () => { quitting = true; monitor?.stop(); clearTimeout(grokTimer); });
app.on('window-all-closed', () => {});
