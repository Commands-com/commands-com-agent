import crypto from 'node:crypto';
import type { ClaudeRunResult } from './types.js';

interface RunOllamaPromptInput {
  prompt: string;
  model: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  ollamaBaseUrl?: string;
}

type OllamaRole = 'system' | 'user' | 'assistant';

interface OllamaMessage {
  role: OllamaRole;
  content: string;
}

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const MAX_SESSION_CACHE = 200;
const MAX_SESSION_MESSAGES = 60;
const LOCAL_OLLAMA_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const sessionMessages = new Map<string, OllamaMessage[]>();

function normalizeOllamaBaseUrl(input: string | undefined): string {
  const raw = (input || DEFAULT_OLLAMA_BASE_URL).trim();
  if (!raw) {
    return DEFAULT_OLLAMA_BASE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid_ollama_base_url:${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid_ollama_protocol:${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('invalid_ollama_url_userinfo_not_allowed');
  }
  if (!LOCAL_OLLAMA_HOSTS.has(parsed.hostname)) {
    throw new Error(`invalid_ollama_host:${parsed.hostname}`);
  }

  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function createSessionId(): string {
  return `ollama_${crypto.randomUUID()}`;
}

function enforceSessionCacheBounds(): void {
  while (sessionMessages.size > MAX_SESSION_CACHE) {
    const oldestKey = sessionMessages.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessionMessages.delete(oldestKey);
  }
}

function enforceMessageBounds(messages: OllamaMessage[]): OllamaMessage[] {
  if (messages.length <= MAX_SESSION_MESSAGES) {
    return messages;
  }

  const systemMessage = messages[0]?.role === 'system' ? messages[0] : null;
  const withoutSystem = systemMessage ? messages.slice(1) : messages.slice();
  const tail = withoutSystem.slice(-Math.max(0, MAX_SESSION_MESSAGES - (systemMessage ? 1 : 0)));
  return systemMessage ? [systemMessage, ...tail] : tail;
}

export async function runOllamaPrompt(input: RunOllamaPromptInput): Promise<ClaudeRunResult> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error('missing_prompt');
  }

  const model = input.model?.trim();
  if (!model) {
    throw new Error('missing_model');
  }

  const baseUrl = normalizeOllamaBaseUrl(input.ollamaBaseUrl);
  const sessionId = input.resumeSessionId?.trim() || createSessionId();
  const history = sessionMessages.get(sessionId)?.slice() || [];

  if (history.length === 0 && input.systemPrompt && input.systemPrompt.trim().length > 0) {
    history.push({ role: 'system', content: input.systemPrompt.trim() });
  }
  history.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: history,
        stream: false,
      }),
      signal: controller.signal,
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // handled by status/body checks below
    }

    if (!response.ok) {
      const errorMessage =
        typeof (payload as { error?: unknown })?.error === 'string'
          ? (payload as { error: string }).error
          : `http_${response.status}`;
      throw new Error(`ollama_request_failed:${errorMessage}`);
    }

    const assistantText =
      typeof (payload as { message?: { content?: unknown } })?.message?.content === 'string'
        ? (payload as { message: { content: string } }).message.content
        : typeof (payload as { response?: unknown })?.response === 'string'
          ? (payload as { response: string }).response
          : '';

    if (!assistantText.trim()) {
      throw new Error('ollama_empty_response');
    }

    history.push({ role: 'assistant', content: assistantText });
    const boundedHistory = enforceMessageBounds(history);
    sessionMessages.set(sessionId, boundedHistory);
    enforceSessionCacheBounds();

    const detectedModel =
      typeof (payload as { model?: unknown })?.model === 'string'
        ? (payload as { model: string }).model
        : model;

    return {
      result: assistantText,
      turns: 1,
      costUsd: 0,
      model: detectedModel,
      sessionId,
    };
  } finally {
    clearTimeout(timeout);
  }
}
