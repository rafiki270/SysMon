// Runs locally or over SSH stdin. Only projected metrics leave this process.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const home = os.homedir();
const delay = ms => new Promise(r => setTimeout(r, ms));
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const safeError = e => e.status ? `HTTP ${e.status}${e.status === 401 ? ' · sign in again' : e.status === 429 ? ' · throttled' : ''}` : e.code === 'ENOENT' ? 'CLI or credentials unavailable' : 'Provider unavailable';
const auth = (vendor, message) => ({vendor, status: 'auth', message, windows: []});
// 401/403 or an explicitly revoked/expired session means the user must sign in again.
const isAuthError = e => e.status === 401 || e.status === 403 || /401|403|unauthorized|revoked/i.test(String(e?.rpcMessage || ''));
async function command(file, args) { return (await exec(file, args, {timeout: 10000, windowsHide:true, maxBuffer:1024*1024})).stdout.trim(); }
function cpuSnapshot() { return os.cpus().reduce((a,c) => { a.idle+=c.times.idle; a.total+=Object.values(c.times).reduce((x,y)=>x+y,0); return a; }, {idle:0,total:0}); }
async function machine() {
  const a=cpuSnapshot(); await delay(1000); const b=cpuSnapshot();
  const cpu=b.total>a.total ? 100*(1-(b.idle-a.idle)/(b.total-a.total)) : null;
  let memTotal=os.totalmem(), memUsed=memTotal-os.freemem(), diskTotal=null, diskFree=null, topProc=null, topPct=null;
  if(os.platform()==='win32') {
    const raw=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command', '$o=Get-CimInstance Win32_OperatingSystem; $d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'"; @{memTotal=[double]$o.TotalVisibleMemorySize*1024;memUsed=([double]$o.TotalVisibleMemorySize-[double]$o.FreePhysicalMemory)*1024;diskTotal=[double]$d.Size;diskFree=[double]$d.FreeSpace} | ConvertTo-Json -Compress']);
    const v=JSON.parse(raw); ({memTotal,memUsed,diskTotal,diskFree}=v);
  } else {
    const disk=fs.statfsSync('/'); diskTotal=Number(disk.blocks)*Number(disk.bsize);diskFree=Number(disk.bavail)*Number(disk.bsize);
    if(os.platform()==='linux') {
      const info=fs.readFileSync('/proc/meminfo','utf8');const available=Number(info.match(/MemAvailable:\s+(\d+)/)?.[1]);if(available) memUsed=memTotal-available*1024;
    } else if(os.platform()==='darwin') {
      const vm=await command('/usr/bin/vm_stat',[]); const page=Number(vm.match(/page size of (\d+)/)?.[1] || 4096);
      const pages = label => Number(vm.match(new RegExp(label+':\\s+(\\d+)'))?.[1] || 0);
      memUsed=(pages('Pages active')+pages('Pages wired down')+pages('Pages occupied by compressor'))*page;
    }
    const procs=(await command('/bin/ps',['-A','-o','pcpu=,comm='])).split('\n').map(x=>x.trim().match(/^([\d.]+)\s+(.+)$/)).filter(Boolean).sort((x,y)=>Number(y[1])-Number(x[1]));
    if(procs[0]) {topProc=path.basename(procs[0][2]);topPct=Number(procs[0][1]);}
  }
  return {hostname:os.hostname(),os:os.platform()==='win32'?'WINDOWS':os.platform()==='darwin'?'MAC':'LINUX',cores:os.cpus().length,cpu,mem:100*memUsed/memTotal,memUsed:memUsed/1e9,memTotal:memTotal/1e9,disk:diskTotal?100*(diskTotal-diskFree)/diskTotal:null,diskFree:diskFree==null?null:diskFree/1e9,uptime:os.uptime(),load:os.platform()==='win32'?null:os.loadavg()[0],topProc,topPct,sampledAt:Date.now()};
}
async function fetchJson(url,token,headers={}) {
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`,...headers},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!r.ok) { const e=new Error('Request failed'); e.status=r.status;e.retryAfter=r.headers.get('retry-after');throw e; }
  return r.json();
}
function codexCommand(homeDir=home) {
  const paths=os.platform()==='win32' ? [path.join(homeDir,'AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')] : [path.join(homeDir,'.local/share/codex-cli/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'),'/Applications/Codex.app/Contents/Resources/codex'];
  return paths.find(p=>fs.existsSync(p)) || 'codex';
}
// null/undefined/''/booleans are missing data, not 0%; only real numbers and numeric strings count.
const finitePct = v => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null; };
const parseReset = v => { if (v == null) return null; const t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v); return Number.isFinite(t) ? t : null; };
// A quota quantity (used/remaining) is a real non-negative number only;
// null/''/booleans must not coerce to 0.
const finiteQty = v => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
// Derive used quota from `used`, else from `remaining`; drop the window when
// neither is valid or values contradict the limit. Never fabricate 0.
function quotaUsed(d) {
  const limit = finiteQty(d?.limit);
  if (!(limit > 0)) return null;
  const usedN = finiteQty(d?.used), remaining = finiteQty(d?.remaining);
  if (usedN != null && usedN <= limit) return { usedPct: 100 * usedN / limit };
  if (remaining != null && remaining <= limit) return { usedPct: 100 * (limit - remaining) / limit };
  return null;
}
// Turn the Codex app-server rate-limit payload into windows. The main bucket
// (limitId "codex" / the root rateLimits object) always leads; reserve buckets
// follow compactly. Malformed entries are dropped, never shown as 0%.
function codexWindows(result) {
  const all = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [result?.rateLimits];
  const windows = [];
  for (const l of all.filter(Boolean)) {
    for (const key of ['primary', 'secondary']) {
      const w = l[key];
      if (!w) continue;
      const used = finitePct(w.usedPercent);
      if (used == null) continue;
      const isMain = l.limitId === 'codex' || (!l.limitId && !l.limitName);
      const name = isMain ? 'Codex' : (l.limitName || l.limitId || 'Codex');
      const mins = Number(w.windowDurationMins);
      const span = !Number.isFinite(mins) || mins <= 0 ? ''
        : mins % 10080 === 0 ? ' · weekly'
        : mins % 1440 === 0 ? ` · ${mins / 1440}d`
        : mins % 60 === 0 ? ` · ${mins / 60}h`
        : mins < 60 ? ` · ${mins}m`
        : ` · ${Math.floor(mins / 60)}h ${mins % 60}m`;
      windows.push({ label: `${name}${span}`, used, resetAt: parseReset(w.resetsAt), main: isMain });
    }
  }
  return windows.sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || b.used - a.used);
}
async function codex(deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const bin = deps.command || codexCommand();
  return new Promise((resolve, reject) => {
    // Strip agent-specific CODEX_HOME so the user's own ~/.codex login is used.
    const env = { ...process.env }; delete env.CODEX_HOME;
    const child = spawnFn(bin, ['app-server'], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', finished = false;
    const finish = (err, result) => { if (finished) return; finished = true; clearTimeout(timer); try { child.kill(); } catch {} err ? reject(err) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('timeout')), 25000);
    child.on('error', e => finish(e)); child.on('exit', () => finish(new Error('exited'))); child.stderr.resume();
    // A missing/exiting CLI closes stdin; swallow EPIPE so it cannot crash the monitor.
    child.stdin.on('error', () => {});
    const send = x => child.stdin.write(JSON.stringify(x) + '\n');
    child.stdout.on('data', chunk => {
      buf += chunk.toString(); if (buf.length > 2e6) return finish(new Error('oversized'));
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); let v; try { v = JSON.parse(line); } catch { continue; }
        if (v.id === 1) { if (v.error) return finish(Object.assign(new Error('initialize'), { rpcMessage: v.error.message })); send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); }
        if (v.id === 2) { if (v.error) return finish(Object.assign(new Error('limits'), { rpcMessage: v.error.message })); const windows = codexWindows(v.result); finish(null, { vendor: 'Codex', status: windows.length ? 'live' : 'unavailable', windows, sampledAt: Date.now() }); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'sysmon', title: 'SysMon', version: '1.0.0' } } });
  });
}
async function claude(deps = {}) {
  const read = deps.readJson || readJson;
  const fetcher = deps.fetchJson || fetchJson;
  let c = read(path.join(home, '.claude/.credentials.json'));
  if (!c && os.platform() === 'darwin') { try { c = JSON.parse(await command('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])); } catch {} }
  const t = c?.claudeAiOauth;
  if (!t) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  // Claude Code writes an empty accessToken and expiresAt:0 when signed out.
  if (!t.accessToken) return auth('Claude', 'Open Claude Code to sign in');
  // Let the owning CLI rotate its credentials; never race a shared refresh token.
  if (Number.isFinite(t.expiresAt) && t.expiresAt <= Date.now()) return auth('Claude', 'Open Claude Code to renew sign-in');
  const r = await fetcher('https://api.anthropic.com/api/oauth/usage', t.accessToken, { 'anthropic-beta': 'oauth-2025-04-20' });
  const windows = Object.entries(r).filter(([k, v]) => v && finitePct(v.utilization) != null).map(([k, v]) => ({ label: k.replaceAll('_', ' '), used: finitePct(v.utilization), resetAt: parseReset(v.resets_at) }));
  return { vendor: 'Claude', status: windows.length ? 'live' : 'unavailable', windows, sampledAt: Date.now() };
}
// Live schema (checked 2026-10): usage{limit,used,remaining,resetTime},
// limits[]{window{duration,timeUnit},detail{...}}, usages{limit_5h|limit_7d{used_ratio,reset_time}}.
// The official Kimi CLI labels the top-level `usage` block "Weekly limit"
// and renders it as remaining/"% left" — it is the weekly headline, kept
// with its own reported reset and preferred over the compatibility 7d mirror.
function kimiWindows(r) {
  const out = [];
  for (const x of r?.limits || []) {
    const d = x?.detail || x;
    const q = quotaUsed(d);
    if (!q) continue;
    const unit = String(x.window?.timeUnit || '').replace(/^TIME_UNIT_/, '').toLowerCase();
    const dur = Number(x.window?.duration);
    const durLabel = x.window ? (unit.startsWith('min') && dur >= 60 && dur % 60 === 0 ? `${dur / 60}h` : `${dur} ${unit || 'window'}`) : 'Limit';
    out.push({ label: x.name || x.title || durLabel, used: q.usedPct, resetAt: parseReset(d.resetTime || d.resetAt || d.reset_at) });
  }
  const u = r?.usage;
  if (u) {
    const q = quotaUsed(u);
    if (q) out.push({ label: 'Kimi · weekly', used: q.usedPct, resetAt: parseReset(u.resetTime), main: true });
  }
  for (const [key, v] of Object.entries(r?.usages || {})) {
    const raw = v?.used_ratio;
    if (raw == null || raw === '' || typeof raw === 'boolean') continue; // never coerce missing to 0
    const ratio = Number(raw);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) continue;
    out.push({ label: key.replace(/^limit_/, ''), used: ratio * 100, resetAt: parseReset(v.reset_time) });
  }
  // The same window can be reported by several schema shapes that disagree
  // (e.g. usages ratio 0 while the detailed limits entry says 24%). Keep the
  // highest valid utilization, preserving the selected window's own reset.
  const byLabel = new Map();
  for (const w of out) {
    if (!Number.isFinite(w.used)) continue;
    const prev = byLabel.get(w.label);
    if (!prev || w.used > prev.used) byLabel.set(w.label, w);
  }
  return [...byLabel.values()];
}
function kimiToken() {
  if (process.env.KIMI_API_KEY) return { token: process.env.KIMI_API_KEY, via: 'env' };
  try { const t = fs.readFileSync(path.join(home, '.kimix/token'), 'utf8').trim(); if (t) return { token: t, via: 'kimix' }; } catch {}
  return null;
}
async function kimi(deps = {}) {
  const read = deps.readJson || readJson;
  const fetcher = deps.fetchJson || fetchJson;
  const tokenFor = deps.tokenFor || kimiToken;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  let token = null, expired = false;
  for (const dir of ['.kimi-code', '.kimi']) { const c = read(path.join(home, dir, 'credentials/kimi-code.json')); if (c?.access_token) { if (c.expires_at && c.expires_at * 1000 <= Date.now()) { expired = true; continue; } token = c.access_token; break; } }
  // Native OAuth token expired: fall back to the Kimix API key (read locally, never logged).
  if (!token) { const k = tokenFor(); if (k) token = k.token; }
  if (!token) {
    for (const dir of ['.kimi-code', '.kimi']) { try { const text = readFile(path.join(home, dir, 'config.toml')); const block = text.match(/\[providers\.[^\]]+\][\s\S]*?base_url\s*=\s*"https:\/\/api.kimi.com\/coding\/v1"[\s\S]*?(?=\n\[|$)/); token = block?.[0].match(/api_key\s*=\s*"([^"\n]+)"/)?.[1]; if (token) break; } catch {} }
  }
  if (!token && expired) return auth('Kimi', 'Open Kimi CLI to renew sign-in');
  if (!token) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  const r = await fetcher('https://api.kimi.com/coding/v1/usages', token); const windows = kimiWindows(r);
  return { vendor: 'Kimi', status: windows.length ? 'live' : 'unavailable', windows, sampledAt: Date.now() };
}
async function accounts(deps = {}) {
  return Promise.all([['Codex', codex], ['Claude', claude], ['Kimi', kimi]].map(async ([vendor, f]) => { try { return await f(deps[vendor.toLowerCase()] || {}); } catch (e) { if (isAuthError(e)) return auth(vendor, vendor === 'Codex' ? 'Open Codex and sign in again' : 'Open the CLI and sign in again'); return { vendor, status: 'unavailable', message: safeError(e), retryAfter: e.status === 429 ? Math.max(300, Number(e.retryAfter) || 0) : null, windows: [] }; } }));
}
async function run(mode) { if (mode === 'machine') return machine(); if (mode === 'accounts') return accounts(); return { machine: await machine(), accounts: await accounts() }; }
module.exports = { machine, accounts, run, kimiWindows, codexWindows, codex, claude, kimi };
if (require.main === module) run(process.argv[2] || 'all').then(x => process.stdout.write(JSON.stringify(x) + '\n')).catch(() => { process.stdout.write(JSON.stringify({ status: 'unavailable' }) + '\n'); process.exitCode = 1; });
