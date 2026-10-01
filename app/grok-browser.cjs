// Grok website subscription quota via a REAL user-visible browser — never the
// embedded Electron webview (grok.com sign-in blocks it), never the native
// Grok app or any PWA/URL-handler (we spawn the browser executable directly
// with an https URL).
//
// Design contract:
// - Dedicated persistent profile under SysMon userData (`--user-data-dir`).
//   The user's own browser profiles are never touched; sign-in cookies live
//   only inside that dedicated profile and are never read, copied, or logged.
// - CDP is loopback-only: launched with `--remote-debugging-port=0` (real
//   Chrome/Edge only write DevToolsActivePort for port 0 — a fixed nonzero
//   port silently produces no port file, verified on Edge 154). The stale
//   port file is removed before launch; the fresh file must report an
//   integer port 1..65535 and a /devtools/browser/ path, and /json/version's
//   webSocketDebuggerUrl must match loopback + that exact port + that exact
//   path. Message sizes are bounded; request ids are unique; every call has
//   a timeout.
// - Read-only: no inference/chat request is ever sent. We observe the site's
//   own /rest/rate-limits calls (request shape + responses) and poll that
//   same endpoint from the page context only while the attached tab is on
//   the grok.com origin (never while the user is on an OAuth origin).
// - Never fabricate: malformed/zero/oversized quantities are rejected,
//   remaining must be <= limit, unknown reset times stay null and render as
//   unknown.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const GROK_ORIGIN = 'https://grok.com';
const RATE_LIMITS_PATH = '/rest/rate-limits';
const RATE_LIMITS_URL = GROK_ORIGIN + RATE_LIMITS_PATH;
const DEFAULT_PARAMS = { requestKind: 'DEFAULT', modelName: 'grok-4-auto' };
const MAX_MESSAGE = 4 * 1024 * 1024; // inbound CDP frame cap
const MAX_BODY = 256 * 1024; // quota response bodies we read
const MAX_POST = 16 * 1024; // observed request postData we parse
const CDP_TIMEOUT_MS = 10000;
const WS_OPEN_TIMEOUT_MS = 10000;
const PORT_FILE_TIMEOUT_MS = 15000;
const BROWSER_WS_PATH_PREFIX = '/devtools/browser/';

// Fixed, secret-free failure stages. Only the OS spawn error (path + errno,
// never payloads) is ever embedded into a user-visible message.
class StageError extends Error {
  constructor(stage) { super(stage); this.stage = stage; }
}
const STAGE_MESSAGES = {
  portfile: 'The browser did not expose its local debug session',
  version: 'Could not verify the browser debug endpoint',
  websocket: 'Could not connect to the browser debug socket',
  attach: 'Could not attach to a Grok tab in the browser',
};

// Well-known executable locations. On Linux we resolve names on PATH instead.
function browserCandidates(platform, env = process.env) {
  if (platform === 'darwin') {
    return [
      { name: 'Google Chrome', command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Chromium', command: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    ];
  }
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const list = [
      { name: 'Google Chrome', command: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', command: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    ];
    if (env.LOCALAPPDATA) list.push({ name: 'Google Chrome', command: path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    return list;
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .map((bin) => ({ name: bin, command: bin, onPath: true }));
}

function pathWhich(bin, env = process.env, existsSync = fs.existsSync) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    if (existsSync(full)) return full;
  }
  return null;
}

// First installed browser wins; null means "report the missing browser
// truthfully" — we never install anything on the user's behalf.
function findBrowser({ platform = process.platform, env = process.env, existsSync = fs.existsSync, which = pathWhich } = {}) {
  for (const c of browserCandidates(platform, env)) {
    if (c.onPath) {
      const full = which(c.command, env, existsSync);
      if (full) return { name: c.name, command: full };
    } else if (existsSync(c.command)) return { name: c.name, command: c.command };
  }
  return null;
}

// Explicit executable + https URL only: no --app= (PWA), no grok:// handler,
// no flag that could route to the native Grok app. Port 0: the browser picks
// an ephemeral loopback port and reports it via the profile's
// DevToolsActivePort file (the only mode that reliably produces that file).
function buildLaunchArgs({ profileDir, url = GROK_ORIGIN }) {
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    url,
  ];
}

// Strict finite number from JSON: accepts real numbers and non-empty numeric
// strings; rejects null/false/''/NaN/Infinity instead of coercing them to 0.
function toFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Website quota shape (private/undocumented, best-effort). Returns null on
// anything unexpected — malformed values are dropped, never coerced.
function parseRateLimits(body, sampledAt = Date.now()) {
  let r;
  try { r = typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
  if (!r || typeof r !== 'object') return null;
  const limit = toFinite(r.totalQueries ?? r.totalRequests);
  const remaining = toFinite(r.remainingQueries ?? r.remainingRequests);
  if (limit == null || limit <= 0) return null;
  if (remaining == null || remaining < 0 || remaining > limit) return null;
  let resetAt = null;
  const absolute = r.resetTime ?? r.resetAt;
  if (absolute != null) {
    const numeric = toFinite(absolute);
    const t = numeric == null ? Date.parse(absolute) : numeric > 1e12 ? numeric : numeric * 1000;
    if (Number.isFinite(t) && t > 0) resetAt = t;
  } else {
    // waitTimeSeconds is a reset delay; windowSizeSeconds is only the bucket
    // duration and cannot tell us where the user is within that window.
    const wait = toFinite(r.waitTimeSeconds);
    if (wait != null && wait > 0) resetAt = sampledAt + wait * 1000;
  }
  return { limit, remaining, resetAt }; // resetAt may stay null: never invented
}

function isGrokOrigin(value) {
  try { return new URL(value).origin === GROK_ORIGIN; } catch { return false; }
}
function isQuotaUrl(value) {
  try { const u = new URL(value); return u.origin === GROK_ORIGIN && u.pathname === RATE_LIMITS_PATH; } catch { return false; }
}

// webSocketDebuggerUrl must be loopback, on the exact port the profile-bound
// DevToolsActivePort file reported, and on the exact /devtools/browser/ path
// from that same file — anything else is not our own browser instance.
function isLoopbackBrowserWsUrl(value, expectedPort, expectedPath) {
  let u;
  try { u = new URL(value); } catch { return false; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return (u.protocol === 'ws:' || u.protocol === 'wss:')
    && ['127.0.0.1', 'localhost', '::1'].includes(host)
    && Number(u.port) === expectedPort
    && u.pathname === expectedPath
    && u.pathname.startsWith(BROWSER_WS_PATH_PREFIX);
}

// Port file content validation: integer port 1..65535 + browser ws path.
function parsePortFile(content) {
  const [portLine, wsPath] = String(content).split('\n');
  const port = Number(String(portLine || '').trim());
  const path2 = String(wsPath || '').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!path2.startsWith(BROWSER_WS_PATH_PREFIX) || path2.length <= BROWSER_WS_PATH_PREFIX.length) return null;
  if (!/^[\w./-]+$/.test(path2)) return null;
  return { port, wsPath: path2 };
}

function httpGetJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 5000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 64 * 1024) req.destroy(new Error('oversized'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new StageError('version'));
        try { resolve(JSON.parse(data)); } catch { reject(new StageError('version')); }
      });
    });
    req.on('timeout', () => req.destroy(new StageError('version')));
    req.on('error', () => reject(new StageError('version')));
  });
}

// Bounded startup: rejects on open-timeout, socket error, or a socket that
// closes before opening — Connect can never hang in "launching" forever.
function connectWs(url, Impl, timeoutMs = WS_OPEN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let ws, settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch {}
      reject(new StageError('websocket'));
    };
    const timer = setTimeout(fail, timeoutMs);
    try { ws = new Impl(url); } catch { clearTimeout(timer); settled = true; reject(new StageError('websocket')); return; }
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = fail;
    ws.onclose = () => { if (!settled) fail(); };
  });
}

// Minimal CDP framing over a WhatWG-style WebSocket. Inbound frames are size
// bounded, ids are monotonic and single-use, every call has a timeout, and
// error messages carry method names/codes only — never payloads.
class Cdp {
  constructor(ws, { maxMessage = MAX_MESSAGE, timeoutMs = CDP_TIMEOUT_MS, onPeerClose = null } = {}) {
    this.ws = ws;
    this.maxMessage = maxMessage;
    this.timeoutMs = timeoutMs;
    this.onPeerClose = onPeerClose;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.oversized = 0;
    this.closed = false;
    ws.onmessage = (ev) => this._recv(ev.data);
    ws.onclose = () => {
      this.closed = true;
      this._failAll(new Error('CDP connection closed'));
      if (this.onPeerClose) this.onPeerClose();
    };
  }
  _recv(data) {
    if (typeof data !== 'string') return;
    if (data.length > this.maxMessage) { this.oversized++; return; }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg == null || typeof msg !== 'object') return;
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return; // unknown or already-settled id: ignore
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP ${p.method} failed (code ${msg.error.code ?? 'unknown'})`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      for (const cb of this.handlers.get(msg.method) || []) {
        try { cb(msg.params, msg.sessionId); } catch {}
      }
    }
  }
  call(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error(`CDP ${method} could not be sent`)); }
    });
  }
  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }
  _failAll(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
  close() {
    this.closed = true;
    this._failAll(new Error('CDP connection closed'));
    try { this.ws.close(); } catch {}
  }
}

// onState(reading) receives the same raw Grok account shape the monitor has
// always consumed ({status, message, windows:[{label, used, resetAt, main}]}).
// spawnImpl/wsImpl/httpGet/which/existsSync are injectable so tests never
// launch a real browser or open a real port.
function createGrokBrowser({
  profileDir,
  onState,
  platform = process.platform,
  env = process.env,
  spawnImpl = spawn,
  wsImpl = globalThis.WebSocket,
  httpGet = httpGetJson,
  existsSync = fs.existsSync,
  which = pathWhich,
  now = () => Date.now(),
  pollIntervalMs = 120000,
  portFileTimeoutMs = PORT_FILE_TIMEOUT_MS,
  log = () => {},
} = {}) {
  if (!profileDir) throw new Error('profileDir is required');
  if (typeof onState !== 'function') throw new Error('onState is required');
  const state = {
    proc: null, procExited: true, cdp: null, sessionId: null, targetId: null,
    tabUrl: null, port: null, wsPath: null, browserName: null,
    observed: null, launching: false, polling: false, closing: false, pollTimer: null,
  };

  const emitLive = ({ limit, remaining, resetAt }) => onState({
    status: 'live',
    sampledAt: now(),
    windows: [{ label: 'Grok web', used: (100 * (limit - remaining)) / limit, resetAt, main: true }],
    message: resetAt ? null : 'Website does not report a reset time',
  });

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  function schedulePoll() {
    stopPolling();
    if (pollIntervalMs > 0 && state.cdp && !state.closing) {
      state.pollTimer = setTimeout(async () => { await poll(); schedulePoll(); }, pollIntervalMs);
      if (state.pollTimer.unref) state.pollTimer.unref();
    }
  }

  function detach() {
    stopPolling();
    if (state.cdp) state.cdp.close();
    state.cdp = null;
    state.sessionId = null;
    state.targetId = null;
    state.tabUrl = null;
  }

  function killProc() {
    if (state.proc && !state.procExited) {
      state.closing = true;
      try { state.proc.kill(); } catch {}
      state.closing = false;
    }
  }

  function onBrowserExit(code) {
    // Edge may relaunch its launcher while the browser and CDP stay alive.
    // A clean launcher exit is not evidence that the browser window closed.
    if (code === 0 && (state.launching || state.cdp)) return;
    state.proc = null;
    state.procExited = true;
    const hadSession = !!state.cdp;
    detach();
    if (!state.closing && hadSession) {
      onState({ status: 'unavailable', message: 'Grok browser window was closed — reconnect to refresh quota', windows: [] });
    }
  }

  // The stale port file is deleted before launch; whatever appears after must
  // be a fresh, valid report from OUR browser instance in OUR profile.
  async function awaitPortFile() {
    const file = path.join(profileDir, 'DevToolsActivePort');
    const deadline = now() + portFileTimeoutMs;
    for (;;) {
      if (state.procExited) throw new StageError('portfile');
      try {
        const parsed = parsePortFile(fs.readFileSync(file, 'utf8'));
        if (parsed) return parsed;
      } catch {}
      if (now() >= deadline) throw new StageError('portfile');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  function wireEvents() {
    state.cdp.on('Target.targetInfoChanged', (params) => {
      try {
        const t = params && params.targetInfo;
        if (t && t.targetId === state.targetId && typeof t.url === 'string') state.tabUrl = t.url;
      } catch {}
    });
    state.cdp.on('Target.targetDestroyed', (params) => {
      try {
        if (params && params.targetId === state.targetId) {
          state.sessionId = null;
          state.targetId = null;
          state.tabUrl = null;
        }
      } catch {}
    });
    state.cdp.on('Network.requestWillBeSent', (params, sessionId) => {
      try {
        const req = params && params.request;
        if (!req || sessionId !== state.sessionId || !isQuotaUrl(req.url)) return;
        const post = req.postData;
        if (typeof post !== 'string' || post.length > MAX_POST) return;
        const p = JSON.parse(post);
        if (p && typeof p.requestKind === 'string') {
          state.observed = { requestKind: p.requestKind, ...(typeof p.modelName === 'string' ? { modelName: p.modelName } : {}) };
        }
      } catch {}
    });
    state.cdp.on('Network.responseReceived', (params, sessionId) => {
      try {
        const res = params && params.response;
        if (!res || sessionId !== state.sessionId || res.status !== 200 || !isQuotaUrl(res.url)) return;
        readSiteQuota(params.requestId).catch(() => {}); // best-effort observation
      } catch {}
    });
  }

  async function readSiteQuota(requestId) {
    const r = await state.cdp.call('Network.getResponseBody', { requestId }, state.sessionId);
    let text = typeof r.body === 'string' ? r.body : '';
    if (r.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
    if (text.length > MAX_BODY) return;
    const parsed = parseRateLimits(text);
    if (parsed) emitLive(parsed);
  }

  async function attachToGrokTab() {
    await state.cdp.call('Target.setDiscoverTargets', { discover: true });
    const targets = await state.cdp.call('Target.getTargets');
    let target = (targets.targetInfos || []).find((t) => t.type === 'page' && isGrokOrigin(t.url));
    if (!target) {
      // No Grok tab (e.g. user closed it): open a fresh one in OUR browser.
      const created = await state.cdp.call('Target.createTarget', { url: GROK_ORIGIN });
      target = { targetId: created.targetId, type: 'page', url: GROK_ORIGIN + '/' };
    }
    state.targetId = target.targetId;
    state.tabUrl = target.url;
    const attached = await state.cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    state.sessionId = attached.sessionId;
    await state.cdp.call('Network.enable', {}, state.sessionId);
    await state.cdp.call('Runtime.enable', {}, state.sessionId);
  }

  // CDP attach to the already-running browser: /json/version must validate
  // against the profile-bound port + path before any socket is opened.
  async function attachToBrowser() {
    let version;
    try { version = await httpGet(state.port, '/json/version'); }
    catch (e) { throw e instanceof StageError ? e : new StageError('version'); }
    if (!version || !isLoopbackBrowserWsUrl(version.webSocketDebuggerUrl, state.port, state.wsPath)) {
      throw new StageError('version');
    }
    const ws = await connectWs(version.webSocketDebuggerUrl, wsImpl);
    state.cdp = new Cdp(ws, {
      onPeerClose: () => {
        // Peer hung up while the browser may still run: reset readiness so a
        // later Connect re-attaches instead of trusting a dead connection.
        state.cdp = null;
        state.sessionId = null;
        state.targetId = null;
        state.tabUrl = null;
        stopPolling();
        if (!state.closing) onState({ status: 'unavailable', message: 'Grok browser window was closed — reconnect to refresh quota', windows: [] });
      },
    });
    wireEvents();
    try { await attachToGrokTab(); }
    catch (e) { throw e instanceof StageError ? e : new StageError('attach'); }
    schedulePoll();
    poll();
  }

  async function connect() {
    if (state.launching) {
      return { ok: false, message: 'Grok browser window is already opening — finish sign-in there' };
    }
    state.launching = true;
    try {
      if (state.proc && !state.procExited) {
        if (state.cdp && state.sessionId) {
          return { ok: false, message: 'Grok browser window is already open — finish sign-in there' };
        }
        // Browser alive but connection dead / tab closed: re-attach.
        try { await attachToBrowser(); }
        catch (e) {
          killProc();
          const message = e instanceof StageError ? `Could not reconnect to the Grok browser — ${STAGE_MESSAGES[e.stage] || 'try again'}` : 'Could not reconnect to the Grok browser';
          onState({ status: 'unavailable', message, windows: [] });
          return { ok: false, message };
        }
        return { ok: true, message: 'Grok browser reconnected — sign in there; quota updates automatically' };
      }

      const browser = findBrowser({ platform, env, existsSync, which });
      if (!browser) {
        const message = 'No supported browser found — install Google Chrome to connect Grok';
        onState({ status: 'unavailable', message, windows: [] });
        return { ok: false, message };
      }
      state.browserName = browser.name;
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      try { fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true }); } catch {}
      const args = buildLaunchArgs({ profileDir });
      let proc;
      try {
        proc = spawnImpl(browser.command, args, { stdio: 'ignore', windowsHide: false });
      } catch (e) {
        // OS spawn errors carry the executable path and errno only.
        const message = `Could not start ${browser.name} (${e && e.message ? e.message : 'launch failed'})`;
        onState({ status: 'unavailable', message, windows: [] });
        return { ok: false, message };
      }
      state.proc = proc;
      state.procExited = false;
      proc.on('exit', onBrowserExit);
      proc.on('error', () => { state.procExited = true; });

      try {
        const { port, wsPath } = await awaitPortFile();
        state.port = port;
        state.wsPath = wsPath;
        await attachToBrowser();
      } catch (e) {
        cleanupAfterFailedLaunch();
        const stage = e instanceof StageError && STAGE_MESSAGES[e.stage] ? STAGE_MESSAGES[e.stage] : 'the browser session could not start';
        const message = `Could not open a Grok browser session — ${stage}`;
        onState({ status: 'unavailable', message, windows: [] });
        return { ok: false, message };
      }
      return { ok: true, message: `${browser.name} opened — sign in to Grok there; quota updates automatically` };
    } finally {
      state.launching = false;
    }
  }

  function cleanupAfterFailedLaunch() {
    detach();
    killProc();
  }

  // Read-only quota poll through the page's own context (its fetch inherits
  // the dedicated profile's session). Never runs while the tab sits on a
  // non-grok.com origin (OAuth pages), and never touches inference endpoints.
  async function poll() {
    if (!state.cdp || !state.sessionId || state.polling) return;
    if (!isGrokOrigin(state.tabUrl)) return; // mid-sign-in elsewhere: skip
    state.polling = true;
    try {
      const params = state.observed || DEFAULT_PARAMS;
      const expression = 'fetch(' + JSON.stringify(RATE_LIMITS_URL) + ', { method: "POST", headers: { "Content-Type": "application/json" }, body: ' + JSON.stringify(JSON.stringify(params)) + ' })'
        + '.then(async r => ({ status: r.status, body: (await r.text()).slice(0, ' + MAX_BODY + ') }))'
        + '.catch(() => ({ status: 0, body: "" }))';
      const res = await state.cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, state.sessionId);
      const v = res && res.result && res.result.value;
      if (!v || typeof v.status !== 'number') return;
      if (v.status === 401 || v.status === 403) {
        return onState({ status: 'auth', message: 'Sign in to Grok in the SysMon browser window', windows: [] });
      }
      if (v.status !== 200) {
        return onState({ status: 'unavailable', message: `Grok HTTP ${v.status} · open connection`, windows: [] });
      }
      const parsed = parseRateLimits(v.body);
      if (!parsed) return onState({ status: 'unavailable', message: 'Website quota format changed', windows: [] });
      emitLive(parsed);
    } catch {
      onState({ status: 'unavailable', message: 'Grok browser connection lost — reconnect', windows: [] });
    } finally {
      state.polling = false;
    }
  }

  async function close() {
    state.closing = true;
    stopPolling();
    const cdp = state.cdp;
    state.cdp = null;
    state.sessionId = null;
    state.targetId = null;
    state.tabUrl = null;
    if (cdp) {
      try { await Promise.race([cdp.call('Browser.close'), new Promise((r) => setTimeout(r, 3000))]); } catch {}
      cdp.close();
    }
    killProc();
    state.proc = null;
    state.procExited = true;
    state.closing = false;
  }

  return { connect, poll, close, _state: state };
}

module.exports = {
  createGrokBrowser,
  browserCandidates,
  findBrowser,
  buildLaunchArgs,
  parseRateLimits,
  parsePortFile,
  isGrokOrigin,
  isQuotaUrl,
  isLoopbackBrowserWsUrl,
  Cdp,
  StageError,
  GROK_ORIGIN,
  RATE_LIMITS_PATH,
  RATE_LIMITS_URL,
  DEFAULT_PARAMS,
};
