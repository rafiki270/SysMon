// Minimal RFC 6455 WebSocket framing for loopback telemetry. No dependencies.
// Server: attach to an http.Server via 'upgrade'. Client: plain net.Socket upgrade.
// Text frames only; ping/pong/close handled; 1 MiB message cap.
'use strict';
const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(data, { masked = false, opcode = 1 } = {}) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  if (!masked) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const mask = crypto.randomBytes(4);
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

// Incremental frame parser. Emits via callbacks; returns bytes consumed state in closure.
function createParser({ onMessage, onPing, onPong, onClose, onError }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (len > MAX_MESSAGE) { onError(new Error('frame too large')); return; }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + len) return;
        let payload = buffer.subarray(offset, offset + len);
        if (masked) {
          const mask = buffer.subarray(maskOffset, maskOffset + 4);
          const un = Buffer.alloc(len);
          for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
          payload = un;
        }
        buffer = buffer.subarray(offset + len);
        if (opcode === 8) { onClose(); return; }
        if (opcode === 9) { onPing(payload); continue; }
        if (opcode === 10) { onPong(payload); continue; }
        if (opcode === 0 || opcode === 1 || opcode === 2) {
          fragments.push(payload);
          const total = fragments.reduce((n, f) => n + f.length, 0);
          if (total > MAX_MESSAGE) { onError(new Error('message too large')); return; }
          if (fin) { onMessage(Buffer.concat(fragments), opcode); fragments = []; }
          continue;
        }
        onError(new Error('unsupported opcode ' + opcode)); return;
      }
    },
  };
}

class WsConnection extends EventEmitter {
  constructor(socket, { masked = false } = {}) {
    super();
    this.socket = socket;
    this.masked = masked;
    this.closed = false;
    this.parser = createParser({
      onMessage: (data, opcode) => { if (opcode === 1) this.emit('message', data.toString('utf8')); },
      onPing: (p) => this.sendRaw(p, 10),
      onPong: () => this.emit('pong'),
      onClose: () => this.close(),
      onError: () => this.close(),
    });
    socket.on('data', (d) => { if (!this.closed) this.parser.push(d); });
    socket.on('close', () => this.#finish());
    socket.on('error', () => this.#finish());
  }
  sendRaw(data, opcode) {
    if (this.closed) return;
    // Slow reader protection: never queue unbounded output on the socket.
    if (this.socket.writableLength > 512 * 1024) { this.close(); return; }
    try { this.socket.write(encodeFrame(data, { masked: this.masked, opcode })); } catch { this.close(); }
  }
  send(text) { this.sendRaw(text, 1); }
  ping() { this.sendRaw(Buffer.alloc(0), 9); }
  close() { if (!this.closed) { try { this.socket.write(encodeFrame(Buffer.alloc(0), { masked: this.masked, opcode: 8 })); } catch {} this.socket.destroy(); } this.#finish(); }
  #finish() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}

// Attach WebSocket handling to an http.Server. onConnection(conn, request).
function attachServer(httpServer, onConnection, { path = '/' } = {}) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const url = req.url || '/';
    // Browsers always send Origin; refusing them keeps local process data
    // unreachable from unrelated websites. Our Node client sends no Origin.
    if (req.headers.origin) { socket.destroy(); return; }
    if (!key || !url.split('?')[0].startsWith(path) || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy(); return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    onConnection(new WsConnection(socket, { masked: false }), req);
  });
}

// Client connects to ws://host:port/path. Resolves with WsConnection (client frames masked).
function connect({ host = '127.0.0.1', port, path = '/', timeout = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => fail(new Error('connect timeout')), timeout);
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(e); };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('connection closed during handshake')));
    socket.on('connect', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    const onData = (d) => {
      buffer = Buffer.concat([buffer, d]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) { if (buffer.length > 16384) fail(new Error('bad handshake')); return; }
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) return fail(new Error('upgrade refused: ' + head.split('\r\n')[0]));
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (accept !== acceptKey(key)) return fail(new Error('bad accept key'));
      settled = true; clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', fail);
      const conn = new WsConnection(socket, { masked: true });
      conn.on('close', () => {});
      if (rest.length) conn.parser.push(rest);
      resolve(conn);
    };
    socket.on('data', onData);
  });
}

module.exports = { attachServer, connect, encodeFrame, createParser, acceptKey, WsConnection };
