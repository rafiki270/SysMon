// Streamable HTTP MCP server (official SDK transport) exposing the app's
// live monitor state on the LAN. Security model, per the MCP transport spec:
//   - Bearer authentication on every request (durable per-installation token).
//   - Origin validation on every request: any request carrying an Origin
//     header is a browser cross-origin request and is rejected with 403
//     (DNS-rebinding guard; non-browser MCP clients never send Origin).
//   - Bounded request bodies, bounded session count, idle-session reaping.
// The endpoint is HTTP (no TLS) on the trusted LAN; that is documented, never
// claimed otherwise. A bind failure never crashes the app: status() reports
// it and every other app function continues.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { createMcpServer } = require('./registry.cjs');

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_SESSIONS = 16;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const REAP_INTERVAL_MS = 5 * 60 * 1000;

function rpcError(res, status, code, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class McpHttpServer {
  constructor({ monitor, token, log = () => {}, maxSessions = MAX_SESSIONS, sessionIdleMs = SESSION_IDLE_MS }) {
    this.monitor = monitor;
    this.token = token;
    this.log = log;
    this.maxSessions = maxSessions;
    this.sessionIdleMs = sessionIdleMs;
    this.sessions = new Map(); // sessionId -> { transport, server, lastTouched }
    this.http = null;
    this.error = null;
    this.reaper = null;
  }

  authorized(req) {
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://sysmon.local'); } catch { return rpcError(res, 400, -32600, 'Invalid request target'); }
    if (url.pathname !== MCP_PATH) return rpcError(res, 404, -32600, 'Not found');
    // Origin validation (MCP spec, DNS-rebinding protection): browsers always
    // send Origin on cross-origin POSTs; legitimate MCP clients do not.
    if (req.headers.origin) return rpcError(res, 403, -32001, 'Browser origins are not allowed');
    if (!this.authorized(req)) return rpcError(res, 401, -32000, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="sysmon-mcp"' });
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return rpcError(res, 405, -32600, 'Method not allowed', { Allow: 'POST, GET, DELETE' });

    let body;
    if (req.method === 'POST') {
      let raw;
      try { raw = await readBody(req, MAX_BODY_BYTES); } catch { return rpcError(res, 413, -32600, 'Request body too large'); }
      try { body = JSON.parse(raw); } catch { return rpcError(res, 400, -32700, 'Parse error'); }
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && !existing) return rpcError(res, 404, -32001, 'Unknown or expired session');

    let transport;
    if (existing) {
      existing.lastTouched = Date.now();
      transport = existing.transport;
    } else {
      if (req.method !== 'POST' || !isInitializeRequest(body)) return rpcError(res, 400, -32600, 'Expected an initialize request for a new session');
      if (this.sessions.size >= this.maxSessions) return rpcError(res, 503, -32001, 'Too many sessions');
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { transport, server, lastTouched: Date.now() });
        },
        onsessionclosed: (id) => { this.sessions.delete(id); },
      });
      const server = createMcpServer(this.monitor);
      transport.onclose = () => {
        for (const [id, s] of this.sessions) if (s.transport === transport) this.sessions.delete(id);
      };
      try {
        await server.connect(transport);
      } catch (e) {
        this.log(`MCP session setup failed: ${e.message}`);
        return rpcError(res, 500, -32603, 'Internal error');
      }
    }
    try {
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
      else res.end();
      this.log(`MCP request failed: ${e.message}`);
    }
  }

  // Resolves in all cases: a bind failure is recorded in status() and logged
  // (sanitized) but never thrown, so the monitor app keeps running.
  start({ port = 7738, host = '0.0.0.0' } = {}) {
    return new Promise((resolve) => {
      this.http = http.createServer((req, res) => { this.handle(req, res).catch(() => { try { res.end(); } catch {} }); });
      this.http.on('error', (e) => {
        this.error = e.code || e.message;
        this.log(`MCP server unavailable on port ${port}: ${this.error}`);
        resolve();
      });
      this.http.on('listening', () => {
        this.log(`MCP server listening on port ${this.port()} (${host === '0.0.0.0' ? 'LAN' : host})${MCP_PATH}`);
        this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
        this.reaper.unref?.();
        resolve();
      });
      try { this.http.listen(port, host); } catch (e) { this.error = e.message; resolve(); }
    });
  }

  reap() {
    const cutoff = Date.now() - this.sessionIdleMs;
    for (const [id, s] of this.sessions) {
      if (s.lastTouched < cutoff) {
        this.sessions.delete(id);
        s.transport.close().catch(() => {});
        s.server.close().catch(() => {});
      }
    }
  }

  listening() { return !!(this.http && this.http.listening); }
  port() { return this.http?.address()?.port ?? null; }

  // Sanitized for tray/log display: never includes the token.
  status() {
    return {
      listening: this.listening(),
      port: this.port(),
      path: MCP_PATH,
      sessions: this.sessions.size,
      error: this.error,
    };
  }

  async stop() {
    if (this.reaper) { clearInterval(this.reaper); this.reaper = null; }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((s) => s.transport.close().then(() => s.server.close())));
    if (this.http) {
      const server = this.http;
      this.http = null;
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    }
  }
}

module.exports = { McpHttpServer, MCP_PATH, MAX_BODY_BYTES, MAX_SESSIONS };
