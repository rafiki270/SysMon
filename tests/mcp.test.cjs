// MCP + mDNS coverage. Protocol tests use the official MCP SDK client (not
// hand-written JSON-RPC); raw fetch appears only where the SDK client cannot
// go (missing/bad auth, browser Origin, wrong path). Servers bind 127.0.0.1
// on ephemeral ports with temp userData dirs; mDNS uses an injected fake
// Bonjour so tests never emit real LAN traffic or touch the production port.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const { Monitor, hosts } = require('../app/monitor.cjs');
const { tokenFile, loadOrCreateToken, readToken, defaultTokenFile } = require('../app/mcp/token.cjs');
const { createMcpServer, sanitize } = require('../app/mcp/registry.cjs');
const { McpHttpServer } = require('../app/mcp/server.cjs');
const { MdnsAdvertiser, serviceConfigs } = require('../app/mcp/mdns.cjs');
const mcpLifecycle = require('../app/mcp/index.cjs');

const ADAPTER = path.join(__dirname, '..', 'app', 'mcp', 'stdio.cjs');
const APP_MAIN = path.join(__dirname, '..', 'app', 'main.cjs');

// The packaged-binary invocations MCP clients actually use after install.
// Returns null when no packed build exists (CI packs after the test phase;
// run `npm run pack` locally first to exercise this).
function packagedBinary() {
  const dist = path.join(__dirname, '..', 'dist');
  const candidates = {
    darwin: ['mac/SysMon.app/Contents/MacOS/SysMon', 'mac-arm64/SysMon.app/Contents/MacOS/SysMon'],
    win32: ['win-unpacked/SysMon.exe'],
    linux: ['linux-unpacked/sysmon'],
  }[process.platform] || [];
  for (const rel of candidates) {
    const p = path.join(dist, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Path of app/main.cjs inside the packed asar, as seen by the packed binary
// itself (Electron resolves asar paths; plain fs.existsSync cannot, so check
// the asar file instead).
function packagedAsarMain(binary) {
  const resources = process.platform === 'darwin'
    ? path.join(path.dirname(binary), '..', 'Resources')
    : path.join(path.dirname(binary), 'resources');
  const asar = path.join(resources, 'app.asar');
  return fs.existsSync(asar) ? path.join(asar, 'app', 'main.cjs') : null;
}

// Adapter launch modes, all spoken to through the official SDK stdio client:
//   direct  — dev checkout: plain node on the adapter (deps from node_modules)
//   runasnode — installed dispatch: electron binary runs app/main.cjs as plain
//               node (ELECTRON_RUN_AS_NODE=1), which routes --mcp-stdio to the
//               adapter before any GUI/single-instance/poller startup
//   packaged — the real packed binary and its bundled asar. macOS/Linux run
//              `SysMon --mcp-stdio` directly; Windows must use the RunAsNode
//              form against the installed asar: the packed exe is a
//              GUI-subsystem binary whose stdio pipes never carry MCP
//              traffic (the adapter connects, then the client hangs —
//              verified against the installed Windows build).
function adapterTransports(env) {
  const modes = [
    ['direct', { command: process.execPath, args: [ADAPTER], env }],
    ['runasnode', { command: require('electron'), args: [APP_MAIN, '--mcp-stdio'], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }],
  ];
  const binary = packagedBinary();
  if (binary) {
    const asarMain = packagedAsarMain(binary);
    if (asarMain) modes.push(['packaged', { command: binary, args: [asarMain, '--mcp-stdio'], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }]);
  }
  return modes;
}

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-mcp-test-')); }

// A monitor state that exercises everything: live daemon metrics with 60s
// history and GB fields, a stale host, an offline host, all quota windows
// (percent and GB, resets), staleness timestamps, CI jobs, plus an unknown
// pass-through field and a decoy sensitively-named field that must be stripped.
function fixtureMonitor() {
  const monitor = new Monitor({ log: () => {} });
  const now = Date.now();
  monitor.applyMetrics(hosts.find((h) => h.id === 'dictator'), {
    type: 'metrics', source: 'daemon', cpu: 42.4, mem: 55.1, memUsed: 8.2e9, memTotal: 16e9,
    disk: 70, diskFree: 1e11, diskTotal: 5e11, uptime: 123456, topProc: 'node', topPct: 12.3,
    history: [{ at: now - 2500, cpu: 40 }, { at: now, cpu: 42.4 }], sampledAt: now,
  });
  monitor.applyMetrics(hosts.find((h) => h.id === 'minis'), { source: 'collector', cpu: 10, mem: 20, sampledAt: now - 60000 });
  monitor.degrade(hosts.find((h) => h.id === 'minis'), 'offline'); // stale: last reading preserved
  monitor.degrade(hosts.find((h) => h.id === 'umac'), 'offline'); // never reached: offline
  monitor.state.accounts = monitor.state.accounts.map((a, i) => i === 0
    ? {
        ...a, status: 'live', sampledAt: now - 1000, lastSuccessAt: now - 1000,
        windows: [
          { label: '5h', used: 40, limit: 100, unit: 'percent', resetsAt: now + 18000000, main: true },
          { label: 'weekly', usedGB: 2.5, limitGB: 10, unit: 'gb', resetsAt: now + 400000000 },
        ],
      }
    : i === 1 ? { ...a, status: 'stale', sampledAt: now - 90000, lastSuccessAt: now - 90000, windows: [{ label: '5h', used: 12, limit: 100, unit: 'percent', resetsAt: null }] }
    : a);
  monitor.state.ci = { status: 'live', sampledAt: now - 5000, scope: 'Open PRs authored by you with failing checks', jobs: [{ repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', title: 'Fix' }], truncated: false };
  monitor.state.machines[0].experimentalField = { nested: ['kept', 42] }; // unknown values must pass through
  monitor.state.machines[0].sessionToken = 'DECOY-SECRET'; // must never leave the app
  monitor.publish();
  return monitor;
}

const expectedSnapshot = (monitor) => sanitize(JSON.parse(JSON.stringify(monitor.state)));

async function startFixture(monitor, opts = {}) {
  const dir = tmpdir();
  const token = loadOrCreateToken(tokenFile(dir));
  const logs = [];
  const server = new McpHttpServer({ monitor, token, log: (m) => logs.push(m), ...opts });
  await server.start({ port: 0, host: '127.0.0.1' });
  assert.ok(server.listening(), 'fixture server must bind');
  return { dir, token, server, logs, url: `http://127.0.0.1:${server.port()}/mcp` };
}

async function connectClient(url, token) {
  const client = new Client({ name: 'mcp-test-client', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

test('token: durable, owner-only, regenerated when corrupt, never logged', async () => {
  const dir = tmpdir();
  const file = tokenFile(dir);
  const first = loadOrCreateToken(file);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(loadOrCreateToken(file), first); // durable across restarts
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'corrupted!!');
  const regenerated = loadOrCreateToken(file);
  assert.notStrictEqual(regenerated, first);
  assert.strictEqual(readToken(file), regenerated);
  assert.throws(() => readToken(path.join(dir, 'missing')), /not found/);

  const monitor = fixtureMonitor();
  const fx = await startFixture(monitor);
  try {
    assert.ok(fx.logs.length > 0);
    for (const line of fx.logs) assert.ok(!line.includes(fx.token), 'logs must never contain the token');
  } finally { await fx.server.stop(); }
});

test('token resolution: env overrides, then platform userData names', () => {
  assert.strictEqual(defaultTokenFile({ env: { SYSMON_MCP_TOKEN_FILE: '/x/tok' } }), '/x/tok');
  assert.strictEqual(defaultTokenFile({ env: { SYSMON_USERDATA: '/x/ud' } }), path.join('/x/ud', 'mcp-token'));
  const home = os.platform() === 'win32' ? 'C:\\Users\\u' : '/home/u';
  const mac = defaultTokenFile({ platform: 'darwin', env: {}, home, exists: () => false });
  assert.strictEqual(mac, path.join(home, 'Library', 'Application Support', 'SysMon', 'mcp-token'));
  const win = defaultTokenFile({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home, exists: () => false });
  assert.strictEqual(win, path.join('C:\\Users\\u\\AppData\\Roaming', 'SysMon', 'mcp-token'));
  // dev builds use the package name dir when that is where the token lives
  const dev = defaultTokenFile({ platform: 'linux', env: {}, home, exists: (p) => p.includes(`${path.sep}sysmon${path.sep}`) });
  assert.strictEqual(dev, path.join(home, '.config', 'sysmon', 'mcp-token'));
});

test('SDK client initializes and lists exactly four read-only tools, no token in metadata', async () => {
  const fx = await startFixture(fixtureMonitor());
  const client = await connectClient(fx.url, fx.token);
  try {
    const version = client.getServerVersion();
    assert.strictEqual(version.name, 'sysmon');
    assert.ok(version.version);
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['get_accounts', 'get_ci', 'get_machines', 'get_stats']);
    for (const t of tools) {
      assert.strictEqual(t.annotations.readOnlyHint, true, `${t.name} must be read-only`);
      assert.strictEqual(t.annotations.destructiveHint, false);
    }
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    for (const u of ['sysmon://snapshot', 'sysmon://machines', 'sysmon://accounts', 'sysmon://ci']) assert.ok(uris.includes(u), `missing ${u}`);
    const { resourceTemplates } = await client.listResourceTemplates();
    const templates = resourceTemplates.map((r) => r.uriTemplate);
    assert.ok(templates.includes('sysmon://machines/{id}'));
    assert.ok(templates.includes('sysmon://accounts/{id}'));
    const metadata = JSON.stringify({ version, tools, resources, resourceTemplates, instructions: client.getInstructions() });
    assert.ok(!metadata.includes(fx.token), 'MCP metadata must never contain the token');
  } finally {
    await client.close();
    await fx.server.stop();
  }
});

test('every tool call returns deep-equal live state including history, windows, staleness, unknown fields', async () => {
  const monitor = fixtureMonitor();
  const fx = await startFixture(monitor);
  const client = await connectClient(fx.url, fx.token);
  try {
    const expected = expectedSnapshot(monitor);

    const stats = await client.callTool({ name: 'get_stats', arguments: {} });
    assert.deepStrictEqual(stats.structuredContent, expected);
    assert.deepStrictEqual(JSON.parse(stats.content[0].text), expected);
    assert.strictEqual(stats.structuredContent.machines.find((m) => m.id === 'dictator').history.length, 2, 'CPU history must be included');
    assert.deepStrictEqual(stats.structuredContent.machines.find((m) => m.id === 'minis').experimentalField, { nested: ['kept', 42] }, 'unknown fields pass through');
    assert.strictEqual(stats.structuredContent.accounts[0].windows.length, 2, 'all quota windows included');
    assert.strictEqual(stats.structuredContent.machines.find((m) => m.id === 'minis').status, 'stale');
    assert.strictEqual(stats.structuredContent.machines.find((m) => m.id === 'umac').status, 'offline');
    assert.ok(!JSON.stringify(stats).includes('DECOY-SECRET'), 'sensitively-named fields are stripped');
    assert.ok(!JSON.stringify(stats).includes(fx.token));

    const machines = await client.callTool({ name: 'get_machines', arguments: {} });
    assert.deepStrictEqual(machines.structuredContent.items, expected.machines);
    const one = await client.callTool({ name: 'get_machines', arguments: { id: 'dictator' } });
    assert.deepStrictEqual(one.structuredContent.items, [expected.machines.find((m) => m.id === 'dictator')]);
    const none = await client.callTool({ name: 'get_machines', arguments: { id: 'nope' } });
    assert.deepStrictEqual(none.structuredContent.items, []);

    const accounts = await client.callTool({ name: 'get_accounts', arguments: {} });
    assert.deepStrictEqual(accounts.structuredContent.items, expected.accounts);
    const byHost = await client.callTool({ name: 'get_accounts', arguments: { host: 'minis' } });
    assert.deepStrictEqual(byHost.structuredContent.items, expected.accounts.filter((a) => a.host === 'minis'));
    const byVendor = await client.callTool({ name: 'get_accounts', arguments: { vendor: 'kimi' } });
    assert.deepStrictEqual(byVendor.structuredContent.items, expected.accounts.filter((a) => a.vendor === 'Kimi'));

    const ci = await client.callTool({ name: 'get_ci', arguments: {} });
    assert.deepStrictEqual(ci.structuredContent, expected.ci);

    // Tools read the exact shared state: a mutation is visible immediately.
    monitor.machine('dictator').cpu = 99.9;
    const updated = await client.callTool({ name: 'get_machines', arguments: { id: 'dictator' } });
    assert.strictEqual(updated.structuredContent.items[0].cpu, 99.9);
  } finally {
    await client.close();
    await fx.server.stop();
  }
});

test('resources read deep-equal state; templates enumerate live ids; unknown ids error', async () => {
  const monitor = fixtureMonitor();
  const fx = await startFixture(monitor);
  const client = await connectClient(fx.url, fx.token);
  try {
    const expected = expectedSnapshot(monitor);
    const snap = await client.readResource({ uri: 'sysmon://snapshot' });
    assert.strictEqual(snap.contents[0].mimeType, 'application/json');
    assert.deepStrictEqual(JSON.parse(snap.contents[0].text), expected);

    const machine = await client.readResource({ uri: 'sysmon://machines/dictator' });
    assert.deepStrictEqual(JSON.parse(machine.contents[0].text), expected.machines.find((m) => m.id === 'dictator'));
    const account = await client.readResource({ uri: 'sysmon://accounts/grok' });
    assert.deepStrictEqual(JSON.parse(account.contents[0].text), expected.accounts.find((a) => a.id === 'grok'));
    const ci = await client.readResource({ uri: 'sysmon://ci' });
    assert.deepStrictEqual(JSON.parse(ci.contents[0].text), expected.ci);

    const { resources } = await client.listResources();
    for (const id of ['minis', 'dictator', 'umac', 'maxis']) assert.ok(resources.some((r) => r.uri === `sysmon://machines/${id}`), 'template list enumerates machines');
    assert.ok(resources.some((r) => r.uri === 'sysmon://accounts/dictator-Kimi'), 'template list enumerates accounts');

    await assert.rejects(client.readResource({ uri: 'sysmon://machines/nope' }), /Unknown machine id/);
    assert.ok(!JSON.stringify(snap).includes(fx.token));
  } finally {
    await client.close();
    await fx.server.stop();
  }
});

test('security: missing/bad token rejected 401, browser Origin rejected 403, other paths 404', async () => {
  const fx = await startFixture(fixtureMonitor());
  try {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
    const post = (headers) => fetch(fx.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) }).then(async (r) => { await r.text(); return r.status; });

    assert.strictEqual(await post({}), 401, 'missing token must be rejected');
    assert.strictEqual(await post({ authorization: 'Bearer wrong-token' }), 401, 'bad token must be rejected');
    assert.strictEqual(await post({ authorization: `Bearer ${fx.token}` }), 200, 'valid token accepted');
    assert.strictEqual(await post({ authorization: `Bearer ${fx.token}`, origin: 'https://evil.example' }), 403, 'browser Origin must be rejected even with a valid token');
    // Origin is rejected by presence, including an empty value (undici drops
    // empty headers, so go through node:http for this one).
    const emptyOrigin = await new Promise((resolve, reject) => {
      const req = require('node:http').request(fx.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${fx.token}`, Origin: '' },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(JSON.stringify(init));
    });
    assert.strictEqual(emptyOrigin, 403, 'empty Origin header must still be rejected');
    const wrongPath = await fetch(`http://127.0.0.1:${fx.server.port()}/other`, { headers: { authorization: `Bearer ${fx.token}` } });
    assert.strictEqual(wrongPath.status, 404);
    await wrongPath.text();

    const unauth = await fetch(fx.url);
    assert.strictEqual(unauth.headers.get('www-authenticate'), 'Bearer realm="sysmon-mcp"');
    await unauth.text();
    assert.ok(!await (await fetch(fx.url)).text().then((t) => t.includes(fx.token)), 'error bodies never echo the token');
  } finally {
    await fx.server.stop();
  }
});

test('bounded sessions: beyond the cap, initialize is refused', async () => {
  const fx = await startFixture(fixtureMonitor(), { maxSessions: 1 });
  const client = await connectClient(fx.url, fx.token);
  try {
    assert.strictEqual(fx.server.sessions.size, 1);
    await assert.rejects(connectClient(fx.url, fx.token), /Too many sessions|503|Error POSTing/);
    assert.strictEqual(fx.server.sessions.size, 1);
    assert.strictEqual(fx.server.pending, 0, 'failed initialization releases its slot');
    // idle reaper frees capacity without client disconnects
    for (const s of fx.server.sessions.values()) s.lastTouched = 0;
    fx.server.reap();
    assert.strictEqual(fx.server.sessions.size, 0);
  } finally {
    await client.close();
    await fx.server.stop();
  }
});

test('session cap race: concurrent initializations cannot all pass the size check', async () => {
  const fx = await startFixture(fixtureMonitor(), { maxSessions: 1 });
  try {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
    const post = () => fetch(fx.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${fx.token}` },
      body: JSON.stringify(init),
    }).then(async (r) => { await r.text(); return r.status; });
    const statuses = await Promise.all([post(), post(), post(), post()]);
    assert.deepStrictEqual(statuses.filter((s) => s === 200).length, 1, 'exactly one initialization wins the slot');
    assert.deepStrictEqual(statuses.filter((s) => s === 503).length, 3);
    assert.strictEqual(fx.server.sessions.size, 1);
    assert.strictEqual(fx.server.pending, 0, 'all slots released after requests finish');
  } finally {
    await fx.server.stop();
  }
});

test('bind failure is graceful: no throw, sanitized status, stop safe', async () => {
  const blocker = require('node:http').createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const logs = [];
  const monitor = fixtureMonitor();
  const handle = await mcpLifecycle.start({ monitor, userData: tmpdir(), log: (m) => logs.push(m), port, host: '127.0.0.1', bonjourFactory: () => { throw new Error('must not advertise'); } });
  try {
    const status = handle.status();
    assert.strictEqual(status.listening, false);
    assert.ok(status.error, 'error recorded');
    assert.strictEqual(status.mdns, false, 'no phantom mDNS advertisement when the bind fails');
    assert.strictEqual(handle.endpoint(), null);
    assert.ok(!JSON.stringify({ status, logs }).includes('DECOY-SECRET'));
  } finally {
    await handle.stop();
    await new Promise((r) => blocker.close(r));
  }
});

test('shutdown cleanup: sessions and listener closed, port refuses connections', async () => {
  const fx = await startFixture(fixtureMonitor());
  const client = await connectClient(fx.url, fx.token);
  await client.callTool({ name: 'get_stats', arguments: {} });
  await fx.server.stop();
  assert.strictEqual(fx.server.sessions.size, 0);
  assert.strictEqual(fx.server.listening(), false);
  await assert.rejects(fetch(fx.url), /fetch failed|ECONNREFUSED/);
  await client.close().catch(() => {});
});

test('mDNS: advertises _sysmon._tcp and _mcp._tcp with endpoint metadata only, goodbye on stop', async () => {
  const published = [];
  let unpublished = false;
  let destroyed = false;
  const fakeBonjour = () => ({
    publish: (config) => { published.push(config); return { on: () => {} }; },
    unpublishAll: (cb) => { unpublished = true; cb(); },
    destroy: (cb) => { destroyed = true; cb(); },
  });
  const monitor = fixtureMonitor();
  const dir = tmpdir();
  const token = loadOrCreateToken(tokenFile(dir));
  const handle = await mcpLifecycle.start({ monitor, userData: dir, log: () => {}, port: 0, host: '127.0.0.1', bonjourFactory: fakeBonjour });
  try {
    assert.strictEqual(published.length, 2);
    const types = published.map((p) => p.type).sort();
    assert.deepStrictEqual(types, ['mcp', 'sysmon']);
    for (const p of published) {
      assert.ok(p.name.includes(os.hostname()), 'instance name carries the hostname: ' + p.name);
      assert.strictEqual(p.port, handle.server.port(), 'advertises the actual bound port');
      assert.strictEqual(p.protocol, 'tcp');
      assert.strictEqual(p.txt.path, '/mcp');
      assert.strictEqual(p.txt.transport, 'streamable-http');
      assert.strictEqual(p.txt.auth, 'bearer');
      assert.ok(p.txt.version);
      assert.ok(!JSON.stringify(p).includes(token), 'advertisement must never contain the token');
      assert.ok(!JSON.stringify(p).includes('42.4'), 'advertisement must never contain stats');
    }
    assert.strictEqual(handle.status().mdns, true);
    assert.match(handle.endpoint(), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.ok(!JSON.stringify(handle.status()).includes(token));
  } finally {
    await handle.stop();
  }
  assert.ok(unpublished, 'stop unpublishes (sends mDNS goodbyes)');
  assert.ok(destroyed);
  assert.strictEqual(handle.status().listening, false);
});

test('mDNS instance names are unique per machine to avoid LAN collisions', () => {
  const a = serviceConfigs(7738, 'dictator');
  const b = serviceConfigs(7738, 'minis');
  assert.ok(a.every((c) => c.name.includes('dictator')));
  assert.ok(b.every((c) => c.name.includes('minis')));
  const names = new Set([...a, ...b].map((c) => `${c.type}/${c.name}`));
  assert.strictEqual(names.size, 4, 'no shared instance name across machines');
});

test('mDNS publication failure is reported truthfully and partial publication is torn down', async () => {
  const handlers = [];
  let unpublished = false;
  let destroyed = false;
  const fakeBonjour = () => ({
    publish: () => ({ on: (ev, cb) => { if (ev === 'error') handlers.push(cb); } }),
    unpublishAll: (cb) => { unpublished = true; cb(); },
    destroy: (cb) => { destroyed = true; cb(); },
  });
  const logs = [];
  const handle = await mcpLifecycle.start({ monitor: fixtureMonitor(), userData: tmpdir(), log: (m) => logs.push(m), port: 0, host: '127.0.0.1', bonjourFactory: fakeBonjour });
  try {
    assert.strictEqual(handle.status().mdns, true, 'advertising before the failure');
    assert.strictEqual(handlers.length, 2, 'error handler attached to every published service');
    handlers[0](new Error('probe conflict')); // asynchronous publication failure
    await new Promise((r) => setImmediate(r));
    const status = handle.status();
    assert.strictEqual(status.mdns, false, 'status reports the failure honestly');
    assert.match(status.mdnsError, /probe conflict/);
    assert.ok(unpublished, 'partial publication is unpublished');
    assert.ok(destroyed, 'bonjour instance destroyed');
    assert.ok(logs.some((l) => l.includes('mDNS advertisement unavailable')), 'failure is logged (sanitized)');
  } finally {
    await handle.stop();
  }
});

test('mDNS synchronous publish throw also fails truthfully', () => {
  const logs = [];
  const advertiser = new MdnsAdvertiser({ log: (m) => logs.push(m), bonjourFactory: () => ({ publish: () => { throw new Error('no multicast'); } }) });
  advertiser.start({ port: 7738 });
  assert.strictEqual(advertiser.active(), false);
  assert.strictEqual(advertiser.error, 'no multicast');
  assert.ok(logs.some((l) => l.includes('no multicast')));
});

test('mDNS service types render as _sysmon._tcp / _mcp._tcp per DNS-SD', () => {
  const configs = serviceConfigs(7738);
  assert.deepStrictEqual(configs.map((c) => c.type).sort(), ['mcp', 'sysmon']);
  // bonjour-service turns {name, protocol} into _name._protocol; verify with its own helper
  const { toString } = require('bonjour-service/dist/lib/service-types.js');
  assert.strictEqual(toString({ name: 'sysmon', protocol: 'tcp' }), '_sysmon._tcp');
  assert.strictEqual(toString({ name: 'mcp', protocol: 'tcp' }), '_mcp._tcp');
});

test('stdio adapter: full lifecycle in every launch mode (direct, RunAsNode dispatch, packaged)', async (t) => {
  const monitor = fixtureMonitor();
  const dir = tmpdir();
  const token = loadOrCreateToken(tokenFile(dir));
  const handle = await mcpLifecycle.start({ monitor, userData: dir, log: () => {}, port: 0, host: '127.0.0.1', mdns: false });
  const url = `http://127.0.0.1:${handle.server.port()}/mcp`;
  try {
    const env = { ...process.env, SYSMON_MCP_URL: url, SYSMON_USERDATA: dir };
    for (const [mode, params] of adapterTransports(env)) {
      await t.test(mode, { timeout: 60000 }, async () => {
        const transport = new StdioClientTransport({ ...params, stderr: 'pipe' });
        const client = new Client({ name: 'stdio-test-client', version: '0.0.1' });
        // Bounded connect: a launch mode whose stdio never answers (e.g. the
        // bare GUI-subsystem exe on Windows) must fail this subtest, not hang
        // the whole suite; the child is always terminated in finally.
        let connectTimer;
        try {
          await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => {
              connectTimer = setTimeout(() => reject(new Error(`adapter connect timed out after 30s (${mode})`)), 30000);
            }),
          ]);
          const { tools } = await client.listTools();
          assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['get_accounts', 'get_ci', 'get_machines', 'get_stats']);
          const stats = await client.callTool({ name: 'get_stats', arguments: {} });
          assert.deepStrictEqual(stats.structuredContent, expectedSnapshot(monitor));
          for (const uri of ['sysmon://snapshot', 'sysmon://machines', 'sysmon://accounts', 'sysmon://ci', 'sysmon://machines/dictator', 'sysmon://accounts/grok']) {
            const read = await client.readResource({ uri });
            assert.ok(read.contents[0].text.length > 2, `${uri} readable through ${mode}`);
          }
          const pid = transport.pid;
          assert.ok(pid, 'adapter process spawned');
          await client.close();
          // The adapter must exit once the client's stdio pipe closes.
          const deadline = Date.now() + 8000;
          let alive = true;
          while (Date.now() < deadline) {
            try { process.kill(pid, 0); } catch { alive = false; break; }
            await new Promise((r) => setTimeout(r, 50));
          }
          assert.ok(!alive, `adapter exits when the client disconnects (${mode})`);
        } finally {
          clearTimeout(connectTimer);
          await client.close().catch(() => {});
          await transport.close().catch(() => {});
          const pid = transport.pid;
          if (pid) { try { process.kill(pid); } catch {} }
        }
      });
    }
  } finally {
    await handle.stop();
  }
});

test('stdio adapter exits cleanly with a sanitized error when the app is not running', async () => {
  const dir = tmpdir();
  loadOrCreateToken(tokenFile(dir));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ADAPTER],
    env: { ...process.env, SYSMON_MCP_URL: 'http://127.0.0.1:9/mcp', SYSMON_USERDATA: dir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test-client', version: '0.0.1' });
  await assert.rejects(client.connect(transport));
  let err = '';
  transport.stderr?.on('data', (d) => { err += d; });
  await new Promise((r) => setTimeout(r, 300));
  const token = readToken(tokenFile(dir));
  assert.ok(!err.includes(token), 'adapter stderr must never contain the token');
  await transport.close().catch(() => {});
});

test('production deps present for packaged builds', () => {
  const pkg = require('../package.json');
  for (const dep of ['@modelcontextprotocol/sdk', 'bonjour-service', 'zod']) {
    assert.ok(pkg.dependencies?.[dep], `${dep} must be a production dependency for asar packaging`);
  }
  assert.ok(pkg.build.files.includes('app/**/*'), 'electron-builder ships app/mcp in the package');
});
