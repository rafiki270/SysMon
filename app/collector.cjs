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
function codexCommand() {
  const paths=os.platform()==='win32' ? [path.join(home,'AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')] : [path.join(home,'.local/share/codex-cli/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'),'/Applications/Codex.app/Contents/Resources/codex'];
  return paths.find(p=>fs.existsSync(p)) || 'codex';
}
async function codex() {
  return new Promise((resolve,reject)=>{
    // Strip agent-specific CODEX_HOME so the user's own ~/.codex login is used.
    const env={...process.env};delete env.CODEX_HOME;
    const child=spawn(codexCommand(),['app-server'],{windowsHide:true,env,stdio:['pipe','pipe','pipe']});let buf='',finished=false;
    const finish=(err,result)=>{if(finished)return;finished=true;clearTimeout(timer);child.kill();err?reject(err):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('timeout')),25000);
    child.on('error',e=>finish(e));child.on('exit',()=>finish(new Error('exited')));child.stderr.resume();
    const send=x=>child.stdin.write(JSON.stringify(x)+'\n');
    child.stdout.on('data',chunk=>{buf+=chunk.toString();if(buf.length>2e6)return finish(new Error('oversized'));let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);let v;try{v=JSON.parse(line);}catch{continue;}
      if(v.id===1){if(v.error)return finish(new Error('initialize'));send({method:'initialized'});send({id:2,method:'account/rateLimits/read'});}
      if(v.id===2){if(v.error)return finish(Object.assign(new Error('limits'),{rpcMessage:v.error.message}));const r=v.result;const all=r.rateLimitsByLimitId?Object.values(r.rateLimitsByLimitId):[r.rateLimits];const windows=all.filter(Boolean).flatMap(l=>['primary','secondary'].map(k=>{const w=l[k];return w?{label:`${l.limitName||l.limitId||'Codex'} · ${w.windowDurationMins>=1440?'weekly':w.windowDurationMins/60+'h'}`,used:w.usedPercent,resetAt:w.resetsAt==null?null:w.resetsAt*1000}:null;})).filter(Boolean);finish(null,{vendor:'Codex',status:windows.length?'live':'unavailable',windows,sampledAt:Date.now()});}
    }});
    send({id:1,method:'initialize',params:{clientInfo:{name:'sysmon',title:'SysMon',version:'1.0.0'}}});
  });
}
async function claude() {
  let c=readJson(path.join(home,'.claude/.credentials.json'));
  if(!c && os.platform()==='darwin') {try{c=JSON.parse(await command('/usr/bin/security',['find-generic-password','-s','Claude Code-credentials','-w']));}catch{}}
  const t=c?.claudeAiOauth;
  if(!t) throw Object.assign(new Error('missing'),{code:'ENOENT'});
  // Claude Code writes an empty accessToken and expiresAt:0 when signed out.
  if(!t.accessToken) return auth('Claude','Open Claude Code to sign in');
  // Let the owning CLI rotate its credentials; never race a shared refresh token.
  if(Number.isFinite(t.expiresAt) && t.expiresAt<=Date.now()) return auth('Claude','Open Claude Code to renew sign-in');
  const r=await fetchJson('https://api.anthropic.com/api/oauth/usage',t.accessToken,{'anthropic-beta':'oauth-2025-04-20'});
  const windows=Object.entries(r).filter(([k,v])=>v&&typeof v.utilization==='number').map(([k,v])=>({label:k.replaceAll('_',' '),used:v.utilization,resetAt:v.resets_at?Date.parse(v.resets_at):null}));
  return {vendor:'Claude',status:windows.length?'live':'unavailable',windows,sampledAt:Date.now()};
}
function kimiWindows(r) {
  const rows=[...(r.usage?[{...r.usage,label:'Weekly'}]:[]),...(r.limits||[]).map(x=>({...x.detail,...(!x.detail?x:{}),label:x.name||x.title||(x.window?`${x.window.duration} ${x.window.timeUnit}`:'Limit')}))];
  return rows.filter(v=>Number(v.limit)>0 && (v.used!=null||v.remaining!=null)).map(v=>({label:v.label,used:100*Number(v.used??(Number(v.limit)-Number(v.remaining)))/Number(v.limit),resetAt:v.resetTime||v.resetAt||v.reset_at?Date.parse(v.resetTime||v.resetAt||v.reset_at):v.resetIn?Date.now()+Number(v.resetIn)*1000:null}));
}
async function kimi() {
  let token=null,expired=false;
  for(const dir of ['.kimi-code','.kimi']) {const c=readJson(path.join(home,dir,'credentials/kimi-code.json'));if(c?.access_token){if(c.expires_at&&c.expires_at*1000<=Date.now()){expired=true;continue;}token=c.access_token;break;}}
  if(!token) {
    for(const dir of ['.kimi-code','.kimi']) {try{const text=fs.readFileSync(path.join(home,dir,'config.toml'),'utf8');const block=text.match(/\[providers\.[^\]]+\][\s\S]*?base_url\s*=\s*"https:\/\/api.kimi.com\/coding\/v1"[\s\S]*?(?=\n\[|$)/);token=block?.[0].match(/api_key\s*=\s*"([^"\n]+)"/)?.[1];if(token)break;}catch{}}
  }
  if(!token&&expired)return auth('Kimi','Open Kimi CLI to renew sign-in');
  if(!token)throw Object.assign(new Error('missing'),{code:'ENOENT'});
  const r=await fetchJson('https://api.kimi.com/coding/v1/usages',token);const windows=kimiWindows(r);
  return {vendor:'Kimi',status:windows.length?'live':'unavailable',windows,sampledAt:Date.now()};
}
async function accounts() {
  return Promise.all([['Codex',codex],['Claude',claude],['Kimi',kimi]].map(async([vendor,f])=>{try{return await f();}catch(e){if(isAuthError(e))return auth(vendor,vendor==='Codex'?'Open Codex and sign in again':'Open the CLI and sign in again');return {vendor,status:'unavailable',message:safeError(e),retryAfter:e.status===429?Math.max(300,Number(e.retryAfter)||0):null,windows:[]};}}));
}
async function run(mode) {if(mode==='machine')return machine();if(mode==='accounts')return accounts();return {machine:await machine(),accounts:await accounts()};}
module.exports={machine,accounts,run,kimiWindows};
if(require.main===module)run(process.argv[2]||'all').then(x=>process.stdout.write(JSON.stringify(x)+'\n')).catch(()=>{process.stdout.write(JSON.stringify({status:'unavailable'})+'\n');process.exitCode=1;});
