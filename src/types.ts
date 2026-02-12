import type {
  McpHttpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '@anthropic-ai/claude-agent-sdk';

export type AgentMcpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;
export type AgentMcpServers = Record<string, AgentMcpServerConfig>;

export type PolicyPreset = 'safe' | 'balanced' | 'power';

export interface AgentPolicy {
  version: 1;
  preset: PolicyPreset;
  allowedCwdRoots: string[];
  blockedPathRoots: string[];
  disallowedTools: string[];
  maxPromptChars: number;
  bash: {
    denyPatterns: string[];
    allowPatterns?: string[];
  };
}

export interface AgentIdentity {
  algorithm: 'ed25519';
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  publicKeyRawBase64: string;
}

export interface AgentConfig {
  version: 1;
  gatewayUrl: string;
  deviceId: string;
  deviceToken: string;
  model: string;
  identity: AgentIdentity;
  mcpServers?: AgentMcpServers;
  policyConfigPath?: string;
  auditLogPath?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  tokenScope?: string;
  ownerUID?: string;
  ownerEmail?: string;
  // Runtime-only resolved policy; not required to persist.
  policy?: AgentPolicy;
}

export interface ClaudeRunResult {
  result: string;
  turns: number;
  costUsd: number;
  model?: string;
  sessionId?: string;
}

export interface SessionKeys {
  clientToAgentBase64: string;
  agentToClientBase64: string;
  controlBase64: string;
}
