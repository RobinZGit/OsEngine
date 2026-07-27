# Plan: OPT() on-the-fly formula optimization

**Status:** live runner ready for test (LinReg Fade Optimized)  
**Date:** 2026-07-26  
**Release note:** do **not** attach to GitHub `real-trade-1` unless Sergey asks.

## Goal

Mark numeric signal params for continuous ±% search while the logic runs (live + later backtest). Champion path stays real (may use stop-loss `is_shadow`). Challenger paths are a **new lane** — never broker orders, never mixed with test / stop-shadow / fake books.

## Syntax

```text
@LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10)) pp <= VALUE
```

- Base value: `std_dev=2`
- Optimize: `OPT(std_dev,10)` → name + shift % (10%)
- Nested parentheses allowed inside `@CODE(...)`

Aliases: `std` ↔ `std_dev` for OPT name resolution.

## Arms (combinatorial)

| OPT count `n` | Challenger arms | + champion | Total books |
|---------------|-----------------|------------|-------------|
| 1 | 2¹ = 2 (up, down) | 1 | 3 |
| 2 | 2² = 4 | 1 | 5 |
| 3 | 2³ = 8 | 1 | 9 |

Each challenger: for every OPT param, either **up** `base×(1+pct/100)` or **down** `base×(1−pct/100)`. No “center” in the 2ⁿ grid.

**Hard cap:** at most **3** distinct OPT param names across **all logics**. Saving a formula that would exceed → HTTP 400, list existing OPT usages, **do not save**.

## Isolation (`opt_lane`)

Column `logic_trades.opt_lane TEXT NOT NULL DEFAULT ''`:

- `''` — champion (real / fake / stop-shadow as today; `is_shadow` / `is_test` unchanged)
- `'std_dev:up'` — one param up
- `'std_dev:up|period:down'` — multi, sorted by param name

Also:

- Challengers: `is_simulated=TRUE`, **no** `tbank_post_order`, `is_test=FALSE`, `is_shadow=FALSE`
- Position qty / unique bar key / PnL summaries **must** filter by `opt_lane`
- UI badge: «опт ↑ std_dev» / «опт ↓ …»

## Logic param

| Key | Default | Meaning |
|-----|---------|---------|
| `opt_eval_candles` | `200` | After N closed TF candles, compare FinRes of champion vs each opt_lane (closes in window), promote best param values into formulas, reset window |

Service params: `last_opt_eval_bar_dt`, `opt_window_started_bar_dt` (optional).

## Promote

1. Window = last `opt_eval_candles` closed bars of logic TF (by `bar_dt`).
2. Score = sum(`financial_result`) of filled Close trades with matching `opt_lane` (and not test).
3. If best challenger beats champion (strict `>`): rewrite each `key=old` in formulas to winner’s numeric value; keep `OPT(key,pct)`; log `opt.promote`.
4. Close/reset challenger open positions (books-only); start new window.
5. Re-apply indicator params + sync for champion (and rebuild opt indicator cache if used).

## Indicator values for challengers

Shared `security_indicator_series` must not be overwritten by opt arms.

**Approach:** evaluate opt arms via formula expansion + `calc_ind_*` / temporary param overlay in `logic_signal_evaluate_at_opt(...)` without persisting champion series params. Champion keeps applying formula bases (numeric left of OPT).

## Seed

Logic **`LinReg Fade Optimized`** (copy of LinReg Fade signals) with:

```text
@LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10)) …
```

(same for UPPER/MIDDLE variants as LinReg Fade).

## Tests

- TS: parse nested `@CODE(...OPT(std_dev,10)...)`, extract opts, expand arms, 2ⁿ lane ids
- API/SQL: reject 4th OPT globally; allow save when replacing same logic’s OPT
- SQL: arm value math (2 ± 10% → 2.2 / 1.8)
- Runner smoke (optional): one bar champion + two lanes insert with distinct `opt_lane`

## Phases

1. **Foundation** — parser, schema, validation, param, seed, UI types/badges, unit tests  
2. **Live runner** — multi-lane process, paper opt trades, promote every N candles  
3. **Backtest** — same `opt_lane` in test runs (optional follow-up)

## Out of scope for v1

- Attaching to GitHub release `real-trade-1`
- OPT on non-indicator formula params (stops etc.)
- Full UI chart of opt equity curves (list badge + reason enough first)
