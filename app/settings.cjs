const fs=require('node:fs');const path=require('node:path');
const layouts=['radial','bars','numerals'];
function loadSettings(file){try{const r=JSON.parse(fs.readFileSync(file,'utf8'));return {layout:layouts.includes(r.layout)?r.layout:'radial',displayId:Number.isInteger(r.displayId)?r.displayId:null};}catch{return {layout:'radial',displayId:null};}}
function saveSettings(file,settings){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(settings),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function chooseDisplay(displays,primaryId,savedId){return displays.find(d=>d.id===savedId)||displays.find(d=>d.id!==primaryId)||displays[0];}
module.exports={layouts,loadSettings,saveSettings,chooseDisplay};
