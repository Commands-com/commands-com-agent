/**
 * app.js — Entry point for the Commands.com Desktop Hub
 * Handles routing, IPC subscriptions, and view dispatch.
 */

import {
  viewState, profiles, loadProfiles, getProfile, invalidateProfileCache,
  runtimeState, updateRuntimeStatus, appendLog, clearLogs,
  isAnyAgentRunning, runningProfileId,
  processConversationEvent, clearConversations,
  loadAppSettings,
  updateAuthState, authState,
  updateSharedDevices, updateDeviceStatus, sharedAgentsState,
  processChatEvent, clearChatState,
  incrementUnseen, clearUnseenForProfile, clearAllUnseen,
} from './state.js';
import { renderSidebar } from './components/sidebar.js';
import { renderDashboard } from './views/dashboard.js';
import { renderAgentDetail } from './views/agent-detail.js';
import { renderAgentCreate, renderAgentEdit } from './views/agent-create.js';
import { renderSettings } from './views/settings.js';
import { renderAgentChat, clearAgentChatTransientState } from './views/agent-chat.js';

const LEGACY_STORAGE_KEY = 'commands.desktop.setupWizard.v1';

// ---------------------------------------------------------------------------
// View routing
// ---------------------------------------------------------------------------

export function setView(name, agentId) {
  viewState.currentView = name;
  if (agentId !== undefined) {
    viewState.selectedAgentId = agentId;
  }
  // Clear unseen badge when user opens that agent's detail view
  if (name === 'agent-detail' && agentId) {
    clearUnseenForProfile(agentId);
  }
  renderSidebar(document.getElementById('sidebar'));
  renderMainPanel();
}

function renderMainPanel() {
  const container = document.getElementById('main-panel');
  if (!container) return;

  switch (viewState.currentView) {
    case 'dashboard':
      renderDashboard(container);
      break;
    case 'agent-detail':
      renderAgentDetail(container, viewState.selectedAgentId);
      break;
    case 'agent-create':
      renderAgentCreate(container);
      break;
    case 'agent-edit':
      renderAgentEdit(container, viewState.selectedAgentId);
      break;
    case 'settings':
      renderSettings(container);
      break;
    case 'agent-chat':
      renderAgentChat(container, viewState.selectedAgentId);
      break;
    default:
      renderDashboard(container);
  }
}

// ---------------------------------------------------------------------------
// IPC subscriptions
// ---------------------------------------------------------------------------

let unsubLog = null;
let unsubStatus = null;
let unsubConversation = null;
let unsubAuthChanged = null;
let unsubDeviceEvent = null;
let unsubChatEvent = null;
let unsubShareEvent = null;
let authUid = null;
let sharedDevicesFetchSeq = 0;

function clearSharedAgentSessionState() {
  // Invalidate any in-flight device fetch tied to a previous auth state.
  sharedDevicesFetchSeq++;
  updateSharedDevices([]);
  sharedAgentsState.selectedDeviceId = null;
  clearChatState();
  clearAgentChatTransientState();
  clearAllUnseen();
}

function subscribeIPC() {
  unsubLog = window.commandsDesktop.onAgentLog((entry) => {
    appendLog(entry);
    // If viewing the running agent's detail + logs tab, re-render logs
    if (
      viewState.currentView === 'agent-detail' &&
      viewState.agentDetailTab === 'logs'
    ) {
      renderMainPanel();
    }
  });

  unsubStatus = window.commandsDesktop.onAgentStatus((status) => {
    const wasRunning = runtimeState.status.running;
    updateRuntimeStatus(status);

    // Clear conversations and unseen badges when agent stops
    if (wasRunning && !status.running) {
      clearConversations();
      clearAllUnseen();
    }

    // Re-render sidebar (status dots) and main panel if relevant
    renderSidebar(document.getElementById('sidebar'));
    if (viewState.currentView === 'agent-detail') {
      renderMainPanel();
    }
  });

  unsubConversation = window.commandsDesktop.onConversationEvent((event) => {
    processConversationEvent(event);

    // Unseen badge: increment for incoming messages on non-visible agents
    if (event?.event === 'session.message') {
      const profileId = event.profileId || runningProfileId();
      if (profileId) {
        const isViewing = viewState.currentView === 'agent-detail' && viewState.selectedAgentId === profileId;
        if (!isViewing) {
          const changed = incrementUnseen(profileId, event.sessionId, event.messageId);
          if (changed) {
            renderSidebar(document.getElementById('sidebar'));
          }
        }
      }
    }

    // Re-render conversations tab if currently viewing it
    if (
      viewState.currentView === 'agent-detail' &&
      viewState.agentDetailTab === 'conversations'
    ) {
      renderMainPanel();
    }
  });

  // Auth state changes
  unsubAuthChanged = window.commandsDesktop.auth.onAuthChanged((status) => {
    const prevUid = authUid;
    updateAuthState(status);
    authUid = status?.signedIn ? (status.uid || null) : null;
    const accountSwitched = Boolean(prevUid && authUid && prevUid !== authUid);

    if (!status.signedIn) {
      clearSharedAgentSessionState();
      if (viewState.currentView === 'agent-chat') {
        setView('dashboard');
      } else {
        renderSidebar(document.getElementById('sidebar'));
      }
      return;
    }

    if (accountSwitched) {
      clearSharedAgentSessionState();
      if (viewState.currentView === 'agent-chat') {
        setView('dashboard');
      } else {
        renderSidebar(document.getElementById('sidebar'));
      }
    } else {
      renderSidebar(document.getElementById('sidebar'));
    }

    // Fetch shared devices on sign-in (or account switch).
    fetchSharedDevices(authUid);
  });

  // Device status events (SSE)
  unsubDeviceEvent = window.commandsDesktop.gateway.onDeviceEvent((event) => {
    if (event?.type === 'device.sse.error') {
      // Stream ended unexpectedly; refetch as fallback to resync sidebar state.
      fetchSharedDevices();
      return;
    }

    const deviceId = event?.device_id || event?.deviceId;
    if (deviceId && event.status) {
      const known = sharedAgentsState.devices.some((d) => d.device_id === deviceId);
      if (!known) {
        fetchSharedDevices();
        return;
      }
      updateDeviceStatus(deviceId, event.status);
      renderSidebar(document.getElementById('sidebar'));
      // Re-render chat view if viewing that device
      if (viewState.currentView === 'agent-chat') {
        renderMainPanel();
      }
    }
  });

  // Chat events (E2E encrypted session events)
  unsubChatEvent = window.commandsDesktop.gateway.onChatEvent((event) => {
    processChatEvent(event);
    // Re-render chat view if viewing the affected device
    if (viewState.currentView === 'agent-chat' && event.deviceId === viewState.selectedAgentId) {
      renderMainPanel();
    }
  });

  // Share events (consume/create/revoke)
  unsubShareEvent = window.commandsDesktop.gateway.onShareEvent((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'share.consume.success' || event.type === 'share.revoke.success') {
      fetchSharedDevices();
      if (viewState.currentView === 'agent-chat') {
        renderMainPanel();
      }
      return;
    }
    if (event.type === 'share.consume.requires-auth') {
      renderSidebar(document.getElementById('sidebar'));
    }
  });
}

async function fetchSharedDevices(requestUid = authUid) {
  const fetchSeq = ++sharedDevicesFetchSeq;
  try {
    const result = await window.commandsDesktop.gateway.fetchDevices();

    // Ignore stale responses from previous auth state/fetch attempts.
    if (fetchSeq !== sharedDevicesFetchSeq) return;
    if (!authState.signedIn) return;
    if (requestUid && authState.uid && requestUid !== authState.uid) return;

    if (!result?.ok) {
      // Non-fatal
    } else if (result.devices) {
      const shared = result.devices.filter((d) => d.role !== 'owner');
      updateSharedDevices(shared);
    } else if (Array.isArray(result)) {
      const shared = result.filter((d) => d.role !== 'owner');
      updateSharedDevices(shared);
    }
    renderSidebar(document.getElementById('sidebar'));
  } catch (err) {
    if (fetchSeq !== sharedDevicesFetchSeq) return;
    console.error('[shared-agents] fetchDevices exception:', err);
  }
}

// ---------------------------------------------------------------------------
// Migration check
// ---------------------------------------------------------------------------

async function checkMigration() {
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return;

  let legacyState;
  try {
    legacyState = JSON.parse(legacy);
  } catch (_e) {
    return;
  }

  const result = await window.commandsDesktop.profiles.migrate(legacyState);
  if (result.ok && result.migrated) {
    // Migration succeeded — clear localStorage marker
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    // Reload profiles to pick up migrated data
    await loadProfiles();
  }
  // If migration failed or was skipped (already migrated), leave localStorage alone
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  // Load global app settings
  await loadAppSettings();

  // Load profiles
  await loadProfiles();

  // Check for legacy localStorage migration
  await checkMigration();

  // Reload profiles in case migration added new ones
  await loadProfiles();

  // Get initial agent status
  const statusResult = await window.commandsDesktop.getAgentStatus();
  if (statusResult.ok) {
    updateRuntimeStatus(statusResult.status);
  }

  // Get initial auth status
  try {
    const authStatus = await window.commandsDesktop.auth.getStatus();
    updateAuthState(authStatus);
    authUid = authStatus?.signedIn ? (authStatus.uid || null) : null;
    if (authStatus?.signedIn) {
      fetchSharedDevices(authUid);
    }
  } catch {
    // Auth not available — ignore
  }

  // Subscribe to agent IPC events
  subscribeIPC();

  // Wire up topbar
  document.getElementById('open-commands-web')?.addEventListener('click', () => {
    window.commandsDesktop.openUrl('https://commands.com');
  });

  // Initial render
  renderSidebar(document.getElementById('sidebar'));
  renderMainPanel();
}

// Make setView available to other modules
window.__hub = { setView, refreshSharedDevices: () => fetchSharedDevices() };

init();
