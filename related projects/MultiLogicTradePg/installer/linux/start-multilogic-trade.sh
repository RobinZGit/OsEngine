#!/usr/bin/env bash
# Launch MultiLogic Trade: API :3000 + Angular :4200
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer install root: script may live in installer/linux or directly in app root.
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

WEB="$APP_ROOT/web"
API="$APP_ROOT/api"

echo
echo " ========================================================"
echo "  MultiLogic Trade Progress Start (Linux)"
echo "  One session: API :3000 + Angular :4200 + PostgreSQL"
echo " ========================================================"
echo
echo "  APP: $APP_ROOT"
echo "  WEB: $WEB"
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
if [[ ! -f "$WEB/package.json" ]]; then
  echo "[ERROR] Missing $WEB/package.json" >&2
  exit 1
fi
if [[ ! -d "$API/node_modules" || ! -d "$WEB/node_modules" ]]; then
  echo "[ERROR] node_modules missing. Re-run installer/linux/install.sh" >&2
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

echo "  [1/3] Free ports 3000 and 4200..."
free_port 3000
free_port 4200
sleep 1

cleanup() {
  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "${WEB_PID:-}" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "  [2/3] Starting API on :${PORT}..."
(
  cd "$API"
  node server.js
) &
API_PID=$!

echo "  [3/3] Starting Angular on :4200..."
(
  cd "$WEB"
  if [[ -f "$WEB/node_modules/@angular/cli/bin/ng.js" ]]; then
    node "$WEB/node_modules/@angular/cli/bin/ng.js" serve --port 4200 --host localhost --open=false --configuration=development
  else
    npx ng serve --port 4200 --host localhost --open=false --configuration=development
  fi
) &
WEB_PID=$!

echo
echo "  API PID=$API_PID  WEB PID=$WEB_PID"
echo "  Open http://localhost:4200"
echo "  Ctrl+C to stop both."
echo

wait
