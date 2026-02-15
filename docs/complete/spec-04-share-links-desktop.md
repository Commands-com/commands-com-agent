# Spec 04 - Share Links in Desktop UI (Create + Consume)

Status: Draft
Priority: P1

## Goal

Enable desktop users to:

- Share their agents using link-based grants.
- Consume share links directly in desktop.
- Manage active grants and revocations.

Desktop revocation is a required capability for this feature (not deferred to web).

## User Flows

### Create Share Link (Owner)

1. Open "My Agent" detail.
2. Click `Share`.
3. Choose role/scope and expiration.
4. Generate link and copy.

### Consume Share Link (Recipient)

1. Click `Paste share link` from the "Shared With Me" section (or after sign-in CTA), or open deep link directly.
2. Desktop resolves token and displays grant preview.
3. User accepts -> device appears under "Shared With Me".

### Manage Shares

- Owner can list active grants and revoke instantly.
- Recipient can remove shared agent locally and revoke own grant access if permitted.

Revocation UX is required in desktop on initial ship:

- Owner: revoke from agent detail grant table and from shared-management modal.
- Recipient: revoke/leave access from "Shared With Me" detail when policy allows.

## Link Format

- Web link: `https://commands.com/share/<shareToken>`
- Desktop deep link: `commands-desktop://share?token=<shareToken>`

`shareToken` should be opaque, signed/random, and non-enumerable.

## Security Requirements

- Token entropy >= 128 bits.
- Optional one-time-use links supported.
- TTL required (default 7 days, max 90 days).
- Scope attached to token (`chat`, `view-status`, optional future scopes).
- Revoked/expired links fail closed.

## Ownership Boundary (Gateway vs App Backend)

Source of truth is the **gateway**:

- Share-token minting, validation, consume, revocation, and grant records live in gateway data model.
- Token status (`active|consumed|revoked|expired`) is authoritative in gateway.
- Device-level authorization checks for shared access are enforced by gateway only.

App backend role:

- Web UX only (landing pages, deep-link bootstrap, account UI).
- May proxy to gateway for compatibility, but must not maintain an independent share-token store.
- Any `/api/gateway/shares/*` endpoint should be a thin authenticated facade over gateway APIs, not a second authority.

Decision:

- Desktop integrates directly with gateway share endpoints for create/consume/manage.
- App backend share endpoints are optional compatibility wrappers and should be documented as such.

## Proposed API Surface

- `POST /gateway/v1/shares` -> create link/grant template
- `POST /gateway/v1/shares/consume` -> consume token, create recipient grant
- `GET /gateway/v1/shares` -> owner list active shares
- `POST /gateway/v1/shares/:shareId/revoke` -> revoke share
- `GET /gateway/v1/shared-with-me` -> recipient list

Compatibility layer (optional):

- `POST /api/gateway/shares/*` -> proxy to gateway with no divergent business logic.

## Desktop Integration

Main process:

- Handle `open-url` for `commands-desktop://share?...`.
- Validate token format.
- Require signed-in state before consume call.
- Emit safe UI events to renderer.

Auth resume handling:

- If consume is attempted while signed out, store `pendingShareToken` in main-process memory before starting auth.
- Resume consume automatically after successful auth callback.
- Clear `pendingShareToken` on first terminal outcome: consume success, consume failure, auth failure/cancel, sign-out, or timeout.
- TTL for pending token: 5 minutes.
- Never persist pending token to disk or logs.

Renderer:

- Add share modal in agent detail.
- Add consume-link confirmation dialog.
- Add grant management table (status, created, expires, revoke action).
- Revoke action must be available in desktop UI with confirmation + optimistic pending state.
- Add `Paste share link` affordance in sidebar under **Shared With Me**.
- If user is signed out, show CTA after login success to continue pending consume flow.
- `Paste share link` opens a modal with one input that accepts:
  - full web URL (`https://commands.com/share/<token>`)
  - desktop deep link (`commands-desktop://share?token=...`)
  - raw token string
- Show inline validation errors before network call when format is invalid.

## Error Handling

- Not signed in -> prompt auth, then resume consume flow.
- Expired/revoked token -> clear actionable error.
- Already consumed -> idempotent response with existing share status.
- Invalid link/token format -> client-side validation error with examples.
- Revoke failure -> show inline retry affordance and preserve current grant row state.

## Verification

1. Owner creates share link; recipient consumes via deep link.
2. Shared agent appears in sidebar immediately.
3. Revoke share removes access (new sessions blocked, active behavior as policy-defined).
4. Expired token cannot be consumed.
5. One-time token cannot be reused.
6. Gateway and app backend never return conflicting share state for same token.
7. Signed-out consume path resumes correctly after auth using in-memory pending token.
8. Recipient can consume by pasting URL/token from sidebar `Paste share link` flow.
9. Owner can revoke from desktop without opening web UI.
10. Recipient sees revoked grant reflected in desktop within one refresh/SSE cycle.
