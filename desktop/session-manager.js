/**
 * session-manager.js — E2E encrypted chat session lifecycle manager.
 *
 * State machine per session: idle → handshaking → ready → ending → ended | error
 * Max 20 concurrent sessions. One session per device.
 *
 * Security:
 *  - Strict sequence enforcement (reject replay/out-of-order)
 *  - Keys zeroed on session end
 *  - No plaintext/keys in log output
 */

const { BrowserWindow } = require('electron');
const crypto = require('./crypto.js');
const gateway = require('./gateway-client.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 20;
const HANDSHAKE_POLL_INTERVAL_MS = 500;
const HANDSHAKE_TIMEOUT_MS = 45_000;
const MAX_MESSAGE_LENGTH = 100_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, SessionState>} deviceId → session */
const sessions = new Map();
/** @type {Map<string, Promise<unknown>>} deviceId → serialized send chain */
const sendQueues = new Map();

/**
 * @typedef {Object} SessionState
 * @property {string} deviceId
 * @property {string} sessionId
 * @property {string} handshakeId
 * @property {'handshaking'|'ready'|'ending'|'ended'|'error'} status
 * @property {{ clientToAgent: Buffer, agentToClient: Buffer, control: Buffer }|null} keys
 * @property {number} nextOutgoingSeq
 * @property {number} nextIncomingSeq
 * @property {AbortController|null} handshakeAbortController
 * @property {AbortController|null} sseAbortController
 * @property {string|null} lastEventId
 * @property {string|null} error
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emitChatEvent(payload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('desktop:gateway-chat-event', payload);
  });
}

function cleanupSessionResources(session) {
  if (!session) return;

  if (session.sseAbortController) {
    session.sseAbortController.abort();
    session.sseAbortController = null;
  }

  if (session.handshakeAbortController) {
    session.handshakeAbortController.abort();
    session.handshakeAbortController = null;
  }

  if (session.keys) {
    crypto.zeroKey(session.keys.clientToAgent);
    crypto.zeroKey(session.keys.agentToClient);
    crypto.zeroKey(session.keys.control);
    session.keys = null;
  }
}

function isHttpStatus(err, status) {
  return Boolean(err && typeof err === 'object' && err.status === status);
}

function sleepWithAbort(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      reject(new Error('Handshake aborted'));
      return;
    }

    let timer = null;
    const onAbort = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Handshake aborted'));
    };

    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function runSerializedSend(deviceId, task) {
  const previous = sendQueues.get(deviceId) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  let tracked;
  tracked = run.finally(() => {
    if (sendQueues.get(deviceId) === tracked) {
      sendQueues.delete(deviceId);
    }
  });
  sendQueues.set(deviceId, tracked);
  return run;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an E2E encrypted session with a shared agent device.
 */
async function startSession(gatewayUrl, deviceId) {
  // Prevent duplicate sessions per device
  if (sessions.has(deviceId)) {
    const existing = sessions.get(deviceId);
    if (existing.status === 'handshaking' || existing.status === 'ready') {
      throw new Error(`Session already exists for device ${deviceId} (status: ${existing.status})`);
    }
    // Clean up stale session
    cleanupSessionResources(existing);
    sessions.delete(deviceId);
    sendQueues.delete(deviceId);
  }

  // Enforce max concurrent sessions
  const activeSessions = [...sessions.values()].filter(
    (s) => s.status === 'handshaking' || s.status === 'ready'
  );
  if (activeSessions.length >= MAX_SESSIONS) {
    throw new Error(`Max concurrent sessions (${MAX_SESSIONS}) reached`);
  }

  // Generate session identifiers and ephemeral keys
  const sessionId = crypto.generateSessionId();
  const handshakeId = crypto.generateHandshakeId();
  const ephemeral = crypto.generateEphemeralX25519();
  const clientNonce = crypto.generateSessionNonce();

  /** @type {SessionState} */
  const session = {
    deviceId,
    sessionId,
    handshakeId,
    status: 'handshaking',
    keys: null,
    nextOutgoingSeq: 1,
    nextIncomingSeq: 1,
    handshakeAbortController: null,
    sseAbortController: null,
    lastEventId: null,
    error: null,
  };
  sessions.set(deviceId, session);

  emitChatEvent({ type: 'session.handshaking', deviceId, sessionId });

  try {
    // Fetch agent's Ed25519 identity key for signature verification
    const identityKeyResult = await gateway.fetchIdentityKey(gatewayUrl, deviceId);
    const agentIdentityPubBase64 = identityKeyResult.public_key;
    if (!agentIdentityPubBase64) {
      throw new Error('Agent has no identity key registered');
    }

    // POST client-init handshake
    await gateway.initHandshake(
      gatewayUrl,
      sessionId,
      handshakeId,
      deviceId,
      ephemeral.publicKeyRawBase64,
      clientNonce
    );

    // Poll for agent acknowledgment
    const startTime = Date.now();
    let ackData = null;
    session.handshakeAbortController = new AbortController();

    while (Date.now() - startTime < HANDSHAKE_TIMEOUT_MS) {
      // Abort if session status changed (e.g., user disconnected)
      if (session.status !== 'handshaking') {
        throw new Error('Handshake aborted — session status changed');
      }

      let poll;
      try {
        poll = await gateway.pollHandshake(
          gatewayUrl,
          sessionId,
          handshakeId,
          session.handshakeAbortController.signal
        );
      } catch (err) {
        // If user disconnected while a poll request was in-flight, stop immediately.
        if (session.status !== 'handshaking') {
          throw new Error('Handshake aborted — session status changed');
        }

        // A single poll timeout/abort can be transient; keep polling until the
        // overall handshake timeout window is reached.
        const msg = err instanceof Error ? err.message : String(err);
        if (/timed out|abort/i.test(msg)) {
          await sleepWithAbort(HANDSHAKE_POLL_INTERVAL_MS, session.handshakeAbortController?.signal);
          continue;
        }
        throw err;
      }

      if (poll.status === 'agent_acknowledged') {
        ackData = poll;
        break;
      }

      await sleepWithAbort(HANDSHAKE_POLL_INTERVAL_MS, session.handshakeAbortController?.signal);
    }

    if (!ackData) {
      throw new Error('Handshake timed out — agent did not acknowledge');
    }

    // Verify session hasn't been cancelled during polling
    if (session.status !== 'handshaking') {
      throw new Error('Handshake aborted — session status changed');
    }

    // Derive session keys
    const agentEphPubBase64 = ackData.agent_ephemeral_public_key;
    const transcriptHash = crypto.buildTranscriptHash(
      sessionId,
      handshakeId,
      ephemeral.publicKeyRawBase64,
      clientNonce,
      agentEphPubBase64
    );

    // Verify agent's Ed25519 signature on the transcript hash.
    // This binds the ephemeral key to the agent's registered identity,
    // preventing relay MITM (the relay never holds the agent's Ed25519 private key).
    const agentSignature = ackData.agent_identity_signature;
    if (!agentSignature) {
      throw new Error('Agent handshake ack missing identity signature');
    }
    const signatureValid = crypto.verifyIdentitySignature(
      agentIdentityPubBase64,
      transcriptHash,
      agentSignature
    );
    if (!signatureValid) {
      throw new Error('Agent identity signature verification failed — possible MITM');
    }

    const sharedSecret = crypto.deriveSharedSecret(ephemeral.privateKey, agentEphPubBase64);
    // Drop ephemeral private key reference early — KeyObject can't be explicitly
    // zeroed (OpenSSL manages it), but releasing the reference enables earlier GC.
    ephemeral.privateKey = null;
    let keys;
    try {
      keys = crypto.deriveSessionKeys(sharedSecret, transcriptHash);
    } finally {
      crypto.zeroKey(sharedSecret);
    }

    session.keys = keys;
    session.status = 'ready';
    session.handshakeAbortController = null;

    // Start SSE subscription for session events
    const abortController = new AbortController();
    session.sseAbortController = abortController;

    gateway.subscribeSessionEvents(
      gatewayUrl,
      sessionId,
      (sseEvent) => handleSseEvent(deviceId, sseEvent),
      abortController.signal,
      null
    ).catch((err) => {
      const s = sessions.get(deviceId);
      if (!s || s.status !== 'ready') {
        return;
      }

      cleanupSessionResources(s);

      // Session-specific terminal failures:
      //  - 404: session no longer exists on gateway
      //  - Other terminal failures: reconnect loop exhausted / auth/network failure
      if (isHttpStatus(err, 404)) {
        s.status = 'error';
        s.error = 'Session expired';
        emitChatEvent({ type: 'session.error', deviceId, error: 'Session expired — will reconnect on next message' });
      } else {
        s.status = 'error';
        s.error = err instanceof Error ? err.message : String(err);
        emitChatEvent({ type: 'session.error', deviceId, error: 'Connection to agent was lost — reconnect to continue' });
      }
    });

    emitChatEvent({ type: 'session.ready', deviceId, sessionId });
    return { ok: true, sessionId, deviceId };
  } catch (err) {
    session.handshakeAbortController = null;
    const current = sessions.get(deviceId);
    if (current === session && session.status !== 'ending' && session.status !== 'ended') {
      cleanupSessionResources(session);
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      emitChatEvent({ type: 'session.error', deviceId, sessionId, error: session.error });
    }
    throw err;
  }
}

/**
 * Send a plaintext message to the agent (encrypted before sending).
 * Auto-reconnects once if the gateway session has expired (e.g. after sleep/wake).
 */
async function sendChatMessageUnlocked(gatewayUrl, deviceId, plaintext, _isRetry = false) {
  if (typeof plaintext !== 'string' || plaintext.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Invalid message: must be string <= ${MAX_MESSAGE_LENGTH} chars`);
  }

  const session = sessions.get(deviceId);
  if (!session) {
    if (_isRetry) {
      throw new Error(`No session for device ${deviceId}`);
    }
    emitChatEvent({ type: 'session.reconnecting', deviceId });
    await startSession(gatewayUrl, deviceId);
    return sendChatMessageUnlocked(gatewayUrl, deviceId, plaintext, true);
  }
  const isCurrentReadySession = () => sessions.get(deviceId) === session && session.status === 'ready';
  // If session is in error state (e.g. expired after sleep), auto-reconnect
  if (session.status === 'error' && !_isRetry) {
    endSession(deviceId);
    emitChatEvent({ type: 'session.reconnecting', deviceId });
    await startSession(gatewayUrl, deviceId);
    return sendChatMessageUnlocked(gatewayUrl, deviceId, plaintext, true);
  }
  if (session.status !== 'ready') {
    throw new Error(`Session not ready (status: ${session.status})`);
  }

  const messageId = crypto.generateSessionId(); // UUID for message
  const seq = session.nextOutgoingSeq;

  // Plaintext must be JSON — agent expects { session_id, message_id, prompt }
  const plaintextJson = JSON.stringify({
    session_id: session.sessionId,
    message_id: messageId,
    prompt: plaintext,
  });

  // Encrypt with client-to-agent key
  const frame = crypto.encryptFrame(
    session.keys.clientToAgent,
    'client_to_agent',
    seq,
    plaintextJson,
    session.sessionId,
    messageId
  );

  try {
    // POST encrypted frame to gateway (match web frontend format)
    await gateway.sendMessage(gatewayUrl, session.sessionId, {
      type: 'session.message',
      session_id: session.sessionId,
      message_id: messageId,
      handshake_id: session.handshakeId,
      encrypted: true,
      ...frame,
    });
  } catch (err) {
    // Session changed while send was in-flight (disconnect/reconnect/expiry).
    // Do not emit stale events or auto-reconnect from an obsolete session object.
    if (!isCurrentReadySession()) {
      throw new Error('Send aborted — session ended');
    }
    // Gateway returned 404 — session expired (e.g. after sleep/wake).
    // Tear down stale session, reconnect, and retry the message once.
    if (!_isRetry && isHttpStatus(err, 404)) {
      endSession(deviceId);
      emitChatEvent({ type: 'session.reconnecting', deviceId });
      await startSession(gatewayUrl, deviceId);
      return sendChatMessageUnlocked(gatewayUrl, deviceId, plaintext, true);
    }
    throw err;
  }

  // Session can change while awaiting gateway ACK (manual disconnect, SSE error, sign-out).
  // Avoid emitting message.sent for a session that is no longer active.
  if (!isCurrentReadySession()) {
    throw new Error('Send aborted — session ended');
  }

  session.nextOutgoingSeq++;

  const ts = new Date().toISOString();
  emitChatEvent({ type: 'message.sent', deviceId, messageId, text: plaintext, ts });

  return { ok: true, messageId };
}

async function sendChatMessage(gatewayUrl, deviceId, plaintext) {
  return runSerializedSend(deviceId, () => sendChatMessageUnlocked(gatewayUrl, deviceId, plaintext));
}

/**
 * Handle an incoming SSE event for a session.
 */
function handleSseEvent(deviceId, sseEvent) {
  const session = sessions.get(deviceId);
  if (!session || (session.status !== 'ready' && session.status !== 'handshaking')) {
    return;
  }

  // Track last event ID for SSE resume
  if (sseEvent.id) {
    session.lastEventId = sseEvent.id;
  }

  let parsed;
  try {
    parsed = JSON.parse(sseEvent.data);
  } catch {
    return; // skip malformed events
  }

  // Handle different event types
  const eventType = sseEvent.event || parsed.type || parsed.event;

  if (parsed.encrypted && parsed.ciphertext) {
    // Encrypted frame from agent — could be progress, result, or error
    if (!session.keys) return;

    const frame = parsed;
    const expectedSeq = session.nextIncomingSeq;

    if (frame.direction !== 'agent_to_client') {
      const reason = `Unexpected direction: ${frame.direction}`;
      endSession(deviceId, reason);
      emitChatEvent({ type: 'session.error', deviceId, error: reason });
      return;
    }

    // Strict sequence validation — reject replay and out-of-order.
    // A mismatch means the stream is permanently desynchronized, so transition
    // to error state so the user gets the reconnect banner.
    if (typeof frame.seq !== 'number' || frame.seq !== expectedSeq) {
      const reason = `Unexpected seq: expected ${expectedSeq}, got ${frame.seq}`;
      endSession(deviceId, reason);
      emitChatEvent({ type: 'session.error', deviceId, error: reason });
      return;
    }

    let decrypted;
    try {
      const plaintext = crypto.decryptFrame(session.keys.agentToClient, frame);
      session.nextIncomingSeq++;
      decrypted = JSON.parse(plaintext);
    } catch (err) {
      // Decryption or payload parse failure — stream is unrecoverable.
      const reason = `Decryption failed: ${err.message}`;
      endSession(deviceId, reason);
      emitChatEvent({ type: 'session.error', deviceId, error: reason });
      return;
    }

    // Route based on the decrypted payload content and SSE event type
    if (decrypted.status === 'running' || eventType === 'session.progress') {
      // Agent is processing — show thinking indicator
      emitChatEvent({ type: 'message.progress', deviceId, status: 'processing' });
    } else if (decrypted.error || eventType === 'session.error') {
      // Agent-side error
      emitChatEvent({
        type: 'message.error',
        deviceId,
        error: decrypted.error || 'Unknown agent error',
      });
    } else if (decrypted.result !== undefined || eventType === 'session.result') {
      // Agent response — extract the result text
      emitChatEvent({
        type: 'message.received',
        deviceId,
        messageId: decrypted.message_id || frame.message_id || null,
        text: decrypted.result || '',
        ts: new Date().toISOString(),
      });
    } else {
      // Unknown encrypted payload — show as message
      const text = decrypted.text || decrypted.prompt || decrypted.message || JSON.stringify(decrypted);
      emitChatEvent({
        type: 'message.received',
        deviceId,
        messageId: decrypted.message_id || frame.message_id || null,
        text,
        ts: new Date().toISOString(),
      });
    }
  } else if (eventType === 'session.ended') {
    endSession(deviceId, parsed.reason || eventType);
  } else if (eventType === 'session.error') {
    const reason = parsed.reason || 'Session error';
    endSession(deviceId, reason);
    // Keep renderer state reconnectable ("send to reconnect") for terminal
    // gateway session errors instead of showing a plain ended state.
    emitChatEvent({ type: 'session.error', deviceId, error: reason });
  } else if (eventType === 'processing' || eventType === 'session.processing') {
    emitChatEvent({ type: 'message.progress', deviceId, status: 'processing' });
  }
}

/**
 * End a session — abort SSE, zero keys.
 */
function endSession(deviceId, reason) {
  const session = sessions.get(deviceId);
  if (!session) return;

  session.status = 'ending';

  cleanupSessionResources(session);

  session.status = 'ended';
  sessions.delete(deviceId);
  sendQueues.delete(deviceId);

  emitChatEvent({ type: 'session.ended', deviceId, reason });
}

/**
 * End all active sessions (called on sign-out).
 */
function endAllSessions() {
  for (const deviceId of [...sessions.keys()]) {
    endSession(deviceId);
  }
  sendQueues.clear();
}

/**
 * Get session status for a device.
 */
function getSessionStatus(deviceId) {
  const session = sessions.get(deviceId);
  if (!session) return { status: 'idle' };
  return {
    status: session.status,
    sessionId: session.sessionId,
    error: session.error,
  };
}

module.exports = {
  startSession,
  sendChatMessage,
  endSession,
  endAllSessions,
  getSessionStatus,
};
