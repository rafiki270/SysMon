'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const ws = require('../daemon/ws.cjs');
const { HostLink, probePort, DAEMON_PORT } = require('../app/link.cjs');
const { detectLocalId, remoteCommand } = require('../app/monitor.cjs');

test('detectLocalId selects the right host on each platform', () => {
  assert.strictEqual(detectLocalId({ platform: 'win32', hostname: 'DESKTOP-XYZ' }), 'minis');
  assert.strictEqual(detectLocalId({ platform: 'darwin', hostname: 'dictator.local' }), 'dictator');
  assert.strictEqual(detectLocalId({ platform: 'linux', hostname: 'umac' }), 'umac');
  assert.strictEqual(detectLocalId({ platform: 'linux', hostname: 'minis' }), 'minis'); // hostname wins
  assert.strictEqual(detectLocalId({ platform: 'freebsd', hostname: 'elsewhere' }), null);
});

test('remoteCommand is shell-appropriate per host OS', () => {
  assert.strictEqual(remoteCommand({ os: 'WINDOWS' }, 'machine'), 'node - machine'); // PowerShell, system Node
  assert.match(remoteCommand({ os: 'MAC' }, 'accounts'), /^export PATH=.*node - accounts$/);
  assert.match(remoteCommand({ os: 'LINUX' }, 'accounts'), /^export PATH=.*node - accounts$/);
});

test('ws server rejects browser Origin upgrades', async () => {
  const server = http.createServer();
  ws.attachServer(server, () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await assert.rejects(ws.connect({ port, headers: { Origin: 'https://evil.example' } }), /upgrade refused|closed|Error/);
  const ok = await ws.connect({ port });
  ok.close();
  server.close();
});

test('HostLink goes offline when no ssh identity exists, never stuck connecting', async () => {
  const link = new HostLink({ id: 'ghost', ssh: null, fallback: null }, { localPort: 17490, sshCollect: async () => { throw new Error('nope'); } });
  const statuses = [];
  link.on('status', (s) => statuses.push(s));
  link.start();
  await new Promise((r) => setTimeout(r, 100));
  // failures=3 needed; speed up by directly invoking attempts
  await link.attempt(); await link.attempt();
  await new Promise((r) => setTimeout(r, 50));
  link.stop();
  assert.ok(statuses.includes('offline'), `saw ${statuses.join(',')}`);
  assert.strictEqual(link.retryTimer === null || link.stopped, true);
});

test('HostLink refuses a local port already owned by someone else', async () => {
  const squat = net.createServer();
  await new Promise((r) => squat.listen(17491, '127.0.0.1', r));
  const link = new HostLink({ id: 'x', ssh: 'nobody@nowhere.invalid', fallback: null }, { localPort: 17491, sshCollect: async () => ({}) });
  await assert.rejects(link.openTunnel(), /busy/);
  link.stop();
  squat.close();
});

test('stop() during a pending tunnel attempt kills children and leaves no timers', async () => {
  const link = new HostLink({ id: 'x', ssh: 'nobody@192.0.2.1', fallback: null }, { localPort: 17492, sshCollect: async () => ({}) });
  const p = link.openTunnel().catch(() => {});
  link.stop();
  await p;
  assert.strictEqual(link.tunnel, null);
  assert.strictEqual(link.pendingTunnel, null);
});

test('probePort reports open/closed truthfully', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(17493, '127.0.0.1', r));
  assert.strictEqual(await probePort(17493), true);
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(await probePort(17493, '127.0.0.1', 300), false);
});
