#!/usr/bin/env bash
# MultiLogicTradePg Linux post-install (parity with Windows install.ps1).
# Usage:
#   sudo ./installer/linux/install.sh
#   ./installer/linux/install.sh --prefix "$HOME/MultiLogicTradePg" --db-mode upgrade
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PREFIX=""
DB_MODE="wipe"
DB_MODE_FROM_CLI=0
UPDATE_SSL_CERTS=0
POSTGRES_PASSWORD="111"
POSTGRES_MAJOR="15"
SKIP_DEPS=0
SKIP_NPM=0

usage() {
  cat <<'EOF'
MultiLogicTradePg Linux installer

Options:
  --prefix DIR          Install directory (default: /opt/MultiLogicTradePg if root, else ~/MultiLogicTradePg)
  --db-mode MODE        wipe | upgrade | create  (default: wipe)
  --update-ssl-certs    Refresh system CA certs + SELECT configure_http_ssl() (off by default)
  --postgres-password P Superuser password (default: 111)
  --skip-deps           Do not try to install Node.js / PostgreSQL via package manager
  --skip-npm            Skip npm ci
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --db-mode) DB_MODE="${2:-}"; DB_MODE_FROM_CLI=1; shift 2 ;;
    --update-ssl-certs) UPDATE_SSL_CERTS=1; shift ;;
    --postgres-password) POSTGRES_PASSWORD="${2:-}"; shift 2 ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --skip-npm) SKIP_NPM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

DB_MODE="$(echo "$DB_MODE" | tr '[:upper:]' '[:lower:]')"
if [[ "$DB_MODE" != "wipe" && "$DB_MODE" != "upgrade" && "$DB_MODE" != "create" ]]; then
  echo "Invalid --db-mode: $DB_MODE (use wipe|upgrade|create)" >&2
  exit 1
fi

if [[ -z "$PREFIX" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    PREFIX="/opt/MultiLogicTradePg"
  else
    PREFIX="${HOME}/MultiLogicTradePg"
  fi
fi

# db-mode.txt only when --db-mode was not passed on CLI
DB_MODE_FILE="$SCRIPT_DIR/db-mode.txt"
if [[ "$DB_MODE_FROM_CLI" -eq 0 && -f "$DB_MODE_FILE" ]]; then
  from_file="$(tr -d '[:space:]' <"$DB_MODE_FILE" | tr '[:upper:]' '[:lower:]')"
  if [[ "$from_file" == "wipe" || "$from_file" == "upgrade" || "$from_file" == "create" ]]; then
    DB_MODE="$from_file"
  fi
fi

# update-ssl-certs.txt (1) written by packaging tools; CLI --update-ssl-certs wins if set
SSL_FILE="$SCRIPT_DIR/update-ssl-certs.txt"
if [[ "$UPDATE_SSL_CERTS" -eq 0 && -f "$SSL_FILE" ]]; then
  ssl_from_file="$(tr -d '[:space:]' <"$SSL_FILE" | tr '[:upper:]' '[:lower:]')"
  if [[ "$ssl_from_file" == "1" || "$ssl_from_file" == "true" || "$ssl_from_file" == "yes" || "$ssl_from_file" == "on" ]]; then
    UPDATE_SSL_CERTS=1
  fi
fi

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGCLIENTENCODING=UTF8

if [[ "$(id -u)" -eq 0 ]]; then
  LOG_DIR="/var/log/MultiLogicTradePg"
else
  LOG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/MultiLogicTradePg"
fi
mkdir -p "$LOG_DIR"
RUN_STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_PATH="$LOG_DIR/install-$RUN_STAMP.log"
LATEST_LOG="$LOG_DIR/install-latest.log"

step() { echo; echo "==> $*"; }
ok() { echo "    $*"; }
warn() { echo "    [WARN] $*" >&2; }

# Tee all output to protocol + log
PROTOCOL_STAGING=""
exec > >(tee -a "$LOG_PATH") 2>&1
cp -f "$LOG_PATH" "$LATEST_LOG" 2>/dev/null || true

copy_tree_to_prefix() {
  step "Installing files to $PREFIX"
  mkdir -p "$PREFIX"
  # If already running from destination, skip copy.
  if [[ "$(cd "$PACKAGE_ROOT" && pwd)" == "$(cd "$PREFIX" 2>/dev/null && pwd)" ]]; then
    ok "Already in install directory; skipping copy."
    return
  fi
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'node_modules/' \
      --exclude '.angular/' \
      --exclude 'web/dist/' \
      --exclude 'api/.env' \
      --exclude 'installer/windows/dist/' \
      --exclude 'installer/linux/dist/' \
      "$PACKAGE_ROOT/" "$PREFIX/"
  else
    # Fallback without rsync (keeps existing api/.env if present)
    local keep_env=""
    if [[ -f "$PREFIX/api/.env" ]]; then
      keep_env="$(mktemp)"
      cp -f "$PREFIX/api/.env" "$keep_env"
    fi
    find "$PREFIX" -mindepth 1 -maxdepth 1 ! -name 'api' -exec rm -rf {} + 2>/dev/null || true
    cp -a "$PACKAGE_ROOT"/. "$PREFIX"/
    rm -rf "$PREFIX/api/node_modules" "$PREFIX/web/node_modules" "$PREFIX/web/.angular" \
      "$PREFIX/installer/windows/dist" "$PREFIX/installer/linux/dist" 2>/dev/null || true
    if [[ -n "$keep_env" ]]; then
      mkdir -p "$PREFIX/api"
      mv -f "$keep_env" "$PREFIX/api/.env"
    else
      rm -f "$PREFIX/api/.env" 2>/dev/null || true
    fi
  fi
  ok "Files copied."
}

detect_pkg_mgr() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  elif command -v pacman >/dev/null 2>&1; then echo pacman
  else echo none
  fi
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then echo 0; return; fi
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

ensure_node() {
  step "Checking Node.js"
  local major
  major="$(node_major)"
  if [[ "$major" -ge 18 ]]; then
    ok "Node.js found: major $major ($(node -v))"
    return
  fi
  if [[ "$SKIP_DEPS" -eq 1 ]]; then
    echo "Node.js 18+ not found and --skip-deps is set." >&2
    exit 1
  fi
  local mgr
  mgr="$(detect_pkg_mgr)"
  ok "Node.js 18+ missing; trying package manager: $mgr"
  case "$mgr" in
    apt)
      apt-get update -y
      apt-get install -y nodejs npm || true
      # Prefer NodeSource if still old
      if [[ "$(node_major)" -lt 18 ]]; then
        warn "Distro node too old; install Node.js 18+ from https://nodejs.org/ and re-run."
        exit 1
      fi
      ;;
    dnf)
      dnf install -y nodejs npm
      ;;
    yum)
      yum install -y nodejs npm
      ;;
    pacman)
      pacman -Sy --noconfirm nodejs npm
      ;;
    *)
      echo "No supported package manager. Install Node.js 18+ manually." >&2
      exit 1
      ;;
  esac
  major="$(node_major)"
  if [[ "$major" -lt 18 ]]; then
    echo "Node.js still below 18 after install attempt." >&2
    exit 1
  fi
  ok "Node.js installed: major $major"
}

ensure_postgres() {
  step "Checking PostgreSQL $POSTGRES_MAJOR"
  if command -v psql >/dev/null 2>&1; then
    ok "psql found: $(command -v psql)"
  else
    if [[ "$SKIP_DEPS" -eq 1 ]]; then
      echo "PostgreSQL not found and --skip-deps is set." >&2
      exit 1
    fi
    local mgr
    mgr="$(detect_pkg_mgr)"
    ok "PostgreSQL missing; trying package manager: $mgr"
    case "$mgr" in
      apt)
        apt-get update -y
        apt-get install -y "postgresql-$POSTGRES_MAJOR" postgresql-client || apt-get install -y postgresql postgresql-client
        ;;
      dnf)
        dnf install -y "postgresql$POSTGRES_MAJOR-server" "postgresql$POSTGRES_MAJOR" || dnf install -y postgresql-server postgresql
        if command -v postgresql-setup >/dev/null 2>&1; then
          postgresql-setup --initdb || true
        fi
        ;;
      yum)
        yum install -y postgresql-server postgresql
        postgresql-setup initdb || true
        ;;
      pacman)
        pacman -Sy --noconfirm postgresql
        ;;
      *)
        echo "Install PostgreSQL $POSTGRES_MAJOR manually, then re-run." >&2
        exit 1
        ;;
    esac
  fi

  # Start service when possible
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now postgresql 2>/dev/null \
      || systemctl enable --now "postgresql@$POSTGRES_MAJOR-main" 2>/dev/null \
      || systemctl enable --now postgresql-"$POSTGRES_MAJOR" 2>/dev/null \
      || true
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql still not found after install attempt." >&2
    exit 1
  fi
}

psql_q() {
  local db="$1"; shift
  psql -h "$PGHOST" -p "$PGPORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"
}

psql_scalar() {
  local db="$1"
  local sql="$2"
  psql -h "$PGHOST" -p "$PGPORT" -U postgres -d "$db" -t -A -v ON_ERROR_STOP=1 -c "$sql" | head -n1 | tr -d '[:space:]'
}

psql_scalar_port() {
  local port="$1"
  local db="$2"
  local sql="$3"
  psql -h localhost -p "$port" -U postgres -d "$db" -t -A -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null | head -n1 | tr -d '[:space:]' || true
}

wait_postgres() {
  step "Waiting for PostgreSQL"
  local i
  for i in $(seq 1 60); do
    if psql_q postgres -c "SELECT 1;" >/dev/null 2>&1; then
      ok "PostgreSQL is ready on $PGHOST:$PGPORT"
      return
    fi
    sleep 2
  done
  echo "PostgreSQL did not become ready within 120 seconds." >&2
  exit 1
}

select_postgres_port() {
  step "Searching PostgreSQL target for multilogictrade"
  local ports=(5432)
  if [[ -f "$PREFIX/api/.env" ]]; then
    local env_port
    env_port="$(grep -E '^\s*PGPORT\s*=' "$PREFIX/api/.env" | head -n1 | cut -d= -f2- | tr -d '[:space:]\r')"
    if [[ -n "$env_port" ]]; then ports+=("$env_port"); fi
  fi
  local p
  for p in 5433 5434 5435 5436 5437 5438 5439 5440; do ports+=("$p"); done

  local ready=""
  for p in "${ports[@]}"; do
    local server_ok db_exists
    server_ok="$(psql_scalar_port "$p" postgres "SELECT 1;")"
    if [[ "$server_ok" != "1" ]]; then
      ok "localhost:$p - no postgres/$POSTGRES_PASSWORD connection"
      continue
    fi
    if [[ -z "$ready" ]]; then ready="$p"; fi
    db_exists="$(psql_scalar_port "$p" postgres "SELECT COUNT(*) FROM pg_database WHERE datname = 'multilogictrade';")"
    ok "localhost:$p - available, multilogictrade=$db_exists"
    if [[ "$db_exists" == "1" ]]; then
      PGPORT="$p"
      ok "Existing multilogictrade found on localhost:$p"
      return
    fi
  done
  if [[ -n "$ready" ]]; then
    PGPORT="$ready"
    ok "No existing DB; will use localhost:$ready"
    return
  fi
  echo "No local PostgreSQL accepted user postgres with password $POSTGRES_PASSWORD." >&2
  echo "Tip: sudo -u postgres psql -c \"ALTER USER postgres PASSWORD '$POSTGRES_PASSWORD';\"" >&2
  exit 1
}

http_extension_ready() {
  local v
  v="$(psql_scalar postgres "SELECT COUNT(*) FROM pg_available_extensions WHERE name = 'http';" 2>/dev/null || echo 0)"
  [[ "$v" == "1" ]]
}

try_install_pgsql_http() {
  step "Checking pgsql-http extension"
  if http_extension_ready; then
    ok "pgsql-http available"
    return 0
  fi
  if [[ "$SKIP_DEPS" -eq 1 ]]; then
    warn "pgsql-http unavailable; HTTP price loading may be limited."
    return 1
  fi
  local mgr
  mgr="$(detect_pkg_mgr)"
  case "$mgr" in
    apt)
      apt-get install -y "postgresql-$POSTGRES_MAJOR-http" 2>/dev/null \
        || apt-get install -y postgresql-http 2>/dev/null \
        || true
      ;;
    *)
      warn "No automatic pgsql-http package for $mgr; continuing without HTTP block."
      ;;
  esac
  if http_extension_ready; then
    ok "pgsql-http installed"
    return 0
  fi
  warn "pgsql-http not installed; core 02 (without optional HTTP/cron) will be used."
  return 1
}

update_ssl_certs_opt_in() {
  # Opt-in (default off). Best-effort: do not abort install on failure.
  # T-Bank: invest-public-api.tbank.ru:443 needs Russian Trusted CA (gosuslugi.ru/crt).
  step "Updating SSL CA certificates (Mozilla + Госуслуги/НУЦ, opt-in)"
  local mgr
  mgr="$(detect_pkg_mgr)"
  case "$mgr" in
    apt)
      apt-get install -y ca-certificates 2>/dev/null || true
      update-ca-certificates 2>/dev/null || true
      ok "ca-certificates refreshed (apt)"
      ;;
    dnf|yum)
      "$mgr" install -y ca-certificates 2>/dev/null || true
      ok "ca-certificates package touched ($mgr)"
      ;;
    *)
      warn "Unknown package manager; skipped system CA refresh"
      ;;
  esac
  # Russian Trusted CA → system trust (curl/OpenSSL used by pgsql-http)
  local ru_dir="/usr/local/share/ca-certificates/russian-trusted"
  local ru_pem="/tmp/russiantrustedca.pem"
  if command -v wget >/dev/null 2>&1 || command -v curl >/dev/null 2>&1; then
    mkdir -p "$ru_dir" 2>/dev/null || true
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL -o "$ru_pem" "https://gu-st.ru/content/Other/doc/russiantrustedca.pem" 2>/dev/null || true
    else
      wget -q -O "$ru_pem" "https://gu-st.ru/content/Other/doc/russiantrustedca.pem" 2>/dev/null || true
    fi
    if [[ -s "$ru_pem" ]] && grep -q "BEGIN CERTIFICATE" "$ru_pem"; then
      cp -f "$ru_pem" "$ru_dir/russiantrustedca.crt" 2>/dev/null || true
      update-ca-certificates 2>/dev/null || update-ca-trust 2>/dev/null || true
      ok "Russian Trusted CA installed (gosuslugi / gu-st.ru)"
    else
      warn "Could not download russiantrustedca.pem — see https://www.gosuslugi.ru/crt"
    fi
  fi
  if psql_scalar multilogictrade "SELECT COUNT(*) FROM pg_proc WHERE proname = 'configure_http_ssl';" 2>/dev/null | grep -qx '1'; then
    if psql_q multilogictrade -c "SELECT configure_http_ssl();" 2>/dev/null; then
      ok "configure_http_ssl() applied"
    else
      warn "configure_http_ssl() failed (non-fatal)"
    fi
  else
    warn "configure_http_ssl() not found; system CAs updated only"
  fi
}

core_sql02() {
  local src="$PREFIX/02_multilogictrade_functions_and_procedures.sql"
  local dest="/tmp/02_multilogictrade_functions_and_procedures.core.$$.sql"
  local marker="-- @optional-pgcron-block"
  if grep -qF "$marker" "$src"; then
    # shellcheck disable=SC2002
    cat "$src" | awk -v m="$marker" 'index($0,m)==1{exit} {print}' >"$dest"
  else
    cp -f "$src" "$dest"
  fi
  echo "$dest"
}

deploy_schema() {
  local http_ok="$1"
  local drop_first="$2"
  if [[ "$drop_first" == "1" ]]; then
    step "Dropping public functions/procedures (data tables kept)"
    psql_q multilogictrade -f "$PREFIX/sql/drop_public_routines.sql"
  fi
  step "Deploying database 01 -> ensure_seed -> 02"
  if [[ ! -f "$PREFIX/01_multilogictrade_tables_and_data.sql" ]]; then
    echo "Missing $PREFIX/01_multilogictrade_tables_and_data.sql" >&2
    exit 1
  fi
  if [[ ! -f "$PREFIX/sql/ensure_seed_logics.sql" ]]; then
    echo "Missing $PREFIX/sql/ensure_seed_logics.sql (required for install-on-top seed logics)." >&2
    exit 1
  fi
  if ! grep -q "v54: install-on-top ensure" "$PREFIX/01_multilogictrade_tables_and_data.sql"; then
    echo "Installed 01 is outdated (no v54 seed ensure). Use the latest package from the OsEngine repo." >&2
    exit 1
  fi
  psql_q multilogictrade -f "$PREFIX/01_multilogictrade_tables_and_data.sql"
  step "Ensuring default seed logics (LinReg Fade Optimized, …)"
  psql_q multilogictrade -f "$PREFIX/sql/ensure_seed_logics.sql"
  local opt_count
  opt_count="$(psql_scalar multilogictrade "SELECT COUNT(*) FROM logics WHERE name = 'LinReg Fade Optimized';")"
  if [[ "$opt_count" != "1" ]]; then
    echo "Seed check failed: LinReg Fade Optimized count=$opt_count (expected 1)." >&2
    exit 1
  fi
  ok "Seed OK: LinReg Fade Optimized present."
  local sql02
  if [[ "$http_ok" == "1" ]]; then
    sql02="$PREFIX/02_multilogictrade_functions_and_procedures.sql"
  else
    sql02="$(core_sql02)"
    warn "Using core 02 without optional HTTP/pg_cron block"
  fi
  psql_q multilogictrade -f "$sql02"
}

deploy_database() {
  local http_ok="$1"
  step "Database deploy mode: $DB_MODE"
  ok "host=$PGHOST port=$PGPORT db=multilogictrade"

  local exists
  exists="$(psql_scalar postgres "SELECT COUNT(*) FROM pg_database WHERE datname = 'multilogictrade';")"

  if [[ "$DB_MODE" == "wipe" ]]; then
    step "Resetting database (wipe)"
    psql_q postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'multilogictrade' AND pid <> pg_backend_pid();" || true
    psql_q postgres -c "DROP DATABASE IF EXISTS multilogictrade WITH (FORCE);"
    psql_q postgres -c "CREATE DATABASE multilogictrade ENCODING 'UTF8' TEMPLATE template0;"
    deploy_schema "$http_ok" 0
    ok "Database wiped and recreated."
    return
  fi

  step "Ensuring database exists (no DROP; preserve data)"
  if [[ "$exists" != "1" ]]; then
    psql_q postgres -c "CREATE DATABASE multilogictrade ENCODING 'UTF8' TEMPLATE template0;"
    deploy_schema "$http_ok" 0
  else
    ok "Existing multilogictrade kept (upgrade in place)."
    deploy_schema "$http_ok" 1
  fi
}

write_api_env() {
  step "Creating api/.env"
  cat >"$PREFIX/api/.env" <<EOF
PGHOST=$PGHOST
PGPORT=$PGPORT
PGDATABASE=multilogictrade
PGUSER=postgres
PGPASSWORD=$POSTGRES_PASSWORD
PORT=3000
CORS_ORIGIN=http://localhost:4200
TRADE_RUNNER_INTERVAL_MS=15000
TRADE_RUNNER_REQUIRE_UI=0
EOF
  ok "Wrote $PREFIX/api/.env"
}

install_npm() {
  if [[ "$SKIP_NPM" -eq 1 ]]; then
    warn "Skipping npm (--skip-npm)"
    return
  fi
  step "Installing npm dependencies"
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found." >&2
    exit 1
  fi
  # Free ports if fuser/lsof available
  if command -v fuser >/dev/null 2>&1; then
    fuser -k 3000/tcp 4200/tcp >/dev/null 2>&1 || true
  fi
  rm -rf "$PREFIX/api/node_modules" "$PREFIX/web/node_modules" "$PREFIX/web/.angular"
  local dir
  for dir in api web; do
    (
      cd "$PREFIX/$dir"
      if [[ -f package-lock.json ]]; then
        npm ci --no-audit --no-fund
      else
        npm install --no-audit --no-fund
      fi
    )
    if [[ ! -d "$PREFIX/$dir/node_modules" ]]; then
      echo "npm finished for $dir but node_modules missing." >&2
      exit 1
    fi
  done
  ok "npm dependencies installed."
}

install_launcher() {
  step "Installing launcher"
  local launcher="$PREFIX/start-multilogic-trade.sh"
  cp -f "$PREFIX/installer/linux/start-multilogic-trade.sh" "$launcher"
  chmod +x "$launcher" "$PREFIX/installer/linux/install.sh" "$PREFIX/installer/linux/start-multilogic-trade.sh"

  local desktop_dir
  if [[ "$(id -u)" -eq 0 ]]; then
    desktop_dir="/usr/share/applications"
  else
    desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  fi
  mkdir -p "$desktop_dir"
  cat >"$desktop_dir/multilogic-trade.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MultiLogic Trade
Comment=MultiLogic Trade API + Angular UI
Exec=bash -lc '$launcher'
Path=$PREFIX
Terminal=true
Categories=Office;Finance;
EOF
  ok "Launcher: $launcher"
  ok "Desktop entry: $desktop_dir/multilogic-trade.desktop"
}

write_protocol() {
  local protocol="$PREFIX/INSTALL_PROTOCOL.txt"
  {
    echo "MultiLogicTradePg Linux install protocol"
    echo "========================================"
    echo "Finished: $(date -Iseconds)"
    echo "Prefix:   $PREFIX"
    echo "DbMode:   $DB_MODE"
    echo "PG:       $PGHOST:$PGPORT"
    echo "Log:      $LOG_PATH"
    echo
    if [[ -f "$PREFIX/VERSION.txt" ]]; then
      echo "----- VERSION.txt -----"
      cat "$PREFIX/VERSION.txt"
      echo "----- end VERSION.txt -----"
    else
      echo "VERSION.txt: MISSING (old or incomplete package)"
    fi
    echo
    echo "---- install log ----"
    cat "$LOG_PATH"
  } >"$protocol"
  cp -f "$LOG_PATH" "$LATEST_LOG"
  ok "Protocol: $protocol"
}

# ---- main ----
step "MultiLogicTradePg Linux installer"
if [[ -f "$PACKAGE_ROOT/VERSION.txt" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    ok "$line"
  done <"$PACKAGE_ROOT/VERSION.txt"
else
  warn "VERSION.txt missing — package may be outdated"
fi
ok "Package: $PACKAGE_ROOT"
ok "Prefix:  $PREFIX"
ok "DbMode:  $DB_MODE"
ok "UpdateSslCerts: $UPDATE_SSL_CERTS"

if [[ ! -f "$PACKAGE_ROOT/01_multilogictrade_tables_and_data.sql" ]]; then
  echo "Package root looks incomplete: $PACKAGE_ROOT" >&2
  exit 1
fi

copy_tree_to_prefix
# After copy, operate on PREFIX
PACKAGE_ROOT="$PREFIX"

ensure_node
ensure_postgres
select_postgres_port
wait_postgres

HTTP_OK=0
if try_install_pgsql_http; then HTTP_OK=1; fi

deploy_database "$HTTP_OK"
if [[ "$UPDATE_SSL_CERTS" -eq 1 ]]; then
  update_ssl_certs_opt_in || warn "SSL CA update failed (non-fatal)"
fi
write_api_env
install_npm
install_launcher
write_protocol

step "Done"
ok "Start: $PREFIX/start-multilogic-trade.sh"
ok "UI:    http://localhost:4200"
ok "API:   http://localhost:3000"
ok "Protocol: $PREFIX/INSTALL_PROTOCOL.txt"

# Always open Angular UI after install unless --no-ui / MULTLOGIC_NO_UI=1.
if [[ "${MULTLOGIC_NO_UI:-0}" != "1" && " ${*} " != *" --no-ui "* ]]; then
  step "Opening MultiLogic Trade UI (API + Angular)"
  nohup bash "$PREFIX/start-multilogic-trade.sh" >/tmp/multilogic-trade-start.log 2>&1 &
  ok "Launcher started in background (log: /tmp/multilogic-trade-start.log)"
  ok "Browser should open http://localhost:4200 in ~30s"
else
  ok "Skipped UI start (MULTLOGIC_NO_UI=1 or --no-ui)"
fi
exit 0
