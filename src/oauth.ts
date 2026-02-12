import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  refresh_token?: string;
}

export interface OAuthLoginOptions {
  gatewayUrl: string;
  clientId: string;
  scope: string;
  timeoutMs: number;
  headless?: boolean;
  openBrowser?: boolean;
}

export interface OAuthLoginResult {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresIn: number;
  userID?: string;
  email?: string;
  name?: string;
}

interface JwtPayload {
  sub?: string;
  email?: string;
  name?: string;
  exp?: number;
}

function base64Url(inputBytes: Buffer): string {
  return inputBytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomString(byteLength: number): string {
  return base64Url(crypto.randomBytes(byteLength));
}

function codeChallengeFromVerifier(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier, 'utf8').digest();
  return base64Url(hash);
}

function parseJwtPayload(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length < 2) {
    return {};
  }

  try {
    const payloadRaw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadRaw + '==='.slice((payloadRaw.length + 3) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as JwtPayload;
    return parsed;
  } catch {
    return {};
  }
}

function maybeOpenBrowser(url: string): boolean {
  try {
    if (process.platform === 'darwin') {
      const child = spawn('open', [url], { stdio: 'ignore', detached: true });
      child.unref();
      return true;
    }

    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
      child.unref();
      return true;
    }

    const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function exchangeCodeForToken(params: {
  gatewayUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
}): Promise<OAuthTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });

  const resp = await fetch(`${params.gatewayUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });

  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }

  if (!resp.ok) {
    const errorText = typeof parsed === 'object' && parsed !== null
      ? (parsed as { error_description?: string; error?: string }).error_description ?? (parsed as { error?: string }).error
      : undefined;
    throw new Error(errorText ?? `token_exchange_failed_http_${resp.status}`);
  }

  const data = parsed as Partial<OAuthTokenResponse>;
  if (!data.access_token || typeof data.expires_in !== 'number') {
    throw new Error('token_exchange_invalid_response');
  }

  return {
    access_token: data.access_token,
    token_type: data.token_type ?? 'Bearer',
    expires_in: data.expires_in,
    scope: data.scope,
    refresh_token: data.refresh_token,
  };
}

async function startLocalCallback(params: {
  expectedState: string;
  timeoutMs: number;
}): Promise<{ redirectUri: string; waitForCode: () => Promise<string> }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('missing request url');
      return;
    }

    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname !== '/callback') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const error = requestUrl.searchParams.get('error');
    const state = requestUrl.searchParams.get('state') ?? '';
    const code = requestUrl.searchParams.get('code') ?? '';

    if (error) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h3>Authorization failed. Return to terminal.</h3>');
      rejectCode(new Error(`oauth_error_${error}`));
      return;
    }

    if (state !== params.expectedState) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h3>Invalid OAuth state. Return to terminal.</h3>');
      rejectCode(new Error('oauth_state_mismatch'));
      return;
    }

    if (!code) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h3>Missing authorization code. Return to terminal.</h3>');
      rejectCode(new Error('oauth_missing_code'));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h3>Authorization complete. You can close this tab and return to terminal.</h3>');
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed_to_bind_local_callback_server');
  }

  const redirectUri = `http://localhost:${address.port}/callback`;

  const waitForCode = async (): Promise<string> => {
    const timeoutHandle = setTimeout(() => {
      rejectCode(new Error(`oauth_timeout_after_${params.timeoutMs}ms`));
    }, params.timeoutMs);

    try {
      return await codePromise;
    } finally {
      clearTimeout(timeoutHandle);
      server.close();
    }
  };

  return {
    redirectUri,
    waitForCode,
  };
}

async function promptForCode(promptLabel: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const code = (await rl.question(promptLabel)).trim();
    if (!code) {
      throw new Error('authorization_code_required');
    }
    return code;
  } finally {
    rl.close();
  }
}

function buildAuthorizeURL(params: {
  gatewayUrl: string;
  redirectUri: string;
  clientId: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(`${params.gatewayUrl}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function runGatewayOAuthLogin(options: OAuthLoginOptions): Promise<OAuthLoginResult> {
  const codeVerifier = randomString(32);
  const codeChallenge = codeChallengeFromVerifier(codeVerifier);
  const state = randomString(16);

  let redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
  let authorizationCode = '';

  if (options.headless) {
    const authorizeURL = buildAuthorizeURL({
      gatewayUrl: options.gatewayUrl,
      redirectUri,
      clientId: options.clientId,
      scope: options.scope,
      state,
      codeChallenge,
    });

    console.log('[auth] headless mode enabled');
    console.log('[auth] open this URL in a browser and authenticate:');
    console.log(authorizeURL);
    authorizationCode = await promptForCode('Paste authorization code: ');
  } else {
    const callback = await startLocalCallback({
      expectedState: state,
      timeoutMs: options.timeoutMs,
    });

    redirectUri = callback.redirectUri;

    const authorizeURL = buildAuthorizeURL({
      gatewayUrl: options.gatewayUrl,
      redirectUri,
      clientId: options.clientId,
      scope: options.scope,
      state,
      codeChallenge,
    });

    if (options.openBrowser) {
      const opened = maybeOpenBrowser(authorizeURL);
      if (!opened) {
        console.log('[auth] failed to open browser automatically');
      }
    }

    console.log('[auth] complete sign-in in your browser:');
    console.log(authorizeURL);

    authorizationCode = await callback.waitForCode();
  }

  const tokenResp = await exchangeCodeForToken({
    gatewayUrl: options.gatewayUrl,
    code: authorizationCode,
    redirectUri,
    clientId: options.clientId,
    codeVerifier,
  });

  const claims = parseJwtPayload(tokenResp.access_token);

  return {
    accessToken: tokenResp.access_token,
    refreshToken: tokenResp.refresh_token,
    scope: tokenResp.scope,
    expiresIn: tokenResp.expires_in,
    userID: claims.sub,
    email: claims.email,
    name: claims.name,
  };
}
