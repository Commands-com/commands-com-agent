const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require('electron');
const { randomBytes } = require('node:crypto');
const MAX_AUDIT_RETURN_ENTRIES = 2000;

// ---------------------------------------------------------------------------
// Profile storage constants
// ---------------------------------------------------------------------------
const PROFILES_DIR = path.join(os.homedir(), '.commands-agent', 'profiles');
const PROFILES_INDEX = path.join(PROFILES_DIR, 'profiles.json');
const VALID_MODELS = ['opus', 'sonnet', 'haiku'];
const VALID_PERMISSIONS = ['read-only', 'dev-safe', 'full'];
const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const AVATAR_MAGIC = {
  png:  Buffer.from([0x89, 0x50, 0x4E, 0x47]),
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
  webp_riff: Buffer.from([0x52, 0x49, 0x46, 0x46]),
  webp_tag:  Buffer.from([0x57, 0x45, 0x42, 0x50]),
};

let agentProcess = null;
let forceKillTimer = null;
const agentState = {
  running: false,
  pid: null,
  startedAt: '',
  lastExitCode: null,
  lastExitSignal: '',
  lastError: '',
  launchConfig: null
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1300,
    height: 1050,
    minWidth: 1100,
    minHeight: 860,
    title: 'Commands.com Desktop',
    backgroundColor: '#0c1017',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function sendSignalToAgentProcess(proc, signal) {
  if (!proc) return false;

  if (process.platform !== 'win32' && typeof proc.pid === 'number') {
    try {
      // Detached child runs as its own process group leader; negative pid targets the whole group.
      process.kill(-proc.pid, signal);
      return true;
    } catch (_err) {
      // Fall back to targeting only the direct process below.
    }
  }

  try {
    return proc.kill(signal);
  } catch (_err) {
    return false;
  }
}

function emitToAllWindows(channel, payload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, payload);
  });
}

function snapshotAgentState() {
  return {
    ...agentState,
    running: Boolean(agentProcess),
    pid: agentProcess?.pid ?? null
  };
}

function emitAgentStatus() {
  emitToAllWindows('desktop:agent-status', snapshotAgentState());
}

function emitAgentLog(stream, message) {
  emitToAllWindows('desktop:agent-log', {
    ts: new Date().toISOString(),
    stream,
    message
  });
}

function resolveAgentRoot(payload) {
  if (typeof payload?.agentRoot === 'string' && payload.agentRoot.trim()) {
    return payload.agentRoot.trim();
  }
  return path.resolve(__dirname, '..');
}

function defaultAuditLogPath() {
  return path.join(os.homedir(), '.commands-agent', 'audit.log');
}

function resolveAuditLogPath(rawPath, agentRoot) {
  let candidate =
    typeof rawPath === 'string' && rawPath.trim()
      ? rawPath.trim()
      : defaultAuditLogPath();

  if (candidate.startsWith('~/')) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  } else if (candidate === '~') {
    candidate = os.homedir();
  }

  if (!path.isAbsolute(candidate)) {
    const base = typeof agentRoot === 'string' && agentRoot.trim() ? agentRoot.trim() : process.cwd();
    candidate = path.resolve(base, candidate);
  }

  return path.normalize(candidate);
}

function parseIsoDateOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function extractAuditTimestamp(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const at = typeof entry.at === 'string' ? entry.at : '';
  if (at.trim()) {
    return at.trim();
  }

  const receivedAt = typeof entry.received_at === 'string' ? entry.received_at : '';
  if (receivedAt.trim()) {
    return receivedAt.trim();
  }

  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Credential security — encrypt sensitive fields at rest via OS keychain
// ---------------------------------------------------------------------------

const SENSITIVE_FIELDS = ['deviceToken', 'refreshToken'];
const SENSITIVE_NESTED = { identity: ['privateKeyDerBase64'] };
const REDACTED_PLACEHOLDER = '[secured-by-desktop-app]';

function getConfigDir() {
  return path.join(os.homedir(), '.commands-agent');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function getCredentialsPath() {
  return path.join(getConfigDir(), 'credentials.enc');
}

function extractSensitiveFields(config) {
  const secrets = {};
  for (const field of SENSITIVE_FIELDS) {
    if (config[field] !== undefined && config[field] !== REDACTED_PLACEHOLDER) {
      secrets[field] = config[field];
    }
  }
  for (const [parent, children] of Object.entries(SENSITIVE_NESTED)) {
    if (config[parent] && typeof config[parent] === 'object') {
      for (const child of children) {
        if (config[parent][child] !== undefined && config[parent][child] !== REDACTED_PLACEHOLDER) {
          if (!secrets[parent]) secrets[parent] = {};
          secrets[parent][child] = config[parent][child];
        }
      }
    }
  }
  return secrets;
}

function redactConfig(config) {
  const redacted = { ...config };
  for (const field of SENSITIVE_FIELDS) {
    if (redacted[field] !== undefined) {
      redacted[field] = REDACTED_PLACEHOLDER;
    }
  }
  for (const [parent, children] of Object.entries(SENSITIVE_NESTED)) {
    if (redacted[parent] && typeof redacted[parent] === 'object') {
      redacted[parent] = { ...redacted[parent] };
      for (const child of children) {
        if (redacted[parent][child] !== undefined) {
          redacted[parent][child] = REDACTED_PLACEHOLDER;
        }
      }
    }
  }
  redacted._credentialsSecured = true;
  return redacted;
}

function mergeSecrets(config, secrets) {
  const restored = { ...config };
  for (const field of SENSITIVE_FIELDS) {
    if (secrets[field] !== undefined) {
      restored[field] = secrets[field];
    }
  }
  for (const [parent, children] of Object.entries(SENSITIVE_NESTED)) {
    if (secrets[parent] && typeof secrets[parent] === 'object') {
      if (!restored[parent] || typeof restored[parent] !== 'object') {
        restored[parent] = {};
      } else {
        restored[parent] = { ...restored[parent] };
      }
      for (const child of children) {
        if (secrets[parent][child] !== undefined) {
          restored[parent][child] = secrets[parent][child];
        }
      }
    }
  }
  delete restored._credentialsSecured;
  return restored;
}

async function secureCredentials() {
  if (!safeStorage.isEncryptionAvailable()) {
    emitAgentLog('system', '[desktop] safeStorage not available — credentials remain in plaintext');
    return { ok: false, reason: 'safeStorage not available' };
  }

  const configPath = getConfigPath();
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'no config file' };
    throw err;
  }

  const config = JSON.parse(raw);
  const secrets = extractSensitiveFields(config);

  // Nothing to secure (already redacted or empty)
  if (Object.keys(secrets).length === 0) {
    return { ok: true, alreadySecured: true };
  }

  const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
  const credPath = getCredentialsPath();
  await fs.writeFile(credPath, encrypted);
  if (process.platform !== 'win32') {
    await fs.chmod(credPath, 0o600);
  }

  const redacted = redactConfig(config);
  await fs.writeFile(configPath, JSON.stringify(redacted, null, 2), 'utf8');

  emitAgentLog('system', '[desktop] credentials encrypted and stored in OS keychain');
  return { ok: true };
}

async function restoreCredentials() {
  const configPath = getConfigPath();
  const credPath = getCredentialsPath();

  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'no config file' };
    throw err;
  }

  const config = JSON.parse(raw);
  if (!config._credentialsSecured) {
    return { ok: true, alreadyRestored: true };
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: 'safeStorage not available — cannot decrypt credentials' };
  }

  let encryptedBuf;
  try {
    encryptedBuf = await fs.readFile(credPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, reason: 'credentials.enc missing but config is marked as secured' };
    }
    throw err;
  }

  const decrypted = safeStorage.decryptString(encryptedBuf);
  const secrets = JSON.parse(decrypted);
  const restored = mergeSecrets(config, secrets);

  await fs.writeFile(configPath, JSON.stringify(restored, null, 2), 'utf8');

  emitAgentLog('system', '[desktop] credentials restored from OS keychain');
  return { ok: true };
}

function areCredentialsSecured() {
  try {
    const raw = require('fs').readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    return Boolean(config._credentialsSecured);
  } catch (_err) {
    return false;
  }
}

function buildAgentEnv(payload) {
  const env = { ...process.env };
  // Prevent inherited shell env from forcing external MCP config in desktop mode.
  delete env.MCP_CONFIG;
  delete env.MCP_FILESYSTEM_ENABLED;
  delete env.MCP_FILESYSTEM_ROOT;

  if (typeof payload?.gatewayUrl === 'string' && payload.gatewayUrl.trim()) {
    env.GATEWAY_URL = payload.gatewayUrl.trim();
  }
  if (typeof payload?.deviceName === 'string' && payload.deviceName.trim()) {
    env.DEVICE_NAME = payload.deviceName.trim();
  }
  if (typeof payload?.defaultCwd === 'string' && payload.defaultCwd.trim()) {
    env.DEFAULT_CWD = payload.defaultCwd.trim();
  }
  if (typeof payload?.model === 'string' && payload.model.trim()) {
    env.MODEL = payload.model.trim();
  }
  if (typeof payload?.permissionProfile === 'string' && payload.permissionProfile.trim()) {
    env.PERMISSION_PROFILE = payload.permissionProfile.trim();
  }
  if (typeof payload?.mcpFilesystemRoot === 'string' && payload.mcpFilesystemRoot.trim()) {
    env.MCP_FILESYSTEM_ROOT = payload.mcpFilesystemRoot.trim();
  }
  if (typeof payload?.mcpFilesystemEnabled === 'boolean') {
    env.MCP_FILESYSTEM_ENABLED = payload.mcpFilesystemEnabled ? '1' : '0';
  }
  if (typeof payload?.auditLogPath === 'string' && payload.auditLogPath.trim()) {
    env.AUDIT_LOG_PATH = resolveAuditLogPath(payload.auditLogPath, resolveAgentRoot(payload));
  }
  if (payload?.forceInit === true) {
    env.INIT_AGENT = '1';
  }
  if (payload?.authMode === 'manual') {
    env.AUTH_MODE = 'manual';
  } else if (payload?.authMode === 'oauth') {
    env.AUTH_MODE = 'oauth';
  }
  if (payload?.headless === true) {
    env.HEADLESS = '1';
  }
  if (typeof payload?.systemPrompt === 'string' && payload.systemPrompt.trim()) {
    env.SYSTEM_PROMPT = payload.systemPrompt;
  }

  return env;
}

async function startAgent(payload = {}) {
  if (agentProcess) {
    return {
      ok: false,
      error: 'agent is already running',
      status: snapshotAgentState()
    };
  }

  const agentRoot = resolveAgentRoot(payload);
  const scriptPath = path.join(agentRoot, 'start-agent.sh');
  try {
    await fs.access(scriptPath);
  } catch (_err) {
    return {
      ok: false,
      error: `start script not found at ${scriptPath}`,
      status: snapshotAgentState()
    };
  }

  // Sync device name into agent config.json if it changed.
  // The DEVICE_NAME env var is only used during login/init, but if the config
  // already exists, init is skipped and the old deviceId persists. This ensures
  // a profile rename is picked up without requiring a full re-auth.
  const desiredDeviceName = typeof payload?.deviceName === 'string' ? payload.deviceName.trim() : '';
  if (desiredDeviceName) {
    try {
      const agentConfigPath = path.join(os.homedir(), '.commands-agent', 'config.json');
      const raw = await fs.readFile(agentConfigPath, 'utf8');
      const agentConfig = JSON.parse(raw);
      // Sanitize to match the agent SDK's sanitizeDeviceSegment logic
      const desiredId = desiredDeviceName.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-')
        .slice(0, 32)
        .replace(/-+$/g, '');
      if (desiredId && agentConfig.deviceId && agentConfig.deviceId !== desiredId) {
        emitAgentLog('system', `[desktop] updating deviceId: ${agentConfig.deviceId} → ${desiredId}`);
        agentConfig.deviceId = desiredId;
        const tmp = agentConfigPath + '.tmp.' + Date.now();
        await fs.writeFile(tmp, JSON.stringify(agentConfig, null, 2) + '\n', 'utf8');
        await fs.rename(tmp, agentConfigPath);
      }
    } catch (_err) {
      // config.json may not exist yet (first run); init will create it
    }
  }

  // Restore credentials from OS keychain before starting the agent
  try {
    const restoreResult = await restoreCredentials();
    if (!restoreResult.ok && restoreResult.reason) {
      emitAgentLog('system', `[desktop] credential restore: ${restoreResult.reason}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitAgentLog('system', `[desktop] credential restore failed: ${msg}`);
    return {
      ok: false,
      error: `failed to restore credentials: ${msg}`,
      status: snapshotAgentState()
    };
  }

  const env = buildAgentEnv(payload);
  const child = spawn('/usr/bin/env', ['bash', scriptPath], {
    cwd: agentRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });

  agentProcess = child;
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }

  agentState.startedAt = new Date().toISOString();
  agentState.lastExitCode = null;
  agentState.lastExitSignal = '';
  agentState.lastError = '';
  agentState.launchConfig = {
    agentRoot,
    profileId: payload.profileId || null,
    gatewayUrl: env.GATEWAY_URL || null,
    deviceName: env.DEVICE_NAME || null,
    defaultCwd: env.DEFAULT_CWD || null,
    model: env.MODEL || null,
    permissionProfile: env.PERMISSION_PROFILE || null,
    mcpFilesystemEnabled: env.MCP_FILESYSTEM_ENABLED || null,
    auditLogPath: env.AUDIT_LOG_PATH || defaultAuditLogPath(),
    authMode: env.AUTH_MODE || 'oauth',
    forceInit: env.INIT_AGENT === '1',
    headless: env.HEADLESS === '1'
  };

  emitAgentLog(
    'system',
    `[desktop] started start-agent.sh pid=${child.pid ?? 'unknown'} cwd=${agentRoot}`
  );
  emitAgentStatus();

  // Line-buffered stdout parsing: intercept __DESKTOP_EVENT__ lines,
  // pass everything else as regular log output.
  const EVENT_PREFIX = '__DESKTOP_EVENT__:';
  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // keep incomplete last line in buffer
    for (const line of lines) {
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          const payload = JSON.parse(line.slice(EVENT_PREFIX.length));
          emitToAllWindows('desktop:conversation-event', payload);
        } catch (_e) { /* malformed event line — skip */ }
      } else if (line.length > 0) {
        emitAgentLog('stdout', line);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    emitAgentLog('stderr', chunk.toString('utf8'));
  });
  child.on('error', (err) => {
    agentState.lastError = err instanceof Error ? err.message : String(err);
    emitAgentLog('system', `[desktop] agent process error: ${agentState.lastError}`);
    emitAgentStatus();
  });
  child.on('close', (code, signal) => {
    // Flush any remaining stdout buffer
    if (stdoutBuffer.length > 0) {
      if (stdoutBuffer.startsWith(EVENT_PREFIX)) {
        try {
          const payload = JSON.parse(stdoutBuffer.slice(EVENT_PREFIX.length));
          emitToAllWindows('desktop:conversation-event', payload);
        } catch (_e) { /* skip */ }
      } else {
        emitAgentLog('stdout', stdoutBuffer);
      }
      stdoutBuffer = '';
    }

    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    if (agentProcess === child) {
      agentProcess = null;
    }

    agentState.lastExitCode = Number.isInteger(code) ? code : null;
    agentState.lastExitSignal = signal || '';
    emitAgentLog(
      'system',
      `[desktop] agent exited code=${code == null ? 'null' : code} signal=${signal || 'none'}`
    );
    emitAgentStatus();

    // Re-encrypt credentials now that agent has stopped
    secureCredentials().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      emitAgentLog('system', `[desktop] credential secure after exit failed: ${msg}`);
    });
  });

  return { ok: true, status: snapshotAgentState() };
}

async function stopAgent(force = false) {
  if (!agentProcess) {
    return {
      ok: false,
      error: 'agent is not running',
      status: snapshotAgentState()
    };
  }

  const proc = agentProcess;
  try {
    if (force) {
      emitAgentLog('system', '[desktop] sending SIGKILL to agent process');
      sendSignalToAgentProcess(proc, 'SIGKILL');
    } else {
      emitAgentLog('system', '[desktop] sending SIGTERM to agent process');
      sendSignalToAgentProcess(proc, 'SIGTERM');
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      forceKillTimer = setTimeout(() => {
        if (agentProcess === proc) {
          emitAgentLog('system', '[desktop] agent did not exit; escalating to SIGKILL');
          sendSignalToAgentProcess(proc, 'SIGKILL');
        }
      }, 5000);
    }
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    emitAgentLog('system', `[desktop] failed to stop agent: ${errorText}`);
    return {
      ok: false,
      error: errorText,
      status: snapshotAgentState()
    };
  }

  return { ok: true, status: snapshotAgentState() };
}

ipcMain.handle('desktop:save-json', async (_event, payload) => {
  const defaultPath = payload?.defaultPath || 'commands-agent-setup.json';
  const data = payload?.data || '';

  const result = await dialog.showSaveDialog({
    title: 'Save Agent Setup JSON',
    defaultPath,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  await fs.writeFile(result.filePath, data, 'utf8');
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('desktop:open-url', async (_event, url) => {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, error: 'invalid url' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('desktop:pick-directory', async (event, payload) => {
  const defaultPath =
    typeof payload?.defaultPath === 'string' && payload.defaultPath.trim()
      ? payload.defaultPath.trim()
      : undefined;
  const title =
    typeof payload?.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : 'Select Directory';

  const win = BrowserWindow.fromWebContents(event.sender) || undefined;
  const result = await dialog.showOpenDialog(win, {
    title,
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('desktop:audit:read', async (_event, payload) => {
  const agentRoot = resolveAgentRoot(payload);
  const auditLogPath = resolveAuditLogPath(payload?.auditLogPath, agentRoot);
  const requestedLimit = Number(payload?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? clamp(Math.trunc(requestedLimit), 1, MAX_AUDIT_RETURN_ENTRIES)
    : 200;

  const search = typeof payload?.search === 'string' ? payload.search.trim().toLowerCase() : '';
  const requester = typeof payload?.requester === 'string' ? payload.requester.trim().toLowerCase() : '';
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim().toLowerCase() : '';
  const eventType = typeof payload?.event === 'string' ? payload.event.trim().toLowerCase() : '';
  const fromIso = parseIsoDateOrNull(payload?.from);
  const toIso = parseIsoDateOrNull(payload?.to);
  const fromMs = fromIso ? Date.parse(fromIso) : null;
  const toMs = toIso ? Date.parse(toIso) : null;

  let content = '';
  try {
    content = await fs.readFile(auditLogPath, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : null;
    if (code === 'ENOENT') {
      return {
        ok: true,
        auditLogPath,
        entries: [],
        requester_uids: [],
        summary: {
          totalLines: 0,
          parsedEntries: 0,
          matches: 0,
          returned: 0,
          parseErrors: 0,
          missing: true
        }
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, auditLogPath };
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let parseErrors = 0;
  const parsedEntries = [];

  lines.forEach((line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        parsedEntries.push(parsed);
      } else {
        parseErrors += 1;
      }
    } catch (_err) {
      parseErrors += 1;
    }
  });

  const requesterUIDs = Array.from(new Set(
    parsedEntries
      .map((entry) => (typeof entry.requester_uid === 'string' ? entry.requester_uid.trim() : ''))
      .filter((uid) => uid.length > 0)
  )).sort((a, b) => a.localeCompare(b));

  const matches = parsedEntries.filter((entry) => {
    const asRecord = entry;
    const rawSearchText = JSON.stringify(asRecord).toLowerCase();

    if (search && !rawSearchText.includes(search)) {
      return false;
    }

    if (requester) {
      const requesterUid =
        (typeof asRecord.requester_uid === 'string' && asRecord.requester_uid.toLowerCase()) || '';
      if (!requesterUid.includes(requester)) {
        return false;
      }
    }

    if (sessionId) {
      const session =
        (typeof asRecord.session_id === 'string' && asRecord.session_id.toLowerCase()) || '';
      if (!session.includes(sessionId)) {
        return false;
      }
    }

    if (eventType) {
      const eventName =
        (typeof asRecord.event === 'string' && asRecord.event.toLowerCase()) || '';
      if (!eventName.includes(eventType)) {
        return false;
      }
    }

    if (fromMs != null || toMs != null) {
      const timestamp = extractAuditTimestamp(asRecord);
      const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
      if (!Number.isFinite(timestampMs)) {
        return false;
      }
      if (fromMs != null && timestampMs < fromMs) {
        return false;
      }
      if (toMs != null && timestampMs > toMs) {
        return false;
      }
    }

    return true;
  });

  matches.sort((a, b) => {
    const aTs = extractAuditTimestamp(a) || '';
    const bTs = extractAuditTimestamp(b) || '';
    return aTs.localeCompare(bTs);
  });

  const entries = matches.slice(-limit).reverse();

  return {
    ok: true,
    auditLogPath,
    entries,
    requester_uids: requesterUIDs,
    summary: {
      totalLines: lines.length,
      parsedEntries: parsedEntries.length,
      matches: matches.length,
      returned: entries.length,
      parseErrors,
      missing: false
    }
  };
});

ipcMain.handle('desktop:agent:start', async (_event, payload) => startAgent(payload || {}));
ipcMain.handle('desktop:agent:stop', async (_event, payload) => stopAgent(Boolean(payload?.force)));
ipcMain.handle('desktop:agent:status', async () => ({ ok: true, status: snapshotAgentState() }));

ipcMain.handle('desktop:credentials:status', async () => ({
  ok: true,
  available: safeStorage.isEncryptionAvailable(),
  secured: areCredentialsSecured()
}));

ipcMain.handle('desktop:credentials:secure', async () => {
  try {
    return await secureCredentials();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// ---------------------------------------------------------------------------
// Profile storage — helpers
// ---------------------------------------------------------------------------

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'agent';
}

async function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + Date.now();
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

async function ensureProfilesDir() {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
}

async function readProfilesIndex() {
  try {
    const raw = await fs.readFile(PROFILES_INDEX, 'utf8');
    const index = JSON.parse(raw);
    return migrateProfilesIndex(index);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { version: 1, profiles: [], activeProfileId: null };
    }
    throw err;
  }
}

async function writeProfilesIndex(index) {
  await ensureProfilesDir();
  await atomicWrite(PROFILES_INDEX, JSON.stringify(index, null, 2));
}

function migrateProfilesIndex(index) {
  if (!index || typeof index !== 'object') {
    return { version: 1, profiles: [], activeProfileId: null };
  }
  if (!index.version || index.version < 1) {
    index.version = 1;
    index.profiles = Array.isArray(index.profiles) ? index.profiles : [];
    index.activeProfileId = index.activeProfileId || null;
  }
  return index;
}

function migrateProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return profile;
  }
  if (!profile.version || profile.version < 1) {
    profile.version = 1;
    profile.systemPrompt = profile.systemPrompt || '';
    profile.mcpServers = profile.mcpServers || '';
    profile.gatewayUrl = profile.gatewayUrl || '';
    profile.auditLogPath = profile.auditLogPath || '';
    profile.deviceNameManuallySet = profile.deviceNameManuallySet || false;
  }
  return profile;
}

function generateProfileId() {
  const ts = Date.now();
  const rand = randomBytes(4).toString('hex');
  return `profile_${ts}_${rand}`;
}

function validateProfileId(id) {
  return typeof id === 'string' && PROFILE_ID_RE.test(id);
}

function sanitizeProfilePayload(incoming) {
  const allowed = {};

  // id — immutable, only accepted on create (validated separately)
  if (typeof incoming.id === 'string') allowed.id = incoming.id;

  // name — required, max 200
  if (typeof incoming.name === 'string') {
    allowed.name = incoming.name.slice(0, 200);
  }

  // deviceName — max 200
  if (typeof incoming.deviceName === 'string') {
    allowed.deviceName = incoming.deviceName.slice(0, 200);
  }

  // deviceNameManuallySet
  if (typeof incoming.deviceNameManuallySet === 'boolean') {
    allowed.deviceNameManuallySet = incoming.deviceNameManuallySet;
  }

  // systemPrompt — max 50k
  if (typeof incoming.systemPrompt === 'string') {
    allowed.systemPrompt = incoming.systemPrompt.slice(0, 50000);
  }

  // workspace — must be absolute
  if (typeof incoming.workspace === 'string' && path.isAbsolute(incoming.workspace)) {
    allowed.workspace = incoming.workspace;
  }

  // model
  if (typeof incoming.model === 'string' && VALID_MODELS.includes(incoming.model)) {
    allowed.model = incoming.model;
  }

  // permissions
  if (typeof incoming.permissions === 'string' && VALID_PERMISSIONS.includes(incoming.permissions)) {
    allowed.permissions = incoming.permissions;
  }

  // gatewayUrl — valid URL or empty
  if (typeof incoming.gatewayUrl === 'string') {
    if (incoming.gatewayUrl.trim() === '') {
      allowed.gatewayUrl = '';
    } else {
      try {
        new URL(incoming.gatewayUrl);
        allowed.gatewayUrl = incoming.gatewayUrl;
      } catch (_e) {
        // invalid URL, drop
      }
    }
  }

  // auditLogPath
  if (typeof incoming.auditLogPath === 'string') {
    allowed.auditLogPath = incoming.auditLogPath;
  }

  // mcpServers — raw JSON string
  if (typeof incoming.mcpServers === 'string') {
    allowed.mcpServers = incoming.mcpServers.slice(0, 100000);
  }

  // mcpFilesystemEnabled
  if (typeof incoming.mcpFilesystemEnabled === 'boolean') {
    allowed.mcpFilesystemEnabled = incoming.mcpFilesystemEnabled;
  }

  // mcpFilesystemRoot
  if (typeof incoming.mcpFilesystemRoot === 'string') {
    allowed.mcpFilesystemRoot = incoming.mcpFilesystemRoot;
  }

  return allowed;
}

function resolveDeviceName(profile, allProfiles) {
  // If manually set, keep it as-is
  if (profile.deviceNameManuallySet && profile.deviceName) {
    return profile.deviceName;
  }

  // Auto-generate from name
  const base = slugify(profile.name || 'agent');
  let candidate = base;
  let suffix = 2;

  while (true) {
    const collision = allProfiles.find(
      (p) => p.id !== profile.id && p.deviceName === candidate
    );
    if (!collision) break;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function checkAvatarMagicBytes(buffer) {
  if (buffer.length < 8) return false;

  // PNG: 89 50 4E 47
  if (buffer.subarray(0, 4).equals(AVATAR_MAGIC.png)) return true;

  // JPEG: FF D8 FF
  if (buffer.subarray(0, 3).equals(AVATAR_MAGIC.jpeg)) return true;

  // WebP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).equals(AVATAR_MAGIC.webp_riff) &&
    buffer.length >= 12 &&
    buffer.subarray(8, 12).equals(AVATAR_MAGIC.webp_tag)
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Profile storage — IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('desktop:profiles:list', async () => {
  try {
    await ensureProfilesDir();
    const index = await readProfilesIndex();
    return { ok: true, ...index };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:profiles:get', async (_event, payload) => {
  try {
    const id = payload?.id;
    if (!validateProfileId(id)) {
      return { ok: false, error: 'Invalid profile id' };
    }

    const profilePath = path.join(PROFILES_DIR, id, 'profile.json');
    let raw;
    try {
      raw = await fs.readFile(profilePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: false, error: 'Profile not found' };
      }
      throw err;
    }

    const profile = migrateProfile(JSON.parse(raw));

    // Check for avatar
    const avatarPath = path.join(PROFILES_DIR, id, 'avatar.png');
    let hasAvatar = false;
    try {
      await fs.access(avatarPath);
      hasAvatar = true;
    } catch (_e) { /* no avatar */ }

    return { ok: true, profile, hasAvatar, avatarPath: hasAvatar ? avatarPath : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:profiles:save', async (_event, payload) => {
  try {
    const incoming = payload?.profile;
    if (!incoming || typeof incoming !== 'object') {
      return { ok: false, error: 'Invalid profile data' };
    }

    const sanitized = sanitizeProfilePayload(incoming);

    if (!sanitized.name || sanitized.name.trim() === '') {
      return { ok: false, error: 'Name is required' };
    }

    await ensureProfilesDir();
    const index = await readProfilesIndex();

    const isCreate = !sanitized.id || !index.profiles.find((p) => p.id === sanitized.id);

    let profile;
    if (isCreate) {
      // Generate immutable ID
      const id = generateProfileId();
      sanitized.id = id;

      // Load all existing profiles for deviceName collision check
      const allProfiles = [];
      for (const entry of index.profiles) {
        try {
          const p = JSON.parse(await fs.readFile(path.join(PROFILES_DIR, entry.id, 'profile.json'), 'utf8'));
          allProfiles.push(p);
        } catch (_e) { /* skip broken */ }
      }

      const deviceName = resolveDeviceName(sanitized, allProfiles);

      profile = {
        version: 1,
        id,
        name: sanitized.name.trim(),
        deviceName,
        deviceNameManuallySet: sanitized.deviceNameManuallySet || false,
        systemPrompt: sanitized.systemPrompt || '',
        workspace: sanitized.workspace || '',
        model: sanitized.model || 'sonnet',
        permissions: sanitized.permissions || 'dev-safe',
        gatewayUrl: sanitized.gatewayUrl || '',
        auditLogPath: sanitized.auditLogPath || '',
        mcpServers: sanitized.mcpServers || '',
        mcpFilesystemEnabled: sanitized.mcpFilesystemEnabled || false,
        mcpFilesystemRoot: sanitized.mcpFilesystemRoot || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Create profile directory
      const profileDir = path.join(PROFILES_DIR, id);
      await fs.mkdir(profileDir, { recursive: true });

      // Write profile.json
      await atomicWrite(path.join(profileDir, 'profile.json'), JSON.stringify(profile, null, 2));

      // Update index
      index.profiles.push({ id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt });
      if (!index.activeProfileId) {
        index.activeProfileId = id;
      }
      await writeProfilesIndex(index);

    } else {
      // Update existing
      const id = sanitized.id;
      if (!validateProfileId(id)) {
        return { ok: false, error: 'Invalid profile id' };
      }

      const profilePath = path.join(PROFILES_DIR, id, 'profile.json');
      let existing;
      try {
        existing = migrateProfile(JSON.parse(await fs.readFile(profilePath, 'utf8')));
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          return { ok: false, error: 'Profile not found' };
        }
        throw err;
      }

      // Load all profiles for deviceName collision check
      const allProfiles = [];
      for (const entry of index.profiles) {
        try {
          const p = JSON.parse(await fs.readFile(path.join(PROFILES_DIR, entry.id, 'profile.json'), 'utf8'));
          allProfiles.push(p);
        } catch (_e) { /* skip broken */ }
      }

      // Merge: sanitized fields overwrite existing, but preserve id, createdAt
      profile = {
        ...existing,
        ...sanitized,
        id: existing.id,  // immutable
        createdAt: existing.createdAt,  // server-controlled
        updatedAt: Date.now(),  // server-controlled
        version: existing.version,
      };

      // Resolve deviceName
      profile.deviceName = resolveDeviceName(profile, allProfiles);

      await atomicWrite(profilePath, JSON.stringify(profile, null, 2));

      // Update index entry
      const indexEntry = index.profiles.find((p) => p.id === id);
      if (indexEntry) {
        indexEntry.name = profile.name;
        indexEntry.updatedAt = profile.updatedAt;
      }
      await writeProfilesIndex(index);
    }

    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:profiles:delete', async (_event, payload) => {
  try {
    const id = payload?.id;
    if (!validateProfileId(id)) {
      return { ok: false, error: 'Invalid profile id' };
    }

    // Delete safety: can't delete profile whose agent is running (keyed on profile.id)
    if (agentProcess && agentState.launchConfig?.profileId === id) {
      return { ok: false, error: 'Stop the agent before deleting this profile' };
    }

    const index = await readProfilesIndex();
    const entryIdx = index.profiles.findIndex((p) => p.id === id);
    if (entryIdx === -1) {
      return { ok: false, error: 'Profile not found' };
    }

    // Remove directory
    const profileDir = path.join(PROFILES_DIR, id);
    try {
      await fs.rm(profileDir, { recursive: true, force: true });
    } catch (_e) { /* dir may not exist */ }

    // Remove from index
    index.profiles.splice(entryIdx, 1);
    if (index.activeProfileId === id) {
      index.activeProfileId = index.profiles.length > 0 ? index.profiles[0].id : null;
    }
    await writeProfilesIndex(index);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:profiles:set-active', async (_event, payload) => {
  try {
    const id = payload?.id;
    if (!validateProfileId(id)) {
      return { ok: false, error: 'Invalid profile id' };
    }

    const index = await readProfilesIndex();
    const exists = index.profiles.find((p) => p.id === id);
    if (!exists) {
      return { ok: false, error: 'Profile not found' };
    }

    index.activeProfileId = id;
    await writeProfilesIndex(index);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:profiles:pick-avatar', async (event, payload) => {
  try {
    const profileId = payload?.profileId;
    if (!validateProfileId(profileId)) {
      return { ok: false, error: 'Invalid profile id' };
    }

    const profileDir = path.join(PROFILES_DIR, profileId);
    try {
      await fs.access(profileDir);
    } catch (_e) {
      return { ok: false, error: 'Profile directory not found' };
    }

    const win = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Avatar Image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }

    const srcPath = result.filePaths[0];

    // Validate file size
    const stat = await fs.stat(srcPath);
    if (stat.size > AVATAR_MAX_BYTES) {
      return { ok: false, error: 'Image too large (max 2MB)' };
    }

    // Validate content via magic bytes
    const fileBuffer = await fs.readFile(srcPath);
    if (!checkAvatarMagicBytes(fileBuffer)) {
      return { ok: false, error: 'Invalid image file' };
    }

    // Copy to profile dir as avatar.png
    const destPath = path.join(profileDir, 'avatar.png');
    await fs.writeFile(destPath, fileBuffer);

    return { ok: true, avatarPath: destPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:profiles:migrate', async (_event, payload) => {
  try {
    const legacyState = payload?.legacyState;
    if (!legacyState || typeof legacyState !== 'object') {
      return { ok: false, error: 'Invalid legacy state' };
    }

    await ensureProfilesDir();
    const index = await readProfilesIndex();

    // Idempotent: if profiles already exist, skip migration
    if (index.profiles.length > 0) {
      return { ok: true, migrated: false, reason: 'Profiles already exist' };
    }

    // Backup legacy payload before processing
    const backupPath = path.join(PROFILES_DIR, 'legacy-backup.json');
    await atomicWrite(backupPath, JSON.stringify(legacyState, null, 2));

    // Extract profile from legacy wizard state
    const id = generateProfileId();
    const name = legacyState.deviceName || legacyState.agentName || 'My Agent';
    const now = Date.now();

    const profile = {
      version: 1,
      id,
      name,
      deviceName: slugify(name),
      deviceNameManuallySet: false,
      systemPrompt: legacyState.systemPrompt || '',
      workspace: legacyState.workspace || legacyState.defaultCwd || '',
      model: legacyState.model || 'sonnet',
      permissions: legacyState.permissionProfile || 'dev-safe',
      gatewayUrl: legacyState.gatewayUrl || '',
      auditLogPath: legacyState.auditLogPath || '',
      mcpServers: '',
      mcpFilesystemEnabled: legacyState.mcpFilesystemEnabled || false,
      mcpFilesystemRoot: legacyState.mcpFilesystemRoot || '',
      createdAt: now,
      updatedAt: now,
    };

    // Create profile directory and write
    const profileDir = path.join(PROFILES_DIR, id);
    await fs.mkdir(profileDir, { recursive: true });
    await atomicWrite(path.join(profileDir, 'profile.json'), JSON.stringify(profile, null, 2));

    // Update index
    index.profiles.push({ id, name: profile.name, createdAt: now, updatedAt: now });
    index.activeProfileId = id;
    await writeProfilesIndex(index);

    return { ok: true, migrated: true, profileId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.whenReady().then(async () => {
  // On startup, if credentials are in plaintext (e.g. after a crash), secure them.
  if (safeStorage.isEncryptionAvailable() && !areCredentialsSecured()) {
    try {
      await secureCredentials();
    } catch (_err) {
      // Best-effort — app is starting
    }
  }

  createWindow();
  emitAgentStatus();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      emitAgentStatus();
    }
  });
});

app.on('before-quit', async () => {
  if (agentProcess) {
    sendSignalToAgentProcess(agentProcess, 'SIGTERM');
  }
  // Ensure credentials are secured on quit regardless of agent state
  try {
    await secureCredentials();
  } catch (_err) {
    // Best-effort — app is closing
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
