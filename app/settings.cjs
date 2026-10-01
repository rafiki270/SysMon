const fs=require('node:fs');const path=require('node:path');
const layouts=['radial','bars','numerals'];
function loadSettings(file){try{const r=JSON.parse(fs.readFileSync(file,'utf8'));return {layout:layouts.includes(r.layout)?r.layout:'radial',displayId:Number.isInteger(r.displayId)?r.displayId:null};}catch{return {layout:'radial',displayId:null};}}
function saveSettings(file,settings){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(settings),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function chooseDisplay(displays,primaryId,savedId){return displays.find(d=>d.id===savedId)||displays.find(d=>d.id!==primaryId)||displays[0];}
// Window placement policy: 2+ displays -> kiosk fullscreen on the remembered
// (or first non-primary) display; 1 or 0 connected displays -> normal framed
// window. `remember` is true only when a fullscreen target was picked without
// matching the saved preference, so falling back to a remaining display never
// overwrites the remembered (temporarily absent) display id.
function resolvePlacement(displays,primaryId,savedId){if(!displays.length)return{mode:'normal',display:null,remember:false};if(displays.length===1)return{mode:'normal',display:displays[0],remember:false};const d=displays.find(x=>x.id===savedId)||displays.find(x=>x.id!==primaryId)||displays[0];return{mode:'fullscreen',display:d,remember:savedId==null};}
// Center a window of the given size inside the work area, clamped to fit.
function fitWindowBounds(workArea,width,height){const w=Math.min(workArea.width,Math.max(320,width)),h=Math.min(workArea.height,Math.max(200,height));return{x:workArea.x+Math.round((workArea.width-w)/2),y:workArea.y+Math.round((workArea.height-h)/2),width:w,height:h};}
module.exports={layouts,loadSettings,saveSettings,chooseDisplay,resolvePlacement,fitWindowBounds};
