const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('sysmon',{
 snapshot:()=>ipcRenderer.invoke('snapshot'),
 settings:()=>ipcRenderer.invoke('settings'),
 layout:layout=>ipcRenderer.invoke('layout',layout),
 connectGrok:()=>ipcRenderer.invoke('connect-grok'),
 openCi:url=>ipcRenderer.invoke('open-ci',url),
 onUpdate:fn=>{const listener=(_,s)=>fn(s);ipcRenderer.on('update',listener);return ()=>ipcRenderer.removeListener('update',listener);}
});
