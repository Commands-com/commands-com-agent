/**
 * sidebar.js — MY AGENTS list, SHARED WITH ME section, create button, settings gear
 */

import {
  viewState, profiles,
  escapeHtml, botIconSvg,
  isProfileRunning,
  authState, sharedAgentsState,
  getUnseenCount, formatUnseenBadge,
} from '../state.js';

export function renderSidebar(container) {
  if (!container) return;

  const selectedId = viewState.selectedAgentId;
  const currentView = viewState.currentView;

  const agentCards = profiles.map((p) => {
    const running = isProfileRunning(p.id);
    const active = selectedId === p.id && currentView === 'agent-detail';
    const unseen = getUnseenCount(p.id);
    const badgeText = formatUnseenBadge(unseen);
    const badgeHtml = unseen > 0
      ? `<span class="unseen-badge" aria-label="${unseen} unseen message${unseen !== 1 ? 's' : ''}">${escapeHtml(badgeText)}</span>`
      : '';

    return `
      <div class="agent-card${active ? ' active' : ''}" data-agent-id="${escapeHtml(p.id)}">
        <div class="avatar-circle">
          ${botIconSvg(32, p.name)}
        </div>
        <div class="agent-card-info">
          <div class="agent-card-name">${escapeHtml(p.name)}</div>
          <div class="agent-card-meta">${running ? '<span style="color: var(--ok)">Running</span>' : ''}</div>
        </div>
        ${badgeHtml}
        <div class="status-dot${running ? ' running' : ''}"></div>
      </div>
    `;
  }).join('');

  // Shared With Me section — inline input replaces prompt() (unsupported in Electron)
  const shareInputHtml = `
    <div style="margin-top: 10px;">
      <button class="shared-sign-in-btn" id="sidebar-consume-share-link">Paste Share Link</button>
      <div id="share-link-input-wrap" style="display: none; margin-top: 8px;">
        <input type="text" id="share-link-input" placeholder="Paste link or token..." style="width: 100%; padding: 6px 8px; font-size: 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg);" />
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          <button id="share-link-submit" style="font-size: 11px; flex: 1;">Submit</button>
          <button id="share-link-cancel" style="font-size: 11px;">Cancel</button>
        </div>
        <div id="share-link-error" style="display: none; font-size: 11px; color: var(--danger); margin-top: 4px;"></div>
      </div>
    </div>
  `;

  let sharedSection = '';
  if (authState.signedIn) {
    const devices = sharedAgentsState.devices;
    if (devices.length > 0) {
      const deviceCards = devices.map((d) => {
        const online = d.status === 'online';
        const active = currentView === 'agent-chat' && selectedId === d.device_id;
        const name = d.display_name || d.name || d.device_id;
        const owner = d.owner_email ? `Owner: ${d.owner_email}` : '';
        return `
          <div class="shared-agent-card${active ? ' active' : ''}" data-device-id="${escapeHtml(d.device_id)}">
            <div class="shared-agent-avatar">${botIconSvg(24, name)}</div>
            <div class="shared-agent-card-info">
              <div class="shared-agent-card-name">${escapeHtml(name)}</div>
              ${owner ? `<div class="shared-agent-card-meta">${escapeHtml(owner)}</div>` : ''}
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
          ${shareInputHtml}
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
          ${shareInputHtml}
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
        ${shareInputHtml}
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

  // Inline share-link input (replaces unsupported prompt())
  const consumeBtn = container.querySelector('#sidebar-consume-share-link');
  const shareWrap = container.querySelector('#share-link-input-wrap');
  const shareInput = container.querySelector('#share-link-input');
  const shareSubmit = container.querySelector('#share-link-submit');
  const shareCancel = container.querySelector('#share-link-cancel');
  const shareError = container.querySelector('#share-link-error');

  function hideShareInput() {
    if (shareWrap) shareWrap.style.display = 'none';
    if (shareInput) shareInput.value = '';
    if (shareError) { shareError.style.display = 'none'; shareError.textContent = ''; }
    if (consumeBtn) consumeBtn.style.display = '';
  }

  async function submitShareLink() {
    const value = shareInput?.value?.trim();
    if (!value) return;

    shareSubmit.disabled = true;
    shareSubmit.textContent = 'Processing...';
    if (shareError) shareError.style.display = 'none';

    try {
      const result = await window.commandsDesktop.gateway.consumeShareLink(value);
      if (result?.ok) {
        hideShareInput();
        if (window.__hub?.refreshSharedDevices) {
          window.__hub.refreshSharedDevices();
        }
        return;
      }

      if (result?.requiresAuth) {
        hideShareInput();
        const authResult = await window.commandsDesktop.auth.signIn();
        if (!authResult?.ok && shareError) {
          shareError.textContent = authResult?.error || 'Sign in failed';
          shareError.style.display = '';
        }
        return;
      }

      if (shareError) {
        shareError.textContent = result?.error || 'Failed to consume share link';
        shareError.style.display = '';
      }
    } catch (err) {
      if (shareError) {
        shareError.textContent = err?.message || 'Failed to consume share link';
        shareError.style.display = '';
      }
    } finally {
      if (shareSubmit) { shareSubmit.disabled = false; shareSubmit.textContent = 'Submit'; }
    }
  }

  if (consumeBtn && shareWrap) {
    consumeBtn.addEventListener('click', () => {
      consumeBtn.style.display = 'none';
      shareWrap.style.display = '';
      shareInput?.focus();
    });
  }
  if (shareCancel) shareCancel.addEventListener('click', hideShareInput);
  if (shareSubmit) shareSubmit.addEventListener('click', submitShareLink);
  if (shareInput) {
    shareInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitShareLink(); }
      if (e.key === 'Escape') hideShareInput();
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
