/**
 * gateway-client.js — HTTP/SSE client for the Commands.com gateway API.
 *
 * Runs in the main process. Uses Node.js fetch (Electron ships with it).
 * All requests attach Authorization: Bearer {idToken} from the auth module.
 *
 * Security:
 *  - Trusted host allowlist — tokens never sent to arbitrary URLs
 *  - HTTPS enforced for non-localhost origins
 *  - redirect: 'manual' on bearer-token requests
 *  - SSE reconnect with Last-Event-ID + bounded dedup (200 IDs)
 */

const auth = require('./auth.js');

// ---------------------------------------------------------------------------
// Trusted host allowlist
// ---------------------------------------------------------------------------

const TRUSTED_ORIGINS = new Set([
  'https://api.commands.com',
  'http://localhost:8091',
  'http://127.0.0.1:8091',
]);

function validateGatewayOrigin(gatewayUrl) {
  const parsed = new URL(gatewayUrl);
  const origin = parsed.origin;

  if (!TRUSTED_ORIGINS.has(origin)) {
    throw new Error(`Untrusted gateway origin: ${origin}`);
  }

  // Enforce HTTPS for non-localhost
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`HTTP not allowed for non-localhost gateway: ${origin}`);
  }
}

function buildHttpError(message, status, body = '') {
  const suffix = body ? ` ${body}` : '';
  const err = new Error(`${message}: ${status}${suffix}`);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the gateway.
 * Auto-retries once on 401 (token refresh).
 */
async function gatewayFetch(url, options = {}, retry = true) {
  validateGatewayOrigin(url);

  const token = await auth.getIdToken();

  const res = await fetch(url, {
    ...options,
    redirect: 'manual',
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  // On 401, try refreshing token and retry once
  if (res.status === 401 && retry) {
    await auth.getIdToken({ forceRefresh: true });
    return gatewayFetch(url, options, false);
  }

  return res;
}

async function gatewayJson(url, options = {}) {
  const res = await gatewayFetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw buildHttpError(`Gateway ${options.method || 'GET'} ${url} failed`, res.status, text);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// REST methods
// ---------------------------------------------------------------------------

/**
 * Fetch all devices the user has access to.
 * GET /gateway/v1/devices
 */
async function fetchDevices(gatewayUrl) {
  return gatewayJson(`${gatewayUrl}/gateway/v1/devices`);
}

/**
 * Fetch a device's identity key.
 * GET /gateway/v1/devices/{deviceId}/identity-key
 */
async function fetchIdentityKey(gatewayUrl, deviceId) {
  return gatewayJson(`${gatewayUrl}/gateway/v1/devices/${encodeURIComponent(deviceId)}/identity-key`);
}

/**
 * Initialize a handshake (client-init).
 * POST /gateway/v1/sessions/{sessionId}/handshake/client-init
 */
async function initHandshake(gatewayUrl, sessionId, handshakeId, deviceId, clientEphemeralPubKey, clientSessionNonce, conversationId = null) {
  const body = {
    handshake_id: handshakeId,
    device_id: deviceId,
    client_ephemeral_public_key: clientEphemeralPubKey,
    client_session_nonce: clientSessionNonce,
  };
  if (typeof conversationId === 'string' && conversationId.trim()) {
    body.conversation_id = conversationId.trim();
  }
  return gatewayJson(`${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/handshake/client-init`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Poll handshake status.
 * GET /gateway/v1/sessions/{sessionId}/handshake/{handshakeId}
 */
async function pollHandshake(gatewayUrl, sessionId, handshakeId, signal) {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort(new Error('Handshake poll request timed out'));
  }, POLL_HANDSHAKE_REQUEST_TIMEOUT_MS);

  const forwardAbort = () => timeoutController.abort(new Error('Handshake poll aborted'));
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutHandle);
      timeoutController.abort(new Error('Handshake poll aborted'));
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  try {
    return gatewayJson(
      `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/handshake/${encodeURIComponent(handshakeId)}`,
      { signal: timeoutController.signal }
    );
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) {
      signal.removeEventListener('abort', forwardAbort);
    }
  }
}

/**
 * Send an encrypted message.
 * POST /gateway/v1/sessions/{sessionId}/messages
 */
async function sendMessage(gatewayUrl, sessionId, encryptedFrame) {
  return gatewayJson(`${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(encryptedFrame),
  });
}

// ---------------------------------------------------------------------------
// SSE subscription with reconnect + dedup
// ---------------------------------------------------------------------------

const MAX_DEDUP_IDS = 200;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;
const MAX_SSE_EVENT_DATA_CHARS = 512 * 1024;
const POLL_HANDSHAKE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Parse an SSE stream from a fetch Response body.
 * Yields { event, data, id } objects.
 */
function parseSseFieldValue(line, prefixLength) {
  let value = line.slice(prefixLength);
  // Per SSE parsing, remove exactly one leading space after ':' if present.
  if (value.startsWith(' ')) {
    value = value.slice(1);
  }
  return value;
}

async function* parseSseStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';
  let hasDataField = false;
  let currentId = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      throw new Error('SSE frame exceeds parser buffer limit');
    }

    // Normalize line endings: CRLF → LF, standalone CR → LF.
    // A trailing \r is deferred — it might be the first half of a \r\n split
    // across chunks. We only consume it when the next character is known.
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r(?=.)/g, '\n');
    if (buffer.endsWith('\r')) {
      // Defer trailing \r until next chunk (or end of stream)
      continue;
    }

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = parseSseFieldValue(line, 6);
      } else if (line.startsWith('data:')) {
        hasDataField = true;
        const nextData = (currentData ? '\n' : '') + parseSseFieldValue(line, 5);
        if (currentData.length + nextData.length > MAX_SSE_EVENT_DATA_CHARS) {
          throw new Error('SSE event exceeds parser data limit');
        }
        currentData += nextData;
      } else if (line.startsWith('id:')) {
        currentId = parseSseFieldValue(line, 3);
      } else if (line === '') {
        // End of event
        if (hasDataField) {
          yield { event: currentEvent || 'message', data: currentData, id: currentId };
        }
        currentEvent = '';
        currentData = '';
        hasDataField = false;
        currentId = '';
      }
    }
  }

  // Flush decoder state so multi-byte UTF-8 sequences split at EOF are emitted.
  buffer += decoder.decode();

  // Flush deferred trailing \r (standalone CR = line ending per SSE spec)
  if (buffer.endsWith('\r')) {
    buffer = buffer.slice(0, -1) + '\n';
  }
  if (buffer) {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = parseSseFieldValue(line, 6);
      } else if (line.startsWith('data:')) {
        hasDataField = true;
        const nextData = (currentData ? '\n' : '') + parseSseFieldValue(line, 5);
        if (currentData.length + nextData.length > MAX_SSE_EVENT_DATA_CHARS) {
          throw new Error('SSE event exceeds parser data limit');
        }
        currentData += nextData;
      } else if (line.startsWith('id:')) {
        currentId = parseSseFieldValue(line, 3);
      } else if (line === '') {
        if (hasDataField) {
          yield { event: currentEvent || 'message', data: currentData, id: currentId };
        }
        currentEvent = '';
        currentData = '';
        hasDataField = false;
        currentId = '';
      }
    }
  }

  // EOF can terminate an event without a trailing blank line.
  if (hasDataField) {
    yield { event: currentEvent || 'message', data: currentData, id: currentId };
  }
}

/**
 * Create a bounded dedup set (FIFO eviction at MAX_DEDUP_IDS).
 */
function createDedupSet() {
  const ids = [];
  const idSet = new Set();
  return {
    has(id) { return idSet.has(id); },
    add(id) {
      if (!id || idSet.has(id)) return;
      ids.push(id);
      idSet.add(id);
      while (ids.length > MAX_DEDUP_IDS) {
        const evicted = ids.shift();
        idSet.delete(evicted);
      }
    },
  };
}

function sleepWithAbort(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }

    let timer = null;
    const onAbort = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener('abort', onAbort);
      resolve();
    };

    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Subscribe to SSE events with auto-reconnect + dedup.
 *
 * @param {string} url - Full SSE endpoint URL
 * @param {function} onEvent - Callback receiving { event, data, id }
 * @param {AbortSignal} signal - AbortSignal to stop subscription
 * @param {string|null} lastEventId - Last event ID for resume
 * @param {{ maxConsecutiveFailures?: number }} options
 * @returns {{ lastEventId: string|null }}
 */
async function subscribeSse(url, onEvent, signal, lastEventId = null, options = {}) {
  validateGatewayOrigin(url);

  const dedup = createDedupSet();
  let currentLastId = lastEventId;
  let attempt = 0;
  let lastWas401 = false;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures =
    Number.isInteger(options.maxConsecutiveFailures) && options.maxConsecutiveFailures > 0
      ? options.maxConsecutiveFailures
      : Infinity;

  while (!signal.aborted) {
    try {
      // Force-refresh token if last attempt was a 401
      const token = await auth.getIdToken(lastWas401 ? { forceRefresh: true } : undefined);
      lastWas401 = false;

      const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      };
      if (currentLastId) {
        headers['Last-Event-ID'] = currentLastId;
      }

      const res = await fetch(url, {
        headers,
        redirect: 'manual',
        signal,
      });

      if (res.status === 401) {
        lastWas401 = true;
        const body = await res.text().catch(() => '');
        throw buildHttpError('SSE connect failed', res.status, body);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw buildHttpError('SSE connect failed', res.status, body);
      }

      // Reset backoff on successful connection
      attempt = 0;
      consecutiveFailures = 0;

      for await (const sseEvent of parseSseStream(res.body)) {
        if (signal.aborted) break;

        // Track last event ID for resume
        if (sseEvent.id) {
          currentLastId = sseEvent.id;
        }

        // Dedup by event ID
        if (sseEvent.id && dedup.has(sseEvent.id)) {
          continue;
        }
        if (sseEvent.id) {
          dedup.add(sseEvent.id);
        }

        try {
          onEvent(sseEvent);
        } catch {
          // ignore handler errors
        }
      }

      // Stream ended cleanly (proxy/server idle timeout, etc.) — reconnect with backoff.
      if (!signal.aborted) {
        throw new Error('SSE stream ended');
      }
    } catch (err) {
      if (signal.aborted) break;
      // Non-retryable: 404 means resource is gone (session expired, etc.)
      if (err && typeof err === 'object' && err.status === 404) {
        throw err;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`SSE terminated after ${consecutiveFailures} consecutive failures: ${reason}`);
      }
      // Exponential backoff with jitter for transient errors
      attempt++;
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
      const jitter = Math.random() * delay * 0.3;
      await sleepWithAbort(delay + jitter, signal);
      if (signal.aborted) {
        break;
      }
    }
  }

  return { lastEventId: currentLastId };
}

/**
 * Subscribe to session events.
 * SSE GET /gateway/v1/sessions/{sessionId}/events
 */
function subscribeSessionEvents(gatewayUrl, sessionId, onEvent, signal, lastEventId = null) {
  const url = `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/events`;
  return subscribeSse(url, onEvent, signal, lastEventId, { maxConsecutiveFailures: 12 });
}

/**
 * Subscribe to device events (status changes).
 * SSE GET /gateway/v1/devices/events
 */
function subscribeDeviceEvents(gatewayUrl, onEvent, signal, lastEventId = null) {
  const url = `${gatewayUrl}/gateway/v1/devices/events`;
  return subscribeSse(url, onEvent, signal, lastEventId);
}

/**
 * Delete a device registration from the gateway.
 * DELETE /gateway/v1/devices/{deviceId}
 */
async function deleteDevice(gatewayUrl, deviceId) {
  const res = await gatewayFetch(`${gatewayUrl}/gateway/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gateway DELETE device failed: ${res.status} ${text}`);
  }
}

module.exports = {
  fetchDevices,
  fetchIdentityKey,
  deleteDevice,
  initHandshake,
  pollHandshake,
  sendMessage,
  subscribeSessionEvents,
  subscribeDeviceEvents,
  validateGatewayOrigin,
};
