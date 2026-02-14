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
const DEFAULT_AGENT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_GATEWAY_URL = 'https://api.commands.com';
const DESKTOP_SETTINGS_PATH = path.join(os.homedir(), '.commands-agent', 'desktop-settings.json');
const VALID_MODELS = ['opus', 'sonnet', 'haiku'];
const VALID_PERMISSIONS = ['read-only', 'dev-safe', 'full'];
const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const TRUSTED_AGENT_PACKAGE_NAMES = new Set(['commands-com-agent']);
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const AVATAR_MAGIC = {
  png:  Buffer.from([0x89, 0x50, 0x4E, 0x47]),
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
  webp_riff: Buffer.from([0x52, 0x49, 0x46, 0x46]),
  webp_tag:  Buffer.from([0x57, 0x45, 0x42, 0x50]),
};

const auth = require('./auth.js');
const sessionManager = require('./session-manager.js');
const gatewayClient = require('./gateway-client.js');

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

const RENDERER_INDEX_PATH = path.normalize(path.join(__dirname, 'renderer', 'index.html'));

function normalizeFileUrlPath(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'file:') {
    return '';
  }
  let filePath = decodeURIComponent(parsed.pathname);
  if (process.platform === 'win32' && filePath.startsWith('/')) {
    filePath = filePath.slice(1);
  }
  return path.normalize(filePath);
}

function isAllowedRendererNavigation(url) {
  try {
    return normalizeFileUrlPath(url) === RENDERER_INDEX_PATH;
  } catch {
    return false;
  }
}

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
      sandbox: true
    }
  });

  win.loadFile(RENDERER_INDEX_PATH);

  // Block navigation away from the exact local renderer page (anti-phishing).
  // Do not allow arbitrary file:// navigations.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererNavigation(url)) {
      event.preventDefault();
    }
  });

  // Block popup windows entirely.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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

function waitForAgentProcessExit(proc, timeoutMs) {
  if (!proc) return Promise.resolve(true);
  if (proc.exitCode != null || proc.signalCode != null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('close', onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once('close', onClose);
  });
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

function normalizeAgentRoot(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let candidate = value.trim();
  if (!candidate) {
    return '';
  }

  if (candidate === '~') {
    candidate = os.homedir();
  } else if (candidate.startsWith('~/')) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }

  if (!path.isAbsolute(candidate)) {
    return '';
  }

  return path.normalize(candidate);
}

function normalizeProfileGatewayUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const candidate = value.trim();
  if (!candidate) {
    return '';
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) {
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

function defaultDesktopSettings() {
  return {
    defaultAgentRoot: '',
  };
}

function sanitizeDesktopSettings(raw) {
  const settings = defaultDesktopSettings();
  if (!raw || typeof raw !== 'object') {
    return settings;
  }
  settings.defaultAgentRoot = normalizeAgentRoot(raw.defaultAgentRoot);
  return settings;
}

async function readDesktopSettings() {
  try {
    const raw = await fs.readFile(DESKTOP_SETTINGS_PATH, 'utf8');
    return sanitizeDesktopSettings(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return defaultDesktopSettings();
    }
    return defaultDesktopSettings();
  }
}

async function writeDesktopSettings(settings) {
  const sanitized = sanitizeDesktopSettings(settings);
  await fs.mkdir(path.dirname(DESKTOP_SETTINGS_PATH), { recursive: true });
  await atomicWrite(DESKTOP_SETTINGS_PATH, JSON.stringify(sanitized, null, 2));
  return sanitized;
}

function resolveAgentRoot(desktopSettings) {
  const fromGlobal = normalizeAgentRoot(desktopSettings?.defaultAgentRoot);
  if (fromGlobal) {
    return fromGlobal;
  }
  return DEFAULT_AGENT_ROOT;
}

function defaultAuditLogPath(profileId) {
  if (profileId && validateProfileId(profileId)) {
    return path.join(PROFILES_DIR, profileId, 'audit.log');
  }
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

async function realpathOrResolve(filePath) {
  const abs = path.resolve(filePath);
  try {
    return await fs.realpath(abs);
  } catch {
    return abs;
  }
}

async function validateAgentInstallRoot(rootPath) {
  const normalized = normalizeAgentRoot(rootPath);
  if (!normalized) {
    return { ok: false, error: 'Default Agent Install Root must be an absolute path' };
  }

  const canonicalRoot = await realpathOrResolve(normalized);

  let rootStat;
  try {
    rootStat = await fs.stat(canonicalRoot);
  } catch {
    return { ok: false, error: 'Default Agent Install Root does not exist' };
  }
  if (!rootStat.isDirectory()) {
    return { ok: false, error: 'Default Agent Install Root must be a directory' };
  }

  const scriptPath = path.join(canonicalRoot, 'start-agent.sh');
  try {
    const scriptStat = await fs.stat(scriptPath);
    if (!scriptStat.isFile()) {
      return { ok: false, error: 'Default Agent Install Root must contain start-agent.sh' };
    }
  } catch {
    return { ok: false, error: 'Default Agent Install Root must contain start-agent.sh' };
  }

  const packageJsonPath = path.join(canonicalRoot, 'package.json');
  let packageJsonRaw = '';
  try {
    packageJsonRaw = await fs.readFile(packageJsonPath, 'utf8');
  } catch {
    return { ok: false, error: 'Default Agent Install Root must contain package.json' };
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonRaw);
  } catch {
    return { ok: false, error: 'Default Agent Install Root has invalid package.json' };
  }

  if (!TRUSTED_AGENT_PACKAGE_NAMES.has(packageJson?.name)) {
    return { ok: false, error: 'Default Agent Install Root is not a trusted commands-com-agent install' };
  }

  return { ok: true, rootPath: canonicalRoot };
}

async function isAllowedAuditLogPath(auditLogPath, profileId, configuredAuditLogPath = '') {
  const candidate = await realpathOrResolve(auditLogPath);
  const allowedFiles = [defaultAuditLogPath(profileId)];
  if (typeof configuredAuditLogPath === 'string' && configuredAuditLogPath.trim()) {
    allowedFiles.push(configuredAuditLogPath.trim());
  }

  const resolvedAllowedFiles = await Promise.all(allowedFiles.map((filePath) => realpathOrResolve(filePath)));
  return resolvedAllowedFiles.some((allowedFile) => path.resolve(allowedFile) === path.resolve(candidate));
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

function isPathWithin(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeProfileAuditLogPath(rawPath, profileId) {
  if (!validateProfileId(profileId)) return '';
  if (typeof rawPath !== 'string') return '';

  let candidate = rawPath.trim();
  if (!candidate) return '';

  if (candidate === '~') {
    candidate = os.homedir();
  } else if (candidate.startsWith('~/')) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }

  if (!path.isAbsolute(candidate)) {
    return '';
  }

  const normalized = path.normalize(candidate);
  const profileDir = path.join(PROFILES_DIR, profileId);
  return isPathWithin(profileDir, normalized) ? normalized : '';
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
  await atomicWriteBuffer(credPath, encrypted);
  if (process.platform !== 'win32') {
    await fs.chmod(credPath, 0o600);
  }

  const redacted = redactConfig(config);
  await atomicWrite(configPath, JSON.stringify(redacted, null, 2));

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

  await atomicWrite(configPath, JSON.stringify(restored, null, 2));

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

function buildAgentEnv(launchProfile, runtimeOptions, agentRoot) {
  const env = { ...process.env };
  // Prevent inherited shell env from forcing external MCP config in desktop mode.
  delete env.MCP_CONFIG;
  delete env.MCP_FILESYSTEM_ENABLED;
  delete env.MCP_FILESYSTEM_ROOT;

  const profileGatewayUrl = typeof launchProfile?.gatewayUrl === 'string' ? launchProfile.gatewayUrl.trim() : '';
  if (profileGatewayUrl) {
    env.GATEWAY_URL = normalizeProfileGatewayUrl(profileGatewayUrl) || DEFAULT_GATEWAY_URL;
  } else {
    env.GATEWAY_URL = DEFAULT_GATEWAY_URL;
  }

  const normalizedDeviceName = sanitizeDeviceName(launchProfile?.deviceName);
  if (normalizedDeviceName) {
    env.DEVICE_NAME = normalizedDeviceName;
  }

  if (typeof launchProfile?.workspace === 'string' && launchProfile.workspace.trim()) {
    const workspace = launchProfile.workspace.trim();
    if (path.isAbsolute(workspace)) {
      env.DEFAULT_CWD = workspace;
    }
  }

  if (typeof launchProfile?.model === 'string' && launchProfile.model.trim()) {
    env.MODEL = launchProfile.model.trim();
  }

  if (typeof launchProfile?.permissions === 'string' && launchProfile.permissions.trim()) {
    env.PERMISSION_PROFILE = launchProfile.permissions.trim();
  }

  if (typeof launchProfile?.mcpFilesystemRoot === 'string' && launchProfile.mcpFilesystemRoot.trim()) {
    const fsRoot = launchProfile.mcpFilesystemRoot.trim();
    if (path.isAbsolute(fsRoot)) {
      env.MCP_FILESYSTEM_ROOT = fsRoot;
    }
  }
  if (typeof launchProfile?.mcpFilesystemEnabled === 'boolean') {
    env.MCP_FILESYSTEM_ENABLED = launchProfile.mcpFilesystemEnabled ? '1' : '0';
  }

  if (typeof launchProfile?.auditLogPath === 'string' && launchProfile.auditLogPath.trim()) {
    env.AUDIT_LOG_PATH = resolveAuditLogPath(launchProfile.auditLogPath, agentRoot);
  } else {
    env.AUDIT_LOG_PATH = defaultAuditLogPath(launchProfile?.id);
  }

  if (runtimeOptions?.forceInit === true) {
    env.INIT_AGENT = '1';
  }
  env.AUTH_MODE = 'oauth';

  if (runtimeOptions?.headless === true) {
    env.HEADLESS = '1';
  }

  if (typeof launchProfile?.systemPrompt === 'string' && launchProfile.systemPrompt.trim()) {
    env.SYSTEM_PROMPT = launchProfile.systemPrompt;
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

  if (Object.prototype.hasOwnProperty.call(payload, 'agentRoot')) {
    return {
      ok: false,
      error: 'agentRoot override is not allowed; configure Default Agent Install Root in Settings',
      status: snapshotAgentState()
    };
  }

  const profileId = typeof payload?.profileId === 'string' ? payload.profileId : '';
  if (!profileId) {
    return {
      ok: false,
      error: 'profileId is required',
      status: snapshotAgentState()
    };
  }
  if (!validateProfileId(profileId)) {
    return {
      ok: false,
      error: 'invalid profile id',
      status: snapshotAgentState()
    };
  }

  const launchProfile = await readProfileById(profileId);
  if (!launchProfile) {
    return {
      ok: false,
      error: 'profile not found',
      status: snapshotAgentState()
    };
  }

  const desktopSettings = await readDesktopSettings();
  const resolvedAgentRoot = resolveAgentRoot(desktopSettings);
  const rootValidation = await validateAgentInstallRoot(resolvedAgentRoot);
  if (!rootValidation.ok) {
    return {
      ok: false,
      error: rootValidation.error,
      status: snapshotAgentState()
    };
  }
  const agentRoot = rootValidation.rootPath;
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
  const desiredDeviceName = typeof launchProfile?.deviceName === 'string' ? launchProfile.deviceName.trim() : '';
  if (desiredDeviceName) {
    try {
      const agentConfigPath = path.join(os.homedir(), '.commands-agent', 'config.json');
      const raw = await fs.readFile(agentConfigPath, 'utf8');
      const agentConfig = JSON.parse(raw);
      // Sanitize to match the agent SDK's sanitizeDeviceSegment logic
      const desiredId = sanitizeDeviceName(desiredDeviceName);
      if (desiredId && agentConfig.deviceId && agentConfig.deviceId !== desiredId) {
        emitAgentLog('system', `[desktop] updating deviceId: ${agentConfig.deviceId} → ${desiredId}`);
        agentConfig.deviceId = desiredId;
        const tmp = agentConfigPath + '.tmp.' + Date.now() + '.' + randomBytes(4).toString('hex');
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
      if (restoreResult.reason !== 'no config file') {
        return {
          ok: false,
          error: `failed to restore credentials: ${restoreResult.reason}`,
          status: snapshotAgentState()
        };
      }
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

  // Renderer-controlled runtime toggles only. All agent config comes from launchProfile.
  const runtimeOptions = {
    forceInit: payload?.forceInit === true,
    headless: payload?.headless === true,
  };
  const env = buildAgentEnv(launchProfile, runtimeOptions, agentRoot);
  let child;
  try {
    child = spawn('/usr/bin/env', ['bash', scriptPath], {
      cwd: agentRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitAgentLog('system', `[desktop] failed to spawn agent: ${msg}`);
    // Credentials were restored above; re-secure them before returning.
    try {
      await secureCredentials();
    } catch (_secureErr) {
      // best-effort
    }
    return {
      ok: false,
      error: `failed to start agent: ${msg}`,
      status: snapshotAgentState()
    };
  }

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
    profileId: launchProfile?.id || null,
    gatewayUrl: env.GATEWAY_URL || null,
    deviceName: env.DEVICE_NAME || null,
    defaultCwd: env.DEFAULT_CWD || null,
    model: env.MODEL || null,
    permissionProfile: env.PERMISSION_PROFILE || null,
    mcpFilesystemEnabled: env.MCP_FILESYSTEM_ENABLED || null,
    auditLogPath: env.AUDIT_LOG_PATH || defaultAuditLogPath(launchProfile?.id),
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
  const STDOUT_BUFFER_MAX = 1024 * 1024; // 1 MB cap to prevent OOM on long lines
  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    if (stdoutBuffer.length > STDOUT_BUFFER_MAX) {
      emitAgentLog('system', '[desktop] stdout buffer overflow — truncating');
      stdoutBuffer = stdoutBuffer.slice(-STDOUT_BUFFER_MAX);
    }
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
  let stderrTail = '';
  const STDERR_TAIL_MAX = 4096;
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    emitAgentLog('stderr', text);
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX);
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

    // Detect known fatal errors from stderr and surface user-friendly messages
    if (code !== 0 && stderrTail) {
      if (/Failed to register identity key/i.test(stderrTail)) {
        if (/owned by a different account/i.test(stderrTail) || /403/i.test(stderrTail)) {
          agentState.lastError = 'Device name is already registered to a different account. Rename the device in Settings or sign in with the original account.';
        } else {
          agentState.lastError = 'Failed to register device with gateway. Check logs for details.';
        }
      } else if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(stderrTail)) {
        agentState.lastError = 'Could not reach the gateway. Check your internet connection and gateway URL.';
      }
    }

    emitAgentLog(
      'system',
      `[desktop] agent exited code=${code == null ? 'null' : code} signal=${signal || 'none'}`
    );
    if (agentState.lastError) {
      emitAgentLog('system', `[desktop] ${agentState.lastError}`);
    }
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

const SAFE_URL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

ipcMain.handle('desktop:open-url', async (_event, url) => {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, error: 'invalid url' };
  }
  // Allowlist URL schemes — block javascript:, data:, file:, etc.
  try {
    const parsed = new URL(url);
    if (!SAFE_URL_SCHEMES.has(parsed.protocol)) {
      return { ok: false, error: `blocked URL scheme: ${parsed.protocol}` };
    }
  } catch {
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

ipcMain.handle('desktop:settings:get', async () => {
  try {
    const settings = await readDesktopSettings();
    return {
      ok: true,
      settings,
      effectiveAgentRoot: resolveAgentRoot(settings),
      bundledAgentRoot: DEFAULT_AGENT_ROOT,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:settings:save', async (_event, payload) => {
  try {
    const raw = payload?.settings;
    const requestedRoot = typeof raw?.defaultAgentRoot === 'string' ? raw.defaultAgentRoot.trim() : '';
    let validatedRoot = '';
    if (requestedRoot) {
      const validation = await validateAgentInstallRoot(requestedRoot);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      validatedRoot = validation.rootPath;
    }

    const current = await readDesktopSettings();
    const next = {
      ...current,
      defaultAgentRoot: validatedRoot,
    };
    const saved = await writeDesktopSettings(next);
    return {
      ok: true,
      settings: saved,
      effectiveAgentRoot: resolveAgentRoot(saved),
      bundledAgentRoot: DEFAULT_AGENT_ROOT,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:audit:read', async (_event, payload) => {
  const profileId = payload?.profileId;
  if (profileId && !validateProfileId(profileId)) {
    return { ok: false, error: 'Invalid profile id' };
  }

  const profile = profileId ? await readProfileById(profileId) : null;
  if (profileId && !profile) {
    return { ok: false, error: 'Profile not found' };
  }

  const desktopSettings = await readDesktopSettings();
  const agentRoot = resolveAgentRoot(desktopSettings);
  const configuredAuditLogPath = profile?.auditLogPath || '';
  const resolvedConfiguredAuditLogPath = configuredAuditLogPath.trim()
    ? resolveAuditLogPath(configuredAuditLogPath, agentRoot)
    : '';
  const auditLogPath = resolvedConfiguredAuditLogPath
    ? resolvedConfiguredAuditLogPath
    : defaultAuditLogPath(profileId);
  if (!(await isAllowedAuditLogPath(auditLogPath, profileId, resolvedConfiguredAuditLogPath))) {
    return { ok: false, error: 'Invalid auditLogPath: outside allowed directories' };
  }
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

ipcMain.handle('desktop:agent:start', async (_event, payload) => {
  const body = payload && typeof payload === 'object' ? payload : {};
  return startAgent(body);
});
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

function sanitizeDeviceName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

function applyDeviceSuffix(base, suffix) {
  const suffixText = `-${suffix}`;
  const maxBaseLen = Math.max(1, 32 - suffixText.length);
  const trimmedBase = base.slice(0, maxBaseLen).replace(/-+$/g, '') || 'agent';
  return `${trimmedBase}${suffixText}`;
}

async function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + Date.now() + '.' + randomBytes(4).toString('hex');
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

async function atomicWriteBuffer(filePath, data) {
  const tmp = filePath + '.tmp.' + Date.now() + '.' + randomBytes(4).toString('hex');
  await fs.writeFile(tmp, data);
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

async function readProfileById(id) {
  if (!validateProfileId(id)) {
    return null;
  }

  const profilePath = path.join(PROFILES_DIR, id, 'profile.json');
  try {
    const raw = await fs.readFile(profilePath, 'utf8');
    return migrateProfile(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
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
    const trimmedGatewayUrl = incoming.gatewayUrl.trim();
    if (trimmedGatewayUrl === '') {
      allowed.gatewayUrl = '';
    } else {
      const normalizedGatewayUrl = normalizeProfileGatewayUrl(trimmedGatewayUrl);
      if (normalizedGatewayUrl) {
        allowed.gatewayUrl = normalizedGatewayUrl;
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
    const fsRoot = incoming.mcpFilesystemRoot.trim();
    if (fsRoot === '' || path.isAbsolute(fsRoot)) {
      allowed.mcpFilesystemRoot = fsRoot;
    }
  }

  return allowed;
}

function resolveDeviceName(profile, allProfiles) {
  const usedNames = new Set(
    (allProfiles || [])
      .filter((p) => p.id !== profile.id)
      .map((p) => sanitizeDeviceName(p.deviceName))
      .filter((name) => name.length > 0)
  );

  // If manually set, keep it as-is
  if (profile.deviceNameManuallySet && profile.deviceName) {
    const manual = sanitizeDeviceName(profile.deviceName);
    if (manual) {
      return manual;
    }
  }

  // Auto-generate from name
  const base = sanitizeDeviceName(profile.name || profile.deviceName || 'agent') || 'agent';
  let candidate = base;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = applyDeviceSuffix(base, suffix);
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
      const normalizedAuditLogPath = normalizeProfileAuditLogPath(sanitized.auditLogPath, id);

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
        auditLogPath: normalizedAuditLogPath,
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
      profile.auditLogPath = normalizeProfileAuditLogPath(profile.auditLogPath, existing.id);

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

    // Deregister device from gateway (best-effort — don't block local delete)
    const profile = await readProfileById(id);
    const deviceName = profile?.deviceName;
    if (deviceName && auth.isSignedIn()) {
      try {
        const gatewayUrl = getGatewayUrl();
        await gatewayClient.deleteDevice(gatewayUrl, deviceName);
      } catch (err) {
        console.log(`[profiles] gateway device deregister failed for ${deviceName}: ${err.message || err}`);
      }
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
      deviceName: sanitizeDeviceName(name) || 'agent',
      deviceNameManuallySet: false,
      systemPrompt: legacyState.systemPrompt || '',
      workspace: legacyState.workspace || legacyState.defaultCwd || '',
      model: legacyState.model || 'sonnet',
      permissions: legacyState.permissionProfile || 'dev-safe',
      gatewayUrl: legacyState.gatewayUrl || '',
      auditLogPath: normalizeProfileAuditLogPath(legacyState.auditLogPath || '', id),
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

// ---------------------------------------------------------------------------
// Auth IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('desktop:auth:sign-in', async () => {
  try {
    return await auth.signIn();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:auth:sign-out', async () => {
  try {
    sessionManager.endAllSessions();
    stopDeviceSSE();
    _msgTimestamps.clear();
    auth.signOut();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:auth:status', async () => {
  return { ok: true, ...auth.getAuthStatus() };
});

// ---------------------------------------------------------------------------
// Gateway IPC handlers
// ---------------------------------------------------------------------------

const DEVICE_ID_RE = /^[a-zA-Z0-9._:-]+$/;

ipcMain.handle('desktop:gateway:devices', async () => {
  try {
    const gatewayUrl = getGatewayUrl();
    const result = await gatewayClient.fetchDevices(gatewayUrl);
    const devices = result.devices || result;
    return { ok: true, devices };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:gateway:start-session', async (_event, payload) => {
  try {
    const deviceId = payload?.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length > 128 || !DEVICE_ID_RE.test(deviceId)) {
      return { ok: false, error: 'Invalid deviceId' };
    }
    const gatewayUrl = getGatewayUrl();
    return await sessionManager.startSession(gatewayUrl, deviceId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// Rate limiting for sendMessage: 10 msg/sec per device
const _msgTimestamps = new Map(); // deviceId → [timestamps]
const MSG_RATE_WINDOW_MS = 1000;
const MSG_RATE_LIMIT = 10;
const MSG_RATE_MAX_TRACKED_DEVICES = 500;

function pruneMsgRateState(now) {
  for (const [key, timestamps] of _msgTimestamps.entries()) {
    const recent = timestamps.filter((t) => now - t < MSG_RATE_WINDOW_MS);
    if (recent.length > 0) {
      _msgTimestamps.set(key, recent);
    } else {
      _msgTimestamps.delete(key);
    }
  }
  while (_msgTimestamps.size > MSG_RATE_MAX_TRACKED_DEVICES) {
    const oldestKey = _msgTimestamps.keys().next().value;
    if (oldestKey === undefined) break;
    _msgTimestamps.delete(oldestKey);
  }
}

ipcMain.handle('desktop:gateway:send-message', async (_event, payload) => {
  try {
    const deviceId = payload?.deviceId;
    const text = payload?.text;
    if (typeof deviceId !== 'string' || deviceId.length > 128 || !DEVICE_ID_RE.test(deviceId)) {
      return { ok: false, error: 'Invalid deviceId' };
    }
    if (typeof text !== 'string' || text.length > 100_000) {
      return { ok: false, error: 'Invalid message (must be string <= 100000 chars)' };
    }

    // Rate limit check
    const now = Date.now();
    pruneMsgRateState(now);
    const timestamps = _msgTimestamps.get(deviceId) || [];
    const recent = timestamps;
    if (recent.length >= MSG_RATE_LIMIT) {
      return { ok: false, error: 'Rate limit exceeded (10 msg/sec)' };
    }
    recent.push(now);
    _msgTimestamps.set(deviceId, recent);

    const gatewayUrl = getGatewayUrl();
    return await sessionManager.sendChatMessage(gatewayUrl, deviceId, text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('desktop:gateway:end-session', async (_event, payload) => {
  try {
    const deviceId = payload?.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length > 128 || !DEVICE_ID_RE.test(deviceId)) {
      return { ok: false, error: 'Invalid deviceId' };
    }
    sessionManager.endSession(deviceId);
    _msgTimestamps.delete(deviceId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ---------------------------------------------------------------------------
// Device SSE subscription (auto-start on sign-in, auto-stop on sign-out)
// ---------------------------------------------------------------------------

let _deviceSseAbort = null;
let _lastAuthUid = null;

function getGatewayUrl() {
  // Use the gateway URL from auth (which tracks config.json / sign-in source)
  // to avoid token/endpoint mismatch when running against non-prod gateways.
  return auth.getGatewayUrl?.() || 'https://api.commands.com';
}

function startDeviceSSE() {
  if (_deviceSseAbort) return; // already running
  _deviceSseAbort = new AbortController();
  const gatewayUrl = getGatewayUrl();
  const currentAbort = _deviceSseAbort;
  gatewayClient.subscribeDeviceEvents(
    gatewayUrl,
    (sseEvent) => {
      try {
        const data = JSON.parse(sseEvent.data);
        emitToAllWindows('desktop:gateway-device-event', data);
      } catch {
        // skip malformed
      }
    },
    currentAbort.signal
  ).catch((err) => {
    if (currentAbort.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    emitAgentLog('system', `[desktop] device SSE stopped: ${message}`);
    emitToAllWindows('desktop:gateway-device-event', {
      type: 'device.sse.error',
      error: message,
    });
  }).finally(() => {
    // Clear the guard so SSE can be restarted (e.g. after terminal error or abort)
    if (_deviceSseAbort === currentAbort) {
      _deviceSseAbort = null;
    }
  });
}

function stopDeviceSSE() {
  if (_deviceSseAbort) {
    _deviceSseAbort.abort();
    _deviceSseAbort = null;
  }
}

// Listen for auth state changes to auto-start/stop device SSE
auth.onAuthChanged((status) => {
  const prevUid = _lastAuthUid;
  const nextUid = status.signedIn ? (status.uid || null) : null;
  _lastAuthUid = nextUid;

  emitToAllWindows('desktop:auth-changed', status);
  if (status.signedIn) {
    // If account switched without an explicit sign-out, tear down prior sessions.
    if (prevUid && nextUid && prevUid !== nextUid) {
      sessionManager.endAllSessions();
      _msgTimestamps.clear();
      stopDeviceSSE();
    }
    startDeviceSSE();
  } else {
    stopDeviceSSE();
    sessionManager.endAllSessions();
    _msgTimestamps.clear();
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

  // Try loading auth from existing agent config (skips OAuth if already registered)
  auth.tryLoadFromConfig();

  createWindow();
  emitAgentStatus();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      emitAgentStatus();
    }
  });
});

let _quitSecureInFlight = false;
let _finalQuitRequested = false;
app.on('before-quit', (event) => {
  // Final pass (triggered by app.quit() below) should continue shutdown.
  if (_finalQuitRequested) {
    return;
  }

  // Ignore duplicate before-quit emissions while shutdown is already in progress.
  if (_quitSecureInFlight) {
    event.preventDefault();
    return;
  }

  event.preventDefault();
  _quitSecureInFlight = true;

  // Secure credentials before allowing process exit.
  Promise.resolve()
    .then(async () => {
      const proc = agentProcess;
      if (proc) {
        emitAgentLog('system', '[desktop] stopping agent before quit');
        sendSignalToAgentProcess(proc, 'SIGTERM');
        const exitedGracefully = await waitForAgentProcessExit(proc, 5000);
        if (!exitedGracefully && agentProcess === proc) {
          emitAgentLog('system', '[desktop] agent did not exit during quit; escalating to SIGKILL');
          sendSignalToAgentProcess(proc, 'SIGKILL');
          await waitForAgentProcessExit(proc, 2000);
        }
      }

      await secureCredentials();
    })
    .catch(() => {
      // Best-effort — app is closing
    })
    .finally(() => {
      _finalQuitRequested = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
