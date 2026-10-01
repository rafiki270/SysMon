// Wires the MCP HTTP server and mDNS advertisement into the app lifecycle.
// Start order matters: the token is loaded/created first, the HTTP listener
// binds next, and mDNS advertises only after the port is verified listening —
// no phantom advertisements if the bind fails. Any failure is logged
// (sanitized, token-free) and leaves the rest of the app running.
'use strict';
const os = require('node:os');
const { tokenFile, loadOrCreateToken } = require('./token.cjs');
const { McpHttpServer, MCP_PATH } = require('./server.cjs');
const { MdnsAdvertiser } = require('./mdns.cjs');

const DEFAULT_PORT = 7738;

// First non-internal IPv4 address, for tray display and docs. The server
// itself binds 0.0.0.0 so it stays reachable as interfaces change.
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) return ni.address;
    }
  }
  return null;
}

async function start({ monitor, userData, log = () => {}, port = DEFAULT_PORT, host = '0.0.0.0', mdns = true, bonjourFactory = null }) {
  let token;
  try {
    token = loadOrCreateToken(tokenFile(userData));
  } catch (e) {
    log(`MCP disabled: cannot access token file (${e.code || e.message})`);
    return disabledHandle(log);
  }
  const server = new McpHttpServer({ monitor, token, log });
  await server.start({ port, host });

  let advertiser = null;
  if (mdns && server.listening()) {
    advertiser = new MdnsAdvertiser({ log, bonjourFactory });
    advertiser.start({ port: server.port() });
    if (!advertiser.active()) advertiser = null;
  }

  const endpoint = () => {
    if (!server.listening()) return null;
    const address = host === '127.0.0.1' ? '127.0.0.1' : (lanAddress() || '127.0.0.1');
    return `http://${address}:${server.port()}${MCP_PATH}`;
  };

  return {
    server,
    endpoint,
    status: () => ({ ...server.status(), endpoint: endpoint(), mdns: !!advertiser }),
    stop: async () => {
      if (advertiser) await advertiser.stop();
      advertiser = null;
      await server.stop();
    },
  };
}

function disabledHandle() {
  return {
    server: null,
    endpoint: () => null,
    status: () => ({ listening: false, port: null, path: MCP_PATH, sessions: 0, error: 'disabled', endpoint: null, mdns: false }),
    stop: async () => {},
  };
}

module.exports = { start, lanAddress, DEFAULT_PORT, MCP_PATH };
