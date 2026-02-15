#!/usr/bin/env node

import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import {
  CONFIG_DIR,
  CONFIG_PATH,
  loadConfig,
  normalizeGatewayUrl,
  requireConfig,
  saveConfig,
} from './config.js';
import { generateIdentity, shortFingerprint } from './crypto.js';
import { runPrompt } from './claude.js';
import { runOllamaPrompt } from './ollama.js';
import { gatewayHealth, registerIdentityKey } from './gateway.js';
import { acknowledgeHandshake } from './handshake.js';
import { startRuntime } from './runtime.js';
import { describeMcpServers, loadMcpServersFromFile } from './mcp.js';
import { refreshGatewayOAuthToken, runGatewayOAuthLogin } from './oauth.js';
import { createDefaultPolicy } from './policy.js';
import type { AgentConfig, AgentMcpServers, AgentProvider, PermissionProfile } from './types.js';

type ParsedArgs = {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const [, , command = 'help', ...rest] = argv;
  const flags = new Map<string, string>();
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=');
      if (eqIndex >= 0) {
        flags.set(token.slice(2, eqIndex), token.slice(eqIndex + 1));
        continue;
      }

      const key = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, 'true');
      }
      continue;
    }
    positionals.push(token);
  }

  return { command, flags, positionals };
}

function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) {
    throw new Error(`Missing required flag --${key}`);
  }
  return value;
}

function optional(flags: Map<string, string>, key: string, fallback: string): string {
  return flags.get(key) ?? fallback;
}

function hasFlag(flags: Map<string, string>, key: string): boolean {
  return flags.has(key);
}

function parseIntStrict(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value for ${fieldName}: ${value}`);
  }
  return Math.floor(parsed);
}

function isInvalidJWTError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('invalid jwt token') || normalized.includes('failed to parse token');
}

function isRefreshTokenMissingError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('refresh token not found or expired');
}

function isPermissionProfile(value: string): value is PermissionProfile {
  return value === 'read-only' || value === 'dev-safe' || value === 'full';
}

function isAgentProvider(value: string): value is AgentProvider {
  return value === 'claude' || value === 'ollama';
}

function resolveProvider(candidate: string | undefined, fallback: AgentProvider = 'claude'): AgentProvider {
  if (candidate && candidate.trim().length > 0) {
    const normalized = candidate.trim().toLowerCase();
    if (!isAgentProvider(normalized)) {
      throw new Error(`Invalid provider "${candidate}". Use claude or ollama.`);
    }
    return normalized;
  }
  return fallback;
}

function defaultModelForProvider(provider: AgentProvider): string {
  if (provider === 'ollama') {
    return 'llama3.2';
  }
  return 'sonnet';
}

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const LOCAL_OLLAMA_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeOllamaBaseUrl(input: string | undefined): string {
  const raw = (input || DEFAULT_OLLAMA_BASE_URL).trim();
  if (!raw) {
    return DEFAULT_OLLAMA_BASE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Ollama base URL: ${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid Ollama protocol: ${parsed.protocol}`);
  }
  if (!LOCAL_OLLAMA_HOSTS.has(parsed.hostname)) {
    throw new Error(`Ollama host must be loopback (localhost/127.0.0.1/::1): ${parsed.hostname}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Ollama URL cannot include auth credentials');
  }

  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function resolvePermissionProfile(
  candidate: string | undefined,
  fallback: PermissionProfile = 'dev-safe'
): PermissionProfile {
  if (candidate && candidate.trim().length > 0) {
    const normalized = candidate.trim().toLowerCase();
    if (!isPermissionProfile(normalized)) {
      throw new Error(`Invalid permission profile "${candidate}". Use read-only, dev-safe, or full.`);
    }
    return normalized;
  }
  return fallback;
}

async function resolveMcpServers(
  flags: Map<string, string>,
  fallback: AgentMcpServers | undefined
): Promise<AgentMcpServers | undefined> {
  const mcpConfigPath = flags.get('mcp-config');
  if (!mcpConfigPath) {
    return fallback;
  }

  return loadMcpServersFromFile(mcpConfigPath);
}

function generatedDeviceID(): string {
  return `dev_${crypto.randomBytes(16).toString('hex')}`;
}

function createRuntimePolicy(permissionProfile: PermissionProfile, allowedRoot: string): AgentConfig['policy'] {
  if (permissionProfile === 'full') {
    return undefined;
  }

  if (permissionProfile === 'read-only') {
    return createDefaultPolicy({
      preset: 'safe',
      allowedRoot,
    });
  }

  return createDefaultPolicy({
    preset: 'balanced',
    allowedRoot,
  });
}

function printHelp(): void {
  console.log(`commands-com-agent

Commands:
  login           Browser OAuth (Firebase) device registration
  init            Manual initialization with device token (headless fallback)
  status          Show local config status and gateway health
  run             Execute a local prompt using configured provider (Claude/Ollama)
  ack-handshake   Create/sign/post handshake ack to gateway
  start           Start always-on websocket runtime with reconnect

Examples:
  commands-agent login --gateway-url https://api.commands.com
  commands-agent login --gateway-url https://api.commands.com --device-name "office-mac"
  commands-agent login --gateway-url https://api.commands.com --headless
  commands-agent init --gateway-url https://api.commands.com --device-id dev_123 --device-token <token>
  commands-agent run --prompt "Summarize this repository" --cwd /Users/me/Code/app --permission-profile read-only
  commands-agent start --provider ollama --model llama3.2 --ollama-base-url http://localhost:11434
  commands-agent start --default-cwd /Users/me/Code --heartbeat-ms 15000 --audit-log-path ~/.commands-agent/audit.log --permission-profile dev-safe
`);
}

async function cmdLogin(flags: Map<string, string>): Promise<void> {
  const gatewayUrl = normalizeGatewayUrl(optional(flags, 'gateway-url', 'https://api.commands.com'));
  const existing = await loadConfig();
  const provider = resolveProvider(flags.get('provider')?.trim(), existing?.provider ?? 'claude');
  const model = optional(flags, 'model', defaultModelForProvider(provider));
  const ollamaBaseUrl = provider === 'ollama'
    ? normalizeOllamaBaseUrl(flags.get('ollama-base-url')?.trim() || existing?.ollamaBaseUrl)
    : undefined;
  const scope = optional(flags, 'scope', 'read_assets write_assets offline_access device');
  const clientId = optional(flags, 'client-id', 'commands-agent');
  const timeoutSeconds = parseIntStrict(optional(flags, 'timeout-seconds', '300'), 'timeout-seconds');
  const headless = hasFlag(flags, 'headless');
  const openBrowser = !headless && !hasFlag(flags, 'no-open-browser');

  const mcpServers = await resolveMcpServers(flags, undefined);

  console.log('[auth] starting gateway OAuth login');
  const oauth = await runGatewayOAuthLogin({
    gatewayUrl,
    clientId,
    scope,
    timeoutMs: timeoutSeconds * 1000,
    headless,
    openBrowser,
  });

  const requestedDeviceID = flags.get('device-id')?.trim();
  const requestedDeviceName = flags.get('device-name')?.trim();
  const defaultPermissionProfile = resolvePermissionProfile(existing?.permissionProfile, 'dev-safe');
  const permissionProfile = resolvePermissionProfile(flags.get('permission-profile')?.trim(), defaultPermissionProfile);
  const canReuseExisting =
    !!existing &&
    normalizeGatewayUrl(existing.gatewayUrl) === gatewayUrl &&
    !!existing.deviceId &&
    (!oauth.userID || !existing.ownerUID || existing.ownerUID === oauth.userID);

  const reusingExistingDevice = !requestedDeviceID && canReuseExisting;
  const deviceId = requestedDeviceID || (reusingExistingDevice ? existing.deviceId : generatedDeviceID());
  const deviceName = requestedDeviceName || (reusingExistingDevice ? existing?.deviceName || '' : '');
  const identity = reusingExistingDevice ? existing.identity : generateIdentity();

  const expiresAt = new Date(Date.now() + oauth.expiresIn * 1000).toISOString();

  const config: AgentConfig = {
    version: 1,
    gatewayUrl,
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    deviceToken: oauth.accessToken,
    provider,
    model,
    ...(ollamaBaseUrl ? { ollamaBaseUrl } : {}),
    permissionProfile,
    identity,
    ...(mcpServers ? { mcpServers } : {}),
    ...(oauth.refreshToken ? { refreshToken: oauth.refreshToken } : {}),
    tokenExpiresAt: expiresAt,
    ...(oauth.scope ? { tokenScope: oauth.scope } : {}),
    ...(oauth.userID ? { ownerUID: oauth.userID } : {}),
    ...(oauth.email ? { ownerEmail: oauth.email } : {}),
  };

  await saveConfig(config);
  console.log(`Saved config: ${CONFIG_PATH}`);
  if (reusingExistingDevice) {
    console.log(`[auth] reusing existing device id: ${deviceId}`);
  } else {
    console.log(`[auth] generated device id: ${deviceId}`);
  }

  if (mcpServers) {
    console.log(`Configured MCP servers: ${describeMcpServers(mcpServers)}`);
  }

  const reg = await registerIdentityKey(
    config.gatewayUrl,
    config.deviceId,
    config.deviceToken,
    config.identity.publicKeyRawBase64,
    config.deviceName
  );

  if (!reg.ok) {
    throw new Error(`Failed to register identity key: ${reg.error}`);
  }

  console.log(`[auth] login complete${oauth.email ? ` for ${oauth.email}` : ''}`);
  console.log(`Registered identity key for device ${config.deviceId}`);
  console.log(`Identity fingerprint: ${shortFingerprint(config.identity.publicKeyRawBase64)}`);
  console.log(`Permission profile: ${config.permissionProfile}`);
  console.log(`Token expires at: ${expiresAt}`);
}

async function cmdInit(flags: Map<string, string>): Promise<void> {
  const gatewayUrl = normalizeGatewayUrl(optional(flags, 'gateway-url', 'https://api.commands.com'));
  const deviceId = required(flags, 'device-id');
  const deviceToken = required(flags, 'device-token');
  const existing = await loadConfig();
  const provider = resolveProvider(flags.get('provider')?.trim(), existing?.provider ?? 'claude');
  const model = optional(flags, 'model', defaultModelForProvider(provider));
  const ollamaBaseUrl = provider === 'ollama'
    ? normalizeOllamaBaseUrl(flags.get('ollama-base-url')?.trim() || existing?.ollamaBaseUrl)
    : undefined;
  const permissionProfile = resolvePermissionProfile(flags.get('permission-profile')?.trim(), 'dev-safe');

  const mcpServers = await resolveMcpServers(flags, undefined);
  const identity = generateIdentity();

  const config: AgentConfig = {
    version: 1,
    gatewayUrl,
    deviceId,
    deviceToken,
    provider,
    model,
    ...(ollamaBaseUrl ? { ollamaBaseUrl } : {}),
    permissionProfile,
    identity,
    ...(mcpServers ? { mcpServers } : {}),
  };

  await saveConfig(config);
  console.log(`Saved config: ${CONFIG_PATH}`);

  if (mcpServers) {
    console.log(`Configured MCP servers: ${describeMcpServers(mcpServers)}`);
  }

  const reg = await registerIdentityKey(
    config.gatewayUrl,
    config.deviceId,
    config.deviceToken,
    config.identity.publicKeyRawBase64,
    config.deviceName
  );

  if (!reg.ok) {
    throw new Error(`Failed to register identity key: ${reg.error}`);
  }

  console.log(`Registered identity key for device ${config.deviceId}`);
  console.log(`Identity fingerprint: ${shortFingerprint(config.identity.publicKeyRawBase64)}`);
  console.log(`Permission profile: ${config.permissionProfile}`);
}

async function cmdStatus(flags: Map<string, string>): Promise<void> {
  const config = await requireConfig();

  const health = await gatewayHealth(config.gatewayUrl);
  const gatewayHealthState = health.ok ? (health.data?.status ?? 'ok') : `DOWN (${health.error})`;

  if (hasFlag(flags, 'json')) {
    const provider = config.provider ?? 'claude';
    const payload = {
      configPath: CONFIG_PATH,
      gateway: config.gatewayUrl,
      deviceId: config.deviceId,
      provider,
      model: config.model,
      ollamaBaseUrl: provider === 'ollama' ? (config.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL) : null,
      permissionProfile: config.permissionProfile ?? 'dev-safe',
      mcpServers: config.mcpServers ? Object.keys(config.mcpServers) : [],
      identityFingerprint: shortFingerprint(config.identity.publicKeyRawBase64),
      tokenExpiresAt: config.tokenExpiresAt ?? null,
      ownerUID: config.ownerUID ?? null,
      ownerEmail: config.ownerEmail ?? null,
      gatewayHealth: gatewayHealthState,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Config file: ${CONFIG_PATH}`);
  console.log(`Gateway: ${config.gatewayUrl}`);
  console.log(`Device: ${config.deviceId}`);
  console.log(`Provider: ${config.provider ?? 'claude'}`);
  console.log(`Model: ${config.model}`);
  if ((config.provider ?? 'claude') === 'ollama') {
    console.log(`Ollama base URL: ${config.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL}`);
  }
  console.log(`Permission profile: ${config.permissionProfile ?? 'dev-safe'}`);
  console.log(`MCP servers: ${describeMcpServers(config.mcpServers)}`);
  console.log(`Identity fingerprint: ${shortFingerprint(config.identity.publicKeyRawBase64)}`);
  if (config.ownerEmail || config.ownerUID) {
    console.log(`Owner: ${config.ownerEmail ?? config.ownerUID}`);
  }
  if (config.tokenExpiresAt) {
    console.log(`Token expires at: ${config.tokenExpiresAt}`);
  }

  console.log(`Gateway health: ${gatewayHealthState}`);
}

async function cmdRun(flags: Map<string, string>, positionals: string[]): Promise<void> {
  const config = await requireConfig();
  const provider = resolveProvider(flags.get('provider')?.trim(), config.provider ?? 'claude');
  const model = flags.get('model')?.trim() ||
    (provider === (config.provider ?? 'claude') ? config.model : defaultModelForProvider(provider));
  const cwd = optional(flags, 'cwd', process.cwd());
  const permissionProfile = resolvePermissionProfile(flags.get('permission-profile')?.trim(), config.permissionProfile ?? 'dev-safe');
  const ollamaBaseUrl = provider === 'ollama'
    ? normalizeOllamaBaseUrl(flags.get('ollama-base-url')?.trim() || config.ollamaBaseUrl)
    : undefined;
  const promptFromFlag = flags.get('prompt')?.trim() ?? '';
  const promptFromPositional = positionals.join(' ').trim();
  const prompt = promptFromFlag || promptFromPositional;

  if (!prompt) {
    throw new Error('Provide a prompt with --prompt "..."');
  }

  const mcpServers = await resolveMcpServers(flags, config.mcpServers);
  console.log(`Running prompt in ${cwd}`);
  if (flags.get('mcp-config')) {
    console.log(`Using MCP config: ${flags.get('mcp-config')}`);
  }
  if (mcpServers) {
    console.log(`MCP servers: ${describeMcpServers(mcpServers)}`);
  }
  console.log(`Provider: ${provider}`);
  console.log(`Model: ${model}`);
  console.log(`Permission profile: ${permissionProfile}`);

  const result = provider === 'ollama'
    ? await runOllamaPrompt({
        prompt,
        model,
        systemPrompt: config.systemPrompt,
        ollamaBaseUrl,
      })
    : await runPrompt({
        prompt,
        cwd,
        model,
        mcpServers,
        policy: createRuntimePolicy(permissionProfile, cwd),
      });

  console.log('\n=== Final Result ===');
  console.log(result.result || '(empty result)');
  console.log('====================');
  console.log(`Turns: ${result.turns}`);
  console.log(`Cost (USD): ${result.costUsd}`);
  if (result.model) {
    console.log(`Model: ${result.model}`);
  }
}

async function cmdAckHandshake(flags: Map<string, string>): Promise<void> {
  const config = await requireConfig();

  const sessionId = required(flags, 'session-id');
  const handshakeId = required(flags, 'handshake-id');
  const clientEphemeralPublicKey = required(flags, 'client-ephemeral-public-key');
  const clientSessionNonce = required(flags, 'client-session-nonce');

  const ack = await acknowledgeHandshake(config, {
    sessionId,
    handshakeId,
    clientEphemeralPublicKey,
    clientSessionNonce,
  });

  console.log(`Handshake acknowledged: ${ack.status}`);
  console.log(`Session: ${ack.sessionId}`);
  console.log(`Handshake: ${ack.handshakeId}`);
  console.log(`Agent ephemeral fingerprint: ${ack.agentEphemeralFingerprint}`);
  console.log(`Derived key fingerprint (control): ${ack.controlKeyFingerprint}`);
}

async function cmdStart(flags: Map<string, string>): Promise<void> {
  const config = await requireConfig();
  const selectedProvider = resolveProvider(flags.get('provider')?.trim(), config.provider ?? 'claude');

  const defaultCwd = optional(flags, 'default-cwd', process.cwd());
  const heartbeatMs = parseIntStrict(optional(flags, 'heartbeat-ms', '15000'), 'heartbeat-ms');
  const reconnectMinMs = parseIntStrict(optional(flags, 'reconnect-min-ms', '1000'), 'reconnect-min-ms');
  const reconnectMaxMs = parseIntStrict(optional(flags, 'reconnect-max-ms', '30000'), 'reconnect-max-ms');
  const auditLogPath = optional(flags, 'audit-log-path', path.join(CONFIG_DIR, 'audit.log'));
  const modelOverride = flags.get('model')?.trim();
  const selectedModel = modelOverride && modelOverride.length > 0
    ? modelOverride
    : config.model || defaultModelForProvider(selectedProvider);
  const selectedOllamaBaseUrl = selectedProvider === 'ollama'
    ? normalizeOllamaBaseUrl(flags.get('ollama-base-url')?.trim() || config.ollamaBaseUrl)
    : undefined;
  const permissionProfile = resolvePermissionProfile(
    flags.get('permission-profile')?.trim(),
    config.permissionProfile ?? 'dev-safe'
  );
  const systemPrompt = flags.get('system-prompt')?.trim() || '';
  const runtimePolicy = createRuntimePolicy(permissionProfile, defaultCwd);

  if (reconnectMinMs > reconnectMaxMs) {
    throw new Error('reconnect-min-ms cannot be greater than reconnect-max-ms');
  }

  const deviceNameOverride = flags.get('device-name')?.trim();

  const mcpServers = await resolveMcpServers(flags, config.mcpServers);
  const effectiveConfig: AgentConfig = {
    ...config,
    provider: selectedProvider,
    model: selectedModel,
    ...(selectedOllamaBaseUrl ? { ollamaBaseUrl: selectedOllamaBaseUrl } : {}),
    permissionProfile,
    policy: runtimePolicy,
    ...(mcpServers ? { mcpServers } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(deviceNameOverride ? { deviceName: deviceNameOverride } : {}),
  };
  const savePersistentConfig = async (): Promise<void> => {
    const { policy: _policy, ...persistable } = effectiveConfig;
    await saveConfig(persistable);
  };

  if (
    effectiveConfig.provider !== (config.provider ?? 'claude') ||
    effectiveConfig.model !== config.model ||
    effectiveConfig.permissionProfile !== config.permissionProfile ||
    (effectiveConfig.ollamaBaseUrl ?? '') !== (config.ollamaBaseUrl ?? '')
  ) {
    if (effectiveConfig.provider !== (config.provider ?? 'claude')) {
      console.log(`[runtime] provider override: ${effectiveConfig.provider} (was ${config.provider ?? 'claude'})`);
    }
    if (effectiveConfig.model !== config.model) {
      console.log(`[runtime] model override: ${effectiveConfig.model} (was ${config.model})`);
    }
    if ((effectiveConfig.ollamaBaseUrl ?? '') !== (config.ollamaBaseUrl ?? '')) {
      console.log(`[runtime] ollama base url: ${effectiveConfig.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL}`);
    }
    if (effectiveConfig.permissionProfile !== config.permissionProfile) {
      console.log(
        `[runtime] permission profile: ${effectiveConfig.permissionProfile} (was ${config.permissionProfile ?? 'dev-safe'})`
      );
    }
    await savePersistentConfig();
    console.log('[runtime] saved updated runtime config to local config');
  }

  const preflight = await registerIdentityKey(
    effectiveConfig.gatewayUrl,
    effectiveConfig.deviceId,
    effectiveConfig.deviceToken,
    effectiveConfig.identity.publicKeyRawBase64,
    effectiveConfig.deviceName
  );

  if (!preflight.ok) {
    if (preflight.error && isInvalidJWTError(preflight.error)) {
      if (!effectiveConfig.refreshToken) {
        throw new Error('device token is invalid and no refresh token is available; run `INIT_AGENT=1 ./start-agent.sh` to re-authenticate');
      }

      console.log('[auth] access token rejected by gateway; attempting refresh token exchange');
      try {
        const refreshed = await refreshGatewayOAuthToken({
          gatewayUrl: effectiveConfig.gatewayUrl,
          refreshToken: effectiveConfig.refreshToken,
          clientId: 'commands-agent',
        });

        effectiveConfig.deviceToken = refreshed.accessToken;
        effectiveConfig.tokenExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
        if (refreshed.refreshToken) {
          effectiveConfig.refreshToken = refreshed.refreshToken;
        }
        if (refreshed.scope) {
          effectiveConfig.tokenScope = refreshed.scope;
        }
        if (refreshed.userID) {
          effectiveConfig.ownerUID = refreshed.userID;
        }
        if (refreshed.email) {
          effectiveConfig.ownerEmail = refreshed.email;
        }

        await savePersistentConfig();
        console.log('[auth] refreshed access token and updated local config');
      } catch (refreshErr) {
        const refreshMsg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        if (!isRefreshTokenMissingError(refreshMsg)) {
          throw refreshErr;
        }

        const headless = hasFlag(flags, 'headless');
        const openBrowser = !headless && !hasFlag(flags, 'no-open-browser');
        const oauthScope = effectiveConfig.tokenScope?.trim() || 'read_assets write_assets offline_access device';

        console.log('[auth] refresh token missing/expired; starting OAuth login to recover session');
        const oauth = await runGatewayOAuthLogin({
          gatewayUrl: effectiveConfig.gatewayUrl,
          clientId: 'commands-agent',
          scope: oauthScope,
          timeoutMs: 300000,
          headless,
          openBrowser,
        });

        effectiveConfig.deviceToken = oauth.accessToken;
        effectiveConfig.tokenExpiresAt = new Date(Date.now() + oauth.expiresIn * 1000).toISOString();
        if (oauth.refreshToken) {
          effectiveConfig.refreshToken = oauth.refreshToken;
        }
        if (oauth.scope) {
          effectiveConfig.tokenScope = oauth.scope;
        }
        if (oauth.userID) {
          effectiveConfig.ownerUID = oauth.userID;
        }
        if (oauth.email) {
          effectiveConfig.ownerEmail = oauth.email;
        }

        await savePersistentConfig();
        console.log('[auth] re-authenticated and updated local config');
      }

      const retry = await registerIdentityKey(
        effectiveConfig.gatewayUrl,
        effectiveConfig.deviceId,
        effectiveConfig.deviceToken,
        effectiveConfig.identity.publicKeyRawBase64,
        effectiveConfig.deviceName
      );
      if (!retry.ok) {
        throw new Error(`identity registration failed after auth recovery: ${retry.error}`);
      }
    } else {
      throw new Error(`identity registration failed: ${preflight.error}`);
    }
  }

  const controller = new AbortController();

  const stop = (): void => {
    console.log('\n[runtime] shutdown requested');
    controller.abort();
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log('[runtime] starting commands-agent websocket runtime');
  console.log(`[runtime] gateway=${effectiveConfig.gatewayUrl} device=${effectiveConfig.deviceId}`);
  console.log(`[runtime] provider=${effectiveConfig.provider ?? 'claude'}`);
  console.log(`[runtime] model=${effectiveConfig.model}`);
  if ((effectiveConfig.provider ?? 'claude') === 'ollama') {
    console.log(`[runtime] ollama-base-url=${effectiveConfig.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL}`);
  }
  console.log(`[runtime] permission-profile=${effectiveConfig.permissionProfile ?? 'dev-safe'}`);
  console.log(`[runtime] default-cwd=${defaultCwd}`);
  console.log(`[runtime] audit-log=${auditLogPath}`);
  console.log(`[runtime] mcp-servers=${describeMcpServers(effectiveConfig.mcpServers)}`);
  if (effectiveConfig.systemPrompt) {
    console.log(`[runtime] system-prompt=${effectiveConfig.systemPrompt.length} chars`);
  }
  if (flags.get('mcp-config')) {
    console.log(`[runtime] using mcp config: ${flags.get('mcp-config')}`);
  }

  try {
    await startRuntime(
      effectiveConfig,
      {
        defaultCwd,
        heartbeatMs,
        reconnectMinMs,
        reconnectMaxMs,
        auditLogPath,
      },
      controller.signal
    );
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }

  console.log('[runtime] stopped');
}

async function main(): Promise<void> {
  const { command, flags, positionals } = parseArgs(process.argv);

  switch (command) {
    case 'login':
      await cmdLogin(flags);
      return;
    case 'init':
      await cmdInit(flags);
      return;
    case 'status':
      await cmdStatus(flags);
      return;
    case 'run':
      await cmdRun(flags, positionals);
      return;
    case 'ack-handshake':
      await cmdAckHandshake(flags);
      return;
    case 'start':
      await cmdStart(flags);
      return;
    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exitCode = 1;
});
