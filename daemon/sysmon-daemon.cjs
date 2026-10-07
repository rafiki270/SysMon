#!/usr/bin/env node
// SysMon telemetry daemon for macOS and Linux. Dependency-free Node.js.
// Samples real CPU/GPU/memory/disk/uptime/top-process every ~2.5 s, keeps a 60 s
// CPU/GPU history, and pushes JSON snapshots to WebSocket clients on 127.0.0.1.
// The port is loopback-only by design: reach it through an SSH tunnel.
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { attachServer } = require('./ws.cjs');

const PORT = Number(process.env.SYSMON_DAEMON_PORT) || 7737;
// Loopback only, always: the port must never be reachable from the LAN,
// regardless of environment overrides. Access goes through an SSH tunnel.
const HOST = '127.0.0.1';
const INTERVAL = Math.max(1000, Number(process.env.SYSMON_DAEMON_INTERVAL) || 2500);
const HISTORY_MS = 60000;

function cpuTimes() {
  return os.cpus().reduce((a, c) => {
    a.idle += c.times.idle;
    a.total += Object.values(c.times).reduce((x, y) => x + y, 0);
    return a;
  }, { idle: 0, total: 0 });
}

function memory() {
  const total = os.totalmem();
  if (process.platform === 'linux') {
    try {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const available = Number(info.match(/MemAvailable:\s+(\d+)/)?.[1]);
      if (available) return { total, used: total - available * 1024 };
    } catch {}
  }
  return { total, used: total - os.freemem() };
}

function darwinMemory() {
  return new Promise((resolve) => {
    execFile('/usr/bin/vm_stat', [], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(memory());
      const page = Number(stdout.match(/page size of (\d+)/)?.[1] || 16384);
      const pages = (label) => Number(stdout.match(new RegExp(label + ':\\s+(\\d+)'))?.[1] || 0);
      const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
      resolve({ total: os.totalmem(), used });
    });
  });
}

function topProcess() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pcpu=,comm='], { timeout: 5000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) return resolve({ topProc: null, topPct: null });
      const procs = stdout.split('\n')
        .map((x) => x.trim().match(/^([\d.]+)\s+(.+)$/))
        .filter(Boolean)
        .sort((x, y) => Number(y[1]) - Number(x[1]));
      resolve(procs[0] ? { topProc: path.basename(procs[0][2]), topPct: Number(procs[0][1]) } : { topProc: null, topPct: null });
    });
  });
}

const pctOrNull = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);
const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
});

// GPU utilization without elevated rights; anything unreadable stays null.
// nvidia-smi rows "util, MiB used, MiB total": busiest GPU, VRAM summed, in GiB.
function parseNvidia(out) {
  const rows = String(out || '').split('\n').map((l) => l.split(',').map((x) => Number(x.trim())))
    .filter((r) => r.length === 3 && r.every(Number.isFinite) && r[2] > 0);
  if (!rows.length) return null;
  const used = rows.reduce((s, r) => s + r[1], 0);
  const total = rows.reduce((s, r) => s + r[2], 0);
  return { gpu: pctOrNull(Math.max(...rows.map((r) => r[0]))), vram: pctOrNull(100 * used / total), vramUsed: used / 1024, vramTotal: total / 1024 };
}

// macOS: IOAccelerator PerformanceStatistics, busiest accelerator.
function parseIoreg(out) {
  const v = [...String(out || '').matchAll(/"Device Utilization %"=(\d+)/g)].map((m) => Number(m[1]));
  return v.length ? pctOrNull(Math.max(...v)) : null;
}

function drmCards() {
  try { return fs.readdirSync('/sys/class/drm').filter((x) => /^card\d+$/.test(x)); } catch { return []; }
}

// Intel on Linux: share of time the GPU spent out of its RC6 idle state.
function rc6Snapshot() {
  for (const d of drmCards()) {
    for (const p of [`/sys/class/drm/${d}/gt/gt0/rc6_residency_ms`, `/sys/class/drm/${d}/power/rc6_residency_ms`]) {
      try { const ms = Number(fs.readFileSync(p, 'utf8')); if (Number.isFinite(ms)) return { at: Date.now(), ms }; } catch {}
    }
  }
  return null;
}

function rc6Busy(a, b) {
  return a && b && b.at > a.at ? pctOrNull(100 * (1 - (b.ms - a.ms) / (b.at - a.at))) : null;
}

// AMD on Linux reports utilization directly.
function sysfsBusy() {
  for (const d of drmCards()) {
    try { const v = Number(fs.readFileSync(`/sys/class/drm/${d}/device/gpu_busy_percent`, 'utf8')); if (Number.isFinite(v)) return pctOrNull(v); } catch {}
  }
  return null;
}

function disk() {
  try {
    const s = fs.statfsSync('/');
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { total, free };
  } catch { return { total: null, free: null }; }
}

class Daemon {
  constructor({ interval = INTERVAL, historyMs = HISTORY_MS } = {}) {
    this.interval = interval;
    this.historyMs = historyMs;
    this.clients = new Set();
    this.history = [];
    this.prevCpu = cpuTimes();
    this.prevRc6 = process.platform === 'linux' ? rc6Snapshot() : null;
    this.hasNvidia = true; // cleared after the first failed probe
    this.timer = null;
    this.stopped = false;
    this.last = null;
  }
  async gpu() {
    const none = { gpu: null, vram: null, vramUsed: null, vramTotal: null };
    if (this.hasNvidia) {
      const n = parseNvidia(await run('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits']));
      if (n) return n;
      this.hasNvidia = false;
    }
    if (process.platform === 'darwin') return { ...none, gpu: parseIoreg(await run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'])) };
    const rc6 = rc6Snapshot();
    const busy = sysfsBusy() ?? rc6Busy(this.prevRc6, rc6);
    this.prevRc6 = rc6;
    return { ...none, gpu: busy };
  }
  async sample() {
    const now = Date.now();
    const times = cpuTimes();
    const cpu = times.total > this.prevCpu.total
      ? Math.max(0, Math.min(100, 100 * (1 - (times.idle - this.prevCpu.idle) / (times.total - this.prevCpu.total))))
      : null;
    this.prevCpu = times;
    const mem = process.platform === 'darwin' ? await darwinMemory() : memory();
    const d = disk();
    const top = await topProcess();
    const g = await this.gpu();
    this.history.push({ at: now, cpu, gpu: g.gpu });
    this.history = this.history.filter((x) => x.at > now - this.historyMs);
    this.last = {
      type: 'metrics',
      hostname: os.hostname(),
      os: process.platform === 'darwin' ? 'MAC' : 'LINUX',
      cores: os.cpus().length,
      cpu,
      gpu: g.gpu,
      vram: g.vram,
      vramUsed: g.vramUsed,
      vramTotal: g.vramTotal,
      mem: mem.total ? 100 * mem.used / mem.total : null,
      memUsed: mem.used / 1e9,
      memTotal: mem.total / 1e9,
      disk: d.total ? 100 * (d.total - d.free) / d.total : null,
      diskFree: d.free == null ? null : d.free / 1e9,
      uptime: os.uptime(),
      load: os.loadavg()[0],
      topProc: top.topProc,
      topPct: top.topPct,
      history: this.history.slice(),
      sampledAt: now,
    };
    return this.last;
  }
  broadcast() {
    if (!this.last) return;
    const text = JSON.stringify(this.last);
    for (const c of this.clients) c.send(text);
  }
  tick = async () => {
    if (this.stopped) return;
    try { await this.sample(); this.broadcast(); } catch {}
    if (!this.stopped) this.timer = setTimeout(this.tick, this.interval);
  };
  start() {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, sampledAt: this.last?.sampledAt ?? null })); return; }
      res.writeHead(404); res.end();
    });
    attachServer(server, (conn) => {
      this.clients.add(conn);
      if (this.last) conn.send(JSON.stringify(this.last));
      conn.on('close', () => this.clients.delete(conn));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, () => resolve(server.address()));
    }).then((addr) => { this.tick(); return addr; });
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const c of this.clients) c.close();
    this.server?.close();
  }
}

if (require.main === module) {
  const daemon = new Daemon();
  daemon.start().then((addr) => {
    process.stdout.write(`sysmon-daemon listening on ${addr.address}:${addr.port} (loopback only)\n`);
  }).catch((e) => { process.stderr.write(`sysmon-daemon failed: ${e.message}\n`); process.exit(1); });
  const shutdown = () => { daemon.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { Daemon, cpuTimes, memory, disk, parseNvidia, parseIoreg, rc6Busy };
