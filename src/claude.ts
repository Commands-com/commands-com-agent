import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  getCwdPolicyViolation,
  getPromptPolicyViolation,
  getToolPolicyViolation,
} from './policy.js';
import type { AgentMcpServers, AgentPolicy, ClaudeRunResult } from './types.js';

interface RunPromptInput {
  prompt: string;
  cwd: string;
  model: string;
  maxTurns?: number;
  resumeSessionId?: string;
  mcpServers?: AgentMcpServers;
  policy?: AgentPolicy;
  onPolicyDecision?: (event: {
    toolName: string;
    allowed: boolean;
    reason?: string;
    toolInput: Record<string, unknown>;
  }) => void;
}

type StreamMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type?: string; text?: string }> | string;
  };
  result?: string;
  total_cost_usd?: number;
  model?: string;
};

function normalizeModelForSdk(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return 'sonnet';
  }

  if (normalized === 'sonnet' || normalized === 'opus' || normalized === 'haiku' || normalized === 'inherit') {
    return normalized;
  }

  if (normalized.startsWith('claude-sonnet')) {
    return 'sonnet';
  }

  if (normalized.startsWith('claude-opus')) {
    return 'opus';
  }

  if (normalized.startsWith('claude-haiku')) {
    return 'haiku';
  }

  return model;
}

function modelFamily(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = model.toLowerCase();
  if (normalized.includes('opus')) {
    return 'opus';
  }
  if (normalized.includes('sonnet')) {
    return 'sonnet';
  }
  if (normalized.includes('haiku')) {
    return 'haiku';
  }
  return undefined;
}

function extractAssistantText(message: StreamMessage): string {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const chunks: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text);
    }
  }
  return chunks.join('');
}

export async function runPrompt(input: RunPromptInput): Promise<ClaudeRunResult> {
  const requestedModel = input.model;
  const sdkModel = normalizeModelForSdk(requestedModel);

  if (sdkModel !== requestedModel) {
    console.log(`[runtime] normalized model "${requestedModel}" -> "${sdkModel}" for SDK compatibility`);
  }

  const options: NonNullable<Parameters<typeof query>[0]['options']> = {
    cwd: input.cwd,
    model: sdkModel,
    maxTurns: input.maxTurns ?? 40,
  };

  if (input.resumeSessionId) {
    options.resume = input.resumeSessionId;
  }

  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    options.mcpServers = input.mcpServers;
  }

  if (input.policy) {
    const promptViolation = getPromptPolicyViolation(input.prompt, input.policy);
    if (promptViolation) {
      throw new Error(`policy_violation_${promptViolation}`);
    }

    const cwdViolation = getCwdPolicyViolation(input.cwd, input.policy);
    if (cwdViolation) {
      throw new Error(`policy_violation_${cwdViolation}`);
    }

    options.permissionMode = 'default';
    options.disallowedTools = [...input.policy.disallowedTools];
    options.additionalDirectories = [...input.policy.allowedCwdRoots];
    options.canUseTool = async (toolName, toolInput) => {
      const violation = getToolPolicyViolation(toolName, toolInput, input.policy as AgentPolicy);
      if (violation) {
        if (input.onPolicyDecision) {
          input.onPolicyDecision({
            toolName,
            allowed: false,
            reason: violation,
            toolInput,
          });
        }

        return {
          behavior: 'deny',
          message: `Blocked by local agent policy: ${violation}`,
          interrupt: true,
        };
      }

      if (input.onPolicyDecision) {
        input.onPolicyDecision({
          toolName,
          allowed: true,
          toolInput,
        });
      }

      return {
        behavior: 'allow',
        updatedInput: toolInput,
      };
    };
  } else {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
  }

  let turns = 0;
  let latestAssistant = '';
  let finalResult = '';
  let costUsd = 0;
  let detectedModel: string | undefined;
  let detectedSessionId: string | undefined;

  const userPrompt = input.prompt.trim();
  if (userPrompt) {
    console.log(`\n[user prompt]\n${userPrompt}\n`);
  }

  for await (const raw of query({ prompt: input.prompt, options })) {
    const message = raw as StreamMessage;

    if (typeof message.session_id === 'string' && message.session_id.trim().length > 0) {
      detectedSessionId = message.session_id;
    }

    if (message.type === 'assistant') {
      turns += 1;
      const text = extractAssistantText(message).trim();
      if (text) {
        latestAssistant = text;
        console.log(`\n[assistant turn ${turns}]\n${text}\n`);
      }
      continue;
    }

    if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string') {
      detectedModel = message.model;
      continue;
    }

    if (message.type === 'result') {
      if (typeof message.result === 'string' && message.result.trim().length > 0) {
        finalResult = message.result;
      }
      if (typeof message.total_cost_usd === 'number') {
        costUsd = message.total_cost_usd;
      }
      break;
    }
  }

  if (!finalResult) {
    finalResult = latestAssistant;
  }

  const requestedFamily = modelFamily(sdkModel);
  const actualFamily = modelFamily(detectedModel);
  if (requestedFamily && actualFamily && requestedFamily !== actualFamily) {
    console.log(`[runtime] warning: model mismatch requested=${sdkModel} actual=${detectedModel}`);
  }

  return {
    result: finalResult,
    turns,
    costUsd,
    model: detectedModel,
    sessionId: detectedSessionId,
  };
}
