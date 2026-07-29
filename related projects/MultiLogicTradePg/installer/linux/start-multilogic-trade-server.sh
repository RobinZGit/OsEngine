#!/usr/bin/env bash
# Launch MultiLogic Trade API only (headless live trading, no Angular).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/../../api/server.js" ]]; then
  APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [[ -f "$SCRIPT_DIR/../api/server.js" ]]; then
  APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [[ -f "$SCRIPT_DIR/api/server.js" ]]; then
  APP_ROOT="$SCRIPT_DIR"
else
  echo "[ERROR] Cannot find api/server.js relative to $SCRIPT_DIR" >&2
  exit 1
fi

API="$APP_ROOT/api"

echo
echo " ========================================================"
echo "  MultiLogic Trade Server Start (Linux)"
echo "  API only — live trading without Angular UI"
echo " ========================================================"
echo
echo "  APP: $APP_ROOT"
echo "  API: $API"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found in PATH. Install Node.js 18+." >&2
  exit 1
fi
echo "  Node: $(node -v)"

export PGPASSWORD="${PGPASSWORD:-111}"
export PGHOST="${PGHOST:-localhost}"
export PGDATABASE="${PGDATABASE:-multilogictrade}"
export PGUSER="${PGUSER:-postgres}"
export PORT="${PORT:-3000}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:4200}"
export TRADE_RUNNER_INTERVAL_MS="${TRADE_RUNNER_INTERVAL_MS:-15000}"
export TRADE_RUNNER_REQUIRE_UI="${TRADE_RUNNER_REQUIRE_UI:-0}"

if [[ -f "$API/.env" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$API/.env" | sed 's/\r$//')
  set +a
fi

if [[ ! -f "$API/server.js" ]]; then
  echo "[ERROR] Missing $API/server.js" >&2
  exit 1
fi
if [[ ! -d "$API/node_modules" ]]; then
  echo "[ERROR] api/node_modules missing. Re-run installer/linux/install.sh" >&2
  exit 1
fi

free_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  elif command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill -9 $pids >/dev/null 2>&1 || true
    fi
  fi
}

echo "  [1/2] Free port ${PORT}..."
free_port "$PORT"
sleep 1

echo "  [2/2] Starting API on :${PORT} (headless trading)..."
echo "  Keep this process running. Ctrl+C stops live trading."
echo
cd "$API"
exec node server.js
