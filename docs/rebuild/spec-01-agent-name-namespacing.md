# Spec 01 - Agent Name Namespacing

Status: Draft
Priority: P1

## Problem

Agent naming currently behaves like a global namespace in key paths, which can block multiple users from registering the same human-friendly name (for example, two users both wanting "CodeBot").

## Goals

- Allow duplicate display names across different owners.
- Preserve stable internal uniqueness for routing and storage.
- Keep UI names human-readable.

## Non-Goals

- Enforcing unique display names across all users.
- Introducing public username collisions as an auth mechanism.

## Proposed Model

Use separate identity fields for display and uniqueness:

- `display_name`: user-facing name, non-unique.
- `owner_uid`: authenticated owner identity.
- `profile_id`: local desktop stable UUID.
- `device_id`: globally unique gateway identifier (opaque, not derived solely from display name).
- `name_key`: normalized display name (for owner-local uniqueness checks only if desired).

Uniqueness guarantees:

- Gateway primary uniqueness: `device_id`.
- Optional owner-local uniqueness rule: `(owner_uid, name_key)`.

## Device ID Generation Strategy (Normative)

`device_id` must be:

- Globally unique.
- Stable for the lifetime of a local profile (rename-safe).
- Opaque (not derived from `display_name`).

Generation rules:

1. Desktop main process generates `device_id` once at profile creation.
2. Format: `dev_` + 32 lowercase hex chars (128 bits random), example: `dev_7f3c...`.
3. Persist in profile metadata and reuse on every start/re-register.
4. Never regenerate on profile rename, model change, or workspace change.
5. Regenerate only on explicit user action (`Rotate device identity`) or hard conflict recovery.

Conflict recovery:

- If registration returns device-id collision/conflict, regenerate and retry up to 3 times.
- On repeated conflict, fail with actionable error and no silent fallback.
- Treat any collision as an operational anomaly (not expected random chance with 128-bit IDs).
- Logging policy: warn on first collision, error on second+ collision, include `profile_id` and attempted `device_id` (no secrets).
- Emit a metric/counter for collisions so backend/data-race bugs are visible.

Notes:

- `deviceName` remains human-readable and may be derived from name.
- `device_id` remains the only routing/storage key for gateway sessions.

## Data Contract Changes

Device object (gateway -> desktop) should always include:

```json
{
  "device_id": "dev_01H...",
  "display_name": "CodeBot",
  "owner_uid": "uid_abc",
  "owner_email": "alice@company.com",
  "status": "online",
  "role": "owner|shared"
}
```

## Backend Changes

- Gateway registration endpoints should accept `display_name` without global uniqueness checks.
- Any previous global uniqueness index on name should be removed or scoped by owner.
- Device list endpoints should return both `display_name` and owner identity metadata for correct disambiguation in shared lists.

## Desktop Changes

- Profile creation/edit screens keep `display_name` as plain text.
- Sidebar labels continue to use display name.
- In "Shared With Me", show subtitle `Owner: <email>` to disambiguate duplicate names.
- Search uses both display name and owner email.

## Migration

No migration required (explicitly accepted). Existing records remain valid.

## Risks

- Confusion when multiple shared agents share the same display name.
- Older clients that assume name uniqueness may render ambiguous lists.

Mitigation:

- Always render owner subtitle in shared list.
- Prefer device-id keyed routing in code paths.

## Verification

1. User A registers `CodeBot`.
2. User B registers `CodeBot`.
3. Both devices are listed and routable independently.
4. Sharing both to a third user shows two distinct entries with owner labels.
5. Existing per-device session paths still use `device_id` and remain stable.
6. Renaming a profile does not change its `device_id`.
7. Collision simulation produces bounded retry then deterministic failure.
