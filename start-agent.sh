#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8091}"
DEVICE_ID="${DEVICE_ID:-}"
DEVICE_NAME="${DEVICE_NAME:-}"
DEVICE_TOKEN="${DEVICE_TOKEN:-}"
MODEL="${MODEL:-sonnet}"
DEFAULT_CWD="${DEFAULT_CWD:-/Users/dtannen/Code/commands-com-app}"
HEARTBEAT_MS="${HEARTBEAT_MS:-5000}"
AUDIT_LOG_PATH="${AUDIT_LOG_PATH:-$HOME/.commands-agent/audit.log}"
DEFAULT_MCP_CONFIG_PATH="${ROOT_DIR}/mcp-servers.local.json"
MCP_CONFIG="${MCP_CONFIG:-$DEFAULT_MCP_CONFIG_PATH}"
MCP_FILESYSTEM_ROOT="${MCP_FILESYSTEM_ROOT:-/Users/dtannen/Code}"
AUTH_MODE="${AUTH_MODE:-oauth}" # oauth | manual
HEADLESS="${HEADLESS:-0}"
BUILD_AGENT="${BUILD_AGENT:-1}"
INIT_AGENT="${INIT_AGENT:-auto}" # auto | 0 | 1
CONFIG_FILE="${CONFIG_FILE:-$HOME/.commands-agent/config.json}"

if [[ "$INIT_AGENT" == "auto" ]]; then
  if [[ -f "$CONFIG_FILE" ]]; then
    INIT_AGENT="0"
  else
    INIT_AGENT="1"
  fi
fi

# DEVICE_NAME is applied during init/login only. If INIT_AGENT resolves to 0,
# we keep the existing registered identity and skip re-auth as expected.

if [[ ! -f "$MCP_CONFIG" ]]; then
  echo "[agent] creating default MCP config at $MCP_CONFIG"
  mkdir -p "$(dirname "$MCP_CONFIG")"
  cat > "$MCP_CONFIG" <<JSON
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${MCP_FILESYSTEM_ROOT}"]
    }
  }
}
JSON
fi

if [[ "$BUILD_AGENT" == "1" ]]; then
  echo "[agent] building TypeScript"
  npm run build
fi

if [[ "$INIT_AGENT" == "1" ]]; then
  if [[ "$AUTH_MODE" == "oauth" ]]; then
    echo "[agent] authenticating with gateway OAuth"
    LOGIN_ARGS=(
      --gateway-url "$GATEWAY_URL"
      --model "$MODEL"
      --mcp-config "$MCP_CONFIG"
    )

    if [[ -n "$DEVICE_ID" ]]; then
      LOGIN_ARGS+=(--device-id "$DEVICE_ID")
    fi
    if [[ -n "$DEVICE_NAME" ]]; then
      LOGIN_ARGS+=(--device-name "$DEVICE_NAME")
    fi

    if [[ "$HEADLESS" == "1" ]]; then
      LOGIN_ARGS+=(--headless)
    fi

    node dist/index.js login "${LOGIN_ARGS[@]}"
  else
    if [[ -z "$DEVICE_ID" || -z "$DEVICE_TOKEN" ]]; then
      echo "[agent] AUTH_MODE=manual requires DEVICE_ID and DEVICE_TOKEN"
      exit 1
    fi

    echo "[agent] manual init using device token"
    node dist/index.js init \
      --gateway-url "$GATEWAY_URL" \
      --device-id "$DEVICE_ID" \
      --device-token "$DEVICE_TOKEN" \
      --model "$MODEL" \
      --mcp-config "$MCP_CONFIG"
  fi
fi

echo "[agent] starting runtime"
if [[ "$INIT_AGENT" == "0" ]]; then
  echo "[agent] using existing config at $CONFIG_FILE (skip init/login)"
fi
echo "[agent] gateway=$GATEWAY_URL model=$MODEL cwd=$DEFAULT_CWD heartbeat_ms=$HEARTBEAT_MS auth_mode=$AUTH_MODE init_agent=$INIT_AGENT audit_log=$AUDIT_LOG_PATH mcp_config=$MCP_CONFIG"

exec node dist/index.js start \
  --default-cwd "$DEFAULT_CWD" \
  --heartbeat-ms "$HEARTBEAT_MS" \
  --audit-log-path "$AUDIT_LOG_PATH" \
  --model "$MODEL" \
  --mcp-config "$MCP_CONFIG"
