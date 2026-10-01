// Durable per-installation bearer token authenticating read-only MCP access.
// The token lives only in the app's userData directory with owner-only file
// permissions. It is never logged, never printed, never advertised over mDNS,
// and never committed to the repository.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function tokenFile(userData) { return path.join(userData, 'mcp-token'); }

// Returns the existing token, generating and persisting a new random one on
// first run (or after the file was corrupted). Regenerating on corruption is
// deliberate: a silently truncated file must not weaken authentication.
function loadOrCreateToken(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (TOKEN_PATTERN.test(existing)) return existing;
  } catch {}
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', token + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return token;
}

function readToken(file) {
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch { throw new Error(`MCP token file not found: ${file} (is SysMon running on this machine?)`); }
  if (!TOKEN_PATTERN.test(token)) throw new Error(`MCP token file is invalid: ${file}`);
  return token;
}

// Resolve the token file without Electron (used by the stdio adapter, which
// runs as a plain Node process). Packaged builds use productName "SysMon";
// unpackaged dev runs use the package name "sysmon".
function defaultTokenFile({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.SYSMON_MCP_TOKEN_FILE) return env.SYSMON_MCP_TOKEN_FILE;
  if (env.SYSMON_USERDATA) return path.join(env.SYSMON_USERDATA, 'mcp-token');
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  for (const name of ['SysMon', 'sysmon']) {
    const candidate = path.join(base, name, 'mcp-token');
    if (exists(candidate)) return candidate;
  }
  return path.join(base, 'SysMon', 'mcp-token');
}

module.exports = { tokenFile, loadOrCreateToken, readToken, defaultTokenFile, TOKEN_PATTERN };
