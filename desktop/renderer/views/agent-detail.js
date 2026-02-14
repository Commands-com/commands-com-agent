/**
 * agent-detail.js — Agent detail view: header, tabs, logs, settings, audit trail
 */

import {
  viewState, getProfile, invalidateProfileCache, loadProfiles,
  escapeHtml, formatModel, formatPermissions,
  botIconSvg, slugify, infoIcon, MODEL_OPTIONS, PERMISSION_OPTIONS,
  runtimeState, isProfileRunning, isAnyAgentRunning, runningProfileId,
  appendLog, clearLogs,
  auditState, resetAuditState, DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT, clamp,
  DEFAULT_GATEWAY_URL,
  conversationState, getSessionList, getSelectedSession,
} from '../state.js';
import { renderMarkdownUntrusted } from '../markdown.js';

// Block javascript: and data: URL schemes in rendered markdown HTML
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

const TABS = [
  { id: 'conversations', label: 'Live Conversations' },
  { id: 'logs', label: 'Logs' },
  { id: 'audit', label: 'Audit Trail' },
  { id: 'settings', label: 'Settings' },
];

let currentProfile = null;
let settingsSubTab = 'identity'; // identity | config | mcp | security

export async function renderAgentDetail(container, profileId) {
  if (!container || !profileId) return;

  const result = await getProfile(profileId);
  if (!result || !result.profile) {
    container.innerHTML = `<p style="color: var(--danger);">Profile not found.</p>`;
    return;
  }

  currentProfile = result.profile;
  const profile = result.profile;
  const hasAvatar = result.hasAvatar;
  const avatarPath = result.avatarPath;
  const running = isProfileRunning(profileId);
  const anyRunning = isAnyAgentRunning();
  const canStart = !anyRunning;
  const rpId = runningProfileId();
  const runningOther = anyRunning && rpId !== profileId;
  const runningName = runningOther ? '' : ''; // could look up name if needed

  // Tab bar
  const activeTab = viewState.agentDetailTab || 'conversations';
  const tabHtml = TABS.map((t) =>
    `<button class="tab-btn${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');

  // Running banner
  const bannerHtml = running
    ? `<div class="running-banner">
        <div class="status-dot running"></div>
        Running (PID ${runtimeState.status.pid || '?'})
       </div>`
    : '';

  // Error banner (shown when agent exited with a known error)
  const lastError = !running && runtimeState.status.lastError ? runtimeState.status.lastError : '';
  const errorBannerHtml = lastError
    ? `<div class="error-banner">${escapeHtml(lastError)}</div>`
    : '';

  // Start/Stop button
  let startStopHtml;
  if (running) {
    startStopHtml = `
      <button class="danger" id="stop-agent-btn">Stop Agent</button>
      <button id="force-stop-btn" style="font-size: 12px;">Force Stop</button>
    `;
  } else {
    const disabled = runningOther ? 'disabled' : '';
    const tooltip = runningOther ? 'data-tooltip="Stop the other agent first"' : '';
    startStopHtml = `<button class="success" id="start-agent-btn" ${disabled} ${tooltip}>Start Agent</button>`;
  }

  container.innerHTML = `
    ${bannerHtml}
    ${errorBannerHtml}
    <div class="detail-header">
      <div class="avatar-circle lg">
        ${hasAvatar ? `<img src="file://${escapeHtml(avatarPath)}" alt="" />` : botIconSvg(48, profile.name)}
      </div>
      <div class="detail-header-info">
        <h2>${escapeHtml(profile.name)}</h2>
        <div class="detail-header-meta">
          <span>${escapeHtml(formatModel(profile.model))}</span>
          <span>${escapeHtml(formatPermissions(profile.permissions))}</span>
          ${profile.workspace ? `<span>${escapeHtml(profile.workspace)}</span>` : ''}
        </div>
      </div>
      <div class="detail-header-actions">
        ${startStopHtml}
        <button class="danger" id="delete-agent-btn" ${running ? 'disabled' : ''}>Delete</button>
      </div>
    </div>

    <div class="tab-bar" id="detail-tab-bar">${tabHtml}</div>
    <div id="tab-content"></div>
  `;

  // Render active tab content
  renderTabContent(container.querySelector('#tab-content'), activeTab, profile, { hasAvatar, avatarPath });

  // Wire up tab bar
  container.querySelector('#detail-tab-bar')?.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const btn = target ? target.closest('[data-tab]') : null;
    if (!btn) return;
    viewState.agentDetailTab = btn.dataset.tab;
    renderAgentDetail(container, profileId);
  });

  // Wire up Start
  container.querySelector('#start-agent-btn')?.addEventListener('click', async () => {
    await startAgent(profile);
  });

  // Wire up Stop
  container.querySelector('#stop-agent-btn')?.addEventListener('click', async () => {
    await stopAgent(false);
  });

  container.querySelector('#force-stop-btn')?.addEventListener('click', async () => {
    await stopAgent(true);
  });

  // Wire up Delete
  container.querySelector('#delete-agent-btn')?.addEventListener('click', async () => {
    if (running) return;
    const confirmed = confirm(`Delete agent "${profile.name}"? This cannot be undone.`);
    if (!confirmed) return;

    const result = await window.commandsDesktop.profiles.delete(profileId);
    if (result.ok) {
      invalidateProfileCache(profileId);
      await loadProfiles();
      window.__hub.setView('dashboard');
    } else {
      alert(result.error || 'Failed to delete profile.');
    }
  });
}

// ---------------------------------------------------------------------------
// Tab content rendering
// ---------------------------------------------------------------------------

function renderTabContent(container, tab, profile, extra = {}) {
  if (!container) return;

  switch (tab) {
    case 'conversations':
      renderConversationsTab(container);
      break;
    case 'logs':
      renderLogsTab(container);
      break;
    case 'audit':
      renderAuditTab(container, profile);
      break;
    case 'settings':
      renderSettingsTab(container, profile, extra);
      break;
  }
}

// ---------------------------------------------------------------------------
// Conversations tab
// ---------------------------------------------------------------------------

function formatTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return isoString;
  }
}

function truncate(str, len) {
  if (!str || str.length <= len) return str || '';
  return str.slice(0, len) + '...';
}

function renderConversationsTab(container) {
  const sessions = getSessionList();
  const running = runtimeState.status.running;

  if (sessions.length === 0) {
    container.innerHTML = `
      <div class="conversations-empty">
        <p>${running
          ? 'No conversations yet. Waiting for incoming messages...'
          : 'No conversations. Start the agent and connect from commands.com to see live conversations here.'
        }</p>
      </div>
    `;
    return;
  }

  // Build session list
  const selectedId = conversationState.selectedSessionId;
  const sessionListHtml = sessions.map((s) => {
    const active = s.sessionId === selectedId;
    const msgCount = s.messages.length;
    const userMsgCount = s.messages.filter((m) => m.role === 'user').length;
    const statusCls = s.status === 'ended' ? 'ended' : 'active';
    const lastMsg = s.messages[s.messages.length - 1];
    const preview = lastMsg ? truncate(lastMsg.text, 60) : '';
    const requester = s.requesterUid ? truncate(s.requesterUid, 20) : 'Unknown';
    // Check if the last user message has no response yet
    const isProcessing = lastMsg?.role === 'user';

    return `
      <div class="session-card ${active ? 'selected' : ''}" data-session-id="${escapeHtml(s.sessionId)}">
        <div class="session-card-head">
          <span class="session-requester">${escapeHtml(requester)}</span>
          <span class="session-status ${statusCls}"></span>
        </div>
        <div class="session-card-time">${formatTime(s.startedAt)}</div>
        <div class="session-card-preview">${isProcessing ? '<span class="processing-indicator">Processing...</span>' : escapeHtml(preview)}</div>
        <div class="session-card-meta">${userMsgCount} message${userMsgCount !== 1 ? 's' : ''}</div>
      </div>
    `;
  }).join('');

  // Build message thread
  const selected = getSelectedSession();
  let threadHtml;

  if (!selected) {
    threadHtml = '<div class="thread-empty"><p>Select a session to view messages.</p></div>';
  } else {
    const messagesHtml = selected.messages.map((m) => {
      if (m.role === 'user') {
        return `
          <div class="message-bubble user">
            <div class="message-content">${escapeHtml(m.text)}</div>
            <div class="message-ts">${formatTime(m.ts)}</div>
          </div>
        `;
      }
      if (m.role === 'assistant') {
        const renderedText = renderMarkdownSafe(m.text);
        const meta = [];
        if (m.turns) meta.push(`${m.turns} turn${m.turns !== 1 ? 's' : ''}`);
        if (m.model) meta.push(m.model);
        if (m.costUsd) meta.push(`$${m.costUsd.toFixed(4)}`);
        const metaHtml = meta.length > 0
          ? `<div class="message-meta">${escapeHtml(meta.join(' · '))}</div>`
          : '';
        return `
          <div class="message-bubble assistant">
            <div class="message-content agent-prose">${renderedText}</div>
            ${metaHtml}
            <div class="message-ts">${formatTime(m.ts)}</div>
          </div>
        `;
      }
      if (m.role === 'error') {
        return `
          <div class="message-bubble error">
            <div class="message-content">${escapeHtml(m.text)}</div>
            <div class="message-ts">${formatTime(m.ts)}</div>
          </div>
        `;
      }
      return '';
    }).join('');

    // Check if processing (last message is user with no response)
    const lastMsg = selected.messages[selected.messages.length - 1];
    const processingHtml = lastMsg?.role === 'user'
      ? '<div class="message-processing"><span class="processing-dots"></span> Agent is thinking...</div>'
      : '';

    threadHtml = `
      <div class="thread-header">
        <span class="thread-requester">${escapeHtml(selected.requesterUid || 'Unknown')}</span>
        <span class="thread-session-id">${escapeHtml(truncate(selected.sessionId, 16))}</span>
      </div>
      <div class="thread-messages" id="thread-messages">
        ${messagesHtml}
        ${processingHtml}
      </div>
    `;
  }

  container.innerHTML = `
    <div class="conversations-layout">
      <div class="session-list" id="session-list">
        <div class="session-list-header">Sessions (${sessions.length})</div>
        ${sessionListHtml}
      </div>
      <div class="message-thread">
        ${threadHtml}
      </div>
    </div>
  `;

  // Auto-scroll message thread to bottom
  const threadEl = container.querySelector('#thread-messages');
  if (threadEl) {
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  // Wire up external link clicks in rendered markdown
  // Use a.href (resolved by browser) not getAttribute('href') to prevent
  // scheme bypass via HTML entity encoding (e.g. javascript&#58;)
  container.querySelectorAll('.agent-prose a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        const parsed = new URL(a.href);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
          window.commandsDesktop.openUrl(a.href);
        }
      } catch {
        // invalid URL — ignore
      }
    });
  });

  // Wire up session selection
  container.querySelector('#session-list')?.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const card = target ? target.closest('[data-session-id]') : null;
    if (!card) return;
    conversationState.selectedSessionId = card.dataset.sessionId;
    renderConversationsTab(container);
  });
}

// ---------------------------------------------------------------------------
// Logs tab
// ---------------------------------------------------------------------------

function renderLogsTab(container) {
  const logs = runtimeState.logs;

  const linesHtml = logs.map((entry) => {
    const stream = entry.stream || 'stdout';
    const cls = stream === 'stderr' ? 'stderr' : stream === 'system' ? 'system' : '';
    return `
      <div class="agent-log-line ${cls}">
        <span class="ts">${escapeHtml(entry.ts || '')}</span>
        <span class="stream">${escapeHtml(stream)}</span>
        <span class="msg">${escapeHtml(entry.message || '')}</span>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="row" style="margin-bottom: 8px;">
      <span style="font-size: 12px; color: var(--muted);">${logs.length} log entries</span>
      <button id="clear-logs-btn" style="font-size: 12px;">Clear Logs</button>
    </div>
    <div class="agent-log" id="agent-log-container">
      <div class="agent-log-lines">${linesHtml || '<p style="color: var(--muted); padding: 12px; font-size: 12px;">No logs yet. Start the agent to see output.</p>'}</div>
    </div>
  `;

  // Auto-scroll to bottom
  const logContainer = container.querySelector('#agent-log-container');
  if (logContainer) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  container.querySelector('#clear-logs-btn')?.addEventListener('click', () => {
    clearLogs();
    renderLogsTab(container);
  });
}

// ---------------------------------------------------------------------------
// Audit Trail tab (placeholder — wired up in Step 8b)
// ---------------------------------------------------------------------------

function renderAuditTab(container, profile) {
  container.innerHTML = `
    <div id="audit-content">
      <p style="color: var(--muted); font-size: 13px;">Loading audit trail...</p>
    </div>
  `;

  // Load audit entries
  loadAuditEntries(container, profile);
}

async function loadAuditEntries(container, profile) {
  const auditLogPath = profile.auditLogPath || '';
  const filters = auditState.filters;

  const payload = {
    profileId: profile.id,
    auditLogPath,
    limit: filters.limit,
    search: filters.search,
    requester: filters.requester,
    sessionId: filters.sessionId,
    event: filters.event,
    from: filters.from,
    to: filters.to,
  };

  const result = await window.commandsDesktop.readAuditLog(payload);
  const auditContent = container.querySelector('#audit-content');
  if (!auditContent) return;

  if (!result.ok) {
    auditContent.innerHTML = `<p style="color: var(--danger); font-size: 12px;">Error: ${escapeHtml(result.error || 'Failed to read audit log')}</p>`;
    return;
  }

  auditState.entries = result.entries || [];
  auditState.requesterUids = result.requester_uids || [];
  auditState.summary = result.summary || null;
  auditState.auditLogPath = result.auditLogPath || '';

  renderAuditContent(auditContent, profile);
}

function renderAuditContent(container, profile) {
  const { entries, summary, auditLogPath, filters, messagesOnly, requesterUids } = auditState;

  const requesterOpts = requesterUids.map((uid) =>
    `<option value="${escapeHtml(uid)}"${uid === filters.requester ? ' selected' : ''}>${escapeHtml(uid)}</option>`
  ).join('');

  const summaryText = summary
    ? `${summary.matches} matches / ${summary.parsedEntries} entries (${summary.returned} shown)`
    : '';

  container.innerHTML = `
    <div class="audit-filters">
      <label>
        <span>Search</span>
        <input type="text" id="audit-search" value="${escapeHtml(filters.search)}" placeholder="Filter..." />
      </label>
      <label>
        <span>Requester</span>
        <select id="audit-requester">
          <option value="">All</option>
          ${requesterOpts}
        </select>
      </label>
      <label>
        <span>Event Type</span>
        <input type="text" id="audit-event" value="${escapeHtml(filters.event)}" placeholder="e.g. message" />
      </label>
      <label>
        <span>Session ID</span>
        <input type="text" id="audit-session" value="${escapeHtml(filters.sessionId)}" placeholder="Filter by session" />
      </label>
      <label>
        <span>From</span>
        <input type="datetime-local" id="audit-from" value="${escapeHtml(filters.from)}" />
      </label>
      <label>
        <span>To</span>
        <input type="datetime-local" id="audit-to" value="${escapeHtml(filters.to)}" />
      </label>
      <label>
        <span>Limit</span>
        <input type="number" id="audit-limit" value="${filters.limit}" min="1" max="${MAX_AUDIT_LIMIT}" />
      </label>
    </div>

    <div class="row" style="margin-bottom: 8px;">
      <span class="audit-summary">${summaryText}</span>
      <div style="display: flex; gap: 8px;">
        <div class="audit-view-toggle">
          <div class="pill">
            <input type="checkbox" id="audit-messages-only" ${messagesOnly ? 'checked' : ''} />
            Messages Only
          </div>
        </div>
        <button id="audit-refresh-btn" style="font-size: 12px;">Refresh</button>
        <button id="audit-export-btn" style="font-size: 12px;">Export</button>
      </div>
    </div>

    <div class="audit-entries" id="audit-entries-list">
      ${renderAuditEntries(entries, messagesOnly)}
    </div>

    <p style="margin-top: 10px; font-size: 11px; color: var(--muted);">
      Path: ${escapeHtml(auditLogPath)}
    </p>
  `;

  // Wire up filter events
  const refresh = () => {
    auditState.filters.search = container.querySelector('#audit-search')?.value || '';
    auditState.filters.requester = container.querySelector('#audit-requester')?.value || '';
    auditState.filters.event = container.querySelector('#audit-event')?.value || '';
    auditState.filters.sessionId = container.querySelector('#audit-session')?.value || '';
    auditState.filters.from = container.querySelector('#audit-from')?.value || '';
    auditState.filters.to = container.querySelector('#audit-to')?.value || '';
    const limitVal = parseInt(container.querySelector('#audit-limit')?.value || DEFAULT_AUDIT_LIMIT, 10);
    auditState.filters.limit = Number.isFinite(limitVal) ? clamp(limitVal, 1, MAX_AUDIT_LIMIT) : DEFAULT_AUDIT_LIMIT;
    loadAuditEntries(container.parentElement, profile);
  };

  container.querySelector('#audit-refresh-btn')?.addEventListener('click', refresh);

  // Apply filters on Enter
  container.querySelectorAll('.audit-filters input, .audit-filters select').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') refresh();
    });
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', refresh);
    }
  });

  // Messages only toggle
  container.querySelector('#audit-messages-only')?.addEventListener('change', (e) => {
    auditState.messagesOnly = e.target.checked;
    const list = container.querySelector('#audit-entries-list');
    if (list) {
      list.innerHTML = renderAuditEntries(auditState.entries, auditState.messagesOnly);
      wireAuditEntryActions(list);
    }
  });

  // Export
  container.querySelector('#audit-export-btn')?.addEventListener('click', async () => {
    const data = JSON.stringify(auditState.entries, null, 2);
    await window.commandsDesktop.saveJson({
      defaultPath: 'audit-export.json',
      data,
    });
  });

  wireAuditEntryActions(container.querySelector('#audit-entries-list'));
}

function renderAuditEntries(entries, messagesOnly) {
  if (!entries || entries.length === 0) {
    return '<p class="audit-empty">No audit entries found.</p>';
  }

  return entries.map((entry, idx) => {
    const event = entry.event || 'unknown';
    const timestamp = entry.at || entry.received_at || '';
    const requester = entry.requester_uid || '';
    const sessionId = entry.session_id || '';

    if (messagesOnly) {
      // Show only prompt/response content
      const prompt = entry.prompt || entry.input || '';
      const response = entry.response || entry.output || '';
      if (!prompt && !response) return '';

      return `
        <div class="audit-entry" data-idx="${idx}">
          <div class="audit-entry-head">
            <span class="audit-event">${escapeHtml(event)}</span>
            <span class="audit-time">${escapeHtml(timestamp)}</span>
          </div>
          ${prompt ? `<div class="audit-prompt">${escapeHtml(prompt)}</div>` : ''}
          ${response ? `<div class="audit-prompt" style="border-color: rgba(16, 185, 129, 0.3);">${escapeHtml(response)}</div>` : ''}
        </div>
      `;
    }

    // Full view
    return `
      <div class="audit-entry" data-idx="${idx}">
        <div class="audit-entry-head">
          <span class="audit-event">${escapeHtml(event)}</span>
          <span class="audit-time">${escapeHtml(timestamp)}</span>
        </div>
        <div class="audit-meta">
          ${requester ? `Requester: <code>${escapeHtml(requester)}</code>` : ''}
          ${sessionId ? ` &middot; Session: <code>${escapeHtml(sessionId)}</code>` : ''}
        </div>
        ${entry.prompt ? `<div class="audit-prompt">${escapeHtml(entry.prompt)}</div>` : ''}
        <div class="audit-entry-actions row">
          ${entry.prompt ? `<button class="copy-prompt-btn" data-idx="${idx}" style="font-size: 11px;">Copy Prompt</button>` : ''}
          <details>
            <summary>Raw JSON</summary>
            <div class="audit-raw-json">${escapeHtml(JSON.stringify(entry, null, 2))}</div>
          </details>
        </div>
      </div>
    `;
  }).join('');
}

function wireAuditEntryActions(container) {
  if (!container) return;

  container.querySelectorAll('.copy-prompt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const entry = auditState.entries[idx];
      if (entry?.prompt) {
        window.commandsDesktop.copyText(entry.prompt);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Settings tab — sub-tabbed: Identity | Config | MCP | Security
// ---------------------------------------------------------------------------

const SETTINGS_SUB_TABS = [
  { id: 'identity', label: 'Identity' },
  { id: 'config', label: 'Configuration' },
  { id: 'mcp', label: 'MCP' },
  { id: 'security', label: 'Security' },
];

// In-memory form state that persists across settings sub-tab switches.
// Initialized from the profile when entering the settings tab, then updated
// from the DOM before each sub-tab switch so edits aren't lost.
let settingsFormState = {};

function initSettingsFormState(profile) {
  settingsFormState = {
    name: profile.name || '',
    deviceName: profile.deviceName || '',
    deviceNameManuallySet: profile.deviceNameManuallySet || false,
    systemPrompt: profile.systemPrompt || '',
    workspace: profile.workspace || '',
    model: profile.model || 'sonnet',
    permissions: profile.permissions || 'dev-safe',
    gatewayUrl: profile.gatewayUrl || '',
    auditLogPath: profile.auditLogPath || '',
    mcpServers: profile.mcpServers || '',
    mcpFilesystemEnabled: profile.mcpFilesystemEnabled || false,
    mcpFilesystemRoot: profile.mcpFilesystemRoot || '',
  };
}

function captureSettingsValues(container) {
  switch (settingsSubTab) {
    case 'identity': {
      const n = container.querySelector('#s-name');
      if (n) settingsFormState.name = n.value.trim();
      const dn = container.querySelector('#s-device-name');
      if (dn) settingsFormState.deviceName = dn.value.trim();
      const sp = container.querySelector('#s-system-prompt');
      if (sp) settingsFormState.systemPrompt = sp.value;
      const ws = container.querySelector('#s-workspace');
      if (ws) settingsFormState.workspace = ws.value.trim();
      const autoSlug = slugify(settingsFormState.name);
      settingsFormState.deviceNameManuallySet = settingsFormState.deviceName !== autoSlug;
      break;
    }
    case 'config': {
      const m = container.querySelector('#s-model');
      if (m) settingsFormState.model = m.value;
      const p = container.querySelector('#s-permissions');
      if (p) settingsFormState.permissions = p.value;
      const gw = container.querySelector('#s-gateway-url');
      if (gw) settingsFormState.gatewayUrl = gw.value.trim();
      const al = container.querySelector('#s-audit-path');
      if (al) settingsFormState.auditLogPath = al.value.trim();
      break;
    }
    case 'mcp': {
      const fs = container.querySelector('#s-mcp-fs-enabled');
      if (fs) settingsFormState.mcpFilesystemEnabled = fs.checked;
      const fr = container.querySelector('#s-mcp-fs-root');
      if (fr) settingsFormState.mcpFilesystemRoot = fr.value.trim();
      const ms = container.querySelector('#s-mcp-servers');
      if (ms) settingsFormState.mcpServers = ms.value;
      break;
    }
  }
}

function renderSettingsTab(container, profile, extra = {}, _internal = false) {
  // Initialize form state from profile on first entry (not on internal sub-tab switches)
  if (!_internal) {
    initSettingsFormState(profile);
  }

  const subTabHtml = SETTINGS_SUB_TABS.map((t) =>
    `<button class="tab-btn${t.id === settingsSubTab ? ' active' : ''}" data-settings-tab="${t.id}">${t.label}</button>`
  ).join('');

  container.innerHTML = `
    <div class="tab-bar sub-tab-bar" id="settings-sub-tabs">${subTabHtml}</div>
    <div id="settings-sub-content"></div>
    <div style="margin-top: 16px; display: flex; align-items: center; gap: 12px;">
      <button class="primary" id="save-settings-btn">Save Changes</button>
      <span id="settings-saved-msg" class="hint" style="color: var(--ok);"></span>
      <span id="settings-error-msg" class="hint" style="color: var(--danger);"></span>
    </div>
  `;

  renderSettingsSubContent(container.querySelector('#settings-sub-content'), profile, extra);

  // Sub-tab switching — capture current DOM values before switching
  container.querySelector('#settings-sub-tabs')?.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const btn = target ? target.closest('[data-settings-tab]') : null;
    if (!btn) return;
    captureSettingsValues(container);
    settingsSubTab = btn.dataset.settingsTab;
    renderSettingsTab(container, profile, extra, true);
  });

  // Save all settings
  container.querySelector('#save-settings-btn')?.addEventListener('click', async () => {
    const errorEl = container.querySelector('#settings-error-msg');
    const savedEl = container.querySelector('#settings-saved-msg');
    errorEl.textContent = '';
    savedEl.textContent = '';

    const payload = gatherSettingsPayload(container, profile);
    if (!payload.name || payload.name.trim() === '') {
      errorEl.textContent = 'Name is required.';
      return;
    }

    const result = await window.commandsDesktop.profiles.save(payload);
    if (result.ok) {
      invalidateProfileCache(profile.id);
      await loadProfiles();
      // Update currentProfile for re-renders without full navigation
      currentProfile = result.profile;
      savedEl.textContent = 'Saved.';
      setTimeout(() => { if (savedEl) savedEl.textContent = ''; }, 2000);
      // Refresh header by re-rendering the detail view
      const mainPanel = document.getElementById('main-panel');
      if (mainPanel) renderAgentDetail(mainPanel, profile.id);
    } else {
      errorEl.textContent = result.error || 'Failed to save.';
    }
  });
}

function gatherSettingsPayload(container, profile) {
  // Capture the active sub-tab's DOM values into settingsFormState first
  captureSettingsValues(container);

  // Build payload from settingsFormState (which accumulates edits across all sub-tabs)
  return {
    id: profile.id,
    name: settingsFormState.name,
    deviceName: settingsFormState.deviceName,
    deviceNameManuallySet: settingsFormState.deviceNameManuallySet,
    systemPrompt: settingsFormState.systemPrompt,
    workspace: settingsFormState.workspace,
    model: settingsFormState.model,
    permissions: settingsFormState.permissions,
    gatewayUrl: settingsFormState.gatewayUrl,
    auditLogPath: settingsFormState.auditLogPath,
    mcpServers: settingsFormState.mcpServers,
    mcpFilesystemEnabled: settingsFormState.mcpFilesystemEnabled,
    mcpFilesystemRoot: settingsFormState.mcpFilesystemRoot,
  };
}

function renderSettingsSubContent(container, profile, extra) {
  if (!container) return;

  switch (settingsSubTab) {
    case 'identity':
      renderSettingsIdentity(container, profile, extra);
      break;
    case 'config':
      renderSettingsConfig(container, profile);
      break;
    case 'mcp':
      renderSettingsMcp(container, profile);
      break;
    case 'security':
      renderSettingsSecurity(container);
      break;
  }
}

function renderSettingsIdentity(container, profile, extra) {
  const hasAvatar = extra.hasAvatar;
  const fs = settingsFormState;

  container.innerHTML = `
    <div style="max-width: 580px;">
      <div class="card">
        <h3>Avatar</h3>
        <div style="display: flex; align-items: center; gap: 16px;">
          <div class="avatar-circle lg">
            ${hasAvatar ? `<img src="file://${escapeHtml(extra.avatarPath)}" alt="" />` : botIconSvg(48, profile.name)}
          </div>
          <div>
            <button id="s-pick-avatar" style="font-size: 12px;">Upload Avatar</button>
            <p class="hint" style="margin-top: 4px;">PNG, JPG, or WebP. Max 2MB.</p>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Name & Identity</h3>
        <div class="field-grid">
          <label>
            <span>Name</span>
            <input type="text" id="s-name" value="${escapeHtml(fs.name)}" placeholder="My Codebot" maxlength="200" />
          </label>
          <label>
            <span>Device Name ${infoIcon('The slug used when connecting to the gateway. Auto-generated from name unless manually edited.')}</span>
            <input type="text" id="s-device-name" value="${escapeHtml(fs.deviceName)}" placeholder="my-codebot" maxlength="200" />
          </label>
        </div>
      </div>

      <div class="card">
        <h3>System Prompt</h3>
        <label>
          <span>Instructions for the agent</span>
          <textarea id="s-system-prompt" rows="8" placeholder="You are a helpful assistant...">${escapeHtml(fs.systemPrompt)}</textarea>
        </label>
      </div>

      <div class="card">
        <h3>Workspace / Knowledge Path ${infoIcon('The directory the agent works from. Can be a codebase, markdown files with backstory, images, or any project folder.')}</h3>
        <label>
          <span>Directory</span>
          <div class="path-input">
            <input type="text" id="s-workspace" value="${escapeHtml(fs.workspace)}" placeholder="/Users/you/Code/my-project" />
            <button class="path-picker-btn" id="s-browse-workspace">Browse</button>
          </div>
        </label>
      </div>
    </div>
  `;

  // Auto-slug device name from name
  const nameInput = container.querySelector('#s-name');
  const deviceNameInput = container.querySelector('#s-device-name');
  nameInput?.addEventListener('input', () => {
    if (!fs.deviceNameManuallySet) {
      deviceNameInput.value = slugify(nameInput.value);
    }
  });

  // Avatar picker
  container.querySelector('#s-pick-avatar')?.addEventListener('click', async () => {
    const result = await window.commandsDesktop.profiles.pickAvatar(profile.id);
    if (result?.ok) {
      invalidateProfileCache(profile.id);
      const mainPanel = document.getElementById('main-panel');
      if (mainPanel) renderAgentDetail(mainPanel, profile.id);
    }
  });

  // Workspace browse
  container.querySelector('#s-browse-workspace')?.addEventListener('click', async () => {
    const result = await window.commandsDesktop.pickDirectory({
      title: 'Select Workspace / Knowledge Path',
      defaultPath: container.querySelector('#s-workspace')?.value || undefined,
    });
    if (result.ok && result.path) {
      container.querySelector('#s-workspace').value = result.path;
    }
  });
}

function renderSettingsConfig(container, profile) {
  const fs = settingsFormState;
  const modelOpts = MODEL_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === fs.model ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');

  const permOpts = PERMISSION_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === fs.permissions ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');

  container.innerHTML = `
    <div style="max-width: 580px;">
      <div class="card">
        <h3>Model & Permissions</h3>
        <div class="field-grid">
          <label>
            <span>Model</span>
            <select id="s-model">${modelOpts}</select>
          </label>
          <label>
            <span>Permissions</span>
            <select id="s-permissions">${permOpts}</select>
          </label>
        </div>
      </div>

      <div class="card">
        <h3>Gateway & Logging</h3>
        <div class="field-grid">
          <label>
            <span>Gateway URL</span>
            <input type="text" id="s-gateway-url" value="${escapeHtml(fs.gatewayUrl)}" placeholder="${DEFAULT_GATEWAY_URL}" />
          </label>
          <label>
            <span>Audit Log Path</span>
            <input type="text" id="s-audit-path" value="${escapeHtml(fs.auditLogPath)}" placeholder="~/.commands-agent/profiles/${escapeHtml(profile.id)}/audit.log" />
          </label>
        </div>
      </div>

      <div class="card">
        <h3>Runtime Options</h3>
        <div class="runtime-options">
          <div class="pill">
            <input type="checkbox" id="settings-force-init" />
            Force Init
          </div>
          <div class="pill">
            <input type="checkbox" id="settings-headless" />
            Headless
          </div>
        </div>
        <p class="hint">These options apply only when starting the agent. They are not saved to the profile.</p>
      </div>
    </div>
  `;
}

function renderSettingsMcp(container, profile) {
  const fs = settingsFormState;
  const fsEnabled = fs.mcpFilesystemEnabled;

  container.innerHTML = `
    <div style="max-width: 580px;">
      <div class="card">
        <h3>Filesystem MCP</h3>
        <div class="pill" style="margin-bottom: 10px;">
          <input type="checkbox" id="s-mcp-fs-enabled" ${fsEnabled ? 'checked' : ''} />
          Enable Filesystem MCP
        </div>
        <div id="s-mcp-fs-root-group" class="${fsEnabled ? '' : 'hidden'}">
          <label>
            <span>Filesystem Root Path</span>
            <div class="path-input">
              <input type="text" id="s-mcp-fs-root" value="${escapeHtml(fs.mcpFilesystemRoot)}" placeholder="/Users/you/Code" />
              <button class="path-picker-btn" id="s-browse-mcp-fs-root">Browse</button>
            </div>
          </label>
        </div>
      </div>

      <div class="card">
        <h3>Custom MCP Servers (JSON)</h3>
        <p style="font-size: 12px; color: var(--muted); margin-bottom: 8px;">
          Paste your MCP server configuration JSON here. This is passed directly to the agent runtime.
        </p>
        <textarea id="s-mcp-servers" rows="8" placeholder='{"mcpServers": {...}}' style="font-family: var(--mono); font-size: 12px;">${escapeHtml(fs.mcpServers)}</textarea>
      </div>
    </div>
  `;

  // Toggle filesystem root visibility
  container.querySelector('#s-mcp-fs-enabled')?.addEventListener('change', (e) => {
    const group = container.querySelector('#s-mcp-fs-root-group');
    if (group) group.classList.toggle('hidden', !e.target.checked);
  });

  // Browse filesystem root
  container.querySelector('#s-browse-mcp-fs-root')?.addEventListener('click', async () => {
    const result = await window.commandsDesktop.pickDirectory({
      title: 'Select Filesystem Root',
      defaultPath: container.querySelector('#s-mcp-fs-root')?.value || undefined,
    });
    if (result.ok && result.path) {
      container.querySelector('#s-mcp-fs-root').value = result.path;
    }
  });
}

function renderSettingsSecurity(container) {
  container.innerHTML = `
    <div style="max-width: 580px;">
      <div class="card">
        <h3>Credential Security</h3>
        <p style="font-size: 12px; color: var(--muted);">
          Sensitive fields (device token, private keys) can be encrypted at rest using your OS keychain.
          Credentials are automatically decrypted when the agent starts and re-encrypted when it stops.
        </p>
        <p style="font-size: 12px; color: var(--muted); margin-top: 8px;" id="cred-status">Checking...</p>
        <button id="secure-creds-btn" style="margin-top: 10px;">Encrypt Credentials Now</button>
      </div>
    </div>
  `;

  loadCredentialStatus(container);

  container.querySelector('#secure-creds-btn')?.addEventListener('click', async () => {
    const result = await window.commandsDesktop.credentialSecurity.secure();
    if (result.ok) {
      loadCredentialStatus(container);
    }
  });
}

async function loadCredentialStatus(container) {
  const result = await window.commandsDesktop.credentialSecurity.getStatus();
  const el = container.querySelector('#cred-status');
  if (!el) return;

  if (result.ok) {
    if (result.secured) {
      el.innerHTML = '<span style="color: var(--ok);">Credentials encrypted via OS keychain</span>';
    } else if (result.available) {
      el.textContent = 'Credentials are in plaintext. Click below to encrypt.';
    } else {
      el.textContent = 'OS keychain not available on this platform.';
    }
  } else {
    el.textContent = 'Could not check credential status.';
  }
}

// ---------------------------------------------------------------------------
// Agent start/stop
// ---------------------------------------------------------------------------

async function startAgent(profile) {
  const payload = {
    profileId: profile.id,
    forceInit: false,
    headless: false,
  };

  // Read runtime options from settings tab if visible
  const forceInitEl = document.querySelector('#settings-force-init');
  const headlessEl = document.querySelector('#settings-headless');
  if (forceInitEl) payload.forceInit = forceInitEl.checked;
  if (headlessEl) payload.headless = headlessEl.checked;

  appendLog({ ts: new Date().toISOString(), stream: 'system', message: `[desktop] Starting agent: ${profile.name}` });

  const result = await window.commandsDesktop.startAgent(payload);
  if (!result || !result.ok) {
    appendLog({ ts: new Date().toISOString(), stream: 'system', message: `[desktop] Start failed: ${result?.error || 'unknown error'}` });
  }
}

async function stopAgent(force) {
  appendLog({ ts: new Date().toISOString(), stream: 'system', message: `[desktop] Stopping agent${force ? ' (force)' : ''}...` });

  const result = await window.commandsDesktop.stopAgent({ force: Boolean(force) });
  if (!result || !result.ok) {
    appendLog({ ts: new Date().toISOString(), stream: 'system', message: `[desktop] Stop failed: ${result?.error || 'unknown error'}` });
  }
}
