#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

GATEWAY_URL="${GATEWAY_URL:-https://api.commands.com}"
DEVICE_ID="${DEVICE_ID:-}"
DEVICE_NAME="${DEVICE_NAME:-}"
DEVICE_TOKEN="${DEVICE_TOKEN:-}"
MODEL="${MODEL:-sonnet}"
PERMISSION_PROFILE="${PERMISSION_PROFILE:-dev-safe}"
DEFAULT_CWD="${DEFAULT_CWD:-$HOME}"
HEARTBEAT_MS="${HEARTBEAT_MS:-30000}"
AUDIT_LOG_PATH="${AUDIT_LOG_PATH:-$HOME/.commands-agent/audit.log}"
MCP_CONFIG_FROM_ENV=0
if [[ -n "${MCP_CONFIG:-}" ]]; then
  MCP_CONFIG_FROM_ENV=1
fi
DEFAULT_MCP_CONFIG_PATH="${ROOT_DIR}/mcp-servers.local.json"
MCP_CONFIG="${MCP_CONFIG:-$DEFAULT_MCP_CONFIG_PATH}"
MCP_FILESYSTEM_ROOT="${MCP_FILESYSTEM_ROOT:-$HOME}"
MCP_FILESYSTEM_ENABLED="${MCP_FILESYSTEM_ENABLED:-1}"
SYSTEM_PROMPT="${SYSTEM_PROMPT:-}"
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

if [[ "$MCP_FILESYSTEM_ENABLED" != "0" && "$MCP_FILESYSTEM_ENABLED" != "1" ]]; then
  echo "[agent] MCP_FILESYSTEM_ENABLED must be 0 or 1 (got: $MCP_FILESYSTEM_ENABLED)"
  exit 1
fi

if [[ "$MCP_CONFIG_FROM_ENV" == "0" ]]; then
  mkdir -p "$(dirname "$MCP_CONFIG")"
  if [[ "$MCP_FILESYSTEM_ENABLED" == "1" ]]; then
    echo "[agent] writing managed MCP config (filesystem enabled) at $MCP_CONFIG"
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
  else
    echo "[agent] writing managed MCP config (filesystem disabled) at $MCP_CONFIG"
    cat > "$MCP_CONFIG" <<JSON
{
  "mcpServers": {}
}
JSON
  fi
elif [[ ! -f "$MCP_CONFIG" ]]; then
  echo "[agent] MCP_CONFIG was set explicitly but does not exist: $MCP_CONFIG"
  exit 1
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
      --permission-profile "$PERMISSION_PROFILE"
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
      --permission-profile "$PERMISSION_PROFILE" \
      --mcp-config "$MCP_CONFIG"
  fi
fi

echo "[agent] starting runtime"
if [[ "$INIT_AGENT" == "0" ]]; then
  echo "[agent] using existing config at $CONFIG_FILE (skip init/login)"
fi
echo "[agent] gateway=$GATEWAY_URL model=$MODEL permission_profile=$PERMISSION_PROFILE cwd=$DEFAULT_CWD heartbeat_ms=$HEARTBEAT_MS auth_mode=$AUTH_MODE init_agent=$INIT_AGENT audit_log=$AUDIT_LOG_PATH mcp_config=$MCP_CONFIG mcp_filesystem_enabled=$MCP_FILESYSTEM_ENABLED"

START_ARGS=(
  --default-cwd "$DEFAULT_CWD"
  --heartbeat-ms "$HEARTBEAT_MS"
  --audit-log-path "$AUDIT_LOG_PATH"
  --model "$MODEL"
  --permission-profile "$PERMISSION_PROFILE"
  --mcp-config "$MCP_CONFIG"
)

if [[ -n "$SYSTEM_PROMPT" ]]; then
  START_ARGS+=(--system-prompt "$SYSTEM_PROMPT")
fi

if [[ -n "$DEVICE_NAME" ]]; then
  START_ARGS+=(--device-name "$DEVICE_NAME")
fi

exec node dist/index.js start "${START_ARGS[@]}"
