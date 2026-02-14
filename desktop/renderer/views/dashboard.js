/**
 * dashboard.js — Welcome / empty state view
 */

import { profiles, isAnyAgentRunning, runningProfileId } from '../state.js';

export function renderDashboard(container) {
  if (!container) return;

  const count = profiles.length;
  const running = isAnyAgentRunning();
  const rpId = runningProfileId();
  const runningProfile = rpId ? profiles.find((p) => p.id === rpId) : null;

  if (count === 0) {
    container.innerHTML = `
      <div style="max-width: 520px; margin: 60px auto; text-align: center;">
        <div style="margin-bottom: 24px;">
          <svg width="64" height="64" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style="opacity: 0.6">
            <rect x="1" y="1" width="30" height="30" rx="4" fill="#121929" stroke="#51A2FF" stroke-width="1.8"/>
            <polyline points="9 10 16 16 9 22" fill="none" stroke="#51A2FF" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="21" y="8" width="2" height="16" fill="#51A2FF">
              <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
            </rect>
          </svg>
        </div>
        <div class="section-header">
          <h2>Welcome to Commands.com</h2>
          <p>Create your first agent to get started. Your agents run locally and connect securely through the Commands.com relay.</p>
        </div>
        <button class="primary" id="dashboard-create-btn" style="margin-top: 8px; padding: 10px 24px; font-size: 14px;">
          + Create Your First Agent
        </button>
      </div>
    `;
  } else {
    const statusLine = running && runningProfile
      ? `<span style="color: var(--ok);">${runningProfile.name}</span> is running`
      : 'No agent running';

    container.innerHTML = `
      <div style="max-width: 520px; margin: 40px auto; text-align: center;">
        <div class="section-header">
          <h2>Agent Hub</h2>
          <p>${count} agent${count !== 1 ? 's' : ''} configured &middot; ${statusLine}</p>
        </div>
        <p style="color: var(--muted); font-size: 13px; margin-top: 8px;">
          Select an agent from the sidebar to view details, start it, or monitor conversations.
        </p>
        <button class="primary" id="dashboard-create-btn" style="margin-top: 16px;">
          + Create Agent
        </button>
      </div>
    `;
  }

  container.querySelector('#dashboard-create-btn')?.addEventListener('click', () => {
    window.__hub.setView('agent-create');
  });
}
