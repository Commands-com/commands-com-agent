# Spec 02 - Requester Email and Identity Enrichment

Status: Implemented (2026-02-15)
Priority: P1

## Problem

Live conversations and audit views currently show `requester_uid` (Firebase UID), which is hard to interpret for operators and owners.

## Goals

- Show requester email/display identity in live chat and audit logs.
- Keep UID for strict identity/audit references.
- Avoid trusting requester-provided identity fields.

## Non-Goals

- Replacing UID as canonical identity key.
- Exposing requester identity to unauthorized users.

## Trust Model

`requester` identity fields are server-derived from validated auth claims and never trusted from client payload.

Required relay behavior:

- Always overwrite `requester_uid` on ingress using authenticated context.
- Always overwrite `requester_email` and `requester_display_name` when available from validated claims/profile.

## Event Schema

Add a normalized `requester` object while retaining legacy fields for compatibility.

```json
{
  "type": "session.message",
  "requester_uid": "uid_123",
  "requester_email": "alice@company.com",
  "requester_display_name": "Alice",
  "requester": {
    "uid": "uid_123",
    "email": "alice@company.com",
    "display_name": "Alice"
  }
}
```

Fallback rules:

- Email unavailable -> `requester_email: null`.
- Display name unavailable -> fallback to local-part of email, else short UID.

## Desktop Rendering Rules

- Live conversation list primary label: `requester_display_name || requester_email || short(uid)`.
- Secondary text can include UID for debugging.
- Audit log entries should persist both UID and email/display values if present.

## Privacy and Access

- Only participants who are already authorized for the session/device receive requester identity fields.
- No additional public endpoint should leak requester email lists.

## Backend/API Changes

- Relay envelope builder: include enriched requester fields server-side.
- Audit log schema: optional `requester_email`, `requester_display_name`.
- Keep backward compatibility for consumers expecting only `requester_uid`.

Implemented:
- Gateway relay now force-overwrites `requester_uid`, `requester_email`, `requester_display_name`, and normalized `requester` object on ingress before forwarding to agent.
- Agent runtime now records requester email/display in audit events and emits enriched desktop live-conversation events.
- Desktop Live Conversations now render `display_name || email || short(uid)` with UID as secondary context.
- Desktop Audit UI now supports requester filtering by UID/email/display and renders enriched requester identity metadata.

## Verification

1. Send message as authenticated user with email claim -> owner sees email/display in live view.
2. Audit entry contains UID + email fields.
3. Spoofed requester fields in POST payload are overwritten.
4. Missing email claim path renders fallback identity cleanly.
