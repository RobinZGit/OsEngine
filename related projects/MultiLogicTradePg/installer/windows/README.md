# Windows installer

Ready-to-run single installer:

```text
installer/windows/dist/MultiLogicTradePgSetup.exe
```

This folder also contains the Inno Setup sources for MultiLogicTradePg.
The project builds one `MultiLogicTradePgSetup.exe` that copies the project to
`Program Files`, installs missing runtime dependencies, deploys the PostgreSQL
database, installs npm packages, and creates launch shortcuts.

## What the installer does

1. Copies the project files into:

   ```text
   C:\Program Files\MultiLogicTradePg
   ```

2. Checks runtime dependencies:

   - Node.js 18+.
   - PostgreSQL 15.

   If a dependency is missing, the post-install script tries to install it:

   - Node.js LTS via `winget` or Node.js MSI from `nodejs.org`.
   - PostgreSQL 15 via `winget` or EnterpriseDB installer.

3. Uses PostgreSQL superuser password:

   ```text
   111
   ```

4. Always deploys the database from scratch.
   Setup first searches local PostgreSQL ports (`5432`, an existing `api\.env`
   `PGPORT`, and nearby ports `5433`–`5440`) using user `postgres` and password `111`.
   Closed ports are skipped via a TCP probe + safe `psql` call (no abort on
   connection refused / IPv6 `::1`). If it
   finds an existing `multilogictrade`, it resets that exact server. Otherwise it
   creates the database on the first reachable local PostgreSQL server. Active
   connections to `multilogictrade` are terminated,
   `DROP DATABASE IF EXISTS multilogictrade WITH (FORCE)` is run, the database is
   created again, and only then scripts `01` and `02` are applied.

   ```text
   01_multilogictrade_tables_and_data.sql
   02_multilogictrade_functions_and_procedures.sql
   ```

   The installer also tries to install `pgsql-http` for the HTTP price-loading
   procedures. If `pgsql-http` cannot be installed, it deploys the core part of
   `02` and writes a warning to the install log.

5. Creates `api\.env` with local PostgreSQL/API settings.

6. Runs:

   ```powershell
   npm ci
   ```

   in both `api\` and `web\`.

7. Writes installation logs:

   ```text
   C:\Program Files\MultiLogicTradePg\INSTALL_PROTOCOL.txt
   C:\ProgramData\MultiLogicTradePg\install-latest.log
   ```

   `INSTALL_PROTOCOL.txt` contains the full post-install output and is the
   easiest file to send for diagnostics. Setup copies a placeholder protocol
   first, then runs post-install hidden through a small wrapper that overwrites
   the file immediately and captures PowerShell output/errors from the first
   line. The setup window remains visible and shows a short current status.
   During the hidden post-install step the progress bar is kept below 100% until
   the step finishes.

8. Creates shortcuts:

   - Desktop: `MultiLogic Trade`
   - Start Menu: `MultiLogic Trade\MultiLogic Trade`
   - Start Menu: `MultiLogic Trade\Install protocol`

   Both shortcuts run via `cmd.exe /k` (console stays open) and start:

   ```text
   web\MultiLogic_Trade_Progress_Start.bat
   ```

   That script refreshes PATH (so Node.js from Setup is visible without re-login),
   verifies that install-time `node_modules` exist, starts API on `:3000`,
   starts Angular on `:4200`, opens the browser, and keeps the window open until
   you press a key. It does not run `npm install`; package installation is an
   installer-time administrator task.

9. Shows a checked final-page checkbox to run MultiLogic Trade immediately after
   setup. There is also an optional unchecked checkbox to open the installation
   protocol.

## Reinstall behavior

When an existing MultiLogicTradePg installation is detected, setup asks:

- **Yes** — uninstall the old version and install from scratch. Database mode
  **wipe**: `DROP DATABASE` + fresh `01`→`02` (all data deleted).
- **No** — install over the existing folder (files + npm). Database mode
  **upgrade**: **no** `DROP DATABASE`; keep prices/trades/logics; re-run
  idempotent `01` (ADD COLUMN / indexes) then drop public routines and apply
  `02`. Close MultiLogic Trade windows before setup if they are open.
- **Cancel** — stop setup.

First install (no prior product) uses database mode **create**: create
`multilogictrade` only if missing, then `01`→`02` (never drops an existing DB).

The chosen PostgreSQL port is written to `api\.env`. Mode is also saved as
`installer\windows\db-mode.txt` and logged in `INSTALL_PROTOCOL.txt`.

Post-install also grants the Windows **Users** group modify rights on the
install folder (`web` / `api`) so `ng serve` can create `.angular\cache` under
`C:\Program Files\...` without EPERM when launched from a normal Desktop shortcut.

## Build the `.exe`

Install Inno Setup 6, then run from the repository root:

```powershell
.\installer\windows\build-installer.ps1
```

If Inno Setup is not installed and `winget` is available:

```powershell
.\installer\windows\build-installer.ps1 -InstallInnoSetup
```

Output:

```text
installer\windows\dist\MultiLogicTradePgSetup.exe
```

## Logs

The post-install script writes a ready-to-send protocol to:

```text
C:\Program Files\MultiLogicTradePg\INSTALL_PROTOCOL.txt
```

It also writes transcripts to:

```text
C:\ProgramData\MultiLogicTradePg\install-latest.log
C:\ProgramData\MultiLogicTradePg\install-YYYYMMDD-HHMMSS.log
```

If the installer cannot install Node.js, PostgreSQL, or npm packages, check this
log first.

## Notes for developers

- Keep `MultiLogicTradePg.iss` in sync when adding files that must ship with the
  installed application.
- Keep `scripts\install.ps1` in sync when the required runtime, PostgreSQL
  version, database deployment flow, or launch flow changes.
- If SQL scripts change, rebuild the installer so the `.exe` contains the new
  scripts.
