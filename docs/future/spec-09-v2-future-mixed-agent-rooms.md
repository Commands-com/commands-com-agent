# Spec 09 - V2 Future: Mixed-Agent Rooms + Coordinator Policies

Status: Future Draft
Priority: Post-v1 Exploration

## Vision

Run a single room with multiple specialists:

- Your local agents (for private/local context)
- Other people's shared agents (for external domain context)

Example room:

- Security expert agent
- DBA agent
- Your codebase agent

All participants collaborate on one objective (for example, a migration review plan) while humans watch in real time and can intervene.

## Why This Matters

- Agents bring non-overlapping context into one thread.
- Local and shared agents become one collaborative surface instead of separate chats.
- The feature is demo-strong and highly shareable.

## Non-Goals (for initial future iteration)

- Replacing 1:1 shared chat workflows.
- Perfect autonomous conversation quality on day one.
- Building a centralized hosted coordinator service.

## Core Architecture

Coordinator runs in desktop main process and treats all participants as a single abstraction:

```ts
type AgentEndpoint =
  | { kind: 'local-stdio'; profileId: string }
  | { kind: 'remote-relay'; deviceId: string; sessionId: string };
```

The coordinator is transport-agnostic:

- Local participants: stdio IPC bridge
- Remote participants: gateway relay sessions (existing encrypted transport)

The coordinator only decides:

1. Who speaks next
2. What context each participant receives
3. When the room pauses/stops/errors

## Context Strategy Per Turn

Each speaking agent gets:

1. Room objective and constraints
2. Full transcript since that agent's last turn
3. Compact room summary for older history
4. Optional role-specific hints/policy metadata

This mirrors real group chat behavior where a participant catches up on missed turns before responding.

## Coordinator Responsibilities

- Maintain participant state (`lastTurnIndex`, latency stats, failures, cooldowns)
- Request next-speaker recommendation from policy plugin
- Dispatch turn prompt to selected endpoint
- Apply limits (turn cap, duration cap, token budget, failure cap)
- Stream state to UI (thinking, speaking, paused, stopped, error)
- Handle explicit `decline` decisions by recording skipped rounds instead of forcing filler turns

## Policy Plugin System (Differentiator)

Policies decide who should speak next and when to skip a turn.

Minimal policy contract:

```ts
interface TurnPolicy {
  id: string;
  proposeNextSpeaker(input: PolicyInput): PolicyDecision;
}
```

`PolicyDecision` supports explicit no-op/decline:

```ts
type PolicyDecision =
  | { action: 'speak'; agentId: string; reason?: string }
  | { action: 'decline'; reason: string };
```

`decline` means "no agent should speak this round" because there is no high-value contribution.

Early built-in policies:

- Round-robin baseline
- Domain-mention gating ("speak only when your domain is referenced")
- Human-priority escalation (yield to user requests first)
- Silence-on-low-confidence

Built-in policies should prefer `decline` over low-signal filler responses.

Future: community-contributed policies with safety validation.

## Safety and Guardrails

- Hard room limits: `maxTurns`, `maxDurationMs`, `maxFailures`, optional budget
- Per-agent cooldown to avoid airtime monopolies
- Loop prevention via trace/hop metadata
- Immediate human override: `Pause`, `Take over`, `Stop`
- Fail closed on transport/auth/policy errors with actionable UI state

## UX Model

Room view includes:

- Participant roster (local/shared badges)
- Live timeline with speaker identity each turn
- Current/next speaker indicator
- Sticky controls (`Pause`, `Resume`, `Take over`, `Stop`)
- Policy selector + policy settings panel
- End-of-run transcript export

## Observability

Track per room and per participant:

- Turns spoken
- Average response latency
- Skipped-turn reasons
- Policy decisions (why next speaker was chosen)
- Error counts and stop reasons

These are required for tuning policies and improving room quality.

## Proposed Delivery Phases

### Phase 1 (Foundational Future)

- Mixed room with 3-5 participants
- Built-in round-robin policy + one domain-aware policy
- Since-last-turn context windowing
- Manual controls and hard safety limits
- Policy `decline` path with skipped-round telemetry in UI/logs

### Phase 2

- Pluggable policy runtime
- Policy simulation/replay mode on saved transcripts
- Community policy pack format and validation rules

## Open Questions

1. How much context is optimal per participant turn for small local models?
2. Should policy plugins be deterministic by default for reproducible demos?
3. What moderation model is needed when shared/public agents are mixed in a room?
4. How should cost/latency budgets be surfaced when cloud and local agents are mixed?

## Relationship to v1

This is intentionally **post-v1**.

v1 should ship and gather usage data from:

- Shared agent chat
- Agent-to-agent (spec-05)
- Ollama support (spec-06)

Real user behavior from v1 should drive which room policies become default in v2.
