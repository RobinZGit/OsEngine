# MultiLogic FINRESP calculator — session notes (2026-06-08)

**Current page version:** `2026-06-08-selectall-fix`  
**Published:** https://robinzgit.github.io/OsEngine/multilogic/MultiLogic_FinrespCalculator.html

## File map

| Role | Path |
|------|------|
| Source (GitHub Pages) | `docs/multilogic/MultiLogic_FinrespCalculator.html` |
| Engine (shared logic) | `docs/multilogic/MultiLogic_FinrespCalculator.engine.js` |
| Local copy (OsEngine) | `project/OsEngine/bin/Debug/Custom/Robots/` (same filenames) |
| Local HTTP server | `serve-calculator.ps1` (docs + bin/Debug) |
| Robot help (separate) | `docs/multilogic/MultiLogic_LogicHelp.html` |

**Sync rule:** edit `docs/multilogic/`, then copy HTML + `.engine.js` to `bin/Debug/Custom/Robots/`.

---

## Commits in this session (`48be0b2` … `7ffe5ba`)

| Commit | Summary |
|--------|---------|
| `70a5c80` | Recalc when selection changes; merge incremental MOEX loads (`ensureInstrumentPacks`) |
| `14cffae` | Fix «select all shares»; `runBusyOwner` / `releaseRunBusy`; `enforceDateRange` on selection |
| `88e8113` | Fix stuck FINRESP `0` after bulk fail; `lastLoadMeta` only after success; cache ≥3 bars |
| `9e1566f` | `orderPacksForInstruments` fallback match by ticker; sync engine to bin/Debug |
| `7ffe5ba` | **Select-all root fix:** `maxCalcDays` uses `√n` + min warmup; widen period on deselect; `serve-calculator.ps1` |

Earlier related (already on main before this burst): tech info block (`48be0b2`), cache init / UI locks (`d05123d`), charts & annualize (`ac9889d`), candle cache (`c0ea1d3`).

---

## Problems we hit

1. **`file://`** — browser blocks MOEX (CORS). Cursor «Open with Browser» does not work for data load.
2. **«Выбрать все акции»** — period was narrowed to ~5 days (31 × 1h); strategy needs ~220+ bars → FINRESP `0`, all instruments skipped.
3. **After failed bulk** — period stayed narrow; single ticker also «did not calculate» until widened again.
4. **Stuck UI** — `uiBusy` / stale `lastLoadMeta` / old FINRESP on screen after errors.
5. **Local server** — `Connection reset` when old Python process on port 8765 was hung; use `--bind 127.0.0.1`.

---

## Key code changes (HTML)

### State
- `runGeneration`, `runBusyOwner`, `uiBusy` — concurrent run guard
- `lastLoadMeta` — `{ periodKey, keys }` set **only after successful load**
- `prevSelectCount` — detect shrink of selection
- `failedInstruments`, `windowSkipped`

### Loading
- `ensureInstrumentPacks()` — incremental load; merge with existing packs; clear failures on success
- `loadInstrumentPacks()` — concurrency `4` when >12 tickers (was 6)
- `tryRefreshFromLoadedPacks()` — instant recalc if all selected tickers already in memory and period unchanged

### Dates
- `maxCalcDays(tf, n)` — `floor(maxBars / (bpd × √n))`, min days from `MIN_WARMUP_BARS = 220`
- `enforceDateRange()` — narrows when many instruments selected
- `relaxDateRangeForInstrumentCount()` — **widens** when selection shrinks; clears `lastLoadMeta`

### Run flow
- `run()` — skip if `uiBusy` (with message); `finally { releaseRunBusy(runGen) }`
- `runWithInstruments()` — stale run via `runGeneration`; reset metrics on render fail

### UX / debug
- Tech info panel (`#tech-info-panel`) — `pageVersion`, protocol, cache, selection, errors; copy button
- `file://` warning banner + hint to run `serve-calculator.ps1`
- `CALC_PAGE_VERSION` — bump on each publish-worthy fix

## Key code changes (engine.js)

- `moexFetchJson()` — 45s timeout, CORS/`file://` hint in errors
- `moexFileProtocolHint()` — exported for UI
- Candle cache: accept entry only if `cached.length >= 3`

---

## How to run locally

```powershell
cd project\OsEngine\bin\Debug\Custom\Robots
.\serve-calculator.ps1
# → http://127.0.0.1:8765/MultiLogic_FinrespCalculator.html
```

Hard refresh: **Ctrl+F5**. Check tech block: `pageVersion=2026-06-08-selectall-fix`.

---

## Test checklist (next refinement)

- [ ] One share (e.g. SBER) — FINRESP + charts
- [ ] «Выбрать все акции» (31) — load ~29d on 1h, non-zero FINRESP
- [ ] After select-all → back to 1 share — period widens, Calculate works
- [ ] Change selection without Calculate — refresh if subset already loaded
- [ ] GitHub Pages vs local — same `pageVersion`
- [ ] 1m TF with many tickers — min days / MOEX load time acceptable?

---

## Not in scope / open

- `MultiLogic.cs` robot — not changed in this HTML session
- `bin/Debug` build artifacts, `node_modules`, logs — not committed
- Push was done to `origin/main` as of `7ffe5ba`

---

## Export commands (git)

```powershell
# Diff this session vs before tech-block work
git diff 48be0b2..HEAD -- docs/multilogic/

# Single file history
git log -p -- docs/multilogic/MultiLogic_FinrespCalculator.html

# Patch file for offline review
git format-patch 48be0b2..HEAD -o multilogic-patches/
```
