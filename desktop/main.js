const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const MAX_AUDIT_RETURN_ENTRIES = 2000;

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
    height: 900,
    minWidth: 1100,
    minHeight: 760,
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

function buildAgentEnv(payload) {
  const env = { ...process.env };

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
  if (typeof payload?.mcpFilesystemRoot === 'string' && payload.mcpFilesystemRoot.trim()) {
    env.MCP_FILESYSTEM_ROOT = payload.mcpFilesystemRoot.trim();
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
    gatewayUrl: env.GATEWAY_URL || null,
    deviceName: env.DEVICE_NAME || null,
    defaultCwd: env.DEFAULT_CWD || null,
    model: env.MODEL || null,
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

  child.stdout.on('data', (chunk) => {
    emitAgentLog('stdout', chunk.toString('utf8'));
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

app.whenReady().then(() => {
  createWindow();
  emitAgentStatus();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      emitAgentStatus();
    }
  });
});

app.on('before-quit', () => {
  if (!agentProcess) return;
  sendSignalToAgentProcess(agentProcess, 'SIGTERM');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
