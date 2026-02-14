const { contextBridge, ipcRenderer, clipboard } = require('electron');
let marked = null;
try {
  ({ marked } = require('marked'));
} catch {
  // In sandboxed preload, third-party npm modules may be unavailable.
  // We fall back to a minimal local markdown renderer below.
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, (c) => map[c]);
}

function blockedImageSpan(altText, srcText, titleText) {
  const alt = (altText || '').trim() || 'image';
  const src = (srcText || '').trim();
  const label = src ? `${alt} - ${src}` : alt;
  const title = (titleText || '').trim() || 'External images blocked';
  return `<span class="md-image-blocked" title="${title}">[blocked ${label}]</span>`;
}

function renderInlineMarkdown(raw) {
  let html = escapeHtml(raw);

  // Block markdown image syntax: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => blockedImageSpan(alt, src, 'External images blocked'));

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" rel="noreferrer noopener">${label}</a>`;
  });

  // Inline code / emphasis
  html = html
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  const paragraphs = html
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`);

  return paragraphs.join('');
}

function fallbackMarkdownToHtml(text) {
  const source = String(text || '');
  const parts = source.split(/```/);
  let out = '';

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += `<pre><code>${escapeHtml(parts[i])}</code></pre>`;
    } else {
      out += renderInlineMarkdown(parts[i]);
    }
  }

  return out;
}

if (marked && typeof marked.Renderer === 'function') {
  // Custom renderer that escapes any raw HTML in markdown source —
  // agent output is untrusted, so no raw HTML tags should survive.
  const renderer = new marked.Renderer();
  renderer.html = (html) => escapeHtml(typeof html === 'string' ? html : html?.text || html?.raw || '');

  // Block markdown image rendering entirely for untrusted agent output.
  // This prevents silent network requests (tracking pixels / SSRF probes) from ![](...) payloads.
  renderer.image = (href, title, text) => {
    const token = href && typeof href === 'object' ? href : null;
    const src = token ? token.href : href;
    const alt = token ? token.text : text;
    const effectiveTitle = token ? token.title : title;
    return blockedImageSpan(escapeHtml(alt), escapeHtml(src), escapeHtml(effectiveTitle));
  };

  marked.setOptions({ breaks: true, gfm: true, renderer });
}

function renderMarkdownUntrusted(text) {
  const source = String(text || '');
  if (marked) {
    try {
      return sanitizeHtml(marked.parse(source));
    } catch {
      // Fall through to minimal renderer.
    }
  }
  return sanitizeHtml(fallbackMarkdownToHtml(source));
}

/**
 * Defense-in-depth sanitizer for marked output.
 * Strips: <script>, ALL event handlers (quoted, unquoted, backtick-quoted),
 * <iframe>, <object>, <embed>, <form>, <style>, <link>, <base>, <meta>, <img>,
 * and javascript:/data: URL schemes in href/src attributes.
 */
function sanitizeHtml(html) {
  return html
    // Dangerous tags
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?(?:script|iframe|object|embed|form|style|link|base|meta|img)\b[^>]*>/gi, '')
    // Event handlers: on*= with any quoting (double, single, backtick, or unquoted)
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s>]+)/gi, '')
    // Dangerous URL schemes in link/image attributes
    .replace(/\s(href|src)\s*=\s*"[\s]*(?:javascript:|data:)[^"]*"/gi, ' $1="#blocked:"')
    .replace(/\s(href|src)\s*=\s*'[\s]*(?:javascript:|data:)[^']*'/gi, ' $1="#blocked:"')
    .replace(/\s(href|src)\s*=\s*`[\s]*(?:javascript:|data:)[^`]*`/gi, ' $1="#blocked:"')
    .replace(/\s(href|src)\s*=\s*(?:javascript:|data:)[^\s>]+/gi, ' $1="#blocked:"');
}

contextBridge.exposeInMainWorld('commandsDesktop', {
  saveJson: (payload) => ipcRenderer.invoke('desktop:save-json', payload),
  openUrl: (url) => ipcRenderer.invoke('desktop:open-url', url),
  pickDirectory: (payload) => ipcRenderer.invoke('desktop:pick-directory', payload),
  settings: {
    get: () => ipcRenderer.invoke('desktop:settings:get'),
    save: (settings) => ipcRenderer.invoke('desktop:settings:save', { settings }),
  },
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
      return renderMarkdownUntrusted(text);
    } catch {
      return escapeHtml(text);
    }
  },
  copyText: (text) => {
    clipboard.writeText(String(text || ''));
    return true;
  },
  auth: {
    signIn: () => ipcRenderer.invoke('desktop:auth:sign-in'),
    signOut: () => ipcRenderer.invoke('desktop:auth:sign-out'),
    getStatus: () => ipcRenderer.invoke('desktop:auth:status'),
    onAuthChanged: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('desktop:auth-changed', listener);
      return () => ipcRenderer.removeListener('desktop:auth-changed', listener);
    },
  },
  gateway: {
    fetchDevices: () => ipcRenderer.invoke('desktop:gateway:devices'),
    startSession: (deviceId) => ipcRenderer.invoke('desktop:gateway:start-session', { deviceId }),
    sendMessage: (deviceId, text) => ipcRenderer.invoke('desktop:gateway:send-message', { deviceId, text }),
    endSession: (deviceId) => ipcRenderer.invoke('desktop:gateway:end-session', { deviceId }),
    onDeviceEvent: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('desktop:gateway-device-event', listener);
      return () => ipcRenderer.removeListener('desktop:gateway-device-event', listener);
    },
    onChatEvent: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('desktop:gateway-chat-event', listener);
      return () => ipcRenderer.removeListener('desktop:gateway-chat-event', listener);
    },
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
