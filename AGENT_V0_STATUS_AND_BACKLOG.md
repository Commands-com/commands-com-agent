# commands-com-agent: Status And Backlog

Status date: 2026-02-13
Project path: `commands-com-agent`
Scope: Local connector for commands.com secure relay (web-first V0)

## 1) What has been done

### 1.1 Project scaffold created

Implemented:
- TypeScript Node project setup (`package.json`, `tsconfig.json`)
- CLI entrypoint with subcommands
- Build and typecheck scripts
- npm distribution support (`files`, `engines`, `prepare` fields)

Files:
- `package.json`
- `tsconfig.json`
- `src/index.ts`

### 1.2 Claude Agent SDK integration (local execution)

Implemented:
- Local prompt execution using `@anthropic-ai/claude-agent-sdk` via streaming `query(...)`
- Assistant turn parsing + final result extraction
- Cost/model extraction from result/system messages
- Policy-aware execution with tool gating and permission modes

Files:
- `src/claude.ts`

### 1.3 Local config and identity key management

Implemented:
- Config persistence at `~/.commands-agent/config.json`
- Secure file permissions (`0700` dir, `0600` config)
- Ed25519 identity generation and storage
- Identity fingerprint helper

Files:
- `src/config.ts`
- `src/crypto.ts`

### 1.4 Gateway API client integration

Implemented endpoints:
- `GET /gateway/v1/health`
- `PUT /gateway/v1/devices/:device_id/identity-key`
- `POST /gateway/v1/sessions/:session_id/handshake/agent-ack`

Files:
- `src/gateway.ts`

### 1.5 Handshake logic module

Implemented:
- Ephemeral X25519 key generation
- Transcript hash construction
- Transcript signature with local Ed25519 identity key
- Shared secret + HKDF session key derivation
- Handshake ack submission to gateway

Files:
- `src/handshake.ts`

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
- `src/runtime.ts`

### 1.7 Encrypted session frame handling

Implemented:
- AES-256-GCM frame encryption/decryption helpers
- Deterministic nonce derivation by `(direction, seq)`
- Strict sequence enforcement (`nextIncomingSeq`, `nextOutgoingSeq`)
- AAD support in encrypted envelopes
- Encrypted `session.message` ingest path
- Encrypted `session.progress`, `session.result`, and `session.error` response paths (all session frames encrypted)

Files:
- `src/crypto.ts`
- `src/runtime.ts`

### 1.8 OAuth login and device token lifecycle

Implemented:
- Browser OAuth with PKCE (`login` command)
- Headless mode with manual code paste
- Refresh token exchange on access token expiry
- Automatic re-auth via OAuth when refresh token is also expired
- Token expiry tracking in config
- Cross-platform browser open (macOS, Windows, Linux)
- Requests `device` scope for device-specific endpoint access

Files:
- `src/oauth.ts`
- `src/index.ts` (cmdLogin, cmdStart token recovery)

### 1.9 Local policy enforcement

Implemented:
- Three presets: `safe` (read-only), `balanced` (dev-safe), `power` (full)
- Tool disallowance lists per preset
- Bash command deny patterns (rm -rf /, shutdown, reboot, mkfs, dd, fork bomb)
- Blocked path roots (~/.ssh, ~/.aws, ~/.gnupg)
- CWD whitelist validation
- Max prompt size limit
- Policy loaded from file or generated from preset
- Integrated into Claude SDK execution via `canUseTool` gate

Files:
- `src/policy.ts`
- `src/claude.ts`

### 1.10 Audit logging

Implemented:
- JSONL audit log for all incoming session messages
- Configurable audit log path
- Secure file permissions (0700/0600)
- Logs: timestamp, event, requester_uid, device_id, session_id, prompt, encrypted flag

Files:
- `src/audit.ts`
- `src/runtime.ts`

### 1.11 MCP server configuration

Implemented:
- Parse MCP server configs (stdio, sse, http types)
- Load from JSON file
- Auto-generation via start-agent.sh (filesystem server)
- Passthrough to Claude Agent SDK

Files:
- `src/mcp.ts`
- `start-agent.sh`

### 1.12 Desktop companion app

Implemented:
- Electron desktop app with setup wizard
- Agent process management (start/stop/status)
- Live log streaming
- Audit log viewer with filtering
- MCP module configuration UI
- Profile management

Files:
- `desktop/main.js`
- `desktop/preload.js`
- `desktop/renderer/app.js`

### 1.13 CLI commands

Implemented:
- `login` — Browser OAuth device registration
- `init` — Manual token initialization (headless fallback)
- `status` — Show config + gateway health (supports --json)
- `run` — Execute single prompt locally
- `ack-handshake` — Sign handshake for session establishment
- `start` — Always-on WebSocket runtime with reconnect

File:
- `src/index.ts`

### 1.14 Production readiness

Implemented:
- Production gateway URL default (`https://api.commands.com`)
- Generic defaults for CWD and filesystem root (`$HOME`)
- npm distribution metadata (files, engines, prepare)

## 2) Remaining gaps

### 2.1 End-to-end integration testing

Current state:
- Agent encrypted frames work. Gateway relay works. Not yet tested end-to-end in a single automated flow.

Needed:
- Integration test: browser → gateway → agent → response → browser with encrypted frames

Priority: P1

### 2.2 Pairing flow (pair code UX)

Current state:
- OAuth login via browser is the primary registration path and works for production.
- Manual init provides headless fallback.

Needed:
- Optional pair code flow for simpler device registration without browser

Priority: P2 (OAuth login covers the primary use case)

### 2.3 WebSocket protocol versioning

Current state:
- Runtime handles frame types but protocol is not version-negotiated.

Needed:
- Protocol version field in `agent.hello`
- Graceful version mismatch handling

Priority: P2

### 2.4 Cross-agent routing (A ↔ Gateway ↔ B)

Current state:
- Runtime handles gateway-to-single-agent sessions only.

Needed:
- Gateway-routed cross-agent session frames
- Same-account restrictions

Priority: P2 (future feature)

### 2.5 Observability improvements

Current state:
- Console logs + JSONL audit file

Needed:
- Structured logs with request/session IDs
- Metrics counters

Priority: P2

### 2.6 Secret handling hardening

Current state:
- Tokens stored in config file with 0600 permissions.

Needed:
- OS keychain integration for sensitive material

Priority: P2

## 3) Short-term roadmap

1. End-to-end integration test across browser ↔ gateway ↔ agent
2. Protocol version field in agent.hello
3. Structured logging with session IDs
4. Optional pair code flow

## 4) Definition of done for Agent V0

Agent V0 is done when all are true:
- [x] Maintains stable always-on WebSocket session with reconnect
- [x] Completes authenticated handshake and derives session keys
- [x] Processes encrypted frames end-to-end
- [x] Enforces local policy before execution
- [x] Supports device token refresh/rotation
- [x] Emits audit logs
- [ ] Passes end-to-end integration test

## 5) Current file map

Core source files:
- `src/index.ts` — CLI entry point
- `src/runtime.ts` — WebSocket runtime
- `src/handshake.ts` — E2EE handshake
- `src/crypto.ts` — Cryptographic primitives
- `src/gateway.ts` — Gateway HTTP client
- `src/claude.ts` — Claude Agent SDK integration
- `src/oauth.ts` — OAuth 2.0 with PKCE
- `src/config.ts` — Config persistence
- `src/types.ts` — TypeScript interfaces
- `src/mcp.ts` — MCP server config
- `src/policy.ts` — Policy enforcement engine
- `src/audit.ts` — Audit log writer

Desktop:
- `desktop/main.js` — Electron main process
- `desktop/preload.js` — IPC bridge
- `desktop/renderer/app.js` — Desktop UI

Scripts:
- `start-agent.sh` — Production startup script
- `run_desktop.sh` — Desktop app launcher
