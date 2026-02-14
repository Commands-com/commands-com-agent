import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket, { type RawData } from 'ws';
import type { AgentConfig, SessionKeys } from './types.js';
import {
  decryptFramePayload,
  encryptFramePayload,
  type FrameDirection,
} from './crypto.js';
import { appendAuditEvent } from './audit.js';
import { registerIdentityKey } from './gateway.js';
import { acknowledgeHandshake } from './handshake.js';
import { runPrompt } from './claude.js';

export interface RuntimeOptions {
  defaultCwd: string;
  heartbeatMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  auditLogPath: string;
}

interface RuntimeSession {
  sessionId: string;
  handshakeId: string;
  establishedAt: string;
  keys: SessionKeys;
  claudeSessionId?: string;
  nextIncomingSeq: number;
  nextOutgoingSeq: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function parsePositiveSeq(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw > 0) {
      return raw;
    }
    return null;
  }

  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeDirection(value: string | null, fallback: FrameDirection): FrameDirection {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === 'client_to_agent' || normalized === 'client-to-agent' || normalized === 'c2a') {
    return 'client_to_agent';
  }

  if (normalized === 'agent_to_client' || normalized === 'agent-to-client' || normalized === 'a2c') {
    return 'agent_to_client';
  }

  return fallback;
}

function buildAadBase64(
  sessionId: string,
  messageId: string,
  seq: number,
  direction: FrameDirection
): string {
  const raw = `${sessionId}|${messageId}|${seq}|${direction}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function rawDataToString(data: RawData): string {
  if (data instanceof Buffer) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString('utf8');
  }
  throw new Error('unsupported raw websocket payload');
}

function toWsUrl(gatewayUrl: string, deviceId: string): string {
  const url = new URL(gatewayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/gateway/v1/agent/connect';
  url.search = '';
  url.searchParams.set('device_id', deviceId);
  return url.toString();
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const maybeRecord = isRecord(payload) ? payload : null;
  const frameType = firstString(maybeRecord?.type, maybeRecord?.event) ?? 'unknown';

  ws.send(JSON.stringify(payload), (err) => {
    if (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[runtime] websocket send failed frame=${frameType} error=${msg}`);
    }
  });
}

/**
 * Emit a structured event line to stdout that the desktop app can intercept.
 * Format: __DESKTOP_EVENT__:{json}\n
 */
function emitDesktopEvent(event: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...data, ts: new Date().toISOString() });
  process.stdout.write(`__DESKTOP_EVENT__:${line}\n`);
}

class AgentRuntime {
  private readonly sessions = new Map<string, RuntimeSession>();
  private backoffMs: number;

  constructor(
    private readonly config: AgentConfig,
    private readonly options: RuntimeOptions,
    private readonly signal: AbortSignal
  ) {
    this.backoffMs = options.reconnectMinMs;
  }

  async run(): Promise<void> {
    while (!this.signal.aborted) {
      try {
        await this.connectOnce();
        this.backoffMs = this.options.reconnectMinMs;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[runtime] connection cycle failed: ${msg}`);
      }

      if (this.signal.aborted) {
        break;
      }

      const jitter = Math.floor(Math.random() * 500);
      const waitMs = this.backoffMs + jitter;
      console.log(`[runtime] reconnecting in ${waitMs}ms`);
      await sleep(waitMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.options.reconnectMaxMs);
    }
  }

  private async connectOnce(): Promise<void> {
    const identityReg = await registerIdentityKey(
      this.config.gatewayUrl,
      this.config.deviceId,
      this.config.deviceToken,
      this.config.identity.publicKeyRawBase64
    );

    if (!identityReg.ok) {
      throw new Error(`identity registration failed: ${identityReg.error}`);
    }

    const wsUrl = toWsUrl(this.config.gatewayUrl, this.config.deviceId);
    console.log(`[runtime] connecting ${wsUrl}`);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.config.deviceToken}`,
          'X-Device-Id': this.config.deviceId,
        },
      });

      let settled = false;
      let heartbeatTimer: NodeJS.Timeout | undefined;

      const finish = (err?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;

        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        this.signal.removeEventListener('abort', onAbort);

        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const onAbort = (): void => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'shutdown');
        }
        finish();
      };

      this.signal.addEventListener('abort', onAbort, { once: true });

      ws.on('open', () => {
        console.log('[runtime] connected');
        sendJson(ws, {
          type: 'agent.hello',
          device_id: this.config.deviceId,
          agent_version: '0.1.0',
          capabilities: {
            plaintext_prompt_execution: true,
            handshake_ack_http: true,
            encrypted_frames: true,
            encrypted_algorithms: ['aes-256-gcm'],
          },
        });

        heartbeatTimer = setInterval(() => {
          sendJson(ws, {
            type: 'heartbeat',
            device_id: this.config.deviceId,
            at: new Date().toISOString(),
          });
        }, this.options.heartbeatMs);
      });

      ws.on('message', (data: RawData) => {
        void this.handleIncoming(ws, data).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(ws, {
            type: 'agent.error',
            error: msg,
            at: new Date().toISOString(),
          });
        });
      });

      ws.on('close', (code: number, reasonBuf: Buffer) => {
        const reason = reasonBuf.toString('utf8');
        console.log(`[runtime] socket closed code=${code} reason=${reason || '(none)'}`);
        finish();
      });

      ws.on('error', (err: Error) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[runtime] socket error: ${msg}`);
        finish(new Error(msg));
      });
    });
  }

  private async handleIncoming(ws: WebSocket, raw: RawData): Promise<void> {
    const text = rawDataToString(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(ws, {
        type: 'agent.error',
        error: 'invalid_json',
        raw_preview: text.slice(0, 200),
      });
      return;
    }

    if (!isRecord(parsed)) {
      sendJson(ws, { type: 'agent.error', error: 'invalid_message_shape' });
      return;
    }

    const frameType = firstString(parsed.type, parsed.event);
    if (!frameType) {
      sendJson(ws, { type: 'agent.error', error: 'missing_type' });
      return;
    }

    if (frameType === 'heartbeat') {
      return;
    }

    if (frameType === 'ping') {
      sendJson(ws, {
        type: 'heartbeat',
        device_id: this.config.deviceId,
        at: new Date().toISOString(),
      });
      return;
    }

    if (frameType === 'session.handshake.request') {
      await this.handleHandshakeRequest(ws, parsed);
      return;
    }

    if (frameType === 'session.message') {
      await this.handleSessionMessage(ws, parsed);
      return;
    }

    if (frameType === 'session.cancel') {
      const sessionId = firstString(parsed.session_id, parsed.sessionId);
      if (sessionId) {
        this.sessions.delete(sessionId);
        emitDesktopEvent('session.ended', { sessionId });
      }
      sendJson(ws, {
        type: 'session.cancelled',
        session_id: sessionId,
      });
      return;
    }

    sendJson(ws, {
      type: 'agent.error',
      error: 'unsupported_type',
      received_type: frameType,
    });
  }

  private async handleHandshakeRequest(ws: WebSocket, frame: JsonRecord): Promise<void> {
    const sessionId = firstString(frame.session_id, frame.sessionId);
    const handshakeId = firstString(frame.handshake_id, frame.handshakeId);
    const clientEphemeralPublicKey = firstString(frame.client_ephemeral_public_key, frame.clientEphemeralPublicKey);
    const clientSessionNonce = firstString(frame.client_session_nonce, frame.clientSessionNonce);

    if (!sessionId || !handshakeId || !clientEphemeralPublicKey || !clientSessionNonce) {
      sendJson(ws, {
        type: 'session.handshake.ack',
        status: 'error',
        session_id: sessionId,
        handshake_id: handshakeId,
        error: 'missing_handshake_fields',
      });
      return;
    }

    try {
      // Re-register the long-lived identity key just before each handshake.
      // This makes handshake ACK robust if gateway in-memory state was reset.
      const identityReg = await registerIdentityKey(
        this.config.gatewayUrl,
        this.config.deviceId,
        this.config.deviceToken,
        this.config.identity.publicKeyRawBase64
      );
      if (!identityReg.ok) {
        throw new Error(`identity registration failed before handshake ack: ${identityReg.error}`);
      }

      const ack = await acknowledgeHandshake(this.config, {
        sessionId,
        handshakeId,
        clientEphemeralPublicKey,
        clientSessionNonce,
      }, {
        postToGateway: true,
        requireGatewayAck: false,
      });

      const establishedAt = new Date().toISOString();
      this.sessions.set(sessionId, {
        sessionId,
        handshakeId,
        establishedAt,
        keys: ack.sessionKeys,
        claudeSessionId: undefined,
        nextIncomingSeq: 1,
        nextOutgoingSeq: 1,
      });

      emitDesktopEvent('session.started', { sessionId, handshakeId, establishedAt });

      sendJson(ws, {
        type: 'session.handshake.ack',
        status: 'ok',
        session_id: ack.sessionId,
        handshake_id: ack.handshakeId,
        agent_ephemeral_public_key: ack.agentEphemeralPublicKey,
        agent_identity_signature: ack.agentIdentitySignature,
        transcript_hash: ack.transcriptHash,
        gateway_ack_posted: ack.gatewayAckPosted,
        ...(ack.gatewayAckError ? { gateway_ack_error: ack.gatewayAckError } : {}),
        agent_ephemeral_fingerprint: ack.agentEphemeralFingerprint,
        control_key_fingerprint: ack.controlKeyFingerprint,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[runtime] handshake failed session=${sessionId} handshake=${handshakeId} error=${msg}`);
      sendJson(ws, {
        type: 'session.handshake.ack',
        status: 'error',
        session_id: sessionId,
        handshake_id: handshakeId,
        error: msg,
      });
    }
  }

  private sendSessionError(
    ws: WebSocket,
    params: {
      sessionId: string;
      messageId: string;
      error: string;
      session?: RuntimeSession;
      encrypted?: boolean;
    }
  ): void {
    const { sessionId, messageId, error, session, encrypted } = params;

    if (session && encrypted) {
      const seq = session.nextOutgoingSeq;
      const direction: FrameDirection = 'agent_to_client';
      const aad = buildAadBase64(sessionId, messageId, seq, direction);

      const encryptedPayload = encryptFramePayload({
        keyBase64: session.keys.agentToClientBase64,
        direction,
        seq,
        plaintextUtf8: JSON.stringify({
          error,
          message_id: messageId,
          session_id: sessionId,
        }),
        aadBase64: aad,
      });

      session.nextOutgoingSeq += 1;

      sendJson(ws, {
        type: 'session.error',
        session_id: sessionId,
        message_id: messageId,
        encrypted: true,
        handshake_id: session.handshakeId,
        ...encryptedPayload,
      });
      return;
    }

    sendJson(ws, {
      type: 'session.error',
      session_id: sessionId,
      message_id: messageId,
      error,
    });
  }

  private async handleSessionMessage(ws: WebSocket, frame: JsonRecord): Promise<void> {
    const sessionId = firstString(frame.session_id, frame.sessionId);
    let messageId = firstString(frame.message_id, frame.messageId) ?? 'unknown';

    if (!sessionId) {
      this.sendSessionError(ws, {
        sessionId: 'unknown',
        messageId,
        error: 'missing_session_id',
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendSessionError(ws, {
        sessionId,
        messageId,
        error: 'handshake_not_established',
      });
      return;
    }

    const hasEncryptedFields =
      typeof frame.ciphertext === 'string' ||
      typeof frame.nonce === 'string' ||
      typeof frame.aad === 'string' ||
      typeof frame.tag === 'string';

    let encryptedRequest = false;
    let prompt: string | null;
    let cwd: string;
    const requesterUID = firstString(frame.requester_uid, frame.requesterUid, frame.user_id, frame.userId) ?? 'unknown';
    const receivedAt = firstString(frame.received_at, frame.receivedAt) ?? new Date().toISOString();

    if (hasEncryptedFields) {
      encryptedRequest = true;

      const seq = parsePositiveSeq(frame.seq);
      if (!seq) {
        this.sendSessionError(ws, {
          sessionId,
          messageId,
          error: 'invalid_or_missing_seq',
          session,
          encrypted: true,
        });
        return;
      }

      if (seq !== session.nextIncomingSeq) {
        this.sendSessionError(ws, {
          sessionId,
          messageId,
          error: `unexpected_seq_expected_${session.nextIncomingSeq}_got_${seq}`,
          session,
          encrypted: true,
        });
        return;
      }

      const direction = normalizeDirection(firstString(frame.direction), 'client_to_agent');
      if (direction !== 'client_to_agent') {
        this.sendSessionError(ws, {
          sessionId,
          messageId,
          error: `invalid_direction_${direction}`,
          session,
          encrypted: true,
        });
        return;
      }

      const ciphertext = firstString(frame.ciphertext);
      const nonce = firstString(frame.nonce);
      const tag = firstString(frame.tag, frame.auth_tag, frame.authTag);
      const aad = firstString(frame.aad) ?? undefined;

      if (!ciphertext || !nonce || !tag) {
        this.sendSessionError(ws, {
          sessionId,
          messageId,
          error: 'missing_encrypted_fields',
          session,
          encrypted: true,
        });
        return;
      }

      let decryptedText: string;
      try {
        decryptedText = decryptFramePayload({
          keyBase64: session.keys.clientToAgentBase64,
          direction: 'client_to_agent',
          seq,
          nonceBase64: nonce,
          ciphertextBase64: ciphertext,
          tagBase64: tag,
          ...(aad ? { aadBase64: aad } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendSessionError(ws, {
          sessionId,
          messageId,
          error: `decrypt_failed_${msg}`,
          session,
          encrypted: true,
        });
        return;
      }

      let decryptedPayload: unknown;
      try {
        decryptedPayload = JSON.parse(decryptedText);
      } catch {
        this.sendSessionError(ws, {
          sessionId,
          messageId,
          error: 'decrypted_payload_not_json',
          session,
          encrypted: true,
        });
        return;
      }

      if (!isRecord(decryptedPayload)) {
        this.sendSessionError(ws, {
          sessionId,
          messageId,
          error: 'decrypted_payload_invalid_shape',
          session,
          encrypted: true,
        });
        return;
      }

      const payloadMessageId = firstString(decryptedPayload.message_id, decryptedPayload.messageId);
      if (payloadMessageId) {
        messageId = payloadMessageId;
      }

      prompt = firstString(
        decryptedPayload.prompt,
        decryptedPayload.text,
        decryptedPayload.message
      );
      cwd = firstString(decryptedPayload.cwd) ?? this.options.defaultCwd;

      session.nextIncomingSeq += 1;
    } else {
      const payload = isRecord(frame.payload) ? frame.payload : null;

      prompt = firstString(
        frame.prompt,
        frame.text,
        frame.message,
        payload?.prompt,
        payload?.text,
        payload?.message
      );

      cwd = firstString(frame.cwd, payload?.cwd) ?? this.options.defaultCwd;
    }

    if (!prompt) {
      this.sendSessionError(ws, {
        sessionId,
        messageId,
        error: 'missing_prompt',
        session,
        encrypted: encryptedRequest,
      });
      return;
    }

    try {
      await appendAuditEvent(this.options.auditLogPath, {
        at: new Date().toISOString(),
        event: 'session.message.received',
        received_at: receivedAt,
        requester_uid: requesterUID,
        device_id: this.config.deviceId,
        session_id: sessionId,
        handshake_id: session.handshakeId,
        message_id: messageId,
        cwd,
        encrypted: encryptedRequest,
        prompt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[runtime] audit log write failed: ${msg}`);
    }

    emitDesktopEvent('session.message', {
      sessionId,
      messageId,
      requesterUid: requesterUID,
      prompt,
    });

    if (encryptedRequest) {
      const seq = session.nextOutgoingSeq;
      const direction: FrameDirection = 'agent_to_client';
      const aad = buildAadBase64(sessionId, messageId, seq, direction);

      const encryptedPayload = encryptFramePayload({
        keyBase64: session.keys.agentToClientBase64,
        direction,
        seq,
        plaintextUtf8: JSON.stringify({
          status: 'running',
          session_id: sessionId,
          message_id: messageId,
        }),
        aadBase64: aad,
      });

      session.nextOutgoingSeq += 1;

      sendJson(ws, {
        type: 'session.progress',
        session_id: sessionId,
        message_id: messageId,
        encrypted: true,
        handshake_id: session.handshakeId,
        ...encryptedPayload,
      });
    } else {
      sendJson(ws, {
        type: 'session.progress',
        session_id: sessionId,
        message_id: messageId,
        status: 'running',
      });
    }

    try {
      const result = await runPrompt({
        prompt,
        cwd,
        model: this.config.model,
        systemPrompt: this.config.systemPrompt,
        resumeSessionId: session.claudeSessionId,
        mcpServers: this.config.mcpServers,
        policy: this.config.policy,
      });
      if (result.sessionId) {
        session.claudeSessionId = result.sessionId;
      }

      emitDesktopEvent('session.result', {
        sessionId,
        messageId,
        result: typeof result.result === 'string' ? result.result : '',
        turns: result.turns,
        costUsd: result.costUsd,
        model: result.model,
      });

      if (encryptedRequest) {
        const seq = session.nextOutgoingSeq;
        const direction: FrameDirection = 'agent_to_client';
        const aad = buildAadBase64(sessionId, messageId, seq, direction);

        const encryptedPayload = encryptFramePayload({
          keyBase64: session.keys.agentToClientBase64,
          direction,
          seq,
          plaintextUtf8: JSON.stringify({
            result: result.result,
            turns: result.turns,
            cost_usd: result.costUsd,
            model: result.model,
            session_id: sessionId,
            message_id: messageId,
          }),
          aadBase64: aad,
        });

        session.nextOutgoingSeq += 1;

        sendJson(ws, {
          type: 'session.result',
          session_id: sessionId,
          message_id: messageId,
          encrypted: true,
          handshake_id: session.handshakeId,
          ...encryptedPayload,
        });
        return;
      }

      sendJson(ws, {
        type: 'session.result',
        session_id: sessionId,
        message_id: messageId,
        result: result.result,
        turns: result.turns,
        cost_usd: result.costUsd,
        model: result.model,
        handshake_id: session.handshakeId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitDesktopEvent('session.error', { sessionId, messageId, error: msg });
      this.sendSessionError(ws, {
        sessionId,
        messageId,
        error: msg,
        session,
        encrypted: encryptedRequest,
      });
    }
  }
}

export async function startRuntime(
  config: AgentConfig,
  options: RuntimeOptions,
  signal: AbortSignal
): Promise<void> {
  const normalizedOptions: RuntimeOptions = {
    defaultCwd: options.defaultCwd,
    heartbeatMs: options.heartbeatMs,
    reconnectMinMs: options.reconnectMinMs ?? 1000,
    reconnectMaxMs: options.reconnectMaxMs ?? 30000,
    auditLogPath: options.auditLogPath,
  };

  const runtime = new AgentRuntime(config, normalizedOptions, signal);
  await runtime.run();
}
