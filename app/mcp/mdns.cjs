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
const os = require('node:os');
const { VERSION } = require('./registry.cjs');

const SERVICE_NAME = 'SysMon';

// Instance names carry the hostname: SysMon runs on several machines of the
// same LAN, and static names would collide into a single DNS-SD instance.
function serviceConfigs(port, hostname = os.hostname()) {
  const txt = {
    path: '/mcp',
    transport: 'streamable-http',
    version: VERSION,
    auth: 'bearer',
  };
  return [
    { name: `${SERVICE_NAME} Monitor (${hostname})`, type: 'sysmon', protocol: 'tcp', port, txt },
    { name: `${SERVICE_NAME} MCP (${hostname})`, type: 'mcp', protocol: 'tcp', port, txt },
  ];
}

class MdnsAdvertiser {
  // bonjourFactory is injectable so tests never emit real LAN traffic.
  constructor({ log = () => {}, bonjourFactory = null } = {}) {
    this.log = log;
    this.bonjourFactory = bonjourFactory || (() => new (require('bonjour-service').Bonjour)());
    this.bonjour = null;
    this.services = [];
    this.error = null;
  }

  active() { return !!this.bonjour && !this.error; }

  start({ port, hostname }) {
    if (this.bonjour || !port) return;
    try {
      this.bonjour = this.bonjourFactory();
      this.services = serviceConfigs(port, hostname).map((config) => {
        const service = this.bonjour.publish(config);
        // A publication failure (probe conflict, socket error) can surface
        // asynchronously per service; report it truthfully and clean up.
        service.on?.('error', (e) => this.fail(e));
        return service;
      });
      this.log(`mDNS advertising _sysmon._tcp and _mcp._tcp on port ${port}`);
    } catch (e) {
      this.fail(e);
    }
  }

  // Record the failure and tear down any partial publication so status is
  // honest: active() is false and nothing half-advertised lingers.
  fail(e) {
    this.error = e?.message || String(e);
    this.log(`mDNS advertisement unavailable: ${this.error}`);
    const bonjour = this.bonjour;
    this.bonjour = null;
    this.services = [];
    if (!bonjour) return;
    try { bonjour.unpublishAll(() => { try { bonjour.destroy(() => {}); } catch {} }); }
    catch { try { bonjour.destroy(() => {}); } catch {} }
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
