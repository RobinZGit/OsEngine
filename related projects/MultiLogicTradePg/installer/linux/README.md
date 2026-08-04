# Linux installer (MacBook / Linux)

Ready-to-run package:

```text
installer/linux/dist/MultiLogicTradePg-linux.tar.gz
```

Built on Windows with:

```powershell
.\installer\linux\build-installer.ps1
```

Or both installers:

```powershell
.\installer\build-all-installers.ps1
```

## Install on Linux

```bash
tar -xzf MultiLogicTradePg-linux.tar.gz
cd MultiLogicTradePg
sudo ./installer/linux/install.sh
# or without root:
./installer/linux/install.sh --prefix "$HOME/MultiLogicTradePg"
```

### Options

| Flag | Meaning |
|------|---------|
| `--prefix DIR` | Install directory (`/opt/MultiLogicTradePg` if root, else `~/MultiLogicTradePg`) |
| `--db-mode wipe\|upgrade\|create` | Same semantics as Windows Setup (default `wipe`) |
| `--update-ssl-certs` | Opt-in: refresh system CA certs + `configure_http_ssl()` (off by default; Windows Setup checkbox) |
| `--postgres-password P` | postgres password (default `111`) |
| `--skip-deps` | Do not auto-install Node / PostgreSQL |
| `--skip-npm` | Skip `npm ci` |

### What it does

1. Copies the project into the prefix.
2. Ensures Node.js 18+ and PostgreSQL (apt / dnf / yum / pacman when possible).
3. Deploys `01` + `02` (core `02` if `pgsql-http` is missing).
4. Writes `api/.env`, runs `npm ci` in `api/` and `web/`.
5. Creates `start-multilogic-trade.sh` and a `.desktop` launcher.
6. Writes `INSTALL_PROTOCOL.txt` and a log under `/var/log/MultiLogicTradePg` or `~/.local/share/MultiLogicTradePg`.

### Start

```bash
/opt/MultiLogicTradePg/start-multilogic-trade.sh
# or
~/MultiLogicTradePg/start-multilogic-trade.sh
```

UI: http://localhost:4200 — API: http://localhost:3000

## Freshness

This archive must be rebuilt on every ship that changes SQL / API / UI / scripts / docs / installer sources — same rule as Windows `MultiLogicTradePgSetup.exe`. See `.cursor/rules/installer-freshness.mdc`.
