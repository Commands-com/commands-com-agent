# Spec 08 - Agent Activity Indicator (Unseen Message Badge)

Status: Draft
Priority: v1.x P2

## Goal

Improve visibility when a local agent is actively chatting by showing a small sidebar activity badge with unseen message count.

## Problem

Today users may not notice that an agent has active conversation traffic unless they open that agent view directly.

## UX Requirements

In **My Agents** sidebar list:

- Show a subtle activity indicator (dot) when new unseen traffic exists.
- Show a compact numeric badge for unseen message count (`1..99+`).
- Badge appears on the same row as the agent entry.

Count semantics:

- Increment on incoming conversation event `session.message` for that agent profile.
- Do not increment when the user is already viewing that agent detail/chat panel.
- Reset count to zero when user opens that agent view.

Display rules:

- `0` -> no badge.
- `1..99` -> exact value.
- `>=100` -> `99+`.

## Data Model (Renderer State)

Add per-profile in-memory counters:

- `unseenMessageCountByProfileId: Map<string, number>`
- `seenEventKeys: Set<string>` for dedup, where key format is `${profileId}|${sessionId}|${messageId}`
- `seenEventQueue: string[]` for FIFO eviction of dedup keys

Dedup memory bound (normative):

- Dedup cache is capped at **500 entries**.
- On insert when full, evict oldest key from `seenEventQueue` and remove it from `seenEventKeys`.
- This cap is required to prevent unbounded renderer memory growth on long-running sessions.

Lifecycle:

- Initialize empty on app launch.
- Clear all counters on sign-out.
- Remove profile key on profile delete.

Persistence:

- No disk persistence in v1.x (ephemeral UI signal only).

## Event Source and Dependencies

Source events:

- `desktop:conversation-event` from main process.
- Increment only for normalized incoming message events (`event === 'session.message'`).

Dependency:

- Depends on profile-scoped conversation events from multi-agent runtime work (`spec-03`), so each event can be attributed to a specific `profileId`.

## Main/Renderer Contract

Conversation event payload must include:

```json
{
  "profileId": "profile_...",
  "event": "session.message",
  "sessionId": "sess_...",
  "messageId": "msg_..."
}
```

Renderer logic:

1. On event, resolve `profileId`.
2. Build dedup key `(profileId, sessionId, messageId)` and skip if already seen.
3. Record dedup key with FIFO eviction under the 500-entry cap.
4. If `profileId` is currently selected/visible, no increment.
5. Else increment unseen count for that profile and re-render sidebar row.

## Accessibility

- Badge must have sufficient color contrast in dark/light themes.
- Provide aria label on badge (example: "3 unseen messages").
- Do not rely on color alone; numeric badge is primary signal.

## Risks

- Over-counting if events are duplicated.
- Mis-attribution if profile scoping is missing.
- Unbounded dedup cache growth if event keys are never evicted.

Mitigations:

- Deduplicate by `(profileId, sessionId, messageId)` in renderer using required 500-entry FIFO-bounded cache.
- Gate feature rollout behind profile-scoped event payload readiness.

## Verification

1. Receive message on non-selected agent -> badge increments.
2. Receive message on selected agent -> badge does not increment.
3. Open agent with badge -> badge resets immediately.
4. Rapid multiple messages -> badge increments correctly and caps display at `99+`.
5. Sign-out clears all badges.
6. Profile delete removes badge state for that profile.
7. Dedup cache remains bounded at 500 entries with FIFO eviction under sustained traffic.
