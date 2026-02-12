(function () {
  const STORAGE_KEY = 'commands.desktop.setupWizard.v1';
  const DEFAULT_GATEWAY_URL = 'http://localhost:8091';
  const MAX_RUNTIME_LOG_LINES = 600;

  const MODEL_OPTIONS = [
    { value: 'opus', label: 'Opus (max quality)' },
    { value: 'sonnet', label: 'Sonnet (balanced)' },
    { value: 'haiku', label: 'Haiku (fast)' }
  ];

  const MODEL_ID_MAP = {
    opus: 'opus',
    sonnet: 'sonnet',
    haiku: 'haiku'
  };

  const PERMISSION_OPTIONS = [
    { value: 'read-only', label: 'Read-Only' },
    { value: 'dev-safe', label: 'Dev Safe' },
    { value: 'full', label: 'Full Access' }
  ];

  const SCHEDULER_INTERVALS = [
    { value: 'off', label: 'Disabled' },
    { value: 'every-15m', label: 'Every 15 minutes' },
    { value: 'hourly', label: 'Hourly' },
    { value: 'daily-9am', label: 'Daily 9:00 AM' },
    { value: 'custom', label: 'Custom CRON' }
  ];

  const MCP_CATALOG = [
    {
      id: 'filesystem',
      name: 'Filesystem MCP',
      description: 'Local project file access with root path boundaries.',
      defaultDeploy: 'local-native',
      fields: [
        { key: 'root_path', label: 'Root Path', defaultValue: '/Users/you/Code' }
      ]
    },
    {
      id: 'github',
      name: 'GitHub MCP',
      description: 'PR context, issue lookup, and code review helpers.',
      defaultDeploy: 'local-docker',
      fields: [
        { key: 'repo', label: 'Default Repo', defaultValue: 'Commands-com/commands-com-app' },
        { key: 'auth_mode', label: 'Auth Mode', defaultValue: 'oauth' }
      ]
    },
    {
      id: 'postgres',
      name: 'Postgres MCP',
      description: 'Read-only SQL diagnostics with explicit connection scope.',
      defaultDeploy: 'local-docker',
      fields: [
        { key: 'connection_url', label: 'Connection URL', defaultValue: 'postgres://user:pass@localhost:5432/app' }
      ]
    },
    {
      id: 'playwright',
      name: 'Playwright MCP',
      description: 'UI smoke checks and screenshot automation.',
      defaultDeploy: 'local-docker',
      fields: [
        { key: 'base_url', label: 'Base URL', defaultValue: 'http://localhost:8080' }
      ]
    },
    {
      id: 'slack',
      name: 'Slack MCP',
      description: 'Post summaries and alerts to team channels.',
      defaultDeploy: 'cloud-hosted',
      fields: [
        { key: 'default_channel', label: 'Default Channel', defaultValue: '#engineering-ai' }
      ]
    }
  ];

  const stepMeta = [
    { id: 1, title: 'Agent Profiles' },
    { id: 2, title: 'MCP Modules' },
    { id: 3, title: 'Scheduler' },
    { id: 4, title: 'Run & Validate' },
    { id: 5, title: 'Review' }
  ];

  const el = {
    steps: document.getElementById('wizard-steps'),
    panels: [
      document.getElementById('step-1'),
      document.getElementById('step-2'),
      document.getElementById('step-3'),
      document.getElementById('step-4'),
      document.getElementById('step-5')
    ],
    prev: document.getElementById('prev-step'),
    next: document.getElementById('next-step'),
    reset: document.getElementById('reset-wizard'),
    openWeb: document.getElementById('open-commands-web')
  };

  const state = loadState();

  const runtimeUi = {
    status: {
      running: false,
      pid: null,
      startedAt: '',
      lastExitCode: null,
      lastExitSignal: '',
      lastError: '',
      launchConfig: null
    },
    logs: []
  };

  function randId(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function defaultProfile(index) {
    return {
      id: randId('profile'),
      name: `Agent ${index}`,
      deviceName: `agent-${index}`,
      workspace: '/Users/you/Code',
      model: 'sonnet',
      permissions: 'dev-safe',
      scheduler: {
        enabled: false,
        interval: 'off',
        customCron: '',
        prompt: 'Summarize local code changes and list key risks.'
      }
    };
  }

  function defaultMcpSelections() {
    const entries = {};
    MCP_CATALOG.forEach((item) => {
      const config = {};
      item.fields.forEach((field) => {
        config[field.key] = field.defaultValue;
      });
      entries[item.id] = {
        enabled: item.id === 'filesystem',
        deployMode: item.defaultDeploy,
        config
      };
    });
    return entries;
  }

  function defaultRuntimeConfig() {
    return {
      gatewayUrl: DEFAULT_GATEWAY_URL,
      profileId: '',
      forceInit: false,
      headless: false
    };
  }

  function ensureRuntimeProfileId() {
    if (!state.runtime) {
      state.runtime = defaultRuntimeConfig();
    }
    if (!Array.isArray(state.profiles) || state.profiles.length === 0) {
      state.runtime.profileId = '';
      return;
    }
    const exists = state.profiles.some((profile) => profile.id === state.runtime.profileId);
    if (!exists) {
      state.runtime.profileId = state.profiles[0].id;
    }
  }

  function normalizeState(raw) {
    const profiles = Array.isArray(raw.profiles) && raw.profiles.length > 0
      ? raw.profiles
      : [defaultProfile(1)];

    profiles.forEach((profile, i) => {
      if (!profile.id) profile.id = randId('profile');
      if (!profile.name) profile.name = `Agent ${i + 1}`;
      if (!profile.deviceName) profile.deviceName = slugify(profile.name) || `agent-${i + 1}`;
      if (!profile.workspace) profile.workspace = '/Users/you/Code';
      if (!profile.model) profile.model = 'sonnet';
      if (!profile.permissions) profile.permissions = 'dev-safe';
      if (!profile.scheduler || typeof profile.scheduler !== 'object') {
        profile.scheduler = defaultProfile(i + 1).scheduler;
      }
      if (!profile.scheduler.interval) profile.scheduler.interval = 'off';
      if (typeof profile.scheduler.enabled !== 'boolean') {
        profile.scheduler.enabled = profile.scheduler.interval !== 'off';
      }
      if (!profile.scheduler.prompt) profile.scheduler.prompt = defaultProfile(i + 1).scheduler.prompt;
      if (!profile.scheduler.customCron) profile.scheduler.customCron = '';
    });

    const runtimeRaw = raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : {};
    const runtime = {
      ...defaultRuntimeConfig(),
      ...runtimeRaw
    };

    if (typeof runtime.gatewayUrl !== 'string' || !runtime.gatewayUrl.trim()) {
      runtime.gatewayUrl = DEFAULT_GATEWAY_URL;
    }
    runtime.gatewayUrl = runtime.gatewayUrl.trim();

    if (typeof runtime.profileId !== 'string') {
      runtime.profileId = '';
    }
    runtime.forceInit = Boolean(runtime.forceInit);
    runtime.headless = Boolean(runtime.headless);

    if (!profiles.some((profile) => profile.id === runtime.profileId)) {
      runtime.profileId = profiles[0]?.id || '';
    }

    return {
      step: Number.isInteger(raw.step) ? clamp(raw.step, 1, 5) : 1,
      profiles,
      mcp: { ...defaultMcpSelections(), ...(raw.mcp || {}) },
      runtime
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return normalizeState(JSON.parse(raw));
      }
    } catch (err) {
      console.warn('Unable to load saved wizard state', err);
    }
    return normalizeState({});
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function resolveModelId(modelKey) {
    return MODEL_ID_MAP[modelKey] || MODEL_ID_MAP.sonnet;
  }

  function getSelectedProfile() {
    ensureRuntimeProfileId();
    const current = state.profiles.find((profile) => profile.id === state.runtime.profileId);
    return current || state.profiles[0] || null;
  }

  function setStep(step) {
    state.step = clamp(step, 1, 5);
    render();
    persist();
  }

  function renderSteps() {
    el.steps.innerHTML = stepMeta.map((step) => `
      <button class="step-btn ${step.id === state.step ? 'active' : ''}" data-step-id="${step.id}">
        <span class="n">Step ${step.id}</span>
        <span class="t">${escapeHtml(step.title)}</span>
      </button>
    `).join('');
  }

  function renderStep1() {
    const html = `
      <div class="section-header">
        <h2>Agent Profiles</h2>
        <p>Create profile presets for machines or repos. v1 runs one active agent process at a time, but supports multiple saved profiles.</p>
      </div>
      <div id="profiles-list">
        ${state.profiles.map((profile, idx) => `
          <div class="card" data-profile-index="${idx}">
            <div class="row">
              <h3>${escapeHtml(profile.name)}</h3>
              <button class="remove-profile" ${state.profiles.length === 1 ? 'disabled' : ''}>Remove</button>
            </div>
            <div class="field-grid">
              <label>
                <span>Display Name</span>
                <input type="text" data-field="name" value="${escapeHtml(profile.name)}" />
              </label>
              <label>
                <span>Device Name</span>
                <input type="text" data-field="deviceName" value="${escapeHtml(profile.deviceName)}" />
              </label>
              <label class="one-column" style="grid-column: span 2;">
                <span>Workspace Path</span>
                <div class="path-input">
                  <input type="text" data-field="workspace" value="${escapeHtml(profile.workspace)}" />
                  <button type="button" class="path-picker-btn" data-browse-workspace>Browse...</button>
                </div>
              </label>
              <label>
                <span>Model</span>
                <select data-field="model">
                  ${MODEL_OPTIONS.map((opt) => `<option value="${opt.value}" ${profile.model === opt.value ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
                </select>
              </label>
              <label>
                <span>Permissions</span>
                <select data-field="permissions">
                  ${PERMISSION_OPTIONS.map((opt) => `<option value="${opt.value}" ${profile.permissions === opt.value ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
                </select>
              </label>
            </div>
          </div>
        `).join('')}
      </div>
      <button id="add-profile">Add Profile</button>
      <p class="hint">Profile device IDs resolve to <code>dev-&lt;deviceName&gt;</code> when generating commands.</p>
    `;
    el.panels[0].innerHTML = html;

    const addBtn = document.getElementById('add-profile');
    addBtn.addEventListener('click', () => {
      const profile = defaultProfile(state.profiles.length + 1);
      state.profiles.push(profile);
      if (!state.runtime.profileId) {
        state.runtime.profileId = profile.id;
      }
      render();
      persist();
    });

    el.panels[0].querySelectorAll('[data-profile-index]').forEach((card) => {
      const idx = Number(card.dataset.profileIndex);
      const profile = state.profiles[idx];
      if (!profile) return;

      const removeBtn = card.querySelector('.remove-profile');
      removeBtn.addEventListener('click', () => {
        if (state.profiles.length <= 1) return;
        const removed = state.profiles.splice(idx, 1)[0];
        if (removed && removed.id === state.runtime.profileId) {
          state.runtime.profileId = state.profiles[0]?.id || '';
        }
        render();
        persist();
      });

      card.querySelectorAll('[data-field]').forEach((input) => {
        input.addEventListener('input', (event) => {
          const field = event.target.dataset.field;
          profile[field] = event.target.value;
          if (field === 'name' && !profile.deviceName) {
            profile.deviceName = slugify(profile.name) || `agent-${idx + 1}`;
          }
          renderStep4PreviewOnly();
          persist();
        });
        input.addEventListener('change', (event) => {
          const field = event.target.dataset.field;
          profile[field] = event.target.value;
          renderStep4PreviewOnly();
          persist();
        });
      });

      const browseWorkspaceBtn = card.querySelector('[data-browse-workspace]');
      if (browseWorkspaceBtn) {
        browseWorkspaceBtn.addEventListener('click', async () => {
          if (!(window.commandsDesktop && window.commandsDesktop.pickDirectory)) {
            return;
          }
          try {
            const result = await window.commandsDesktop.pickDirectory({
              title: `Select Workspace for ${profile.name}`,
              defaultPath: profile.workspace
            });
            if (!result || !result.ok || !result.path) {
              return;
            }
            profile.workspace = String(result.path);
            render();
            persist();
          } catch (_err) {
            // no-op
          }
        });
      }
    });
  }

  function renderStep2() {
    const html = `
      <div class="section-header">
        <h2>MCP Modules</h2>
        <p>Pick which MCP modules to deploy with each agent. Deploy modes include local native, local Docker, and cloud-hosted.</p>
      </div>
      ${MCP_CATALOG.map((item) => {
        const selected = state.mcp[item.id] || { enabled: false, deployMode: item.defaultDeploy, config: {} };
        return `
          <div class="card" data-mcp-id="${item.id}">
            <div class="row">
              <div>
                <h3>${escapeHtml(item.name)}</h3>
                <p class="meta">${escapeHtml(item.description)}</p>
              </div>
              <label class="pill">
                <input type="checkbox" data-mcp-field="enabled" ${selected.enabled ? 'checked' : ''} />
                Enabled
              </label>
            </div>
            <div class="${selected.enabled ? '' : 'hidden'}" data-mcp-config-section>
              <div class="field-grid">
                <label>
                  <span>Deploy Mode</span>
                  <select data-mcp-field="deployMode">
                    <option value="local-native" ${selected.deployMode === 'local-native' ? 'selected' : ''}>Local Native</option>
                    <option value="local-docker" ${selected.deployMode === 'local-docker' ? 'selected' : ''}>Local Docker</option>
                    <option value="cloud-hosted" ${selected.deployMode === 'cloud-hosted' ? 'selected' : ''}>Cloud Hosted</option>
                  </select>
                </label>
              </div>
              <div class="field-grid">
                ${item.fields.map((field) => {
                  const value = (selected.config && selected.config[field.key]) || field.defaultValue;
                  const supportsDirectoryPicker = field.key === 'root_path';
                  return `
                    <label>
                      <span>${escapeHtml(field.label)}</span>
                      ${
                        supportsDirectoryPicker
                          ? `
                        <div class="path-input">
                          <input type="text" data-mcp-config-key="${field.key}" value="${escapeHtml(value)}" />
                          <button type="button" class="path-picker-btn" data-mcp-config-browse-key="${field.key}">Browse...</button>
                        </div>
                      `
                          : `<input type="text" data-mcp-config-key="${field.key}" value="${escapeHtml(value)}" />`
                      }
                    </label>
                  `;
                }).join('')}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    `;
    el.panels[1].innerHTML = html;

    el.panels[1].querySelectorAll('[data-mcp-id]').forEach((card) => {
      const mcpId = card.dataset.mcpId;
      if (!state.mcp[mcpId]) {
        state.mcp[mcpId] = { enabled: false, deployMode: 'local-native', config: {} };
      }
      const current = state.mcp[mcpId];

      card.querySelectorAll('[data-mcp-field]').forEach((input) => {
        input.addEventListener('change', (event) => {
          const field = event.target.dataset.mcpField;
          if (field === 'enabled') {
            current.enabled = event.target.checked;
            render();
          } else if (field === 'deployMode') {
            current.deployMode = event.target.value;
            renderStep4PreviewOnly();
          }
          persist();
        });
      });

      card.querySelectorAll('[data-mcp-config-key]').forEach((input) => {
        input.addEventListener('input', (event) => {
          const key = event.target.dataset.mcpConfigKey;
          if (!current.config) current.config = {};
          current.config[key] = event.target.value;
          renderStep4PreviewOnly();
          persist();
        });
      });

      card.querySelectorAll('[data-mcp-config-browse-key]').forEach((browseBtn) => {
        browseBtn.addEventListener('click', async (event) => {
          if (!(window.commandsDesktop && window.commandsDesktop.pickDirectory)) {
            return;
          }
          const key = event.currentTarget.dataset.mcpConfigBrowseKey;
          const existingValue = current.config && typeof current.config[key] === 'string'
            ? current.config[key]
            : '';

          try {
            const result = await window.commandsDesktop.pickDirectory({
              title: `Select ${key}`,
              defaultPath: existingValue
            });
            if (!result || !result.ok || !result.path) {
              return;
            }

            if (!current.config) current.config = {};
            current.config[key] = String(result.path);

            const targetInput = card.querySelector(`[data-mcp-config-key="${key}"]`);
            if (targetInput) {
              targetInput.value = current.config[key];
            }

            renderStep4PreviewOnly();
            persist();
          } catch (_err) {
            // no-op
          }
        });
      });
    });
  }

  function renderStep3() {
    const html = `
      <div class="section-header">
        <h2>Scheduler</h2>
        <p>Configure recurring prompts. This should run through commands.com scheduler in production; this wizard generates deploy-ready settings.</p>
      </div>
      ${state.profiles.map((profile, idx) => `
        <div class="card" data-scheduler-index="${idx}">
          <div class="row">
            <div>
              <h3>${escapeHtml(profile.name)}</h3>
              <p class="meta">Device: dev-${escapeHtml(slugify(profile.deviceName || profile.name) || `agent-${idx + 1}`)}</p>
            </div>
            <label class="pill">
              <input type="checkbox" data-sched-field="enabled" ${profile.scheduler.enabled ? 'checked' : ''} />
              Enabled
            </label>
          </div>
          <div class="${profile.scheduler.enabled ? '' : 'hidden'}" data-sched-config>
            <div class="field-grid">
              <label>
                <span>Interval</span>
                <select data-sched-field="interval">
                  ${SCHEDULER_INTERVALS.map((opt) => `<option value="${opt.value}" ${profile.scheduler.interval === opt.value ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
                </select>
              </label>
              <label>
                <span>Custom CRON</span>
                <input type="text" data-sched-field="customCron" value="${escapeHtml(profile.scheduler.customCron || '')}" ${profile.scheduler.interval === 'custom' ? '' : 'disabled'} />
              </label>
            </div>
            <div class="field-grid one">
              <label>
                <span>Prompt</span>
                <textarea rows="3" data-sched-field="prompt">${escapeHtml(profile.scheduler.prompt)}</textarea>
              </label>
            </div>
          </div>
        </div>
      `).join('')}
    `;

    el.panels[2].innerHTML = html;

    el.panels[2].querySelectorAll('[data-scheduler-index]').forEach((card) => {
      const idx = Number(card.dataset.schedulerIndex);
      const profile = state.profiles[idx];
      if (!profile) return;

      card.querySelectorAll('[data-sched-field]').forEach((input) => {
        input.addEventListener('change', (event) => {
          const field = event.target.dataset.schedField;
          if (field === 'enabled') {
            profile.scheduler.enabled = event.target.checked;
            if (!profile.scheduler.enabled) {
              profile.scheduler.interval = 'off';
            } else if (profile.scheduler.interval === 'off') {
              profile.scheduler.interval = 'hourly';
            }
            render();
          } else if (field === 'interval') {
            profile.scheduler.interval = event.target.value;
            profile.scheduler.enabled = event.target.value !== 'off';
            render();
          } else {
            profile.scheduler[field] = event.target.value;
          }
          renderStep4PreviewOnly();
          persist();
        });

        input.addEventListener('input', (event) => {
          const field = event.target.dataset.schedField;
          if (field === 'customCron' || field === 'prompt') {
            profile.scheduler[field] = event.target.value;
            renderStep4PreviewOnly();
            persist();
          }
        });
      });
    });
  }

  function exportPayload() {
    const mcpModules = {};
    MCP_CATALOG.forEach((item) => {
      const selected = state.mcp[item.id];
      if (selected && selected.enabled) {
        mcpModules[item.id] = {
          deploy_mode: selected.deployMode,
          config: selected.config
        };
      }
    });

    return {
      version: 1,
      generated_at: new Date().toISOString(),
      source: 'commands-com-desktop',
      profiles: state.profiles.map((profile) => ({
        name: profile.name,
        device_name: slugify(profile.deviceName || profile.name),
        workspace: profile.workspace,
        model: profile.model,
        permissions: profile.permissions
      })),
      mcp_modules: mcpModules,
      scheduler_jobs: state.profiles
        .filter((profile) => profile.scheduler.enabled)
        .map((profile) => ({
          profile: profile.name,
          interval: profile.scheduler.interval,
          custom_cron: profile.scheduler.interval === 'custom' ? profile.scheduler.customCron : null,
          prompt: profile.scheduler.prompt
        }))
    };
  }

  function bootstrapCommand() {
    const profile = getSelectedProfile();
    if (!profile) return '# Add at least one profile';
    const deviceName = slugify(profile.deviceName || profile.name) || 'agent-1';
    const gatewayPrefix = state.runtime.gatewayUrl ? `GATEWAY_URL=\"${state.runtime.gatewayUrl}\" ` : '';
    return `${gatewayPrefix}DEVICE_NAME=\"${deviceName}\" MODEL=${resolveModelId(profile.model)} DEFAULT_CWD=\"${profile.workspace}\" INIT_AGENT=1 ./start-agent.sh`;
  }

  function splitLogLines(message) {
    return String(message || '')
      .replace(/\r/g, '')
      .split('\n')
      .filter((line) => line.trim() !== '');
  }

  function normalizeTimestamp(ts) {
    if (!ts) return new Date().toISOString();
    return String(ts);
  }

  function appendRuntimeLog(stream, message, ts) {
    const lines = splitLogLines(message);
    if (lines.length === 0) return;

    const timestamp = normalizeTimestamp(ts);
    lines.forEach((line) => {
      runtimeUi.logs.push({
        ts: timestamp,
        stream: stream || 'stdout',
        message: line
      });
    });

    if (runtimeUi.logs.length > MAX_RUNTIME_LOG_LINES) {
      runtimeUi.logs.splice(0, runtimeUi.logs.length - MAX_RUNTIME_LOG_LINES);
    }

    renderRuntimeLogs(true);
  }

  function renderRuntimeLogs(stickToBottom) {
    const logHost = document.getElementById('agent-log');
    const logLines = document.getElementById('agent-log-lines');
    if (!logHost || !logLines) return;

    const shouldStick = Boolean(stickToBottom)
      || logHost.scrollHeight - logHost.scrollTop - logHost.clientHeight < 30;

    logLines.innerHTML = runtimeUi.logs.map((entry) => `
      <div class="agent-log-line ${escapeHtml(entry.stream)}">
        <span class="ts">${escapeHtml(entry.ts)}</span>
        <span class="stream">${escapeHtml(entry.stream)}</span>
        <span class="msg">${escapeHtml(entry.message)}</span>
      </div>
    `).join('');

    if (shouldStick) {
      logHost.scrollTop = logHost.scrollHeight;
    }
  }

  function formatRuntimeStatusText() {
    if (runtimeUi.status.running) {
      return `Running (pid ${runtimeUi.status.pid || '?'})`;
    }
    if (runtimeUi.status.lastError) {
      return `Stopped (error: ${runtimeUi.status.lastError})`;
    }
    if (runtimeUi.status.lastExitCode != null) {
      return `Stopped (exit ${runtimeUi.status.lastExitCode})`;
    }
    return 'Stopped';
  }

  function formatRuntimeMeta() {
    const parts = [];
    if (runtimeUi.status.startedAt) {
      parts.push(`Started: ${runtimeUi.status.startedAt}`);
    }
    if (runtimeUi.status.lastExitSignal) {
      parts.push(`Signal: ${runtimeUi.status.lastExitSignal}`);
    }
    const launch = runtimeUi.status.launchConfig;
    if (launch && launch.deviceName) {
      parts.push(`Device: dev-${launch.deviceName}`);
    }
    if (launch && launch.gatewayUrl) {
      parts.push(`Gateway: ${launch.gatewayUrl}`);
    }
    return parts.join(' | ');
  }

  function updateRuntimeStatusDom() {
    const statusEl = document.getElementById('agent-runtime-status');
    const metaEl = document.getElementById('agent-runtime-meta');
    const startBtn = document.getElementById('start-agent-btn');
    const stopBtn = document.getElementById('stop-agent-btn');
    const reviewStatusEl = document.getElementById('review-runtime-status');
    const reviewMetaEl = document.getElementById('review-runtime-meta');
    const reviewRunBtn = document.getElementById('run-agent-review-btn');

    if (statusEl) {
      statusEl.textContent = formatRuntimeStatusText();
      statusEl.classList.toggle('running', Boolean(runtimeUi.status.running));
    }
    if (reviewStatusEl) {
      reviewStatusEl.textContent = formatRuntimeStatusText();
      reviewStatusEl.classList.toggle('running', Boolean(runtimeUi.status.running));
    }

    if (metaEl) {
      metaEl.textContent = formatRuntimeMeta();
    }
    if (reviewMetaEl) {
      reviewMetaEl.textContent = formatRuntimeMeta();
    }

    if (startBtn) {
      startBtn.disabled = Boolean(runtimeUi.status.running);
    }
    if (stopBtn) {
      stopBtn.disabled = !runtimeUi.status.running;
    }
    if (reviewRunBtn) {
      reviewRunBtn.disabled = Boolean(runtimeUi.status.running);
    }
  }

  function resolveFilesystemRoot(profile) {
    const fsMcp = state.mcp.filesystem;
    if (fsMcp && fsMcp.enabled && fsMcp.config && typeof fsMcp.config.root_path === 'string' && fsMcp.config.root_path.trim()) {
      return fsMcp.config.root_path.trim();
    }
    return profile.workspace;
  }

  async function startAgentFromDesktop() {
    if (!(window.commandsDesktop && window.commandsDesktop.startAgent)) {
      appendRuntimeLog('system', '[desktop] start is unavailable outside Electron desktop mode');
      return;
    }

    const profile = getSelectedProfile();
    if (!profile) {
      appendRuntimeLog('system', '[desktop] cannot start agent: no profile configured');
      return;
    }

    const payload = {
      gatewayUrl: state.runtime.gatewayUrl,
      deviceName: slugify(profile.deviceName || profile.name) || 'agent-1',
      defaultCwd: profile.workspace,
      model: resolveModelId(profile.model),
      mcpFilesystemRoot: resolveFilesystemRoot(profile),
      forceInit: Boolean(state.runtime.forceInit),
      headless: Boolean(state.runtime.headless),
      authMode: 'oauth'
    };

    try {
      const result = await window.commandsDesktop.startAgent(payload);
      if (!result || !result.ok) {
        appendRuntimeLog('system', `[desktop] start failed: ${result?.error || 'unknown error'}`);
        if (result && result.status) {
          runtimeUi.status = { ...runtimeUi.status, ...result.status };
          updateRuntimeStatusDom();
        }
        return;
      }

      appendRuntimeLog('system', '[desktop] start command sent');
      if (result.status) {
        runtimeUi.status = { ...runtimeUi.status, ...result.status };
        updateRuntimeStatusDom();
      }
    } catch (err) {
      appendRuntimeLog('system', `[desktop] start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function stopAgentFromDesktop(force) {
    if (!(window.commandsDesktop && window.commandsDesktop.stopAgent)) {
      appendRuntimeLog('system', '[desktop] stop is unavailable outside Electron desktop mode');
      return;
    }

    try {
      const result = await window.commandsDesktop.stopAgent({ force: Boolean(force) });
      if (!result || !result.ok) {
        appendRuntimeLog('system', `[desktop] stop failed: ${result?.error || 'unknown error'}`);
        if (result && result.status) {
          runtimeUi.status = { ...runtimeUi.status, ...result.status };
          updateRuntimeStatusDom();
        }
        return;
      }

      appendRuntimeLog('system', '[desktop] stop command sent');
      if (result.status) {
        runtimeUi.status = { ...runtimeUi.status, ...result.status };
        updateRuntimeStatusDom();
      }
    } catch (err) {
      appendRuntimeLog('system', `[desktop] stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function savePayloadToFile(payload) {
    const filename = `commands-agent-setup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const data = JSON.stringify(payload, null, 2);
    try {
      if (window.commandsDesktop && window.commandsDesktop.saveJson) {
        const result = await window.commandsDesktop.saveJson({
          defaultPath: filename,
          data
        });
        if (result && result.ok) {
          alert(`Saved: ${result.filePath}`);
        }
      } else {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function copyCommandToClipboard(command, statusEl) {
    try {
      if (window.commandsDesktop && window.commandsDesktop.copyText) {
        window.commandsDesktop.copyText(command);
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(command);
      }
      if (statusEl) {
        statusEl.textContent = 'Command copied';
        statusEl.classList.remove('hidden');
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Copy failed: ${err instanceof Error ? err.message : String(err)}`;
        statusEl.classList.remove('hidden');
      }
    }
  }

  function wireRuntimeControls() {
    const gatewayInput = document.getElementById('runtime-gateway-url');
    if (gatewayInput) {
      gatewayInput.addEventListener('input', (event) => {
        state.runtime.gatewayUrl = event.target.value;
        persist();
      });
      gatewayInput.addEventListener('change', (event) => {
        state.runtime.gatewayUrl = event.target.value.trim() || DEFAULT_GATEWAY_URL;
        persist();
        renderStep4PreviewOnly();
      });
    }

    const profileSelect = document.getElementById('runtime-profile-id');
    if (profileSelect) {
      profileSelect.addEventListener('change', (event) => {
        state.runtime.profileId = event.target.value;
        persist();
        renderStep4PreviewOnly();
      });
    }

    const forceInitCheckbox = document.getElementById('runtime-force-init');
    if (forceInitCheckbox) {
      forceInitCheckbox.addEventListener('change', (event) => {
        state.runtime.forceInit = event.target.checked;
        persist();
      });
    }

    const headlessCheckbox = document.getElementById('runtime-headless');
    if (headlessCheckbox) {
      headlessCheckbox.addEventListener('change', (event) => {
        state.runtime.headless = event.target.checked;
        persist();
      });
    }

    const startBtn = document.getElementById('start-agent-btn');
    if (startBtn) {
      startBtn.addEventListener('click', async () => {
        await startAgentFromDesktop();
      });
    }

    const stopBtn = document.getElementById('stop-agent-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        await stopAgentFromDesktop(false);
      });
    }

    const clearLogBtn = document.getElementById('clear-agent-log-btn');
    if (clearLogBtn) {
      clearLogBtn.addEventListener('click', () => {
        runtimeUi.logs = [];
        renderRuntimeLogs(false);
      });
    }
  }

  function renderStep4() {
    ensureRuntimeProfileId();
    const selectedProfile = getSelectedProfile();

    const html = `
      <div class="section-header">
        <h2>Run & Validate</h2>
        <p>Start the local agent from desktop and validate auth, connection stability, and runtime behavior.</p>
      </div>

      <div class="card runtime-card">
        <div class="row">
          <div>
            <h3>Run Agent Directly</h3>
            <p class="meta">Starts <code>./start-agent.sh</code> in this repo and streams runtime logs below. After validation, continue to the Review step.</p>
          </div>
          <span id="agent-runtime-status" class="runtime-pill">Stopped</span>
        </div>
        <p class="runtime-meta"><strong>Selected profile:</strong> ${escapeHtml(selectedProfile?.name || 'n/a')} | <strong>Device:</strong> dev-${escapeHtml(slugify(selectedProfile?.deviceName || selectedProfile?.name) || 'n/a')}</p>
        <div class="field-grid">
          <label>
            <span>Gateway URL</span>
            <input type="text" id="runtime-gateway-url" value="${escapeHtml(state.runtime.gatewayUrl)}" />
          </label>
          <label>
            <span>Profile</span>
            <select id="runtime-profile-id">
              ${state.profiles.map((profile) => `
                <option value="${escapeHtml(profile.id)}" ${profile.id === state.runtime.profileId ? 'selected' : ''}>
                  ${escapeHtml(profile.name)} (${escapeHtml(slugify(profile.deviceName || profile.name) || 'agent')})
                </option>
              `).join('')}
            </select>
          </label>
        </div>
        <div class="runtime-options">
          <label class="pill"><input type="checkbox" id="runtime-force-init" ${state.runtime.forceInit ? 'checked' : ''} /> Force init/login</label>
          <label class="pill"><input type="checkbox" id="runtime-headless" ${state.runtime.headless ? 'checked' : ''} /> Headless OAuth</label>
        </div>
        <div class="row runtime-actions">
          <button id="start-agent-btn" class="primary">Start Agent</button>
          <button id="stop-agent-btn">Stop Agent</button>
          <button id="clear-agent-log-btn">Clear Log</button>
        </div>
        <p id="agent-runtime-meta" class="runtime-meta"></p>
        <div class="agent-log" id="agent-log">
          <div id="agent-log-lines"></div>
        </div>
      </div>
    `;

    el.panels[3].innerHTML = html;
    wireRuntimeControls();
    updateRuntimeStatusDom();
    renderRuntimeLogs(true);
  }

  function renderStep5() {
    ensureRuntimeProfileId();
    const payload = exportPayload();
    const cmd = bootstrapCommand();
    const enabledMcpCount = Object.keys(payload.mcp_modules).length;
    const selectedProfile = getSelectedProfile();

    const html = `
      <div class="section-header">
        <h2>Review</h2>
        <p>Final check before you either export the setup config or run the agent with this configuration.</p>
      </div>
      <div class="summary">
        <div class="summary-box summary-list">
          <p><strong>Profiles:</strong> ${payload.profiles.length}</p>
          <p><strong>Enabled MCP Modules:</strong> ${enabledMcpCount}</p>
          <p><strong>Scheduled Jobs:</strong> ${payload.scheduler_jobs.length}</p>
          <p><strong>Primary Profile:</strong> ${escapeHtml(selectedProfile?.name || 'n/a')}</p>
          <p><strong>Primary Device:</strong> dev-${escapeHtml(slugify(selectedProfile?.deviceName || selectedProfile?.name) || 'n/a')}</p>
        </div>
        <div class="summary-box">
          <div class="row">
            <strong>Bootstrap Command</strong>
            <button id="copy-command-review">Copy</button>
          </div>
          <pre>${escapeHtml(cmd)}</pre>
          <p id="copy-status-review" class="status hidden"></p>
        </div>
      </div>

      <div class="card runtime-card">
        <div class="row">
          <div>
            <h3>Final Actions</h3>
            <p class="meta">Choose one action now. You can always do the other action later.</p>
          </div>
          <span id="review-runtime-status" class="runtime-pill">Stopped</span>
        </div>
        <div class="row runtime-actions">
          <button id="save-json-review-btn" class="primary">Export JSON</button>
          <button id="run-agent-review-btn">Run Agent</button>
        </div>
        <p id="review-runtime-meta" class="runtime-meta"></p>
      </div>

      <div class="row" style="margin-top: 10px;">
        <strong>Generated JSON</strong>
      </div>
      <div class="json-preview" id="json-preview">${escapeHtml(JSON.stringify(payload, null, 2))}</div>
    `;

    el.panels[4].innerHTML = html;

    const copyBtn = document.getElementById('copy-command-review');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const status = document.getElementById('copy-status-review');
        await copyCommandToClipboard(cmd, status);
      });
    }

    const saveBtn = document.getElementById('save-json-review-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        await savePayloadToFile(payload);
      });
    }

    const runBtn = document.getElementById('run-agent-review-btn');
    if (runBtn) {
      runBtn.addEventListener('click', async () => {
        await startAgentFromDesktop();
      });
    }

    updateRuntimeStatusDom();
  }

  function renderStep4PreviewOnly() {
    if (state.step === 4) {
      renderStep4();
      return;
    }
    if (state.step === 5) {
      renderStep5();
    }
  }

  function renderPanels() {
    el.panels.forEach((panel, idx) => {
      const active = idx + 1 === state.step;
      panel.classList.toggle('hidden', !active);
    });

    renderStep1();
    renderStep2();
    renderStep3();
    renderStep4();
    renderStep5();
  }

  function renderNav() {
    el.prev.disabled = state.step === 1;
    el.next.textContent = state.step === 5 ? 'Done' : 'Next';
  }

  function render() {
    ensureRuntimeProfileId();
    renderSteps();
    renderPanels();
    renderNav();
  }

  function initDesktopRuntimeBridge() {
    if (!(window.commandsDesktop && window.commandsDesktop.onAgentLog && window.commandsDesktop.onAgentStatus)) {
      return;
    }

    window.commandsDesktop.onAgentLog((payload) => {
      appendRuntimeLog(payload?.stream || 'stdout', payload?.message || '', payload?.ts);
    });

    window.commandsDesktop.onAgentStatus((payload) => {
      if (!payload || typeof payload !== 'object') return;
      runtimeUi.status = {
        ...runtimeUi.status,
        ...payload
      };
      updateRuntimeStatusDom();
    });

    if (window.commandsDesktop.getAgentStatus) {
      window.commandsDesktop.getAgentStatus().then((result) => {
        if (result && result.status) {
          runtimeUi.status = {
            ...runtimeUi.status,
            ...result.status
          };
          updateRuntimeStatusDom();
        }
      }).catch((err) => {
        appendRuntimeLog('system', `[desktop] failed to read initial status: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  el.steps.addEventListener('click', (event) => {
    const target = event.target.closest('[data-step-id]');
    if (!target) return;
    const step = Number(target.dataset.stepId);
    setStep(step);
  });

  el.prev.addEventListener('click', () => setStep(state.step - 1));
  el.next.addEventListener('click', () => {
    if (state.step < 5) {
      setStep(state.step + 1);
    }
  });

  el.reset.addEventListener('click', () => {
    if (!confirm('Reset wizard state?')) return;
    const fresh = normalizeState({});
    state.step = fresh.step;
    state.profiles = fresh.profiles;
    state.mcp = fresh.mcp;
    state.runtime = fresh.runtime;
    runtimeUi.logs = [];
    persist();
    render();
  });

  el.openWeb.addEventListener('click', async () => {
    const url = 'https://commands.com/gateway';
    if (window.commandsDesktop && window.commandsDesktop.openUrl) {
      await window.commandsDesktop.openUrl(url);
      return;
    }
    window.open(url, '_blank');
  });

  initDesktopRuntimeBridge();
  render();
})();
