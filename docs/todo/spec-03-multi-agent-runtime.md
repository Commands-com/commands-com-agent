# Spec 03 - Multi-Agent Runtime (Desktop)

Status: Draft
Priority: P1

## Goal

Allow multiple local agent profiles to run concurrently without config/token/log/session collisions.

## Isolation Model (Required First)

Use profile-scoped home directories:

- Path: `~/.commands-agent/profiles/<profileId>/agent-home`
- For each spawned agent process, set environment `HOME=<profileHome>`.
- Keep profile-level config, tokens, and identity isolated in that home.

This replaces the current implicit global-home assumption that causes collisions.

## Main Process Runtime Manager

Replace singletons in desktop main process with maps keyed by `profileId`:

- `agentProcess` -> `Map<profileId, ChildProcess>`
- `forceKillTimer` -> `Map<profileId, Timeout>`
- launch metadata -> `Map<profileId, LaunchState>`

### startAgent(profileId)

- Reject only when the same `profileId` is already running.
- Allow concurrent starts for different profiles.
- Record per-profile launch state and PID.

### stopAgent(profileId)

- Stop only the specified profile runtime.
- Backward compatibility: if no profileId and exactly one runtime exists, stop that one.

### Snapshot Contract

Keep current fields for compatibility and add:

```json
{
  "running": true,
  "pid": 12345,
  "launchConfig": {},
  "runningProfiles": [
    {
      "profileId": "p_1",
      "pid": 12345,
      "startedAt": "2026-02-14T17:00:00Z",
      "launchConfig": {}
    }
  ]
}
```

## Renderer State Changes

In `state.js`:

- Add/maintain `runningProfiles` state.
- `isProfileRunning(profileId)` checks that set.
- `isAnyAgentRunning()` returns `runningProfiles.length > 0`.
- `runningProfileId()` returns profile id only when exactly one exists (or first for legacy fallback).

## UI Changes

- Remove single-agent start gate in agent detail.
- Start button enabled when selected profile is not running.
- Stop button targets selected profile.
- Dashboard summary shows `N agents running`.

## Logs and Sessions

All emitted logs/events must carry `profileId`:

- main -> renderer log events include `profileId`.
- conversation events include `profileId`.
- renderer stores/filter by `profileId` to prevent cross-stream mixing.

## Credentials and Security

Generalize credential secure/restore helpers to profile base dir:

- Per profile home: `config.json` + `credentials.enc`
- Restore before start of that profile.
- Secure after stop of that profile.

Legacy global credential path remains fallback only.

## Build/Concurrency Safety

- Avoid concurrent build races from `start-agent.sh`.
- Use `BUILD_AGENT=0` when `dist` already exists.
- If build needed, perform one build before parallel spawns.
- Add small serialized operation queue for profile start/stop and migration operations.

## Resource Limits and Gateway Connection Caps

Define explicit limits so multi-agent runtime cannot overwhelm local machine or gateway.

Desktop runtime limits (defaults):

- `maxConcurrentLocalAgents = 5` (hard cap 20).
- `maxPendingStartOps = 10` queued start requests.
- `maxPendingStopOps = 20` queued stop requests.
- `agentStartTimeoutMs = 60_000` per profile start.
- `agentStopGraceMs = 10_000` then force kill.

Gateway connection budgeting:

- Each running local agent holds one gateway websocket connection.
- Gateway enforces owner connection cap (`maxAgentConnectionsPerOwner`, currently 50).
- Desktop should enforce a lower soft cap (default 45) to leave operational headroom.
- If gateway rejects connect with `429` / `too_many_agent_connections`, mark that profile start as failed with explicit UI error (no blind restart loop).

Shared-chat interaction limits (existing + required):

- Keep session-manager cap at 20 concurrent shared chat sessions.
- Reject new shared sessions with clear error when cap reached.
- Per-device send rate limit remains enforced in main process.

Operational visibility:

- Surface active local-agent count and cap in diagnostics/settings.
- Emit structured events for cap-hit failures (`local_limit`, `gateway_limit`).

## Desktop Quit / Reattach Policy

Desktop owns local agent process lifecycle in this spec.

- On normal app quit, desktop gracefully stops all running local agents.
- Shutdown sequence: stop request -> wait `agentStopGraceMs` -> force kill remaining.
- No background orphan mode in v1 (no keep-running-on-quit behavior by default).

Crash/unexpected-exit handling:

- On next launch, detect stale runtime markers/PIDs and clean them up.
- Do not assume automatic reattach to unknown orphan processes.
- If future keep-alive mode is added, it must ship with explicit process discovery + attach handshake.

## IPC Contract Updates

- `desktop:agent:stop` accepts `{ profileId, force }`.
- Keep old payload shape valid for rollout compatibility.

## Rollout Phases

### Phase A

- Multi-process runtime maps
- UI start/stop/status updates
- Basic profile-scoped log/session tagging

### Phase B

- Per-profile credential isolation
- Complete profile-scoped conversation/log filtering
- Legacy cleanup

## Verification Matrix

1. Start 2+ profiles concurrently.
2. Stop one profile; others continue running.
3. Logs and conversations remain profile-isolated.
4. Sign-in/sign-out flows still work.
5. Per-profile credential secure/restore works.
6. `npx tsc --noEmit` passes.
7. Manual E2E smoke passes.
8. Starting beyond local cap fails predictably with no partial launch.
9. Simulated gateway connection-cap rejection surfaces actionable error and does not loop.
10. App quit stops all running local agents within grace+force window.
