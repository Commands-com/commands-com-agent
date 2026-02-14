/**
 * app.js — Entry point for the Commands.com Desktop Hub
 * Handles routing, IPC subscriptions, and view dispatch.
 */

import {
  viewState, profiles, loadProfiles, getProfile, invalidateProfileCache,
  runtimeState, updateRuntimeStatus, appendLog, clearLogs,
  isAnyAgentRunning, runningProfileId,
  processConversationEvent, clearConversations,
} from './state.js';
import { renderSidebar } from './components/sidebar.js';
import { renderDashboard } from './views/dashboard.js';
import { renderAgentDetail } from './views/agent-detail.js';
import { renderAgentCreate, renderAgentEdit } from './views/agent-create.js';
import { renderSettings } from './views/settings.js';

const LEGACY_STORAGE_KEY = 'commands.desktop.setupWizard.v1';

// ---------------------------------------------------------------------------
// View routing
// ---------------------------------------------------------------------------

export function setView(name, agentId) {
  viewState.currentView = name;
  if (agentId !== undefined) {
    viewState.selectedAgentId = agentId;
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

    // Clear conversations when agent stops
    if (wasRunning && !status.running) {
      clearConversations();
    }

    // Re-render sidebar (status dots) and main panel if relevant
    renderSidebar(document.getElementById('sidebar'));
    if (viewState.currentView === 'agent-detail') {
      renderMainPanel();
    }
  });

  unsubConversation = window.commandsDesktop.onConversationEvent((event) => {
    processConversationEvent(event);
    // Re-render conversations tab if currently viewing it
    if (
      viewState.currentView === 'agent-detail' &&
      viewState.agentDetailTab === 'conversations'
    ) {
      renderMainPanel();
    }
  });
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
window.__hub = { setView };

init();
