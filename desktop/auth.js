/**
 * auth.js — Gateway OAuth authentication for the desktop app (main process).
 *
 * Uses the same OAuth 2.0 + PKCE flow as the agent CLI:
 *  1. Start a local HTTP callback server on a random port
 *  2. Open the system browser to {gatewayUrl}/oauth/authorize
 *  3. User authenticates with Google in their normal browser
 *  4. Gateway redirects to http://localhost:{port}/callback?code=...&state=...
 *  5. Exchange authorization code for access_token + refresh_token
 *
 * No Firebase SDK, no Electron BrowserWindow, no embedded auth pages.
 * The system browser handles Google sign-in natively (passkeys, cookies, etc.).
 *
 * Security:
 *  - PKCE (S256) prevents authorization code interception
 *  - State parameter prevents CSRF
 *  - Local callback server only accepts GET /callback with matching state
 *  - Singleflight pattern prevents parallel token refreshes
 *  - Tokens stored in memory only (renderer never sees them)
 */

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { shell, safeStorage } = require('electron');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GATEWAY_URL = 'https://api.commands.com';
const CLIENT_ID = 'commands-agent';
const SCOPE = 'read_assets write_assets offline_access device';
const LOGIN_TIMEOUT_MS = 300_000; // 5 minutes
const TOKEN_REQUEST_TIMEOUT_MS = 30_000; // 30 seconds

// Trusted origins for auth token requests (same model as gateway-client.js)
const TRUSTED_AUTH_ORIGINS = new Set([
  'https://api.commands.com',
  'http://localhost:8091',
  'http://127.0.0.1:8091',
]);

function validateAuthOrigin(gatewayUrl) {
  const parsed = new URL(gatewayUrl);
  if (!TRUSTED_AUTH_ORIGINS.has(parsed.origin)) {
    throw new Error(`Untrusted auth origin: ${parsed.origin}`);
  }
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`HTTP not allowed for non-localhost auth: ${parsed.origin}`);
  }
}

function normalizeTrustedGatewayUrl(gatewayUrl) {
  if (typeof gatewayUrl !== 'string' || gatewayUrl.trim() === '') {
    return DEFAULT_GATEWAY_URL;
  }
  const candidate = gatewayUrl.trim();
  try {
    const parsed = new URL(candidate);
    validateAuthOrigin(parsed.origin);
    return parsed.origin;
  } catch {
    return DEFAULT_GATEWAY_URL;
  }
}

// Desktop-specific auth storage (separate from agent config.json)
const DESKTOP_AUTH_DIR = path.join(os.homedir(), '.commands-agent');
const DESKTOP_AUTH_PATH = path.join(DESKTOP_AUTH_DIR, 'desktop-auth.enc');
const DESKTOP_SIGNOUT_SENTINEL = path.join(DESKTOP_AUTH_DIR, 'desktop-signed-out');

// ---------------------------------------------------------------------------
// PKCE + URL helpers
// ---------------------------------------------------------------------------

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomString(byteLength) {
  return base64Url(crypto.randomBytes(byteLength));
}

function codeChallengeFromVerifier(verifier) {
  return base64Url(crypto.createHash('sha256').update(verifier, 'utf8').digest());
}

function parseJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return {};
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '==='.slice((raw.length + 3) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function buildAuthorizeUrl(gatewayUrl, redirectUri, state, codeChallenge) {
  const url = new URL(`${gatewayUrl}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${Math.trunc(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Callback page HTML (shown in the user's browser after auth)
// ---------------------------------------------------------------------------

function callbackPage(title, message, success) {
  const color = success ? '#10b981' : '#ef4444';
  const icon = success
    ? '<circle cx="20" cy="20" r="20" fill="#10b981"/><path d="M13 20l4 4 10-10" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<circle cx="20" cy="20" r="20" fill="#ef4444"/><path d="M14 14l12 12M26 14l-12 12" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Commands.com - ${title}</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:'Inter',system-ui,-apple-system,sans-serif;background:#0c1017;color:#e5e7eb;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:420px;width:100%;background:#131923;border:1px solid rgba(55,65,81,0.4);
border-radius:14px;padding:40px;text-align:center}
.logo{margin-bottom:28px}
.icon{margin-bottom:20px}
h2{margin:0 0 8px;font-size:20px;font-weight:600;color:${color}}
p{margin:0;color:#94a3b8;font-size:14px;line-height:1.5}
.hint{margin-top:20px;padding-top:16px;border-top:1px solid rgba(55,65,81,0.4);font-size:12px;color:#64748b}
</style></head><body>
<div class="card">
<div class="logo">
<svg viewBox="0 0 32 32" width="36" height="36" xmlns="http://www.w3.org/2000/svg">
<rect x="1" y="1" width="30" height="30" rx="4" fill="#121929" stroke="#51A2FF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
<polyline points="9 10 16 16 9 22" fill="none" stroke="#51A2FF" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="21" y="8" width="2" height="16" fill="#51A2FF"/>
</svg>
</div>
<div class="icon"><svg width="40" height="40" viewBox="0 0 40 40">${icon}</svg></div>
<h2>${title}</h2>
<p>${message}</p>
<div class="hint">You can close this tab and return to the desktop app.</div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Local callback server
// ---------------------------------------------------------------------------

function startCallbackServer(expectedState, timeoutMs) {
  return new Promise((resolveSetup, rejectSetup) => {
    let resolveCode, rejectCode;
    let setupSettled = false;
    let serverClosed = false;
    let codeSettled = false;
    const codePromise = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const settleCodeResolve = (value) => {
      if (codeSettled) return;
      codeSettled = true;
      resolveCode(value);
    };

    const settleCodeReject = (err) => {
      if (codeSettled) return;
      codeSettled = true;
      rejectCode(err);
    };

    const settleSetupResolve = (value) => {
      if (setupSettled) return;
      setupSettled = true;
      resolveSetup(value);
    };

    const settleSetupReject = (err) => {
      if (setupSettled) return;
      setupSettled = true;
      rejectSetup(err);
    };

    const closeServer = () => {
      if (!serverClosed) {
        serverClosed = true;
        try {
          server.close();
        } catch {
          // no-op
        }
      }
    };

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('missing request url');
        return;
      }

      const requestUrl = new URL(req.url, 'http://localhost');
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      const error = requestUrl.searchParams.get('error');
      const state = requestUrl.searchParams.get('state') || '';
      const code = requestUrl.searchParams.get('code') || '';

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage('Invalid Request', 'The authorization state did not match. Please try again.', false));
        // Ignore mismatched state and continue waiting for the valid callback.
        // This avoids letting unrelated localhost requests abort the whole sign-in flow.
        return;
      }

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage('Sign-In Failed', 'An error occurred during sign-in. Please try again from the desktop app.', false));
        settleCodeReject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage('Missing Code', 'No authorization code was received. Please try again.', false));
        // Ignore malformed callbacks and keep waiting for a valid code/state pair.
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackPage('Signed In', 'You have been signed in to Commands.com. You can return to the desktop app.', true));
      settleCodeResolve(code);
    });

    const onServerError = (err) => {
      const normalized = err instanceof Error ? err : new Error(String(err));
      // Reject code waiters only after setup has been handed to the caller.
      // Otherwise this can create an unhandled rejection when setup fails early.
      if (setupSettled) {
        settleCodeReject(new Error(`OAuth callback server error: ${normalized.message}`));
      }
      closeServer();
      settleSetupReject(normalized);
    };

    server.on('error', onServerError);

    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        closeServer();
        settleSetupReject(new Error('Failed to bind callback server'));
        return;
      }

      const redirectUri = `http://localhost:${addr.port}/callback`;
      const close = () => {
        closeServer();
      };

      const waitForCode = () => {
        const timer = setTimeout(() => {
          settleCodeReject(new Error('Sign-in timed out (5 minutes). Please try again.'));
        }, timeoutMs);

        return codePromise.finally(() => {
          clearTimeout(timer);
          close();
        });
      };

      const cancel = (reason = 'Sign-in cancelled') => {
        settleCodeReject(new Error(reason));
        close();
      };

      settleSetupResolve({ redirectUri, waitForCode, close, cancel });
    });
  });
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

async function exchangeCodeForToken(gatewayUrl, code, redirectUri, codeVerifier) {
  validateAuthOrigin(gatewayUrl);
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const res = await fetchWithTimeout(`${gatewayUrl}/oauth/token`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  }, TOKEN_REQUEST_TIMEOUT_MS, 'Token exchange');

  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }

  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed !== null
      ? (parsed.error_description || parsed.error)
      : undefined;
    throw new Error(msg || `Token exchange failed: HTTP ${res.status}`);
  }

  if (!parsed.access_token || typeof parsed.expires_in !== 'number') {
    throw new Error('Token exchange returned invalid response');
  }

  return parsed;
}

async function exchangeRefreshToken(gatewayUrl, refreshToken) {
  validateAuthOrigin(gatewayUrl);
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const res = await fetchWithTimeout(`${gatewayUrl}/oauth/token`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  }, TOKEN_REQUEST_TIMEOUT_MS, 'Token refresh');

  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }

  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed !== null
      ? (parsed.error_description || parsed.error)
      : undefined;
    const err = new Error(msg || `Token refresh failed: HTTP ${res.status}`);
    err.status = res.status;
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.error === 'string') {
      err.oauthError = parsed.error;
    }
    throw err;
  }

  if (!parsed.access_token || typeof parsed.expires_in !== 'number') {
    throw new Error('Token refresh returned invalid response');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _accessToken = null;
let _refreshToken = null;
let _tokenExpiresAt = 0; // ms since epoch
let _email = '';
let _uid = '';
let _gatewayUrl = DEFAULT_GATEWAY_URL;

// Singleflight: in-flight refresh promise
let _refreshInFlight = null;
let _signInInFlight = null;
let _cancelSignIn = null;

// Monotonic sign-out generation: incremented on every signOut().
// refreshAccessToken() captures the generation at start and aborts if it changed,
// preventing a stale in-flight refresh from overwriting a sign-out.
let _authGeneration = 0;

// Listeners for auth state changes
const _authChangeListeners = [];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clearTokens() {
  _accessToken = null;
  _refreshToken = null;
  _tokenExpiresAt = 0;
  _email = '';
  _uid = '';
  _gatewayUrl = normalizeTrustedGatewayUrl(_gatewayUrl);
  _refreshInFlight = null;
}

// ---------------------------------------------------------------------------
// Persistent desktop auth (encrypted via safeStorage, separate from agent config)
// ---------------------------------------------------------------------------

function saveDesktopAuth() {
  if (!safeStorage.isEncryptionAvailable()) return;
  try {
    const data = JSON.stringify({
      accessToken: _accessToken,
      refreshToken: _refreshToken,
      tokenExpiresAt: _tokenExpiresAt,
      email: _email,
      uid: _uid,
      gatewayUrl: _gatewayUrl,
    });
    fs.mkdirSync(DESKTOP_AUTH_DIR, { recursive: true });
    const tmpPath = `${DESKTOP_AUTH_PATH}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpPath, safeStorage.encryptString(data));
    fs.renameSync(tmpPath, DESKTOP_AUTH_PATH);
  } catch { /* best-effort */ }
}

function loadDesktopAuth() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const enc = fs.readFileSync(DESKTOP_AUTH_PATH);
    const data = JSON.parse(safeStorage.decryptString(enc));
    if (!data.refreshToken) return false;

    _accessToken = data.accessToken;
    _refreshToken = data.refreshToken;
    _tokenExpiresAt = data.tokenExpiresAt || 0;
    _email = data.email || '';
    _uid = data.uid || '';
    _gatewayUrl = normalizeTrustedGatewayUrl(data.gatewayUrl);
    return true;
  } catch {
    return false;
  }
}

function clearDesktopAuthFile() {
  try { fs.unlinkSync(DESKTOP_AUTH_PATH); } catch { /* may not exist */ }
}

function writeSignoutSentinel() {
  try {
    fs.mkdirSync(DESKTOP_AUTH_DIR, { recursive: true });
    fs.writeFileSync(DESKTOP_SIGNOUT_SENTINEL, '');
  } catch { /* best-effort */ }
}

function clearDesktopAuth() {
  clearDesktopAuthFile();
  // Write sentinel so startup config.json fallback is suppressed
  writeSignoutSentinel();
}

function clearSignoutSentinel() {
  try { fs.unlinkSync(DESKTOP_SIGNOUT_SENTINEL); } catch { /* may not exist */ }
}

function hasSignoutSentinel() {
  try { fs.accessSync(DESKTOP_SIGNOUT_SENTINEL); return true; } catch { return false; }
}

function notifyAuthChange() {
  const status = getAuthStatus();
  for (const listener of _authChangeListeners) {
    try { listener(status); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to restore auth on startup. Checks two sources in order:
 *  1. Desktop-specific auth (desktop-auth.enc) — persists explicit sign-in/sign-out
 *  2. Agent config (config.json) — fallback if user hasn't signed in separately
 *
 * The two are independent: signing in as a different user in the desktop app
 * never touches the agent's config.json.
 */
function tryLoadFromConfig() {
  // 1. Check desktop-specific auth first (explicit sign-in takes priority)
  if (loadDesktopAuth()) {
    notifyAuthChange();
    return { ok: true, email: _email, uid: _uid };
  }

  // 2. Fall back to agent config.json (suppressed if user explicitly signed out)
  if (hasSignoutSentinel()) {
    return { ok: false };
  }
  try {
    const configDir = path.join(os.homedir(), '.commands-agent');
    const configPath = path.join(configDir, 'config.json');

    let raw;
    try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return { ok: false }; }

    let config = JSON.parse(raw);

    // If credentials are encrypted via safeStorage, decrypt them
    if (config._credentialsSecured && safeStorage.isEncryptionAvailable()) {
      try {
        const credPath = path.join(configDir, 'credentials.enc');
        const encBuf = fs.readFileSync(credPath);
        const secrets = JSON.parse(safeStorage.decryptString(encBuf));

        if (secrets.deviceToken) config.deviceToken = secrets.deviceToken;
        if (secrets.refreshToken) config.refreshToken = secrets.refreshToken;
      } catch {
        return { ok: false };
      }
    }

    const token = config.deviceToken;
    const refresh = config.refreshToken;
    if (!token || !refresh) return { ok: false };

    const claims = parseJwtPayload(token);
    const expMs = claims.exp ? claims.exp * 1000 : 0;

    _accessToken = token;
    _refreshToken = refresh;
    _tokenExpiresAt = expMs;
    _email = config.ownerEmail || claims.email || '';
    _uid = config.ownerUID || claims.sub || '';
    _gatewayUrl = normalizeTrustedGatewayUrl(config.gatewayUrl);

    notifyAuthChange();
    return { ok: true, email: _email, uid: _uid };
  } catch {
    return { ok: false };
  }
}

/**
 * Sign in via gateway OAuth. Opens the system browser.
 * Returns { ok, email, uid } on success.
 */
async function signIn(gatewayUrl) {
  if (_signInInFlight) {
    return _signInInFlight;
  }

  _signInInFlight = (async () => {
  const genAtStart = _authGeneration;
  const hasOverride = typeof gatewayUrl === 'string' && gatewayUrl.trim() !== '';
  const gw = hasOverride
    ? normalizeTrustedGatewayUrl(gatewayUrl)
    : normalizeTrustedGatewayUrl(_gatewayUrl);
  validateAuthOrigin(gw);

  const codeVerifier = randomString(32);
  const codeChallenge = codeChallengeFromVerifier(codeVerifier);
  const state = randomString(16);

  // Start local callback server
  const { redirectUri, waitForCode, close, cancel } = await startCallbackServer(state, LOGIN_TIMEOUT_MS);
  _cancelSignIn = cancel;

  // Build authorize URL and open in system browser
  const authorizeUrl = buildAuthorizeUrl(gw, redirectUri, state, codeChallenge);
  try {
    const opened = await shell.openExternal(authorizeUrl);
    if (opened === false) {
      close();
      throw new Error('System browser did not open');
    }
  } catch (err) {
    close();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to open browser for sign-in: ${msg}`);
  }

  // Wait for the callback
  const code = await waitForCode();
  _cancelSignIn = null;

  // Exchange code for tokens
  const tokenResp = await exchangeCodeForToken(gw, code, redirectUri, codeVerifier);

  // Extract user info from JWT
  const claims = parseJwtPayload(tokenResp.access_token);

  // signOut() or another sign-in happened while this flow was in progress.
  // Discard this result to avoid reviving a stale session.
  if (_authGeneration !== genAtStart) {
    throw new Error('Sign-in cancelled');
  }

  // Invalidate any in-flight refresh so it won't overwrite the new user's tokens
  _authGeneration++;
  _refreshInFlight = null;

  _accessToken = tokenResp.access_token;
  _refreshToken = tokenResp.refresh_token || null;
  _tokenExpiresAt = Date.now() + (tokenResp.expires_in * 1000);
  _email = claims.email || '';
  _uid = claims.sub || '';
  _gatewayUrl = gw;

  clearSignoutSentinel();
  saveDesktopAuth();
  notifyAuthChange();
  return { ok: true, email: _email, uid: _uid };
  })().finally(() => {
    _cancelSignIn = null;
    _signInInFlight = null;
  });

  return _signInInFlight;
}

/**
 * Sign out — clear all tokens and state.
 */
function signOut() {
  _authGeneration++;
  if (_cancelSignIn) {
    _cancelSignIn('Sign-in cancelled by sign-out');
    _cancelSignIn = null;
  }
  clearTokens();
  clearDesktopAuth();
  notifyAuthChange();
}

/**
 * Get current access token. Refreshes automatically if expired.
 * Uses singleflight pattern to prevent concurrent refreshes.
 * @param {{ forceRefresh?: boolean }} [opts]
 */
async function getIdToken(opts) {
  if (!_refreshToken && !_accessToken) {
    throw new Error('Not signed in');
  }

  // Token still valid (with 60s buffer) — skip if forceRefresh requested
  if (!opts?.forceRefresh && _accessToken && Date.now() < _tokenExpiresAt - 60_000) {
    return _accessToken;
  }

  if (!_refreshToken) {
    throw new Error('Token expired and no refresh token available');
  }

  // Singleflight: reuse in-flight refresh if one exists
  if (_refreshInFlight) {
    return _refreshInFlight;
  }

  _refreshInFlight = refreshAccessToken()
    .finally(() => { _refreshInFlight = null; });

  return _refreshInFlight;
}

async function refreshAccessToken() {
  const genAtStart = _authGeneration;
  try {
    const tokenResp = await exchangeRefreshToken(_gatewayUrl, _refreshToken);

    // If signOut() was called while refresh was in-flight, discard the result
    if (_authGeneration !== genAtStart) {
      throw new Error('Sign-out occurred during token refresh');
    }

    const claims = parseJwtPayload(tokenResp.access_token);
    _accessToken = tokenResp.access_token;
    if (tokenResp.refresh_token) {
      _refreshToken = tokenResp.refresh_token;
    }
    _tokenExpiresAt = Date.now() + (tokenResp.expires_in * 1000);
    _email = claims.email || _email;
    _uid = claims.sub || _uid;

    saveDesktopAuth();
    return _accessToken;
  } catch (err) {
    const status = err && typeof err === 'object' ? err.status : undefined;
    const oauthError = err && typeof err === 'object' ? err.oauthError : '';
    const terminalAuthError =
      status === 400 ||
      status === 401 ||
      (typeof oauthError === 'string' && /(invalid_grant|invalid_token|unauthorized_client|invalid_client)/i.test(oauthError));

    // Only clear tokens if no new sign-in occurred while refresh was in-flight.
    // If generation changed, a new session owns the token state — don't touch it.
    if (_authGeneration === genAtStart && terminalAuthError) {
      // Persist explicit signed-out intent so startup won't fall back to config.json.
      writeSignoutSentinel();
      clearTokens();
      clearDesktopAuth();
      notifyAuthChange();
    }
    if (terminalAuthError) {
      throw new Error('Session expired — please sign in again');
    }

    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Token refresh failed: ${msg}`);
  }
}

/**
 * Get auth status (safe for renderer — no tokens exposed).
 */
function getAuthStatus() {
  return {
    signedIn: Boolean(_accessToken && (_refreshToken || Date.now() < _tokenExpiresAt)),
    email: _email,
    uid: _uid,
  };
}

/**
 * Quick boolean check.
 */
function isSignedIn() {
  return Boolean(_accessToken && (_refreshToken || Date.now() < _tokenExpiresAt));
}

/**
 * Register a listener for auth state changes.
 * Returns unsubscribe function.
 */
function onAuthChanged(listener) {
  _authChangeListeners.push(listener);
  return () => {
    const idx = _authChangeListeners.indexOf(listener);
    if (idx >= 0) _authChangeListeners.splice(idx, 1);
  };
}

/**
 * Get the gateway URL (from sign-in or config fallback).
 */
function getGatewayUrl() {
  _gatewayUrl = normalizeTrustedGatewayUrl(_gatewayUrl);
  return _gatewayUrl;
}

/**
 * Get raw credentials for syncing into the agent's config.json before launch.
 * Refreshes the access token if needed so the agent starts with a valid token.
 * Returns null if not signed in.
 */
async function getCredentialsForAgent() {
  if (!_refreshToken) return null;
  try {
    // Ensure we have a fresh access token
    const freshToken = await getIdToken();
    return {
      accessToken: freshToken,
      refreshToken: _refreshToken,
      gatewayUrl: normalizeTrustedGatewayUrl(_gatewayUrl),
      ownerUID: _uid,
      email: _email,
    };
  } catch {
    // If refresh fails, return what we have (agent can refresh on its own)
    if (!_accessToken) return null;
    return {
      accessToken: _accessToken,
      refreshToken: _refreshToken,
      gatewayUrl: normalizeTrustedGatewayUrl(_gatewayUrl),
      ownerUID: _uid,
      email: _email,
    };
  }
}

module.exports = {
  tryLoadFromConfig,
  signIn,
  signOut,
  getIdToken,
  getAuthStatus,
  isSignedIn,
  onAuthChanged,
  getGatewayUrl,
  getCredentialsForAgent,
};
