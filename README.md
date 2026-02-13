# commands-com-agent

Local agent connector for commands.com secure relay.

This project uses `@anthropic-ai/claude-agent-sdk` locally and includes:
- browser OAuth/Firebase login flow for device registration (default)
- manual token init fallback for headless environments
- local secure config + identity key management
- gateway identity key registration
- authenticated handshake ack command
- always-on websocket runtime with reconnect/backoff
- encrypted session frame handling (AES-256-GCM)
- local Claude prompt execution for session tasks
- optional MCP server passthrough for Claude tool access

## Requirements

- Node.js 20+
- Valid local Claude auth for Claude Code / Claude Agent SDK
- Gateway reachable from your machine

## Install

```bash
git clone https://github.com/commands-com/commands-com-agent.git
cd commands-com-agent
npm install
npm run build
```

## Quickstart (OAuth, recommended)

```bash
# Starts browser OAuth (Firebase), saves config, registers identity key, starts runtime
./start-agent.sh

# Name your device (used to build a stable device_id like dev-office-mac)
INIT_AGENT=1 DEVICE_NAME="office-mac" ./start-agent.sh
```

Or run commands directly:

```bash
node dist/index.js login \
  --gateway-url https://api.commands.com \
  --device-name "office-mac" \
  --mcp-config ./mcp-servers.json

node dist/index.js start --default-cwd $HOME --heartbeat-ms 30000
```

## Desktop Wizard (Electron)

The desktop app provides a local setup wizard for agent profiles, MCP modules, and run/validate controls.
It can also start/stop the local agent process directly and stream runtime logs.

```bash
# first run (installs desktop deps)
npm install --prefix ./desktop
npm run dev:desktop

# subsequent runs
npm run dev:desktop
```

## Headless / Manual fallback

```bash
# Headless OAuth flow (prints URL, prompts for auth code)
node dist/index.js login --gateway-url https://api.commands.com --headless

# Manual token init (for test/dev or non-interactive bootstrap)
node dist/index.js init \
  --gateway-url https://api.commands.com \
  --device-id <device_id> \
  --device-token <device_token>
```

## Commands

```bash
# Browser OAuth login + device registration
node dist/index.js login

# Browser OAuth login + custom device name
node dist/index.js login --device-name "office-mac"

# Headless OAuth login (no auto-open browser)
node dist/index.js login --headless

# Show local status (add --json for machine-readable output)
node dist/index.js status
node dist/index.js status --json

# Run one prompt locally through Claude Agent SDK
node dist/index.js run --prompt "Summarize current TODOs" --cwd /path/to/repo

# Start always-on runtime
node dist/index.js start \
  --default-cwd $HOME \
  --heartbeat-ms 30000 \
  --audit-log-path ~/.commands-agent/audit.log \
  --reconnect-min-ms 1000 \
  --reconnect-max-ms 30000
```

## Startup script behavior

`start-agent.sh` defaults to OAuth auth mode and connects to `https://api.commands.com`.

Environment variables:
- `AUTH_MODE=oauth|manual` (default `oauth`)
- `HEADLESS=1` for headless OAuth login
- `GATEWAY_URL` (default `https://api.commands.com`)
- `MODEL`, `DEFAULT_CWD` (default `$HOME`), `HEARTBEAT_MS` (default `30000`)
- `DEVICE_NAME` optional friendly name for OAuth login (`dev-<device_name_slug>`)
- `AUDIT_LOG_PATH` local JSONL audit trail path (default `~/.commands-agent/audit.log`)
- `MCP_CONFIG` (default `./mcp-servers.local.json`)
- `MCP_FILESYSTEM_ROOT` (default `$HOME`)
- `DEVICE_ID`, `DEVICE_TOKEN` (required only in `AUTH_MODE=manual`)

## MCP config file format

`--mcp-config` accepts either:
- a direct MCP server map, or
- an object containing `mcpServers`.

Example:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Code"]
    },
    "github": {
      "type": "http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

## Runtime message support

Handled incoming frame types:
- `heartbeat` / `ping`
- `session.handshake.request`
- `session.message` (plaintext or encrypted envelope)
- `session.cancel`

Produced outgoing frame types:
- `agent.hello`
- `heartbeat`
- `session.handshake.ack`
- `session.progress` (metadata)
- `session.result` (plaintext or encrypted envelope)
- `session.error` (plaintext or encrypted envelope)
- `agent.error`

## Encryption behavior

When `session.message` includes encrypted fields (`ciphertext`, `nonce`, `tag`, `seq`), the runtime:
- validates strict in-order sequence (`seq`)
- validates deterministic nonce by direction + seq
- decrypts with `client_to_agent` key (AES-256-GCM)
- executes prompt locally
- returns encrypted `session.result` or `session.error` using `agent_to_client` key

## Security notes

- Config is stored at `~/.commands-agent/config.json`.
- File permissions are tightened (`0700` dir, `0600` file).
- Identity keys are generated and stored locally.
- Session keys are derived after handshake and kept in memory.
- Nonce reuse is prevented via deterministic nonce + monotonic sequence.
- MCP server permissions are the responsibility of the local operator; only trust servers you control.
- Incoming session prompts are logged locally to the audit log path for owner review.

## Known gaps

- Gateway/web side must enforce the same encrypted frame contract for full end-to-end rollout.
- `session.progress` and some runtime metadata frames are still plaintext metadata.
