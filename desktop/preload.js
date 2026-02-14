const { contextBridge, ipcRenderer, clipboard } = require('electron');
const { marked } = require('marked');

marked.setOptions({ breaks: true, gfm: true });

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, (c) => map[c]);
}

function sanitizeHtml(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
}

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
  onConversationEvent: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop:conversation-event', listener);
    return () => ipcRenderer.removeListener('desktop:conversation-event', listener);
  },
  renderMarkdown: (text) => {
    try {
      return sanitizeHtml(marked.parse(String(text || '')));
    } catch {
      return escapeHtml(text);
    }
  },
  copyText: (text) => {
    clipboard.writeText(String(text || ''));
    return true;
  },
  credentialSecurity: {
    getStatus: () => ipcRenderer.invoke('desktop:credentials:status'),
    secure: () => ipcRenderer.invoke('desktop:credentials:secure')
  },
  profiles: {
    list: () => ipcRenderer.invoke('desktop:profiles:list'),
    get: (id) => ipcRenderer.invoke('desktop:profiles:get', { id }),
    save: (profile) => ipcRenderer.invoke('desktop:profiles:save', { profile }),
    delete: (id) => ipcRenderer.invoke('desktop:profiles:delete', { id }),
    setActive: (id) => ipcRenderer.invoke('desktop:profiles:set-active', { id }),
    pickAvatar: (profileId) => ipcRenderer.invoke('desktop:profiles:pick-avatar', { profileId }),
    migrate: (legacyState) => ipcRenderer.invoke('desktop:profiles:migrate', { legacyState })
  }
});
