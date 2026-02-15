# Spec 06 - Ollama Support (Desktop + Agent Runtime)

Status: Draft
Priority: v1 P0

## Goal

Support Ollama as a first-class local model provider so users can run agents without a cloud model subscription.

For v1 this must be production-usable for:

- Local agent workflows.
- Shared-agent serving (an owner can run their shared agent on Ollama).
- Agent-to-agent loops where the local orchestrator agent uses Ollama.

## Why This Is In v1

- Removes major adoption friction (no paid model required).
- Enables offline/local experimentation.
- Improves growth loop for "try it now" agent experiences.

## Non-Goals

- Managing Ollama installation from desktop app.
- Building a custom inference server (desktop integrates with existing Ollama daemon).
- Guaranteeing identical output quality across local models.

## Provider Model

Add explicit provider selection in profile/runtime config:

- `provider = claude | ollama`
- `model = <provider-specific model id>`

Rules:

- Provider is per-profile.
- Runtime launch must use trusted profile config (not renderer overrides).
- Model validation is provider-aware.

## Ollama Connectivity Contract

Default endpoint:

- `OLLAMA_BASE_URL=http://localhost:11434`

Requirements:

- Health check endpoint before start/first request.
- Model list discovery via Ollama tags API (installed/downloaded models only).
- Clear user-facing error when Ollama is unreachable.

Security constraints:

- For v1, Ollama is **strictly local-only**.
- Allowed hosts: `localhost`, `127.0.0.1`, `::1` only.
- Any non-loopback Ollama URL must be rejected in main process (fail closed).

## Desktop UX Requirements

In profile create/edit:

- Provider selector (`Claude`, `Ollama`).
- When `Ollama` is selected:
  - Show discovered local models in dropdown from Ollama API response.
  - Provide refresh action.
  - Show "Ollama not running" guidance if health check fails.
- Preserve existing Claude model UX.

Model source of truth:

- Desktop reads installed models from Ollama (`/api/tags`) at runtime.
- Desktop does not maintain a separate model registry/catalog for Ollama in v1.
- If a model is not installed, it is not selectable until present in Ollama API results.

In settings:

- Optional `Ollama Base URL` input, but validation only permits loopback hosts.
- Diagnostic card: reachable, model count, last check timestamp.

Security rationale:

- Ollama mode is intended for users requiring maximum local-data control.
- Preventing remote Ollama endpoints avoids accidental prompt/context exfiltration to network hosts.

## Runtime Behavior

- Agent process receives provider/model via env/profile config.
- If provider is `ollama`, runtime routes generation calls through Ollama adapter.
- Permission profiles, MCP behavior, and audit logging remain provider-agnostic.
- Shared-session transport (gateway + E2EE) remains unchanged.

## Performance and Guardrails

- Default timeout for local generation requests (configurable).
- Concurrency limit for in-flight local generations per profile.
- Graceful handling for slow models (progress/status events when possible).
- Backpressure behavior documented when multiple sessions target one local Ollama-backed agent.

## Failure Modes

- Ollama unavailable at launch -> fail fast with actionable error.
- Model missing -> fail with model-not-found and offer reselect/refresh.
- Mid-session inference failure -> emit session error without crashing runtime.
- Timeout -> bounded retry policy (max 1 retry by default).

## Validation Matrix

1. Create profile with `provider=ollama`, select local model, start agent successfully.
2. Stop/restart Ollama and verify desktop/runtime errors are actionable.
3. Shared user can chat with an Ollama-backed agent over gateway relay.
4. Agent-to-agent flow works when local orchestrator uses Ollama model.
5. Claude-backed profiles continue to work (no regression).
6. Local-only mode functions without gateway sign-in.
7. Invalid/non-loopback Ollama URL is always blocked.

## Exit Criteria

- A new user with Ollama running locally can create and run a working agent in desktop without Claude credentials.
- Ollama-backed agents can participate in v1 shared-chat flows.
- Provider selection is stable across restarts and profile edits.
