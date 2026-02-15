# Spec 07 - OSS Gateway Fast Deploy (Railway-First)

Status: Draft
Priority: Post-v1 P0

## Goal

Make the open-source gateway deployable to Railway (and similar hosts) so a developer can get a valid public gateway URL and test with real collaborators quickly.

Primary target:

- **Time to valid URL**: <= 10 minutes from "Deploy" click.
- **Time to first shared chat**: <= 20 minutes with two users.

## Why This Matters

- Reduces setup friction for OSS adoption.
- Makes "test with another person" viable on day 1.
- Unblocks community validation of shared-agent and relay behavior without infra expertise.

## Non-Goals

- Perfect production hardening in quick-start mode.
- Multi-region HA for initial OSS launch.
- Provider-specific lock-in beyond reference templates.

## Deployment UX Requirements

Railway-first experience must include:

1. One-click deploy template.
2. Minimal required env vars surfaced in UI.
3. Automatic HTTPS public URL.
4. Health/readiness checks so failed deploys are obvious.
5. Copy-paste gateway URL path for desktop settings.

## Runtime Architecture Constraints

- Single stateless gateway service process.
- External Redis required for relay/session/event state.
- Persistent backing store required for device/share/auth metadata (backend adapter must have a Railway-friendly option).
- No local disk dependency for critical runtime state.

## Required Auth Modes

The OSS build must support explicit modes:

- `AUTH_MODE=demo` (quick-start)
- `AUTH_MODE=firebase` (existing production-compatible path)
- `AUTH_MODE=oidc` (standards path for self-hosters)

### Demo Auth (quick-start)

Purpose: shortest path to collaborative testing.

Rules:

- Enabled only when `AUTH_MODE=demo`.
- Clearly marked as non-production in logs and auth UI.
- Issues normal gateway OAuth tokens so desktop flow remains unchanged.
- Rate-limited and short default token TTLs.
- Can be disabled entirely via env.

## Environment Contract (Minimum)

Required for quick-start:

- `PORT`
- `PUBLIC_BASE_URL` (or platform-provided external URL)
- `JWT_SIGNING_KEY`
- `REDIS_URL`
- `AUTH_MODE=demo`

Required for production-like modes:

- `AUTH_MODE=firebase` plus Firebase env set
- or `AUTH_MODE=oidc` plus issuer/client config

## Railway Deliverables

- `railway.toml` with start command, health check path, and restart policy.
- README section: "Deploy to Railway in 10 minutes."
- Deploy button/template metadata checked into repo.
- `.env.example` including quick-start and production auth variants.

## Desktop Compatibility Requirements

- Desktop continues using `Gateway URL` setting with no code changes to auth/session stack.
- OAuth authorize/token endpoints must remain compatible with existing desktop flow.
- Shared chat endpoints and SSE contracts must remain stable.

## Operational Guardrails

- `/healthz` (liveness) and `/readyz` (deps ready: Redis + store).
- Structured startup log showing resolved public base URL and auth mode.
- Fail fast on missing required env.
- Safe defaults for CORS and redirect allowlists (explicitly configurable).

## Validation Matrix

1. Fresh Railway deploy yields public HTTPS URL.
2. Desktop sign-in works against deployed URL.
3. User A shares an agent; User B consumes and chats.
4. SSE device status + session events function across two real clients.
5. Revoke share from desktop/web takes effect against deployed gateway.
6. Restart gateway service; clients reconnect successfully.
7. Demo auth mode clearly indicates non-production status.

## Exit Criteria

- A new OSS user can follow README and complete cross-user shared chat in <= 20 minutes.
- No manual code edits required for basic Railway deployment.
- Gateway URL produced is directly usable in desktop app settings.
