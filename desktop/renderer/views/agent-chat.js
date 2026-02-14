/**
 * agent-chat.js — Chat interface for shared agents (E2E encrypted)
 *
 * Renders a full-height chat layout: header, scrollable messages, input area.
 * Agent markdown is untrusted — sanitized via preload's renderMarkdown + URL scheme blocking.
 */

import {
  escapeHtml, botIconSvg, sharedAgentsState, chatState, processChatEvent,
} from '../state.js';
import { renderMarkdownUntrusted } from '../markdown.js';

const chatDrafts = new Map(); // deviceId -> unsent textarea draft
const sessionStartInFlight = new Set(); // deviceIds with auto-start in progress
const chatRenderMeta = new Map(); // deviceId -> { messageCount, lastMessageKey }

// Block javascript: and data: URL schemes in rendered HTML
function sanitizeUrls(html) {
  return html
    .replace(/href\s*=\s*["']?\s*javascript:/gi, 'href="#blocked:')
    .replace(/href\s*=\s*["']?\s*data:/gi, 'href="#blocked:')
    .replace(/src\s*=\s*["']?\s*javascript:/gi, 'src="#blocked:')
    .replace(/src\s*=\s*["']?\s*data:/gi, 'src="#blocked:');
}

function renderMarkdownSafe(text) {
  try {
    const html = renderMarkdownUntrusted(text);
    return sanitizeUrls(html);
  } catch {
    return escapeHtml(text);
  }
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function getDevice(deviceId) {
  return sharedAgentsState.devices.find((d) => d.device_id === deviceId);
}

function getChat(deviceId) {
  return chatState.get(deviceId) || { status: 'idle', messages: [], conversationId: null };
}

function getDraft(deviceId) {
  return chatDrafts.get(deviceId) || '';
}

function setDraft(deviceId, value) {
  const text = String(value || '').slice(0, 100_000);
  if (text) {
    chatDrafts.set(deviceId, text);
  } else {
    chatDrafts.delete(deviceId);
  }
}

function syncDraftFromDom(container, fallbackDeviceId) {
  if (!container) return;
  const input = container.querySelector('#chat-input');
  if (!input) return;
  const sourceDeviceId =
    (typeof input.dataset.deviceId === 'string' && input.dataset.deviceId.trim())
      ? input.dataset.deviceId.trim()
      : (typeof fallbackDeviceId === 'string' ? fallbackDeviceId : '');
  if (!sourceDeviceId) return;
  setDraft(sourceDeviceId, input.value);
}

function autoSizeTextarea(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

function lastMessageKey(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const last = messages[messages.length - 1];
  return `${last.role || ''}|${last.messageId || ''}|${last.ts || ''}|${String(last.text || '').length}`;
}

export function renderAgentChat(container, deviceId) {
  if (!container) return;
  syncDraftFromDom(container, deviceId);
  const previousMessagesEl = container.querySelector('#chat-messages');
  const previousScroll = previousMessagesEl
    ? {
      top: previousMessagesEl.scrollTop,
      nearBottom: previousMessagesEl.scrollTop + previousMessagesEl.clientHeight >= previousMessagesEl.scrollHeight - 24,
    }
    : null;

  const device = getDevice(deviceId);
  const chat = getChat(deviceId);
  const previousMeta = chatRenderMeta.get(deviceId) || { messageCount: 0, lastMessageKey: '' };
  const currentMessageCount = chat.messages.length;
  const currentLastMessageKey = lastMessageKey(chat.messages);
  const hasNewMessage =
    currentMessageCount > previousMeta.messageCount ||
    (currentMessageCount === previousMeta.messageCount && currentLastMessageKey !== previousMeta.lastMessageKey);
  const draft = getDraft(deviceId);
  const deviceName = device?.name || device?.device_id || deviceId;
  const deviceOnline = device?.status === 'online';
  const sessionReady = chat.status === 'ready';
  const isProcessing = chat.status === 'processing';
  const isConnecting = chat.status === 'handshaking';
  const isSessionError = chat.status === 'error';
  const isEnded = chat.status === 'ended' || isSessionError;
  // Allow sending while processing so users can compose/send follow-ups.
  // Error state still allows send to trigger reconnect.
  const canSend = (sessionReady || isProcessing || isSessionError) && deviceOnline;

  // Build messages HTML
  let messagesHtml = '';
  if (chat.messages.length === 0 && !isConnecting) {
    messagesHtml = `
      <div class="chat-empty">
        <p>No messages yet. Send a message to start chatting.</p>
      </div>
    `;
  } else {
    messagesHtml = chat.messages.map((msg) => {
      if (msg.role === 'user') {
        return `
          <div class="message-bubble chat-user">
            <div class="message-content">${escapeHtml(msg.text)}</div>
            <div class="message-ts">${formatTime(msg.ts)}</div>
          </div>
        `;
      } else if (msg.role === 'assistant') {
        return `
          <div class="message-bubble chat-assistant">
            <div class="message-content agent-prose">${renderMarkdownSafe(msg.text)}</div>
            <div class="message-ts">${formatTime(msg.ts)}</div>
          </div>
        `;
      } else if (msg.role === 'error') {
        return `
          <div class="message-bubble error">
            <div class="message-content">${escapeHtml(msg.text)}</div>
            <div class="message-ts">${formatTime(msg.ts)}</div>
          </div>
        `;
      }
      return '';
    }).join('');
  }

  // Processing indicator
  if (chat.status === 'processing') {
    messagesHtml += `
      <div class="message-processing">
        <span class="processing-dots">Agent is thinking</span>
      </div>
    `;
  }

  // Connecting indicator
  if (isConnecting) {
    messagesHtml += `
      <div class="chat-connecting">
        <div class="chat-connecting-spinner"></div>
        <span>Connecting to agent...</span>
      </div>
    `;
  }

  // Status banner
  let statusBanner = '';
  if (isSessionError) {
    statusBanner = `<div class="chat-status-banner error">Session expired — send a message to reconnect, or <button class="chat-reconnect-btn" id="chat-reconnect">reconnect now</button></div>`;
  } else if (isEnded) {
    statusBanner = `<div class="chat-status-banner ended">Session ended. <button class="chat-reconnect-btn" id="chat-reconnect">Reconnect</button></div>`;
  } else if (!deviceOnline && !isConnecting) {
    statusBanner = `<div class="chat-status-banner offline">Agent is offline</div>`;
  }

  container.innerHTML = `
    <div class="chat-layout">
      <div class="chat-header">
        <div class="chat-header-info">
          <div class="chat-header-avatar">${botIconSvg(28, deviceName)}</div>
          <div>
            <div class="chat-header-name">${escapeHtml(deviceName)}</div>
            <div class="chat-header-status">
              <span class="status-dot${deviceOnline ? ' running' : ''}"></span>
              ${deviceOnline ? 'Online' : 'Offline'}
              ${isConnecting ? ' — Connecting...' : ''}
              ${sessionReady ? ' — Connected' : ''}
            </div>
          </div>
        </div>
        <div class="chat-header-actions">
          ${(sessionReady || isConnecting || isProcessing) ? '<button class="danger" id="chat-disconnect">Disconnect</button>' : ''}
          <button id="chat-back">Back</button>
        </div>
      </div>
      ${statusBanner}
      <div class="chat-messages" id="chat-messages">
        ${messagesHtml}
      </div>
      <div class="chat-input-area">
          <textarea
            id="chat-input"
            data-device-id="${escapeHtml(deviceId)}"
            class="chat-textarea"
            placeholder="${canSend ? 'Type a message...' : (isConnecting ? 'Connecting...' : 'Agent unavailable')}"
            rows="1"
            ${canSend ? '' : 'disabled'}
        >${escapeHtml(draft)}</textarea>
        <button class="primary chat-send-btn" id="chat-send" ${canSend ? '' : 'disabled'}>Send</button>
      </div>
    </div>
  `;

  // Auto-scroll only when new messages arrive or the user was already near bottom.
  const messagesEl = container.querySelector('#chat-messages');
  if (messagesEl) {
    if (!previousScroll || hasNewMessage || previousScroll.nearBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      const maxTop = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
      messagesEl.scrollTop = Math.min(previousScroll.top, maxTop);
    }
  }
  chatRenderMeta.set(deviceId, { messageCount: currentMessageCount, lastMessageKey: currentLastMessageKey });

  // Auto-start session if not connected and device is online
  if ((chat.status === 'idle') && deviceOnline && !sessionStartInFlight.has(deviceId)) {
    sessionStartInFlight.add(deviceId);
    window.commandsDesktop.gateway.startSession(deviceId)
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        sessionStartInFlight.delete(deviceId);
      });
  }

  // Wire up event handlers
  wireUpChatEvents(container, deviceId);
}

function wireUpChatEvents(container, deviceId) {
  const input = container.querySelector('#chat-input');
  const sendBtn = container.querySelector('#chat-send');
  const backBtn = container.querySelector('#chat-back');
  const disconnectBtn = container.querySelector('#chat-disconnect');
  const reconnectBtn = container.querySelector('#chat-reconnect');

  // Auto-resize textarea
  if (input) {
    input.addEventListener('input', () => {
      setDraft(deviceId, input.value);
      autoSizeTextarea(input);
    });
    autoSizeTextarea(input);

    // Enter to send, Shift+Enter for newline
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(deviceId, input);
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      sendMessage(deviceId, input);
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.__hub.setView('dashboard');
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => {
      window.commandsDesktop.gateway.endSession(deviceId);
    });
  }

  if (reconnectBtn) {
    reconnectBtn.addEventListener('click', () => {
      window.commandsDesktop.gateway.startSession(deviceId)
        .then(() => {})
        .catch(() => {});
    });
  }

  // Intercept link clicks in agent prose — open externally
  // Use link.href (resolved by browser, entities decoded) not getAttribute('href')
  // to prevent scheme bypass via HTML entity encoding (e.g. javascript&#58;)
  const messagesEl = container.querySelector('#chat-messages');
  if (messagesEl) {
    messagesEl.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const link = target ? target.closest('a') : null;
      if (link && link.href) {
        e.preventDefault();
        try {
          const parsed = new URL(link.href);
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
            window.commandsDesktop.openUrl(link.href);
          }
        } catch {
          // invalid URL — ignore
        }
      }
    });
  }
}

async function sendMessage(deviceId, inputEl) {
  if (!inputEl) return;
  const originalText = inputEl.value;
  const text = originalText.trim();
  if (!text) return;

  try {
    const result = await window.commandsDesktop.gateway.sendMessage(deviceId, text);
    if (!result?.ok) {
      emitLocalError(deviceId, result?.error);
      return;
    }

    // message.sent can re-render before this promise resolves, so prefer the live input.
    const liveInput = document.getElementById('main-panel')?.querySelector('#chat-input');
    const targetInput = liveInput || inputEl;

    // Clear only if user hasn't edited the draft while send was in-flight.
    if (targetInput.value === originalText) {
      targetInput.value = '';
      setDraft(deviceId, '');
    } else {
      setDraft(deviceId, targetInput.value);
    }
    autoSizeTextarea(targetInput);
  } catch (e) {
    emitLocalError(deviceId, e?.message);
    // Preserve draft on failure — resolve the live input (same pattern as success path).
    const liveErr = document.getElementById('main-panel')?.querySelector('#chat-input');
    const targetErr = liveErr || inputEl;
    if (!targetErr.value) {
      targetErr.value = originalText;
      setDraft(deviceId, originalText);
      autoSizeTextarea(targetErr);
    }
  }
}

export function clearAgentChatTransientState() {
  chatDrafts.clear();
  sessionStartInFlight.clear();
  chatRenderMeta.clear();
}

/** Push an error into chat state and re-render without round-tripping through IPC. */
function emitLocalError(deviceId, msg) {
  processChatEvent({ type: 'message.error', deviceId, error: msg || 'Unknown error' });
  reRenderChat(deviceId);
}

function reRenderChat(deviceId) {
  const container = document.getElementById('main-panel');
  if (container) renderAgentChat(container, deviceId);
}
