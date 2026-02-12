interface JsonResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function parseJsonSafe(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit
): Promise<JsonResult<T>> {
  try {
    const resp = await fetch(url, init);
    const data = await parseJsonSafe(resp);

    if (!resp.ok) {
      const maybeErr = (data as { error?: string } | undefined)?.error;
      return {
        ok: false,
        status: resp.status,
        error: maybeErr ?? `HTTP ${resp.status}`,
      };
    }

    return {
      ok: true,
      status: resp.status,
      data: data as T,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function gatewayHealth(gatewayUrl: string): Promise<JsonResult<{ status: string }>> {
  return requestJson<{ status: string }>(`${gatewayUrl}/gateway/v1/health`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
}

export async function registerIdentityKey(
  gatewayUrl: string,
  deviceId: string,
  deviceToken: string,
  publicKeyRawBase64: string
): Promise<JsonResult<void>> {
  return requestJson<void>(`${gatewayUrl}/gateway/v1/devices/${encodeURIComponent(deviceId)}/identity-key`, {
    method: 'PUT',
    headers: authHeaders(deviceToken),
    body: JSON.stringify({
      algorithm: 'ed25519',
      public_key: publicKeyRawBase64,
    }),
  });
}

interface HandshakeAckPayload {
  device_id: string;
  agent_ephemeral_public_key: string;
  agent_identity_signature: string;
  transcript_hash: string;
  handshake_id: string;
}

export async function postHandshakeAck(
  gatewayUrl: string,
  sessionId: string,
  deviceToken: string,
  payload: HandshakeAckPayload
): Promise<JsonResult<{ status: string; session_id: string; handshake_id: string }>> {
  return requestJson<{ status: string; session_id: string; handshake_id: string }>(
    `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/handshake/agent-ack`,
    {
      method: 'POST',
      headers: authHeaders(deviceToken),
      body: JSON.stringify(payload),
    }
  );
}
