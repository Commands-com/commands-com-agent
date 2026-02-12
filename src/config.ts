import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AgentConfig } from './types.js';

export const CONFIG_DIR = path.join(os.homedir(), '.commands-agent');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function normalizeGatewayUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await chmod(CONFIG_DIR, 0o700);
}

export async function loadConfig(): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

export async function requireConfig(): Promise<AgentConfig> {
  const config = await loadConfig();
  if (!config) {
    throw new Error(`Config not found. Run: commands-agent init (expected ${CONFIG_PATH})`);
  }
  return config;
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8' });
  await chmod(CONFIG_PATH, 0o600);
}
