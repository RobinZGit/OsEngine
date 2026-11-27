# Классические индикаторные логики и производные аналоги / Classic indicator logics and derivative analogues

Branch: `opencode/classic-indicator-derivatives-study`. No commits or pushes were made.
Ветка `opencode/classic-indicator-derivatives-study`; коммитов и пушей нет.

---

## 1. Цель / Goal

**RU.** Собрать локальные классические примеры (цена vs средняя, Боллинджер, Келтнер, стохастик), построить для них аналоги на дискретных производных индикаторов и проверить на типичных российских акциях (Сбербанк, Газпром, нефть, металлургия, банки, ритейл), улучшают ли производные финансовый результат на M5/M15/H1.

**EN.** Collect local classic examples (price vs MA, Bollinger, Keltner, Stochastic), define discrete-derivative analogues, and test on typical Russian equities (Sberbank, Gazprom, oil, metallurgy, banks, retail) whether derivatives improve FinRes on M5/M15/H1.

---

## 2. Классические примеры, найденные локально / Local classic references

Источник — C# роботы и SQL-сиды репозитория; приоритет отдавался исполняемому коду, а не заголовкам комментариев. / Source — local C# robots and SQL seeds; executable code was treated as authoritative over header comments.

| Классическая логика / Logic | Файл / File | Тип / Type | Правило (код) / Rule (code) |
|---|---|---|---|
| `StrategyBollinger` | `project/OsEngine/Robots/CounterTrend/StrategyBollinger.cs` | counter-trend | BB(21, 2σ): short при `C > Up`, long при `C < Low`; выход long `C > SMA15`, short `C < SMA15` |
| `CountertrendBollinger` | `project/OsEngine/bin/Debug/Custom/Robots/CountertrendBollinger.cs` | counter-trend | BB(21, 1σ): long при `Low[-2] < LowBand[-2] && Low[-1] > LowBand[-1]`; short зеркально; выход на центральной линии `SMA21` |
| `BreakBollinger` | `project/OsEngine/bin/Debug/Custom/Robots/BreakBollinger.cs` | trend breakout | BB(21, 1σ): long `C > Up`, short `C < Low`; выход на противоположной полосе |
| `BollingerRevers` | `project/OsEngine/Robots/OnScriptIndicators/BollingerRevers.cs` | trend/reversal | BB(12, 2σ): вход за полосу, разворот по противоположной полосе |
| `FuturesStart2Keltner` | `project/OsEngine/Robots/FuturesStart/FuturesStart2Keltner.cs` | trend breakout | Keltner: `mid=EMA150`, `up/down=mid±3.9*EMA(ATR24)`; long `C > up`, short `C < down`, выход на противоположной полосе |
| `SmaCross` | `project/OsEngine/bin/Debug/Custom/Robots/SmaCross.cs` | trend cross | Истинный кросс `SMA9[-2] <= SMA21[-2] && SMA9[-1] > SMA21[-1]` (и наоборот) |
| `IntersectionOfTwoSma` | `project/OsEngine/bin/Debug/Custom/Robots/IntersectionOfTwoSma.cs` | trend state | `SMA100 > SMA200` → long; наоборот → short (состояние, не кросс) |
| `SmaStochastic` | `project/OsEngine/Robots/Trend/SmaStochastic.cs` | trend + contra-timing | long `C > SMA + Step && K[-2] <= 30 && K[-1] >= 30`; выход `C < SMA - Step` |
| `BreakStochastic` | `project/OsEngine/bin/Debug/Custom/Robots/BreakStochastic.cs` | trend cross | long `K[-2] < D[-2] && K[-1] > D[-1]`; short зеркально |
| `StochasticTrade` | `project/OsEngine/bin/Debug/Custom/Robots/StochasticTrade/StochasticTrade.cs` | counter-trend | `Kavg=SMA(K,3)`: long `Kavg < 20 && Kavg > K`; short `Kavg > 80 && Kavg < K`; разворот на противоположной зоне |
| `ContrtrendStochAndAroon` | `project/OsEngine/bin/Debug/Custom/Robots/ContrtrendStochAndAroon.cs` | counter-trend | long `AroonUp > 70 && K[-2] < 30 && K[-1] > 30`; выход `AroonUp < 60` |
| SQL-сиды | `related projects/MultiLogicTradePg/01_multilogictrade_tables_and_data.sql` (~строки 2486–2706) | упрощённые копии | `Bollinger Bounce`: `BB LOWER pp<VALUE` / `BB MIDDLE pp>VALUE`; `Bollinger Breakout`: `BB UPPER pp>VALUE`; `Stochastic Levels`: `K<20` → long, `K>50` → выход; `Dual MA Trend`: `C>SMA20 && C>EMA50` |

**Замечание.** Робота `StochasticContrtrend` в исходниках нет; ближайшие локальные аналоги — `StochasticTrade` и `ContrtrendStochAndAroon`. Во многих заголовках сказано «пересечение», а в коде — просто состояние «выше/ниже»; это важно при переносе критериев.
**Note.** No `StochasticContrtrend` source exists; closest are `StochasticTrade` and `ContrtrendStochAndAroon`. Many headers say “cross” while the code only tests above/below state.

---

## 3. Производные критерии / Derivative criteria

### 3.1. Определения / Definitions

Для индикатора `X` на бар `i` с шагом `Δt` (300 / 900 / 3600 с): / For indicator `X` at bar `i` with step `Δt` (300 / 900 / 3600 s):

- простая производная / discrete derivative: `dX_i = (X_i − X_{i−1}) / Δt`;
- нормированный наклон / normalized slope: `sX_i = (X_i / X_{i−1} − 1) · 100` (% за бар); порог в тесте ±0.05%;
- вторая производная / acceleration: `d²X_i = (dX_i − dX_{i−1}) / Δt`.

```
SMA_n(i) = mean(C[i−n+1..i]);  σ_n = stddev(C, n)
BB: Up = SMA_n + kσ, Low = SMA_n − kσ, Width = 2kσ, z = (C − SMA_n)/σ
Keltner: Mid = EMA_n(C), ATR_n, Up = Mid + k·ATR, Low = Mid − k·ATR
Stoch: K = 100·(C − LL_n)/(HH_n − LL_n), D = SMA_d(K)
```

Так как `Δt` внутри таймфрейма постоянно, знак `dX` совпадает со знаком разности; `Δt` нужен только для сопоставления наклонов между таймфреймами. / Since `Δt` is constant inside a timeframe, the sign of `dX` equals the sign of the difference; `Δt` only matters when comparing slopes across timeframes.

### 3.2. Соответствие классическим правилам / Mapping to classic rules

| Классика / Classic | Производный «тренд» / Derivative trend | Производный «контр-тренд» / Derivative counter | Гибрид / Hybrid |
|---|---|---|---|
| `C < SMA` → buy, `C > SMA` → sell | **`dSMA > 0` → buy, `dSMA < 0` → sell** (ваша формулировка; фактически трендовое правило) | `dSMA < 0` → buy, `dSMA > 0` → sell (логический аналог «покупаем ниже средней») | `C < SMA && dSMA > 0` → buy |
| Cross `C` через SMA | `dSMA`_cross_zero (`dSMA_i>0 && dSMA_{i−1}<=0`) | обратный кросс | — |
| Bollinger breakout: `C > Up` | `dSMA > 0 && dWidth > 0` | — | `C > Up && dSMA > 0` |
| Bollinger counter: `C < Low` | — | `z < −1 && dz > 0`; либо `dSMA < 0 && dWidth < 0` | `C < Low && dSMA > 0` |
| Keltner breakout: `C > Up` | `dEMA > 0` | — | `C > UpK && dEMA > 0` |
| Keltner counter: `C < Low` | — | `dEMA < 0 && dATR < 0` | `C < LowK && dEMA > 0` |
| Stoch cross `K/D` | `dK` sign; `dK > 0 && K > 50` | — | — |
| Stoch levels 20/80 | — | `dK > 0 && K < 20` → buy; `dK < 0 && K > 80` → sell | — |
| Ускорение / acceleration | `d²SMA` разворот наклона | — | — |

**Важно / Important.** Предложенное в задании соответствие «ниже средней ⇒ покупаем» → «наклон больше нуля ⇒ покупаем» не является аналогом контр-тренда: это уже трендовое правило. Проверены оба знака (`d_ma_slope_pos` и `d_ma_slope_neg`).
The proposed mapping “below MA ⇒ buy” → “slope > 0 ⇒ buy” is not a counter-trend analogue; it is a trend rule. Both signs were tested (`d_ma_slope_pos`, `d_ma_slope_neg`).

---

## 4. Методика проверки / Test setup

- **Бумаги / Universe (17):** Сбербанк 29/34, ВТБ 13; Газпром 28, Лукойл 27, Роснефть 26, НОВАТЭК 25, Татнефть 23, Сургутнефтегаз 22; Северсталь 19, НЛМК 18, ММК 17, Норникель 24, Мечел 16; Магнит 15, МТС 14, АФК Система 1. RIS `[id|name]` взят из таблицы `securities`.
- **Период / Period:** 2026-10-01 … 2026-11-05. M5/M15 — реальные свечи из локального экспорта; **H1 синтетический, ресемплирован из M5 — только индикативно**.
- **Управление / Money management:** long-only, 10% депозита на позицию, максимум 10 позиций, комиссия 0.03% на сторону, закрытие в конце дня — как в модели движка `logic_backtest_fill_at` (`position_size_pct=10`, `max_open_positions=10`, `free_cash`).
- **Исполнение / Fills:** `close` = по цене закрытия сигнального бара (идеализированный режим, как `exec_delay_sec=0`); `next` = по закрытию следующего бара того же торгового дня (консервативный режим). Это **не** точная эмуляция задержки 30 с движка; выводы относятся к внутренней модели FinRes.
- **Калибровка / Calibration:** контрольный прогон модели для конфигурации логики `10875` (`LOWER20` вход / `UPPER20` выход, M5, delay0, 42 бумаги) дал +93 273 при 641 сделке, тогда как движок дал +24 349 при 570 сделках (`%TEMP%\opencode\classic\validate.js`). Модель **не откалибрована по движку** (лотность, free-cash sizing, набор бумаг), поэтому сравнимы только относительные результаты внутри одного прогона, но не абсолютные FinRes. / The model is **not engine-calibrated**; only relative rankings inside one run are meaningful, not absolute FinRes values.
- **Параметры / Parameters:** SMA/EMA/ATR/BB `n=20`, `k=2`, Stoch `14/3/3`; чувствительность проверена при `n=10` и `n=30`.
- **Код / Scripts:** `%TEMP%\opencode\classic\study.js`, `report.js`, `coverage.js`; результаты `study_results.json`, `study_n10.json`, `study_n30.json`, `report.md`, `study_summary.txt`.

---

## 5. Результаты / Results

FinRes в рублях на стартовый депозит 1 000 000. / FinRes in RUB on 1,000,000 starting equity.

### 5.1. Лучшие правила по таймфреймам / Best rules per timeframe (реалистичное исполнение `next`)

| TF | Лучшая классика / Best classic | FinRes next | Сделки | Лучшая производная / Best derivative | FinRes next | Сделки |
|---|---|---:|---:|---|---:|---:|
| M5 | `cl_kelt_counter` | −944 | 344 | `d_boll_revert_turn` (гибрид) | −5 409 | 43 |
| M15 | `cl_kelt_counter` | **+53 535** | 333 | `d_stoch_counter` | **+21 504** | 479 |
| H1 (синт.) | `cl_kelt_counter` | +1 759 | 32 | `d_ma_cross_zero` | +1 663 | 58 |

Ключевые производные rules / Key derivative rules:

| TF | `d_ma_slope_pos` (ваш знак / your sign) | `d_ma_slope_neg` (контр-знак / counter sign) | `d_stoch_counter` | `d_ma_cross_zero` | `cl_kelt_counter` (эталон) |
|---|---:|---:|---:|---:|---:|
| M5 | −192 987 | −123 801 | −24 606 | −184 776 | −944 |
| M15 | −126 641 | −51 841 | +21 504 | −131 361 | +53 535 |
| H1 | −9 361 | −29 628 | −6 269 | +1 663 | +1 759 |

**Идеализированный режим `close` создаёт хорошо знакомый артефакт / Idealized `close` fill creates the familiar artifact:** например `cl_stoch_counter` M5 даёт +44 919 при исполнении по закрытию сигнального бара, но −29 962 при исполнении на следующий бар; `cl_ma_counter` M15: +133 948 → −73 775. Производные не получают этого бонуса, потому что их сигналы не привязаны к экстремуму бара. / Derivative signals are not tied to the bar extreme, so they do not receive this bonus.

### 5.2. Сравнение по группам бумаг / Group comparison (next-bar fill, сумма FinRes по бумагам)

| TF | Группа / Group | Лучшая классика | FinRes | Лучшая производная | FinRes | Дельта |
|---|---|---|---:|---|---:|---:|
| M5 | Сбер/банки | `cl_kelt_counter` | −2 600 | `d_boll_revert_turn` | +2 117 | +4 717 |
| M5 | Нефть/газ | `cl_boll_counter` | −23 480 | `d_boll_revert_turn` | −4 671 | +18 808 |
| M5 | Металлургия | `cl_kelt_counter` | +4 616 | `d_stoch_counter` | +5 811 | +1 194 |
| M5 | Ритейл/телеком | `cl_boll_counter` | +6 773 | `d_boll_revert_turn` | −1 008 | −7 781 |
| M15 | Сбер/банки | `cl_kelt_counter` | +1 099 | `d_ma_slope_thresh` | +1 509 | +410 |
| M15 | Нефть/газ | `cl_boll_counter` | +18 940 | `d_boll_z_revert` | +2 953 | −15 987 |
| M15 | Металлургия | `cl_kelt_counter` | +20 892 | `d_stoch_counter` | +19 422 | −1 470 |
| M15 | Ритейл/телеком | `cl_boll_counter` | +10 819 | `d_ma_slope_thresh` | +4 869 | −5 950 |
| H1 | Сбер/банки | `cl_boll_trend` | +135 | `d_ma_cross_zero` | +1 227 | +1 092 |
| H1 | Нефть/газ | `cl_kelt_counter` | +2 273 | `d_stoch_counter` | +278 | −1 996 |
| H1 | Металлургия | `cl_kelt_counter` | −2 872 | `d_ma_cross_zero` | +78 | +2 950 |
| H1 | Ритейл/телеком | `cl_ma_cross` | +3 623 | `d_bollwidth_counter` | +5 246 | +1 623 |

### 5.3. Отдельные бумаги / Selected securities (next-bar fill)

| Бумага / Security | M5: классика → производная | M15: классика → производная | H1: классика → производная |
|---|---:|---:|---:|
| Сбербанк (29) | −771 → +1 199 | +1 361 → +387 | −197 → +406 |
| Газпром (28) | −2 891 → +2 020 | +4 164 → +3 753 | −1 031 → +775 |
| Лукойл (27) | −1 598 → 0 (нет сделок) | +3 417 → +5 905 | +2 622 → −647 |
| Роснефть (26) | −2 141 → +404 | +1 148 → −3 609 | +5 → +1 427 |
| НЛМК (18) | +4 390 → +4 309 | +4 616 → +5 782 | +878 → +1 794 |
| Северсталь (19) | −77 → +3 150 | +5 909 → +4 215 | +1 013 → +1 158 |
| Магнит (15) | +3 525 → +6 369 | +10 493 → +10 121 | +2 336 → +3 835 |
| ВТБ (13) | −2 532 → 0 | +4 451 → +3 211 | +1 941 → +2 599 |

Полные таблицы по всем 17 бумагам и 27 критериям: `%TEMP%\opencode\classic\report.md` и `study_results.json`.

### 5.4. Чувствительность / Sensitivity to MA period

| TF | `n=10` | `n=20` | `n=30` |
|---|---:|---:|---:|
| M5: лучшая классика / best classic | −643 | −944 | +317 |
| M5: лучшая производная / best derivative | −24 606 | −16 667 | −4 587 |
| M15: лучшая классика / best classic | +36 726 | +53 535 | +47 998 |
| M15: лучшая производная / best derivative | +21 504 | +21 504 | +21 504 |
| H1: лучшая классика / best classic | −1 682 | +1 759 | +5 726 |
| H1: лучшая производная / best derivative | −3 811 | +1 663 | +6 435 |

Вывод: `d_stoch_counter` на M15 стабильно положителен (параметры стохастика не менялись), но всегда уступает классическому Keltner counter. `d_ma_cross_zero` на H1 меняет знак при `n=10` → результат не робастный.
`d_stoch_counter` on M15 is stably positive (Stoch params fixed) but always below classic Keltner counter; `d_ma_cross_zero` on H1 flips sign at `n=10` → not robust.

---

## 6. Выводы / Conclusions

**RU.**

1. **Производные индикаторы сами по себе не улучшили FinRes.** На M5 все производные критерии отрицательны при реалистичном исполнении; на M15 лучшая производная (`d_stoch_counter`, +21,5k) почти вдвое хуже классического Keltner counter (+53,5k); на H1 устойчивого преимущества нет, а свечи синтетические.
2. **По группам картина та же:** на M5 «преимущество» производных есть в 3 из 4 групп, но классика там тоже в минусе (улучшение = меньший убыток); на M15 производные не выиграли ни в одной группе — это единственный таймфрейм с устойчиво положительной классикой; на H1 «победы» в 3 группах копеечные и объясняются синтетическими свечами.
3. **Предложенная формулировка знака неверна для контр-тренда.** `dSMA > 0 → buy` — трендовое правило и даёт худшие результаты (−193k на M5, −127k на M15). Обратный знак `dSMA < 0 → buy` лучше, но тоже отрицателен.
4. **Стохастический «разворот из зоны перепроданности» — единственный полезный производный критерий:** `K < 20 && dK > 0` даёт положительный FinRes на M15 и высокий средний результат сделки +0.106%, но уступает классике по количеству сделок и итогу.
5. **Гибриды (уровень + подтверждение наклоном) не помогли:** `d_boll_revert_turn`, `d_ma_counter_turn`, `d_boll_break_slope` отрицательны или не дают сделок.
6. **Практика:** оставить классические level-правила (Keltner/Bollinger counter) как базу; производный наклон использовать только как дополнительный фильтр и только после проверки на других периодах/бумагах. H1-результат требует настоящих часовых свечей.
7. **Оговорки:** внутренняя модель FinRes, а не прогон движка; модель не откалибрована (контроль: +93,3k против +24,3k у движка для `10875`); нет точной задержки 30 с, лотности, проскальзывания и реального H1; один период 2026-10-01..11-05. Поэтому вывод — именно относительный: производные критерии не дали преимущества над классикой в одинаковых условиях.

**EN.**

1. **Derivative indicators alone did not improve FinRes.** On M5 all derivative criteria are negative with realistic fills; on M15 the best derivative (`d_stoch_counter`, +21.5k) is less than half the classic Keltner counter (+53.5k); on H1 there is no reliable edge and candles are synthetic.
2. **By group the picture is the same:** on M5 derivatives “win” in 3 of 4 groups, but classics are negative there too (a smaller loss); on M15 derivatives win in no group — the only timeframe with robustly positive classics; on H1 “wins” are tiny and rest on synthetic candles.
3. **The proposed sign mapping is not counter-trend.** `dSMA > 0 → buy` is a trend rule and performs worst (−193k M5, −127k M15). The inverted sign `dSMA < 0 → buy` is better but still negative.
4. **Stochastic turn-from-oversold is the only useful derivative criterion:** `K < 20 && dK > 0` is positive on M15 with avg trade +0.106%, yet still below the classic level rule.
5. **Hybrids (level + slope confirmation) did not help:** `d_boll_revert_turn`, `d_ma_counter_turn`, `d_boll_break_slope` are negative or produce no trades.
6. **Practical recommendation:** keep classic Keltner/Bollinger counter rules; use slope only as an extra filter after out-of-sample checks. The H1 result needs real hourly data.
7. **Caveats:** internal FinRes model, not an engine run and not calibrated (control: +93.3k vs engine +24.3k for `10875`); no exact 30-second delay, lot size, slippage, or real H1 data; single test period. The conclusion is therefore relative: derivative criteria gave no edge over classic ones under identical conditions.

---

## 7. Воспроизводимость / Reproduction

- Branch `opencode/classic-indicator-derivatives-study`, created from `opencode/logic-10779-shifted-m5-study`; no commits, no push.
- Исходные скрипты и результаты / Scripts and artifacts:
  - `%TEMP%\opencode\classic\coverage.js` — покрытие цен по бумагам/таймфреймам;
  - `%TEMP%\opencode\classic\study.js` — расчёт индикаторов, производных и внутренний FinRes (`IND_N`, `STOCH_N`, `OUT` через env);
  - `%TEMP%\opencode\classic\report.js` → `report.md` — итоговые таблицы;
  - `%TEMP%\opencode\classic\validate.js` — контрольная сверка модели с движком (`10875`);
  - `%TEMP%\opencode\classic\combo_report.js` → `combo_report.md` — совместные сигналы индикатора и производной;
  - `%TEMP%\opencode\classic\study_results.json`, `study_n10.json`, `study_n30.json`, `study_results_precombo.json`, `study_n10_combo.json`, `study_n30_combo.json` — сырые результаты.
- Оригинальные логики 10779/10780 и тестовые копии не менялись. / Original logics 10779/10780 and earlier test copies were not modified.

---

## 8. Проверка в движке / Engine validation (дополнение)

Созданы две **отключённые** тестовые копии логики 10779: `10970` (`TEST_deriv_square_slope_pos`) и `10971` (`TEST_deriv_square_slope_neg`). Сигналы:

```text
@SQUARE(period=20,std_dev=2,series=SLOPE) VALUE > 0  → open long   (10970)
@SQUARE(period=20,std_dev=2,series=SLOPE) VALUE < 0  → close long  (10970)
@SQUARE(period=20,std_dev=2,series=SLOPE) VALUE < 0  → open long   (10971)
@SQUARE(period=20,std_dev=2,series=SLOPE) VALUE > 0  → close long  (10971)
```

`SQUARE:SLOPE` — настоящая производная квадратичной регрессии `a + 2·c·x` (`calc_ind_square_array`). Прямой `LINREG:SLOPE` в on-the-fly режиме движка недоступен: `logic_opt_linreg_series_at` возвращает только `MIDDLE/UPPER/LOWER`. В условии используется токен `VALUE` (SQL-функция `evaluate_signal_condition` подставляет только `pp` и `VALUE`), а `series=SLOPE` выбирает нужную серию индикатора.

Запуск/опрос / Start + poll:

```powershell
$body = @{ logic_id = 10970; date_from = '2026-10-01'; date_to = '2026-11-05';
           exec_delay_sec = 30; close_all_at_end = $true } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://localhost:3000/api/logic-backtest/start' -Method Post -Body $body -ContentType 'application/json'
Invoke-RestMethod -Uri 'http://localhost:3000/api/logic-backtest/status?logic_id=10970&run_id=57'
```

`financial_result` в `/status` — сумма `logic_trades.financial_result` для `is_test=true`, `run_id=<id>` (исключая shadow/OPT-лэйны). Состояние прогона и финальные результаты сохраняются в `%TEMP%\opencode\classic\engine_run*.json`. / The run status and final results are saved there.

**Результат 10970 / Run 10970 result:** run `57` завершён `2026-11-26T12:08:52Z`; `financial_result = −60 293.61`, `trades_created = 2 002`, `exec_delay_sec = 30`, период `2026-10-01..2026-11-05`. Трендовый вариант `SQUARE:SLOPE > 0 → buy` в движке подтвердил отрицательный результат, соответствующий internal screen (`d_ma_slope_pos` давал −193k на M5).

**Результат 10971 / Run 10971 result:** run `58` завершён `2026-11-26T12:48:20Z`; `financial_result = −7 654.14`, `trades_created = 378`, `exec_delay_sec = 30`, период `2026-10-01..2026-11-05`. Обратный знак `SLOPE < 0 → buy` лучше трендового варианта, но также отрицателен и подтверждающий тест не опроверг вывод внутреннего скрининга: производная наклона не добавила FinRes. / The inverse `SLOPE < 0 → buy` is better than the trend variant but still negative; the engine confirmation agrees with the internal screen.

**EN:** Run `57` completed `2026-11-26T12:08:52Z` with `financial_result = −60,293.61`, `2,002` trades, `exec_delay_sec=30`, window `2026-10-01..2026-11-05`. The trend variant `SQUARE:SLOPE > 0 → buy` confirms the negative internal-screen result. Run `58` (logic `10971`, `SLOPE < 0 → buy`) completed `2026-11-26T12:48:20Z` with `financial_result = −7,654.14` and `378` trades: the inverse sign is better but still negative.

**Все использованные цены / All prices used:** полный срез OHLC (89 703 строки: M5 47 035, M15 41 092, H1 1 576) сохранён рядом с HTML-отчётом как `RESEARCH_classic_indicator_derivatives_prices.csv` и в `%TEMP%\opencode\classic\research_prices_used.csv`. / The full OHLC slice is saved next to the HTML report as `RESEARCH_classic_indicator_derivatives_prices.csv` and in `%TEMP%\opencode\classic\research_prices_used.csv`.

---

## 9. Одновременные сигналы индикатора и производной / Simultaneous classic + derivative signals

**RU.** По просьбе отдельно проверено совместное использование классического сигнала и производного. Для 14 пар «классика + производная» проверены три режима (всего 42 комбинации):
**EN.** A separate check was added for simultaneous classic + derivative signals. For 14 pairs, three modes were tested (42 combinations):

- `both` — вход и выход только когда оба сигнала совпадают (AND/AND);
- `gate` — классический сигнал разрешён, если производная не противоречит (veto производной / derivative veto);
- `exitany` — вход по обоим, выход по любому (AND entry / OR exit).

Условия те же: 17 бумаг, 2026-10-01..11-05, next-bar fill, internal FinRes. / Same universe, period and conservative next-bar fill.

### 9.1. Итоги по таймфреймам / Aggregate results (`next`)

| TF | Лучшая комбинация / Best combo | FinRes | Сделки | Лучшая классика / Best classic | FinRes | Лучшая производная / Best derivative | FinRes |
|---|---|---:|---:|---|---:|---|---:|
| M5 | `cmb_boll_counter__boll_z_revert_gate` | −1 430 | 503 | `cl_kelt_counter` | −944 | `d_boll_revert_turn` | −5 381 |
| M15 | `cmb_boll_counter__boll_z_revert_gate` | **+36 979** | 512 | `cl_kelt_counter` | **+53 535** | `d_stoch_counter` | +21 504 |
| H1 (синт.) | `cmb_ma_cross__ma_cross_zero_exitany` | +4 163 | 24 | `cl_kelt_counter` | +1 759 | `d_ma_cross_zero` | +1 663 |

### 9.2. Чувствительность к периоду / Sensitivity to MA period

| TF | `n=10`: комбинация / классика | `n=20` | `n=30` |
|---|---:|---:|---:|
| M5 | +2 049 / −643 | −1 430 / −944 | +3 267 / +2 265 |
| M15 | +27 456 / +36 726 | +36 979 / +53 535 | +37 630 / +47 998 |
| H1 | +246 / −1 682 | +4 163 / +1 759 | +6 109 / +5 726 |

### 9.3. Группы бумаг / Groups (`n=20`, next, сумма FinRes по бумагам)

| TF | Группа / Group | Комбинация | Классика | Дельта |
|---|---|---:|---:|---:|
| M5 | Сбер/банки | +2 117 | −2 600 | +4 717 |
| M5 | Нефть/газ | −73 | −23 480 | +23 406 |
| M5 | Металлургия | +7 795 | +4 616 | +3 178 |
| M5 | Ритейл/телеком | +6 825 | +6 773 | +52 |
| M15 | Сбер/банки | +1 087 | +1 099 | −12 |
| M15 | Нефть/газ | +21 228 | +18 940 | +2 289 |
| M15 | Металлургия | +19 422 | +20 892 | −1 470 |
| M15 | Ритейл/телеком | +10 819 | +10 819 | 0 |
| H1 | Сбер/банки | +2 955 | +135 | +2 820 |
| H1 | Нефть/газ | +850 | +2 273 | −1 423 |
| H1 | Металлургия | +3 031 | −2 872 | +5 903 |
| H1 | Ритейл/телеком | +3 623 | +3 623 | 0 |

### 9.4. Наблюдения / Observations

**RU.**

1. **`gate` часто вырождается в классику.** `cmb_boll_counter__boll_z_revert_gate` даёт **идентичные** FinRes и число сделок, что и `cl_boll_counter` на всех трёх таймфреймах: производное условие почти никогда не запрещает сигнал. Это не синергия, а тот же самый уровень-фильтр.
2. **`both` со стохастиком — это просто `d_stoch_counter`.** На M15 +21 504, но всё равно почти вдвое ниже классического Keltner counter (+53 535).
3. **`exitany` резко сокращает сделки и ухудшает результат.** Например на M5 `cmb_boll_counter__ma_slope_pos_exitany` — всего 47 сделок и −2 376 против 503 сделок у классики; ранний выход по производной режет прибыль.
4. **На M5 комбинации могут выйти в плюс, но нестабильно:** при `n=10` и `n=30` они обыгрывают классику, при `n=20` — нет. На M15, самом надёжном таймфрейме, комбинации ни при каких `n` не обыгрывают классику.
5. **H1-преимущество не надёжно:** «победа» комбинации на H1 основана на 24 сделках и синтетических часовых свечах.
6. **Итог:** одновременное использование не даёт робастного прироста. Классический уровень остаётся базой; производная полезна лишь как редкий veto и только после out-of-sample проверки.

**EN.**

1. **`gate` often degenerates to the classic rule.** `cmb_boll_counter__boll_z_revert_gate` produces **identical** FinRes and trade counts to `cl_boll_counter` on all three timeframes: the derivative condition almost never vetoes. This is the same level filter, not synergy.
2. **`both` on Stochastic is just `d_stoch_counter`.** On M15 it gives +21.5k, still less than half of classic Keltner counter (+53.5k).
3. **`exitany` sharply reduces trades and hurts results.** On M5 `cmb_boll_counter__ma_slope_pos_exitany` has only 47 trades and −2.4k versus 503 trades for the classic rule; early derivative exit cuts winners.
4. **On M5 combos can be positive but not stable:** they beat classic at `n=10` and `n=30`, but not at `n=20`. On M15 — the most reliable timeframe — combos never beat classic at any `n`.
5. **The H1 edge is not reliable:** it rests on 24 trades and synthetic hourly candles.
6. **Conclusion:** simultaneous use gives no robust gain. Keep the classic level rule as the base; use the derivative only as a rare veto and only after out-of-sample validation.

Подробные таблицы: `%TEMP%\opencode\classic\combo_report.md`, `combo_report_n10.md`, `combo_report_n30.md`; сырые данные — `study_results.json`, `study_n10_combo.json`, `study_n30_combo.json`. / Detailed tables and raw data are in those files.
