'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const ws = require('../daemon/ws.cjs');

test('acceptKey matches RFC 6455 example', () => {
  assert.strictEqual(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame small/medium/large lengths roundtrip through parser', () => {
  const seen = [];
  const parser = ws.createParser({ onMessage: (d) => seen.push(d.toString()), onPing: () => {}, onPong: () => {}, onClose: () => {}, onError: (e) => { throw e; } });
  for (const len of [0, 5, 125, 126, 70000]) {
    const payload = 'x'.repeat(len);
    parser.push(ws.encodeFrame(payload));
    assert.strictEqual(seen.pop(), payload);
  }
});

test('parser unmasks client frames and assembles fragments', () => {
  const seen = [];
  const parser = ws.createParser({ onMessage: (d) => seen.push(d.toString()), onPing: () => {}, onPong: () => {}, onClose: () => seen.push('CLOSED'), onError: (e) => { throw e; } });
  parser.push(ws.encodeFrame('masked payload', { masked: true }));
  assert.strictEqual(seen.pop(), 'masked payload');
  // fragmented: FIN=0 text frame then continuation
  const a = ws.encodeFrame('hel', { opcode: 1 }); a[0] = 1; // clear FIN
  const b = ws.encodeFrame('lo', { opcode: 0 });
  parser.push(Buffer.concat([a, b]));
  assert.strictEqual(seen.pop(), 'hello');
});

test('parser splits multiple frames in one chunk and across chunks', () => {
  const seen = [];
  const parser = ws.createParser({ onMessage: (d) => seen.push(d.toString()), onPing: () => {}, onPong: () => {}, onClose: () => {}, onError: (e) => { throw e; } });
  const both = Buffer.concat([ws.encodeFrame('one'), ws.encodeFrame('two')]);
  parser.push(both.subarray(0, 3));
  parser.push(both.subarray(3));
  assert.deepStrictEqual(seen, ['one', 'two']);
});

test('server/client roundtrip over loopback', async () => {
  const server = http.createServer();
  const conns = [];
  ws.attachServer(server, (c) => { conns.push(c); c.on('message', (m) => c.send('echo:' + m)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const client = await ws.connect({ port });
  const reply = new Promise((r) => client.on('message', r));
  client.send('ping-json-' + JSON.stringify({ a: 1 }));
  assert.strictEqual(await reply, 'echo:ping-json-{"a":1}');
  // server push after client connects
  const pushed = new Promise((r) => client.on('message', r));
  conns[0].send('push');
  assert.strictEqual(await pushed, 'push');
  client.close();
  server.close();
});

test('client rejects non-upgrade responses', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('no'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await assert.rejects(ws.connect({ port: server.address().port }), /upgrade refused/);
  server.close();
});
