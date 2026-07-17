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

4. Deploys the database from scratch when the installer task is selected:

   ```text
   00_create_database.sql
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

7. Creates shortcuts:

   - Desktop: `MultiLogic Trade`
   - Start Menu: `MultiLogic Trade\MultiLogic Trade`

   Both shortcuts run via `cmd.exe /k` (console stays open) and start:

   ```text
   web\MultiLogic_Trade_Progress_Start.bat
   ```

   That script refreshes PATH (so Node.js from Setup is visible without re-login),
   starts API on `:3000`, Angular on `:4200`, opens the browser, and keeps the
   window open until you press a key.

## Reinstall behavior

When an existing MultiLogicTradePg installation is detected, setup asks:

- **Yes** — uninstall the old version and install from scratch.
- **No** — install over the existing folder.
- **Cancel** — stop setup.

The database-reset task is checked by default. When selected, `00` recreates the
`multilogictrade` database and deletes previous data.

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

The post-install script writes a transcript to:

```text
C:\ProgramData\MultiLogicTradePg\install.log
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
