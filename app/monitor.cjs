// Aggregates machine telemetry (daemon-over-SSH-tunnel, local collector),
// account rate-limit readings (SSH stdin collector / local), and failing CI
// into one published state. Never fabricates values: failed reads preserve the
// last valid reading and mark it stale; hosts never reached stay offline.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const EventEmitter = require('node:events');
const collector = require('./collector.cjs');
const { HostLink } = require('./link.cjs');

const hosts = [
  { id: 'minis', name: 'Minis', os: 'WINDOWS', address: '192.168.1.215', ssh: 'ondre@Minis.local', fallback: 'ondre@192.168.1.215', localPort: 17378 },
  { id: 'dictator', name: 'dictator', os: 'MAC', address: '192.168.1.229', ssh: 'dictator@dictator.local', fallback: 'dictator@192.168.1.229', localPort: 17379 },
  { id: 'umac', name: 'umac', os: 'LINUX', address: '192.168.1.192', ssh: 'umac@umac.local', fallback: 'umac@192.168.1.192', localPort: 17380 },
];
const STALE_AFTER_MS = 12000;
const source = fs.readFileSync(path.join(__dirname, 'collector.cjs'), 'utf8');

// The app can run on any of the three machines: decide which host is local by
// hostname first, then by platform, instead of assuming Windows.
function detectLocalId({ platform = os.platform(), hostname = os.hostname() } = {}) {
  const hn = String(hostname).toLowerCase().replace(/\.(local|lan)$/, '');
  const byName = hosts.find(h => h.id === hn || h.name.toLowerCase() === hn);
  if (byName) return byName.id;
  return { win32: 'minis', darwin: 'dictator', linux: 'umac' }[platform] || null;
}

// Remote shells differ: Minis runs PowerShell (system Node is on PATH), while
// macOS/Linux need the user's local Node prepended to PATH first.
function remoteCommand(host, mode) {
  if (host.os === 'WINDOWS') return `node - ${mode}`;
  return "export PATH=\"$HOME/.local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; node - " + mode;
}

function sshCollect(host, mode, target = host.ssh) {
  return new Promise((resolve, reject) => {
    // Source is sent over encrypted stdin. No remote installation or credentials copy.
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-o', 'StrictHostKeyChecking=accept-new', target, remoteCommand(host, mode)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', done = false;
    const timer = setTimeout(() => finish(new Error('timeout')), 45000);
    function finish(e, v) { if (done) return; done = true; clearTimeout(timer); p.kill(); e ? reject(e) : resolve(v); }
    p.on('error', e => finish(e));
    p.stdin.on('error', () => {});
    p.stderr.resume();
    p.stdout.on('data', d => { output += d.toString(); if (output.length > 2e6) finish(new Error('oversized')); });
    p.on('close', code => { if (code !== 0) return finish(new Error('offline')); try { finish(null, JSON.parse(output.trim())); } catch { finish(new Error('invalid collector response')); } });
    // node-stdin sets require.main!==module, so invoke the runner explicitly.
    p.stdin.end(source + '\n;module.exports.run(' + JSON.stringify(mode) + ').then(x=>process.stdout.write(JSON.stringify(x)+"\\n")).catch(()=>{process.stdout.write(JSON.stringify({status:"unavailable"})+"\\n");process.exitCode=1;});');
  }).catch(e => { if (target === host.ssh && host.fallback) return sshCollect(host, mode, host.fallback); throw e; });
}

function reconcileAccount(old, reading) {
  const sampledAt = reading.sampledAt || old?.sampledAt || null;
  if (reading.status === 'live') return { ...reading, sampledAt, lastSuccessAt: sampledAt };
  return { ...reading, sampledAt, lastSuccessAt: old?.lastSuccessAt || null, windows: old?.windows?.length ? old.windows : reading.windows || [], status: old?.windows?.length ? 'stale' : reading.status };
}

class Monitor extends EventEmitter {
  constructor({ log = () => {}, inject, readAccounts } = {}) {
    super();
    this.log = log;
    this.inject = inject; // test hook: {machines, accounts, ci} applied in start()
    this.readAccounts = readAccounts || null; // test hook: replaces local/ssh reads
    this.localId = detectLocalId();
    this.state = {
      machines: hosts.map(h => ({ ...h, local: h.id === this.localId, status: 'connecting', sampledAt: null, history: [] })),
      accounts: [
        ...['minis', 'dictator'].flatMap(host => ['Codex', 'Claude'].map(vendor => ({ id: `${host}-${vendor}`, host, vendor, status: 'connecting', windows: [] }))),
        { id: 'dictator-Kimi', host: 'dictator', vendor: 'Kimi', status: 'connecting', windows: [] },
        { id: 'grok', host: 'web', vendor: 'Grok', status: 'auth', message: 'Connect Grok', windows: [] },
      ],
      ci: { status: 'connecting', jobs: [], sampledAt: null },
      updatedAt: null,
    };
    this.stopped = false;
    this.timers = new Set();
    this.accountNext = {};
    this.accountTimers = new Map(); // host.id -> the single pending chain wake-up
    this.accountBusy = new Set(); // host.id with a read in flight
    this.links = [];
  }
  later(fn, ms) {
    if (this.stopped) return null;
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }
  publish() { this.state.updatedAt = Date.now(); this.emit('update', this.state); }
  machine(id) { return this.state.machines.find(m => m.id === id); }
  applyMetrics(host, reading) {
    const m = this.machine(host.id);
    const { type, source: via, history, ...fields } = reading;
    Object.assign(m, fields, { status: 'live', source: via, lastSuccessAt: fields.sampledAt || Date.now() });
    if (Array.isArray(history) && history.length) m.history = history.filter(x => x && Number.isFinite(x.cpu));
    else if (Number.isFinite(m.cpu)) m.history = [...m.history.filter(x => x.at > Date.now() - 60000), { at: m.sampledAt, cpu: m.cpu }];
    this.publish();
  }
  degrade(host, status) {
    const m = this.machine(host.id);
    // Preserve the last valid reading as stale; only never-reached hosts are offline.
    m.status = m.sampledAt ? 'stale' : (status === 'connecting' ? 'connecting' : 'offline');
    this.publish();
  }
  async localMachine(host) {
    if (this.stopped) return;
    try { const r = await collector.machine(); this.applyMetrics(host, { ...r, source: 'local' }); }
    catch { this.degrade(host, 'offline'); }
    this.later(() => this.localMachine(host), 2500);
  }
  startHost(host) {
    if (host.id === this.localId) { this.localMachine(host); return; }
    const link = new HostLink(host, { localPort: host.localPort, sshCollect, log: this.log });
    link.on('metrics', r => this.applyMetrics(host, r));
    link.on('status', s => { if (s !== 'live') this.degrade(host, s); });
    this.links.push(link);
    link.start();
  }
  // Exactly one pending wake-up per host: the chain self-polls every 5s and
  // re-checks the deadline, so refresh requests never add parallel chains.
  scheduleAccounts(host, ms = 5000) {
    if (this.stopped || this.accountTimers.has(host.id)) return;
    const t = this.later(() => { this.accountTimers.delete(host.id); this.accounts(host); }, ms);
    if (t) this.accountTimers.set(host.id, t);
  }
  async accounts(host) {
    if (this.stopped) return;
    if (this.accountBusy.has(host.id)) { this.scheduleAccounts(host); return; }
    if ((this.accountNext[host.id] || 0) > Date.now()) { this.scheduleAccounts(host); return; }
    this.accountBusy.add(host.id);
    // Consume any refresh marker up front: this read IS the requested
    // refresh. Only a refresh requested DURING the await below queues
    // another read; otherwise the deadline advances to the normal interval.
    this.accountNext[host.id] = -1; // read in flight
    try {
      const result = this.readAccounts ? await this.readAccounts(host) : (host.id === this.localId ? await collector.accounts() : await sshCollect(host, 'accounts'));
      for (const r of result) {
        const i = this.state.accounts.findIndex(a => a.host === host.id && a.vendor === r.vendor);
        if (i >= 0) this.state.accounts[i] = { ...this.state.accounts[i], ...reconcileAccount(this.state.accounts[i], r) };
      }
      const retry = Math.max(0, ...result.map(r => r.retryAfter || 0));
      // 0 here means a refresh arrived during the read: keep it so exactly
      // one extra read runs, which then advances the deadline normally.
      if (this.accountNext[host.id] !== 0) this.accountNext[host.id] = Date.now() + Math.max(120, retry) * 1000;
    } catch {
      if (this.accountNext[host.id] !== 0) this.accountNext[host.id] = Date.now() + 120000;
      this.state.accounts = this.state.accounts.map(a => a.host === host.id ? { ...a, status: a.windows.length ? 'stale' : 'unavailable', message: 'Host unavailable' } : a);
    }
    this.accountBusy.delete(host.id);
    this.publish();
    if (this.accountNext[host.id] === 0) {
      // Service the queued refresh promptly: replace any pending wake-up
      // with an immediate one (still exactly one pending timer per host).
      const pending = this.accountTimers.get(host.id);
      if (pending) { clearTimeout(pending); this.timers.delete(pending); this.accountTimers.delete(host.id); }
      this.scheduleAccounts(host, 0);
    } else {
      this.scheduleAccounts(host);
    }
  }
  // Re-read one host's accounts now (e.g. right after a CLI sign-in finished)
  // instead of waiting for the next scheduled poll. Resets the deadline and
  // nudges the single existing chain — never starts a parallel one.
  refreshAccounts(hostId) {
    if (this.stopped || !this.started) return;
    const host = hosts.find(h => h.id === hostId);
    if (!host || host.id === 'umac') return; // umac has no account cards
    this.accountNext[host.id] = 0;
    const pending = this.accountTimers.get(host.id);
    if (pending) { clearTimeout(pending); this.timers.delete(pending); this.accountTimers.delete(host.id); }
    this.scheduleAccounts(host, 0);
  }
  async ci() {
    if (this.stopped) return;
    try {
      const { stdout } = await promisify(execFile)('gh', ['api', '/search/issues?q=is:pr+is:open+author:@me+status:failure&per_page=50'], { timeout: 20000, windowsHide: true, maxBuffer: 2e6 });
      const result = JSON.parse(stdout);
      this.state.ci = { status: 'live', sampledAt: Date.now(), scope: 'Open PRs authored by you with failing checks', jobs: result.items.map(i => ({ repo: i.repository_url.split('/').slice(-2).join('/'), number: i.number, url: i.html_url, title: i.title })), truncated: result.total_count > result.items.length };
    } catch {
      this.state.ci = { ...this.state.ci, status: this.state.ci.sampledAt ? 'stale' : 'unavailable', message: 'GitHub CLI unavailable or not signed in' };
    }
    this.publish();
    this.later(() => this.ci(), 60000);
  }
  watchdog() {
    if (this.stopped) return;
    const now = Date.now();
    for (const m of this.state.machines) {
      if (m.status === 'live' && m.sampledAt && now - m.sampledAt > STALE_AFTER_MS) { m.status = 'stale'; this.publish(); }
    }
    this.later(() => this.watchdog(), 4000);
  }
  setGrok(r) {
    const i = this.state.accounts.findIndex(a => a.id === 'grok');
    this.state.accounts[i] = { ...this.state.accounts[i], ...reconcileAccount(this.state.accounts[i], r) };
    this.publish();
  }
  start() {
    this.started = true;
    hosts.forEach(h => this.startHost(h));
    hosts.filter(h => h.id !== 'umac').forEach(h => this.accounts(h)); // Ubuntu shares a subscription; no duplicate account cards.
    this.ci();
    this.watchdog();
  }
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.accountTimers.clear();
    this.links.forEach(l => l.stop());
    this.links = [];
  }
}
module.exports = { Monitor, hosts, sshCollect, reconcileAccount, detectLocalId, remoteCommand, STALE_AFTER_MS };
