const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('commandsDesktop', {
  saveJson: (payload) => ipcRenderer.invoke('desktop:save-json', payload),
  openUrl: (url) => ipcRenderer.invoke('desktop:open-url', url),
  pickDirectory: (payload) => ipcRenderer.invoke('desktop:pick-directory', payload),
  readAuditLog: (payload) => ipcRenderer.invoke('desktop:audit:read', payload),
  startAgent: (payload) => ipcRenderer.invoke('desktop:agent:start', payload),
  stopAgent: (payload) => ipcRenderer.invoke('desktop:agent:stop', payload),
  getAgentStatus: () => ipcRenderer.invoke('desktop:agent:status'),
  onAgentLog: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop:agent-log', listener);
    return () => ipcRenderer.removeListener('desktop:agent-log', listener);
  },
  onAgentStatus: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop:agent-status', listener);
    return () => ipcRenderer.removeListener('desktop:agent-status', listener);
  },
  copyText: (text) => {
    clipboard.writeText(String(text || ''));
    return true;
  },
  credentialSecurity: {
    getStatus: () => ipcRenderer.invoke('desktop:credentials:status'),
    secure: () => ipcRenderer.invoke('desktop:credentials:secure')
  }
});
