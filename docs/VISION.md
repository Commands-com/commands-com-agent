# Commands.com Desktop — Product Vision & Rebuild Specification

## Executive Summary

The Commands.com Desktop app has moved from a setup wizard toward an **agent network client** — a persistent hub where users manage their own AI agents, connect to agents shared by others, and orchestrate agent-to-agent conversations. The app is becoming the primary interface for the Commands.com ecosystem, while the web UI remains the zero-friction entry point for new and casual users.

The viral feature: **watch two AI agents talk to each other.** Users give each agent a persona, point them at each other, and observe the conversation unfold in real time. This transforms Commands.com from "infrastructure for developers" into "something anyone wants to try."

---

## Current State (Feb 2026 Snapshot)

### What exists today

The desktop app now runs as a **hub UI** (not a wizard-first experience) with shipped support for:

1. **My Agents** management (profiles, start/stop, logs, audit trail, settings).
2. **Shared With Me** sidebar and chat view.
3. **Gateway OAuth sign-in** in system browser (PKCE + localhost callback), managed in main process.
4. **Gateway REST + SSE integration** for device discovery, status updates, session events.
5. **E2E shared chat sessions** (X25519 ECDH + HKDF + AES-256-GCM) in main process.
6. **Renderer hardening**: sandbox enabled, strict context isolation, renderer CSP, sanitized markdown pipeline, safe external URL allowlist.

### Current architecture

```
desktop/
├── main.js              # Electron main process (agent lifecycle, IPC, gateway wiring, policy checks)
├── preload.js           # Strict IPC bridge (no token/key exposure)
├── auth.js              # Gateway OAuth + refresh + secure local token storage
├── gateway-client.js    # REST/SSE client (origin allowlist, retry, dedup, resume)
├── crypto.js            # E2E crypto helpers
├── session-manager.js   # Handshake/session state machine + encrypted messaging
└── renderer/
    ├── app.js
    ├── state.js
    ├── components/sidebar.js
    ├── views/agent-detail.js
    ├── views/agent-chat.js
    ├── views/agent-create.js
    └── styles/*
```

Storage and runtime facts:

- Profiles/settings live on disk under `~/.commands-agent/*`.
- Desktop auth state is encrypted at rest via Electron `safeStorage`.
- Gateway auth/network/crypto operations run in **main process only**.
- Renderer receives plaintext event payloads and action results only.

### Current gaps (active roadmap items)

1. Agent naming is still effectively global in some flows (no owner-scoped namespacing yet).
2. Live conversations and audit still show requester UID in many views (email/display enrichment pending).
3. Desktop runtime is still single-local-agent (`agentProcess` singleton).
4. Share link creation/consumption is not fully integrated in desktop UI.
5. Agent-to-agent orchestration loop is not shipped yet.

---

## Target State (v1.0)

### Product model

The app is a **persistent agent hub** — always running, always connected. Users see their agents, see who's talking to them, chat with other people's agents, and delegate conversations to their own agents.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Commands.com Desktop                                    ─ □ ✕     │
├──────────────────┬──────────────────────────────────────────────────┤
│                  │                                                  │
│  MY AGENTS       │         Chat / Agent Detail View                │
│  ┌────────────┐  │                                                  │
│  │ 🟢 CodeBot │💬│  Messages render in real time as remote users   │
│  │    Agent 1  │  │  interact with your agent. Markdown supports    │
│  └────────────┘  │  code blocks + safe links; external media blocked │
│  ┌────────────┐  │                                                  │
│  │ ⚫ Helper  │  │  ┌─────────────────────────────────────────┐    │
│  │    Agent 2  │  │  │ Sarah (remote user):                    │    │
│  └────────────┘  │  │ "Can you explain the auth flow?"        │    │
│                  │  ├─────────────────────────────────────────┤    │
│  + Create Agent  │  │ CodeBot (your agent):                    │    │
│                  │  │ "The auth flow uses OAuth 2.0 with..."  │    │
│  ──────────────  │  └─────────────────────────────────────────┘    │
│                  │                                                  │
│  SHARED WITH ME  │  ┌──────────────────────────────────────────┐   │
│  ┌────────────┐  │  │ Type a message...          [Send] [🤖]  │   │
│  │ 🟢 Alice's │  │  └──────────────────────────────────────────┘   │
│  │   DevAgent  │  │                                                  │
│  └────────────┘  │                                                  │
│  ┌────────────┐  │                                                  │
│  │ ⚫ Bob's   │  │                                                  │
│  │   Support   │  │                                                  │
│  └────────────┘  │                                                  │
│                  │                                                  │
└──────────────────┴──────────────────────────────────────────────────┘
```

---

## Feature Specifications

### 1. Hub Layout (Main Interface)

The wizard is replaced as the primary view by a persistent hub layout.

#### Sidebar (left panel, ~280px)

Two sections, each scrollable independently:

**MY AGENTS**
- List of agent profiles the user has created
- Each entry shows:
  - Agent avatar/icon (custom image or generated)
  - Agent name
  - Online/offline status indicator (green dot = running, gray = stopped)
  - Active conversation badge (💬 speech bubble) when someone is currently chatting
  - Active session count (e.g., "2 active" if multiple remote users connected)
- Click an agent → main panel shows that agent's detail/chat view
- Right-click context menu: Start, Stop, Edit, Duplicate, Delete
- **"+ Create Agent"** button at bottom → opens agent creation flow

**SHARED WITH ME**
- List of agents other people have shared with this user
- Each entry shows:
  - Agent avatar/icon (provided by the agent owner)
  - Agent name
  - Owner name or email (subtle, below agent name)
  - Online/offline status (green = agent is running and reachable)
- Click an agent → main panel shows chat interface for that agent
- Entries auto-populate from gateway device discovery (`GET /gateway/v1/devices`, shared/granted entries) and device status SSE events

**Sidebar footer**
- User avatar + email (from desktop gateway auth session)
- Settings gear icon
- Connection status indicator (connected to gateway / offline)

#### Main Panel (right, fills remaining space)

Content changes based on sidebar selection:

- **No selection (default)**: Welcome/dashboard view — quick stats, recent activity
- **My Agent selected**: Agent detail view with live conversation feed
- **Shared Agent selected**: Chat interface to talk with that agent

#### Topbar

- Commands.com logo + "Desktop" label (no "Setup Wizard" tagline)
- Search bar (search across agents, conversations)
- Notification bell (new shares, agent errors, subscription status)
- Window controls (minimize, maximize, close)

### 2. Agent Profiles (Redesigned)

Agent profiles evolve from infrastructure configuration into **agent identities** — characters with personality, knowledge, and visual presence.

#### Profile fields

| Field | Type | Description |
|-------|------|-------------|
| **Name** | Text | Display name shown everywhere (e.g., "CodeBot", "Sarah's Helper") |
| **Avatar** | Image | Custom image upload (PNG/JPG, cropped to circle). Falls back to generated avatar from initials. Stored locally in `~/.commands-agent/profiles/<id>/avatar.png` |
| **System Prompt** | Multiline text | The agent's core instructions, personality, and behavioral guidelines. This is the system prompt passed to Claude. Supports markdown. |
| **Workspace / Knowledge Path** | Directory | Root directory the agent operates in. Tooltip (?): "Point this at a codebase, a folder of markdown documents, images, or any mix. The agent reads and understands whatever's here — code, docs, backstory, reference material." |
| **Model** | Dropdown | **Claude**: `opus` (max quality), `sonnet` (balanced), `haiku` (fast) — requires Claude Code subscription. **Ollama**: any locally-running model (llama3, mistral, codellama, etc.) — completely free, no account needed. |
| **Permissions** | Dropdown | `read-only`, `dev-safe`, `full` |
| **MCP Servers** | Config (see §3) | Which MCP servers this agent has access to |
| **Device Name** | Text (auto-generated) | Slugified from name, used as device ID prefix. Editable for advanced users. |

#### System Prompt

The system prompt is the most important new field. It defines the agent's character and behavior:

```
You are CodeBot, a senior software engineer who specializes in TypeScript
and React applications. You are helpful, concise, and always explain your
reasoning. When reviewing code, you focus on correctness first, then
performance, then style.

You have access to the codebase at /Users/dan/Code/my-app. When asked
about the project, reference actual files and code.

You should never reveal API keys, environment variables, or credentials
that appear in config files.
```

The system prompt editor should be a **full-width textarea** with:
- Monospace font
- Line numbers (optional)
- Character count
- Markdown preview toggle
- Template suggestions (collapsible): "Code reviewer", "Support agent", "Creative writer", etc.

#### Workspace as identity

The workspace path is intentionally flexible. It can be:

- **A codebase**: `/Users/dan/Code/my-app` — the agent understands the code and can answer questions about it
- **A character folder**: `/Users/dan/agents/sarah/` — full of markdown files describing Sarah's backstory, personality, preferences, and images from her life
- **A knowledge base**: `/Users/dan/docs/support/` — runbooks, API specs, FAQs
- **A mix**: a codebase with a `docs/` folder containing context about the team, conventions, and project history

The agent reads and indexes whatever's in the directory. No need to separate "code" from "knowledge" — it's all context.

Example character workspace:
```
/Users/dan/agents/sarah/
├── backstory.md        # "I'm a senior engineer at Acme Corp..."
├── preferences.md      # "I prefer functional programming..."
├── speaking-style.md   # "I'm direct but friendly, I use analogies..."
├── team-context.md     # "The team uses React, TypeScript, and PostgreSQL..."
└── images/
    └── architecture.png  # Diagrams the agent can reference
```

Example professional workspace:
```
/Users/dan/Code/my-app/
├── src/                # Codebase — agent can read and explain
├── docs/               # Project docs — agent uses as context
├── CLAUDE.md           # Agent instructions (already supported)
└── README.md           # Project overview
```

#### Profile storage

Profiles are stored on disk (not localStorage) for persistence and portability:

```
~/.commands-agent/profiles/
├── profiles.json           # Index of all profiles
├── codebot-abc123/
│   ├── profile.json        # Profile metadata + system prompt
│   └── avatar.png          # Custom avatar image
└── helper-def456/
    ├── profile.json
    └── avatar.png
```

`profiles.json` (index):
```json
{
  "version": 1,
  "profiles": [
    {
      "id": "codebot-abc123",
      "name": "CodeBot",
      "createdAt": "2025-01-15T10:00:00Z",
      "updatedAt": "2025-01-20T14:30:00Z"
    }
  ],
  "activeProfileId": "codebot-abc123"
}
```

`profile.json` (per profile):
```json
{
  "id": "codebot-abc123",
  "version": 1,
  "name": "CodeBot",
  "deviceName": "codebot",
  "systemPrompt": "You are CodeBot, a senior software engineer...",
  "workspace": "/Users/dan/Code/my-app",
  "model": "sonnet",
  "permissions": "dev-safe",
  "mcpServers": {},
  "avatarPath": "avatar.png",
  "createdAt": "2025-01-15T10:00:00Z",
  "updatedAt": "2025-01-20T14:30:00Z"
}
```

Agent install location is a **global desktop setting**, not a per-profile field.

### 3. MCP Servers (Custom JSON Support)

#### Current limitation

5 hardcoded MCP modules with toggle switches. Users can only choose from the catalog.

#### New design

Two paths to add MCP servers:

**Quick-start templates** (the existing 5, plus more over time):
- Filesystem, GitHub, Postgres, Playwright, Slack
- One-click enable with sensible defaults
- Expandable config fields for customization

**Custom MCP (JSON editor)**:
- A "Custom MCP" option that opens a JSON editor
- Users paste the MCP server configuration JSON in Claude Desktop format:

```json
{
  "my-custom-mcp": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": {
      "BRAVE_API_KEY": "your-key-here"
    }
  }
}
```

- The editor validates the JSON structure before saving
- Supports all MCP transport types: `stdio`, `sse`, `http`
- Each custom MCP entry shows in the MCP list like a template entry
- Users can name their custom MCPs for easy identification

**MCP configuration per profile**: Each agent profile has its own MCP configuration, so different agents can use different tools.

#### UI

```
┌─────────────────────────────────────────────────┐
│ MCP Servers                                      │
├─────────────────────────────────────────────────┤
│                                                   │
│  ✅ Filesystem MCP          [Configure]          │
│     Local project file access                    │
│                                                   │
│  ☐  GitHub MCP              [Configure]          │
│     PR context and code review                   │
│                                                   │
│  ☐  Postgres MCP            [Configure]          │
│     Read-only SQL diagnostics                    │
│                                                   │
│  ✅ brave-search (custom)   [Edit] [Remove]      │
│     npx @modelcontextprotocol/server-brave...    │
│                                                   │
│  [+ Add Template MCP]  [+ Add Custom MCP JSON]   │
│                                                   │
└─────────────────────────────────────────────────┘
```

### 4. Agent Creation Flow

The wizard transforms from the primary UI into a **secondary flow** triggered by "+ Create Agent."

#### Flow

1. **Name & Avatar** — Name the agent, optionally upload an avatar image
2. **System Prompt** — Write or select from templates. This is the most important step and gets the most screen space.
3. **Workspace / Knowledge Path** — Pick the directory the agent will work in. Tooltip explains this can be a codebase, a folder of docs/backstory, or any mix.
4. **Model & Permissions** — Quick selection (defaults: sonnet, dev-safe)
5. **MCP Servers** (optional) — Enable templates or add custom JSON
6. **Review & Create** — Summary, then create

The flow should feel lightweight — a **slide-out panel** or **modal dialog** rather than a full-screen wizard. Users should be able to create a basic agent (name + workspace + model) in under 30 seconds. Advanced configuration (system prompt, knowledge files, MCP) is available but not required.

#### Agent templates

Pre-built templates for common use cases:

| Template | System Prompt Focus | Default Permissions | Default MCPs |
|----------|-------------------|-------------------|-------------|
| **Code Reviewer** | Reviews code for bugs, style, and correctness | read-only | Filesystem, GitHub |
| **Project Assistant** | Answers questions about a codebase | read-only | Filesystem |
| **Dev Agent** | Full development capabilities | dev-safe | Filesystem, GitHub |
| **Support Agent** | Answers questions from a knowledge base | read-only | Filesystem |
| **Creative Writer** | Writes with a specific voice and style | read-only | None |
| **Custom** | Empty prompt, configure everything | dev-safe | None |

### 5. My Agent — Detail & Live Conversation View

When the user clicks one of their own agents in the sidebar, the main panel shows:

#### Agent header

```
┌─────────────────────────────────────────────────────────────────┐
│  [Avatar]  CodeBot                              [Edit] [⚙️]    │
│            sonnet · dev-safe · /Users/dan/Code/my-app           │
│            🟢 Running · 2 active sessions                       │
│            [Start] [Stop] [Restart]                             │
└─────────────────────────────────────────────────────────────────┘
```

- Avatar, name, model, permissions, workspace path
- Status (running/stopped) with start/stop/restart controls
- Active session count
- Edit button → opens profile editor
- Settings gear → advanced config (gateway URL, audit log, etc.)

#### Live conversation feed

Below the header, a **real-time conversation feed** showing all active conversations with this agent:

```
┌─────────────────────────────────────────────────────────────────┐
│  Session: sarah@example.com · Started 5m ago                    │
│  ─────────────────────────────────────────────────────────────  │
│                                                                  │
│  Sarah: Can you explain the authentication flow?                │
│                                                                  │
│  CodeBot: The authentication flow uses OAuth 2.0 with PKCE.    │
│  Here's how it works:                                            │
│                                                                  │
│  1. The client initiates...                                      │
│  ```typescript                                                   │
│  const authUrl = buildAuthUrl({                                  │
│    clientId: config.clientId,                                    │
│    redirectUri: config.redirectUri,                               │
│    codeChallenge: pkce.challenge                                 │
│  });                                                             │
│  ```                                                             │
│                                                                  │
│  Sarah: What about refresh tokens?                               │
│                                                                  │
│  CodeBot: (typing...)                                            │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  Session: mike@example.com · Started 12m ago                    │
│  ─────────────────────────────────────────────────────────────  │
│  Mike: How do I add a new API endpoint?                         │
│  CodeBot: To add a new endpoint, create a handler in...         │
└─────────────────────────────────────────────────────────────────┘
```

**Key behaviors:**
- Messages stream in real time via SSE from the gateway
- Multiple active sessions shown as separate collapsible sections
- Full markdown rendering: code blocks with syntax highlighting, images, lists, tables
- The agent owner can **read but not type** in these conversations — they are observing
- Scroll-to-bottom auto-follows new messages (with "jump to latest" button if scrolled up)
- Conversations are E2E encrypted; the desktop app receives decrypted messages from the agent process via local IPC (see §5 E2E encryption section)

#### Tabbed sub-views

Below the agent header, the detail view has tabs:

```
[ Live Conversations ]  [ Audit Trail ]  [ Settings ]
```

**Live Conversations** (default tab): The real-time conversation feed described above — active sessions with streaming messages, plus recent past conversations grouped by date.

**Audit Trail**: Full audit history for this agent, carrying forward the existing audit trail functionality with all its filtering power.

```
┌─────────────────────────────────────────────────────────────────┐
│  Audit Trail — CodeBot                                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Search: [________________]  Requester: [All ▾]                 │
│  Event type: [All ▾]  Session: [________________]              │
│  From: [__________]  To: [__________]  Limit: [200]            │
│  [ ] Messages only                                               │
│                                                                  │
│  [Refresh]  [Clear Filters]  [Export]                           │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 2025-01-20 14:32:01 · session.message                      │ │
│  │ Requester: sarah@example.com · Session: abc-123             │ │
│  │ "Can you explain the authentication flow?"                  │ │
│  │ [▶ Show full details]                                       │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ 2025-01-20 14:31:45 · session.created                      │ │
│  │ Requester: sarah@example.com · Session: abc-123             │ │
│  │ [▶ Show full details]                                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

Features (carried forward from current wizard Step 5):
- Full-text search across all audit entries
- Filter by: requester UID, session ID, event type, date range
- Adjustable result limit (1–2000 entries)
- "Messages only" toggle for quick conversation review
- Expandable raw JSON details per entry
- Copy prompt button for individual entries
- Export filtered results as JSON
- Requester UID dropdown auto-populated from log data

**Settings** tab: Agent-specific configuration — gateway URL, audit log path, advanced runtime options. Replaces the per-agent parts of the old wizard Step 3.

#### E2E encryption & owner monitoring

**Protocol decision: local plaintext observability, not protocol-level participation.**

The desktop app does NOT participate in the E2E key exchange or attempt to derive session keys independently. Instead, the agent process — which already decrypts every message to process it — exposes decrypted conversation data to the desktop app via a local channel.

How it works:
1. Agent receives an encrypted message from the relay
2. Agent decrypts it (as it already does to generate a response)
3. Agent writes the decrypted message to a **local IPC channel** (or structured log) that the desktop app reads
4. Desktop app renders the plaintext in the live conversation view

This is architecturally clean:
- The desktop app never touches encryption keys or ciphertext
- The E2E protocol remains unchanged — no new participants in the key flow
- The agent is already the trust boundary — the owner controls the machine the agent runs on
- Implementation options: Unix domain socket, named pipe, IPC via Electron main process, or structured event stream to a local file (similar to existing audit log)

**Important**: This means owner monitoring only works while the agent is running locally. If the agent is stopped, you see conversation history from the audit trail, not live messages.

### 6. Shared Agents — Chat Interface

When the user clicks an agent in the "SHARED WITH ME" section, the main panel shows a **chat interface** for direct conversation:

#### Chat view

```
┌─────────────────────────────────────────────────────────────────┐
│  [Avatar]  Alice's DevAgent                    🟢 Online        │
│            Shared by alice@example.com                           │
│            Permissions: read-only                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  You: What framework does this project use?                     │
│                                                                  │
│  Alice's DevAgent: This project uses Next.js 14 with the       │
│  App Router. The main technologies are:                          │
│  - **Frontend**: React 18, TypeScript, Tailwind CSS             │
│  - **Backend**: Next.js API routes + Prisma ORM                 │
│  - **Database**: PostgreSQL                                      │
│                                                                  │
│  You: Show me the database schema                               │
│                                                                  │
│  Alice's DevAgent:                                               │
│  ```prisma                                                       │
│  model User {                                                    │
│    id        String   @id @default(cuid())                      │
│    email     String   @unique                                    │
│    name      String?                                             │
│    posts     Post[]                                              │
│    createdAt DateTime @default(now())                            │
│  }                                                               │
│  ```                                                             │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Type a message...                              ] [Send] [🤖]  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key features:**
- Full markdown rendering with syntax-highlighted code blocks
- Message input with send button
- Agent avatar and status displayed prominently
- Connection status (online/offline/reconnecting)
- Message history persisted locally (encrypted at rest)
- E2E encryption — messages encrypted before leaving the app, decrypted on arrival

#### The 🤖 Button — Delegate to Your Agent

Next to the Send button, a **robot icon button (🤖)** activates agent-to-agent mode. This is the core differentiating feature.

### 7. Agent-to-Agent Conversations

#### Activation flow

1. User is in a chat with a shared agent (e.g., "Alice's DevAgent")
2. User clicks the **🤖 button** in the message input area
3. A **delegation panel** slides up above the message input:

```
┌─────────────────────────────────────────────────────────────────┐
│  🤖 DELEGATE TO YOUR AGENT                                      │
│                                                                  │
│  Select agent:  [CodeBot ▾]                                     │
│                                                                  │
│  Instructions for your agent:                                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Find out what authentication method they use, whether      │  │
│  │ they have rate limiting, and what their API versioning     │  │
│  │ strategy is. Be thorough but concise.                      │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Max turns: [10 ▾]     Auto-stop on: [completion ▾]            │
│                                                                  │
│  [Start Conversation]                          [Cancel]          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Delegation panel fields:**

| Field | Description |
|-------|-------------|
| **Select Agent** | Dropdown of user's own agents (must be running) |
| **Instructions** | System prompt/context for this specific delegation. Tells your agent what to ask, what to look for, what tone to use. |
| **Max Turns** | Safety limit: 5, 10, 25, 50, unlimited. Prevents runaway conversations. |
| **Auto-stop** | When to stop: "On completion" (agent decides it's done), "After max turns", "Manual only" |

#### During agent-to-agent conversation

Once started, the chat view changes to show the automated conversation:

```
┌─────────────────────────────────────────────────────────────────┐
│  [Avatar]  Alice's DevAgent                    🟢 Online        │
│            Shared by alice@example.com                           │
├──────────────────────────────────────────────────────────────── │
│  🤖 AUTO MODE — CodeBot is conversing on your behalf            │
│  Turn 3/10 · [Pause] [Stop] [Edit Instructions]                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CodeBot 🤖: What authentication method does your               │
│  application use?                                                │
│                                                                  │
│  Alice's DevAgent: We use JWT-based authentication with         │
│  refresh token rotation. The flow is:                            │
│  1. User logs in with email/password or OAuth                   │
│  2. Server issues access token (15min) + refresh token (7d)     │
│  3. Client stores refresh token in httpOnly cookie              │
│                                                                  │
│  CodeBot 🤖: Good. Do you have rate limiting in place?          │
│  If so, what are the limits per endpoint?                       │
│                                                                  │
│  Alice's DevAgent: Yes, we use a token bucket algorithm:        │
│  - Public endpoints: 100 req/min per IP                         │
│  - Authenticated endpoints: 1000 req/min per user               │
│  - File upload: 10 req/min per user                             │
│                                                                  │
│  CodeBot 🤖: What about API versioning?                        │
│                                                                  │
│  Alice's DevAgent: (typing...)                                   │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  🤖 Agent is conversing...                                      │
│  [Type to intervene...]                          [Send] [Stop]  │
└─────────────────────────────────────────────────────────────────┘
```

**Key behaviors during auto mode:**

- **Status bar** at top shows: auto mode active, which agent is delegated, turn count, controls
- **Your agent's messages** are visually distinct — marked with a 🤖 badge and slightly different background color
- **Pause button** — immediately stops your agent from sending the next message. You can review, then resume or take over manually.
- **Stop button** — ends auto mode entirely. You can continue the conversation manually.
- **Edit Instructions** — opens the instruction panel to refine what your agent should focus on. Your agent uses the updated instructions for subsequent turns.
- **Manual intervention** — at any time, you can type a message in the input box. This sends as YOU (not your agent), temporarily overriding auto mode. After your message, your agent resumes if auto mode is still active.
- **Turn counter** — shows progress toward max turns. When limit is reached, auto mode stops and control returns to the user.

#### How it works technically

The delegating user's desktop app orchestrates the conversation:

1. User starts delegation → desktop app sends the first message (from the user's agent) to the shared agent via the gateway relay
2. The shared agent responds → response arrives via SSE
3. Desktop app feeds the response + delegation instructions to the user's local agent (running on their machine)
4. User's local agent generates a reply → desktop app sends it through the relay
5. Loop continues until: max turns reached, auto-stop condition met, or user manually stops

```
User's Machine                   Gateway Relay              Agent Owner's Machine
┌──────────────────┐            ┌──────────┐              ┌──────────────────┐
│ Desktop App      │            │          │              │                  │
│ ┌──────────────┐ │            │          │              │                  │
│ │ User's Agent │ │◄─prompt──┐ │          │              │                  │
│ │ (CodeBot)    │─┤          │ │          │              │                  │
│ └──────────────┘ │          │ │          │              │                  │
│                  │          │ │          │              │                  │
│ Orchestrator:    │          │ │          │              │                  │
│ 1. Send msg ─────┼──E2EE───┼►│  Relay   │──E2EE──────►│ Shared Agent     │
│ 2. Receive resp ◄┼──E2EE───┼─│          │◄─E2EE───────│ (Alice's Dev)    │
│ 3. Feed to agent─┘          │ │          │              │                  │
│ 4. Repeat                   │ │          │              │                  │
└──────────────────┘            └──────────┘              └──────────────────┘
```

The gateway relay is unaware that one side is automated — it sees the same encrypted messages regardless of whether a human or agent is sending them. No relay changes needed.

### 8. Chat Interface — Rendering & UX

All chat interfaces (both "my agent" monitoring and "shared agent" conversations) share a common chat renderer.

#### Markdown rendering

Messages render as rich markdown:

- **Code blocks** with syntax highlighting (language detection)
- **Inline code** with monospace background
- **Headers, lists, tables** — full GFM support
- **Images** — inline display (from agent responses that reference accessible images)
- **Links** — clickable, open in system browser
- **Math** — LaTeX rendering (optional, if agents produce mathematical content)

#### Message bubbles

- **Remote user / You**: Right-aligned, brand-colored background
- **Agent**: Left-aligned, subtle panel background
- **Your agent (delegated)**: Left-aligned, brand-colored border + 🤖 badge
- **System messages**: Centered, muted text (e.g., "Session started", "Agent stopped")

#### Typing indicator

When the agent is processing a response:
- Animated dots ("...") in a message bubble
- For streaming responses: characters appear in real time as they're generated

#### Input area

```
┌─────────────────────────────────────────────────────────────────┐
│  [📎]  Type a message...                         [Send] [🤖]   │
└─────────────────────────────────────────────────────────────────┘
```

- Multiline input (grows vertically up to ~4 lines, then scrolls)
- Enter to send, Shift+Enter for newline
- 📎 attachment button (optional future: send files to agent)
- 🤖 delegate button (only shown when chatting with shared agents)
- Send button (or Enter)
- Markdown preview toggle (optional)

### 9. Agent Status & Notifications

#### Sidebar indicators

| Icon | Meaning |
|------|---------|
| 🟢 | Agent is running and connected to gateway |
| 🟡 | Agent is running but gateway connection lost (reconnecting) |
| ⚫ | Agent is stopped |
| 🔴 | Agent crashed or has an error |
| 💬 | Someone is actively chatting with this agent (speech bubble overlay) |

#### System tray (future)

- Tray icon with notification badge
- Quick menu: list agents, start/stop, open app
- Native OS notifications for: new chat session started, agent error, agent stopped unexpectedly

#### In-app notifications

- Toast notifications for transient events (agent started, message sent, etc.)
- Notification center (bell icon) for persistent events (new share received, subscription change)

### 10. Ollama Support (Free Tier)

Ollama is critical to adoption. It removes every barrier to entry:

- **No Claude subscription needed** — run any open-source model locally
- **No API keys** — Ollama runs on `localhost:11434`, no auth required
- **No account needed** — a user can download Commands.com Desktop + Ollama and start agent-to-agent conversations without signing up for anything
- **Completely free** — no metered usage, no credits, no limits

#### How it works

Ollama exposes a local API compatible with the OpenAI chat completions format. The agent runtime calls `http://localhost:11434/api/chat` instead of the Claude API.

#### Model selection in profile

When creating or editing an agent profile, the model dropdown detects whether Ollama is running locally:

```
┌─────────────────────────────────────────────────┐
│  Model                                           │
│  ┌─────────────────────────────────────────────┐ │
│  │ ── Claude (requires subscription) ──        │ │
│  │   Opus (max quality)                        │ │
│  │   Sonnet (balanced)                         │ │
│  │   Haiku (fast)                              │ │
│  │                                             │ │
│  │ ── Ollama (free, local) ──                  │ │
│  │   llama3.1:8b                               │ │
│  │   codellama:13b                             │ │
│  │   mistral:7b                                │ │
│  │   [+ Pull new model...]                     │ │
│  └─────────────────────────────────────────────┘ │
│                                                   │
│  ⓘ Ollama detected at localhost:11434            │
│    3 models available                             │
└─────────────────────────────────────────────────┘
```

- If Ollama is not running: show "Install Ollama" link + brief instructions
- If Ollama is running: auto-detect available models via `GET /api/tags`
- "Pull new model" opens a dialog to pull models by name (e.g., `llama3.1:70b`)

#### Viral implications

The zero-cost path to agent-to-agent:

1. User sees a fun agent-to-agent conversation on social media
2. Downloads Commands.com Desktop (free)
3. Downloads Ollama (free) + pulls a model (`ollama pull llama3.1`)
4. Creates two agents with different personas
5. Points them at each other and watches

No credit card. No API key. No sign-up. This is how you get millions of users before monetization matters.

#### Two products, one app

**Ollama** and **Claude** aren't just different quality tiers — they serve different use cases:

| | Ollama (free) | Claude (subscription) |
|---|---|---|
| **Use case** | Fun, social, creative | Professional, business, technical |
| **Example** | Two persona agents debating philosophy | Coworker asks questions about your local codebase |
| **Strength** | Zero barrier, viral, entertaining | Deep reasoning, accurate code understanding, long context |
| **Why it works** | Good enough for conversation and roleplay | Required for real work — Ollama can't reliably reason through a complex codebase |

The viral loop: Ollama gets millions of users through fun agent-to-agent conversations. A percentage of those users realize they can use the same app to share their codebase with a teammate — but that requires Claude. That's the conversion.

The product works as a free toy (Ollama) and as a professional tool (Claude) in the same app. The user never has to switch products.

### 11. Authentication

#### Two principals, two tokens

The system maintains separate principals for blast-radius control:

| Principal | Token | Scope | Used by |
|-----------|-------|-------|---------|
| **Desktop user principal** | Gateway OAuth access/refresh tokens | Desktop control-plane and shared-chat client calls | Desktop main process |
| **Agent device principal** | Device JWT | Agent relay connection, device lifecycle, runtime frames | Agent process |

If a device token is compromised, impact is scoped to that device runtime. Desktop user token handling remains isolated in desktop main process.

#### Current desktop auth flow (implemented)

Desktop uses gateway OAuth 2.0 with PKCE:

1. Start localhost callback server on random port.
2. Open system browser to `{gatewayUrl}/oauth/authorize`.
3. User authenticates in browser (Google/Firebase handled by gateway).
4. Gateway redirects to `http://localhost:{port}/callback?code=...&state=...`.
5. Desktop exchanges code at `{gatewayUrl}/oauth/token`.
6. Desktop stores refresh token securely (encrypted at rest), keeps access token in memory with refresh singleflight.

No Firebase JS SDK is loaded in the desktop renderer. No embedded auth BrowserWindow flow is required.

#### Token handling in Electron

**Critical**: The renderer process NEVER sees raw tokens, auth headers, or credentials.

All authenticated network requests are performed by the **main process**. The renderer requests actions; the main process executes them with proper auth.

```
Renderer                    Main Process                    External API
   │                            │                                │
   │── gateway:fetchDevices() ─►│                                │
   │                            │── read token from safeStorage  │
   │                            │── decrypt + validate           │
   │                            │── GET /gateway/v1/devices ────►│
   │                            │◄── response ──────────────────│
   │◄── { devices: [...] } ────│                                │
   │                            │                                │
```

- Renderer calls action-specific IPC methods (e.g., `commandsDesktop.gateway.fetchDevices()`, `commandsDesktop.gateway.sendMessage()`)
- Main process attaches auth headers, makes the HTTP call, returns only the response data
- If token needs refresh, main process handles it transparently before retrying
- If renderer process is compromised, attacker cannot extract tokens or make arbitrary authenticated requests

#### Operating modes

The app supports two modes based on auth state:

| Mode | Auth required | Features available |
|------|--------------|-------------------|
| **Local-only** | None | Profile management, local agent runtime, logs/audit, local workflows |
| **Networked** | Gateway OAuth sign-in | Shared agent discovery/chat, gateway status SSE, encrypted relay sessions |

#### Token management

- Desktop refresh token encrypted at rest via `safeStorage`; access token held in memory.
- Main process refreshes access token automatically and serializes concurrent refresh attempts.
- Invalid/expired refresh paths fail closed and require re-authentication.
- Device JWT lifecycle remains managed by agent runtime.
- Offline mode preserves local agent management; gateway-backed features are unavailable.

### 12. Settings

Accessible from sidebar footer gear icon.

| Setting | Description |
|---------|-------------|
| **Agent Install Root** | Global location of the local agent runtime used by all profiles (configured once in desktop settings, not per-agent). |
| **Gateway URL** | Default: `https://api.commands.com`. Advanced users can point to self-hosted. |
| **Audit Log Path** | Where to write audit logs. Default: `~/.commands-agent/audit.log` |
| **Theme** | Dark (default), Light, System |
| **Notifications** | Toggle system notifications, in-app sounds |
| **Auto-start** | Launch at login (macOS: login items, Windows: startup) |
| **Auto-connect** | Automatically start agents on app launch |
| **Data** | Export all profiles, clear local data, reset app |

### 13. Data Flow & Gateway Integration

#### API surfaces

Current desktop network path is gateway-first:

| Backend | Base URL | Namespace | Purpose |
|---------|----------|-----------|---------|
| **Gateway** (Go/Fiber) | `api.commands.com` | `/oauth/*`, `/gateway/v1/*` | OAuth, devices, sessions, relay, SSE |
| **App backend** (future/optional) | `commands.com` | `/api/gateway/*` | Share links, subscription and account surfaces |

#### SSE event stream (gateway relay)

```
GET /gateway/v1/devices/events
Authorization: Bearer <gateway-access-token>
```

**Current events** (implemented today):
- `device.status` — an agent went online/offline (includes device ID, status, timestamp)
- Per-session SSE for chat sessions via `GET /gateway/v1/sessions/:session_id/events`

Note: live conversation content (individual messages) is NOT delivered via this SSE stream. Owner monitoring of message content comes from local IPC with the agent process (see §5 E2E encryption section). This keeps the relay zero-knowledge about message content.

#### REST API calls

**Gateway** (`api.commands.com`) — desktop calls use gateway OAuth bearer token unless noted:

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /gateway/v1/devices` | Desktop user token | List devices the signed-in user can access |
| `GET /gateway/v1/devices/events` | Desktop user token | SSE device status stream |
| `GET /gateway/v1/devices/:device_id/identity-key` | Desktop user token | Fetch agent identity key for handshake verification |
| `PUT /gateway/v1/devices/:device_id/identity-key` | **Device JWT** | Agent registers/updates its identity key |
| `POST /gateway/v1/sessions/:session_id/handshake/client-init` | Desktop user token | Start E2E handshake |
| `POST /gateway/v1/sessions/:session_id/handshake/agent-ack` | **Device JWT** | Agent acknowledges handshake |
| `GET /gateway/v1/sessions/:session_id/handshake/:handshake_id` | Desktop user token | Poll handshake status |
| `POST /gateway/v1/sessions/:session_id/messages` | Desktop user token | Send encrypted message |
| `GET /gateway/v1/sessions/:session_id/events` | Desktop user token | SSE stream for one chat session |
| `GET /gateway/v1/agent/connect` | **Device JWT** | Agent WebSocket relay connection |

**App backend** (`commands.com`) — share/subscription flows are planned/optional in desktop:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/gateway/shares/devices/:deviceId/grants` | Fetch share grants for a device |
| `POST /api/gateway/shares/invites` | Create a share invite |
| `POST /api/gateway/shares/invites/accept` | Accept a share invite |
| `POST /api/gateway/shares/grants/:grantId/revoke` | Revoke a share |
| `PATCH /api/gateway/shares/grants/:grantId` | Update grant permissions |
| `GET /api/gateway/subscription` | Fetch subscription status |
| `POST /api/gateway/subscription/checkout` | Create Stripe checkout session |
| `POST /api/gateway/subscription/portal` | Create Stripe billing portal session |

#### Local agent communication

For monitoring conversations on your own agents, the desktop app reads from a **local IPC channel** provided by the agent process (see §5 E2E encryption section). This is purely local — no network calls, no relay involvement. The relay never sees decrypted message content.

---

## Implementation Phases

### Delivery Status (as of Feb 2026)

| Phase | Status | Notes |
|------|--------|-------|
| **Phase 1: Hub Shell & Auth** | ✅ Mostly complete | Hub layout shipped, profiles on disk, gateway OAuth in desktop main process |
| **Phase 2: Enhanced Profiles & MCP** | 🟡 Partial | Core profile editing exists; character-centric polish and MCP UX still evolving |
| **Phase 3: Live Conversations & Shared Agents** | ✅ Core complete | Shared With Me list, chat UI, E2E sessions, gateway SSE are functional |
| **Phase 4: Agent-to-Agent** | ⏳ Not shipped | Spec complete, implementation pending |
| **Phase 5: Polish & Viral** | ⏳ Not shipped | Post-foundation quality and growth features remain |

### Next Milestone Priorities

1. Namespaced agent names (owner-scoped uniqueness).
2. Requester identity enrichment (email/display in live + audit).
3. Multi-agent local runtime (remove singleton process model).
4. Share link create/consume flow in desktop UI.
5. Agent-to-agent orchestration loop in shared chat.

---

## Technical Considerations

### Renderer architecture

Renderer is now modularized and routed through `app.js` with split views/components/state.

Current structure (implemented):

```
renderer/
├── index.html
├── app.js                    # Router + view orchestration
├── state.js                  # Shared app/chat/auth state
├── styles/
│   ├── base.css
│   ├── layout.css
│   ├── chat.css
│   └── components.css
├── views/
│   ├── dashboard.js
│   ├── agent-detail.js
│   ├── agent-chat.js
│   ├── agent-create.js
│   └── settings.js
├── components/
│   └── sidebar.js
└── markdown.js               # Renderer markdown helpers
```

Remaining architecture goals:

- Further reduce cross-view coupling in `state.js`.
- Keep all auth/network/crypto logic in main process.
- Maintain sandbox-compatible renderer APIs only.

### IPC additions (preload.js)

Current primary IPC surfaces:

```javascript
// Profiles + local runtime
'desktop:profiles:*'
'desktop:agent:start'
'desktop:agent:stop'
'desktop:agent:status'
'desktop:agent-log'               // push event
'desktop:conversation-event'      // push event

// Auth (main-process only token handling)
'desktop:auth:sign-in'
'desktop:auth:sign-out'
'desktop:auth:status'
'desktop:auth-changed'            // push event

// Gateway shared-chat APIs
'desktop:gateway:devices'
'desktop:gateway:start-session'
'desktop:gateway:send-message'
'desktop:gateway:end-session'
'desktop:gateway-device-event'    // push event
'desktop:gateway-chat-event'      // push event
```

### Encryption in the desktop app

Two distinct encryption contexts:

**Chatting with shared agents (user as remote client):**
The desktop app acts as a chat client — it must perform E2E encryption directly:
1. **Key exchange**: X25519 ECDH to establish session keys with the remote agent
2. **Message encryption**: AES-256-GCM with deterministic nonces (matching existing protocol)
3. All crypto operations happen in the **main process** (Node.js `crypto` module), never in the renderer

**Monitoring your own agents (owner observability):**
The desktop app does NOT perform decryption. The local agent process already decrypts messages to process them. It forwards decrypted content to the desktop app via local IPC. See §5 E2E encryption section.

Crypto implementation:
- Use Node.js `crypto` in main process — it already has X25519, AES-256-GCM, HKDF natively
- Expose via IPC: renderer calls `commandsDesktop.sendMessage(sessionId, plaintext)` → main process encrypts and sends
- Port key exchange helpers from `src/crypto.ts` to main process JavaScript
- Renderer never sees raw keys or ciphertext

### Performance

- **Virtualized message lists**: For conversations with hundreds of messages, use virtual scrolling
- **Lazy loading**: Don't load full conversation history until user scrolls up
- **SSE reconnection**: Exponential backoff with jitter on connection loss
- **Image optimization**: Compress avatar images on upload (max 256x256)
- **Profile indexing**: Profile index file prevents scanning directories on startup

---

## Design Language

### Visual identity

Carry forward the existing dark theme with refinements:

- **Background**: `#0c1017` (deep navy-black)
- **Panel**: `#151b27` (elevated surface)
- **Brand accent**: `#667eea` → `#764ba2` gradient (purple-indigo)
- **Success**: `#10b981` (green)
- **Danger**: `#ef4444` (red)
- **Online**: `#10b981` (green dot)
- **Offline**: `#6b7280` (gray dot)
- **Text**: `#e5e7eb` (primary), `#94a3b8` (muted)

### Typography

- **UI**: Inter (system-ui fallback)
- **Code**: JetBrains Mono or SF Mono (monospace)
- **Chat messages**: 14px base, 1.6 line height for readability

### Interactions

- Subtle hover effects on interactive elements
- Smooth transitions between views (sidebar selection → main panel content)
- Loading skeletons for async content
- Micro-animations for status changes (online/offline transitions)

---

## Success Metrics

### Adoption & engagement

| Metric | Target |
|--------|--------|
| Time to create first agent | < 60 seconds |
| Time to start first shared agent chat | < 30 seconds after share link received |
| Time to start first agent-to-agent conversation | < 2 minutes |
| Conversations shared externally (screenshots, exports) | Tracked — this is the viral metric |
| Daily active desktop app users | Growth indicator |
| Agent-to-agent conversations per user per week | Engagement indicator |

### Reliability & trust

| Metric | Target |
|--------|--------|
| Gateway relay uptime | 99.9% |
| SSE reconnect success rate | > 99% |
| Median SSE reconnect time | < 3 seconds |
| Auth failure rate (token refresh) | < 0.1% |
| Message delivery success (end-to-end) | > 99.9% |
| E2E decryption success rate | 100% (any failure is a bug) |
| Agent crash recovery (auto-restart) | < 5 seconds |

---

## Decisions (Resolved)

1. **Multi-agent monitoring**: **Per-agent.** Each agent's detail view shows only its own conversations. Simpler, more focused, avoids cross-agent noise.

2. **Conversation persistence**: **Forever by default, user-configurable.** History is stored locally indefinitely unless the user sets a retention policy. Settings provide: retention period (30 days / 90 days / 1 year / forever), disk usage display, per-agent clear, clear all. A configurable disk cap (e.g., 1GB default) triggers oldest-first cleanup when exceeded.

3. **Agent-to-agent cost**: **No per-call API credit cost (current assumption).** Claude models currently use the user's Claude Code subscription (not pay-per-call API credits). Ollama models are completely free. Note: if provider pricing/terms change, we may need to add usage visibility or turn-limit defaults. The architecture should support showing per-conversation cost estimates even if we don't surface them initially.

4. **Shared agent avatars**: **Gateway stores a thumbnail.** When an agent registers or updates its profile, the gateway stores a small avatar image (max 256x256). Shared users receive the avatar URL with the share grant metadata. Simpler than handshake-time transfer and works even when the agent is offline (the avatar still shows in the sidebar).

5. **Multiple simultaneous delegations**: **No.** One delegation at a time. Keeps the UX clean — the user focuses on one agent-to-agent conversation. They can stop one and start another. No need for the complexity of managing parallel automated conversations.

6. **Web parity for agent-to-agent**: **Desktop exclusive.** Agent-to-agent delegation requires a local agent running on the user's machine. The web gateway chat remains human-to-agent only. This makes the desktop app the premium experience and gives users a reason to install it.
