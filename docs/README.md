# Commands.com Agent Feature Specs Index

Date: 2026-02-14
Owner: Desktop + Gateway
Status: Active

## Scope

This spec set covers seven rebuild features:

1. Namespaced agent naming so different users can register the same agent name.
2. Requester identity enrichment (email/display name) for live conversations and audit logs.
3. Multi-agent runtime (run multiple local agents at once).
4. Share links in desktop UI (create, consume, and manage).
5. Agent-to-agent communication using agents in "Shared With Me".
6. Ollama model-provider support for local/shared agent runtimes.
7. OSS gateway fast deploy (Railway-first) for rapid external validation.

Primary vision context: `/Users/dtannen/Code/commands-com-agent/docs/VISION.md`.

## Completed

- `/Users/dtannen/Code/commands-com-agent/docs/complete/spec-01-agent-name-namespacing.md`
- `/Users/dtannen/Code/commands-com-agent/docs/complete/spec-02-requester-email-identity.md`
- `/Users/dtannen/Code/commands-com-agent/docs/complete/spec-04-share-links-desktop.md`
- `/Users/dtannen/Code/commands-com-agent/docs/complete/spec-06-ollama-support.md`
- `/Users/dtannen/Code/commands-com-agent/docs/complete/spec-08-agent-activity-indicator.md`

## Todo

- `/Users/dtannen/Code/commands-com-agent/docs/todo/spec-03-multi-agent-runtime.md`
- `/Users/dtannen/Code/commands-com-agent/docs/todo/spec-05-agent-to-agent-shared.md`
- `/Users/dtannen/Code/commands-com-agent/docs/todo/spec-07-oss-gateway-fast-deploy.md`

## Future

- `/Users/dtannen/Code/commands-com-agent/docs/future/spec-09-v2-future-mixed-agent-rooms.md`

## Dependency Order

Recommended implementation order:

1. `spec-03` Multi-agent runtime
2. `spec-05` Agent-to-agent communication (depends on 2, 3, and 4)
3. `spec-07` OSS gateway fast deploy (depends on endpoint parity from 1-6)

## Release Strategy

- Completed: 1, 2, 4, 6, 8
- Current v1 push: 3, 5, 7
- Future platform exploration: 9

## Global Security Requirements

- Renderer never receives auth tokens, long-lived secrets, or encryption keys.
- All gateway bearer-token requests remain origin-allowlisted and `redirect: 'manual'`.
- Desktop retains strict markdown sanitization and safe external URL opening.
- New APIs must preserve least-privilege access checks.

## Cross-Spec Invariants

These constraints are normative across specs and must not diverge per feature.

- **Device identity keying**: `device_id` is opaque and globally unique. Required format is `dev_` + 32 lowercase hex chars (128-bit random). `device_id` is stable for a profile lifetime and is never derived from display name.
- **Runtime and session limits**: Desktop enforces bounded concurrency/resource caps for local runtimes and shared chat sessions. Gateway owner-connection caps remain authoritative; desktop applies a lower soft cap to avoid edge saturation.
- **Share authority model**: Gateway is the single source of truth for share token mint/consume/revoke state and grant authorization. App backend share endpoints, when present, are thin facades only.
- **Token and key isolation**: Renderer never receives bearer tokens, refresh tokens, private keys, or ciphertext. Auth, gateway I/O, and cryptographic operations execute in desktop main process only.
- **Fail-closed security posture**: Untrusted origins, invalid/revoked/expired auth or share state, and policy violations must fail closed with explicit user-visible errors.
- **Error reporting contract**: User-facing errors across desktop features must use a common shape: `{ code: string, message: string, recoverable: boolean }`. `code` is stable for programmatic handling, `message` is human-readable, and `recoverable` drives retry/next-step UX.

## Global Done Criteria

- End-to-end happy path passes for each feature.
- Negative tests for spoofing, replay, unauthorized access, and malformed input pass.
- Existing "My Agents" behavior remains backward-compatible where required.
- `npx tsc --noEmit` passes in desktop repo and relevant gateway test suites remain green.
