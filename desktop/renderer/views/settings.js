/**
 * settings.js — App-level settings view
 */

import { escapeHtml, profiles, DEFAULT_GATEWAY_URL } from '../state.js';

export function renderSettings(container) {
  if (!container) return;

  container.innerHTML = `
    <div style="max-width: 520px;">
      <div class="section-header">
        <h2>Settings</h2>
        <p>App-level configuration for Commands.com Desktop.</p>
      </div>

      <div class="card">
        <h3>Default Gateway URL</h3>
        <p style="font-size: 12px; color: var(--muted); margin-bottom: 8px;">
          The default gateway URL used when creating new agents.
        </p>
        <input type="text" id="default-gateway-url" value="${escapeHtml(DEFAULT_GATEWAY_URL)}" placeholder="https://api.commands.com" disabled />
        <p class="hint">Gateway URL is currently set per-agent. Global default coming in a future update.</p>
      </div>

      <div class="card">
        <h3>Theme</h3>
        <p style="font-size: 12px; color: var(--muted);">Dark theme only for now.</p>
      </div>

      <div class="card" id="cred-card">
        <h3>Credential Security</h3>
        <p style="font-size: 12px; color: var(--muted);" id="global-cred-status">Checking...</p>
        <button id="global-secure-creds-btn" style="margin-top: 8px; font-size: 12px;">Encrypt Credentials</button>
      </div>

      <div class="card">
        <h3>Data</h3>
        <p style="font-size: 12px; color: var(--muted); margin-bottom: 8px;">
          ${profiles.length} agent profile${profiles.length !== 1 ? 's' : ''} configured.
        </p>
        <div style="display: flex; gap: 8px;">
          <button id="export-profiles-btn" style="font-size: 12px;">Export All Profiles</button>
        </div>
      </div>

      <div class="card">
        <h3>About</h3>
        <p style="font-size: 12px; color: var(--muted);">
          Commands.com Desktop &mdash; Agent Hub<br />
          Profiles stored at <code>~/.commands-agent/profiles/</code>
        </p>
      </div>
    </div>
  `;

  // Load credential status
  loadGlobalCredStatus(container);

  // Secure credentials
  container.querySelector('#global-secure-creds-btn')?.addEventListener('click', async () => {
    const result = await window.commandsDesktop.credentialSecurity.secure();
    if (result.ok) {
      loadGlobalCredStatus(container);
    }
  });

  // Export all profiles
  container.querySelector('#export-profiles-btn')?.addEventListener('click', async () => {
    const allProfiles = [];
    for (const p of profiles) {
      const result = await window.commandsDesktop.profiles.get(p.id);
      if (result?.ok && result.profile) {
        allProfiles.push(result.profile);
      }
    }
    const data = JSON.stringify(allProfiles, null, 2);
    await window.commandsDesktop.saveJson({
      defaultPath: 'commands-profiles-export.json',
      data,
    });
  });
}

async function loadGlobalCredStatus(container) {
  const result = await window.commandsDesktop.credentialSecurity.getStatus();
  const el = container.querySelector('#global-cred-status');
  if (!el) return;

  if (result.ok) {
    if (result.secured) {
      el.innerHTML = '<span style="color: var(--ok);">Credentials encrypted via OS keychain</span>';
    } else if (result.available) {
      el.textContent = 'Credentials are in plaintext. Click below to encrypt.';
    } else {
      el.textContent = 'OS keychain not available on this platform.';
    }
  }
}
