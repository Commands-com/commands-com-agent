#!/usr/bin/env node

import crypto from 'node:crypto';
import process from 'node:process';
import { CONFIG_PATH, normalizeGatewayUrl, requireConfig, saveConfig } from './config.js';
import { generateIdentity, shortFingerprint } from './crypto.js';
import { runPrompt } from './claude.js';
import { gatewayHealth, registerIdentityKey } from './gateway.js';
import { acknowledgeHandshake } from './handshake.js';
import { startRuntime } from './runtime.js';
import { describeMcpServers, loadMcpServersFromFile } from './mcp.js';
import { runGatewayOAuthLogin } from './oauth.js';
import type { AgentConfig, AgentMcpServers } from './types.js';

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

function generatedDeviceID(userID?: string): string {
  const userPart = (userID ?? 'user').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'user';
  const suffix = crypto.randomBytes(4).toString('hex');
  return `dev-${userPart}-${suffix}`;
}

function printHelp(): void {
  console.log(`commands-com-agent

Commands:
  login           Browser OAuth (Firebase) device registration
  init            Manual initialization with device token (headless fallback)
  status          Show local config status and gateway health
  run             Execute a local Claude prompt via Claude Agent SDK
  ack-handshake   Create/sign/post handshake ack to gateway
  start           Start always-on websocket runtime with reconnect

Examples:
  commands-agent login --gateway-url https://commands.com
  commands-agent login --gateway-url https://commands.com --headless
  commands-agent init --gateway-url https://commands.com --device-id dev_123 --device-token <token>
  commands-agent run --prompt "Summarize this repository" --cwd /Users/me/Code/app
  commands-agent start --default-cwd /Users/me/Code --heartbeat-ms 15000
`);
}

async function cmdLogin(flags: Map<string, string>): Promise<void> {
  const gatewayUrl = normalizeGatewayUrl(optional(flags, 'gateway-url', 'https://commands.com'));
  const model = optional(flags, 'model', 'claude-sonnet-4-5-20250929');
  const scope = optional(flags, 'scope', 'read_assets write_assets offline_access');
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

  const deviceId = optional(flags, 'device-id', generatedDeviceID(oauth.userID));
  const identity = generateIdentity();

  const expiresAt = new Date(Date.now() + oauth.expiresIn * 1000).toISOString();

  const config: AgentConfig = {
    version: 1,
    gatewayUrl,
    deviceId,
    deviceToken: oauth.accessToken,
    model,
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

  if (mcpServers) {
    console.log(`Configured MCP servers: ${describeMcpServers(mcpServers)}`);
  }

  const reg = await registerIdentityKey(
    config.gatewayUrl,
    config.deviceId,
    config.deviceToken,
    config.identity.publicKeyRawBase64
  );

  if (!reg.ok) {
    throw new Error(`Failed to register identity key: ${reg.error}`);
  }

  console.log(`[auth] login complete${oauth.email ? ` for ${oauth.email}` : ''}`);
  console.log(`Registered identity key for device ${config.deviceId}`);
  console.log(`Identity fingerprint: ${shortFingerprint(config.identity.publicKeyRawBase64)}`);
  console.log(`Token expires at: ${expiresAt}`);
}

async function cmdInit(flags: Map<string, string>): Promise<void> {
  const gatewayUrl = normalizeGatewayUrl(optional(flags, 'gateway-url', 'https://commands.com'));
  const deviceId = required(flags, 'device-id');
  const deviceToken = required(flags, 'device-token');
  const model = optional(flags, 'model', 'claude-sonnet-4-5-20250929');

  const mcpServers = await resolveMcpServers(flags, undefined);
  const identity = generateIdentity();

  const config: AgentConfig = {
    version: 1,
    gatewayUrl,
    deviceId,
    deviceToken,
    model,
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
    config.identity.publicKeyRawBase64
  );

  if (!reg.ok) {
    throw new Error(`Failed to register identity key: ${reg.error}`);
  }

  console.log(`Registered identity key for device ${config.deviceId}`);
  console.log(`Identity fingerprint: ${shortFingerprint(config.identity.publicKeyRawBase64)}`);
}

async function cmdStatus(flags: Map<string, string>): Promise<void> {
  const config = await requireConfig();

  const health = await gatewayHealth(config.gatewayUrl);
  const gatewayHealthState = health.ok ? (health.data?.status ?? 'ok') : `DOWN (${health.error})`;

  if (hasFlag(flags, 'json')) {
    const payload = {
      configPath: CONFIG_PATH,
      gateway: config.gatewayUrl,
      deviceId: config.deviceId,
      model: config.model,
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
  console.log(`Model: ${config.model}`);
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
  const cwd = optional(flags, 'cwd', process.cwd());
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

  const result = await runPrompt({
    prompt,
    cwd,
    model: config.model,
    mcpServers,
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

  const defaultCwd = optional(flags, 'default-cwd', process.cwd());
  const heartbeatMs = parseIntStrict(optional(flags, 'heartbeat-ms', '15000'), 'heartbeat-ms');
  const reconnectMinMs = parseIntStrict(optional(flags, 'reconnect-min-ms', '1000'), 'reconnect-min-ms');
  const reconnectMaxMs = parseIntStrict(optional(flags, 'reconnect-max-ms', '30000'), 'reconnect-max-ms');

  if (reconnectMinMs > reconnectMaxMs) {
    throw new Error('reconnect-min-ms cannot be greater than reconnect-max-ms');
  }

  const mcpServers = await resolveMcpServers(flags, config.mcpServers);
  const effectiveConfig: AgentConfig = {
    ...config,
    ...(mcpServers ? { mcpServers } : {}),
  };

  const controller = new AbortController();

  const stop = (): void => {
    console.log('\n[runtime] shutdown requested');
    controller.abort();
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log('[runtime] starting commands-agent websocket runtime');
  console.log(`[runtime] gateway=${effectiveConfig.gatewayUrl} device=${effectiveConfig.deviceId}`);
  console.log(`[runtime] default-cwd=${defaultCwd}`);
  console.log(`[runtime] mcp-servers=${describeMcpServers(effectiveConfig.mcpServers)}`);
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
