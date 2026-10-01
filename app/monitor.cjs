const fs=require('node:fs');const path=require('node:path');const {spawn,execFile}=require('node:child_process');const {promisify}=require('node:util');const EventEmitter=require('node:events');const collector=require('./collector.cjs');
const hosts=[{id:'minis',name:'Minis',os:'WINDOWS',address:'192.168.1.215',local:true},{id:'dictator',name:'dictator',os:'MAC',address:'192.168.1.229',ssh:'dictator@dictator.local',fallback:'dictator@192.168.1.229'},{id:'umac',name:'umac',os:'LINUX',address:'192.168.1.192',ssh:'umac@umac.local',fallback:'umac@192.168.1.192'}];
const source=fs.readFileSync(path.join(__dirname,'collector.cjs'),'utf8');
function sshCollect(host,mode,target=host.ssh) {
 return new Promise((resolve,reject)=>{
  // Source is sent over encrypted stdin. No remote installation or credentials copy.
  const remote="export PATH=\"$HOME/.local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; node - "+mode;
  const p=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=5','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2',target,remote],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',done=false;
  const timer=setTimeout(()=>finish(new Error('timeout')),45000);
  function finish(e,v){if(done)return;done=true;clearTimeout(timer);p.kill();e?reject(e):resolve(v);}
  p.on('error',e=>finish(e));p.stdin.on('error',()=>{});p.stderr.resume();p.stdout.on('data',d=>{output+=d.toString();if(output.length>2e6)finish(new Error('oversized'));});
  p.on('close',code=>{if(code!==0)return finish(new Error('offline'));try{finish(null,JSON.parse(output.trim()));}catch{finish(new Error('invalid collector response'));}});p.stdin.end(source);
 }).catch(e=>{if(target===host.ssh)return sshCollect(host,mode,host.fallback);throw e;});
}
function reconcileAccount(old,reading) {
 const sampledAt=reading.sampledAt||old?.sampledAt||null;
 if(reading.status==='live')return {...reading,sampledAt,lastSuccessAt:sampledAt};
 return {...reading,sampledAt,lastSuccessAt:old?.lastSuccessAt||null,windows:old?.windows||[],status:old?.windows?.length?'stale':reading.status};
}
class Monitor extends EventEmitter {
 constructor(){super();this.state={machines:hosts.map(h=>({...h,status:'connecting',history:[]})),accounts:[...['minis','dictator'].flatMap(host=>['Codex','Claude'].map(vendor=>({id:`${host}-${vendor}`,host,vendor,status:'connecting',windows:[]}))),{id:'dictator-Kimi',host:'dictator',vendor:'Kimi',status:'connecting',windows:[]},{id:'grok',host:'web',vendor:'Grok',status:'auth',message:'Connect Grok',windows:[]}],ci:{status:'connecting',jobs:[],sampledAt:null},updatedAt:null};this.stopped=false;this.timers=[];this.accountNext={};}
 publish(){this.state.updatedAt=Date.now();this.emit('update',this.state);}
 async machine(h){const old=this.state.machines.find(m=>m.id===h.id);try{const r=h.local?await collector.machine():await sshCollect(h,'machine');Object.assign(old,r,{status:'live',history:[...old.history.filter(x=>x.at>Date.now()-60000),{at:r.sampledAt,cpu:r.cpu}]});}catch{old.status='offline';old.history=[];}this.publish();}
 async accounts(h){if((this.accountNext[h.id]||0)>Date.now())return;try{const result=h.local?await collector.accounts():await sshCollect(h,'accounts');for(const r of result){const i=this.state.accounts.findIndex(a=>a.host===h.id&&a.vendor===r.vendor);if(i>=0)this.state.accounts[i]={...this.state.accounts[i],...reconcileAccount(this.state.accounts[i],r)};}const retry=Math.max(0,...result.map(r=>r.retryAfter||0));this.accountNext[h.id]=Date.now()+Math.max(120,retry)*1000;}catch{this.accountNext[h.id]=Date.now()+120000;this.state.accounts=this.state.accounts.map(a=>a.host===h.id?{...a,status:a.windows.length?'stale':'unavailable',message:'Host unavailable'}:a);}this.publish();}
 async ci(){try{const {stdout}=await promisify(execFile)('gh',['api','/search/issues?q=is:pr+is:open+author:@me+status:failure&per_page=50'],{timeout:20000,windowsHide:true,maxBuffer:2e6});const result=JSON.parse(stdout);this.state.ci={status:'live',sampledAt:Date.now(),jobs:result.items.map(i=>({repo:i.repository_url.split('/').slice(-2).join('/'),number:i.number,url:i.html_url,title:i.title})),truncated:result.total_count>result.items.length};}catch{this.state.ci={...this.state.ci,status:this.state.ci.sampledAt?'stale':'unavailable',message:'GitHub CLI unavailable or not signed in'};}this.publish();}
 setGrok(r){const i=this.state.accounts.findIndex(a=>a.id==='grok');this.state.accounts[i]={...this.state.accounts[i],...reconcileAccount(this.state.accounts[i],r)};this.publish();}
 start(){const loop=async(fn,interval)=>{if(this.stopped)return;await fn();if(!this.stopped)this.timers.push(setTimeout(()=>loop(fn,interval),interval));};hosts.forEach(h=>loop(()=>this.machine(h),5000));hosts.filter(h=>h.id!=='umac').forEach(h=>loop(()=>this.accounts(h),120000));loop(()=>this.ci(),60000);}
 stop(){this.stopped=true;this.timers.forEach(clearTimeout);this.timers=[];}
}
module.exports={Monitor,hosts,sshCollect,reconcileAccount};
