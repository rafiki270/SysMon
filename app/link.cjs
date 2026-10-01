// HostLink: streams machine telemetry from a remote sysmon-daemon through an
// SSH local port-forward (loopback on both ends, no LAN exposure). Falls back
// to the legacy SSH stdin collector when the daemon is not installed yet.
'use strict';
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const ws = require('../daemon/ws.cjs');

const DAEMON_PORT = 7737;

function probePort(port, host = '127.0.0.1', timeout = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeout);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

class HostLink extends EventEmitter {
  // host: {id, ssh, fallback}; opts: {localPort, sshCollect(mode)->Promise, log}
  constructor(host, { localPort, sshCollect, log = () => {} } = {}) {
    super();
    this.host = host;
    this.localPort = localPort;
    this.sshCollect = sshCollect;
    this.log = log;
    this.stopped = false;
    this.attempting = false;
    this.mode = null; // 'daemon' | 'collector'
    this.conn = null;
    this.tunnel = null;
    this.retryTimer = null;
    this.collectorTimer = null;
    this.daemonFailures = 0;
  }
  start() { this.schedule(0); }
  schedule(delay) {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.attempt(), delay);
  }
  async attempt() {
    if (this.stopped || this.attempting) return;
    this.attempting = true;
    try {
      await this.connectDaemon();
    } catch (e) {
      this.log(`${this.host.id}: daemon path failed (${e.message})`);
      if (this.daemonFailures >= 2) {
        // Daemon probably not installed; degrade to SSH collector polling.
        try { await this.connectCollector(); } catch (e2) {
          this.log(`${this.host.id}: collector path failed (${e2.message})`);
          this.emit('status', 'offline');
          this.schedule(15000);
        }
      } else {
        this.emit('status', this.daemonFailures ? 'connecting' : 'connecting');
        this.schedule(5000);
      }
    } finally {
      this.attempting = false;
    }
  }
  sshArgs(target) {
    return ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6',
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-L', `127.0.0.1:${this.localPort}:127.0.0.1:${DAEMON_PORT}`, target];
  }
  async openTunnel() {
    const targets = [this.host.ssh, this.host.fallback].filter(Boolean);
    let lastErr = new Error('no ssh target');
    for (const target of targets) {
      const tunnel = spawn('ssh', this.sshArgs(target), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      tunnel.stderr.resume();
      const opened = await new Promise((resolve) => {
        let done = false;
        const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
        tunnel.on('error', () => finish(false));
        tunnel.on('exit', () => finish(false));
        let waited = 0;
        const poll = async () => {
          if (done) return;
          if (await probePort(this.localPort)) return finish(true);
          waited += 300;
          if (waited > 8000) return finish(false);
          setTimeout(poll, 300);
        };
        poll();
      });
      if (opened) { this.tunnel = tunnel; tunnel.on('exit', () => this.handleDrop('tunnel exited')); return; }
      tunnel.kill();
      lastErr = new Error(`ssh tunnel failed for ${target}`);
    }
    throw lastErr;
  }
  async connectDaemon() {
    this.teardownConn();
    if (!this.tunnel || this.tunnel.exitCode !== null || !(await probePort(this.localPort))) {
      this.killTunnel();
      await this.openTunnel();
    }
    try {
      const conn = await ws.connect({ host: '127.0.0.1', port: this.localPort, timeout: 8000 });
      this.conn = conn;
      this.mode = 'daemon';
      this.daemonFailures = 0;
      conn.on('message', (text) => {
        let v; try { v = JSON.parse(text); } catch { return; }
        if (v && v.type === 'metrics') this.emit('metrics', { ...v, source: 'daemon' });
      });
      conn.on('close', () => this.handleDrop('daemon closed'));
      this.emit('status', 'live');
    } catch (e) {
      this.daemonFailures += 1;
      throw e;
    }
  }
  async connectCollector() {
    if (typeof this.sshCollect !== 'function') throw new Error('no collector');
    this.mode = 'collector';
    const poll = async () => {
      if (this.stopped || this.mode !== 'collector') return;
      try {
        const v = await this.sshCollect(this.host, 'machine');
        this.emit('metrics', { ...v, type: 'metrics', source: 'collector' });
        this.emit('status', 'live');
      } catch {
        this.emit('status', 'offline');
        this.mode = null;
        this.schedule(15000);
        return;
      }
      this.collectorTimer = setTimeout(poll, 5000);
    };
    await poll();
  }
  handleDrop(reason) {
    if (this.stopped) return;
    this.log(`${this.host.id}: ${reason}`);
    this.teardownConn();
    this.killTunnel();
    if (this.mode === 'daemon') { this.mode = null; this.emit('status', 'stale'); this.schedule(3000); }
  }
  teardownConn() { if (this.conn) { this.conn.removeAllListeners(); this.conn.close(); this.conn = null; } }
  killTunnel() { if (this.tunnel) { this.tunnel.removeAllListeners(); this.tunnel.kill(); this.tunnel = null; } }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.collectorTimer);
    this.teardownConn();
    this.killTunnel();
  }
}

module.exports = { HostLink, probePort, DAEMON_PORT };
