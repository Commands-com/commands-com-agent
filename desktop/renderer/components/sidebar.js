/**
 * sidebar.js — MY AGENTS list, create button, settings gear
 */

import {
  viewState, profiles,
  escapeHtml, botIconSvg,
  isProfileRunning,
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

  container.innerHTML = `
    <div class="sidebar-section">
      <p class="sidebar-section-label">My Agents</p>
    </div>
    <div class="sidebar-agents" id="agent-list">
      ${agentCards || '<p style="color: var(--muted); font-size: 12px; padding: 8px 0;">No agents yet</p>'}
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
    </div>
  `;

  // Event delegation
  const agentList = container.querySelector('#agent-list');
  if (agentList) {
    agentList.addEventListener('click', (e) => {
      const card = e.target.closest('[data-agent-id]');
      if (!card) return;
      const id = card.dataset.agentId;
      window.__hub.setView('agent-detail', id);
    });
  }

  container.querySelector('#create-agent-btn')?.addEventListener('click', () => {
    window.__hub.setView('agent-create');
  });

  container.querySelector('#settings-btn')?.addEventListener('click', () => {
    window.__hub.setView('settings');
  });
}
