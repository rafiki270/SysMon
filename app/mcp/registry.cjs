// Defines the read-only MCP surface (tools + resources) over the app's live
// Monitor state. Every handler reads the exact shared Monitor.state the tray
// app renders — there is no second polling path and no cached copy. There are
// no mutation tools: no auth control, no browser opening, no inference.
'use strict';
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');

const VERSION = require('../../package.json').version;

// Defense in depth: Monitor.state never contains credentials (provider
// cookies/tokens live in the Electron session, never in state), but strip any
// sensitively-named key anyway so a future field can never leak by accident.
const SENSITIVE_KEY = /token|secret|password|credential|cookie|session|api[-_]?key|authorization/i;
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) if (!SENSITIVE_KEY.test(key)) out[key] = sanitize(v);
    return out;
  }
  return value;
}

const snapshot = (monitor) => sanitize(JSON.parse(JSON.stringify(monitor.state)));

const json = (data) => JSON.stringify(data, null, 2);
const toolResult = (data) => ({
  content: [{ type: 'text', text: json(data) }],
  structuredContent: Array.isArray(data) ? { items: data } : data,
});
const resourceResult = (uri, data) => ({ contents: [{ uri, mimeType: 'application/json', text: json(data) }] });

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Builds a fresh McpServer bound to the given Monitor. A new instance per
// session keeps per-connection state isolated; all of them read the same
// live Monitor.state object.
function createMcpServer(monitor) {
  const server = new McpServer(
    { name: 'sysmon', version: VERSION },
    { instructions: 'Read-only SysMon operations monitor: machine telemetry (CPU/GPU/VRAM/memory/disk/uptime/top process/history), subscription account quota windows (used/limit as percent and GB, resets, sampled/last-success times, live/stale/offline/auth state), and failing CI pull requests. All values are the app\'s own shared state; nothing is re-polled or fabricated.' },
  );

  server.registerTool('get_stats', {
    title: 'Full monitor snapshot',
    description: 'Complete SysMon state: every machine (all metrics and CPU/GPU history), every account quota window with resets and staleness, CI results, and updatedAt. Read-only.',
    annotations: READ_ONLY,
  }, async () => toolResult(snapshot(monitor)));

  server.registerTool('get_machines', {
    title: 'Machine telemetry',
    description: 'Per-machine telemetry: status (live/stale/offline/connecting), cpu/gpu/mem/disk raw percentages, VRAM where reported, memory/disk GB, uptime, top process, 60s CPU history, sampled/last-success times, source. Optionally filter by machine id.',
    inputSchema: { id: z.string().optional().describe('Machine id, e.g. "minis", "dictator", "umac", "maxis". Omit for all machines.') },
    annotations: READ_ONLY,
  }, async ({ id } = {}) => {
    const machines = snapshot(monitor).machines;
    return toolResult(id ? machines.filter((m) => m.id === id) : machines);
  });

  server.registerTool('get_accounts', {
    title: 'Account quota windows',
    description: 'Subscription account readings: every quota window (used/limit as raw percent or GB, window label, reset time), status (live/stale/unavailable/auth/connecting), sampledAt/lastSuccessAt, host and vendor. Filter by id, host, or vendor.',
    inputSchema: {
      id: z.string().optional().describe('Account id, e.g. "dictator-Codex".'),
      host: z.string().optional().describe('Host the account is read from, e.g. "minis".'),
      vendor: z.string().optional().describe('Vendor name, e.g. "Codex", "Claude", "Kimi", "Grok".'),
    },
    annotations: READ_ONLY,
  }, async ({ id, host, vendor } = {}) => {
    let accounts = snapshot(monitor).accounts;
    if (id) accounts = accounts.filter((a) => a.id === id);
    if (host) accounts = accounts.filter((a) => a.host === host);
    if (vendor) accounts = accounts.filter((a) => a.vendor.toLowerCase() === vendor.toLowerCase());
    return toolResult(accounts);
  });

  server.registerTool('get_ci', {
    title: 'Failing CI pull requests',
    description: 'CI status: open pull requests with failing checks (repo, number, url, title), scope, sampledAt, truncation flag, and live/stale/unavailable state. Read-only.',
    annotations: READ_ONLY,
  }, async () => toolResult(snapshot(monitor).ci));

  server.registerResource('snapshot', 'sysmon://snapshot', {
    title: 'Full monitor snapshot',
    description: 'The complete live SysMon state as JSON (machines, accounts, CI, updatedAt).',
    mimeType: 'application/json',
  }, async (uri) => resourceResult(uri.href, snapshot(monitor)));

  server.registerResource('machines', 'sysmon://machines', {
    title: 'All machines',
    description: 'Telemetry for every monitored machine, including CPU/GPU history and staleness.',
    mimeType: 'application/json',
  }, async (uri) => resourceResult(uri.href, snapshot(monitor).machines));

  server.registerResource('machine', new ResourceTemplate('sysmon://machines/{id}', {
    list: async () => ({
      resources: snapshot(monitor).machines.map((m) => ({ uri: `sysmon://machines/${m.id}`, name: m.id, title: `${m.name} (${m.os})`, mimeType: 'application/json' })),
    }),
  }), {
    title: 'One machine',
    description: 'Full telemetry for a single machine by id.',
    mimeType: 'application/json',
  }, async (uri, { id }) => {
    const machine = snapshot(monitor).machines.find((m) => m.id === id);
    if (!machine) throw new Error(`Unknown machine id: ${id}`);
    return resourceResult(uri.href, machine);
  });

  server.registerResource('accounts', 'sysmon://accounts', {
    title: 'All accounts',
    description: 'Every subscription account card with all quota windows, resets, and staleness.',
    mimeType: 'application/json',
  }, async (uri) => resourceResult(uri.href, snapshot(monitor).accounts));

  server.registerResource('account', new ResourceTemplate('sysmon://accounts/{id}', {
    list: async () => ({
      resources: snapshot(monitor).accounts.map((a) => ({ uri: `sysmon://accounts/${a.id}`, name: a.id, title: `${a.vendor} @ ${a.host}`, mimeType: 'application/json' })),
    }),
  }), {
    title: 'One account',
    description: 'All quota windows and state for a single account by id.',
    mimeType: 'application/json',
  }, async (uri, { id }) => {
    const account = snapshot(monitor).accounts.find((a) => a.id === id);
    if (!account) throw new Error(`Unknown account id: ${id}`);
    return resourceResult(uri.href, account);
  });

  server.registerResource('ci', 'sysmon://ci', {
    title: 'CI results',
    description: 'Open pull requests with failing checks and CI sampling state.',
    mimeType: 'application/json',
  }, async (uri) => resourceResult(uri.href, snapshot(monitor).ci));

  return server;
}

module.exports = { createMcpServer, sanitize, VERSION };
