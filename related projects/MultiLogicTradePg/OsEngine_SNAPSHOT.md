# MultiLogicTradePg snapshot inside OsEngine

This folder is a full copy of https://github.com/RobinZGit/MultiLogicTradePg
(including the Windows installer sources and the built Setup.exe under
`installer/windows/dist/`).

It was added to the OsEngine repository because the Cursor Cloud agent
for OsEngine could not push directly to the separate MultiLogicTradePg
GitHub repository (write access is scoped to OsEngine; public repos not
selected in the Cursor GitHub App are read-only).

## Current state (2026-07-17)

| Item | Location / note |
|------|-----------------|
| Upstream repo | https://github.com/RobinZGit/MultiLogicTradePg (push from this agent often blocked) |
| This mirror | OsEngine `related projects/MultiLogicTradePg` on `main` |
| Context file | `docs/PROJECT_CONTEXT.md` — update before every push |
| Setup.exe | `installer/windows/dist/MultiLogicTradePgSetup.exe` (~2.2 MB) |
| Desktop launch | Shortcuts use `cmd.exe /k` → `web\MultiLogic_Trade_Progress_Start.bat` (API :3000 + Angular :4200; console stays open) |
| Postgres password (installer) | `111` |

Source installer workflow commit (local MultiLogicTradePg history): `141c7fa`  
OsEngine mirror commits: `23bc1ce` (snapshot), `f2e2496` (Setup.exe), `3683458` (launcher fix).
