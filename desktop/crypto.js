/**
 * crypto.js — E2E encryption for desktop ↔ agent chat sessions.
 *
 * Port of src/crypto.ts to plain Node.js (no TypeScript, no ESM).
 * Uses Node.js built-in crypto module only.
 */

const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} = require('node:crypto');

// SPKI DER prefixes for raw 32-byte keys
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const AES_256_GCM = 'aes-256-gcm';
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HKDF_INFO = Buffer.from('commands.com/gateway/v1/e2ee', 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeBase64(raw, label) {
  if (typeof raw !== 'string') {
    throw new Error(`invalid base64 type for ${label}`);
  }
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw new Error(`invalid base64 for ${label}`);
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 0 && raw.length > 0) {
    throw new Error(`invalid base64 for ${label}`);
  }
  return buf;
}

function buildSpkiFromRaw(raw, prefix, label) {
  if (raw.length !== 32) {
    throw new Error(`Invalid ${label} raw key length: ${raw.length}`);
  }
  return Buffer.concat([prefix, raw]);
}

function readRawFromSpki(spkiDer, prefix, label) {
  if (spkiDer.length !== prefix.length + 32) {
    throw new Error(`Invalid ${label} SPKI length: ${spkiDer.length}`);
  }
  const head = spkiDer.subarray(0, prefix.length);
  if (!head.equals(prefix)) {
    throw new Error(`Unexpected ${label} SPKI prefix`);
  }
  return spkiDer.subarray(prefix.length);
}

function directionPrefix(direction) {
  if (direction === 'client_to_agent') {
    return Buffer.from([0x63, 0x32, 0x61, 0x00]); // c2a\0
  }
  if (direction === 'agent_to_client') {
    return Buffer.from([0x61, 0x32, 0x63, 0x00]); // a2c\0
  }
  throw new Error(`invalid direction: ${direction}`);
}

function validateSeq(seq) {
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`invalid sequence number: ${seq}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an X25519 ephemeral keypair for ECDH key exchange.
 * Returns { privateKey: KeyObject, publicKeyRawBase64: string }
 */
function generateEphemeralX25519() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const publicKeyDer = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  const publicRaw = readRawFromSpki(publicKeyDer, X25519_SPKI_PREFIX, 'x25519');
  return {
    privateKey,
    publicKeyRawBase64: publicRaw.toString('base64'),
  };
}

/**
 * Generate 16 random bytes as a session nonce (base64).
 */
function generateSessionNonce() {
  return randomBytes(16).toString('base64');
}

/**
 * Generate a unique session ID (UUID v4).
 */
function generateSessionId() {
  return randomUUID();
}

/**
 * Generate a unique handshake ID (UUID v4).
 */
function generateHandshakeId() {
  return randomUUID();
}

/**
 * Build transcript hash:
 *   SHA256(sessionId|handshakeId|clientEphPub|clientNonce|agentEphPub) → base64
 */
function buildTranscriptHash(sessionId, handshakeId, clientEphPubBase64, clientNonce, agentEphPubBase64) {
  const transcript = `${sessionId}|${handshakeId}|${clientEphPubBase64}|${clientNonce}|${agentEphPubBase64}`;
  return createHash('sha256').update(transcript, 'utf8').digest('base64');
}

/**
 * Derive shared secret via ECDH: our X25519 private + agent's X25519 ephemeral public.
 */
function deriveSharedSecret(ephemeralPrivateKey, agentEphemeralPublicKeyBase64) {
  const agentRaw = Buffer.from(agentEphemeralPublicKeyBase64, 'base64');
  const agentSpki = buildSpkiFromRaw(agentRaw, X25519_SPKI_PREFIX, 'x25519');
  const agentPubKey = createPublicKey({ format: 'der', type: 'spki', key: agentSpki });
  return diffieHellman({ privateKey: ephemeralPrivateKey, publicKey: agentPubKey });
}

/**
 * Derive three 32-byte session keys from ECDH shared secret + transcript hash salt.
 * Returns { clientToAgent, agentToClient, control } — all Buffers.
 */
function deriveSessionKeys(sharedSecret, transcriptHashBase64) {
  const salt = Buffer.from(transcriptHashBase64, 'base64');
  const keyMaterial = Buffer.from(hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 96));
  const clientToAgent = Buffer.from(keyMaterial.subarray(0, 32));
  const agentToClient = Buffer.from(keyMaterial.subarray(32, 64));
  const control = Buffer.from(keyMaterial.subarray(64, 96));
  keyMaterial.fill(0);
  return {
    clientToAgent,
    agentToClient,
    control,
  };
}

function normalizeKeyMaterial(keyMaterial, label) {
  if (Buffer.isBuffer(keyMaterial)) {
    return keyMaterial;
  }
  if (typeof keyMaterial === 'string') {
    return decodeBase64(keyMaterial, label);
  }
  throw new Error(`invalid ${label} type`);
}

/**
 * Build a deterministic 12-byte AES-GCM nonce from direction + sequence number.
 *   Bytes 0-3: direction prefix (c2a\0 or a2c\0)
 *   Bytes 4-11: BigUInt64BE of seq
 */
function deterministicNonce(direction, seq) {
  validateSeq(seq);
  const nonce = Buffer.alloc(GCM_NONCE_BYTES);
  directionPrefix(direction).copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

/**
 * Build AAD (Additional Authenticated Data) for a frame.
 *   base64(sessionId|messageId|seq|direction)
 */
function buildAad(sessionId, messageId, seq, direction) {
  const raw = `${sessionId}|${messageId}|${seq}|${direction}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

/**
 * Encrypt a plaintext message to an AES-256-GCM frame.
 * Returns { alg, direction, seq, nonce, ciphertext, tag, aad } (all base64 where applicable).
 */
function encryptFrame(keyMaterial, direction, seq, plaintextUtf8, sessionId, messageId) {
  const key = normalizeKeyMaterial(keyMaterial, 'session key');
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`invalid session key length: got ${key.length}, want ${AES_KEY_BYTES}`);
  }

  const nonce = deterministicNonce(direction, seq);
  const aadBase64 = buildAad(sessionId, messageId, seq, direction);
  const aad = Buffer.from(aadBase64, 'base64');

  const cipher = createCipheriv(AES_256_GCM, key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(plaintextUtf8, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    alg: AES_256_GCM,
    direction,
    seq,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
    aad: aadBase64,
  };
}

/**
 * Decrypt an AES-256-GCM frame. Verifies direction, seq, nonce, and AAD.
 * Returns plaintext string.
 */
function decryptFrame(keyMaterial, frame) {
  const key = normalizeKeyMaterial(keyMaterial, 'session key');
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`invalid session key length: got ${key.length}, want ${AES_KEY_BYTES}`);
  }
  if (!frame || frame.alg !== AES_256_GCM) {
    throw new Error(`unsupported frame alg: ${frame?.alg}`);
  }

  const expectedNonce = deterministicNonce(frame.direction, frame.seq);
  const receivedNonce = decodeBase64(frame.nonce, 'nonce');

  if (receivedNonce.length !== GCM_NONCE_BYTES) {
    throw new Error(`invalid nonce length: got ${receivedNonce.length}, want ${GCM_NONCE_BYTES}`);
  }
  if (!timingSafeEqual(expectedNonce, receivedNonce)) {
    throw new Error('nonce mismatch for sequence/direction');
  }

  const tag = decodeBase64(frame.tag, 'tag');
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error(`invalid auth tag length: got ${tag.length}, want ${GCM_TAG_BYTES}`);
  }

  const ciphertext = decodeBase64(frame.ciphertext, 'ciphertext');

  const decipher = createDecipheriv(AES_256_GCM, key, receivedNonce, { authTagLength: GCM_TAG_BYTES });

  if (typeof frame.aad !== 'string' || frame.aad.length === 0) {
    throw new Error('missing aad');
  }
  const aad = decodeBase64(frame.aad, 'aad');
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

/**
 * Verify an Ed25519 signature on a transcript hash.
 * @param {string} identityPublicKeyBase64 - Agent's Ed25519 public key (raw 32 bytes, base64)
 * @param {string} transcriptHashBase64 - Transcript hash (base64)
 * @param {string} signatureBase64 - Ed25519 signature (base64)
 * @returns {boolean} true if signature is valid
 */
function verifyIdentitySignature(identityPublicKeyBase64, transcriptHashBase64, signatureBase64) {
  const rawKey = decodeBase64(identityPublicKeyBase64, 'identity public key');
  const spki = buildSpkiFromRaw(rawKey, ED25519_SPKI_PREFIX, 'ed25519');
  const pubKey = createPublicKey({ format: 'der', type: 'spki', key: spki });
  const message = decodeBase64(transcriptHashBase64, 'transcript hash');
  const signature = decodeBase64(signatureBase64, 'signature');
  return verify(null, message, pubKey, signature);
}

/**
 * Zero-fill key material in-place.
 * Only mutable byte buffers can be wiped; strings are immutable in JS.
 */
function zeroKey(keyMaterial) {
  if (!keyMaterial) return;
  try {
    if (Buffer.isBuffer(keyMaterial)) {
      keyMaterial.fill(0);
    }
  } catch (_e) {
    // best-effort
  }
}

module.exports = {
  generateEphemeralX25519,
  generateSessionNonce,
  generateSessionId,
  generateHandshakeId,
  buildTranscriptHash,
  deriveSharedSecret,
  deriveSessionKeys,
  deterministicNonce,
  buildAad,
  encryptFrame,
  decryptFrame,
  verifyIdentitySignature,
  zeroKey,
};
