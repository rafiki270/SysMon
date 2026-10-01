'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sysmon', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  settings: () => ipcRenderer.invoke('settings'),
  layout: layout => ipcRenderer.invoke('layout', layout),
  displays: () => ipcRenderer.invoke('displays'),
  selectDisplay: id => ipcRenderer.invoke('display', id),
  connectGrok: () => ipcRenderer.invoke('connect-grok'),
  openCi: url => ipcRenderer.invoke('open-ci', url),
  testDisplays: list => ipcRenderer.invoke('test:displays', list),
  testRealDisplays: () => ipcRenderer.invoke('test:real-displays'),
  onUpdate: fn => { const listener = (_, s) => fn(s); ipcRenderer.on('update', listener); return () => ipcRenderer.removeListener('update', listener); },
});
