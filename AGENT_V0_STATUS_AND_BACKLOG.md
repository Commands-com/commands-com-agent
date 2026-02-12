# commands-com-agent: Status And Backlog

Status date: 2026-02-11
Project path: `/Users/dtannen/Code/commands-com-agent`
Scope: Local connector for commands.com secure relay (web-first V0)

## 1) What has been done

### 1.1 Project scaffold created

Implemented:
- TypeScript Node project setup (`package.json`, `tsconfig.json`)
- CLI entrypoint with subcommands
- Build and typecheck scripts

Files:
- `/Users/dtannen/Code/commands-com-agent/package.json`
- `/Users/dtannen/Code/commands-com-agent/tsconfig.json`
- `/Users/dtannen/Code/commands-com-agent/src/index.ts`

### 1.2 Claude Agent SDK integration (local execution)

Implemented:
- Local prompt execution using `@anthropic-ai/claude-agent-sdk` via streaming `query(...)`
- Assistant turn parsing + final result extraction
- Cost/model extraction from result/system messages

Files:
- `/Users/dtannen/Code/commands-com-agent/src/claude.ts`

Notes:
- This follows the same SDK family used in Shannon.

### 1.3 Local config and identity key management

Implemented:
- Config persistence at `~/.commands-agent/config.json`
- Secure file permissions (`0700` dir, `0600` config)
- Ed25519 identity generation and storage
- Identity fingerprint helper

Files:
- `/Users/dtannen/Code/commands-com-agent/src/config.ts`
- `/Users/dtannen/Code/commands-com-agent/src/crypto.ts`

### 1.4 Gateway API client integration

Implemented endpoints:
- `GET /gateway/v1/health`
- `PUT /gateway/v1/devices/:device_id/identity-key`
- `POST /gateway/v1/sessions/:session_id/handshake/agent-ack`

Files:
- `/Users/dtannen/Code/commands-com-agent/src/gateway.ts`

### 1.5 Handshake logic module

Implemented:
- Ephemeral X25519 key generation
- Transcript hash construction
- Transcript signature with local Ed25519 identity key
- Shared secret + HKDF session key derivation
- Handshake ack submission to gateway

Files:
- `/Users/dtannen/Code/commands-com-agent/src/handshake.ts`

### 1.6 Always-on runtime

Implemented:
- Persistent WebSocket runtime to gateway endpoint
- Exponential reconnect with jitter
- Runtime hello + heartbeat
- Handling for incoming frames:
  - `session.handshake.request`
  - `session.message`
  - `session.cancel`
  - `heartbeat`/`ping`
- Session map in memory after handshake success
- Local prompt execution on session message

Files:
- `/Users/dtannen/Code/commands-com-agent/src/runtime.ts`

### 1.7 Encrypted session frame handling (first pass)

Implemented:
- AES-256-GCM frame encryption/decryption helpers
- Deterministic nonce derivation by `(direction, seq)`
- Strict sequence enforcement (`nextIncomingSeq`, `nextOutgoingSeq`)
- AAD support in encrypted envelopes
- Encrypted `session.message` ingest path
- Encrypted `session.result` and encrypted `session.error` response path

Files:
- `/Users/dtannen/Code/commands-com-agent/src/crypto.ts`
- `/Users/dtannen/Code/commands-com-agent/src/runtime.ts`

### 1.8 CLI commands available

Implemented commands:
- `init`
- `status`
- `run`
- `ack-handshake`
- `start`

File:
- `/Users/dtannen/Code/commands-com-agent/src/index.ts`

### 1.9 Documentation and dependencies

Implemented:
- README updated for runtime + encryption behavior + known gaps
- Added `ws` and `@types/ws`

Files:
- `/Users/dtannen/Code/commands-com-agent/README.md`
- `/Users/dtannen/Code/commands-com-agent/package.json`

### 1.10 Verification completed

Commands run successfully:
- `npm run typecheck`
- `npm run build`

## 2) What is not done yet (critical gaps)

## 2.1 Full end-to-end encrypted rollout (gateway + client parity)

Current state:
- Agent can process encrypted envelopes for `session.message` and return encrypted results/errors.
- Gateway/browser-side relay contract is not fully implemented end-to-end yet.

Needed:
- Gateway runtime relay must preserve and validate encrypted envelope contract consistently.
- Web client/runtime must generate and consume the same encrypted envelope format.
- Integration tests across browser <-> gateway <-> agent using encrypted frames only.

Priority: P0

## 2.2 Device token lifecycle is incomplete

Current state:
- Uses static `device_token` from config.

Needed:
- Refresh token support and automatic rotation
- Expiry handling and re-auth flow
- Revocation handling (hard fail + operator guidance)

Priority: P0

## 2.3 Pairing flow is not implemented in this project

Current state:
- Requires manual `device_id` and `device_token` via `init` flags.

Needed:
- Implement pair code flow once gateway endpoints are available:
  - pair-code retrieval/input UX
  - token bootstrap + secure persistence

Priority: P0

## 2.4 WebSocket protocol hardening and versioning

Current state:
- Runtime handles proposed frame names but protocol is not version-negotiated.

Needed:
- Protocol version field + compatibility matrix
- Structured schema validation for incoming/outgoing frames
- Graceful downgrade behavior

Priority: P1

## 2.5 Agent<->Gateway<->Agent routing is not implemented yet

Clarification:
- Desired model is **not direct agent-to-agent**.
- Desired model is gateway-mediated relay:
  - `Agent A <-> Gateway <-> Agent B`

Current state:
- Runtime only handles gateway-to-single-agent session messages.

Needed:
- Add gateway-routed cross-agent session frame support:
  - `agent.session.open`
  - `agent.session.accept`
  - `agent.session.message`
  - `agent.session.close`
- Same-account default restriction and explicit allowlist policies.

Priority: P0

## 2.6 Local policy enforcement is minimal

Current state:
- Prompt execution allowed with configurable cwd fallback.

Needed:
- Local allow/deny policy file (paths + capabilities)
- Enforce policy before any execution
- Approval hook integration for privileged actions

Priority: P0

## 2.7 Observability is basic

Current state:
- Console logs only.

Needed:
- Structured logs with request/session IDs
- Optional local audit file (metadata-only)
- Metrics counters (handshake, reconnect, execution success/failure)

Priority: P1

## 2.8 Secret handling hardening

Current state:
- Tokens are stored in config file.

Needed:
- Use OS keychain/keyring for refresh token and sensitive material
- Keep config non-sensitive where possible

Priority: P1

## 3) Short-term roadmap (next execution order)

1. Align gateway/web with encrypted envelope contract and run end-to-end encrypted integration tests.
2. Add nonce window/replay telemetry and strict policy for duplicate/reordered frames.
3. Add device token refresh workflow and expiry recovery.
4. Add protocol schema validation and version negotiation.
5. Add gateway-mediated Agent<->Gateway<->Agent message types.
6. Add local policy engine and execution guardrails.
7. Add structured logging + metrics.

## 4) Definition of done for Agent V0

Agent V0 is done when all are true:
- Maintains stable always-on WebSocket session with reconnect.
- Completes authenticated handshake and derives session keys.
- Processes encrypted frames end-to-end with gateway/client parity.
- Enforces local policy before execution.
- Supports device token refresh/rotation.
- Supports gateway-mediated cross-agent routing (A<->Gateway<->B) with same-account restrictions.
- Emits structured metadata logs and passes integration tests.

## 5) Current file map

Core source files:
- `/Users/dtannen/Code/commands-com-agent/src/index.ts`
- `/Users/dtannen/Code/commands-com-agent/src/runtime.ts`
- `/Users/dtannen/Code/commands-com-agent/src/handshake.ts`
- `/Users/dtannen/Code/commands-com-agent/src/crypto.ts`
- `/Users/dtannen/Code/commands-com-agent/src/gateway.ts`
- `/Users/dtannen/Code/commands-com-agent/src/claude.ts`
- `/Users/dtannen/Code/commands-com-agent/src/config.ts`
- `/Users/dtannen/Code/commands-com-agent/src/types.ts`

Project config/docs:
- `/Users/dtannen/Code/commands-com-agent/package.json`
- `/Users/dtannen/Code/commands-com-agent/tsconfig.json`
- `/Users/dtannen/Code/commands-com-agent/README.md`

Built artifacts:
- `/Users/dtannen/Code/commands-com-agent/dist/*`
