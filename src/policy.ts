import os from 'node:os';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { CONFIG_DIR } from './config.js';
import type { AgentPolicy, PolicyPreset } from './types.js';

export const DEFAULT_POLICY_CONFIG_PATH = path.join(CONFIG_DIR, 'policy.json');

const FILE_PATH_TOOL_NAMES = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'NotebookWrite',
  'Grep',
  'Glob',
  'LS',
]);

const BASH_TOOL_NAME = 'Bash';
const DEFAULT_MAX_PROMPT_CHARS = 24_000;

const SAFE_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'NotebookWrite',
];

const DEFAULT_BASH_DENY_PATTERNS = [
  '(^|\\s)rm\\s+-rf\\s+/',
  '(^|\\s)(sudo\\s+)?shutdown\\b',
  '(^|\\s)(sudo\\s+)?reboot\\b',
  '(^|\\s)mkfs\\b',
  '(^|\\s)dd\\s+if=',
  ':\\(\\)\\s*\\{\\s*:\\|:\\s*&\\s*\\};:',
];

const READ_ONLY_MUTATING_TOOL_PATTERNS: RegExp[] = [
  /\bwrite\b/i,
  /\bedit\b/i,
  /\bmulti\s*edit\b/i,
  /\bnotebook\s*edit\b/i,
  /\bnotebook\s*write\b/i,
  /\bappend\b/i,
  /\binsert\b/i,
  /\breplace\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bunlink\b/i,
  /\brename\b/i,
  /\bmove\b/i,
  /\btouch\b/i,
  /\bmkdir\b/i,
  /\brmdir\b/i,
  /\bcreate\s*(file|dir|directory|folder)\b/i,
  /\bcopy\s*(file|dir|directory|folder)\b/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  const expanded = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : trimmed;
  return path.resolve(expanded);
}

function asStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim().length > 0)) {
    throw new Error(`Policy field "${fieldName}" must be a non-empty string[]`);
  }
  return value.map((v) => v.trim());
}

function hasPathPrefix(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function extractPathsFromInput(input: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const stack: unknown[] = [input];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (Array.isArray(current)) {
      for (const value of current) {
        stack.push(value);
      }
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      const lowerKey = key.toLowerCase();
      if (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        (lowerKey.includes('path') || lowerKey.includes('file') || lowerKey.includes('dir') || lowerKey === 'cwd')
      ) {
        out.add(value.trim());
      }

      if (Array.isArray(value) || isRecord(value)) {
        stack.push(value);
      }
    }
  }

  return [...out];
}

function getBashCommand(input: Record<string, unknown>): string {
  const keys = ['command', 'cmd', 'script', 'bash'];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

function normalizeToolNameForPattern(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMutatingToolName(toolName: string): boolean {
  const normalized = normalizeToolNameForPattern(toolName);
  if (!normalized) {
    return false;
  }

  return READ_ONLY_MUTATING_TOOL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizePolicy(policy: AgentPolicy): AgentPolicy {
  return {
    ...policy,
    allowedCwdRoots: policy.allowedCwdRoots.map(normalizePath),
    blockedPathRoots: policy.blockedPathRoots.map(normalizePath),
    disallowedTools: policy.disallowedTools.map((tool) => tool.trim()).filter((tool) => tool.length > 0),
    maxPromptChars: policy.maxPromptChars,
    bash: {
      denyPatterns: policy.bash.denyPatterns,
      ...(policy.bash.allowPatterns ? { allowPatterns: policy.bash.allowPatterns } : {}),
    },
  };
}

export function isValidPolicyPreset(value: string): value is PolicyPreset {
  return value === 'safe' || value === 'balanced' || value === 'power';
}

export function createDefaultPolicy(params?: {
  preset?: PolicyPreset;
  allowedRoot?: string;
}): AgentPolicy {
  const preset = params?.preset ?? 'balanced';
  const allowedRoot = normalizePath(params?.allowedRoot ?? process.cwd());

  const blockedDefaults = [
    path.join(os.homedir(), '.ssh'),
    path.join(os.homedir(), '.aws'),
    path.join(os.homedir(), '.gnupg'),
  ];

  return normalizePolicy({
    version: 1,
    preset,
    allowedCwdRoots: [allowedRoot],
    blockedPathRoots: blockedDefaults,
    disallowedTools: preset === 'safe' ? SAFE_DISALLOWED_TOOLS : [],
    maxPromptChars: DEFAULT_MAX_PROMPT_CHARS,
    bash: {
      denyPatterns: [...DEFAULT_BASH_DENY_PATTERNS],
    },
  });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadPolicyFromFile(filePath: string): Promise<AgentPolicy> {
  const resolvedPath = path.resolve(filePath);
  const raw = await readFile(resolvedPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in policy config ${resolvedPath}: ${msg}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid policy config ${resolvedPath}: root must be an object`);
  }

  if (parsed.version !== 1) {
    throw new Error(`Invalid policy config ${resolvedPath}: version must be 1`);
  }

  const presetRaw = parsed.preset;
  if (typeof presetRaw !== 'string' || !isValidPolicyPreset(presetRaw)) {
    throw new Error(`Invalid policy config ${resolvedPath}: preset must be safe|balanced|power`);
  }

  const allowedCwdRoots = asStringArray(parsed.allowedCwdRoots, 'allowedCwdRoots');
  const blockedPathRoots = Array.isArray(parsed.blockedPathRoots)
    ? asStringArray(parsed.blockedPathRoots, 'blockedPathRoots')
    : [];
  const disallowedTools = Array.isArray(parsed.disallowedTools)
    ? asStringArray(parsed.disallowedTools, 'disallowedTools')
    : [];

  const maxPromptChars = parsed.maxPromptChars;
  if (typeof maxPromptChars !== 'number' || !Number.isFinite(maxPromptChars) || maxPromptChars <= 0) {
    throw new Error(`Invalid policy config ${resolvedPath}: maxPromptChars must be a positive number`);
  }

  const bashRaw = parsed.bash;
  if (!isRecord(bashRaw)) {
    throw new Error(`Invalid policy config ${resolvedPath}: bash must be an object`);
  }

  const denyPatterns = asStringArray(bashRaw.denyPatterns, 'bash.denyPatterns');
  const allowPatterns = Array.isArray(bashRaw.allowPatterns)
    ? asStringArray(bashRaw.allowPatterns, 'bash.allowPatterns')
    : undefined;

  return normalizePolicy({
    version: 1,
    preset: presetRaw,
    allowedCwdRoots,
    blockedPathRoots,
    disallowedTools,
    maxPromptChars: Math.floor(maxPromptChars),
    bash: {
      denyPatterns,
      ...(allowPatterns ? { allowPatterns } : {}),
    },
  });
}

export function describePolicy(policy: AgentPolicy | undefined): string {
  if (!policy) {
    return 'none';
  }

  return `${policy.preset} (allowed_roots=${policy.allowedCwdRoots.length}, disallowed_tools=${policy.disallowedTools.length})`;
}

export function summarizePolicy(policy: AgentPolicy | undefined): Record<string, unknown> | null {
  if (!policy) {
    return null;
  }

  return {
    version: policy.version,
    preset: policy.preset,
    allowedCwdRoots: [...policy.allowedCwdRoots],
    blockedPathRoots: [...policy.blockedPathRoots],
    disallowedTools: [...policy.disallowedTools],
    maxPromptChars: policy.maxPromptChars,
    bash: {
      denyPatterns: [...policy.bash.denyPatterns],
      allowPatterns: policy.bash.allowPatterns ? [...policy.bash.allowPatterns] : undefined,
    },
  };
}

export function getPromptPolicyViolation(prompt: string, policy: AgentPolicy): string | null {
  if (prompt.length > policy.maxPromptChars) {
    return `prompt_too_large_limit_${policy.maxPromptChars}`;
  }
  return null;
}

export function getCwdPolicyViolation(cwd: string, policy: AgentPolicy): string | null {
  const resolvedCwd = normalizePath(cwd);

  const inAllowedRoot = policy.allowedCwdRoots.some((root) => hasPathPrefix(resolvedCwd, root));
  if (!inAllowedRoot) {
    return `cwd_not_in_allowed_roots_${resolvedCwd}`;
  }

  const inBlockedRoot = policy.blockedPathRoots.some((root) => hasPathPrefix(resolvedCwd, root));
  if (inBlockedRoot) {
    return `cwd_in_blocked_root_${resolvedCwd}`;
  }

  return null;
}

export function getToolPolicyViolation(
  toolName: string,
  input: Record<string, unknown>,
  policy: AgentPolicy
): string | null {
  const lowerToolName = toolName.trim().toLowerCase();
  const disallowed = policy.disallowedTools.some((tool) => tool.trim().toLowerCase() === lowerToolName);
  if (disallowed) {
    return `tool_disallowed_${toolName}`;
  }

  // "safe" preset is our read-only mode. Deny mutating tools even when they
  // come from MCP servers with names like "filesystem__write_file".
  if (policy.preset === 'safe' && isMutatingToolName(toolName)) {
    return `tool_disallowed_read_only_${toolName}`;
  }

  if (toolName === BASH_TOOL_NAME) {
    const command = getBashCommand(input);
    if (!command) {
      return null;
    }

    for (const pattern of policy.bash.denyPatterns) {
      const re = new RegExp(pattern, 'i');
      if (re.test(command)) {
        return `bash_command_blocked_${pattern}`;
      }
    }

    if (policy.bash.allowPatterns && policy.bash.allowPatterns.length > 0) {
      const anyAllowed = policy.bash.allowPatterns.some((pattern) => new RegExp(pattern, 'i').test(command));
      if (!anyAllowed) {
        return 'bash_command_not_in_allowlist';
      }
    }
  }

  if (FILE_PATH_TOOL_NAMES.has(toolName)) {
    const paths = extractPathsFromInput(input);
    for (const candidate of paths) {
      const resolved = normalizePath(candidate);

      const inAllowedRoot = policy.allowedCwdRoots.some((root) => hasPathPrefix(resolved, root));
      if (!inAllowedRoot) {
        return `path_not_in_allowed_roots_${resolved}`;
      }

      const inBlockedRoot = policy.blockedPathRoots.some((root) => hasPathPrefix(resolved, root));
      if (inBlockedRoot) {
        return `path_in_blocked_root_${resolved}`;
      }
    }
  }

  return null;
}
