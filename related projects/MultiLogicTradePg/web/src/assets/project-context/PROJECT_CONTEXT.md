# MultiLogicTradePg — контекст проекта

> Живой файл контекста для продолжения работы с разных устройств и в Cursor.  
> **Обновлять перед каждым push в репозиторий** — см. `.cursor/rules/project-context.mdc`.
> Запросы пользователя текстом — в **`docs/USER_INSTRUCTIONS.md`** (Help → «Инструкции пользователя»); здесь только ссылка.

**Единственная рабочая копия:** `related projects/MultiLogicTradePg` в https://github.com/RobinZGit/OsEngine  
**GitHub Pages:** https://robinzgit.github.io/OsEngine/ (workflow `.github/workflows/pages.yml` в OsEngine, `base-href=/OsEngine/`)  
**Старый репозиторий:** https://github.com/RobinZGit/MultiLogicTradePg — **archived** (read-only), не пушить; Pages с него больше не деплоятся.  
**Последнее обновление:** 2026-07-29 — merge Crypt + My Projects hub to main (GitHub Pages); equity-curve let fix; sticky row CSS; Testing header

> **Важно для агентов:** вся разработка и push — только в **OsEngine**. Отдельный `RobinZGit/MultiLogicTradePg` архивирован. Не синхронизировать туда код и не ждать Pages с того репо.

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
| `01_multilogictrade_tables_and_data.sql` | Таблицы, индексы, справочники (идемпотентно, **v54**) |
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
- **`logic_stops`** — стоп-лосс и тейк-профит (`rule_kind` stop_loss|take_profit; stop scopes: security|**security_resume** (бумага×сторона)|security_inversion|portfolio|portfolio_resume; take_profit: security|portfolio|**portfolio_ltp_renew**; `value` / `value_unit`; колонка `inversion_value` устарела / не используется);
- **`logic_securities`** — портфель бумаг логики + пауза resume по сторонам: `real_trading_paused_long/short`, `stop_resume_*_long/short` (v48); `real_trading_paused` = OR сторон;
- **`logic_trades`** — сделки: `position_event`, `signal_kind`, `is_simulated`, **`is_fictitious`**, `commission`, **`financial_result`** (только Close), **`run_id`** (прогон теста → `logic_backtest_runs`; NULL у боя), `bar_dt`, `status`; side Open/Close через `sides`; уникальность бара: `(logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow)`;
- **`logic_trade_lots`** — пакеты закрытия (FIFO / средняя): связь close↔open, суммы, комиссии, PnL по пакету;
- **`logic_param_defs`** + **`logic_params`** — параметры торговли (EAV): **`timeframe`**, `position_size_pct`, `max_open_positions`, `initial_balance`, `current_balance`, **`commission_pct`**, **`cost_method`** (FIFO|AVERAGE), **`base_annual_rate_pct`**, **`cash_fund_code`** / **`cash_fund_threshold`** (порог **equity**, default **1000000** = `initial_balance` теста; не 100000) / **`last_cash_fund_bar_dt`** (`logic_park_excess_cash` / `logic_backtest_park_excess_cash`: BUY `min(кэш, equity−порог−уже_в_фонде)`), `last_trade_check_at`;
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

## Что сделано (актуально на 2026-07-29)

### 2026-07-29 (Crypt + My Projects → GitHub Pages, merge main)

- Инструмент `tools/parity-stego.html` (+ `web/src/assets/tools/parity-stego.html`).
- Pages: **`/OsEngine/crypt-parity-stego.html`**, хаб **`/OsEngine/my-projects.html`**; в шапке **My Projects** + **Crypt**.
- Ключ: пустой = без ключа; иначе ≥3 символов. Decrypt auto: text vs picture.
- Хаб: Crypt, MultiLogic PG, FINRESP/TradeA, UN Calculator, Диетолог, TotalCalendar (без MacroRithm).

### 2026-07-29 (equity-curve: Assignment to constant variable)

- `dateFromFinal` был `const`, затем присваивался из meta run → TypeError на `/api/logic-trades/equity-curve`.
- Фикс: `let dateFromFinal`.

### 2026-07-29 (sticky ends + шапка теста на всю ширину)

- Цвет строки через `--logic-row-bg` → липкие края всегда залиты (серый/синий/жёлтый/сиреневый) с первого кадра и после раскрытия.
- Шапка «Тестирование» full-bleed (кнопки Экспорт/Стоп в том же фоне).

### 2026-07-29 (export: LOGIC_TRADE_SELECT is not defined)

- После Phase A константы `LOGIC_TRADE_SELECT` / `_TEST_PANEL` остались в `logics.js`, а `/api/logic-trades/export` — в `trades.js`.
- Фикс: `api/lib/logic-trade-sql.js` + require в `trades.js`.

### 2026-07-29 (справка: глава «Инверсия логики»)

- Help → отдельная глава: принцип галочки, что меняется / не меняется, примеры SMA и LinReg Fade, отличие от security_inversion, ссылка на XOR в TradeA.
- В «Логики» — краткая отсылка; UI: «Инверсия (Long↔Short, те же условия)» + title.

### 2026-07-29 (инверсия: нет зеркала эквити + второй тест «висит»)

- **Данные (runs 210/211):** без inversion ~1650 Open / FinRes ~17k; с inversion ~6615 Open / FinRes ~160k — не зеркало.
- **Корень:** галочка делала OsEngine ReverseSignals+ReverseSides **без XOR**. Для LinReg Fade `pp <= LOWER` → `pp >= LOWER` (почти всегда true) → спам.
- **MultiLogicTradeA:** `isReverseSignalsEnabled = ReverseSignals XOR ReverseSides`. При **обоих** флагах ON эффективна только смена сторон → зеркало. «Сопряжённые» ⇄↔ = этот угол. L3/L4 — отдельные запечённые формулы («зеркало L1/L2»), не runtime-галочка.
- **Симметрия X:** те же условия, Long↔Short (opens+closes).
- **Фикс:** evaluate_at(..., FALSE); flip только стороны. Накатить `sql/logic_backtest_runner.sql` (+ trade/opt); уже running-тесты перезапустить.
- **Hang:** спам сделок от старой инверсии условий.

### 2026-07-29 (mid-run: FinRes +92k, эквити уходит в минус)

- **Симптом:** шапка «Фин. результат» растёт (полный `/pnl-summary`), синяя «общая» эквити заканчивается глубоко в минусе; на панели `(…/2500)`.
- **Не корень:** инверсия / второй параллельный тест как разная математика PnL — оба пути (FinRes и equity-curve) режут shadow/OPT одинаково.
- **Корень:** mid-run сделки = `test-panel` (последние **2500** Close). Если `/equity-curve` пуст/задержался, график строился из этой усечённой выборки → конец кривой ≠ FinRes. Два теста усиливают таймауты equity-poll.
- **Фикс:** mid-run не строить эквити из panel-trades; сброс equity при старте; `run_id` на equity-curve; refresh при расхождении с FinRes; лёгкий align конца кривой к FinRes.

### 2026-07-28 (Phase A: Express routers из `api/server.js`)

- Монолит ~5.2k строк → тонкий `api/server.js` (~80 строк) + `api/lib/server-shared.js` + `api/routes/{settings,indicators,market,references,logics,trades,backtest,ops}.js`.
- URL и поведение без смены контракта; smoke: `node --check` + регистрация **96** маршрутов.
- Скрипт разбиения: `api/scripts/split-server-routes.mjs`; локальный бэкап `server.js.pre-routes-bak` в `.gitignore`.
- Phase B (дробление `logics.component.ts` / огромных SQL) — **не** начата.

### 2026-07-28 (актуализация Help / схемы / контекста / инструкций)

- Help: главы «Бой T-Bank: лоты…», «Экспорт и отчёты»; обновлены логики (метла, I/O шапки, sticky, last OPT), вкладки, API.
- PROJECT_CONTEXT: устаревшие формулировки sell-all (LIMIT→market) и lot_size; ссылка на последние USER_INSTRUCTIONS.
- schema-offline.json пересобран из 01/02 (`generate:schema`); COMMENT ON PostOrder/sell-all уже в 02.
- Правило: при каждом push — и контекст, и новые пункты USER_INSTRUCTIONS.

### 2026-07-28 (Продать всё: недопродажа после shares→lots)

- **Симптом:** «Продать всё» на рынке продавало меньше лотов, чем было в портфеле.
- **Причина:** после фикса PostOrder (штуки→лоты) sell-all продолжал брать `quantityLots` и слать без `is_lots=TRUE` → повторное `floor(lots/lot_size)` (напр. 13→1 при lot=10). Старый fallback «quantity=лоты» был неверен (`quantity` = штуки).
- **Фикс:** sell-all считает лоты из `quantity`−`blockedLots`×lot; PostOrder с `TRUE`; hotfix-скрипт обновляет и sell-all.

### 2026-07-28 (бой: PostOrder штуки→лоты — перерасход FLOT)

- **Симптом (logic 1720 remote):** Short Open FLOT `qty=13` в книге, комиссия ~4.90 ≈ 0.05% от **130×75.27** — брокер исполнил **13 лотов**, а не 13 акций (TQBR lot=10).
- **Причина:** `tbank_post_order` слал `quantity` как штуки; T-Invest API ждёт **лоты**. Sell-all уже слал лоты; runner/stops/cash-fund — штуки.
- **Фикс:** `tbank_post_order(..., p_quantity_is_lots DEFAULT FALSE)` делит штуки на `instrument.lot` (GetInstrumentBy + кэш `securities.lot_size`); sell-all/bond buy передают `TRUE`. Обновлены lot_size MOEX TQBR в `01` (FLOT=10, SBER=1, FEES=10000, …). Hotfix: `api/scripts/apply-tbank-post-order-lots.sql`.
- **На remote:** применить hotfix SQL или полный upgrade `01`/`02` — UI-only не чинит бой.

### 2026-07-28 (иконки снова справа + всегда видны)

- `col-actions` (edit/copy/broom/delete) снова в конце строки; sticky справа вместе с чекбоксом экспорта; «Вкл.» sticky слева.
- Таблица не сжимает иконки (`min-width` + scroll); на узком экране скрываются вторичные колонки (acc_id/брокер/актив./счёт), имя и иконки остаются.

### 2026-07-28 (действия строки слева + только шапочный import/export)

- Per-row import/export убраны — только шапка (чекбоксы + иконки I/O); bundle v2 / overwrite by name / last OPT.
- (Слева sticky для actions — откатили как «ugly»; см. блок выше.)

### 2026-07-28 (иконки export/import на доске + OPT в bundle)

- В шапке — иконки export/import; ранее также были в строке (снято в follow-up выше).
- Bundle v2: params/signals/stops/securities + `last_opt_grid` (без сделок/свечей/тестов); импорт по имени — перезапись, иначе новая; кэш OPT для «Применить лучшие OPT».

### 2026-07-28 (кэш Apply best OPT + авто-отчёты)

- `logics.last_opt_grid_*`: результат offline-сетки живёт на логике до «Параметры по умолчанию» / «Сброс OPT» (cleanup больше не уничтожает Apply).
- `resolveLastOptGridResults`: кэш → run → finalize по arms; Apply всегда активна (фиолетовая); авто-открытие отчёта теста и OPT после прогона.
- Finalize также при Стоп; SQL 01/02 + `api/lib/opt-grid-store.js`.

### 2026-07-28 (подписи OPT на панели сигналов)

- «Сброс параметров» → **«Параметры по умолчанию»**; Help/docs.
- Кнопка **«Сброс OPT»** в параметрах — жирный янтарный стиль, заметнее.

### 2026-07-28 (метла + цвет OPT + анти-мигание)

- Кнопка-метла на доске логик: `POST /api/logics/:id/shadow-reset` — удалить live `is_shadow` сделки, снять pause/инверсию, `is_active=TRUE` по всем бумагам логики; при enable — rating precalc.
- Тест **с оптимизацией**: сиреневый ряд/блок (не жёлтый), заголовок «Тестирование с оптимизацией».
- Анти-мигание: `/logic-backtest/active` отдаёт `opt_grid_enabled`; UI sticky-merge флага для того же `run_id`.

### 2026-07-28 (оптимизация в том же тесте)

- Чекбокс **«Оптимизировать»** рядом с Запуск в блоке Тестирование; модалка параметров из формул сигналов (шаг, итерации ±, лимит 81 комбинаций).
- Один `logic_backtest_runs`: чемпион = defaults (эквити/сделки как обычно); сетка = бумажные `opt_lane` без mid-run promote; `logic_opt_grid_finalize` → `opt_grid_results`.
- Один последовательный прогон баров (не N параллельных потоков на ветку).
- Отчёт OPT (HTML); на панели «Сигналы» — «Применить лучшие OPT» / «Параметры по умолчанию».

### 2026-07-28 (resume_sl_no_reduce — не снижать цель security_resume)

- Param `resume_sl_no_reduce` (boolean, **default false**): UI checkbox «Не снижать цель возобновления SL» в параметрах логики.
- Только для `security_resume`: при новой остановке цель = `GREATEST(HWM, track_before)`; HWM хранится в `stop_resume_hwm_long/short` (live + backtest); при resume HWM **не** сбрасывается.
- Helper `logic_resume_sl_peak_target`; warm-up переносит HWM; API/Help/docs.

### 2026-07-28 (fix CI GitHub Pages — 01 parameter_values)

- **Ошибка:** `relation "parameter_values" does not exist` на `UPDATE parameter_values` (v57 cleanup default) — UPDATE стоял **до** `CREATE TABLE parameter_values`.
- **Фикс:** перенести UPDATE сразу после seed `parameter_values`.

### 2026-07-28 (приоритет открытия: лучший PnL бумаги)

- При лимите слотов/room: обход бумаг `ORDER BY` сумма closed FinRes **DESC**, затем `display_order`, `id` (тест, бой, OPT-ветки).
- В начале теста у всех 0 → стабильный tie-break; дальше слоты получают бумаги с лучшим текущим результатом.
- **Hotfix:** коррелированный `SUM` на каждую бумагу тормозил бар → mid-run UI пустой (сделки/портфель), FinRes из `/pnl-summary` ещё рос. Заменено на один `LEFT JOIN … GROUP BY` на бар; panel timeout 20s + poll каждый тик.

### 2026-07-28 (remake SL security_inversion — без % инверсии)

- Убраны UI/API для `inversion_value`; один порог — `value` (%).
- Машина по бумаге: DD≥value → close + shadow; shadow к пику/нулю → toggle `real_trading_inverted`; тот же % на инвертированной логике.
- SQL: `logic_stop_runner.sql` + `logic_backtest_runner.sql`; Help обновлён.

### 2026-07-28 (цвета зон на графиках бумаг — как просил Sergey)

- Зелёный = **обычная** логика; серый = **shadow**; розовый = **инверсия**. Зоны покрывают весь период теста.
- `buildShadedDisabledRanges`: SL → shadow; реальный Open после shadow+security_inversion → toggle pink; не путать с «выкл.» и не красить green как shadow.

### 2026-07-27 (зоны на графиках бумаг)

- Эквити/цена бумаг: зоны режима; легенда обновлена 2026-07-28 (обычная/shadow/инверсия).

### 2026-07-27 (OPT promote: sigma «ползёт вниз», FinRes-дыры 10×)

- **Симптом (тест #2136):** почти всегда promote `std_dev:down` (2 → ~0.25); в окне FinRes ветки ≫ чемпиона при ±10% параметра.
- **Причины:** (1) **баг сравнения размеров** — чемпион в тесте уже `LEAST(cash, equity)`, OPT paper до фикса брал сырой cash / без room → абсолютный FinRes ветки раздут; (2) **метрика** = сумма closed FinRes за окно → у mean-reversion более узкий канал = больше сделок = выше сумма (даже при честном размере) → ratchet вниз; (3) `logic_opt_lane_finres` без `run_id` мог мешать чужие тесты.
- **Фикс:** OPT sizing = cycle budget + room (уже); sync `logic_backtest_runner.sql` free_cash=`LEAST`; FinRes + `run_id` + exclude `opt:promote`. Пересчёт окна с MTM/нормировкой — по желанию (отдельное решение).

### 2026-07-27 (OPT paper без потолка equity — «лоты 100k»)

- **Симптом (remote logic 359, новый дамп):** после фикса чемпиона в списке сделок снова «огромные» short/long (~комиссия 30 ≈ 0.03% от ~100k); брокер по-прежнему `30042` на части реальных Open.
- **Разбор:** реальные champion-opens ~10% от ~43k (норма); **OPT paper** (`is_simulated`, `opt_lane`) считал лот от сырого `logic_position_sizing_base` / fallback **1_000_000**, без `logic_exposure_cycle_budget` и без room `%×max_open_positions`.
- **Фикс:** `process_logic_opt_trades` — live: `logic_exposure_cycle_budget`; test: `LEAST(cash, backtest equity)`; на ветку — `logic_open_notional_exposure` + room как у чемпиона (`sql/logic_opt.sql` + `02`).
- **На remote:** обязательно применить обновлённый **`02`** (installer/upgrade). UI-only install без SQL не закрывает дыру.

### 2026-07-27 (кнопка «Сброс OPT» у окна свечей)

- В «Параметры логики» слева от «Свечей окна OPT» — кнопка **Сброс OPT**.
- `logic_opt_reset_to_initial`: вернуть начальные формулы (earliest snapshot / `params_prev` первого promote), `DELETE` live `opt_lane` сделок, сброс `last_opt_eval_bar_dt`, apply indicator params.
- При первом live-курсоре OPT — авто-snapshot начальных баз.
- API: `POST /api/logics/:id/opt-reset`.

### 2026-07-27 (плечо 1: не считать выручку шорта / заёмный кэш)

- **Симптом (remote logic 359):** short Open уходил в маржу сверх остатка при «плече 1» (10% × 10 поз); брокер `30042 Not enough assets for a margin trade`.
- **Причина:** `position_size_base=free_cash` → T-Bank `cash_amount` / test `current_balance` растут от выручки short (и могут включать заём); между циклами потолок `%×max` пересчитывался от раздутой базы. Mid-cycle freeze не спасал cross-cycle.
- **Фикс:** `logic_account_net_equity` (real = broker `amount`; fake = cash − short notional + long MTM) + `logic_exposure_cycle_budget` = `LEAST(sizing_base, equity)`. Live `process_logic_trades` + `sql/logic_trade_runner.sql`; backtest `free_cash` = `LEAST(cash, portfolio_equity)`.
- **На remote:** применить обновлённый `02` (или полный upgrade), иначе бой продолжит старую логику.

### 2026-07-26 (mid-run: пустые бумаги/открытия/закрытия)

- **Причина:** после фикса «не вешать вкладку» mid-run не грузился full trade dump; эквити шла из `/equity-curve`, а списки сделок/бумаг — из пустого `trades[]`.
- **Фикс:** `GET /api/logic-trades/test-panel` — все champion Open + до 2500 последних Close (без OPT paper); poll при открытом «Тестирование» во время running. Полный dump — после finish.

### 2026-07-26 (seed LinReg Fade Twice Optimized)

- Новая дефолтная логика **LinReg Fade Twice Optimized** (FAKE, выкл.): как LinReg Fade, но `OPT(std_dev,10)` + `OPT(period,10)` → чемпион + 4 ветки.
- Seed в `01` (v56), `sql/ensure_seed_logics.sql`, `api/scripts/seed-linreg-fade-twice-optimized.sql`.
- Бумаги/стопы как у LinReg Fade; `opt_eval_candles=200` (после v56).

### 2026-07-26 (эквити mid-run ≠ FinRes)

- **Симптом:** во время теста FinRes растёт (напр. +251k), «Эквити портфеля» почти плоская / другой масштаб.
- **Причина:** после фикса «не вешать вкладку» полный dump сделок mid-run не грузится; FinRes — из `/pnl-summary`, график — из устаревшего `trades[]`.
- **Фикс:** `GET /api/logic-trades/equity-curve` (только Close champion, те же фильтры что pnl-summary); poll при открытом блоке «Тестирование»; панель предпочитает live curve. Champion-only (`opt_lane=''`) сохранён. Full 50k dump по-прежнему только после finish.

### 2026-07-26 (GitHub Pages CI: verify-sql падал)

- **Ошибка:** `relation "logic_params" does not exist` (01:1330) на чистой `multilogictrade_verify`.
- **Причина:** `DELETE FROM logic_params … margin_leverage` стоял **до** `CREATE TABLE logic_params` (с коммита exposure cap).
- **Фикс:** DELETE перенесён после CREATE/ALTER.

### 2026-07-26 (форма «висит» при раскрытии параметров во время теста)

- **Причина:** poll качал полный список тестовых сделок (до 50k / ~40 МБ) пока `running` — парсинг вешал вкладку («загрузка…» у параметров).
- **Фикс:** не загружать full test trades dump во время running; сделки — после finish; прогресс/FinRes из status/pnl-summary.

### 2026-07-27 (автообрезка indicator_values)

- `cleanup_unused_indicator_values()`: сироты (нет активной `security_indicator_series`) + `dt` старше keep_days (120); running/pending бэктесты защищены (`date_from − warmup`).
- Вызов: после каждого бэктеста (API fire-and-forget); из `cleanup_trading_disk_space`; scheduler при `APP_CLEANUP_DISK` (default ON, v57).
- Не трогает чужие test-сделки (в отличие от полного disk cleanup).

### 2026-07-27 (OPT promote: closed + ΔMTM окна)

- В отчёте #2136 / run 191 огромный разрыв FinRes (448 vs −8956): в БД жила **старая** метрика «только Close» (MTM-функция не держалась в PG).
- Плюс абсолютный рублёвый FinRes при разном числе/размере сделок (чемпион ~5× больше opens).
- Скор: `closed(from,to] + MTM(to) − MTM(from)`; `logic_trade_open_remaining_qty_at`; накатка на локальную БД.

### 2026-07-27 (OPT promote: FinRes + MTM открытых)

- Скор сравнения чемпион vs OPT-ветки: сумма `financial_result` Close в окне **+** MTM остатка Open на баре оценки (как будто закрыли по `prices.close` TF, минус комиссия Close).
- Устраняет bias «0 закрытий → FinRes 0 лучше убытка чемпиона».
- `logic_opt_lane_finres(..., p_tf_id)`; sync `sql/logic_opt.sql` + `02`.

### 2026-07-27 (форма: Свечей окна OPT = 200)

- Дефолт `opt_eval_candles` **200** (раньше 20): `logic_param_defs`, seed Optimized/Twice, UPDATE всех `logic_params`, fallbacks в `logic_opt`/`02`, API/UI/help.
- `01` v56 UPDATE; `sql/ensure_seed_logics.sql` синхронизирован.

### 2026-07-26 (форма: Свечей окна OPT = 20)

- Поле в «Параметры логики»: `opt_eval_candles`, дефолт **20**.
- UPDATE всех логик: значение 20 (раньше у Optimized иногда было 5).
- Seed/ensure больше не ставят 5.

### 2026-07-26 (свитч на баре: Close → Open с учётом кэша)

- Порядок сигналов: `close` затем `open` (ORDER BY position_event).
- **Всегда** (без параметра): после успешного Close в том же цикле — пересчёт `v_spent_notional` и обновление `v_cycle_budget` / `v_max_exposure` (кэш появился или ушёл), чтобы следующий Open не уходил в долг и видел комнату.
- После Open базу по-прежнему не трогаем (freeze от short-кэша). Live + backtest.

### 2026-07-26 (эквити vs FinRes на OPT-тесте)

- **Симптом:** FinRes плюс, кривая «Эквити портфеля» глубоко в минусе.
- **Причина:** `/pnl-summary` и FinRes — только чемпион (`opt_lane=''`); график суммировал и OPT paper (`std_dev:up/down`) с большим минусом.
- **Фикс:** `buildEquityPoints` + локальный суммарный PnL в панели — без `opt_lane≠''` (как FinRes).

### 2026-07-26 (ускорение бэктеста OPT)

- Локальный тест «висел» без locks: `logic_backtest_process_bar` + OPT на 34 бумагах (~0.5 бар/с).
- **Фикс:** в `process_logic_opt_trades` счётчик `v_open_lane` — один раз на OPT-ветку (было на каждую бумагу); `logic_open_notional_exposure` — set-based + опциональный `p_run_id`; индекс `idx_logic_trades_test_run_lane`.
- Важно: накатывать только полный `02` (не отдельные `sql/*.sql` с DROP) — иначе пропадают функции (`logic_trade_open_remaining_qty` и др.).

### 2026-07-26 (потолок номинала Open = % × макс. позиций)

- **Правило:** суммарный номинал открытых long+short ≤ `база × (position_size_pct/100) × max_open_positions` (10×10%=100% базы; 20×10%=200%).
- Уже открытые позиции входят в spent; short считается так же, как long (база цикла не растёт от short-кэша).
- Live + backtest; UI hint у «Макс. открытых позиций».

### 2026-07-26 (Scheduled cleanup: set_app_cleanup_last_at)

- **Ошибка:** `procedure set_app_cleanup_last_at(timestamp with time zone) does not exist`.
- **Причина:** процедура была `(TIMESTAMP)`; `CALL …(CURRENT_TIMESTAMP)` передаёт `timestamptz`.
- **Фикс:** сигнатура `TIMESTAMPTZ` + DROP старой; в `sql/app_cleanup_settings.sql` и `02`.

### 2026-07-26 (Setup.ex_ рядом с Setup.exe)

- При сборке копируется `MultiLogicTradePgSetup.ex_` (те же байты; последняя буква расширения `_`) — для выгрузки/скачивания с серверов, где `.exe` режется.
- После скачивания переименовать в `.exe`. В git оба файла; `build-installer.ps1` всегда обновляет пару.

### 2026-07-26 (бэктест Optimized: signal_kind_check)

- **Симптом:** тест `LinReg Fade Optimized` / copy падает: `logic_trades_signal_kind_check` (runs 184–185).
- **Причина:** OPT promote reset пишет `signal_kind='opt'`, а CHECK допускал только `trend|counter|cash_fund`. Не из‑за номера сборки установщика.
- **Фикс:** CHECK + комментарий в `01` (+ тип в `logic-trade.ts`).

### 2026-07-26 (install.ps1 ParserError — seed не запускался)

- **Протокол 17:00 Build 59, ExitCode 1:** `Variable reference is not valid` на `DbMode=$DbMode:` и каскад ошибок на `throw "...(02 restored..."`.
- Post-install **не выполнялся** → ensure_seed / LinReg Fade Optimized не ставились.
- **Фикс:** безопасные строки (`-f` / без `$var:` и без `(02` в expandable string); ASCII-only предупреждения.

### 2026-07-26 (номер сборки на форме установщика)

- На мастере Inno: Welcome — «Версия / Сборка»; полоска `BeveledLabel` на всех страницах; диалог «уже установлен» тоже показывает версию/сборку; `UninstallDisplayName` с build.
- Ранее: `VERSION.txt` + протокол + bump `BUILD_NUMBER` при сборке.

### 2026-07-26 (номер сборки установщика)

- **Проблема:** протокол 16:42 снова `logics=46→46`, «will be reset», без `ensure_seed` — в Program Files остались **v53** и `install.ps1` от 25.07; пользователь ставил **старый Setup.exe**, а не свежий из repo.
- **Фикс:** `installer/BUILD_NUMBER` + `Sync-InstallerVersion.ps1` (bump при каждой сборке); `VERSION.txt` в корень пакета; Inno `AppVersion`/`AppVerName` из build; протокол Windows/Linux печатает `VERSION.txt` в начале.
- Как проверить новую установку: в `INSTALL_PROTOCOL.txt` есть блок `----- VERSION.txt -----` с `Build: N` и шаг `Deploying database 01 -> ensure_seed -> 02` + `Seed OK: LinReg Fade Optimized`.

### 2026-07-26 (v54 / v54b: seed-логики при install-on-top)

- **Проблема:** на установке поверх «LinReg Fade Optimized» не появлялась; протокол 15:57 — `logics=46→46`, в Program Files был **старый 01 без v54**.
- **Фикс v54:** UNIQUE(name); account fallback; ensure-блок в `01`; бумаги Optimized после LinReg Fade.
- **Фикс v54b:** отдельный `sql/ensure_seed_logics.sql` после `01`; installer **падает**, если в `01` нет маркера v54 или нет `LinReg Fade Optimized`; Linux тот же путь; сообщение «will be reset» уточнено (wipe vs upgrade).

### 2026-07-26 (Купить облигации: несколько фондов + зеркала)

- В select: **TBRU**, **SBGB** (Первая / RGBITR), **OBLG** (ex VTBB / RUCBTRNS).
- Состав SBGB/OBLG при расчёте обновляется с **MOEX ISS** analytics; если недоступно — статический снимок в `bond-tbru-data.js`.
- У каждого фонда список зеркал (porti / cbonds / rusetfs / MOEX) — если одна ссылка недоступна, есть другие.
- UI fallback каталог без API; план показывает источник состава.

### 2026-07-26 (Тест: «год.» = «—»)

- **Причина:** `annualPct()` брал дни только из `backtestRun.date_from/to`; после завершения/reload `recoverActive` не восстанавливает completed run → период null → «—», хотя FinRes из pnl-summary уже есть.
- **Фикс:** fallback дат: `backtestRun` → `testPeriodFrom/To` из pnl-summary → min/max `bar_dt` сделок; `returnPct` при пустом `initial_balance` → 1_000_000 (как бэктест).

### 2026-07-26 (Купить облигации — UX)

- Кнопка «Купить облигации» на **всех** счетах (не только real T-Bank); заявки по-прежнему через токен T-Bank.
- Сумма всегда редактируема; без авто-расчёта при открытии.
- «Рассчитать» — яркая первая; «Купить» бледная до расчёта, затем зелёная. Ошибки заявок — в отчёте в диалоге.
- **Fix:** форма больше не прячется за «Загрузка…» (если `/bond-funds` висел — поля были недоступны). TBRU сразу в select; native `<dialog>` заменён на `div` с z-index 1200+.
- **Fix NG5002:** в шаблоне литерал `@` цены ломал Angular control flow → «по {{ price }}».

### 2026-07-26 (Недоступные типы SL/TP + инструкции в Help)

- UI: типы видны в `<select>`, но `disabled` для выбора: SL `portfolio_resume`; TP все портфельные (`portfolio`, `portfolio_ltp_renew`). API отклоняет создание/смену на эти типы.
- **`security_inversion`** (2026-07-28 remake): один `%` (`value`). DD≥value → shadow; возврат shadow к пику/нулю → toggle `real_trading_inverted`; тот же стоп на инвертированной логике; снова через ноль → снятие инверсии. `inversion_value` не используется.
- Дефолт нового TP: `security` (по бумаге).
- `docs/USER_INSTRUCTIONS.md` — только формулировки запросов Sergey; Help → «Инструкции пользователя»; sync в assets; `PROJECT_CONTEXT` держит ссылку без полного дубля.

### 2026-07-26 (OPT в бэктесте)

- В `logic_backtest_process_bar`: после champion signals — `process_logic_opt_trades(..., is_test, run_id)` + `logic_opt_maybe_promote(..., is_test, run_id)`.
- Курсор окна: `logic_backtest_runs.last_opt_eval_bar_dt` (v53) — live `last_opt_eval_bar_dt` не трогаем.
- Champion после promote: `logic_signal_evaluate_at_opt` по базам формулы (без полного sync серий).
- При смене баз — запись в `logic_opt_param_history` с `run_id`; после прогона — `logic_opt_restore_formulas_from_run`.
- Equity / PnL / отчёт — только чемпион (`opt_lane=''`); paper OPT не двигает cash.

### 2026-07-26 (Отчёт: история параметров OPT)

- Таблица `logic_opt_param_history`; снимок при старте теста; promote в `logic_opt_maybe_promote`.
- Секция «Параметры сигналов / OPT» в отчёте (live «Отчёт» + архив); если promote не было — один снимок баз/формул.
- API `GET /api/logics/:id/opt-param-history`; sync `01`/`02`/`logic_opt.sql` + `backtest-report`.

### 2026-07-26 (Backtest failed: ON CONFLICT / opt_lane)

- Runs 181–182 failed instantly: unique index includes `opt_lane`, but `logic_backtest_insert_trade` (and cash-fund park) still used old ON CONFLICT without it → yellow chip vanished.
- Fix: INSERT/ON CONFLICT with `opt_lane=''` for champion/test.

### 2026-07-26 (Backtest: 0 opens + bar speed)

- **Проблема:** прогон 180 — 0 сделок, `test_balance=0`. У Optimized / copy `initial_balance` пустой → `get_logic_param_numeric(..., 0)` = 0 → sizing от free_cash не открывает.
- **Фикс:** default/NULLIF → 1_000_000 в Node + SQL; UPDATE params Optimized%; seed/01 upgrade.
- **Скорость баров:** `logic_backtest_process_bar` (rate→risk→EOD→signals→park) — 1 RTT вместо ~5; cancel check каждые 5 баров.
- Файлы: `sql/logic_backtest_runner.sql`, `api/logic-backtest.js`, seed, `01` (+ sync `02`).

### 2026-07-26 (Backtest load speed)

- **Проблема:** prep «Загрузка цен» по 15+ мин на 34 бумаги M15 — часть бумаг (VTBR, RUAL, TATN…) имеет историю только с ~27.04; `backtest_prices_cached` требовал старт у `date_from` → каждый прогон снова `load_prices` HTTP, хотя баров уже тысячи и брокер раньше не отдаёт.
- **Фикс:** поздний старт при достаточном `v_min_bars` = кэш; конец периода по-прежнему строгий. Default `BACKTEST_PRICE_CONCURRENCY` 1→3.
- Файлы: `sql/logic_backtest_runner.sql`, `api/logic-backtest.js` (+ sync `02`).

### 2026-07-26 (OPT live runner — testable)

- План: `docs/PLAN_opt_formula.md` (не в релиз `real-trade-1`).
- Синтаксис: `@LINREG(...,std_dev=2,...,OPT(std_dev,10))`; ветки 2ⁿ + чемпион; max **3** OPT-ключа глобально (API save reject).
- Схема: `logic_trades.opt_lane`, unique bar book + `opt_lane`; params `opt_eval_candles`, `last_opt_eval_bar_dt`.
- Seed: **LinReg Fade Optimized** (FAKE) — бумаги с LinReg Fade, `opt_eval_candles=5` для теста.
- UI: бейдж «опт …»; PnL summary без opt_lane.
- **Runner:** `sql/logic_opt.sql` — `process_logic_opt_trades` (paper `opt_lane`, calc через `exec_indicator_script`), `logic_opt_maybe_promote` каждые N свечей; вызов из `process_logic_trades`.
- FIFO lots / count open — изоляция по `opt_lane` (+ shadow/test).
- Nested parse `@CODE(...OPT(...))` в SQL.

### 2026-07-26 (GitHub release real-trade-1)

- Релиз **`real-trade-1`**: акцент — **боевая торговля заработала** (T‑Bank real: заявки, комиссии/FinRes, shadow без PostOrder, sell-all → book-close, market/limit, free_cash).
- Assets: `MultiLogicTradePgSetup.exe`, `MultiLogicTradePg-linux.tar.gz` (сборка на `ea2f9be`+).
- Черновик `test-1` оставлен как есть; пауза релизов снята по запросу Sergey.

### 2026-07-26 (Account sell-all → book-close логик)

- **Проблема:** «Продать всё» на счёте закрывало портфель у брокера, но `logic_trades` оставались Open (FLOT/IRAO и др.).
- **Правильнее, чем sell + close-all с PostOrder:** после market sell-all — `account_book_close_logic_positions` → `logic_close_all_positions_at_market(..., p_post_broker=FALSE)` — закрытия в книге с `trade_reason=account:sell_all`, цены/orderId из `sold[]` если есть; **без** повторной заявки.
- UI: отклонённые Open не в списке открытых; `remaining_qty` только для filled/submitted.
- Repair: account 58 / logic 2133 — 2 book-close.

### 2026-07-26 (Shadow real без брокера + UI отклонений + safer cleanup)

- **Баг:** после `security_resume` (FLOT long paused) сигнал Open шёл с `is_shadow=true`, но `process_logic_trades` всё равно делал `tbank_post_order` → реальная покупка с бейджем «теневая» (#602132).
- **Фикс:** PostOrder только если `account_type <> fake` **и** `NOT v_is_shadow` (как в stop-runner). Shadow на real — paper fill без заявки.
- **Данные:** #602132 → `is_shadow=false` (был реальный orderId); снят pause long по FLOT, чтобы позиция управлялась в боевом треке.
- **Тест:** shadow **не** смешиваются с боевым cash/equity/open-count/`pnl-summary` (только отдельный resume-track); в списке видны с бейджем.
- **Статус сделок:** `Отклонена (причина)` из `note`; строка растёт по высоте.
- **Disk cleanup:** advisory lock + timeouts; UI/API про риск `APP_CLEANUP_DISK`.

### 2026-07-26 (Pages → OsEngine; MultiLogicTradePg archived)

- GitHub Pages деплоится из **OsEngine** (`.github/workflows/pages.yml`), сайт: https://robinzgit.github.io/OsEngine/
- Angular `baseHref` / CI `--base-href` → `/OsEngine/`
- Репозиторий `RobinZGit/MultiLogicTradePg` **архивирован** (не удалён); старый workflow Pages помечен DEPRECATED
- Единственная рабочая копия: `related projects/MultiLogicTradePg` в OsEngine

### 2026-07-26 (Бой: order_execution, free_cash default, комиссия с T-Bank)

- **`order_execution`** (`market`|`limit`, default **market**): UI «Тип исполнения заявок»; `tbank_post_order(..., p_order_execution)`; runner/close/stop/cash-fund читают `logic_order_execution`.
- Accounts **«Продать всё»**: всегда `ORDER_TYPE_MARKET` (не зависит от параметра логики).
- **`position_size_base` default = `free_cash`** (v51): install `01`, API/UI fallback, SQL sizing/backtest; миграция старого `portfolio` → `free_cash`.
- **Боевой FinRes:** комиссия real с T-Bank (`executedCommission` / GetOrderState), **не** из `commission_pct` (только fake/тест). Хелперы `tbank_order_commission`, `tbank_order_unit_price`, `logic_sync_real_trade_broker_fees`.
- Стоп-закрытия на real: PostOrder + комиссия брокера (раньше писались paper `filled` без заявки).
- Apply-скрипты: `api/scripts/apply-tbank-*.sql`, `apply-position-size-base-free-cash.sql`.

### 2026-07-26 (Бэктест: params из формулы сигнала → series → sync)

- Node `logic-backtest.js` и SQL `logic_backtest_ensure_security_data`: перед кэшем индикаторов — `ensure` → `logic_apply_indicator_params_from_signals` → sync только если params изменились или нет кэша / перегрузили цены.
- Apply принимает алиасы `std`/`std_dev`, `fast`/`fast_period`, …
- UI defaults: LINREG/BB/SQUARE → `period=20,std_dev=2,series=MIDDLE`.
- OPT / редакторы параметров — не делались.

### 2026-07-26 (Архив отчётов тестов — PostgreSQL, не browser cache)

- **Почему Postgres, не localStorage:** мультидевайс, переживает очистку браузера, рядом с `logic_backtest_runs` / сделками.
- Таблица **`logic_backtest_reports`** (v49): HTML + summary JSON на каждый `run_id` (UPSERT).
- Сохранение **вне bar-loop**: `schedulePersistBacktestReport` (fire-and-forget, mutex на run_id) при `completed|cancelled|failed`; редкий snapshot каждые 500 баров.
- API: `GET /api/logic-backtest/reports`, `GET …/reports/:id` (prev/next), `POST …/reports/rebuild`.
- UI: кнопка **«Отчёты тестов»** у полосы процессов; модалка со списком, HTML iframe, ←/→ и стрелки клавиатуры.

### 2026-07-26 (UI: полоса процессов без дёрганья таблицы)

- Полоса «Процессы» всегда одной высоты; чипы в один ряд со скроллом по X (без wrap).
- Пустое состояние «нет активных» — таблица логик не прыгает при появлении/исчезновении Postgres/тестов.

### 2026-07-25 (Backtest: критическая медленность)

- Причина: `logic_backtest_portfolio_equity` через `DISTINCT ON` + join `prices` (~0.4s/вызов; park + каждый open в signals).
- Фикс: LATERAL last price по индексу; Node: cancel 1×/бар, PnL SUM раз в 25 баров, sync бумаг раз в 100.
- Замер: `process_signals` ~2.2s → ~0.27s на том же баре.

### 2026-07-25 (Backtest: resume после рестарта API/формы)

- После убийства API (bat FreePorts / перезапуск) прогоны со статусом `pending|loading_*|running` **не остаются зомби**: при `listen` вызывается `resumeOrphanBacktests`.
- Тот же `run_id` продолжается с `processed_bars` (баланс, сделки, `logic_backtest_security_state` не стираются).
- Свежий Start по кнопке — как раньше (wipe test trades логики).

### 2026-07-25 (выкладка: OsEngine + MultiLogicTradePg Pages)

- Push зеркала OsEngine и upstream **MultiLogicTradePg** (чтобы Pages пересобрался).
- Account: sell-all + buy TBRU bonds (real only); UI labels остатков боя; prices single-flight; finres колонка = шапка Тестирования; Pages CI sync:context + assetUrl.
- Installers пересобраны. **no GitHub release**.

### 2026-07-25 (GitHub Pages: старый UI / нет иконок)

- **Причина:** Pages = `RobinZGit/MultiLogicTradePg` (workflow); последний deploy **2026-07-15**. Свежий код шёл в mirror OsEngine → Pages не обновлялся.
- **CI:** перед `ng build` — `npm run sync:context` + `generate:schema` (раньше `npx ng build` пропускал prebuild → контекст мог не попасть в артефакт).
- **Offline на Pages:** `assetUrl()` учитывает `base-href=/MultiLogicTradePg/` для `PROJECT_CONTEXT.md` и `schema-offline.json` (книга/структура БД без API).
- Нужен push в upstream MultiLogicTradePg, чтобы сайт обновился.

### 2026-07-25 (Счета: продать всё / купить облигации — только real)

- Справочники → Счета: кнопки **только** у `account_type=real` и брокера T-BANK.
- **Продать всё:** `POST /api/accounts/:id/sell-all` → `account_sell_all_at_market` — market sell всех невалютных позиций (quantity штуки − blocked → лоты, `is_lots=TRUE`); затем book-close логик без второй заявки.
- **Купить облигации:** диалог — сумма (дефолт = свободный кэш), фонд **TBRU** («Т-Капитал Облигации»); жадная покупка по доходности (корп. раньше ОФЗ), состав из MultiLogicTradeA / porti.ru.
- SQL: `sql/account_portfolio_actions.sql` (+ блок в `02`); Node: `api/lib/bond-tbru-*.js`, `account-portfolio-actions.js`.
- На fake-счетах кнопок нет.

### 2026-07-25 (UI: остатки боя ≠ кэш бэктеста)

- Параметры логики: группа «Остатки боя…»; поля **«Начальный остаток (старт)»**, **«Текущий остаток (бой)»**.
- Подсказки явно: `current_balance` обновляет только боевой/sim runner; исторический тест считает свой `test_balance` / эквити / финрез теста.
- Запрос: не путать миллион в параметрах с пересчётом во время бэктеста.

### 2026-07-25 (Backtest: shared prices single-flight)

- **`api/logic-backtest.js`:** загрузка цен — single-flight по ключу `(security_id, timeframe_id, date_from, date_to)`.
- Первый прогон вызывает `CALL load_prices`; параллельные прогоны с тем же ключом ждут Promise и читают `prices` из БД (лог `backtest.prices.shared`).
- Денежный фонд (TMON/…) — тот же single-flight через `ensureFundPricesReady` / `load_prices_http`.
- Индикаторы **не** шарятся одним job: каждый прогон сам делает `ensure_security_indicator_series` + `sync_…` по своим активным сигналам логики.
- Торговая математика bar-loop не менялась. Installers — при push; **no release**.

### 2026-07-25 (Angular: разгрузка при длинных/повторных тестах)

- Один владелец status: `BacktestUiStateService` (без дубля из `LogicsComponent`).
- In-flight cancel status по logicId; pause poll при `document.hidden`.
- Пока running — не качать 50k test trades каждые 2 с; полный список после finish; PnL summary реже + in-flight guard.
- Main `/logics` timer не крутится на скрытой вкладке. Installers; **no release**.

### 2026-07-25 (portfolio_ltp_renew: фиксация всплеска)

- **Проблема:** продажа на любом тике вниз с пика + немедленный re-arm после renew → частые циклы, equity «проседает».
- **Исправление:** закрытие только если откат `(peak−equity)/peak ≥ TP%`; после продажи **latch** — снова взводить только когда `track% < arm%`.
- Колонка `portfolio_linear_tp_latched` на `logics` / `logic_backtest_runs`; applied local DB; installers; **no release**.

### 2026-07-25 (справка: контекст проекта в UI)

- Книга в шапке → отдельные разделы **«Контекст проекта»** и **«Локальная установка (контекст)»**.
- Текст из `docs/PROJECT_CONTEXT.md` / `docs/LOCAL_SETUP.md` (копия в `web/src/assets/project-context/` через `npm run sync:context` / prestart / prebuild).
- Внутри — навигация по главам `##`, чтобы просмотреть историю решений и запросы.
- Installers; **no GitHub release**.

### 2026-07-25 (v48 security_resume по бумаге и стороне)

- **`security_resume`:** просадка / закрытие / shadow / resume **отдельно для Long и Short** на бумаге; другая сторона остаётся боевой.
- Колонки на `logic_securities` и `logic_backtest_security_state`: `real_trading_paused_long/short`, `stop_resume_equity_*`, `stop_resume_baseline_*`, `stop_resume_triggered_at_*`.
- UI label: «По бумаге и стороне (возобновление при достижении суммы прерывания)»; warm-up переносит side-state; runners live+backtest.
- Fix early `logic_stops_scope_type_check` (включает `portfolio_ltp_renew`); BOM stripped from `logic_stop_runner.sql`.
- Applied on local DB; installers; **no GitHub release**.

### 2026-07-25 (линейный TP / лот / бэктест)
- **portfolio_ltp_renew:** линейный тейк по **всему портфелю** с возобновлением (замена `security_ltp_renew`): track% = (equity−initial)/initial; взведение при base%×годы + TP%; трейл пика equity; закрытие всех на падении; pause/shadow/renew как portfolio_resume. UI: «Линейный тейк-профит по всему портфелю с возобновлением».
- **База % лота:** `free_cash` | `portfolio` (default, без ден. фонда) | `portfolio_incl_fund`.
- **Прогресс теста:** рядом с % — дата текущей свечи (`current_bar_dt`).
- **HTML-отчёт:** кнопка «Скачать»; имя файла = логика + период + TF + PnL% + сделки.
- **Fix бэктест portfolio TP:** был кэш vs initial (спам); теперь equity + latch.
- **Fix бэктест v_ltp:** crash на отсутствующей строке state.
- **Install-over:** починка DO$ в 01; при падении 01 после drop routines — всё равно 02.
- **Правило:** перед каждым push обновлять этот `PROJECT_CONTEXT.md` (шапка, сделано, история, запросы).
- GitHub release **не** публиковать, пока боевая торговля не стабильна.

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
73. **Лотность бумаги (v44b+):** `securities.lot_size` (MOEX TQBR, seed обновлён 2026-07-28: FLOT=10, SBER=1, FEES=10000, …); при PostOrder лот с T-Bank GetInstrumentBy кэшируется в `lot_size`. `logic_calc_open_quantity` округляет вниз до лота (штуки в книге). PostOrder: штуки→лоты (`is_lots=FALSE`) или уже лоты (`TRUE`). Колонка «Лот» в бумагах логики.
74. **Инверсия логики:** param `inversion` (default false); **только Long↔Short** при тех же условиях сигналов (зеркало позиций / ReverseSides). Инверсия `≥↔≤` убрана — на каналах (LOWER/UPPER) давала спам сделок. UI галочка в параметрах.
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
92. **Stop-loss security_inversion:** один `%` (`value`); `inversion_value` не используется. normal/inverted real → DD≥value → shadow → возврат к пику/нулю → toggle `real_trading_inverted`. `real_trading_inverted` XOR с глобальной `inversion`. UI без колонки «% инверсии»; badge «инверсия».
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
105. **cash_fund_threshold default 1M:** `logic_param_defs` / API / UI / park SQL fallbacks `1000000` (как `initial_balance`); upgrade UPDATE существующих `'100000'` → `'1000000'`; release `test-1` переиздан с новыми installers.
106. **Yellow backtest survives tabs:** `OperationsRouteReuseStrategy` keeps `/operations` mounted; `BacktestUiStateService` + `/active` recover; panel yellow CSS; no force-reopen of «Тестирование» on every poll.
107. **HTML отчёт теста:** кнопка «Отчёт» рядом с Экспорт/Стоп → окно HTML (Profit Factor, макс. просадка %, Sharpe, Recovery, All/Long/Short) по образцу OsEngine Journal → Статистика.
108. **portfolio_resume SL:** просадка от **пика** equity → закрыть реал, `portfolio_trading_paused`, все сделки shadow; восстановление baseline+shadow_pnl ≥ цели → снова реал; **не** в `logicNeedsWarmup`.
109. **Backtest resume SL:** mid-run resume для `security_resume` (track before/after как в бою); `portfolio_resume` цель = equity до close (не пик); shadow в тесте **не** двигает cash.
117. **v48 security_resume paper×side:** drawdown/close/shadow/resume per Long|Short; other side stays live; columns `*_long/*_short` on `logic_securities` + backtest state; UI rename; warm-up transfer.
110. **v47 counter-trend seed:** +8 логик из OsEngine Custom (NRTR ROC / RAVI BB / Stoch Aroon / MI SMA / SuperTrend CMO / Force Index / BB StdDev / BB Volume); прокси на calc-индикаторы; CountertrendBollinger skipped (= Bollinger Bounce).
111. **Installer PG port probe:** closed ports (5433…) no longer throw under `$ErrorActionPreference=Stop`; TCP check + `127.0.0.1`; post-install reaches `npm ci` / Angular CLI.
112. **01 order fix:** `UPDATE logic_params` (cash_fund_threshold 100k→1M) moved **after** `CREATE TABLE logic_params` — upgrade on DBs without that table no longer aborts before npm.
113. **01 LINREGV cleanup:** `DELETE FROM logic_trade_lots/trades` wrapped in `to_regclass` guards (tables created later in `01`).
114. **Real account sizing:** `logic_ensure_balance` for `account_type<>fake` syncs **T-Bank free cash** (`totalAmountCurrencies` → `cash_amount`) into `current_balance` and uses it for `logic_calc_open_quantity`; no paper `initial_balance`/million fallback; after real fills re-sync from broker (no ±notional on paper); stocks no longer force 1 lot when qty&lt;lot; futures 1-lot only if balance known &gt;0. `fetch_tbank_portfolio_balance` returns `cash_amount`. **GitHub releases paused** until real trading is solid (`.cursor/rules/project-context.mdc`).
116. **Lot sizing base:** param position_size_base (free_cash|portfolio), max_order_amount; real=broker only; test=current or equity; UI group «Расчёт лота» + плечо=max×%/100.
115. **Install-over real balances:** `01` resets `initial_balance`/`current_balance` to `0` for all logics on real accounts; `02` runs `logic_sync_all_real_account_balances()` (broker cash or 0). Helpers `logic_apply_real_account_balances` / `logic_is_paper_balance_text`. API create/copy/PUT/import sync real balances. Never leave paper 1M on real.

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
- [ ] Phase B: разбить oversized UI/SQL (`logics.component.ts`, `01`/`02`) — после Phase A routers.
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
- [x] Remake `security_inversion`: без `inversion_value`; toggle inverted при возврате shadow к нулю (2026-07-28).
- [x] `resume_sl_no_reduce`: HWM цели security_resume (default off); live+backtest+UI; installers shipped (2026-07-28).
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
- [x] Pages на OsEngine; `RobinZGit/MultiLogicTradePg` archived (2026-07-26).
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
- [x] Real trading: size/`current_balance` from T-Bank cash, not paper million (2026-07-25, applied on local DB; no release).
- [x] Install-over: real logics `initial`/`current` from broker or 0 (never 1M); installers + push without GitHub release (2026-07-25).
- [x] v48 `security_resume` per paper×side (long/short); local DB + installers; no release (2026-07-25).
- [x] Backtest: single-flight `load_prices` by key + per-run indicator SQL (`api/logic-backtest.js`, 2026-07-25).
- [x] Real account actions: sell-all portfolio + buy TBRU bonds (UI + SQL/API, 2026-07-25).
- [ ] Validate real-account logic after equity-cap deploy (qty vs equity, no short-proceeds inflation).
- [ ] Apply `02` equity-cap fix on remote (logic 359 / live T-Bank) and confirm no 30042 from oversized short opens.
- [x] GitHub release **real-trade-1** — боевая торговля (2026-07-26).

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
| 2026-07-29 | Merge Crypt + My Projects hub to main (GitHub Pages publish) |
| 2026-07-29 | Push: equity-curve let fix; sticky CSS vars; Testing header full-width; installers |
| 2026-07-29 | My Projects hub on GitHub Pages + Crypt auto-detect decrypt |
| 2026-07-29 | Crypt parity-stego on GitHub Pages (crypt-parity-stego.html + Crypt in app bar) |
| 2026-07-29 | Push: inversion sides-only + Help; equity mid-run; sticky colors; LOGIC_TRADE_SELECT export; installers |
| 2026-07-29 | Push: inversion sides-only + Help chapter; equity mid-run fix; sticky row colors; installers |
| 2026-07-29 | Inversion = Long↔Short only (no ≥/≤ flip); band-fade spam/hang; docs |
| 2026-07-29 | Fix mid-run equity ≠ FinRes (no truncated panel fallback; run_id; align) |
| 2026-07-28 | Phase A: split api/server.js → routes/* + server-shared; Help/docs; installers; push |
| 2026-07-28 | Refresh Help/docs/schema (lots, sell-all, exports); USER_INSTRUCTIONS; installers; push |
| 2026-07-28 | Fix sell-all undersell (lots÷lot_size); quantity-based sell-all; installers; push |
| 2026-07-28 | Fix PostOrder shares→lots (FLOT×10); refresh MOEX lot_size; installers; push |
| 2026-07-28 | Row icons back right + sticky; hide secondary cols when tight; installers; push |
| 2026-07-28 | Sticky left row actions (broom); remove per-row import/export; header I/O only; installers; push |
| 2026-07-28 | Per-row export/import icons; bundle v2 + last OPT; overwrite by name; installers; push |
| 2026-07-28 | Persist last OPT on logics; Apply best recover; auto-open reports; installers; push |
| 2026-07-28 | Rename «Параметры по умолчанию» + bold «Сброс OPT»; installers; push |
| 2026-07-28 | Ship offline OPT grid + broom shadow-reset + lilac OPT UI + flicker fix; installers; push |
| 2026-07-28 | Ship resume_sl_no_reduce (HWM security_resume) + rebuild installers; push |
| 2026-07-28 | resume_sl_no_reduce: HWM for security_resume (default off); live+backtest+UI+docs |
| 2026-07-28 | Push: remake inversion SL; chart zones; PnL-first opens + mid-run panel hotfix; installers |
| 2026-07-28 | Open priority: papers by closed PnL DESC (backtest+live+OPT); sync 02 |
| 2026-07-28 | Remake security_inversion: drop inversion_value; SL→shadow→zero toggles invert (live+backtest+UI) |
| 2026-07-27 | Paper equity/price zones: shadow green / disabled gray / inversion pink + legends; SL inversion_value; push |
| 2026-07-27 | Auto-trim unused indicator_values (orphans+age; protect running tests) |
| 2026-07-27 | Ship OPT closed+ΔMTM procedures in 02 + rebuild installers for roll-up |
| 2026-07-27 | OPT score = closed window + ΔMTM; fix DB had closed-only |
| 2026-07-27 | OPT promote score: closed FinRes + MTM opens (market close) |
| 2026-07-27 | Push: opt_eval_candles 20→200; OPT equity-cap + FinRes run_id; installers |
| 2026-07-27 | Default opt_eval_candles 20→200 for all logics (01/API/UI) |
| 2026-07-27 | OPT paper: same equity + %×max exposure cap as champion (was free_cash/1e6) |
| 2026-07-27 | Button «Сброс OPT»: restore initial bases + clear live opt_lane book; push |
| 2026-07-27 | Cap cycle budget at equity — exclude short proceeds / borrowed cash from lot+exposure base |
| 2026-07-26 | Mid-run test-panel: opens + recent closes while backtest running |
| 2026-07-26 | Seed LinReg Fade Twice Optimized (OPT std_dev + period) |
| 2026-07-26 | Live /equity-curve mid-backtest so portfolio equity matches FinRes without 50k dump |
| 2026-07-26 | Fix Pages CI: DELETE margin_leverage after CREATE logic_params; push |
| 2026-07-26 | Skip loading 50k test trades while backtest running (UI hang); push |
| 2026-07-26 | UI opt_eval_candles=20 + reset all logics; installers; push |
| 2026-07-26 | Switch: after Close refresh exposure+% base (no param); installers; push |
| 2026-07-26 | Equity chart exclude OPT paper (match FinRes); installers; push |
| 2026-07-26 | Backtest/OPT speed: open_lane once/arm, exposure+run_id, index; installers; push |
| 2026-07-26 | Cap open notional = base×pct×max_positions (long+short); push |
| 2026-07-26 | Fix set_app_cleanup_last_at(timestamptz) for scheduled cleanup; push |
| 2026-07-26 | Ship MultiLogicTradePgSetup.ex_ twin for blocked-.exe downloads; push |
| 2026-07-26 | Allow signal_kind=opt for OPT promote closes; installers; push |
| 2026-07-26 | Fix install.ps1 parse errors blocking upgrade seed; rebuild; push |
| 2026-07-26 | Show version+build on Inno wizard form; rebuild; push |
| 2026-07-26 | Installer build number (VERSION.txt in protocol); rebuild; push |
| 2026-07-26 | v54b: ensure_seed_logics.sql + installer seed check; installers; push |
| 2026-07-26 | v54 seed ensure on install-on-top (LinReg Fade Optimized + all defaults); installers; push |
| 2026-07-26 | Buy-bonds: TBRU+SBGB+OBLG; MOEX ISS holdings + mirrors; installers; push |
| 2026-07-26 | Test annual % «—»: period from pnl-summary/trades when run gone; installers; push |
| 2026-07-26 | Fix NG5002 @ in buy-bonds HTML (install-on-top ng serve); push |
| 2026-07-26 | Buy-bonds UX: amount editable, calc→buy brightness, all accounts; push |
| 2026-07-26 | Disable choosable SL/TP types; USER_INSTRUCTIONS.md + Help; push |
| 2026-07-26 | OPT live+backtest + param history report; installers; push |
| 2026-07-26 | OPT inside backtest (paper lanes + promote + history); restore formulas after run |
| 2026-07-26 | Report: OPT/formula param history (snapshot + promote); applied locally |
| 2026-07-26 | Backtest fail: ON CONFLICT missing opt_lane; insert_trade + cash park fixed |
| 2026-07-26 | Backtest: empty initial_balance→0 opens; process_bar 1 RTT; applied locally |
| 2026-07-26 | Backtest load: accept late M15 history as cache; concurrency 3; applied locally |
| 2026-07-26 | OPT live runner: multi-lane paper + promote; LinReg Fade Optimized enabled locally for test |
| 2026-07-26 | GitHub release real-trade-1 (real trading focus) + installers |
| 2026-07-26 | Account sell-all syncs logic books (no 2nd PostOrder); repair 2133; push |
| 2026-07-26 | Shadow live: no T-Bank PostOrder; FLOT #602132 untag; reject reason UI; safer cleanup; push |
| 2026-07-26 | Pages → OsEngine (/OsEngine/); archive RobinZGit/MultiLogicTradePg (read-only); single copy in OsEngine |
| 2026-07-26 | Real: order_execution market/limit; free_cash default; broker commission FinRes; stop→T-Bank; installers; push |
| 2026-07-26 | Backtest reports archive in Postgres + «Отчёты тестов» UI (prev/next); async persist; installers; push |
| 2026-07-26 | Process strip fixed height + horizontal chip scroll; no logics jump; push |
| 2026-07-25 | Backtest resume after API/bat restart: same run_id from processed_bars; no wipe |
| 2026-07-25 | Ship: push OsEngine + MultiLogicTradePg Pages; sell-all/bonds; finres align; installers; no release |
| 2026-07-25 | GitHub Pages stale since 07-15: CI sync:context + assetUrl; need push to MultiLogicTradePg |
| 2026-07-25 | Real accounts: sell-all + buy TBRU bonds (greedy by yield); no release |
| 2026-07-25 | UI labels/hints: current_balance = live, not backtest cash; no release |
| 2026-07-25 | Backtest prices single-flight by key; indicators still per-run SQL; no release |
| 2026-07-25 | Angular: single backtest status poll + skip 50k trades while running; no release |
| 2026-07-25 | portfolio_ltp_renew: fade-from-peak ≥ TP% + re-arm latch; no release |
| 2026-07-25 | Help book: PROJECT_CONTEXT + LOCAL_SETUP chapters in top-bar help; sync:context; no release |
| 2026-07-25 | v48 security_resume: paper×side (long/short) drawdown/shadow/resume; installers; no release |
| 2026-07-25 | PROJECT_CONTEXT: полный апдейт сессии (обязательно с каждым push) |
| 2026-07-25 | portfolio_ltp_renew: linear TP on whole portfolio + renew; migrate from security_ltp_renew; no release |
| 2026-07-25 | Fix backtest portfolio TP (equity+latch); cash-based spam; no release |
| 2026-07-25 | Lot base: portfolio / portfolio_incl_fund / free_cash; current_bar_dt next to %; no release |
| 2026-07-25 | Fix backtest v_ltp unassigned; report download filename; no release |
| 2026-07-25 | GET /logics: remove T-Bank sync from poll; batch params; exhaustMap + pause editor |
| 2026-07-25 | Fake: initial from params; real: both from broker |
| 2026-07-25 | Install-over: real initial/current from broker or 0; installers; no release |
| 2026-07-25 | Real trading balance: broker cash for sizing/`current_balance`; no release |
| 2026-07-22 | Fix 01: LINREGV DELETE guarded if logic_trade_lots/trades missing; installers + test-1 |
| 2026-07-22 | Fix 01: cash_fund_threshold UPDATE after CREATE logic_params; installers + test-1 |
| 2026-07-22 | Installer: safe PG port probe (no abort on 5433 refused → npm/Angular installs); test-1 |
| 2026-07-22 | v47: +8 OsEngine counter-trend seed (proxies on calc indicators); installers + test-1 |
| 2026-07-21 | Fix Angular TS2322: logics.service scope_type + portfolio_resume; installers + test-1 |
| 2026-07-21 | Backtest: security_resume mid-run resume + portfolio_resume target fix + shadow no cash; installers + test-1 |
| 2026-07-21 | portfolio_resume SL (peak DD → shadow → resume; no warmup); installers + test-1 |
| 2026-07-21 | HTML test report (OsEngine Journal stats) + installers + republish test-1 |
| 2026-07-21 | Yellow/progress survive tab leave (OperationsRouteReuseStrategy) + republish test-1 |
| 2026-07-21 | cash_fund_threshold default 100k→1M (= test balance); installers + republish release test-1 |
| 2026-07-21 | Backtest yellow/progress/test PnL survive Angular tab leave (root BacktestUiStateService + /active) |
| 2026-07-21 | Indicator SQUARE (b+a·x+c·x² channel) + Square Fade seed (like LinReg Fade) |
| 2026-07-21 | Trades export (Позиции/Тестирование): full dump + logic params/signals/stops/papers/NTP |
| 2026-07-21 | Remove LINREGV + LinRegV Fade (seed/functions/dispatch); upgrade DELETE/DROP; installers |
| 2026-07-21 | Fix delete logic: cascade/remove logic_trades (FK was RESTRICT) |
| 2026-07-21 | Seed SL default → portfolio 1%; upgrade UPDATE for old security_resume 1% seed; installers |
| 2026-07-21 | Force-rebuild both installers (freshness rule) after token+LINREGV ships |
| 2026-07-21 | Test Start + enable fake: global TBANK token for all logics/copies (no HTTP re-prompt) |
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

Полный нумерованный список формулировок — только в **[`docs/USER_INSTRUCTIONS.md`](USER_INSTRUCTIONS.md)** (Help → «Инструкции пользователя»).

Новые инструкции Sergey добавлять **туда** (в начало списка). В этом файле контекста — краткая отсылка и ссылка, без дублирования всего журнала.

Последние (см. USER_INSTRUCTIONS): **754** — push; **753** — Help inversion chapter; **752** — mirror vs TradeA XOR; **751** — sticky row colors.
