# MultiLogicTradePg — контекст проекта

> Живой файл контекста для продолжения работы с разных устройств и в Cursor.  
> **Обновлять перед каждым push в репозиторий** — см. `.cursor/rules/project-context.mdc`.
> Включать **запросы пользователя текстом** (секция «Запросы пользователя»).

**Репозиторий (upstream):** https://github.com/RobinZGit/MultiLogicTradePg  
**Зеркало в OsEngine (куда пишет Cloud Agent):** `related projects/MultiLogicTradePg` в https://github.com/RobinZGit/OsEngine  
**Последнее обновление:** 2026-07-21 — Indicator LINREGV (variable period) + logic LinRegV Fade (clone of LinReg Fade)

> **Важно для агентов:** push в отдельный `RobinZGit/MultiLogicTradePg` из Cloud Agent на OsEngine **недоступен** (`cursor[bot]` write scoped to OsEngine; публичный репо без выбора в GitHub App = read-only). Рабочая копия с installer живёт в **OsEngine** → `related projects/MultiLogicTradePg`. Синхронизацию в upstream MultiLogicTradePg делать вручную или новым агентом, запущенным на том репозитории.

---

## Цель проекта

Перенос торговой системы **MultiLogic Trade** с Angular (логика в приложении) на **PostgreSQL-first**:

- расчёт индикаторов, загрузка цен, торговые правила — в БД;
- **Angular** — визуальные формы и вызовы API/SQL.

Биржа: **MOEX** (акции + фьючерсы), источники цен: **T-Bank API** и **MOEX ISS** (через расширение `pgsql-http`).

---

## Структура SQL-скриптов (порядок запуска)

| Файл | Назначение |
|------|------------|
| `00_create_database.sql` | **DROP + CREATE** базы `multilogictrade` (полное пересоздание) |
| `01_multilogictrade_tables_and_data.sql` | Таблицы, индексы, справочники (идемпотентно, **v46**) |
| `02_multilogictrade_functions_and_procedures.sql` | Функции и процедуры (идемпотентно) |
| `03_multilogictrade_examples.sql` | Примеры SELECT (необязательно) |

Устаревший монолит: `multilogictrade_full_database.sql` (v11) — только для истории.

**Полный цикл «с нуля»:** `00` → `01` → `02`. Для проверки скриптов без сброса данных — `npm run verify:sql`.

---

## Ключевые решения схемы (v12+)

### Префиксы акций и фьючерсов

- уникальность: `(security_id, exchange_id)`, не глобально по `prefix`;
- `instrument_market`: `stock` | `futures` | `bonds` | `index`;
- **Групповые фьючерсы** (Si, CR→CNY): префикс группы в `security_prefixes` (`CR`, `Si`);
- **Вечные фьючерсы** (`CNYRUBF`, `USDRUBF`, …): префикс = тикер группы, **без** rollover по контрактам;
- **`futures_expirations`** — **runtime-кэш** контрактов (пустая после `00`/TRUNCATE; заполняется `sync_futures_expirations_from_moex` при загрузке);
- поля контракта: `prefix` (SHORTNAME, напр. `CNY-9.26`), **`moex_secid`** (SECID, напр. `CRU6`), `expiration_date`, `tbank_figi`;
- **`prices.contract_prefix`** — какой контракт дал свечу при rollover.

### Загрузка цен (фьючерсы)

- `load_prices_futures_http` — обход контрактов от `date_to` назад (rollover);
- `sync_futures_expirations_from_moex` — список FORTS с MOEX ISS → UPSERT в `futures_expirations`;
- T-Bank **FutureBy** — сначала `moex_secid` (`CRU6`), затем `prefix` (`CNY-9.26`);
- MOEX candles URL — по **SECID**, не SHORTNAME;
- `load_prices_http` — вечные → T-Bank/MOEX по `CNYRUBF` из `security_prefixes` (не из `futures_expirations`);
- **MOEX FORTS не отдаёт M15/M5/…** (только 1, 10, 60, 24, 7, 31, 4) → `load_prices_from_moex_http` вызывает **M1 + resample** (`load_prices_moex_via_m1_resample`);
- `moex_future_asset_code`: CR→CNY, GD→GOLD, SV→SILV, MX→MIX, RI→RTS, …;
- открытие позиции по фьючерсу: если `% депозита / цена` даёт 0 → **1 лот** (бой и тест);
- таймауты: `lock_timeout` / `statement_timeout` в API и SQL (защита от зависаний).

### Проверка SQL перед сборкой

- `scripts/verify-sql.mjs`, `npm run verify:sql` в `web/` (`prebuild`);
- CI: `--core-only` (без HTTP/pg_cron); маркеры `@optional-pgcron-block`, `@optional-http-block` в `02`.

### UI

- Angular `web/` + Express `api/`;
- прокручиваемые списки — правило `.cursor/rules/scrollable-lists.mdc`;
- **редактируемое не refresh'ить** — poll не перезаписывает черновики с кнопкой «Сохранить» — `.cursor/rules/no-refresh-while-editing.mdc`;
- панель цен: `contract_prefix`, `group_prefix`, остановка после пустых периодов по `records_loaded`.

### Индикаторы и logics

- справочник `indicators` (32 шт.: + **SMAT3**), классические + **PACC** + пользовательские через `formula`;
- **`indicators.sig_trend_def`**, **`indicators.sig_ct_def`** — условия тренда/контртренда по умолчанию (на сериях: `VALUE > 50`, `pp > VALUE`, …);
- **`logic_indicator_signals`** — сигналы на логике: **`position_event`** open|close, **`position_side`** long|short, **`signal_kind`** trend|counter, `formula`, **`rating`** / **`rating_test`** (могут быть &lt;0; агрегат по всем бумагам; не рейтинг справочника `indicators`);
- **AND:** сделка только если **все** активные сигналы одной группы `(position_event × position_side)` сработали; OR → отдельные logics;
- **`logic_signal_rating_pending`** + **`logic_signal_rating_history`**: сработал → pending; на **следующей** свече ход → **% годовых** vs **`base_annual_rate_pct`** (дефолт 20) → `±1`; history с `logic_id`+`security_id`+`signal_id` для графика **на бумаге**;
- **Бэктест Стоп:** `cancel` сразу ставит `status=cancelled`, результат теста **не удаляется**; UI не висит на «Останавливаю…»;
- **`logic_stops`** — стоп-лосс и тейк-профит по логике (`rule_kind` stop_loss|take_profit, `scope_type` security|portfolio|security_resume, `value`, `value_unit` percent|atr);
- **`logic_securities`** — портфель бумаг логики (`logic_id`, `security_id`, `display_order`, `is_active`);
- **`logic_trades`** — сделки: `position_event`, `signal_kind`, `is_simulated`, **`is_fictitious`**, `commission`, **`financial_result`** (только Close), **`run_id`** (прогон теста → `logic_backtest_runs`; NULL у боя), `bar_dt`, `status`; side Open/Close через `sides`; уникальность бара: `(logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow)`;
- **`logic_trade_lots`** — пакеты закрытия (FIFO / средняя): связь close↔open, суммы, комиссии, PnL по пакету;
- **`logic_param_defs`** + **`logic_params`** — параметры торговли (EAV): **`timeframe`**, `position_size_pct`, `max_open_positions`, `initial_balance`, `current_balance`, **`commission_pct`**, **`cost_method`** (FIFO|AVERAGE), **`base_annual_rate_pct`**, **`cash_fund_code`** / **`cash_fund_threshold`** (порог **equity**, не только кэша) / **`last_cash_fund_bar_dt`** (`logic_park_excess_cash` / `logic_backtest_park_excess_cash`: BUY `min(кэш, equity−порог−уже_в_фонде)`), `last_trade_check_at`;
- **Общие настройки (шестерёнка):** `APP_CLEANUP_DISK` + `cleanup_trading_disk_space()` / `run_cleanup_if_enabled()`; pg_cron 03:30 + Node `maintenance-scheduler.js`; API cleanup; иконка БД → схема, шестерёнка → настройки;
- **`indicators.formula`** — многочлен для `calc_poly_formula_array`; **`is_custom`** — подсветка в списке;
- **`sma`**, **`ema`**, **`ww()`** — от close; **`sma(period=20)`**, **`sma(period=20, series=VALUE)`** — параметры в ();
- **`@CODE`**, `*`, `#`, ядра `(1;-2;1)` — единый парсер `poly_*` в `02`;
- `invoke_formula` / `default_invoke_formula`: если не `calc_*` — многочлен;
- UI: **«+»** у «Индикаторы» → форма (код, название, описание, формула); **«И.»** — справка по синтаксису;
- API: `GET/POST /api/indicators`, `PUT /api/indicators/:id` (formula для `is_custom`);
- `logics` + `logic_indicator_signals` / `logic_params` — торговые правила и параметры (EAV); таблица **`logics_detail` удалена** (v39);
- UI **Операции** (`/operations`): пять сворачиваемых блоков — **«Параметры логики»**, **«Сигналы на логике»**, **«Стоп-лосс и тейк-профит»**, **«Ценные бумаги»**, **«Сделки»** (по умолчанию свёрнуты);
- API logics: **`GET/PUT /api/logic-params`** — чтение/запись `logic_params`; signals/stops/securities/trades;
- **Trade runner (PostgreSQL):** `run_trade_cycle()` → `process_logic_trades()` — **AND-группы** `(position_event × position_side)`; **перед сигналами** `logic_refresh_market_data` + `logic_signal_rating_resolve_pending`; парсинг `@CODE(...) condition` на **`timeframe` из logic_params**; **сигналы только на последней закрытой свече TF**; fake/real; idempotency `(logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow)`; модули `sql/logic_signal_and_rating.sql`, `sql/logic_trade_runner.sql`;
- **Расписание:** **Node fallback** каждые **15 с** (`TRADE_RUNNER_INTERVAL_MS`, Windows); **pg_cron** раз в минуту (Linux); **только при открытом Angular** (heartbeat → `APP_TRADE_RUNNER_HB`, TTL 90 с); ручной `POST /api/logic-trades/run`;
- **Демо-логика** в `01`: `SMA Price Cross Demo` — **follow/breakout**: open AND (SMA + BB UPPER/LOWER + STOCH 50), close **только SMA**; **все акции**; SL **1%** / TP **3%**;
- **v41 пакет логик** (по мотивам OsEngine): ещё **10** логик на `FAKE-EFF-001`, `is_enabled=FALSE`, все акции, SL/TP как у демо;
- **v43 L1–L4** (из MultiLogicTradeA/FINRESP): лонг/шорт × тренд/боковик; AND-сигналы; без Strict/Regime/OnFlip; индикаторы SMA100, LINREG, ATR GROWTH5, ADX, CCI, MACD HISTOGRAM, STOCH; комиссия default **0.03**;
- **`indicators.sig_profile`**: `trend_line` | `oscillator` | `channel` | `zero_line` | `strength` | `volume`; шаблоны `sig_trend_def`=follow, `sig_ct_def`=fade (для channel: UPPER / LOWER);
- UI тип сигнала: **«По течению» / «Против»** (в БД по-прежнему `trend`/`counter`);
- UI **Позиции / Тестирование**: в шапке рядом с фин. результатом — **% от нач.** и **год.** (простая аннуализация);
- График бумаги в тесте: линия PnL (фиолетовый ноль) с **начала периода теста** (`date_from`), не с первой сделки;
- UI сигналов: блок **«Сигналы на логике»**, колонка **боевой «Рейтинг»** (сумма по бумагам), раскрытие сигнала → бумаги → график; параметр **базовая ставка % годовых** + **`rating_lookback_days`** (предрасчёт при enable);
- **v42 боевой предрасчёт рейтинга:** при `is_enabled=true` фон (`logic_signal_rating_reset_live` + `logic_signal_rate_bar`); иконка ↻ у чекбокса; тест в колонке не показывается;

### Правило схемы БД

- изменения — в `00`–`02`; для существующих БД — `ALTER … ADD COLUMN IF NOT EXISTS` после `CREATE TABLE`;
- после правок — `npm run verify:sql`; правило: `.cursor/rules/database-scripts.mdc`.

---

## Что сделано (актуально на 2026-07-14)

### Бумаги ↔ индикаторы

12. Вкладки: **2 — Бумаги и индикаторы**, **3 — Справочники**.
13. Таблица **`security_indicator_series`** — одна строка = серия индикатора на бумаге (`series_code`, `invoke_formula`, параметры, `point_count`).
14. Функции **`calc_ind_*_array`** — один проход по ценам, возвращают `TABLE(dt, value)`; процедуры `ensure_security_indicator_series`, `sync_security_indicator_series(_all)`.
15. API: `GET/POST/DELETE /api/security-indicator-series`, `POST /api/security-indicator-series/sync`, `GET /api/indicator-values`.
16. UI: drag → создание всех серий индикатора + sync; список серий с удалением; график через sync (инкрементально при прокрутке).
17. **График цен:** панель (↻ пересчёт, ± zoom, ◀▶, ⛶ полный экран); колёсико/pinch; инкрементальный sync по видимому окну; fullscreen подписи **×1.55**; **линия y=0** на шкале цены (PACC) и в панели OSC (MACD и др.).
18. **Fix hang при добавлении индикатора:** POST `/api/security-indicator-series` без полного sync; расчёт — отдельно через `/sync`; прогресс «Добавление…» / «Расчёт…»; `insert_indicator_value` через UPSERT.
19. **Единый парсер формул:** `sma()`/`ema()`/`ww()`, поле `formula`, SMAT3; `calc_indicator_series_array` → `calc_poly_formula_array` при наличии formula.
20. **Создание индикатора в UI:** «+» в списке; POST `/api/indicators` + серия VALUE; форма с подсказкой и «И.»; синяя подсветка `is_custom`.
21. **Фоновый пересчёт после drag:** POST assign → список сразу; async sync в PostgreSQL; спиннер «Пересчёт …».
22. **T-Bank токен:** `parameter_types.TBANK_API_TOKEN` → `parameter_values`; `get_tbank_token` / `set_tbank_token`; диалог при «Загрузить цены»; API `GET/PUT /api/settings/tbank-token`.
23. **SMAT3 / график:** локальная свёртка по `period`; sync без зависания при scroll/fullscreen/expand (`verify-chart-sync.mjs`, `userInitiated`, suppress до готовности).
24. **Logics — сигналы индикаторов:** таблица `logic_indicator_signals`, дефолты `sig_*_def`, UI с inline-редактированием формулы.
25. **Технический журнал `app_tech_log`:** галочка **«Логирование»** в **верхней шапке** (глобально); флаг **`APP_TECH_LOGGING`** в `parameter_values` (Default); `app_tech_log_event` / `logic_trade_log`; логи trade runner (цикл, свеча, сигнал, сделка), enable/disable логики, параметры; API `GET/PUT /api/settings/tech-logging`, `POST/GET /api/tech-log`.
26. **Fix pan влево (SMAT3):** proactive `loadOlder`, `incremental=false` при сдвиге `end_dt` влево, защита poll от stale gen, debounce по `lastVisibleRange`.
27. **Logics — стопы:** таблица `logic_stops`, UI блок под сигналами, форма добавления, inline-редактирование строк.
28. **Fix hang при drag индикатора:** единый `syncGen` для assign/range/poll; блок full sync во время `mergeOnly` assign; отложенный full sync после assign; расширенное `app_tech_log` (poll start/ok, superseded, deferred).
29. **Fix multi-indicator assign:** очередь POST+mergeOnly по одному на бумагу; debounced flush после серии assign.
30. **Logics — ценные бумаги:** таблица `logic_securities`, блок «Ценные бумаги» (+ Добавить, picker акции/фьючерсы с «выбрать все», bulk add); все три подблока логики свёрнуты по умолчанию.
31. **Hotfix logics build:** у `ExchangeRow` нет `is_active` — MOEX по имени; удалён дубликат `toggleStopsBlock`.
32. **Logics — сделки:** таблица `logic_trades`, trade runner по включённым логикам, UI блок «Сделки»; поля `is_simulated` / `is_fictitious`.
33. **Logics — параметры торговли:** `position_size_pct`, `max_open_positions`, `initial_balance`, `current_balance`; UI блок «Параметры логики»; runner — расчёт лота и лимит позиций; демо `SMA Price Cross Demo`.
34. **Fix params UI:** черновик в Map (не теряются правки), % показывается как `10` не `10.0000`, сообщение об ошибке сохранения; T-Bank токен при включении фейковой логики.
35. **logic_indicator_signals.position_side:** Long/Short; кнопки «+ Индикатор Long/Short», тренд/к-тренд на форме picker.
36. **logic_params (v20):** таблица параметров логики EAV; сохранение через PUT /api/logic-params; runner читает из logic_params.
37. **Fix poll logics:** цикл 2 с больше не перезагружает «Параметры» и не затирает черновики формул; `paramsDirtyIds`; правило `no-refresh-while-editing.mdc`.
38. **Демо SMA v22:** только long trend + short trend (без counter); long выше SMA, short ниже SMA.
39. **v23 trade runner в PostgreSQL:** `timeframe` в logic_params; `run_trade_cycle` / `process_logic_trades`; pg_cron + Node fallback; UI выбор таймфрейма; `sql/logic_trade_runner.sql`.
40. **v24 закрытие свечи TF:** job ждёт закрытия бара (`logic_last_closed_bar_dt` + `last_trade_bar_dt`); данные через `logic_bar_data_at`; fix timezone epoch и `\y` в `evaluate_signal_condition` (раньше `pp`/`VALUE` не подставлялись).
41. **v25 глобальное логирование:** галочка в app-bar; `APP_TECH_LOGGING` в parameter_values; `sql/app_tech_logging.sql`; trade runner + API logics → `app_tech_log`.
42. **v26 live data в runner:** `logic_refresh_market_data` — робот сам грузит свечи (T-Bank/MOEX) и пересчитывает индикаторы; окно `logic_trade_load_date_from` (M1/M2 — только сегодня).
43. **v27 T-Bank UTC→MSK:** `market_candle_dt_from_iso` при записи свечей T-Bank; иначе `prices.dt` на +3 ч от `logic_last_closed_bar_dt` → `trade.not_ready`.
44. **v28 chart pan perf:** rAF redraw, `loadingOlder` не блокирует перемотку; fullscreen ниже вкладок; логи `chart.pan.*`, `chart.redraw.slow`, `indicator.rangeSync.retryStorm`.
45. **v29 runner только с UI:** heartbeat Angular → `touch_trade_runner_ui_heartbeat`; `run_trade_cycle` пропускает без UI; блок сделок со scroll.
46. **v30 intraday TF:** runner **15 с**; `logic_trade_sync_point_count` (M1=400, M2=300, M5=200 свечей); T-Bank UTC→MSK (`market_candle_dt_from_iso`).
47. **v31 PnL и пакеты сделок:** параметры **`commission_pct`** (% от депозита на сделку для фейка) и **`cost_method`** (FIFO / AVERAGE); колонки `logic_trades.commission`, `financial_result`; таблица **`logic_trade_lots`**; функции `logic_trade_finalize`, `logic_trade_build_lots`, `logic_trade_rebuild_pnl`; UI — параметры комиссии/метода, разворот строки сделки → таблица пакетов; API `GET /api/logic-trade-lots?trade_id=`; fix клика по блоку «Сделки»; исходник `sql/logic_trade_pnl.sql`.
48. **v32 проверка токена T-Bank:** `tbank_verify_token()`; красный баннер у блока позиций; клик → диалог.
49. **v33 позиции UI + runner:** блок «Сделки» → **«Позиции»**; подблоки **Открытые** / **Закрытые**; общий фин. результат сверху; runner не блокирует цикл из‑за одной бумаги без данных M1.
50. **v38 сигналы open/close:** `logic_indicator_signals.position_event`, `logic_trades.position_event`; UI «+ Открытие/+ Закрытие»; runner по `position_event`; демо — 4 сигнала SMA, все акции, SL1%/TP3%; графики бумаг теста (PnL-полоса, ⟸сд./сд.⟹, fullscreen); БД 00→02.
51. **v39 чистка схемы:** DROP `logics_detail`; с `logics` убраны дубли `position_size_pct`/`max_open_positions`/`initial_balance`/`current_balance` (истина — `logic_params`); убраны legacy `indicator_values.is_signal/signal_type`, `parameter_types.is_control/is_fake_only/min/max/description`, `parameter_sets` extras, `parameter_values.record_date`, `prices.trades`/`created_at`, audit `created_at` у brokers/accounts, `security_types.note`.
52. **v40 AND + рейтинг сигнала на логике:** группа сигналов одной стороны/действия — все должны сработать; `logic_indicator_signals.rating` + `logic_signal_rating_pending` + `base_annual_rate_pct`; демо SMA/BB/STOCH; UI: «Рейтинг сигнала» на закладке логики (не рейтинг индикатора из справочника); backtest тоже AND.
53. **v40b рейтинги в тесте:** `rating_test` + `logic_signal_rating_history` (logic+signal+security); успех = ход на **след.** свече → % годовых vs `base_annual_rate_pct` → ±1 (без пола 0); UI — «Рейтинги сигналов на бумаге» под графиком в блоке Бумаги; модуль `sql/logic_signal_and_rating.sql`.
54. **Бэктест Стоп:** сразу `status=cancelled`, результат сохранён; не зависать на длинном `rate_signals`; демо follow/breakout (SMA+BB+STOCH).
55. **v41 seed логик:** 10 классических стратегий (OsEngine-style) + неизменённое демо; все на фейк-счёте, все акции.
56. **v42 боевой рейтинг на вкладке Сигналы:** колонка только `rating` (сумма по бумагам); раскрытие сигнала → бумаги → график (`is_test=0`); параметр `rating_lookback_days` (default 7); при enable — фоновый предрасчёт `api/logic-rating-precalc.js` + иконка ↻; `logic_signal_rate_bar` / `logic_signal_rating_reset_live`.
57. **Финрез + комиссия в UI:** шапка Позиции/Тестирование и плитки бумаг — комиссия; главная таблица логик — колонки «Финрез» (бой) и «Финрез теста» (онлайн).
58. **v43 L1–L4 + комиссия 0.03:** перенос FINRESP L1–L4; индикаторы **как SMA/STOCH** — каталог + `indicator_value_types` + `script` → `calc_ind_*` + `calc_ind_*_array` + CASE в `calc_indicator_series_array` (без отдельного poly); ATR серия GROWTH5; `logic_apply_indicator_params_from_signals` для period из `@IND(...)`.
59. **v43b изоляция бой/тест/прекалк:** Node trade-runner — отдельная tx на логику; пропуск логики с активным бэктестом; при любом бэктесте бой не делает HTTP `load_prices`; `ensureDefaultParams` с `lock_timeout` + кэш; rating precalc ждёт бэктест + retry deadlock/serialization; пул PG `max≈24`.
60. **Прогресс теста UI:** % в крутилке у имени; плавный progress при HTTP-ценах/индикаторах и по барам.
61. **v43c финрез теста не смешивается:** `logic_trades.run_id`; INSERT бэктеста пишет `run_id`; `GET /pnl-summary?is_test=1` только сумма сделок последнего прогона (без fallback на устаревший `logic_backtest_runs.financial_result`); панель «Тестирование» считает финрез только по сделкам; фильтр `tradesFor` по `run_id`.
62. **Fix rating precalc при enable:** `logic_rating_precalc_ensure_data` грузит цены+индикаторы за lookback; сброс live-рейтинга только если есть свечи (раньше empty→reset→нули после 00).
63. **Fix зависание UI при раскрытии бумаги в тесте:** poll trades больше не сбрасывает график; `reloadToken` без `processed_bars`; убран `backtest.trade_created` в `app_tech_log` на каждую сделку.
64. **Fix зависание раскрытия бумаги (бой):** `process_logic_stops` на новой свече вызывал `load_prices` по **всем** active бумагам (~35 с при 34 шт. × T-Bank) → блокировал пул PG/API → UI «висит» на графике. Теперь: только бумаги с открытыми боевыми позициями / pause; `prices_have_closed_bar` — без повторного HTTP; skip HTTP при активном бэктесте; то же в `logic_refresh_market_data`.
65. **Fix повторного зависания раскрытия:** на новой M15-свече `logic_refresh` всё равно грузил 34 бумаги × lookback + sync индикаторов + **сотни** `trade.signal_skip` в `app_tech_log` (при включённом логировании). Исправлено: `prices_topup_date_from` (1 день), `indicator_has_closed_bar`, mute спама в `logic_trade_log`; UI теста — показать график с первой порции свечей, догрузка в фоне; tech-log `paper.expand` / `chart.load`.
66. **Fix раскрытия бумаги #4 (главная причина «виса» после перезапуска bat):** `GET /api/indicator-values` без LIMIT отдавал **~7 МБ** JSON (~6 с) → браузер замирал на parse/draw. Теперь LIMIT (до 1500–4000), узкое окно индикаторов один раз после первой порции свечей; `MultiLogic_Trade_Progress_Start.bat` чистит `.angular/cache` и открывает `/?v=…` (cache-bust); `paper.expand` пишется с `force`+flush.
67. **Fix раскрытия #5:** по логу был `paper.expand` sec=30 без `chart.load.*` (UI зависал после клика). Убрана цепочка `loadOlderUntilCovered`; график монтируется **только после** свечей; индикаторы через 400 ms; tech-log `chart.load.start/prices/done`.
68. **Fix маркеров «все на последней свече»:** поиск индекса по полному `candles[]`, вне окна не clamp к краю.
69. **Fix Dual MA / ММК (куча маркеров на одной линии):** API отдаёт `prices.dt` / `bar_dt` через `to_char` (стенные часы БД, без `…Z` и сдвига TZ); лимит тест-сделок **5000** (было 200 — обрезало набор); на одном баре open+close слегка разводятся по X (stagger).
70. **Fix лага UI при нескольких тестах / выборе даты:** poll больше не грузит ×5000 сделок по всем логикам каждые 2 с; кэш `tradesFor`/`signalIndicatorIds`; пауза poll на диалоге периода; OnPush positions-panel.
71. **v44 logics.note + контртренд OsEngine:** колонка `logics.note`; поле «Примечание» в редакторе; подписи у всех seed; +5 логик CCI/LinReg/ADX/MACD/ATR Fade.
72. **Комиссия % от номинала сделки:** `logic_trade_calc_commission` = `price × quantity × commission_pct / 100` (было % от депозита — ломало mean-reversion бэктесты).
73. **Лотность бумаги (v44b):** `securities.lot_size` (MOEX TQBR: 10 для большинства акций, 1 для VTBR и др.); `logic_security_lot_size` + `logic_calc_open_quantity(..., lot_size)` — объём открытия округляется вниз до лота; runner и бэктест; колонка «Лот» в блоке бумаг логики; API `/api/securities`, `/api/logic-securities`.
74. **Инверсия логики:** param `inversion` (default false); условия `≥↔≤`, `>↔<` + сделки Long↔Short (как ReverseSignals+ReverseSides / OsEngine); UI галочка в параметрах.
75. **Эквити в тесте:** переключатель «График / Эквити» у блока Бумаги; общая синяя + бледные long(зел.)/short(кр.).
76. **Финрез (% депозита):** в скобках у боевого/тестового финреза и на панелях Позиции/Тестирование / плитках бумаг.
77. **Windows-инсталлятор (исходники):** `installer/windows` — Inno Setup `.iss`, post-install PowerShell, build helper и README. Установка: копирует проект в Program Files, ставит недостающие Node.js 18+ и PostgreSQL 15, пытается поставить pgsql-http, разворачивает БД `00→01→02` с паролем `111`, создаёт `api\.env`, выполняет `npm ci` для `api`/`web`; при старой установке предлагает удалить и поставить заново.
78. **Снимок в OsEngine:** полная копия проекта (SQL/api/web/docs/installer) положена в `related projects/MultiLogicTradePg` репозитория OsEngine (`OsEngine_SNAPSHOT.md`), потому что Cloud Agent OsEngine не может push в отдельный MultiLogicTradePg.
79. **Готовый один `.exe`:** собран Inno Setup (Wine+ISCC в Linux Cloud) → `installer/windows/dist/MultiLogicTradePgSetup.exe` (~2.2 MB), закоммичен в git (gitignore разрешает только этот Setup.exe).
80. **Fix ярлыка Desktop/Start Menu:** ярлыки через `cmd.exe /k` (консоль не мигает); `MultiLogic_Trade_Progress_Start.bat` обновляет PATH (Node после Setup без re-login), читает `api\.env`, поднимает API `:3000` + `ng serve` `:4200`, открывает браузер, всегда `pause` в конце. Добавлен `web/Start_MultiLogic_Trade.cmd`.
81. **Fix batch-ошибок установленного launcher:** Windows-скрипты установщика/запуска нормализуются в CRLF + UTF-8 без BOM; добавлен `.gitattributes`; API стартует с унаследованными env-переменными вместо длинной цепочки `cmd /c "set ...&& ..."`.
82. **Fix launcher v2/v3:** после повтора ошибки большой PowerShell-wrapper отменён; возвращён старый рабочий `.bat` flow (одно окно, API в фоне, Angular в foreground), но файл сделан ASCII-only/CRLF и исправлено отложенное открытие браузера без вложенного `start \"\"`, которое давало `The system cannot find the file \\.`.
83. **Fix installer admin responsibilities:** `MultiLogic_Trade_Progress_Start.bat` больше не выполняет `npm install`; он только проверяет `api\web node_modules` и локальный Angular CLI. Все npm-пакеты ставятся post-install скриптом от администратора, установка падает, если `node_modules` не создан.
84. **Fix reset БД:** installer больше не полагается на `00` для reset; post-install ищет локальный PostgreSQL (`5432`, существующий `api\.env PGPORT`, `5433..5440`) с пользователем `postgres`/паролем `111`, выбирает порт, где уже есть `multilogictrade`, удаляет базу по имени через terminate + `DROP DATABASE IF EXISTS ... WITH (FORCE)`, проверяет отсутствие/создание базы, накатывает `01 -> 02` и записывает выбранный `PGPORT` в `api\.env`.
85. **Reset всегда:** checkbox `resetdb` удалён из Inno Setup; post-install больше не принимает `-ResetDatabase` и всегда сбрасывает/пересоздаёт `multilogictrade` при установке.
86. **Протокол установки + автозапуск:** installer сразу кладёт placeholder `{app}\INSTALL_PROTOCOL.txt`; post-install запускается скрыто через `installer\windows\scripts\run_postinstall.cmd`, который сразу перезаписывает протокол и пишет туда stdout/stderr PowerShell. `install.ps1` дополнительно копирует transcript в `C:\ProgramData\MultiLogicTradePg\install-latest.log`; Notepad запускается только если файл существует; в Start Menu есть `Install protocol`; на финальной странице Setup добавлен checked checkbox `Run MultiLogic Trade` и optional unchecked `Open installation protocol`.
87. **Fix PowerShell parser:** протокол показал ParserError в `install.ps1` на Windows PowerShell 5.1; скрипт переведён в ASCII-only, убраны here-string блоки (`@"..."@`) для `api\.env` и protocol summary, сообщения заменены на ASCII.
88. **UI logics:** добавлен backend/UI copy logic (`POST /api/logics/:id/copy`) — копирует логику, params, signals, stops, securities, но не trades/runs; имя `... copy`, копия выключена; endpoint сразу возвращает полную joined-строку с account/broker полями. Главная таблица logics ужата, actions видны на экране. В «Позиции/Тестирование» рядом с названием — счётчик open/close, PnL уже с `%` от депозита; в тестировании добавлен блок «Эквити портфеля» (общая/long/short).
89. **UI processes/formulas/select-all:** сверху на странице logics добавлена панель активных процессов (`GET /api/processes`: pg_stat_activity, running backtests, enabled trade runner, pg_cron если доступен + локальный rating precalc). В picker бумаг групповой checkbox больше не disabled и может снять выбор. Формула сигнала — full-width textarea с переносом, Ctrl+Enter сохраняет; warning `sig.rating ?? 0` убран.
90. **Правила актуальности SQL/installer:** добавлено `.cursor/rules/installer-freshness.mdc`; `database-scripts.mdc` и `project-context.mdc` теперь явно требуют держать `00`–`03`, `docs/PROJECT_CONTEXT.md` и `installer/windows/dist/MultiLogicTradePgSetup.exe` в актуальном состоянии. При изменении SQL/API/UI/scripts/docs/installer sources — пересобрать installer и коммитить `.exe` вместе с изменениями.
91. **Installer UX status/progress:** длинный `StatusMsg` post-install заменён на короткий «Настройка приложения... См. INSTALL_PROTOCOL.txt»; перед скрытым post-install шагом progress bar ставится примерно на 85%, после завершения — на 100%.
92. **Stop-loss security_inversion:** добавлен scope `security_inversion` для stop_loss. В `logic_securities` и `logic_backtest_security_state` есть `real_trading_inverted`; SL по бумаге с инверсией закрывает текущую позицию и переключает локальную инверсию по этой бумаге. Trade runner/backtest используют XOR глобальной `inversion` и локальной `real_trading_inverted`. UI показывает badge «инверсия», глобально инвертированная логика обводится красным; график теста подсвечивает периоды инверсии бледно-розовым без разрыва equity.
93. **Warm-up перед включением боя:** добавлен boolean param `warmup_pretest` (default TRUE), UI checkbox «Прогрев (предварительное тестирование)». При включении логики с активным stop_loss `security_resume` или `security_inversion` API оставляет `is_enabled=FALSE`, запускает backtest за `rating_lookback_days`, раскрывает блок «Тестирование», после `completed` переносит `real_trading_paused`/`real_trading_inverted`/resume targets из `logic_backtest_security_state` в live `logic_securities`, затем включает логику и запускает rating precalc. Повторный click во время warm-up переиспользует текущий run.
94. **Copy logic UX:** после успешного `POST /api/logics/:id/copy` — `alert` «Логика скопирована: {name}»; после OK — прокрутка к новой развёрнутой строке; кнопка «+» того же цвета, что карандаш/корзина (`#374151`).
95. **Fix install-over («Нет»):** post-install останавливает :3000/:4200, удаляет `api`/`web` `node_modules` (+ `.angular`), затем чистый `npm ci` и проверка `web\node_modules\@angular\cli\bin\ng.js`. Launcher `FreePorts`: `taskkill` через PowerShell `2>$null` (убран `2>nul | Out-Null`, который давал Out-File на устройство nul).
96. **Fix EPERM `.angular/cache`:** post-install `icacls` — группа Users получает Modify на `{app}`, `web`, `api` и создаётся `web\.angular\cache`; launcher проверяет mkdir cache до `ng serve` (иначе ясная ошибка про переустановку).
97. **Copy logic scroll:** после `alert` и OK — `scrollIntoView` к строке новой логики (`data-logic-id`); разворот копии по-прежнему сразу после копирования.
98. **Справка UI + комментарии рутин:** панель «Справка» (иконка книги, белая на тёмной шапке) рядом с шестерёнкой — разделы о системе, вкладках, логиках, индикаторах, структуре БД, API, установке. В SQL добавлены COMMENT ON для ~91 функций/процедур без описания (`sql/routine_comments_missing.sql` → блок в `02`); JSDoc у `api/server.js` и ключевых методов `LogicsService`.
99. **Installer DbMode:** Да → `wipe` (DROP DATABASE); Нет → `upgrade` (без DROP, `sql/drop_public_routines.sql` + `01` + `02`, данные таблиц сохраняются); первая установка → `create`. Режим в `db-mode.txt` / аргумент post-install / `INSTALL_PROTOCOL.txt`.
100. **01 CREATE+ALTER:** у каждой таблицы полный `CREATE TABLE IF NOT EXISTS`; сразу после — `ALTER … ADD COLUMN IF NOT EXISTS` для всех колонок кроме PK `id` (с комментарием upgrade); `NOT NULL` в ALTER только вместе с `DEFAULT`. Генератор: `scripts/ensure-01-column-alters.mjs` (игнорирует `--`/`/*` в CREATE; убирает сиротские mid-file ADD COLUMN; `indicators.sig_*` в CREATE).
101. **Эквити/бумаги бой+тест:** блок «Эквити портфеля» и раскрываемые «Бумаги» (график/эквити, lazy load) в live как в test; вертикали портфельных SL/TP на эквити; период теста запоминается; `/pnl-summary` и панель — один критерий последнего run (`id DESC`) + только filled/submitted.
102. **Cash-fund + общие настройки очистки:** params `cash_fund_code` / `cash_fund_threshold` / `last_cash_fund_bar_dt`; шапка DB+gear; `APP_CLEANUP_DISK` + manual cleanup API.
103. **Cash-fund runner + cleanup schedule:** `logic_park_excess_cash` (EtfBy/FindInstrument + `tbank_post_order` BUY; fake skip+log; 1×/closed TF bar); `run_cleanup_if_enabled` + pg_cron `30 3 * * *` + Node `maintenance-scheduler.js` (24h); `APP_CLEANUP_LAST_AT`.
104. **Cash fund in portfolio UI:** seed ETF TMON/LQDT/SBMM; on param save → `syncLogicCashFundSecurity` (`display_order=0`); pin in Позиции/Тестирование «Бумаги»; runner/backtest skip fund for signals.

### Автотесты

- `scripts/verify-indicators.mjs` — smoke SQL (sync без цен, calc_ind_*_array, seed STOCH, sig_*_def).
- `scripts/verify-chart-sync.mjs` — регрессия зависания индикаторов на графике.
- `scripts/verify-async-sync.mjs` — async assign/sync.
- `npm run test:unit` — Karma/ChromeHeadless (разворот бумаги, fullscreen, recalc).
- `prebuild`: verify:sql → test:unit → generate:schema; CI: unit-тесты + verify-indicators.

### База и инфраструктура

1. Идемпотентные скрипты `00`–`03`, split монолита v11 → v12.
2. Локально: PostgreSQL 15, pgsql-http, база `multilogictrade`.
3. `verify:sql` + `verify:indicators` + `test:unit`, CI в `.github/workflows/pages.yml`.
4. `docs/LOCAL_SETUP.md`, `scripts/run_multilogictrade.ps1`, `web/MultiLogic_Trade_Progress_Start.bat`.
5. Windows Setup: `installer/windows/dist/MultiLogicTradePgSetup.exe` + исходники Inno; ярлыки → `cmd /k` + Start.bat (API+Angular).

### Фьючерсы и загрузка цен

5. Rollover по контрактам, `prices.contract_prefix`, `load_prices_futures_http`.
6. Авто-sync контрактов MOEX → `futures_expirations` (без ручного INSERT в `01`).
7. `moex_secid` для T-Bank/MOEX (CNY, Si).
8. TRUNCATE + тест загрузки с пустой `futures_expirations` — OK (CNY id=52, Si id=54).
9. **Вечный CNYRUBF (id=51):** `get_active_future_prefix` и `load_prices_from_tbank_http` — префикс из `security_prefixes`, не из кэша контрактов; загрузка 305 свечей проверена.

### UI и API

10. Scrollable lists (securities, indicators, references, logics).
11. API: таймауты клиента, `GET /api/prices` с `contract_prefix` / `group_prefix`.
12. `price-chart`: canvas, overlay индикаторов, полноэкранный режим с крупными подписями.
13. `securities-panel`: drag-drop серий, загрузка цен, fix зависания при развороте без цен.

---

## Открытые задачи / следующие шаги

- [x] Выложить v40/v40b (commit/push) и прогнать `00`→`02` на рабочей БД (2026-07-14).
- [x] Seed ~10 классических логик (OsEngine) + демо; FAKE; все акции (v41).
- [x] Боевой рейтинг: колонка только бой; сигнал→бумаги→график; предрасчёт при enable (`rating_lookback_days`) (v42, локально).
- [x] Финрез: комиссия в шапках/плитках; колонка «Финрез теста» на главной (онлайн).
- [x] v43: L1–L4 (MultiLogicTradeA) + индикаторы + комиссия 0.03; БД 00→02; push.
- [x] v43b: изоляция бой / тест / прекалк рейтингов (без взаимных lock-stall).
- [x] v43c: финрез теста привязан к сделкам/`run_id` (не stale PnL из `logic_backtest_runs`).
- [x] Применить `lot_size` + функции на рабочей БД (`00`→`02`, 2026-07-15); бэктесты после пересборки нужно перезапустить.
- [ ] Расширить оценку формул сигналов (CROSS; AND внутри одной формулы).
- [ ] `is_fictitious` — логика заполнения.
- [ ] Заполнить `tbank_figi` где возможно (частично через `resolve_tbank_instrument_id`).
- [ ] Влить реструктуризацию параметров индикаторов (черновик `Indicators_parameters_todo`).
- [ ] Прогнать полный UI-тест загрузки для вечных (`USDRUBF` и др.).
- [ ] Параметры индикаторов per-security (редактирование колонок `param_*` в UI).
- [ ] Параметр периода ATR для `logic_stops.value_unit = atr` (сейчас только хранение единицы).
- [x] Собрать `installer/windows/dist/MultiLogicTradePgSetup.exe` (Inno Setup / Wine ISCC) и выложить в OsEngine mirror (2026-07-17).
- [x] Fix ярлыка: окно не закрывается; поднимаются API+Angular с установленной БД (2026-07-17).
- [x] Fix batch-ошибок launcher после установки: CRLF/UTF-8 без BOM + упрощённый старт API (2026-07-17).
- [x] Fix launcher v3: вернуть старый рабочий `.bat` flow, исправить delayed browser opener и сохранить ASCII/CRLF (2026-07-17).
- [x] Installer-only npm install; launcher без npm install; reset БД по имени с `DROP ... WITH (FORCE)` и проверкой (2026-07-17).
- [x] Reset БД ищет существующий `multilogictrade` на локальных портах PostgreSQL и пишет найденный `PGPORT` в `api\.env` (2026-07-17).
- [x] Убрать optional reset checkbox: каждая установка всегда пересоздаёт `multilogictrade` (2026-07-17).
- [x] Добавить `INSTALL_PROTOCOL.txt` + shortcut протокола + checked checkbox запуска после установки (2026-07-17).
- [x] Fix missing `INSTALL_PROTOCOL.txt`: placeholder копируется в `{app}` до post-install, Notepad guarded by `FileExists` (2026-07-17).
- [x] Post-install через `run_postinstall.cmd`, чтобы `INSTALL_PROTOCOL.txt` получал stdout/stderr даже при раннем падении PowerShell (2026-07-17).
- [x] Fix ParserError в `install.ps1`: ASCII-only + без here-string для Windows PowerShell 5.1 (2026-07-17).
- [x] UI logics: copy button, compact table, portfolio equity common/long/short, open/closed counts (2026-07-18).
- [x] Installer UX: post-install `cmd` wrapper runs hidden, setup window shows status, details go to `INSTALL_PROTOCOL.txt` (2026-07-18).
- [x] UI logics follow-up: process panel, available select-all checkbox fix, formula textarea, rebuilt installer (2026-07-18).
- [x] Project rules: SQL scripts and Windows installer must always be current; rebuild installer for shipped changes (2026-07-18).
- [x] Installer UX: короткий status text + progress bar ниже 100% во время post-install (2026-07-18).
- [x] Stop-loss `security_inversion`: локальная инверсия по бумаге, runner/backtest/UI/chart support, SQL scripts synced, installer rebuilt (2026-07-18).
- [x] `warmup_pretest`: preliminary test before enabling live for `security_resume`/`security_inversion`, transfer tested paper states to live, installer rebuilt (2026-07-18).
- [x] Copy logic UX: success alert with new name; copy (+) button same black as edit/delete (2026-07-18).
- [x] Fix install-over (No): clean npm + Angular CLI verify; fix launcher FreePorts Out-File (2026-07-18).
- [x] Fix EPERM Angular/Vite cache under Program Files via icacls Users modify (2026-07-18).
- [x] Copy logic: after OK on success alert, scroll form to the new expanded logic (2026-07-18).
- [x] App help panel (book icon) + missing SQL COMMENT ON for routines; JSDoc API hints (2026-07-18).
- [x] Installer «Нет»: data-preserving DB upgrade (DbMode upgrade/create/wipe) (2026-07-18).
- [x] 01: full CREATE + idempotent ALTER ADD COLUMN IF NOT EXISTS with upgrade comments (2026-07-18).
- [x] Live+test equity/papers parity; portfolio SL/TP on equity; remember test period; pnl-summary align; installer (2026-07-18).
- [x] Cash-fund params + header DB/gear + cleanup settings panel/SQL/API; installer (2026-07-18).
- [ ] Smoke-test полной установки Setup.exe на чистой Windows VM (Node/Postgres/DB/npm/UI).
- [ ] Синхронизировать mirror OsEngine → upstream `RobinZGit/MultiLogicTradePg` (когда есть write-доступ к тому репо).
- [x] Trade runner: auto-buy cash fund (TMON/LQDT/SBMM) when free cash > threshold — `logic_park_excess_cash` (2026-07-18).
- [x] pg_cron / Node daily schedule for cleanup when `APP_CLEANUP_DISK` is on (2026-07-18).
- [x] Futures testing/live: MOEX M15 via M1 resample; asset aliases; 1-lot opens; T-Bank token restore on bad verify (2026-07-18).
- [x] Logics export/import JSON (checkboxes, papers yes / tests no) (2026-07-19).
- [x] v45: +5 trend +10 counter OsEngine seed logics; seed idempotent (no DELETE) (2026-07-19).
- [x] Help/schema: live PG vs offline 01/02; fix nested stop_runner in 02; regen schema-offline (2026-07-19).
- [x] Readable test period on test line + Финрез теста; empty papers ISO fix; backtest cash-fund park (2026-07-19).
- [x] v46 ship: test `executed_at`=`bar_dt`; `logic_non_trading_intervals` + UI «Торговые периоды» / MOEX; `use_non_trading_periods` (default on); `close_positions_eod` (default off, except funds); installer (2026-07-19).
- [x] Linux installer: `installer/linux/dist/MultiLogicTradePg-linux.tar.gz` + `install.sh`; freshness rule for Windows+Linux; `build-all-installers.ps1` (2026-07-19).
- [x] Non-trading UI: add/edit/delete intervals; warning when «Учитывать…» is off; TMON park skip logs + end-of-backtest park; both installers (2026-07-19).
- [x] Ship: equity-based TMON park (`logic_backtest_portfolio_equity` + park formula); UI «Порог портфеля»; both installers + push (2026-07-19).

---

## Заметки для агента

- Коммиты и push — **по запросу** пользователя.
- **Перед каждым push** — обновить `docs/PROJECT_CONTEXT.md` и включить в выкладку (правило `.cursor/rules/project-context.mdc`). Не считать выкладку завершённой без актуального контекста в `origin`.
- **Installers:** любое изменение SQL/API/Angular/`web`/scripts/docs → пересобрать **оба**: `MultiLogicTradePgSetup.exe` и `MultiLogicTradePg-linux.tar.gz` **в том же push** (`.\installer\build-all-installers.ps1`, `.cursor/rules/installer-freshness.mdc`).
- Sergey — **2–3 устройства**; в начале сессии читать этот файл + `git log`.
- Язык: русский (English note — только если пользователь пишет по-английски).
- Пароль локального postgres часто: `111`.
- Объём репо (2026-07-12): ~22–26 тыс. строк исходного кода без `package-lock.json`; ~41 тыс. с lock-файлом.

---

## История сессий (кратко)

| Дата | Суть |
|------|------|
| 2026-07-21 | Indicator LINREGV (period max→3, min max\|residual\|) + seed logic LinRegV Fade |
| 2026-07-19 | Ship: papers ост./сум./цена test+live; fund never Close; Windows+Linux installers |
| 2026-07-19 | Papers MTM: «в портф.» money = open_qty × mark; label финрез; TMON not sold |
| 2026-07-19 | Fix: papers pin id type → ост. 0 despite +70; block Close/lots on cash fund; signals via logic_is_cash_fund |
| 2026-07-19 | TMON: Node park/EOD/NTP; SL/TP skip fund; papers «ост.» open_qty; no SQL-robots/Start hang UI |
| 2026-07-19 | HARD rollback MultiLogicTradePg tree to `29ed3ba` (pre-SQL-robots ~12:57) |
| 2026-07-19 | Ship: TMON park by equity excess; UI «Порог портфеля»; Windows+Linux installers |
| 2026-07-19 | Ship: non-trading interval CRUD UI; NTP-off warning; TMON park fix/logs; Windows+Linux installers |
| 2026-07-19 | Linux installer tar.gz + install.sh; freshness rule Windows+Linux; build-all-installers.ps1 |
| 2026-07-19 | Ship v46: bar_dt trade time; non-trading periods MOEX UI; EOD close except funds; installer |
| 2026-07-19 | Ship: test period UI; Help schema live/offline; ISO papers fix; backtest TMON park; fix stop_runner nest; installer |
| 2026-07-19 | Help/DB schema: live from PG, offline from 01+02; fix stop_runner ×N nest in sync-02; schema-offline regen |
| 2026-07-19 | v45 seed: +5 trend +10 counter OsEngine logics; no DELETE on re-seed (preserve copies/edits) |
| 2026-07-19 | Logics export/import: right checkboxes, header Export/Import, JSON with papers/params/signals/stops, no tests |
| 2026-07-18 | Futures backtest fix: partial coverage still runs indicators; MOEX M10→M15; T-Bank partial→MOEX; concurrency=1 |
| 2026-07-18 | Futures: MOEX M15 via M1 resample; asset aliases; 1-lot opens; T-Bank token rollback on bad verify |
| 2026-07-18 | Cash fund in logic_securities + papers pin (top); seed TMON/LQDT/SBMM; skip signals on fund |
| 2026-07-18 | Implement cash-fund park in runner + scheduled cleanup; plan docs; installer |
| 2026-07-18 | Posted plan docs/PLAN_cash_fund_runner_and_cleanup_cron.md (runner buy + cleanup cron); installer |
| 2026-07-18 | Cash-fund params; DB+gear header; APP_CLEANUP_DISK + cleanup_trading_disk_space; settings panel; installer |
| 2026-07-18 | Test finres mismatch: panel LIMIT 5000 vs pnl-summary 6685; load full run_id; installer |
| 2026-07-18 | Fix upgrade No: install.ps1 ParserError (em-dash); equity open by default; reinstall Setup |
| 2026-07-18 | Live/test equity+papers; portfolio SL/TP equity lines; remember test period; pnl-summary by run id; installer |
| 2026-07-18 | 01 CREATE+ALTER: comment-aware ensure script; indicators.sig_* in CREATE; verify-sql + upgrade OK; installer rebuild |
| 2026-07-18 | 01 full CREATE + ALTER IF NOT EXISTS for all columns (upgrade comments); ensure script |
| 2026-07-18 | Installer DbMode: Yes=wipe DB, No=upgrade keep data (drop routines + 01/02) |
| 2026-07-18 | Help panel (book) next to gear; COMMENT ON for 91 routines; JSDoc; installer rebuild |
| 2026-07-18 | Copy logic: after alert OK, scrollIntoView to new expanded row; installer rebuild |
| 2026-07-18 | Fix EPERM .angular/cache in Program Files: icacls Users + launcher mkdir check |
| 2026-07-18 | Fix install-over (No): stop ports, wipe node_modules, npm ci + ng.js check; FreePorts 2>$null |
| 2026-07-18 | Copy logic UX: alert with copied name; + button same color as pencil/trash; installer rebuild |
| 2026-07-18 | Warm-up pretest before live enable: param/UI/API watcher transfers backtest paper states then enables logic |
| 2026-07-18 | Stop-loss security_inversion: schema, runner/backtest, UI badges/highlight, chart shading, installer rebuild |
| 2026-07-18 | Installer UX: shorter StatusMsg and hold progress at ~85% during hidden post-install |
| 2026-07-18 | Project rules: installer freshness rule; SQL/context rules require current SQL + rebuilt Setup.exe |
| 2026-07-18 | UI follow-up + installer rebuild: process strip, formula textarea, select-all fix, no sig.rating warning |
| 2026-07-18 | Installer UX: hide empty post-install cmd window; keep setup status and protocol logging |
| 2026-07-18 | UI logics: copy endpoint/button, compact columns, portfolio equity block, open/closed counts |
| 2026-07-17 | Fix install.ps1 ParserError: ASCII-only PowerShell, no here-strings; rebuilt Setup.exe |
| 2026-07-17 | Robust installer protocol: run_postinstall.cmd captures PowerShell stdout/stderr into INSTALL_PROTOCOL.txt |
| 2026-07-17 | Fix missing protocol Notepad: packaged INSTALL_PROTOCOL placeholder and FileExists check |
| 2026-07-17 | Installer protocol + final-page run checkbox: INSTALL_PROTOCOL.txt, install-latest.log, Start Menu protocol |
| 2026-07-17 | Installer reset is mandatory: removed resetdb task/flag; every setup recreates multilogictrade |
| 2026-07-17 | Installer DB target fix: find local port containing multilogictrade; reset it; write PGPORT |
| 2026-07-17 | Installer admin fix: npm only during setup; launcher checks node_modules; DB reset by name with FORCE |
| 2026-07-17 | Fix installer launcher v3: old working bat flow restored; fixed delayed browser start; rebuilt Setup.exe |
| 2026-07-17 | Fix installer launcher batch parsing: CRLF/UTF-8 no BOM, inherited API env, rebuilt Setup.exe |
| 2026-07-17 | Контекст: mirror OsEngine, Setup.exe, fix ярлыка cmd/k + PATH + pause; save PROJECT_CONTEXT |
| 2026-07-17 | Fix desktop launcher: окно закрывалось; cmd /k; bat refresh PATH; API+Angular stay open |
| 2026-07-17 | Built MultiLogicTradePgSetup.exe (~2.2MB) into installer/windows/dist; push OsEngine main |
| 2026-07-17 | Snapshot MultiLogicTradePg (+ installer sources) → OsEngine `related projects/MultiLogicTradePg` |
| 2026-07-17 | Windows installer sources: Inno Setup, post-install dependency install, DB deploy, npm ci, shortcuts |
| 2026-07-15 | inversion param; equity curve in backtest papers; PnL (% of deposit) in parentheses |
| 2026-07-15 | БД 00→01→02 с нуля (lot_size + commission notional + v44 logics) |
| 2026-07-15 | securities.lot_size + logic_calc_open_quantity rounds to lot; UI column «Лот»; sync-02 lot block |
| 2026-07-15 | Commission = % of trade notional (price×qty), not deposit |
| 2026-07-15 | v44: logics.note, 5 counter OsEngine seeds, strategy type notes on all default logics |
| 2026-07-15 | Fix Dual MA/MMK markers: to_char wall-clock dt, test trades limit 5000, stagger same-bar open/close |
| 2026-07-15 | Fix paper-expand #5: no loadOlderUntilCovered; mount chart after candles; chart.load.* logs |
| 2026-07-15 | Fix paper-expand #4: indicator-values LIMIT (~7MB→~0.5MB); bat clears angular cache + ?v= bust |
| 2026-07-15 | Fix re-expand hang: 1-day price topup, mute signal_skip logs, progressive paper chart |
| 2026-07-15 | Fix paper-expand hang: stops no longer load_prices for all 34 secs; prices_have_closed_bar |
| 2026-07-15 | Fix paper-expand hang during backtest: no chart reload on trades poll; drop per-trade tech log |
| 2026-07-14 | Fix rating precalc: load prices before reset; empty window no longer wipes ratings |
| 2026-07-14 | v43c: финрез теста — run_id + pnl только из сделок (без смешения с чужим/старым прогоном) |
| 2026-07-14 | v43b: изоляция бой/тест/прекалк (короткие tx, skip HTTP при бэктесте, lock_timeout) |
| 2026-07-14 | v43: комиссия 0.03; L1–L4 FINRESP; LINREG/ADX/CCI; push + БД 00→02 |
| 2026-07-14 | Финрез: комиссия в шапках/плитках; колонка «Финрез теста» на главной (онлайн) |
| 2026-07-14 | v42 (локально): боевой рейтинг UI (сигнал→бумаги→график); предрасчёт при enable; rating_lookback_days |
| 2026-07-14 | v41: 10 классических логик (OsEngine) + демо; push + БД 00→02 |
| 2026-07-14 | Push v40b + БД 00→02: рейтинги на бумаге, мгновенный Стоп, демо follow/breakout |
| 2026-07-14 | Рейтинг: успех на след. свече (годовые vs base_annual); ±1 без пола 0; UI «Рейтинги на бумаге» под графиком |
| 2026-07-14 | Тест: рейтинги сигналов независимо от сделок; rating_test + history; блок «Рейтинги сигналов» с графиком |
| 2026-07-14 | Демо v40b follow/breakout (8 сигналов); sig_profile; UI по течению/против; mean-reversion+SMA AND убран |
| 2026-07-14 | БД 00→02: демо SMA+BB/STOCH (коридор), 12 сигналов, SL1%/TP3%; fix пустого UI (не было rating в старой БД) |
| 2026-07-14 | v40: AND-сигналы; рейтинг сигнала на логике (+pending, base_annual_rate_pct); демо SMA+BB+STOCH; UI подписи |
| 2026-07-14 | Выкладка main → GitHub Pages: v39, диаграмма FK, PnL с date_from, %/год. |
| 2026-07-14 | Gear/структура БД: вкладка «Диаграмма» (таблицы + FK поле→поле); БД 00→02 |
| 2026-07-14 | v39: DROP logics_detail; дубли колонок logics; legacy is_signal/parameter_*/prices.trades |
| 2026-07-14 | Позиции+Тест: % от нач. и год.; демо/дефолт SL = security_resume |
| 2026-07-14 | v38: сигналы open/close + trend/counter; демо все акции + SL1%/TP3%; выкладка + БД 00→02 |
| 2026-07-14 | PnL — отдельная полоса под ценой; кнопки ⟸сд./сд.⟹; подблоки теста свёрнуты |
| 2026-07-14 | PnL: разрыв в зоне «выкл.» (PHOR); Тестирование — все подблоки свёрнуты; fullscreen/timeout ранее |
| 2026-07-14 | Бумаги теста: убран recalc, кнопка «Полный экран», бледные зоны выкл., timeout при pan не на графике |
| 2026-07-13 | v25: глобальное логирование (app-bar, APP_TECH_LOGGING, trade runner logs) |
| 2026-07-13 | v24: закрытие свечи TF в runner, last_trade_bar_dt, fix evaluate_signal/timezone |
| 2026-07-13 | v23: run_trade_cycle в PostgreSQL, timeframe, pg_cron; БД 00→02 |
| 2026-07-13 | v22 demo: только long-trend + short-trend (без counter) |
| 2026-07-13 | v21 demo SMA: long выше / short ниже средней; БД 00→02 |
| 2026-07-13 | fix poll: параметры/формулы не сбрасываются при редактировании; правило UI |
| 2026-07-13 | v20 logic_params EAV + position_side Long/Short; БД 00→02 |
| 2026-07-13 | параметры logics (% депозита, макс. позиций, остаток) + SMA demo + sizing в runner |
| 2026-07-13 | logic_trades + trade runner + UI «Сделки» |
| 2026-07-12 | правило: контекст обязателен перед каждым push; hotfix logics build |
| 2026-07-12 | logic_securities + UI блок «Ценные бумаги» на logics |
| 2026-07-12 | assign queue + debounced flush; fix multi-indicator drag hang |
| 2026-07-12 | fix assign indicator sync race; tech log poll/superseded |
| 2026-07-12 | logic_stops scope: security (по бумаге) / portfolio (портфель) |
| 2026-07-12 | logic_stops + UI стоп-лосс/тейк-профит; обновление PROJECT_CONTEXT |
| 2026-07-12 | app_tech_log + UI «Логирование»; fix pan-left SMAT3 sync |
| 2026-07-12 | SMAT3 локальная свёртка; chart sync без зависания; verify-chart-sync |
| 2026-07-12 | logics: logic_indicator_signals, sig_*_def, UI сигналов, signal-formula |
| 2026-07-12 | pgsql-http, локальная БД 00–02 |
| 2026-07-12 | Фьючерсы: sync MOEX, moex_secid, rollover, verify:sql, scroll lists |
| 2026-07-12 | TRUNCATE + load test; fix вечный CNYRUBF; правило контекста при выкладке |
| 2026-07-12 | security_indicator_series, calc_ind_*_array, sync инкрементальный |
| 2026-07-12 | verify-indicators, test:unit, fullscreen график, fix expand hang |
| 2026-07-12 | PACC + poly parser; fix hang assign; линия нуля на графике; push в репо |
| 2026-07-12 | Оптимистичный drop: строка в таблице сразу; sync только async |
| 2026-07-12 | Убран SMAT3COMP; sma без скобок; SMAT3 = sma*sma*sma |
| 2026-07-12 | Async sync при drag; SMAT3 нормализация свёртки |
| 2026-07-12 | Единый formula engine, SMAT3, UI создать индикатор (+), справка «И.» |

---

## Запросы пользователя (текст)

### 2026-07-12 (ранние)

1. Обзор репо, исправления, split SQL, DROP в `00`, контекст в проект.
2. Локальный запуск, pgsql-http, logics + Angular + Express.
3. Правило БД: изменения в CREATE TABLE, прогон локально.

### 2026-07-12 (фьючерсы и загрузка)

4. «Загрузка фьючерсов по группам (CR/Si), обход контрактов назад, contract_prefix».
5. «Проверка SQL перед build, CI».
6. «Пустая futures_expirations — только sync при load; TRUNCATE и прогнать тест».
7. Ошибка id=51 (CNYRUBF): «Активный фьючерс не найден…» — исправить вечные фьючерсы.

### 2026-07-12 (контекст)

8. «Правила проекта: файлы контекста с каждой новой выкладкой…»

9. «Бумаги и индикаторы: 2-я вкладка; 3-я — Справочники; drag индикатора на бумагу → security_indicators; список и графики по calculate_indicator с параметрами по умолчанию; полный прогон 00–02.»

### 2026-07-12 (индикаторы, график, тесты)

10. «security_indicator_series, calc_ind_*_array, sync инкрементальный; пересоздать БД 00–02».
11. «Зависание при развороте акции без цен — исправить».
12. «Автотесты на expand без цен + prebuild».
13. «Загрузка цен без T-Bank — MOEX D1/H1; M15 нужен токен».
14. «На графике пересчёт индикаторов; полный экран с zoom/pan; крупнее подписи в fullscreen; выложить в репо».
15. «Индикатор ускорения цены PACC, парсер многочленов, формула pp*(1;-2;1)».
16. «Зависание при добавлении PACC на ALRS — fix + прогресс».
17. «Линия нуля на графике (fullscreen и обычный); обновить контекст; выложить в репо».
18. «Индикатор = многочлен: свёртки, умножение, pp, sma(), единый парсер для всех формул».
19. «Кнопка + в списке индикаторов; форма код/название/описание/формула; хинт и кнопка «И.» с подробной справкой; обновить контекст; в репо».
20. «При drag индикатора страница зависает — сразу показывать в списке, пересчёт в PostgreSQL в фоне, спиннер «Пересчёт …» как при загрузке цен».
21. «SMAT3 — sma(pp)*sma(pp)*sma(pp) (свёртка рядов); SMAT3COMP — sma(sma(sma(pp))) (композиция); при том же N числа разные; * без подмены ядром».
22. «После пересоздания БД теряется токен T-Bank — диалог ввода при загрузке цен, хранить в глобальных параметрах, отмена → MOEX; пересоздать БД; в репо».
26. «Drag индикатора: сразу в таблицу, расчёт async; жёсткий verify-async-sync в prebuild».
27. «SMAT3 при перемотке в одну сторону OK, в обратную — зависает; таблица tech log в БД; галочка Логирование (выкл.); логировать start/end по потокам; пересобрать БД; контекст; в репо».
28. «На странице logics под сигналами — блок стоп-лосс/тейк-профит; кнопки + стоп-лосс и + тейк-профит; таблица logic_stops; форма: вид, тип (по логике / портфель логики), значение, единица % или ATR; строки в списке; контекст; в репо».
29. «Файлы контекста обновлять локально и выкладывать в репо каждый раз — правило проекта, не забывать».
30. «Тип стопа: не «по логике», а **по бумаге** и **по всему портфелю логики**; исправить и в репо».
31. «Зависание при добавлении индикатора с логированием — исправить гонку sync (gen, defer full sync, лог poll); в репо».
32. «Снова зависание при добавлении нескольких индикаторов на бумагу — разбор app_tech_log; очередь assign + debounced flush; в репо».
33. «На logics третий блок «Ценные бумаги»: таблица logic_securities, picker акции/фьючерсы с галочками и «выбрать все», bulk add; все три блока свёрнуты по умолчанию; контекст; в репо».
34. «Контекст обновляй при каждой выкладке; запиши в правила проекта, что перед push нужно обновлять PROJECT_CONTEXT.md».
35. «Сделки по включённой логике в реальном времени по сигналам; реальный/фейковый счёт; поле Фиктивная (резерв); блок «Сделки» на logics; таблица сделок».
36. «Параметры логики: % депозита, макс. открытых позиций, начальный остаток (фейк); текущий остаток в logics; блок «Параметры» сверху; расчёт лота и лимит позиций; сделки по выбранным сигналам индикаторов; демо SMA на FAKE-EFF-001 (выше SMA покупаем, ниже продаём) + SBER».
37. «Fix: % депозита 10.0000 / не сохраняются параметры; TS2322; T-Bank токен при включении фейковой логики; в репо».
38. «Сигналы: поле Long/Short; кнопки + Long/+ Short; тренд/к-тренд на форме; выложить».
39. «Параметры логики не сохраняются — таблица logic_params (ключ/значение/тип); выложить».
40. «Собери базу с нуля и выложи в репозиторий».
41. «Poll каждые 2 с сбрасывает параметры — не refresh'ить редактируемое; правило проекта; выложить».
42. «Демо-логика: long при цене выше SMA, short при ниже; пересобрать БД; в репо».
43. «Из демо убрать counter-сигналы — только long-trend и short-trend».
44. «Сделки не идут — переделать runner: timeframe в параметрах, цикл в PostgreSQL (pg_cron job), парсинг сигналов в БД; пересобрать БД; в репо».
45. «Финансовый результат сделок: комиссия % от депозита (фейк) / с биржи (реал); метод FIFO или средняя; таблица пакетов по сделкам; разворот сделки в UI; параметры в блоке параметров; блок «Сделки» не разворачивается — исправить».
46. «Проверка токена T-Bank при сделках: если не валиден — сообщение и диалог ввода; если диалог уже открыт — не дублировать; пересобрать БД с нуля».
47. «На графике бумаг теста: убрать кнопку пересчёта индикаторов; добавить полный экран; PnL/точки/стопы пересчитывать в фоне при rewind; бледные зоны пока бумага выкл.; Timeout has occurred при rewind — убрать».
48. «Сигналы: open/close и trend/counter на форме; кнопки выбора; поле в таблице; демо — сигнал открытия и закрытия; все акции; take profit 3% и stop loss 1%; в репо; БД с нуля; обновить контекст».
49. «Те же % от депозита и годовые — в строке Позиций (фин. результат) и в Тестировании; стоп-лосс по умолчанию — не просто по бумаге, а по бумаге с обновлением (security_resume)».
50. «Сводка лишнего в БД → удалить: logics_detail, дубли колонок logics, legacy write-only колонки» (v39).
51. «Комментарии таблиц/колонок оставить; в окне структуры (шестерёнка) — вкладка диаграммы со связями полей; потом БД с нуля».
52. «Выложить в репозиторий для публикации на GitHub Pages».
53. «Сигналы одной стороны — AND (все open/close); рейтинг сигнала на логике (+1/−1 по следующей свече, порог от годовой ставки); демо SMA+BB+STOCH; предупреждение в UI».
54. «The rating of indicators is not quite accurate — rating of the indicator signal is exactly the one on the logic bookmark».
55. «Тест логики без сделок — сигналы слишком жёсткие; оставить SMA+BB+STOCH, сделать логичнее; возможно follow/fade и профили по индикаторам».
56. «В Тестировании — блок рейтингов сигналов с графиком; считать независимо от сделок; test/combat раздельно».
57. «Рейтинги не отдельным блоком, а под графиком бумаги; по ценам этой бумаги; не +1 за срабатывание, а pending → следующая свеча → % годовых vs base_annual (20) → +1/−1».
58. «Стоп зависает — остановить сразу; после стопа всё протестированное оставить».
59. «Выложить в репозиторий и собрать базу с нуля».
60. «Добавить ~10 частых успешных стратегий из OsEngine; демо оставить; все на фейк + все акции; можно в репо».
61. «Рейтинг на вкладке Сигналы — только бой (сумма по бумагам); сигнал раскрывается → бумаги → график рейтинга; как в тесте по всем свечам без сделок; при enable — предрасчёт за N дней (param default 7) в фоне + иконка; тест в колонке не показывать».
62. «Где финрез на плитках (тест и бой) — добавить комиссии; на главной форме у логики — колонка финрез теста (онлайн, зелёный/красный; без хранения; если теста не было — пусто)».
63. «Комиссия default 0.03; добавить L1–L4 из MultiLogicTradeA (адаптировать под Pg); недостающие индикаторы; в репо; БД с нуля».
64. «Новые индикаторы считать как SMA/STOCH: SQL-функции, каталог indicators, тот же парсинг — без отдельной схемы».
65. «Исправить блокировки: тест всех логик + бой одновременно не должны блокировать друг друга».
66. «Колонка Финрез (бой) рядом с Финрез теста; крутилка теста с %; плавнее progress загрузки цен и прогона».
67. «Финрез теста не должен смешиваться: в большой таблице одно, в развороте теста другое/пусто; надёжная привязка тестовых сделок к логике/этому прогону».
68. «Включил первую логику — рейтинги нули, в бумагах пусто; должны считаться за lookback по сигналам и ценам».
69. «Тест снова зависает при открытии бумаги; логирование включено».
70. «Сейчас зависло раскрытие бумаги. Логирование включено. Посмотри, почему он обвисет».
71. «Всё равно зависает. Всмотри, переразворачивание бумаги, регулирование включено».
72. «Зависло при развертывании вони бумаги, как и в прошлый раз».
73. «Закрыл вкладку, запустил заново батник — всё равно зависание при раскрытии бумаги; может недобравил страницу / жёстче обновление в bat / или не поправил».
74. «Не помогло. Запустил батника ещё раз, разворачивает бумагу и зависает».
75. «Сейчас бумага развернулась. Но график не отрисовывается, пишут загрузка графика и висит».
76. «График рисуется, но не отрисовывается; пишет отрисовка; бумагу обратно не свернуть — зависание UI».
77. «Бумага развернулась с графиком; через время все сделки сдвинулись на последнюю свечу (вход/выход); сначала было нормально».
78. «8-я стратегия, бумага ММК — часть маркеров в начале, часть в конце, много входов/выходов на одной линии».
79. «Запустил несколько тестирований — UI медленно реагирует, например при выборе даты начала теста; посмотри подписки / что блокирует Angular».
80. «Поле примечание у логики — для seed написать тренд/контртренд/демо и OsEngine; добавить 5 контртрендовых OsEngine в сборку; пересобрать БД с нуля».
81. «Комиссия по сделке должна быть % от номинала сделки (суммы), не от всего депозита».
82. «Проверь, учитывается ли лотность бумаги; если нет — добавить лотность и её учёт».
83. «Собери базу данных с нуля».
84. «Галочка инверсия в параметрах (условия наоборот + другая сторона); в тесте флажок эквити/график с лонгами/шортами; у финреза в скобках % депозита».
85. «For this project, you need to create an installer and put it in the repository. The installer is probably in the form of an .exe file. The installer must install needed programs like node and postgres if missing; deploy the database by scripts; install what is needed for Angular; put shortcuts on Desktop and launch panel; if the program is found, propose to delete it and install again from scratch. Postgres password is 111».
86. «Push installer changes to MultiLogicTradePg main» — Cloud Agent на OsEngine не имел write в MultiLogicTradePg; дан доступ Cursor App / токен обсуждался (`MULTILOGIC_GITHUB_TOKEN` в env не появился).
87. «If I can't create a circle in this repository, create a folder for MultiLogicTradePg in OsEngine, copy everything, push to main» — сделано: `related projects/MultiLogicTradePg` на OsEngine `main`.
88. «Сделай инсталлятор в виде одного exe файла» — собран и закоммичен `MultiLogicTradePgSetup.exe`.
89. «After using the installer, desktop button closes the window; Angular does not open; old bat kept window open and raised ports» — fix ярлыков `cmd /k` + hardened Start.bat; пересобран Setup.exe.
90. «Сохрани контекст в репо» — обновление этого файла + push.
91. «Read the context and correct the installer's error. That's it for this repository.» Ошибки `cmd`: `--no-fund`, `SSWORDPGHOSTPGDATABASEPGUSERPORT`, `Unknown argument: port` — исправить установленный launcher.
92. Повтор того же лога (`'--no-fund' is not recognized`, `Unknown argument: port`) + старый bat в source поднимает API/Angular, но пишет `The system cannot find the file \\.` — вернуть старый рабочий `.bat` flow, исправить delayed browser opener, не переустанавливать npm при наличии `node_modules`.
93. «Can the installer itself install packages as administrator, not when the batch file is launched? ... why old logic remains after reset?» — убрать npm install из bat, сделать npm обязательным в installer, reset базы по имени с FORCE и логом host/port/db.
94. «Connect to PostgreSQL user/server `postgres`, password `111`; delete database completely and roll scripts again. If installer could connect, why could it not delete?» — искать локальный PostgreSQL-порт, где реально есть `multilogictrade`, сбрасывать именно его и записывать выбранный порт в `api\.env`.
95. «Did you put it in main? He still did not update/delete the database.» — подтвердить main и сделать reset БД безусловным при каждой установке.
96. «database is still not reset; add installation protocol so I can throw it to you; add checkbox enabled to run program after installation» — добавить `INSTALL_PROTOCOL.txt`, shortcut протокола и checked run-after-install checkbox.
97. Скрин Блокнота: «Не удаётся найти файл C:\Program Files\MultiLogicTradePg\INSTALL_PROTOCOL.txt» — добавить placeholder протокола в installer files и `Check: FileExists` для открытия.
98. Placeholder протокола остался неизменённым после setup — запускать post-install через `.cmd` wrapper, который пишет stdout/stderr в `INSTALL_PROTOCOL.txt` независимо от внутреннего finally PowerShell.
99. Протокол показал `ParserError` в `install.ps1` на строке `Write-Utf8NoBomText ... api\.env` и mojibake строк — убрать here-string и non-ASCII из PowerShell-скрипта.
100. «Make a copy button in logics; trim columns so edit/delete visible; in testing add equity-common/long/short for portfolio; in testing/live show open/closed trade counts after block name; after financial result show % of deposit.»
101. Скрин: при установке пустое окно `cmd.exe` поверх Setup сбивает пользователя — скрыть post-install cmd wrapper, оставить прогресс в окне Setup и лог в `INSTALL_PROTOCOL.txt`.
102. «I don't see the copy button… always commit to main… add working process indicator… fix shares/futures all checkbox… signal formula as textarea full length… collect/export because I don't see current changes.» — причина невидимости: installer не был пересобран после UI; добавить process strip, textarea формул, select-all fix, пересобрать Setup.exe.
103. «always need to reassemble the installer… sql scripts if database structure changes… write project rules» — добавить Cursor rule: SQL scripts and Windows installer must always match shipped state; rebuild installer before push for shipped changes.
104. Скрин installer: status text обрезан, progress bar 100% на долгом post-install — укоротить StatusMsg и держать progress ниже 100% до завершения post-install.
105. «If inversion checkbox is enabled highlight logic; add stop-loss type on paper with inversion; if paper equity falls below SL percent, invert logic on that paper; if falls again switch back; highlight inversion period on equity/chart.»
106. «Add logic parameter checkbox warm-up/preliminary testing, default on; for security_resume/security_inversion stop-loss, enabling logic first runs testing for rating_lookback_days, real trade starts only after test; transfer paused/inverted paper states from test to live logic_securities.»
107. «After copying the logic, report that the logic has been copied and in the same name. Also, the plus button to copy the logic, make it the same color as the icons pencil and basket are black.» + «Do it and post it.»
108. Ошибка после установки с «Нет» (поверх): Out-File/nul в FreePorts; Angular CLI не найден в web\node_modules — починить install-over и launcher.
109. После успешного старта: `EPERM mkdir ... Program Files\...\web\.angular\cache\...\vite\deps_temp_*` — права на запись кэша Angular под Program Files.
110. «When copying the logic, after the message… clicks OK, rewind the form so that this new logic is visible» — прокрутка к копии после OK; разворот уже есть; выложить + контекст.
111. «Add comments to all procedures and functions… write help… next to the gear… icon… white on black… put in the repository.»
112. Upgrade DB on installer «No»: keep table data; ALTER/add columns via 01; recreate procedures/functions; do not DROP DATABASE.
113. Keep CREATE full schema + ALTER that never fail; comment why each ALTER (upgrade existing DBs).
114. Remember test period; portfolio SL/TP verticals on equity; live equity+papers same as test (lazy/non-block); fix table vs panel test finres mismatch.
115. «Always put changes in the installer when needed (DB, Angular, everything at once)… then put out what I corrected in the repository, installer, everything.»
116. After local Setup + No: no equity tiles, finres still differ — INSTALL_PROTOCOL ExitCode 1: install.ps1 ParserError on em-dash; post-install never finished (npm/API restart).
117. «Add cash fund param (TMON/LQDT) + amount threshold default 100000; gear → general settings with cleanup checkbox for unused prices/tests/logs; DB icon for schema.»
118. «Make a plan and post it» / «Do what you planned» / «Stop planning and do what is planned!» — implement cash-fund park + scheduled cleanup.
119. «The product that is purchased must be visible in the block of securities, both in the test and in the real trade… at the top of the list.»
120. «Learn Futures… when I choose Futures in testing it loads prices and tests; same for combat… T-Bank token didn’t save / can it fly off?»
121. «Futures again, not a single test transaction… look, is it right or again something fell?»
122. «Add export/import for logics: checkboxes on the right, Export/Import buttons on the subtitle row; message with names; papers included, tests not.»
123. «Add 5 trend + 10 counter-trend OsEngine logics not yet in seed; on upgrade do not erase existing/copied logics — insert if not exists.»
124. «Update Help DB structure for all changes and idempotence; tables/routines from DB when connected, else from SQL scripts; check it is not broken.»
125. «Show testing period on the test line as day/month/year from–to, readable; keep existing places.»
126. «TMON not purchased in test; empty papers list though params set.»
127. «Post changes in the repository. Only the installer needs to be assembled first.»
128. «В тесте дата/время сделки = по свечам, не wall-clock прогона; блок «Торговые периоды» до ЦБ с галочкой учитывать неторговые (вкл. по умолчанию) и кнопкой установить как на MOEX; параметр закрывать позиции в конце дня (кроме фондов), выкл. по умолчанию.»
129. «Make another installer for linux for macbook… updated every time when changing the project» — Linux tar.gz + freshness like Windows.
130. Sunday trades with NTP off; need add/delete/edit period lines; TMON not bought with positive PnL; reassemble installer and post.
131. Same test: TMON must buy each candle on equity excess over 1M; +13k finres → buy as much free cash allows ≤ excess; do not sell fund / stay in it.
132. After SQL-robots / hang fixes: hard rewind — «I'll have to twist this very tightly» to **19.07.2026 ~12:57 / `29ed3ba`** (last ship before SQL-robots message).
133. Hang finally over; TMON in papers but zero — park TMON in Angular/Node test; exclude from SL/TP test+live; show bought qty (ост.) in papers.
134. Test passed: TMON «ост. 0» though +70 — never sell fund (no SL/signals); remainder must stay.
135. After test TMON still shows 0 with ост. +70 — show money at current/period price (в портф.), not realized 0.
136. Papers list: next to ост. — short money remainder + current price; test and live.
137. New indicator ≈ LINREG but vary period max→3, pick min max|distance to line|; logic like LinReg Fade with new indicator.
