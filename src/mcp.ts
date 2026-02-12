import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AgentMcpServerConfig, AgentMcpServers } from './types.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((v) => typeof v === 'string');
}

function parseSingleServer(
  serverName: string,
  raw: unknown
): AgentMcpServerConfig {
  if (!isRecord(raw)) {
    throw new Error(`MCP server "${serverName}" must be an object`);
  }

  const typeRaw = raw.type;
  const type = typeof typeRaw === 'string' ? typeRaw.trim() : undefined;

  if (!type || type === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) {
      throw new Error(`MCP server "${serverName}" requires non-empty "command"`);
    }

    const argsRaw = raw.args;
    let args: string[] | undefined;
    if (argsRaw !== undefined) {
      if (!Array.isArray(argsRaw) || !argsRaw.every((v) => typeof v === 'string')) {
        throw new Error(`MCP server "${serverName}" has invalid "args"; expected string[]`);
      }
      args = [...argsRaw];
    }

    const envRaw = raw.env;
    let env: Record<string, string> | undefined;
    if (envRaw !== undefined) {
      if (!isStringRecord(envRaw)) {
        throw new Error(`MCP server "${serverName}" has invalid "env"; expected Record<string,string>`);
      }
      env = { ...envRaw };
    }

    return {
      type: 'stdio',
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    };
  }

  if (type === 'sse' || type === 'http') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url) {
      throw new Error(`MCP server "${serverName}" requires non-empty "url"`);
    }

    const headersRaw = raw.headers;
    let headers: Record<string, string> | undefined;
    if (headersRaw !== undefined) {
      if (!isStringRecord(headersRaw)) {
        throw new Error(`MCP server "${serverName}" has invalid "headers"; expected Record<string,string>`);
      }
      headers = { ...headersRaw };
    }

    if (type === 'sse') {
      return {
        type: 'sse',
        url,
        ...(headers ? { headers } : {}),
      };
    }

    return {
      type: 'http',
      url,
      ...(headers ? { headers } : {}),
    };
  }

  throw new Error(`MCP server "${serverName}" has unsupported type "${type}" (supported: stdio, sse, http)`);
}

export function parseMcpServers(raw: unknown): AgentMcpServers {
  const rootCandidate = isRecord(raw) && isRecord(raw.mcpServers)
    ? raw.mcpServers
    : raw;

  if (!isRecord(rootCandidate)) {
    throw new Error('MCP config must be an object or include an object "mcpServers" field');
  }

  const parsed: AgentMcpServers = {};
  for (const [serverName, serverConfig] of Object.entries(rootCandidate)) {
    const trimmedName = serverName.trim();
    if (!trimmedName) {
      throw new Error('MCP server name cannot be empty');
    }
    parsed[trimmedName] = parseSingleServer(trimmedName, serverConfig);
  }

  return parsed;
}

export async function loadMcpServersFromFile(filePath: string): Promise<AgentMcpServers> {
  const resolvedPath = path.resolve(filePath);
  const raw = await readFile(resolvedPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in MCP config ${resolvedPath}: ${msg}`);
  }

  try {
    return parseMcpServers(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid MCP config ${resolvedPath}: ${msg}`);
  }
}

export function describeMcpServers(mcpServers: AgentMcpServers | undefined): string {
  if (!mcpServers) {
    return 'none';
  }

  const names = Object.keys(mcpServers);
  if (names.length === 0) {
    return 'none';
  }

  return names.join(', ');
}
