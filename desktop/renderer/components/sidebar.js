/**
 * sidebar.js — MY AGENTS list, SHARED WITH ME section, create button, settings gear
 */

import {
  viewState, profiles,
  escapeHtml, botIconSvg,
  isProfileRunning,
  authState, sharedAgentsState,
} from '../state.js';

export function renderSidebar(container) {
  if (!container) return;

  const selectedId = viewState.selectedAgentId;
  const currentView = viewState.currentView;

  const agentCards = profiles.map((p) => {
    const running = isProfileRunning(p.id);
    const active = selectedId === p.id && currentView === 'agent-detail';

    return `
      <div class="agent-card${active ? ' active' : ''}" data-agent-id="${escapeHtml(p.id)}">
        <div class="avatar-circle">
          ${botIconSvg(32, p.name)}
        </div>
        <div class="agent-card-info">
          <div class="agent-card-name">${escapeHtml(p.name)}</div>
          <div class="agent-card-meta">${running ? '<span style="color: var(--ok)">Running</span>' : ''}</div>
        </div>
        <div class="status-dot${running ? ' running' : ''}"></div>
      </div>
    `;
  }).join('');

  // Shared With Me section
  let sharedSection = '';
  if (authState.signedIn) {
    const devices = sharedAgentsState.devices;
    if (devices.length > 0) {
      const deviceCards = devices.map((d) => {
        const online = d.status === 'online';
        const active = currentView === 'agent-chat' && selectedId === d.device_id;
        const name = d.name || d.device_id;
        return `
          <div class="shared-agent-card${active ? ' active' : ''}" data-device-id="${escapeHtml(d.device_id)}">
            <div class="shared-agent-avatar">${botIconSvg(24, name)}</div>
            <div class="shared-agent-card-info">
              <div class="shared-agent-card-name">${escapeHtml(name)}</div>
              <div class="shared-agent-card-meta">${online ? '<span style="color: var(--ok)">Online</span>' : 'Offline'}</div>
            </div>
            <div class="status-dot${online ? ' running' : ''}"></div>
          </div>
        `;
      }).join('');
      sharedSection = `
        <div class="shared-section-wrap">
          <p class="sidebar-section-label">Shared With Me</p>
          <div class="shared-agents-list" id="shared-agent-list">
            ${deviceCards}
          </div>
        </div>
      `;
    } else {
      sharedSection = `
        <div class="shared-section-wrap">
          <p class="sidebar-section-label">Shared With Me</p>
          <div class="shared-empty-state">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span>No agents shared with you yet</span>
          </div>
        </div>
      `;
    }
  } else {
    sharedSection = `
      <div class="shared-section-wrap">
        <p class="sidebar-section-label">Shared With Me</p>
        <button class="shared-sign-in-btn" id="sidebar-sign-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
            <polyline points="10 17 15 12 10 7"/>
            <line x1="15" y1="12" x2="3" y2="12"/>
          </svg>
          Sign in to see shared agents
        </button>
      </div>
    `;
  }

  // Footer auth status
  let authFooter = '';
  if (authState.signedIn) {
    authFooter = `
      <div class="sidebar-auth-status">
        <span class="sidebar-auth-email" title="${escapeHtml(authState.email)}">${escapeHtml(authState.email)}</span>
        <button class="sidebar-signout-btn" id="sidebar-sign-out">Sign Out</button>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="sidebar-scroll">
      <div class="sidebar-section">
        <p class="sidebar-section-label">My Agents</p>
      </div>
      <div class="sidebar-agents" id="agent-list">
        ${agentCards || '<p style="color: var(--muted); font-size: 12px; padding: 8px 0;">No agents yet</p>'}
      </div>
      ${sharedSection}
    </div>
    <div class="sidebar-footer">
      <button class="create-agent-btn" id="create-agent-btn">+ Create Agent</button>
      <button class="settings-btn" id="settings-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        Settings
      </button>
      ${authFooter}
    </div>
  `;

  // Event delegation — My Agents
  const agentList = container.querySelector('#agent-list');
  if (agentList) {
    agentList.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const card = target ? target.closest('[data-agent-id]') : null;
      if (!card) return;
      const id = card.dataset.agentId;
      window.__hub.setView('agent-detail', id);
    });
  }

  // Event delegation — Shared Agents
  const sharedList = container.querySelector('#shared-agent-list');
  if (sharedList) {
    sharedList.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const card = target ? target.closest('[data-device-id]') : null;
      if (!card) return;
      const deviceId = card.dataset.deviceId;
      window.__hub.setView('agent-chat', deviceId);
    });
  }

  // Sign in — opens system browser, show waiting state
  const signInBtn = container.querySelector('#sidebar-sign-in');
  if (signInBtn) {
    const resetSignInBtn = () => {
      signInBtn.disabled = false;
      signInBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
          <polyline points="10 17 15 12 10 7"/>
          <line x1="15" y1="12" x2="3" y2="12"/>
        </svg>
        Sign in to see shared agents
      `;
    };
    signInBtn.addEventListener('click', () => {
      signInBtn.disabled = true;
      signInBtn.innerHTML = `
        <span class="chat-connecting-spinner"></span>
        Waiting for browser sign-in...
      `;
      window.commandsDesktop.auth.signIn()
        .then((result) => {
          if (!result?.ok) resetSignInBtn();
        })
        .catch(() => resetSignInBtn());
    });
  }

  // Sign out button
  container.querySelector('#sidebar-sign-out')?.addEventListener('click', () => {
    window.commandsDesktop.auth.signOut().catch(() => {});
  });

  container.querySelector('#create-agent-btn')?.addEventListener('click', () => {
    window.__hub.setView('agent-create');
  });

  container.querySelector('#settings-btn')?.addEventListener('click', () => {
    window.__hub.setView('settings');
  });
}
