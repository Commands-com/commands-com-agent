/**
 * state.js — Central state management for the Commands.com Desktop Hub
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const DEFAULT_GATEWAY_URL = 'https://api.commands.com';
export const MAX_RUNTIME_LOG_LINES = 600;
export const DEFAULT_AUDIT_LIMIT = 200;
export const MAX_AUDIT_LIMIT = 2000;

export const MODEL_OPTIONS = [
  { value: 'opus', label: 'Opus (max quality)' },
  { value: 'sonnet', label: 'Sonnet (balanced)' },
  { value: 'haiku', label: 'Haiku (fast)' },
];

export const PERMISSION_OPTIONS = [
  { value: 'read-only', label: 'Read-Only' },
  { value: 'dev-safe', label: 'Dev Safe' },
  { value: 'full', label: 'Full Access' },
];

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------
export const viewState = {
  currentView: 'dashboard', // dashboard | agent-detail | agent-create | agent-edit | settings
  selectedAgentId: null,
  agentDetailTab: 'conversations', // conversations | logs | audit | settings
};

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
export let profiles = [];         // Summary list from profiles.json index
export let activeProfileId = null;
const profileCache = new Map();   // Map<id, fullProfile>

export async function loadProfiles() {
  const result = await window.commandsDesktop.profiles.list();
  if (result.ok) {
    profiles = result.profiles || [];
    activeProfileId = result.activeProfileId || null;
  } else {
    profiles = [];
    activeProfileId = null;
  }
  // Clear cache entries that no longer exist
  for (const id of profileCache.keys()) {
    if (!profiles.find((p) => p.id === id)) {
      profileCache.delete(id);
    }
  }
  return profiles;
}

export async function getProfile(id) {
  if (profileCache.has(id)) {
    return profileCache.get(id);
  }
  const result = await window.commandsDesktop.profiles.get(id);
  if (result.ok) {
    profileCache.set(id, result);
    return result;
  }
  return null;
}

export function invalidateProfileCache(id) {
  if (id) {
    profileCache.delete(id);
  } else {
    profileCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Runtime state (agent process)
// ---------------------------------------------------------------------------
export const runtimeState = {
  status: {
    running: false,
    pid: null,
    startedAt: '',
    lastExitCode: null,
    lastExitSignal: '',
    lastError: '',
    launchConfig: null,
  },
  logs: [],
};

export function updateRuntimeStatus(statusPayload) {
  Object.assign(runtimeState.status, statusPayload);
}

export function appendLog(entry) {
  runtimeState.logs.push(entry);
  if (runtimeState.logs.length > MAX_RUNTIME_LOG_LINES) {
    runtimeState.logs.splice(0, runtimeState.logs.length - MAX_RUNTIME_LOG_LINES);
  }
}

export function clearLogs() {
  runtimeState.logs.length = 0;
}

/**
 * Check if a specific profile's agent is currently running.
 */
export function isProfileRunning(profileId) {
  return runtimeState.status.running && runtimeState.status.launchConfig?.profileId === profileId;
}

/**
 * Check if any agent is running.
 */
export function isAnyAgentRunning() {
  return runtimeState.status.running;
}

/**
 * Get the profileId of the currently running agent (if any).
 */
export function runningProfileId() {
  return runtimeState.status.running ? runtimeState.status.launchConfig?.profileId : null;
}

// ---------------------------------------------------------------------------
// Audit state
// ---------------------------------------------------------------------------
export const auditState = {
  entries: [],
  requesterUids: [],
  summary: null,
  auditLogPath: '',
  filters: {
    search: '',
    requester: '',
    sessionId: '',
    event: '',
    from: '',
    to: '',
    limit: DEFAULT_AUDIT_LIMIT,
  },
  messagesOnly: false,
};

export function resetAuditState() {
  auditState.entries = [];
  auditState.requesterUids = [];
  auditState.summary = null;
  auditState.auditLogPath = '';
  auditState.filters = {
    search: '',
    requester: '',
    sessionId: '',
    event: '',
    from: '',
    to: '',
    limit: DEFAULT_AUDIT_LIMIT,
  };
  auditState.messagesOnly = false;
}

// ---------------------------------------------------------------------------
// Conversation state (live sessions)
// ---------------------------------------------------------------------------
export const conversationState = {
  sessions: new Map(),       // Map<sessionId, { sessionId, startedAt, requesterUid, messages: [], status }>
  selectedSessionId: null,
};

export function processConversationEvent(event) {
  if (!event || !event.event) return;

  switch (event.event) {
    case 'session.started': {
      const sid = event.sessionId;
      if (!sid) return;
      if (!conversationState.sessions.has(sid)) {
        conversationState.sessions.set(sid, {
          sessionId: sid,
          startedAt: event.establishedAt || event.ts,
          requesterUid: '',
          messages: [],
          status: 'active',
          lastActivity: event.ts,
        });
      }
      break;
    }

    case 'session.message': {
      const sid = event.sessionId;
      if (!sid) return;
      let session = conversationState.sessions.get(sid);
      if (!session) {
        // Session started before desktop was watching — create it
        session = {
          sessionId: sid,
          startedAt: event.ts,
          requesterUid: event.requesterUid || '',
          messages: [],
          status: 'active',
          lastActivity: event.ts,
        };
        conversationState.sessions.set(sid, session);
      }
      if (event.requesterUid) {
        session.requesterUid = event.requesterUid;
      }
      session.messages.push({
        role: 'user',
        text: event.prompt || '',
        messageId: event.messageId,
        ts: event.ts,
      });
      session.lastActivity = event.ts;
      // Auto-select the session that just received a message
      conversationState.selectedSessionId = sid;
      break;
    }

    case 'session.result': {
      const sid = event.sessionId;
      if (!sid) return;
      const session = conversationState.sessions.get(sid);
      if (!session) return;
      session.messages.push({
        role: 'assistant',
        text: event.result || '',
        messageId: event.messageId,
        ts: event.ts,
        turns: event.turns,
        costUsd: event.costUsd,
        model: event.model,
      });
      session.lastActivity = event.ts;
      break;
    }

    case 'session.error': {
      const sid = event.sessionId;
      if (!sid) return;
      const session = conversationState.sessions.get(sid);
      if (!session) return;
      session.messages.push({
        role: 'error',
        text: event.error || 'Unknown error',
        messageId: event.messageId,
        ts: event.ts,
      });
      session.lastActivity = event.ts;
      break;
    }

    case 'session.ended': {
      const sid = event.sessionId;
      if (!sid) return;
      const session = conversationState.sessions.get(sid);
      if (session) {
        session.status = 'ended';
        session.lastActivity = event.ts;
      }
      break;
    }
  }
}

export function clearConversations() {
  conversationState.sessions.clear();
  conversationState.selectedSessionId = null;
}

export function getSessionList() {
  return Array.from(conversationState.sessions.values())
    .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
}

export function getSelectedSession() {
  if (!conversationState.selectedSessionId) return null;
  return conversationState.sessions.get(conversationState.selectedSessionId) || null;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'agent';
}

export function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function randId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Generate a deterministic color from a string (for avatar backgrounds).
 */
export function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

/**
 * Get initials from a name (up to 2 chars).
 */
export function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Render an info-circle icon with a tooltip.
 * @param {string} tooltip - The tooltip text
 */
export function infoIcon(tooltip) {
  return `<span class="info-icon" data-tooltip="${escapeHtml(tooltip)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>`;
}

/**
 * Derive a deterministic hue rotation (in degrees) from a string.
 */
export function stringToHue(str) {
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

/**
 * Generate an img tag for the default robot bot avatar.
 * @param {number} size - width/height in px
 * @param {string} [name] - agent name used to shift the robot's colors
 */
export function botIconSvg(size = 24, name) {
  const hue = name ? stringToHue(name) : 0;
  const filter = hue ? `filter: hue-rotate(${hue}deg);` : '';
  return `<img src="./assets/robot-bot-icon.svg" width="${size}" height="${size}" alt="" style="display: block; ${filter}" />`;
}

/**
 * Format a model key for display.
 */
export function formatModel(model) {
  const opt = MODEL_OPTIONS.find((o) => o.value === model);
  return opt ? opt.label : model || 'Sonnet';
}

/**
 * Format a permissions key for display.
 */
export function formatPermissions(permissions) {
  const opt = PERMISSION_OPTIONS.find((o) => o.value === permissions);
  return opt ? opt.label : permissions || 'Dev Safe';
}
