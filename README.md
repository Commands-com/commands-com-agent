# commands-com-agent

Local agent runtime and desktop companion for the Commands secure relay.

`commands-com-agent` runs an AI agent on your machine, connects it to the gateway, and handles encrypted relay sessions for remote chat. It supports both Claude and Ollama providers.

## Highlights

- Gateway OAuth login and device registration
- Manual token initialization fallback for non-interactive environments
- Local identity key management and handshake signing
- Encrypted session frame handling (AES-256-GCM)
- Always-on runtime with reconnect/backoff
- Local prompt execution via `claude` or `ollama`
- Optional MCP server passthrough for local tool access
- Electron desktop app for profile setup, logs, and shared-agent chat

## Requirements

- Node.js 20+
- Reachable gateway URL
- Claude provider: local Claude auth for Claude Code / Claude Agent SDK
- Ollama provider: local Ollama running (default `http://localhost:11434`) with models pulled

## Install

```bash
git clone https://github.com/Commands-com/commands-com-agent.git
cd commands-com-agent
npm install
npm run build
```

## Quickstart (recommended)

```bash
# OAuth login + config + identity registration + runtime
./start-agent.sh

# Optional friendly display name for this device
INIT_AGENT=1 DEVICE_NAME="office-mac" ./start-agent.sh
```

Notes:
- If no `--device-id` is supplied, device IDs are generated as `dev_<32 hex>`.
- `DEVICE_NAME` is a UI label and does not determine device ID format.

### Provider selection

```bash
# Claude (default)
PROVIDER=claude MODEL=sonnet ./start-agent.sh

# Ollama (local only)
PROVIDER=ollama MODEL=llama3.2 OLLAMA_BASE_URL=http://localhost:11434 ./start-agent.sh
```

## Desktop app (Electron)

The desktop app can:
- Start/stop local agent processes
- Stream logs and conversations
- Sign in with gateway OAuth
- Show agents shared with you and chat with them
- Consume share links and manage share grants

```bash
npm install --prefix ./desktop
npm run dev:desktop
```

## CLI usage

```bash
# OAuth login
node dist/index.js login --gateway-url https://api.commands.com

# Manual init (fallback)
node dist/index.js init --gateway-url https://api.commands.com --device-id <device_id> --device-token <device_token>

# Status
node dist/index.js status
node dist/index.js status --json

# One-off local prompt
node dist/index.js run --prompt "Summarize current TODOs"
node dist/index.js run --provider ollama --model llama3.2 --ollama-base-url http://localhost:11434 --prompt "Summarize current TODOs"

# Start runtime
node dist/index.js start --default-cwd "$HOME" --heartbeat-ms 30000 --audit-log-path ~/.commands-agent/audit.log
```

See full command options:

```bash
node dist/index.js --help
```

## `start-agent.sh` environment variables

Core variables:
- `AUTH_MODE=oauth|manual` (default `oauth`)
- `HEADLESS=1` for headless OAuth login
- `GATEWAY_URL` (default `https://api.commands.com`)
- `PROVIDER=claude|ollama` (default `claude`)
- `MODEL` (default `sonnet`)
- `OLLAMA_BASE_URL` (default `http://localhost:11434`, ollama only)
- `DEVICE_NAME` optional friendly display name
- `DEFAULT_CWD` (default `$HOME`)
- `HEARTBEAT_MS` (default `30000`)
- `AUDIT_LOG_PATH` (default `~/.commands-agent/audit.log`)

MCP variables:
- `MCP_CONFIG` (default `./mcp-servers.local.json`)
- `MCP_FILESYSTEM_ROOT` (default `$HOME`)
- `MCP_FILESYSTEM_ENABLED=0|1`

Manual auth variables:
- `DEVICE_ID`
- `DEVICE_TOKEN`

## MCP config format

`--mcp-config` accepts either a direct server map or an object with `mcpServers`.

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

## Security and project policy

- Security notes:
  - Config stored at `~/.commands-agent/config.json`
  - File permissions tightened (`0700` dir, `0600` file)
  - Session keys kept in memory after handshake
  - Monotonic sequence + deterministic nonce checks
- Vulnerability reporting: see [`SECURITY.md`](./SECURITY.md)
- Contribution workflow: see [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- License: [`MIT`](./LICENSE)

## Additional docs

See `/docs` for current architecture, rebuild specs, and delivery plans.
