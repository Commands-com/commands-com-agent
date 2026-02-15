# Spec 05 - Agent-to-Agent Communication via Shared Agents

Status: Draft
Priority: P1

## Goal

Allow a user to run a local agent as an orchestrator inside an existing chat session with a shared remote agent.

This is a proxy mode on top of the current shared-chat transport:

- Desktop keeps using existing gateway + E2EE session flow.
- Local and remote agent turns are orchestrated by desktop main process.
- User can watch, pause, intervene, and redirect at any time.

## Canonical User Flow

1. User opens chat with a shared agent (existing flow).
2. User enables `Use my agent` and selects one local agent.
3. User enters objective prompt (example: `review this API for security issues`).
4. Desktop asks local agent for an outbound message draft.
5. Desktop sends local agent output through existing E2EE relay to remote shared agent.
6. Remote agent response is received through existing E2EE relay.
7. Desktop forwards remote response back to local agent as context.
8. Loop continues until stop condition or user action.

## Architecture

### Orchestrator Placement

Orchestration loop runs in desktop **main process**.

- Renderer provides user controls and displays state.
- Main process owns session state, gateway I/O, and orchestration state.
- Renderer never receives tokens, keys, or ciphertext.

### Transport

No new relay crypto protocol is required.

- Reuse `session-manager` for shared agent E2EE sessions.
- Reuse current gateway relay send/receive APIs.
- Add orchestration state machine on top.

### Local Agent Interface

Desktop invokes local agent through existing local process bridge/IPC, with explicit context envelope per turn.

## Local Agent Invocation Mechanism (Normative)

Define a concrete request/response channel between desktop main process and each running local agent process.

Transport:

- Per-profile local IPC prompt channel over stdio NDJSON on the running agent process.
- Main process writes request frames to agent stdin.
- Agent emits response frames on stdout tagged for desktop bridge.
- Renderer never talks to this channel directly.

Frame contract:

Request (`desktop.local_prompt.request`):

```json
{
  "type": "desktop.local_prompt.request",
  "request_id": "req_01...",
  "profile_id": "profile_...",
  "session_id": "sess_...",
  "turn_index": 3,
  "mode": "manual|semi_auto|full_auto",
  "objective": "review this API for security issues",
  "remote_message": "latest remote agent response",
  "history": [
    { "role": "local_agent", "text": "..." },
    { "role": "remote_agent", "text": "..." }
  ],
  "constraints": {
    "max_output_chars": 12000,
    "allow_tool_use": true,
    "max_history_turns": 6,
    "max_history_chars": 24000,
    "max_tool_rounds": 3,
    "local_turn_timeout_ms": 120000
  }
}
```

Response (`desktop.local_prompt.response`):

```json
{
  "type": "desktop.local_prompt.response",
  "request_id": "req_01...",
  "status": "ok|error",
  "draft_message": "next outbound message to remote agent",
  "reason": "",
  "metrics": { "latency_ms": 842 }
}
```

Channel rules:

- Exactly one in-flight local prompt request per profile.
- Request timeout default 60s when tool use is disabled; up to 120s when `allow_tool_use=true`.
- Local agent may perform multiple internal tool calls, but must emit exactly one terminal response frame per request.
- Responses with unknown `request_id` are ignored and logged as protocol violations.
- If channel is unavailable (agent restarting/crashed), orchestration transitions to `error` and requires user action.

Main-process API boundary:

- Add internal bridge module (`local-agent-bridge`) used by orchestration manager.
- Renderer gets high-level orchestration events only, never raw bridge control frames.

History bounding and summarization:

- Orchestrator must enforce both `max_history_turns` and `max_history_chars` before sending each local prompt request.
- If history exceeds bounds, oldest turns are summarized into a compact `history_summary` field and raw old turns are dropped.
- Keep the most recent remote message verbatim as `remote_message`.

## Orchestration Modes

Per session mode selected in UI:

- `manual`: local draft generated, user approves before send.
- `semi_auto`: auto-send unless confidence/risk rule triggers review.
- `full_auto`: auto-send all turns until stop condition.

Default: `manual`.

## Stop Conditions and Safety Limits

Mandatory hard limits:

- `maxTurns` (default 8)
- `maxDurationMs` (default 10 minutes)
- `maxFailures` (default 3 consecutive failures)
- `maxTokensBudget` (optional per run)

User controls:

- `Pause`
- `Resume`
- `Stop`
- `Take over` (switch to manual human typing)

## State Machine (Session Overlay)

`idle -> planning -> waiting_local -> ready_to_send -> waiting_remote -> processing_remote -> completed | paused | error | stopped`

Rules:

- Single in-flight turn at a time per orchestrated session.
- Transition to `error` on transport or local-agent hard failure.
- `Pause` is immediate and prevents new sends.

## Policy Controls

Per local profile settings:

- `allowSharedAgentCalls: boolean`
- `allowedSharedDeviceIds: string[]`
- `maxConcurrentSharedCalls` (default 3)
- `maxHopCount` (default 2)

Default is deny until enabled.

## Loop and Abuse Prevention

Each forwarded message includes orchestration metadata (in control envelope, not user-visible prose):

- `origin_agent_device_id`
- `trace_id`
- `hop_count`
- `orchestrator_profile_id`

Enforcement:

- Reject if `hop_count > maxHopCount`.
- Reject self-loop (`origin == target`).
- Rate-limit per `(profileId, targetDeviceId)`.

## UX Requirements

In shared chat view:

- `Use my agent` toggle.
- Local-agent selector dropdown.
- Objective prompt input.
- Mode selector (`manual`, `semi_auto`, `full_auto`).
- Turn timeline with avatars (`Local Agent`, `Remote Agent`, optional `You`).
- Sticky run controls (`Pause`, `Resume`, `Stop`, `Take over`).

Presentation:

- User objective pinned at top.
- Clear labels for auto-sent vs user-approved turns.
- Explicit banner when limits are hit.

## Observability and Audit

Audit entries include:

- `profileId`
- target `sharedDeviceId`
- requester identity context
- turn index
- mode
- timing/status/failure reason

Redaction remains unchanged: no plaintext secrets, no tokens, no keys.

## Dependencies and Priority

Hard dependencies:

- Spec 02 requester identity enrichment
- Spec 03 multi-agent runtime

Soft dependency:

- Spec 04 share links (helpful for discovery, not required for core orchestration)

Priority guidance:

- This feature can ship **before share links** if "Shared With Me" inventory already exists.

## Verification

1. Start orchestrated session from shared chat with selected local agent.
2. Confirm loop: local draft -> remote send -> remote response -> local follow-up.
3. Confirm manual mode requires approval before each send.
4. Confirm full-auto runs until max-turn stop condition.
5. Confirm pause/resume/stop work without breaking E2EE session integrity.
6. Confirm policy blocks disallowed target.
7. Confirm loop-prevention blocks recursive chains.
8. Confirm audit/log entries are profile-scoped and redacted.
9. Kill local agent mid-run -> channel timeout/error path is surfaced and loop halts safely.
10. Oversized history is truncated/summarized deterministically and stays within configured bounds.
11. Tool-enabled runs respect `max_tool_rounds` and timeout constraints.
