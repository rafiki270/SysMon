// DNS-SD/Bonjour (mDNS) advertisement of the MCP endpoint so LAN clients can
// discover it without configuration. Advertises endpoint metadata only —
// path, transport, version, and that bearer auth is required. Never
// advertises stats, host metrics, or the token.
//
// Advertisement starts only after the HTTP listener is verified up (the
// caller passes the actual bound port), and stop() unpublishes, which sends
// mDNS goodbye packets (TTL=0) so the service disappears from the network.
// bonjour-service responds on all interfaces and re-announces as network
// interfaces change; the advertised host is the machine's LAN hostname,
// never 127.0.0.1.
'use strict';
const { VERSION } = require('./registry.cjs');

const SERVICE_NAME = 'SysMon';

function serviceConfigs(port) {
  const txt = {
    path: '/mcp',
    transport: 'streamable-http',
    version: VERSION,
    auth: 'bearer',
  };
  return [
    { name: `${SERVICE_NAME} Monitor`, type: 'sysmon', protocol: 'tcp', port, txt },
    { name: `${SERVICE_NAME} MCP`, type: 'mcp', protocol: 'tcp', port, txt },
  ];
}

class MdnsAdvertiser {
  // bonjourFactory is injectable so tests never emit real LAN traffic.
  constructor({ log = () => {}, bonjourFactory = null } = {}) {
    this.log = log;
    this.bonjourFactory = bonjourFactory || (() => new (require('bonjour-service').Bonjour)());
    this.bonjour = null;
    this.services = [];
  }

  active() { return !!this.bonjour; }

  start({ port }) {
    if (this.bonjour || !port) return;
    try {
      this.bonjour = this.bonjourFactory();
      this.services = serviceConfigs(port).map((config) => this.bonjour.publish(config));
      for (const s of this.services) s.on?.('error', () => {});
      this.log(`mDNS advertising _sysmon._tcp and _mcp._tcp on port ${port}`);
    } catch (e) {
      this.log(`mDNS advertisement unavailable: ${e.message}`);
      this.bonjour = null;
      this.services = [];
    }
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.bonjour) return resolve();
      const bonjour = this.bonjour;
      this.bonjour = null;
      this.services = [];
      try {
        bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
      } catch {
        try { bonjour.destroy(() => resolve()); } catch { resolve(); }
      }
      // Goodbye packets are best-effort; never hang app quit on them.
      setTimeout(resolve, 1500).unref?.();
    });
  }
}

module.exports = { MdnsAdvertiser, serviceConfigs, SERVICE_NAME };
