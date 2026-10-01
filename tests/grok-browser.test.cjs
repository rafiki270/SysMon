'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createGrokBrowser, findBrowser, browserCandidates, buildLaunchArgs,
  parseRateLimits, parsePortFile, isGrokOrigin, isQuotaUrl,
  isLoopbackBrowserWsUrl, Cdp, RATE_LIMITS_URL, GROK_ORIGIN,
} = require('../app/grok-browser.cjs');

const flush = () => new Promise((r) => setImmediate(r));
async function flushAll() { for (let i = 0; i < 8; i++) await flush(); }

function tmpProfile() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-grok-test-')); }

// A fake child process that never touches the real system.
function fakeProc() {
  const handlers = {};
  return {
    killed: false,
    on(ev, cb) { handlers[ev] = cb; return this; },
    kill() { this.killed = true; },
    exit(code = 0) { if (handlers.exit) handlers.exit(code); },
    error(e) { if (handlers.error) handlers.error(e); },
  };
}

// WhatWG-style fake WebSocket; routes sent frames to a programmable responder.
function makeWsClass(log, responder, { openDelay = true } = {}) {
  return class FakeWs {
    constructor(url) {
      this.url = url;
      this.sent = [];
      log.push({ ws: url });
      FakeWs.last = this;
      if (openDelay === 'close') setImmediate(() => this.onclose && this.onclose());
      else if (openDelay === 'hang') { /* never opens, never closes */ }
      else setImmediate(() => this.onopen && this.onopen());
    }
    send(raw) {
      const frame = JSON.parse(raw);
      this.sent.push(frame);
      const result = responder(frame);
      if (result === undefined) return; // no reply (simulates hang)
      Promise.resolve(result).then((r) => {
        const msg = r && r.__error ? { id: frame.id, error: r.__error } : { id: frame.id, result: r };
        this.onmessage && this.onmessage({ data: JSON.stringify(msg) });
      });
    }
    deliver(msg) { this.onmessage && this.onmessage({ data: JSON.stringify(msg) }); }
    close() { this.onclose && this.onclose(); }
  };
}

const GROK_TARGET = { targetId: 't1', type: 'page', url: 'https://grok.com/' };
const FRESH_PORT = 63983;
const FRESH_WS_PATH = '/devtools/browser/abc-123';

function baseResponder(overrides = {}) {
  return (frame) => {
    if (frame.method in overrides) {
      const v = overrides[frame.method];
      return typeof v === 'function' ? v(frame) : v;
    }
    switch (frame.method) {
      case 'Target.getTargets': return { targetInfos: [GROK_TARGET] };
      case 'Target.setDiscoverTargets': return {};
      case 'Target.createTarget': return { targetId: 't-created' };
      case 'Target.attachToTarget': return { sessionId: 'session-1' };
      case 'Network.enable': return {};
      case 'Runtime.enable': return {};
      case 'Browser.close': return {};
      case 'Runtime.evaluate': return { result: { value: { status: 401, body: '' } } };
      default: return {};
    }
  };
}

// Fully wired harness. The fake "browser" reports its CDP endpoint ONLY via a
// fresh DevToolsActivePort file in the dedicated profile (like a real
// port-0 launch); httpGet hands back a loopback webSocketDebuggerUrl bound to
// that exact port + path. Real browsers are never launched here.
function make(overrides = {}) {
  const log = [];
  const states = [];
  const profileDir = overrides.profileDir || tmpProfile();
  const proc = fakeProc();
  const spawnImpl = (command, args, opts) => {
    log.push({ command, args, opts });
    if (overrides.portFileContent !== null) {
      const content = overrides.portFileContent || `${FRESH_PORT}\n${FRESH_WS_PATH}`;
      setImmediate(() => fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), content));
    }
    return proc;
  };
  const wsImpl = makeWsClass(log, overrides.responder || baseResponder(), overrides.wsBehavior ? { openDelay: overrides.wsBehavior } : {});
  const httpGet = overrides.httpGet || (async (port, p) => {
    log.push({ httpGet: { port, path: p } });
    return { webSocketDebuggerUrl: `ws://127.0.0.1:${port}${FRESH_WS_PATH}` };
  });
  const gb = createGrokBrowser({
    profileDir,
    onState: (s) => states.push(s),
    platform: 'darwin',
    existsSync: (p) => p.includes('Google Chrome'),
    spawnImpl,
    wsImpl,
    httpGet,
    pollIntervalMs: 0,
    portFileTimeoutMs: 2500,
    ...overrides.module,
  });
  return { gb, log, states, proc, profileDir, ws: () => wsImpl.last };
}

test('launch args: dedicated profile, port 0 (real browsers only write DevToolsActivePort for port 0), loopback, https URL', () => {
  const args = buildLaunchArgs({ profileDir: '/x/sysmon-grok' });
  assert.ok(args.includes('--user-data-dir=/x/sysmon-grok'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=0'), 'ephemeral port allocated by the browser, never a fixed nonzero port');
  assert.ok(!args.some((a) => /^--remote-debugging-port=[1-9]/.test(a)));
  assert.strictEqual(args[args.length - 1], 'https://grok.com');
  assert.ok(!args.some((a) => a.startsWith('--app')), 'never PWA/--app mode');
  assert.ok(!args.some((a) => /grok:\/\//.test(a)), 'never a native URL handler');
  assert.ok(!args.some((a) => /--remote-debugging-(pipe|address=0\.0\.0\.0)/.test(a)));
});

test('parsePortFile: integer 1..65535 + /devtools/browser/ path only', () => {
  assert.deepStrictEqual(parsePortFile('63983\n/devtools/browser/abc-123'), { port: 63983, wsPath: '/devtools/browser/abc-123' });
  for (const bad of ['0\n/devtools/browser/x', '65536\n/devtools/browser/x', '-1\n/devtools/browser/x', '1.5\n/devtools/browser/x', 'abc\n/devtools/browser/x', '63983\n', '63983\n/devtools/browser/', '63983\n/devtools/page/x', '63983\n/evil/../../x', '63983\n/devtools/browser/a b', '']) {
    assert.strictEqual(parsePortFile(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('isLoopbackBrowserWsUrl: loopback + exact port + exact browser path', () => {
  assert.strictEqual(isLoopbackBrowserWsUrl('ws://127.0.0.1:63983/devtools/browser/abc-123', 63983, '/devtools/browser/abc-123'), true);
  assert.strictEqual(isLoopbackBrowserWsUrl('ws://[::1]:63983/devtools/browser/abc-123', 63983, '/devtools/browser/abc-123'), true);
  const bad = [
    'ws://0.0.0.0:63983/devtools/browser/abc-123',
    'ws://192.168.1.5:63983/devtools/browser/abc-123',
    'ws://evil.example:63983/devtools/browser/abc-123',
    'http://127.0.0.1:63983/devtools/browser/abc-123',
    'ws://127.0.0.1:63984/devtools/browser/abc-123', // wrong port
    'ws://127.0.0.1:63983/devtools/browser/other', // wrong path
    'ws://127.0.0.1:63983/devtools/page/abc-123', // page target, not browser
    'not a url', '',
  ];
  for (const b of bad) assert.strictEqual(isLoopbackBrowserWsUrl(b, 63983, '/devtools/browser/abc-123'), false, `rejects ${b}`);
});

test('origin helpers: URL.origin equality, never startsWith', () => {
  assert.strictEqual(isGrokOrigin('https://grok.com/'), true);
  assert.strictEqual(isGrokOrigin('https://grok.com/chat/123'), true);
  assert.strictEqual(isGrokOrigin('https://grok.com.evil.example/'), false);
  assert.strictEqual(isGrokOrigin('https://evil.example/?https://grok.com'), false);
  assert.strictEqual(isGrokOrigin('https://accounts.x.ai/login'), false);
  assert.strictEqual(isQuotaUrl(RATE_LIMITS_URL), true);
  assert.strictEqual(isQuotaUrl('https://grok.com.evil.example/rest/rate-limits'), false);
  assert.strictEqual(isQuotaUrl('https://grok.com/rest/rate-limits.evil'), false);
  assert.strictEqual(isQuotaUrl('https://grok.com/rest/inference'), false);
});

test('parseRateLimits: strict quantities, remaining <= limit, reset only when reported', () => {
  const sample = { windowSizeSeconds: 7200, remainingQueries: 2, totalQueries: 2, lowEffortRateLimits: null, highEffortRateLimits: null };
  assert.deepStrictEqual(parseRateLimits(sample), { limit: 2, remaining: 2, resetAt: null });
  assert.deepStrictEqual(parseRateLimits({ ...sample, remainingQueries: 0 }), { limit: 2, remaining: 0, resetAt: null });
  assert.strictEqual(parseRateLimits({ ...sample, totalQueries: false }), null);
  assert.strictEqual(parseRateLimits({ ...sample, remainingQueries: 3 }), null);
  assert.strictEqual(parseRateLimits({ ...sample, waitTimeSeconds: 60 }, 1790000000000).resetAt, 1790000060000);
  assert.strictEqual(parseRateLimits({ ...sample, resetAt: 1790000000000 }).resetAt, 1790000000000);
  assert.deepStrictEqual(
    parseRateLimits(JSON.stringify({ totalRequests: 100, remainingQueries: 40 })),
    { limit: 100, remaining: 40, resetAt: null },
  );
  assert.deepStrictEqual(parseRateLimits({ totalRequests: '50', remainingRequests: '10' }), { limit: 50, remaining: 10, resetAt: null });
  const iso = parseRateLimits({ totalRequests: 50, remainingRequests: 50, resetTime: '2026-10-01T12:00:00Z' });
  assert.strictEqual(iso.resetAt, Date.parse('2026-10-01T12:00:00Z'));
  assert.strictEqual(parseRateLimits({ totalRequests: 50, remainingRequests: 10, resetAt: 1790000000 }).resetAt, 1790000000000);
  const rejects = [
    'not json', '{}', 'null', '[1]',
    '{"totalRequests":0,"remainingQueries":1}',
    '{"totalRequests":10}',
    '{"totalRequests":10,"remainingQueries":null}', // Number(null)===0 would fabricate
    '{"totalRequests":10,"remainingQueries":false}',
    '{"totalRequests":10,"remainingQueries":""}',
    '{"totalRequests":10,"remainingQueries":-1}',
    '{"totalRequests":10,"remainingQueries":11}', // remaining > limit
    '{"totalRequests":null,"remainingQueries":1}',
    '{"totalRequests":true,"remainingQueries":1}',
    '{"totalRequests":"Infinity","remainingQueries":1}',
  ];
  for (const bad of rejects) assert.strictEqual(parseRateLimits(bad), null, `rejects ${bad}`);
  assert.strictEqual(parseRateLimits({ totalRequests: 10, remainingQueries: 5, resetTime: 'soon' }).resetAt, null);
});

test('connect: port-0 launch, fresh profile-bound port file consumed, dedup while open', async () => {
  const { gb, log, states, profileDir } = make();
  const r = await gb.connect();
  assert.strictEqual(r.ok, true);
  assert.match(r.message, /Google Chrome opened/);
  const launch = log.find((e) => e.args);
  assert.strictEqual(launch.command, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.ok(launch.args.includes(`--user-data-dir=${profileDir}`), 'dedicated persistent SysMon profile');
  assert.ok(launch.args.includes('--remote-debugging-port=0'));
  assert.strictEqual(launch.opts.windowsHide, false, 'browser window stays user-visible');
  // The debug endpoint came from the fresh port file, not from any flag.
  const get = log.find((e) => e.httpGet);
  assert.deepStrictEqual(get.httpGet, { port: FRESH_PORT, path: '/json/version' });
  const wsOpen = log.find((e) => e.ws);
  assert.strictEqual(wsOpen.ws, `ws://127.0.0.1:${FRESH_PORT}${FRESH_WS_PATH}`);
  assert.strictEqual(gb._state.port, FRESH_PORT);
  assert.strictEqual(gb._state.wsPath, FRESH_WS_PATH);
  const again = await gb.connect();
  assert.strictEqual(again.ok, false);
  assert.match(again.message, /already open/);
  assert.strictEqual(log.filter((e) => e.args).length, 1, 'no second browser launch');
  assert.ok(states.every((s) => s.status !== 'live' || s.windows.length === 1));
  await gb.close();
});

test('stale DevToolsActivePort is deleted before launch and never trusted', async () => {
  const profileDir = tmpProfile();
  fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), '11111\n/devtools/browser/stale');
  // Browser never writes a fresh file: connect must fail on the port-file
  // stage rather than consume the stale 11111 endpoint.
  const { gb, log, states } = make({ profileDir, portFileContent: null });
  const r = await gb.connect();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /did not expose its local debug session/);
  assert.ok(!log.some((e) => e.httpGet), 'stale port never used');
  assert.ok(!log.some((e) => e.ws), 'no socket opened against a stale endpoint');
  assert.strictEqual(states.at(-1).status, 'unavailable', 'failure is visible to the renderer');
});

test('invalid fresh port file contents are rejected', async () => {
  for (const content of ['0\n/devtools/browser/x', '70000\n/devtools/browser/x', 'garbage', '1234\n/devtools/page/x']) {
    const { gb, log } = make({ portFileContent: content });
    const r = await gb.connect();
    assert.strictEqual(r.ok, false, `rejects ${JSON.stringify(content)}`);
    assert.match(r.message, /did not expose its local debug session/);
    assert.ok(!log.some((e) => e.ws));
  }
});

test('connect reports a missing browser truthfully and never installs one', async () => {
  const { gb, log, states } = make({ module: { existsSync: () => false } });
  const r = await gb.connect();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /No supported browser found/);
  assert.strictEqual(log.filter((e) => e.args).length, 0, 'no spawn attempted');
  assert.strictEqual(states.at(-1).status, 'unavailable');
  assert.match(states.at(-1).message, /install Google Chrome/);
});

test('connect failure after spawn is explicit, renderer-visible, and token-free', async () => {
  const { gb, states } = make({ portFileContent: null });
  const r = await gb.connect();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Could not open a Grok browser session/);
  assert.ok(!/sso|cookie|token|authorization/i.test(r.message));
  assert.strictEqual(states.at(-1).status, 'unavailable');
  assert.match(states.at(-1).message, /Could not open a Grok browser session/);
});

test('webSocketDebuggerUrl failing loopback/port/path validation is rejected', async () => {
  const httpGet = async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${FRESH_PORT}/devtools/browser/DIFFERENT` });
  const { gb, log, states } = make({ httpGet });
  const r = await gb.connect();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Could not verify the browser debug endpoint/);
  assert.ok(!log.some((e) => e.ws), 'socket never opened to an unvalidated URL');
  assert.strictEqual(states.at(-1).status, 'unavailable');
});

test('websocket closed-before-open fails bounded and Connect can retry', async () => {
  const h = make({ wsBehavior: 'close' });
  const r = await h.gb.connect();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /debug socket/);
  assert.strictEqual(h.gb._state.launching, false, 'never stuck in launching');
  assert.strictEqual(h.states.at(-1).status, 'unavailable');
  const h2 = make({ profileDir: h.profileDir });
  const r2 = await h2.gb.connect();
  assert.strictEqual(r2.ok, true, 'retry after a dead socket works');
  await h2.gb.close();
});

test('websocket open timeout is bounded', async () => {
  const { gb } = make({ wsBehavior: 'hang', module: { portFileTimeoutMs: 2500 } });
  const started = Date.now();
  const r = await gb.connect();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /debug socket/);
  assert.ok(Date.now() - started < 15000, 'bounded startup');
  assert.strictEqual(gb._state.launching, false);
});

test('peer close mid-session resets readiness; reconnect re-attaches without a new launch', async () => {
  const { gb, log, proc } = make();
  await gb.connect();
  await flushAll();
  gb._state.cdp.ws.close(); // peer hangs up, browser process still alive
  await flushAll();
  assert.strictEqual(gb._state.cdp, null);
  assert.strictEqual(gb._state.sessionId, null);
  const r = await gb.connect();
  assert.strictEqual(r.ok, true);
  assert.match(r.message, /reconnected/);
  assert.strictEqual(log.filter((e) => e.args).length, 1, 'same browser process re-used');
  assert.ok(!proc.killed);
  await gb.close();
});

test('non-grok.com tab is never attached: a fresh Grok tab is created instead', async () => {
  const created = [];
  const responder = baseResponder({
    'Target.getTargets': { targetInfos: [{ targetId: 'evil', type: 'page', url: 'https://grok.com.evil.example/' }] },
    'Target.createTarget': (frame) => { created.push(frame.params.url); return { targetId: 't-created' }; },
  });
  const { gb } = make({ responder });
  const r = await gb.connect();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(created, [GROK_ORIGIN], 'grok.com.evil.example rejected via URL.origin');
  assert.strictEqual(gb._state.targetId, 't-created');
  await gb.close();
});

test('poll uses absolute quota URL and never fires while the tab is on another origin', async () => {
  const evaluated = [];
  const responder = baseResponder({
    'Runtime.evaluate': (frame) => { evaluated.push(frame.params.expression); return { result: { value: { status: 401, body: '' } } }; },
  });
  const { gb, ws } = make({ responder });
  await gb.connect();
  await flushAll();
  assert.strictEqual(evaluated.length, 1);
  assert.ok(evaluated[0].includes(`fetch("${RATE_LIMITS_URL}"`), 'absolute URL, never a relative path on a foreign origin');
  assert.ok(!evaluated[0].includes('"/rest/rate-limits"'));
  // User navigates the tab to the OAuth origin: polling must stop entirely.
  ws().deliver({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 't1', url: 'https://accounts.x.ai/login' } } });
  await gb.poll();
  assert.strictEqual(evaluated.length, 1, 'no quota fetch while on the OAuth origin');
  // Back on grok.com: polling resumes.
  ws().deliver({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 't1', url: 'https://grok.com/' } } });
  await gb.poll();
  assert.strictEqual(evaluated.length, 2);
  await gb.close();
});

test('poll: default request shape until one is observed; valid body goes live with raw used percent', async () => {
  const seen = [];
  const responder = baseResponder({
    'Runtime.evaluate': (frame) => {
      seen.push(JSON.parse(JSON.parse(frame.params.expression.match(/body: ("(?:[^"\\]|\\.)*")/)[1])));
      return { result: { value: { status: 200, body: JSON.stringify({ totalRequests: 200, remainingQueries: 50 }) } } };
    },
  });
  const { gb, states } = make({ responder });
  await gb.connect();
  await flushAll();
  assert.deepStrictEqual(seen[0], { requestKind: 'DEFAULT', modelName: 'grok-4-auto' });
  const live = states.at(-1);
  assert.strictEqual(live.status, 'live');
  assert.deepStrictEqual(live.windows, [{ label: 'Grok web', used: 75, resetAt: null, main: true }]);
  assert.match(live.message, /does not report a reset time/);
  await gb.poll();
  assert.strictEqual(states.at(-1).status, 'live');
  await gb.close();
});

test('poll: 401/403 asks to sign in; other failures explicit; malformed quota format flagged', async () => {
  let reply = { status: 401, body: '' };
  const responder = baseResponder({ 'Runtime.evaluate': () => ({ result: { value: reply } }) });
  const { gb, states } = make({ responder });
  await gb.connect();
  await flushAll();
  assert.strictEqual(states.at(-1).status, 'auth');
  assert.match(states.at(-1).message, /Sign in to Grok/);

  reply = { status: 500, body: '' };
  await gb.poll();
  assert.strictEqual(states.at(-1).status, 'unavailable');
  assert.match(states.at(-1).message, /Grok HTTP 500/);

  reply = { status: 200, body: '{"surprise":true}' };
  await gb.poll();
  assert.strictEqual(states.at(-1).status, 'unavailable');
  assert.match(states.at(-1).message, /quota format changed/);
  await gb.close();
});

test("site's own rate-limits traffic is observed: request shape learned, response quota read", async () => {
  const bodies = { 'req-1': JSON.stringify({ totalRequests: 100, remainingQueries: 90, resetTime: '2026-10-02T00:00:00Z' }) };
  const responder = baseResponder({
    'Network.getResponseBody': (frame) => ({ body: bodies[frame.params.requestId] || '', base64Encoded: false }),
  });
  const { gb, states, ws } = make({ responder });
  await gb.connect();
  await flushAll();
  assert.strictEqual(gb._state.sessionId, 'session-1');

  ws().deliver({ method: 'Network.requestWillBeSent', sessionId: 'session-1', params: { requestId: 'req-1', request: { url: RATE_LIMITS_URL, postData: JSON.stringify({ requestKind: 'REASONING', modelName: 'grok-4' }) } } });
  ws().deliver({ method: 'Network.responseReceived', sessionId: 'session-1', params: { requestId: 'req-1', response: { url: RATE_LIMITS_URL, status: 200 } } });
  await flushAll();

  const live = states.at(-1);
  assert.strictEqual(live.status, 'live');
  assert.strictEqual(live.windows[0].used, 10);
  assert.strictEqual(live.windows[0].resetAt, Date.parse('2026-10-02T00:00:00Z'));
  assert.strictEqual(live.message, null);
  assert.deepStrictEqual(gb._state.observed, { requestKind: 'REASONING', modelName: 'grok-4' });

  // Other sessions, lookalike origins, and non-quota paths are ignored.
  const before = states.length;
  ws().deliver({ method: 'Network.responseReceived', sessionId: 'other', params: { requestId: 'req-1', response: { url: RATE_LIMITS_URL, status: 200 } } });
  ws().deliver({ method: 'Network.responseReceived', sessionId: 'session-1', params: { requestId: 'req-1', response: { url: 'https://grok.com.evil.example/rest/rate-limits', status: 200 } } });
  ws().deliver({ method: 'Network.responseReceived', sessionId: 'session-1', params: { requestId: 'req-1', response: { url: 'https://grok.com/rest/inference', status: 200 } } });
  await flushAll();
  assert.strictEqual(states.length, before);
  await gb.close();
});

test('browser exit after a session marks the card unavailable, never fabricates quota', async () => {
  const { gb, log, states, proc, profileDir } = make();
  await gb.connect();
  await flushAll();
  proc.exit(0);
  // A clean launcher exit alone is also an Edge compatibility relaunch.
  assert.ok(gb._state.cdp);
  proc.exit(1);
  await flushAll();
  const last = states.at(-1);
  assert.strictEqual(last.status, 'unavailable');
  assert.match(last.message, /closed — reconnect/);
  assert.deepStrictEqual(last.windows, []);
  // Reconnect relaunches against the same persistent profile.
  const r = await gb.connect();
  assert.strictEqual(r.ok, true);
  const launches = log.filter((e) => e.args);
  assert.strictEqual(launches.length, 2);
  assert.ok(launches[1].args.includes(`--user-data-dir=${profileDir}`), 'profile persists across relaunch');
  await gb.close();
});

test('close() shuts the browser via CDP and kills the process; errors carry no payloads', async () => {
  const { gb, proc, ws } = make();
  await gb.connect();
  await flushAll();
  await gb.close();
  assert.ok(proc.killed, 'process killed after Browser.close');
  assert.ok(ws().sent.some((f) => f.method === 'Browser.close'));
  // CDP error frames with secrets in the message must not leak into rejections.
  const c = new Cdp({ send() {}, close() {} });
  const p = c.call('Network.getResponseBody', { requestId: 'x' });
  c._recv(JSON.stringify({ id: 1, error: { code: -32000, message: 'cookie sso=secretvalue leaked' } }));
  await assert.rejects(p, (e) => {
    assert.ok(!/secretvalue|sso=/.test(e.message));
    return true;
  });
});

test('Cdp: peer close marks the connection closed; oversized frames dropped; ids single-use; timeouts fire', async () => {
  const c = new Cdp({ send() {}, close() {} }, { maxMessage: 1024, timeoutMs: 50 });
  c._recv('x'.repeat(5000));
  assert.strictEqual(c.oversized, 1);
  c._recv('not json');
  c._recv(JSON.stringify({ id: 999, result: {} })); // unknown id: no crash
  const settled = [];
  const p = c.call('Runtime.evaluate');
  p.catch((e) => settled.push(e.message));
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(settled, ['CDP Runtime.evaluate timed out']);
  c._recv(JSON.stringify({ id: 1, result: {} })); // late reply for settled id ignored
  c.ws.onclose();
  assert.strictEqual(c.closed, true, 'peer close flips readiness');
  await assert.rejects(() => c.call('X'), /closed/);
});

test('Grok uses Chrome on Windows even when Edge is installed', () => {
  const chrome = findBrowser({platform:'win32', existsSync:()=>true});
  assert.strictEqual(chrome.name, 'Google Chrome');
  assert.match(chrome.command, /chrome\.exe$/i);
  assert.strictEqual(findBrowser({platform:'win32', existsSync:p=>/msedge/i.test(p)}), null);
  for (const platform of ['win32','darwin','linux']) assert.ok(browserCandidates(platform).every(c=>!/edge/i.test(c.command)));
});
