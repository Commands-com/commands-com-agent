/**
 * agent-create.js — Create and Edit agent profile forms with sub-tabs
 */

import {
  loadProfiles, getProfile, invalidateProfileCache, slugify, escapeHtml, infoIcon,
  CLAUDE_MODEL_OPTIONS, PERMISSION_OPTIONS, PROVIDER_OPTIONS, DEFAULT_GATEWAY_URL,
} from '../state.js';

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

const CREATE_TABS = [
  { key: 'identity', label: 'Identity' },
  { key: 'config', label: 'Configuration' },
  { key: 'mcp', label: 'MCP' },
];

let activeSubTab = 'identity';
let manuallySet = false;

function renderForm(container, profile, isEdit) {
  const title = isEdit ? 'Edit Agent' : 'Create Agent';
  const subtitle = isEdit
    ? 'Update your agent profile settings.'
    : 'Configure a new local agent profile.';

  activeSubTab = 'identity';
  manuallySet = profile?.deviceNameManuallySet || false;

  const subTabHtml = CREATE_TABS.map((t) =>
    `<button class="tab-btn${t.key === activeSubTab ? ' active' : ''}" data-create-tab="${t.key}">${t.label}</button>`
  ).join('');

  container.innerHTML = `
    <div style="max-width: 640px;">
      <div class="section-header">
        <h2>${title}</h2>
        <p>${subtitle}</p>
      </div>

      <div class="tab-bar sub-tab-bar" id="create-sub-tabs">${subTabHtml}</div>
      <div id="create-sub-content"></div>

      <div class="row" style="margin-top: 16px;">
        <button id="cancel-btn">Cancel</button>
        <button class="primary" id="save-btn">${isEdit ? 'Save Changes' : 'Create Agent'}</button>
      </div>
      <div id="form-error" class="hint" style="color: var(--danger); margin-top: 8px;"></div>
    </div>
  `;

  renderSubContent(container, profile, isEdit);

  // Sub-tab switching
  container.querySelector('#create-sub-tabs')?.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const btn = target ? target.closest('[data-create-tab]') : null;
    if (!btn) return;

    // Capture current values before switching
    captureValues(container, profile);

    activeSubTab = btn.dataset.createTab;
    // Update tab button active state
    container.querySelectorAll('[data-create-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.createTab === activeSubTab);
    });
    renderSubContent(container, profile, isEdit);
  });

  // Cancel
  container.querySelector('#cancel-btn')?.addEventListener('click', () => {
    if (isEdit && profile?.id) {
      window.__hub.setView('agent-detail', profile.id);
    } else {
      window.__hub.setView('dashboard');
    }
  });

  // Save
  container.querySelector('#save-btn')?.addEventListener('click', async () => {
    const errorEl = container.querySelector('#form-error');
    errorEl.textContent = '';

    // Capture current tab values into formState
    captureValues(container, profile);

    if (!formState.name?.trim()) {
      errorEl.textContent = 'Name is required.';
      // Switch to identity tab if not there
      if (activeSubTab !== 'identity') {
        activeSubTab = 'identity';
        container.querySelectorAll('[data-create-tab]').forEach((b) => {
          b.classList.toggle('active', b.dataset.createTab === activeSubTab);
        });
        renderSubContent(container, profile, isEdit);
      }
      return;
    }

    const payload = {
      name: formState.name.trim(),
      deviceName: formState.deviceName?.trim() || slugify(formState.name.trim()),
      deviceNameManuallySet: manuallySet,
      systemPrompt: formState.systemPrompt || '',
      workspace: formState.workspace?.trim() || '',
      provider: formState.provider || 'claude',
      model: formState.model || 'sonnet',
      ollamaBaseUrl: formState.ollamaBaseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL,
      permissions: formState.permissions || 'dev-safe',
      gatewayUrl: formState.gatewayUrl?.trim() || '',
      auditLogPath: formState.auditLogPath?.trim() || '',
      mcpFilesystemEnabled: formState.mcpFilesystemEnabled || false,
      mcpFilesystemRoot: formState.mcpFilesystemRoot?.trim() || '',
      mcpServers: formState.mcpServers || '',
    };

    if (isEdit && profile?.id) {
      payload.id = profile.id;
    }

    const result = await window.commandsDesktop.profiles.save(payload);
    if (!result.ok) {
      errorEl.textContent = result.error || 'Failed to save profile.';
      return;
    }

    invalidateProfileCache(result.profile?.id);
    await loadProfiles();

    window.__hub.setView('agent-detail', result.profile.id);
  });
}

// In-memory form state that persists across tab switches
let formState = {};

function autoDeviceSlug(nameValue) {
  const raw = String(nameValue || '').trim();
  if (!raw) return '';
  return slugify(raw);
}

function inferProvider(profile) {
  if (profile?.provider === 'ollama' || profile?.provider === 'claude') {
    return profile.provider;
  }
  return 'claude';
}

function initFormState(profile) {
  const provider = inferProvider(profile);
  formState = {
    name: profile?.name || '',
    deviceName: profile?.deviceName || '',
    systemPrompt: profile?.systemPrompt || '',
    workspace: profile?.workspace || '',
    provider,
    model: profile?.model || (provider === 'ollama' ? 'llama3.2' : 'sonnet'),
    ollamaBaseUrl: profile?.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    ollamaModels: [],
    ollamaStatus: '',
    permissions: profile?.permissions || 'dev-safe',
    gatewayUrl: profile?.gatewayUrl || '',
    auditLogPath: profile?.auditLogPath || '',
    mcpServers: profile?.mcpServers || '',
    mcpFilesystemEnabled: profile?.mcpFilesystemEnabled || false,
    mcpFilesystemRoot: profile?.mcpFilesystemRoot || '',
  };
}

function captureValues(container, _profile) {
  switch (activeSubTab) {
    case 'identity': {
      const n = container.querySelector('#agent-name');
      if (n) formState.name = n.value;
      const dn = container.querySelector('#agent-device-name');
      if (dn) formState.deviceName = dn.value;
      const sp = container.querySelector('#agent-system-prompt');
      if (sp) formState.systemPrompt = sp.value;
      const ws = container.querySelector('#agent-workspace');
      if (ws) formState.workspace = ws.value;
      const autoSlug = autoDeviceSlug(formState.name);
      manuallySet = formState.deviceName !== autoSlug;
      break;
    }
    case 'config': {
      const pr = container.querySelector('#agent-provider');
      if (pr) formState.provider = pr.value;
      const m = container.querySelector('#agent-model');
      if (m) formState.model = m.value;
      const ob = container.querySelector('#agent-ollama-base-url');
      if (ob) formState.ollamaBaseUrl = ob.value;
      const p = container.querySelector('#agent-permissions');
      if (p) formState.permissions = p.value;
      const gw = container.querySelector('#agent-gateway-url');
      if (gw) formState.gatewayUrl = gw.value;
      const al = container.querySelector('#agent-audit-log-path');
      if (al) formState.auditLogPath = al.value;
      break;
    }
    case 'mcp': {
      const fs = container.querySelector('#agent-mcp-fs-enabled');
      if (fs) formState.mcpFilesystemEnabled = fs.checked;
      const fr = container.querySelector('#agent-mcp-fs-root');
      if (fr) formState.mcpFilesystemRoot = fr.value;
      const ms = container.querySelector('#agent-mcp-servers');
      if (ms) formState.mcpServers = ms.value;
      break;
    }
  }
}

function renderSubContent(container, profile, isEdit) {
  const el = container.querySelector('#create-sub-content');
  if (!el) return;

  switch (activeSubTab) {
    case 'identity':
      renderIdentityTab(el, profile, isEdit, container);
      break;
    case 'config':
      renderConfigTab(el, container, profile, isEdit);
      break;
    case 'mcp':
      renderMcpTab(el);
      break;
  }
}

function renderIdentityTab(el, profile, isEdit, container) {
  el.innerHTML = `
    <div class="card">
      <div class="field-grid">
        <label>
          <span>Name</span>
          <input type="text" id="agent-name" value="${escapeHtml(formState.name)}" placeholder="My Codebot" maxlength="200" />
        </label>
        <label>
          <span>Device Name ${infoIcon('The slug identifier used when connecting to the gateway. Auto-generated from name unless manually edited.')}</span>
          <input type="text" id="agent-device-name" value="${escapeHtml(formState.deviceName)}" placeholder="my-codebot" maxlength="200" />
        </label>
      </div>
      ${isEdit && profile?.id ? `
        <div style="margin-top: 10px;">
          <button type="button" id="pick-avatar-btn" style="font-size: 12px;">Change Avatar</button>
        </div>
      ` : ''}
    </div>

    <div class="card">
      <h3>System Prompt</h3>
      <div class="field-grid one">
        <label>
          <span>Instructions for the agent</span>
          <textarea id="agent-system-prompt" rows="6" placeholder="You are a helpful assistant...">${escapeHtml(formState.systemPrompt)}</textarea>
        </label>
      </div>
    </div>

    <div class="card">
      <h3>Workspace / Knowledge Path ${infoIcon('The directory the agent works from. Can be a codebase, a folder of markdown files with backstory, images, or any project folder.')}</h3>
      <div class="field-grid one">
        <label>
          <span>Directory</span>
          <div class="path-input">
            <input type="text" id="agent-workspace" value="${escapeHtml(formState.workspace)}" placeholder="/Users/you/Code/my-project" />
            <button class="path-picker-btn" id="browse-workspace">Browse</button>
          </div>
        </label>
      </div>
    </div>
  `;

  // Wire events
  const nameInput = el.querySelector('#agent-name');
  const deviceNameInput = el.querySelector('#agent-device-name');

  nameInput?.addEventListener('input', () => {
    if (!manuallySet) {
      deviceNameInput.value = autoDeviceSlug(nameInput.value);
    }
  });

  deviceNameInput?.addEventListener('input', () => {
    const autoSlug = autoDeviceSlug(nameInput.value);
    manuallySet = deviceNameInput.value !== autoSlug;
  });

  el.querySelector('#browse-workspace')?.addEventListener('click', async () => {
    const result = await window.commandsDesktop.pickDirectory({
      title: 'Select Workspace / Knowledge Path',
      defaultPath: el.querySelector('#agent-workspace')?.value || undefined,
    });
    if (result.ok && result.path) {
      el.querySelector('#agent-workspace').value = result.path;
    }
  });

  if (isEdit && profile?.id) {
    el.querySelector('#pick-avatar-btn')?.addEventListener('click', async () => {
      await window.commandsDesktop.profiles.pickAvatar(profile.id);
    });
  }
}

function renderConfigTab(el, container, profile, isEdit) {
  const providerOpts = PROVIDER_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === formState.provider ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');

  const modelOpts = CLAUDE_MODEL_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === formState.model ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');

  const permOpts = PERMISSION_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === formState.permissions ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('');

  const ollamaModelValues = Array.isArray(formState.ollamaModels)
    ? [...new Set(formState.ollamaModels.map((m) => String(m || '').trim()).filter(Boolean))]
    : [];
  const currentOllamaModel = String(formState.model || '').trim();
  const ollamaOptions = [...ollamaModelValues];
  if (currentOllamaModel && !ollamaOptions.includes(currentOllamaModel)) {
    ollamaOptions.unshift(currentOllamaModel);
  }
  if (ollamaOptions.length === 0) {
    ollamaOptions.push('llama3.2');
  }
  const ollamaModelOptions = ollamaOptions
    .map((m) => {
      const isCurrentOnly = m === currentOllamaModel && !ollamaModelValues.includes(m);
      const label = isCurrentOnly ? `${m} (current)` : m;
      return `<option value="${escapeHtml(m)}"${m === currentOllamaModel ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');

  const ollamaStatus = formState.ollamaStatus
    ? `<p class="hint" style="margin-top: 8px;">${escapeHtml(formState.ollamaStatus)}</p>`
    : '';

  const modelField = formState.provider === 'ollama'
    ? `
        <label>
          <span>Model</span>
          <select id="agent-model">${ollamaModelOptions}</select>
        </label>
        <label>
          <span>Ollama Base URL</span>
          <input type="text" id="agent-ollama-base-url" value="${escapeHtml(formState.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL)}" placeholder="${DEFAULT_OLLAMA_BASE_URL}" />
        </label>
      `
    : `
        <label>
          <span>Model</span>
          <select id="agent-model">${modelOpts}</select>
        </label>
      `;

  el.innerHTML = `
    <div class="card">
      <div class="field-grid">
        <label>
          <span>Provider</span>
          <select id="agent-provider">${providerOpts}</select>
        </label>
        ${modelField}
        <label>
          <span>Permissions</span>
          <select id="agent-permissions">${permOpts}</select>
        </label>
        <label>
          <span>Gateway URL</span>
          <input type="text" id="agent-gateway-url" value="${escapeHtml(formState.gatewayUrl)}" placeholder="${DEFAULT_GATEWAY_URL}" />
        </label>
        <label>
          <span>Audit Log Path</span>
          <input type="text" id="agent-audit-log-path" value="${escapeHtml(formState.auditLogPath)}" placeholder="~/.commands-agent/audit.log" />
        </label>
      </div>
      ${formState.provider === 'ollama' ? `
        <div class="row" style="margin-top: 10px;">
          <button id="agent-refresh-ollama-models" style="font-size: 12px;">Refresh Ollama Models</button>
        </div>
        ${ollamaStatus}
      ` : ''}
    </div>
  `;

  const providerEl = el.querySelector('#agent-provider');
  providerEl?.addEventListener('change', () => {
    formState.provider = providerEl.value;
    if (formState.provider === 'claude' && !['opus', 'sonnet', 'haiku'].includes(formState.model)) {
      formState.model = 'sonnet';
    }
    if (formState.provider === 'ollama' && ['opus', 'sonnet', 'haiku'].includes(formState.model)) {
      formState.model = 'llama3.2';
    }
    formState.ollamaStatus = '';
    renderSubContent(container, profile, isEdit);
  });

  const refreshBtn = el.querySelector('#agent-refresh-ollama-models');
  refreshBtn?.addEventListener('click', async () => {
    const baseUrlEl = el.querySelector('#agent-ollama-base-url');
    const baseUrl = baseUrlEl?.value || formState.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL;
    const result = await window.commandsDesktop.ollama.listModels(baseUrl);
    if (!result?.ok) {
      formState.ollamaStatus = result?.error || 'Failed to load models';
      renderSubContent(container, profile, isEdit);
      return;
    }
    formState.ollamaBaseUrl = result.baseUrl || baseUrl;
    formState.ollamaModels = Array.isArray(result.models) ? result.models : [];
    if (!formState.model && formState.ollamaModels.length > 0) {
      formState.model = formState.ollamaModels[0];
    }
    formState.ollamaStatus = `Loaded ${formState.ollamaModels.length} model(s)`;
    renderSubContent(container, profile, isEdit);
  });
}

function renderMcpTab(el) {
  el.innerHTML = `
    <div class="card">
      <h3>Filesystem MCP</h3>
      <div class="field-grid one">
        <div class="pill" style="margin-bottom: 10px;">
          <input type="checkbox" id="agent-mcp-fs-enabled" ${formState.mcpFilesystemEnabled ? 'checked' : ''} />
          Filesystem MCP
        </div>
        <label id="mcp-fs-root-label" class="${formState.mcpFilesystemEnabled ? '' : 'hidden'}">
          <span>Filesystem Root Path</span>
          <div class="path-input">
            <input type="text" id="agent-mcp-fs-root" value="${escapeHtml(formState.mcpFilesystemRoot)}" placeholder="/Users/you/Code" />
            <button class="path-picker-btn" id="browse-mcp-fs-root">Browse</button>
          </div>
        </label>
      </div>
    </div>

    <div class="card">
      <h3>Custom MCP Servers (JSON)</h3>
      <div class="field-grid one">
        <label>
          <span>Paste your MCP server configuration JSON here</span>
          <textarea id="agent-mcp-servers" rows="4" placeholder='{"mcpServers": {...}}' style="font-family: var(--mono); font-size: 12px;">${escapeHtml(formState.mcpServers)}</textarea>
        </label>
      </div>
    </div>
  `;

  // Wire events
  el.querySelector('#agent-mcp-fs-enabled')?.addEventListener('change', (e) => {
    const label = el.querySelector('#mcp-fs-root-label');
    if (label) label.classList.toggle('hidden', !e.target.checked);
  });

  el.querySelector('#browse-mcp-fs-root')?.addEventListener('click', async () => {
    const result = await window.commandsDesktop.pickDirectory({
      title: 'Select Filesystem Root',
      defaultPath: el.querySelector('#agent-mcp-fs-root')?.value || undefined,
    });
    if (result.ok && result.path) {
      el.querySelector('#agent-mcp-fs-root').value = result.path;
    }
  });
}

export function renderAgentCreate(container) {
  initFormState(null);
  renderForm(container, null, false);
}

export async function renderAgentEdit(container, profileId) {
  if (!profileId) {
    window.__hub.setView('dashboard');
    return;
  }

  const result = await getProfile(profileId);
  if (!result || !result.profile) {
    container.innerHTML = `<p style="color: var(--danger);">Profile not found.</p>`;
    return;
  }

  initFormState(result.profile);
  renderForm(container, result.profile, true);
}
