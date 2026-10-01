'use strict';
// `--mcp-stdio`: run the read-only MCP stdio adapter instead of the GUI (how
// installed MCP clients reach the app's stats; see docs/MCP.md). Dispatched
// before electron, the single-instance lock, windows, and provider pollers:
// the adapter never launches a second GUI, never touches the lock, and exits
// when the client's stdio closes.
if (process.argv.includes('--mcp-stdio')) {
  require('./mcp/stdio.cjs').main().catch((e) => {
    console.error(`SysMon MCP stdio adapter failed: ${e.message}`);
    process.exit(1);
  });
  return;
}
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, shell, clipboard, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Monitor } = require('./monitor.cjs');
const { hosts } = require('./monitor.cjs');
const { createClaudeAuth } = require('./auth.cjs');
const { createGrokBrowser } = require('./grok-browser.cjs');
const { loadSettings, saveSettings, layouts, resolvePlacement, fitWindowBounds } = require('./settings.cjs');

let win, tray, monitor, settings, file, claudeAuth, grokAuth, quitting = false, mcpHandle = null;
const claudeRefreshTimers = new Set();
// Test mode (SYSMON_TEST=1): no real polling, no login items, isolated userData,
// deterministic fixture states from SYSMON_FIXTURE. Used by Playwright flows.
const TEST = process.env.SYSMON_TEST === '1';
let displayStub = null; // test-only override for hotplug simulation

// Test userData must be set before the single-instance lock: the lock lives in
// userData, so tests could otherwise collide with an installed app instance.
if (TEST && process.env.SYSMON_USERDATA) app.setPath('userData', process.env.SYSMON_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { win?.show(); win?.focus(); });

function allDisplays() { return displayStub || screen.getAllDisplays(); }
// Never call primary-display APIs with an empty topology: platforms may throw
// when every screen is off or none exists.
function primaryId() { try { return screen.getPrimaryDisplay().id; } catch { return null; } }

// Window placement (policy in settings.cjs resolvePlacement): 2+ displays ->
// fullscreen kiosk on the remembered/preferred display (no native titlebar);
// 1 or 0 connected displays -> normal framed window. A fallback target never
// overwrites settings.displayId, so a powered-off second monitor's identity
// survives the disconnect and fullscreen is restored when it returns.
let placeTimer = null, placement = null, placementSig = null;
function placeWindow() {
  if (!win || win.isDestroyed()) return;
  const displays = allDisplays();
  const decision = resolvePlacement(displays, displays.length ? primaryId() : null, settings.displayId);
  if (decision.remember) { settings.displayId = decision.display.id; saveSettings(file, settings); }
  const fullscreen = decision.mode === 'fullscreen';
  const cur = win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
  const area = decision.display ? decision.display.workArea || decision.display.bounds : null;
  const bounds = area ? (fullscreen ? decision.display.bounds : fitWindowBounds(area, cur.width, cur.height)) : null;
  placement = { mode: decision.mode, displayId: decision.display ? decision.display.id : null, bounds };
  const sig = `${decision.mode}:${placement.displayId}:${bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : ''}`;
  if (sig === placementSig && win.isFullScreen() === fullscreen) return; // already there; avoid fullscreen re-animation loops
  placementSig = sig;
  try {
    if (win.isFullScreen()) win.setFullScreen(false);
    if (bounds) win.setBounds(bounds);
    if (fullscreen) win.setFullScreen(true);
  } catch (e) { console.log(`[sysmon] window placement failed: ${e.message}`); }
}
// Hotplug/resume storms (docks, nightly power-off) collapse into one pass.
function schedulePlaceWindow(ms = 150) {
  clearTimeout(placeTimer);
  placeTimer = setTimeout(() => { placeTimer = null; placeWindow(); }, ms);
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

// Grok sign-in runs in a REAL user-visible browser (dedicated SysMon profile,
// loopback-only CDP) — the embedded Electron webview cannot complete grok.com
// sign-in. All browser logic lives in grok-browser.cjs; main keeps only the
// narrow IPC/tray hooks. See app/grok-browser.cjs for the design contract.

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
  file = path.join(app.getPath('userData'), 'settings.json');
  const firstRun = !fs.existsSync(file);
  settings = loadSettings(file);
  monitor = new Monitor({ log: () => {} });
  Menu.setApplicationMenu(null);
  // Framed window: normal mode keeps native user controls; fullscreen mode
  // natively hides the titlebar, so the kiosk view stays clean on the second
  // display. autoHideMenuBar keeps Windows/Linux chrome minimal.
  win = new BrowserWindow({ show: false, frame: true, autoHideMenuBar: true, title: 'SysMon', width: TEST ? 1600 : 1280, height: TEST ? 900 : 760, backgroundColor: '#0a0d0b', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') win.setFullScreen(false);
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  handle('snapshot', () => monitor.state);
  handle('settings', () => settings);
  handle('layout', layout => { if (!layouts.includes(layout)) throw new Error('Invalid layout'); settings.layout = layout; saveSettings(file, settings); return settings; });
  handle('displays', () => { const ds = allDisplays(); const pid = ds.length ? primaryId() : null; return ds.map(d => ({ id: d.id, bounds: d.bounds, primary: d.id === pid })); });
  handle('display', id => { if (!allDisplays().some(d => d.id === id)) throw new Error('Unknown display'); settings.displayId = id; saveSettings(file, settings); placeWindow(); win.show(); return settings; });
  // TEST mode never launches a real browser: the fake process exits at once,
  // so connect() fails fast and truthfully without touching the system.
  const grokLaunchLog = [];
  const testSpawn = (command, args) => {
    grokLaunchLog.push({ command, args });
    return { on(ev, cb) { if (ev === 'exit') setImmediate(() => cb(1)); if (ev === 'error') return undefined; return this; }, kill() {}, unref() {} };
  };
  grokAuth = createGrokBrowser({
    profileDir: path.join(app.getPath('userData'), 'grok-browser-profile'),
    onState: r => monitor.setGrok({ vendor: 'Grok', ...r }),
    ...(TEST ? { spawnImpl: testSpawn, httpGet: async () => { throw new Error('disabled in tests'); }, wsImpl: function () { throw new Error('disabled in tests'); } } : {}),
  });
  handle('connect-grok', () => grokAuth.connect());
  handle('open-ci', url => { if (typeof url === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) return shell.openExternal(url); });
  // Claude sign-in: narrow allowlist of host ids that own a Claude card.
  // SYSMON_TEST records the allowlisted launch (host id + command) instead of
  // spawning — tests never open a terminal, browser, or real auth flow.
  const claudeLoginLog = [];
  const recordSpawn = (command, args) => { claudeLoginLog.push({ command, args }); return { on(ev, cb) { if (ev === 'exit') setImmediate(() => cb(0)); return this; }, unref() {} }; };
  claudeAuth = createClaudeAuth({
    hosts: hosts.map(h => ({ id: h.id, os: h.os, ssh: h.ssh, fallback: h.fallback, local: h.id === monitor.localId })),
    claudeHosts: monitor.state.accounts.filter(a => a.vendor === 'Claude').map(a => a.host),
    ...(TEST ? { spawnImpl: recordSpawn, writeFile: async (p, content) => { claudeLoginLog.push({ script: p, content }); } } : {}),
    onLaunched: TEST ? null : hostId => {
      // Prompt quota refresh once the user has had time to finish OAuth.
      for (const ms of [20000, 60000, 120000]) {
        const t = setTimeout(() => { claudeRefreshTimers.delete(t); monitor.refreshAccounts(hostId); }, ms);
        claudeRefreshTimers.add(t);
      }
    },
  });
  handle('connect-claude', hostId => claudeAuth.connect(hostId));
  if (TEST) {
    handle('test:displays', (list, opts) => { displayStub = list; if (opts?.reset) { settings.displayId = null; saveSettings(file, settings); } placeWindow(); return allDisplays().map(d => d.id); });
    handle('test:real-displays', () => { displayStub = null; placeWindow(); return true; });
    handle('test:placement', () => placement); // deterministic policy record: OS geometry itself is not assertable with synthetic displays
    handle('test:claude-logins', () => claudeLoginLog);
    handle('test:grok-launches', () => grokLaunchLog);
  }
  monitor.on('update', s => { if (!win.isDestroyed()) win.webContents.send('update', s); });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.once('ready-to-show', () => { placeWindow(); win.show(); });
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABGElEQVQ4T6WTwQ3CMAxF/0xgB8AAmIAJMAEmYAImwARsgAkwAROwAWwAjEAH4BkHJIpDUuoBkSxn8X/fjgPgKwkIJD3Pd0KIIZM9SZA0A3CH+AEoqQNwBTDT3CSAfYG6qXMF1fmsPF8awDnASERpwJsCGNUteDWAsgATGaBLsjZWGPHMpPWg6X+CJAFo64Qlaz2lrZ+A/PpTk+ZqXAHcAGxuIOOu1SVPvsm89MPMmqMwAHZwnwNUbi99/f4HsCtOgdKaBFRmi0EjXDkUPSpByQuBQCVJeBxIGcqhAGVpMoMssoB8KTIJPBGEDqwLD+nDTngXofIdcaDpSCNsZKUCRmvauvcBV4KNhgUdCI93EF+/IPTVHX3+8WcNVa6XD/WG0evAKI1LGNRDgvBAAAAAElFTkSuQmCC');
  tray = new Tray(icon);
  tray.setToolTip('SysMon');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Show on second display', click: () => { settings.displayId = null; saveSettings(file, settings); placeWindow(); win.show(); } },
    { label: 'Displays', submenu: allDisplays().map((d, i) => ({ label: `Display ${i + 1} · ${d.size.width} × ${d.size.height}`, type: 'radio', checked: d.id === settings.displayId, click: () => { settings.displayId = d.id; saveSettings(file, settings); placeWindow(); win.show(); } })) },
    { label: 'Connect Grok', click: () => grokAuth.connect() },
    { label: `MCP: ${mcpHandle?.endpoint() || 'unavailable'}`, enabled: false },
    { label: 'Copy MCP endpoint', enabled: !!mcpHandle?.endpoint(), click: () => clipboard.writeText(mcpHandle.endpoint()) },
    { label: 'Start at login', type: 'checkbox', checked: loginItemState(), click: item => setLoginItem(item.checked) },
    { type: 'separator' },
    { label: 'Quit SysMon', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', () => win.show());
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  screen.on('display-added', () => schedulePlaceWindow());
  screen.on('display-removed', () => schedulePlaceWindow());
  screen.on('display-metrics-changed', () => schedulePlaceWindow());
  // After sleep the reported topology can take seconds to settle (docks,
  // powered-off screens): re-evaluate now and once more shortly after.
  powerMonitor.on('resume', () => { schedulePlaceWindow(); setTimeout(() => { if (!quitting) placeWindow(); }, 2000); });
  if (!TEST) {
    // Enable autostart by default only on first run; a saved opt-out is never re-enabled.
    if (app.isPackaged && firstRun && !loginItemState()) setLoginItem(true);
    monitor.start();
  } else if (process.env.SYSMON_FIXTURE) {
    applyFixture(process.env.SYSMON_FIXTURE);
  }
  // Read-only LAN access to the same monitor state: MCP (Streamable HTTP,
  // bearer token from userData) plus mDNS discovery. Test mode keeps the LAN
  // listener and advertisement off unless SYSMON_MCP=1, and then binds an
  // ephemeral port inside the isolated userData so tests never touch the
  // production port or the network. A startup failure never crashes the app.
  if (!TEST || process.env.SYSMON_MCP === '1') {
    require('./mcp/index.cjs').start({
      monitor,
      userData: app.getPath('userData'),
      log: msg => console.log(`[sysmon] ${msg}`),
      port: Number(process.env.SYSMON_MCP_PORT) || (TEST ? 0 : 7738),
      mdns: !TEST,
    }).then(h => { mcpHandle = h; }).catch(e => console.log(`[sysmon] MCP failed to start: ${e.message}`));
  }
});
app.on('before-quit', () => { quitting = true; monitor?.stop(); grokAuth?.close(); clearTimeout(placeTimer); for (const t of claudeRefreshTimers) clearTimeout(t); claudeRefreshTimers.clear(); mcpHandle?.stop(); });
app.on('window-all-closed', () => {});
