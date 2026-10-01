'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sysmon', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  settings: () => ipcRenderer.invoke('settings'),
  layout: layout => ipcRenderer.invoke('layout', layout),
  displays: () => ipcRenderer.invoke('displays'),
  selectDisplay: id => ipcRenderer.invoke('display', id),
  connectGrok: () => ipcRenderer.invoke('connect-grok'),
  connectClaude: hostId => ipcRenderer.invoke('connect-claude', hostId),
  openCi: url => ipcRenderer.invoke('open-ci', url),
  testDisplays: (list, opts) => ipcRenderer.invoke('test:displays', list, opts),
  testRealDisplays: () => ipcRenderer.invoke('test:real-displays'),
  testPlacement: () => ipcRenderer.invoke('test:placement'),
  testGrokLaunches: () => ipcRenderer.invoke('test:grok-launches'),
  testClaudeLogins: () => ipcRenderer.invoke('test:claude-logins'),
  onUpdate: fn => { const listener = (_, s) => fn(s); ipcRenderer.on('update', listener); return () => ipcRenderer.removeListener('update', listener); },
});
