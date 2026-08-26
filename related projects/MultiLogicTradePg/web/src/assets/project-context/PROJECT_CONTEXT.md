# MultiLogicTradePg — контекст проекта

> Живой файл контекста для продолжения работы с разных устройств и в Cursor.  
> **Обновлять перед каждым push в репозиторий** — см. `.cursor/rules/project-context.mdc`.
> Запросы пользователя текстом — в **`docs/USER_INSTRUCTIONS.md`** (Help → «Инструкции пользователя»); здесь только ссылка.

**Единственная рабочая копия:** `related projects/MultiLogicTradePg` в https://github.com/RobinZGit/OsEngine  
**GitHub Pages:** https://robinzgit.github.io/OsEngine/ (workflow `.github/workflows/pages.yml` в OsEngine, `base-href=/OsEngine/`)  
**Старый репозиторий:** https://github.com/RobinZGit/MultiLogicTradePg — **archived** (read-only), не пушить; Pages с него больше не деплоятся.  
**Последнее обновление:** 2026-08-25 — #844: **маржа на remote снова** — закрыты обе дыры: equity<=0 → не торгуем (раньше откат на сырой кэш при 429-шторме); реальное эквити = amount − номинал открытых шортов; installers **v1.0.156**
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
| `01_multilogictrade_tables_and_data.sql` | Таблицы, индексы, справочники (идемпотентно, **v61**) |
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
- **`logic_stops`** — стоп-лосс и тейк-профит (`rule_kind` stop_loss|take_profit; stop scopes: security|**security_resume** (бумага×сторона)|**security_inversion** (бумага×сторона + toggle inverted)|portfolio|portfolio_resume; take_profit: security|portfolio|**portfolio_ltp_renew**; `value` / `value_unit`; колонка `inversion_value` устарела / не используется);
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
- **Расписание:** **Node fallback** каждые **15 с** (`TRADE_RUNNER_INTERVAL_MS`, Windows); **pg_cron** раз в минуту (Linux); **по умолчанию headless** (API up → торгует включённые логики; Angular не обязателен); опционально `TRADE_RUNNER_REQUIRE_UI=1` / `APP_TRADE_RUNNER_REQUIRE_UI=1` — только при heartbeat UI; ручной `POST /api/logic-trades/run`;
- **Watchdog:** Node каждые ~30 с (`TRADE_WATCHDOG_MS`) + PG `trade_runner_watchdog_tick` (pg_cron); stale если нет `APP_TRADE_RUNNER_LAST_OK` >90 с при включённых логиках; kick stuck backends + force cycle; UI: зелёный/красный чекбокс + бейдж «торговля остановлена»;
- **Сервер / install-over:** после установки **по умолчанию** открывается Angular UI (`MultiLogic_Trade_Progress_Start.bat`); «API only» — только если пользователь явно снял галочку / выбрал Server Start. Runner по-прежнему headless (`TRADE_RUNNER_REQUIRE_UI=0`): закрытие браузера не останавливает бой, пока открыто окно launcher.
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

## Что сделано (актуально на 2026-08-25)

### 2026-08-25 (#844: маржа на remote снова — закрыты обе дыры)

- **Факт (111.txt, логика 5585):** MTLRP Short 27×774 = **20 898 ₽** одной сделкой при своих <10k; всего открытых шортов 25 085 ₽; гросс шорт-открытий за день 94 363 ₽; 18 заявок отбито HTTP 429.
- **Причина 1:** в шторм 429 запрос портфеля падал → `equity=0` → `logic_exposure_cycle_budget` возвращал **сырой sizing** (раздутый кэш) → потолок исчез. Дыра известна с 05.08 («fallback при equity=0»), теперь закрыта: **equity<=0 → бюджет 0 — не торгуем вслепую**.
- **Причина 2:** T-Bank `cash_amount`/`amount` не чистили шорт-выручку → эквити завышалось. Теперь реальное эквити = **amount − номинал открытых шортов по входу** (новый хелпер `logic_open_short_entry_notional`; консервативно чинит оба варианта поведения брокера).
- Файлы: `sql/logic_trade_runner.sql` (+sync в `02`). verify:sql OK.
- **Для remote:** обязательно обновить установщиком ≥ этой версии (режим «Нет») — без нового `02` потолок продолжит отваливаться при каждом 429-шторме.

### 2026-08-25 (#843: мультитаймфрейм-сигналы — tf= в формуле каждого сигнала)

- **Синтаксис (подтверждён Sergey):** `tf=<База>[×|*|x]<целое>` внутри `@CODE(...)`: `tf=M15`, `tf=M1*7` (= M7), `tf=M1×7`. База — каталог M1…D1. Пусто/нет параметра → сигнал наследует ТФ логики → **все существующие логики работают как раньше**.
- **Семантика:** сигнал оценивается на последнем закрытом баре своего ТФ, который закрылся **не позже** закрытия текущего бара ТФ логики (без заглядывания). Сетка выровнена к началу эпохи — тот же якорь использует ресемпл из M1. Сделка по-прежнему пишется на баре ТФ логики (идемпотентность стабильна при смешанных AND-группах).
- **SQL-хелперы** (`sql/logic_trade_runner.sql` + sync в `02`): `signal_param_value`, `signal_tf_parse_sec`, `signal_tf_name_for_sec`, `signal_tf_id_for_sec` (автосоздание `M7`-строк в `timeframes`; уникальный индекс `uq_timeframes_tf` в 01 v65), `logic_signal_eval_point`, `logic_signal_extra_tf_ids`.
- **Runner:** перед циклом догружает цены/серии по всем ТФ активных сигналов (`logic_refresh_market_data` на каждый); каждый сигнал оценивается через eval-point; OPT-ветки аналогично.
- **Backtest:** `logic_backtest_ensure_security_data` грузит цены и синкает серии каждого доп. ТФ (окно точек масштабируется от сек ТФ логики); обе ветки оценки (обычная/OPT) идут через eval-point.
- **UI:** у каждого сигнала контролы «ТФ: [база▾] × [множитель]» над формулой; изменение перезаписывает `tf=` в формуле и автосейвит; helpers `extractSignalTf`/`applySignalTf` в shared.
- **Ограничения (задокументированы):** производные интервалы строятся ресемплом из M1 — глубина минутки у T-Bank ограничена, история накапливается со временем; стопы/денежный фонд/EOD остаются на простых ТФ каталога.
- Проверено: verify:sql OK (core+full), тесты 78/78, прод-сборка OK; функциональные тесты хелперов на verify-БД (парсер, автосоздание M7, выравнивание бара).

### 2026-08-25 (#842: откат LinReg Fade Trend; остаются #841-правки)

- **Удалено до пуша** (никогда не попадало в origin): сид-логика `LinReg Fade Trend` (#840) — плохо показала себя; вместе с ней откатено увеличение sync-окна M15..H1 (800 → прежние 200/150), т.к. оно нужно было только под SLOPE(500).
- Запросы #840/#842 сохранены в `USER_INSTRUCTIONS.md`; попытка задокументирована здесь и в «Истории сессий».
- Если тренд-фильтр понадобится снова: синтаксис `@LINREG(period=N,std_dev=2,series=SLOPE) VALUE > 0` работает, но требует окно синка ≥ периода (см. `logic_trade_sync_point_count`).

### 2026-08-25 (#841: ресайз колонок логик; полное копирование логики)

- **Колонки списка логик:** ширина меняется перетаскиванием за правый край заголовка (ручка `.col-resizer`, подсветка на hover); ширины хранятся в `localStorage` (`logics.columnWidths.v1`), двойной клик по ручке — сброс колонки. Диапазон 36–900 px; `th` получают инлайн-width (auto-layout трактирует как целевую ширину, содержимое режется ellipsis как раньше).
- **Копирование логики (`POST /api/logics/:id/copy`) — дополнено:**
  - сигналы: **`signal_acts_on`** (раньше терялся → копии contango/base_asset-логик молча ломались);
  - стопы: **`inversion_value`** (правило security_inversion с % инверсии);
  - бумаги: настройки боя **`real_trading_paused(_long/_short)`, `real_trading_inverted`**;
  - **OPT-сетка** источника: `last_opt_grid_results/run_id/at`.
  - Торговые периоды (`logic_non_trading_intervals`) копировались и раньше — проверено.
  - Намеренно НЕ копируются: сделки/лоты/эквити (по требованию), runtime-состояние — `portfolio_trading_paused`, equity peak, `stop_resume_*`, `linear_tp_*`, рейтинги сигналов (сбрасываются в 0). Копия создаётся выключенной.
- Файлы: `api/routes/logics.js`, `web/src/app/logics/logics.component.{ts,html,css}`. Прод-сборка OK, тесты 76/76.

### 2026-08-25 (#838: аудит «без займа» long+short; защита от гэпа исполнения)

- **Аудит истории (итог):** цепочка защит «плечо ≤ 1» собрана из коммитов `fc225de`/`c37bf50` (25.07: free_cash база, real-остатки только с брокера) → `1d4b955` (26.07: потолок номинала %×макс.позиций, long+short одним номиналом) → `219fa20` (27.07: `logic_exposure_cycle_budget` = LEAST(база, net equity); fake-equity = cash − short notional + long MTM) → локальный фикс 28.07, выложенный в #837-пуше («нет cash_amount → 0», пауза заявок). Инциденты #359/#824/#837 на remote — старый `02`/fallback при equity=0.
- **Проверено — деньги в долг НЕ берутся:** лонг: qty = floor(%×LEAST(free_cash,equity)/цена) вниз до лота + room ≤ потолка; шорт: тот же потолок номинала, деньги на открытие не тратятся (заём бумаг — разрешён), кэш после шорта раздут, но база режется LEAST с net equity; закрытия/стопы уменьшают exposure; rejections не занимают потолок.
- **Найденные дыры закрыты:**
  1. **Гэп цена сигнала → исполнение** (market): фактическая покупка дороже расчётной = заём сверх остатка. Теперь параметр **`order_gap_buffer_pct`** — qty считается по цене × (1+буфер), и **`max_open_gap_pct`** — перед Open свежая цена (стоп-ТФ, догрузка при необходимости через новую `logic_fresh_order_price`) сравнивается с ценой сигнала; отклонение > порога → `trade.gap_skip`, вход пропущен до следующей свечи. Оба — для long и short, пусто/0 = выкл (поведение как раньше).
  2. **Цена записи сделки**: если PostOrder не дал цену исполнения — добирается из GetOrderState (`averagePositionPrice→initialSecurityPrice→stages→executed`); точный номинал в потолке и FinRes.
  3. **Парковка фонда** (`logic_park_excess_cash`): из кэша вычитается номинал открытых шортов — парк больше не тратит шорт-выручку (заёмные деньги).
- Файлы: `sql/logic_trade_runner.sql`, `sql/logic_cash_fund_park.sql` (+sync в `02`), `01_…sql` (defs v66: два новых параметра), `api/lib/logic-params.js`, `api/lib/server-shared.js`, UI форм параметров + Help. verify:sql OK, тесты 76/76, schema-offline регенерирована (327 routines).
- **Hotfix Pages CI (#839):** прод-сборка падала TS2339 — инлайн-тип параметра `draftFromTrading` без двух новых полей; тип дополнен, прод-сборка локально OK. Урок: перед пушем UI-правок гонять `ng build --configuration production`, не только karma.
- **Ограничение (документировано):** шорт-закрытие BUY при гэпе против позиции может временно потребовать кэш сверху выручки — это убыток позиции, а не новый сайзинг; покрывается equity-капом следующих циклов. Фьючерсы: force-1-лот по-прежнему капится room.

### 2026-08-25 (#837: инсталлятор «Нет» переписывает функции — проверено; безусловное правило пуша)

- **Проверка #837 (вопрос Sergey):** подтверждено по коду — при выборе **«Нет»** (установка поверх, база сохраняется) установщик пересоздаёт **все** функции/процедуры: `InitializeSetup` → `DbMode=upgrade` (`MultiLogicTradePg.iss`) → `run_postinstall.cmd` → `install.ps1 -DropRoutinesFirst $true`: `sql/drop_public_routines.sql` сносит все public routines → `01` → `ensure_seed` → `02`. Работает с коммита `9217765` (2026-07-18). Нюанс: функции будут версии из упакованного Setup.exe — обновлять сервер только свежим exe.
- **Контекст проблемы маржи (#824/#837):** на удалённом сервере логика снова открыла MTLRP Long 20×755 = 15 100 ₽ при остатке ~10 000 ₽ (`position_size_pct=10`). Обратный расчёт: база сайзинга ≈ весь портфель (~151k), а не свободный кэш.
- **Найден и выложен главный фикс:** правки «нет `cash_amount` → база **0** (не весь портфель)» + пауза `pg_sleep(0.30)` между реальными заявками (лечит пачки HTTP 429) лежали **только локально** в `sql/logic_trade_runner.sql` и не были закоммичены/синхронизированы в `02` → удалённый сервер работал на старом коде с fallback на весь портфель. Теперь: модуль синхронизирован в `02_…sql` (`sync-sql-modules-to-02`), `verify:sql` OK, offline-схема регенерирована. Серверу после обновления — переустановка свежим exe (режим «Нет») или перевыполнение `01`/`02`.
- **Правило усилено** (`.cursor/rules/project-context.mdc`): явный безусловный запрет — любой `git push` только после явного запроса/разрешения Sergey (#829/#832/#837); локальные коммиты допустимы.
- Файлы: `.cursor/rules/project-context.mdc`, `docs/USER_INSTRUCTIONS.md` (№837), web-ассеты контекта (sync). Установщики пересобраны — **v1.0.149 / build 149** (docs внутри пакета).

### 2026-08-24 (#836: убраны кнопки «График/Эквити» в Бумагах; LINREG/SQUARE вернулись на шкалу цены)

- **Блок «Бумаги» (тест/бой):** старые 2 кнопки «График / Эквити» в шапке удалены вместе с режимом — цена всегда рисуется `app-price-chart` (свечи/линия — тумблером в тулбаре графика #835), эквити бумаги осталась полосой PnL под ценой (`equityPoints`). Из компонента вычищены `chartMode/setChartMode` и `EquityCurveChartComponent`.
- **Баг с невидимым LINREG:** правило ценовой шкалы требовало `line_code='VALUE'` для overlay-кодов и отдельно разрешало каналы только у BB → серии LINREG/SQUARE (MIDDLE/UPPER/LOWER) падали в нижнюю OSC-панель (не видны), а чип легенды сверху оставался. Теперь **любой** индикатор с линиями UPPER/MIDDLE/LOWER рисуется на шкале цены. Исправлено в двух местах: `logic-backtest-papers.buildChartSeries()` и `securities-panel.isPriceScaleSeries()`.
- **Вторая причина (главная):** сопоставление точек индикатора со свечами шло по точной строке dt, а `/api/prices` отдаёт dt текстом `"YYYY-MM-DD HH:MM:SS"`, `/api/indicator-values` — ISO-датой с UTC-сдвигом (`…T08:00:00.000Z`) → совпадений ноль, линии индикаторов не рисовались нигде (и на вкладке индикаторов тоже). Фикс: индекс серий строится по моменту времени (`@epochMs`, `price-chart.rebuildSeriesPointIndex/valueAtDt`).
- Файлы: `logics/logic-backtest-papers.component.{ts,html}`, `securities-panel/securities-panel.component.ts`.

### 2026-08-24 (#835: зоны лонгов/шортов на графике портфеля + свечи/линия на графиках цен)

- **График реального портфеля:** новые зоны `long` (бледно-зелёная) и `short` (бледно-красная) — от Open до закрывающего Close по каждой стороне, поверх обычных/shadow/инверсия зон; легенда «лонги открыты / шорты открыты». Стоп-маркеры SL/TP уже рисовались — остались. Новый билдер `buildSideOpenShadedRanges()` (`backtest-chart-overlays.ts`), подключён в `logic-positions-panel` только для боя. `ChartShadedRange.kind` расширен значениями `long|short`.
- **Графики цен (все `app-price-chart`):** тумблер в тулбаре **«▮▮ / ∿»** — свечи или линия. Линейный режим — ломанная по **Close** каждой свечи (стандарт не-свечных графиков), шкала подстраивается под Close. Индикаторы/стопы/сделки/PnL рисуются как раньше.
- Файлы: `models/market.model.ts`, `logics/backtest-chart-overlays.ts`, `logics/logic-positions-panel.component.ts`, `logics/equity-curve-chart.component.ts`, `price-chart/*`. Тесты 76/76, сборка OK.

### 2026-08-24 (#834: cleanup больше не стирает последний тест — результаты тестирования видны всегда)

- **Корень:** `cleanup_trading_disk_space()` (pg_cron 03:30 / Node scheduler, галочка APP_CLEANUP_DISK) удалял **все** завершённые `logic_backtest_runs`, **все** `is_test` сделки и всю тестовую историю рейтингов → после ночной очистки UI выглядел «как будто не тестировали».
- **Фикс:** перед удалением строится `_cleanup_keep_runs` = активные прогоны (pending/loading/running) + **последний завершённый прогон каждой логики** (`DISTINCT ON (logic_id)` по `COALESCE(finished_at, created_at) DESC`). Удаляются только прогоны вне списка; test-сделки и тестовая история рейтингов — только те, чей `run_id` не в списке. Каскад сохраняет и отчёт последнего прогона (`logic_backtest_reports.run_id ON DELETE CASCADE`).
- Обновлены обе копии: модуль `sql/cleanup_trading_disk_space.sql` + зеркало в `02_…sql` (+COMMENT).
- Функциональный тест на verify-БД: 2 прогона + 2 сделки + история → после cleanup остался 1 прогон (новейший), его сделка цела, старое удалено. verify:sql OK.
- `USER_INSTRUCTIONS.md` №834.

### 2026-08-24 (#833: линейный TP снова доступен к выбору)

- `isStopScopeChoosable` (web `shared/logic-stop.ts`): для take_profit выбор расширен с одного `security` до `security` + **`portfolio_ltp_renew`** («Линейный TP по портфелю с возобновлением») — теперь выбирается и в форме добавления, и при смене типа существующего правила. Простой TP «по всему портфелю логики» остался серым.
- API не менялся — он уже принимал `portfolio_ltp_renew`; блокировка была только в UI.
- Help (`app-help-content.ts`, глава «Логики») обновлён; `USER_INSTRUCTIONS.md` №833.

### 2026-08-24 (правило #832: локальные изменения → пересборка установщиков; пуш только с подтверждения)

- Новое правило проекта (`.cursor/rules/installer-freshness.mdc`, `project-context.mdc`): изменения **только локально** (без пуша) всё равно включаются в установщики — **пересобирать оба** после значимой локальной сессии; **коммит/пуш — только после явного подтверждения Sergey**.
- Оба установщика пересобраны и выложены: **v1.0.142 / build 142** (VERSION.txt).

### 2026-08-24 (v65: дубликаты сигналов логики + «?» внутри поля формулы)

- **UNIQUE сигналов снят** (#831): раньше `(logic_id, indicator_id, position_event, position_side, signal_kind, signal_acts_on)` был уникален — повторное «открытие long по течению» с тем же индикатором молча апдейтило существующий сигнал. Теперь одинаковых наборов может быть сколько угодно:
  - `01`: UNIQUE-ограничение убрано из CREATE TABLE; вместо unique-индекса — обычный `idx_logic_indicator_signals_group`; DO-блок снимает **все** non-PK unique-индексы таблицы (upgrade старых БД с любыми именами); seed демо-логики — без ON CONFLICT (идемпотентность на NOT EXISTS);
  - API `POST /api/logic-indicator-signals`: обычный INSERT без ON CONFLICT;
  - UI `addSelectedSignals`: клиентский фильтр дублей убран.
- **«?» внутри поля формулы** (#830→#831): кнопка в textarea (абсолют, правый верхний угол, `.formula-box`); у textarea `padding-right`, чтобы текст не заходил под кнопку. **Уточнение #831:** основная кнопка «?» — в **шапке блока «Сигналы на логике»**, рядом с названием (`.signals-summary-help`); клик раскрывает свёрнутый блок и показывает панель справки сверху (`signalFormulaHelpText()`); повторный клик скрывает.
- Help: глава «Редактор формулы сигнала» дополнена (кнопка в углу поля; одинаковые сигналы разрешены).
- Файлы: `01_…sql`, `api/routes/logics.js`, `web/src/app/logics/logics.component.{ts,html,css}`, `web/src/app/app-help/app-help-content.ts`.
- Установщики включают эти изменения начиная с **v1.0.140**; финальная выкладка — **v1.0.142**.

### 2026-08-24 (редактор формулы сигнала: арифметика в условии + справка «?»)

- **Арифметика в условии сигнала** (#830): `evaluate_signal_condition` теперь считает слева/справа от сравнения произвольные числовые выражения над `pp` и `VALUE`: `+ −` покомпонентно, `*` свёртка/умножение, `#` покомпонентное произведение, `/`, скобки. Сравнения прежние (`> < >= <= = != <>`). Поиск оператора — на верхнем уровне скобок; вычисление через параметризованный `EXECUTE` с whitelist-charset `[0-9+*/(). пробел]` и try/exception (деление на 0 / мусор → FALSE). Примеры: `pp - VALUE > 0`, `(pp - VALUE) / pp * 100 < -3`, `pp # VALUE > pp`.
- Обновлены обе копии функции: ядро `02_…sql` + зеркало `sql/logic_trade_runner.sql`; COMMENT (в `02` и `routine_comments_missing.sql`). Инверсия сравнения (`logic_invert_comparison_condition`) совместима — меняет только оператор.
- **Кнопка «?» у поля формулы сигнала** (#830): в блоке «Сигналы на логике» рядом с textarea — круглая кнопка; раскрывает панель со справкой: формат `@CODE(параметры) условие`, переменные, арифметика над рядами, примеры условий и параметры основных индикаторов (RSI/MACD/STOCH/BB/LINREG/ATR + OPT), каталог индикаторов из API. Новый хелпер `buildSignalFormulaHelp` в `web/src/app/shared/indicator-formula-help.ts`.
- Help приложения: новая глава **«Редактор формулы сигнала»** (после «Формулы сигналов и OPT()»).
- Файлы: `02_multilogictrade_functions_and_procedures.sql`, `sql/logic_trade_runner.sql`, `sql/routine_comments_missing.sql`, `web/src/app/logics/logics.component.{ts,html,css}`, `web/src/app/shared/indicator-formula-help.ts`, `web/src/app/app-help/app-help-content.ts`.
- Installers не пересобраны (правка только в SQL/UI — пересборка перед push).

### 2026-08-23 (Buy bonds: режим «Счёт брокера» — докупка имеющихся облигаций)

- В диалоге «Купить облигации» новый первый пункт выбора — **«Счёт брокера»** (`fund_code=ACCOUNT`): докупка облигаций, **уже лежащих на счёте**.
- Источник: T-Bank `GetPortfolio` (позиции BOND) + `BondBy` по FIGI (купон, номинал, лот); цена из `currentPrice` с нормализацией % номинала к ₽ (`<200 → ×номинал/100`). Конкурентность запросов 3 (rate limits).
- «Прибыльные первыми» = **купон к цене** через существующий `bondCurrentYieldPct`; без купонных данных — в конец списка.
- Раскладка суммы — прежний greedy `computeGreedyBuyLots`: целыми лотами сверху вниз, пока хватает суммы/кэша. `executeBuyBonds` переиспользован без изменений (BUY market по figi).
- Уточнение (#829): в выборе «Счёт» — **все реальные T-Bank счета системы, у которых в портфеле есть облигации**: `GET /api/accounts/with-bonds` (Node `GetPortfolio`, конкурентность 3); подпись = номер счёта · имя + количество облигаций; покупка уходит на выбранный счёт (`target_account_id` в body buy-bonds). Для списка достаточно **read-only токена** (только GetPortfolio); ошибки торговли видны в отчёте заявок. Если открытый счёт сам имеет облигации — он выбирается по умолчанию.
- Фикс `normalizedWeights` (bond-tbru-alloc.js): при нулевой сумме весов — равные доли; раньше возвращался пустой список → план без покупок (ловилось только тестом режима ACCOUNT).
- Файлы: `api/lib/account-portfolio-actions.js`, `api/lib/bond-tbru-alloc.js`, `web/src/app/buy-bonds-dialog/*`.
- Installers **v1.0.138**.

### 2026-08-23 (fix: боевой FinRes — авто-сверка с брокером, пересборка PnL, детектор аномалий)

- Разбор экспорта логики 1720 (remote): финрез **+21 209,84** при честном **−171,37**. Виновник — Close MTLRP id 2883 (`stop_loss:security_resume`, 18.08 13:35): записан **+20 737,32** вместо ≈**+5**; значение соответствовало базе цен ДО консолидации Мечела (~35 ₽ vs ~804). Аналогично CHMF +455/+382 (Северсталь тоже прыгнула уровнем) и ещё ~41 мелкое искажение.
- Причина: finres боевых Close писался сразу после INSERT по предварительной цене (из серии `prices`, до финального fill), а `logic_sync_real_trade_broker_fees` не вызывался никем и никогда — расхождение не лечилось.
- Фикс:
  - `logic_sync_real_trade_broker_fees`: при изменении цены закрытия — немедленный `logic_trade_finalize` этой сделки (пересборка пакетов/PnL свежими данными); полный rebuild_pnl в конце под try/exception (`rebuild_error` в результате + WARNING).
  - Новая **`logic_trades_finres_anomalies(p_logic_id)`**: Close с finres≠0 без пакетов (`finres_without_lots`) или |finres| > qty×GREATEST(price_close, max(price_open))+comms (`finres_out_of_bounds`).
  - API: **`GET /api/logic-trades/finres-anomalies?logic_id=`**.
  - Node: maintenance-scheduler каждые **5 мин** (`BROKER_FEE_SYNC_CHECK_MS`; выкл. `APP_BROKER_FEE_SYNC=0`) автоматически вызывает сверку.
  - `verify-async-sync.mjs`: проверки assign/sync переведены на `api/routes/indicators.js` — после split роутов (#747) проверка ложно падала на server.js.
- Файлы: `api/scripts/apply-tbank-broker-commission.sql` + зеркально в `02_…`, `api/maintenance-scheduler.js`, `api/routes/trades.js`, `scripts/verify-async-sync.mjs`.
- Лечение уже испорченной истории на рабочей БД: `SELECT logic_sync_real_trade_broker_fees(1720);` → проверить `SELECT * FROM logic_trades_finres_anomalies(1720);` (финрез логики должен стать ≈ −171). Скрипт точечных UPDATE также сохранён у пользователя (fix_finres_1720.sql).
- Installers **v1.0.137**.

### 2026-08-23 (переупаковка релиза optimize-and-real-trade из текущего main)

- Пользователь откатил последний коммит ИИ; в релизе `optimize-and-real-trade` оставались артефакты, собранные **до** `293e261` (кэш индикаторов бэктеста): VERSION указывал сборку от `e835001`.
- Оба установщика пересобраны из актуального `main` (`d28ed18`): Windows `MultiLogicTradePgSetup.exe` (+ `.ex_` для хостов, блокирующих .exe) и Linux `MultiLogicTradePg-linux.tar.gz`.
- Ассеты заменены в релизе через `gh release upload --clobber`; имя и описание релиза не менялись (`real-trade-1` не трогали).
- Installers **v1.0.136**.

### 2026-08-05 (fix: кэш индикаторов бэктеста — дырявый Stoch)

- **Проблема:** `backtest_indicators_cached` = `EXISTS` одной точки в периоде → Stoch с хвостом с ~28.05 считался закэшированным (`sync=0`), AND open не стрелял на апрель–май; 5634 ~вдвое слабее 2088.
- **Фикс:** нужны ≥**3 бара подряд** без пропуска шага TF; на периоде ≥10д — **две** такие «тройки» с разносом (~¼ окна, мин. 3д); края у начала цен / `date_to` (как у `backtest_prices_cached`).
- Файлы: `sql/logic_backtest_runner.sql`, `02_multilogictrade_functions_and_procedures.sql`. На рабочей БД функция применена.
- Installers **v1.0.135**. На remote нужен обновлённый `02` (иначе снова `EXISTS`-кэш).

### 2026-08-05 (разбор: снова маржа remote logic 1720 / MTLRP)

- Симптом: Short MTLRP `25×995≈24875` и Long `20×994≈19880` при equity ~33k и «плече 1» (10%×10).
- Причина та же, что у 359: 10% от раздутого T-Bank `cash_amount` (выручка шорта/заём), не от equity; типичный слот до этого был ~800–1100.
- Фикс в коде уже есть (`logic_exposure_cycle_budget`); на remote, судя по сделкам 05.08, потолок equity **не держит** (старый `02` и/или fallback при `equity=0` → сырой sizing).
- Код fallback пока не ужесточали в этой выкладке — только диагностика; задача «apply equity-cap on remote» усилена.

### 2026-08-04 (чекбокс alive = heartbeat runner, не TF)

- На M15 чекбокс зеленел после сделки/баров, через ~90 с краснел: UI смотрел `last_trade_check_at`, а между свечами `bar_skip` его не обновлял.
- UI: зелёный при `status=ok` / `node_running` — ритм цикла (~15 с), не таймфрейм и не момент сделки.
- SQL: при `trade.bar_skip` пульсировать `last_trade_check_at` (ожидание следующей свечи ≠ сон).
- Installers **v1.0.134**. Нужен обновлённый `02` / `sql/logic_trade_runner.sql`.

### 2026-08-04 (fix: красный чекбокс при живых сделках, канал Node)

- UI красил все логики красным, если глобальный `APP_TRADE_RUNNER_LAST_OK` stale — даже когда цикл Node шёл и сделки создавались.
- Health: свежий Node-pulse / `node_running` → status ok; per-logic `stale` больше не форсируется от глобального.
- UI: alive если цикл running, свежий `last_trade_check_at` или недавние live fills (не shadow).
- Тень портфеля (`portfolio_trading_paused`) по-прежнему красный — это отдельный режим.
- Installers **v1.0.133**.

### 2026-08-04 (fix: «Закрыть всё по рынку» = путь Node как sell-all)

- Проблема: close-all шёл SQL → `tbank_post_order_via_node` (HTTP + UI heartbeat), а «Продать всё» на счёте — in-process `postOrder` без heartbeat → close-all молча/с ошибкой не продавал.
- `closeAllLogicPositions`: при channel=node — PostOrder в Node, затем books-only (`market:close_all_node`, только figi из sold[]).
- Снят UI-heartbeat gate с internal PostOrder / `tbank_post_order_via_node` (остаётся localhost-only).
- Installers **v1.0.132**. На рабочей БД нужен обновлённый `02` (или `sql/logic_close_all_positions.sql` + `sql/tbank_order_channel.sql`).

### 2026-08-04 (блок отклонённых сделок в боевых позициях)

- В live-панели после «Сделки закрытия»: **Сделки отклонённые (rejected)** — только `status=rejected`.
- Колонка **Причина отказа** из `logic_trades.note` (человекочитаемо через `tradeRejectReason`).
- API `GET /api/logic-trades/rejected` отдельно от open/close (rejects не съедают LIMIT).
- Installers **v1.0.131**.

### 2026-08-04 (dismissible warning banners: отказы / токен)

- Баннер «много отказов биржи» и баннер токена T-Bank: кнопка **×** скрывает баннер (и чип в шапке блока).
- Скрытие по fingerprint (count+message / reason+message); при новых данных баннер снова показывается.
- Если алерт пропал (проблема ушла), dismiss сбрасывается — при повторе ситуации баннер появляется снова.
- Других похожих live-баннеров в позициях нет (error-banner БД — отдельный статус загрузки, не warning burst).
- Installers **v1.0.130**.

### 2026-08-04 (hotfix: fetch failed → https.Agent + CA НУЦ)

- UI «проверка счёта» показывала `fetch failed` (cause: SELF_SIGNED_CERT_IN_CHAIN): `fetch`/undici не применял russiantrustedca.pem.
- Клиент T-Bank переведён на `https.request` + `https.Agent({ ca: rootCertificates + russiantrustedca.pem })`.
- Ошибки показывают code/cause, не только «fetch failed». Installers **v1.0.129**.

### 2026-08-04 (sell-all / bonds / close-all = канал из шестерёнки)

- «Продать всё», покупка облигаций: при `channel=node` — Node `postOrder` + GetPortfolio/BondBy; при postgres — SQL.
- «Закрыть всё» в позициях: `tbank_post_order` / `tbank_http_post` по каналу; `tbank_figi_lot_size` и bond resolve без сырого `http()`.
- Default канала `node`. Installers **v1.0.128**.

### 2026-08-04 (SSL: UI token/account через Node + CA НУЦ)

- Причина: radio postgres|node влиял только на PostOrder; проверка токена/счёта шла через pgsql-http → self-signed chain.
- Node не берёт Windows store → вшит `api/certs/russiantrustedca.pem` + `NODE_EXTRA_CA_CERTS` / undici Agent.
- `pgResolveTbankAccount` / verify token / balance / `tbank_http_post` (channel=node) → Node TLS.
- Default канала → `node`. UI-текст обновлён. Installers **v1.0.127**.

### 2026-08-04 (hotfix: pgResolveTbankAccount is not defined)

- `POST /api/accounts/preview-connection` падал: `pgResolveTbankAccount` / `pgFetchTbankPortfolioBalance` не деструктурировались из `ctx` в `api/routes/references.js`.
- Installers **v1.0.126**.

### 2026-08-04 (T-Bank support: tbank.ru host + CA Госуслуг в installer)

- Prod API: `https://invest-public-api.tbank.ru/rest` (= `invest-public-api.tbank.ru:443`); UPDATE старых `brokers.api_url` с tinkoff.ru.
- `fix_pgsql_http_ssl.ps1`: Mozilla cacert + append `russiantrustedca.pem` (gu-st.ru / gosuslugi.ru/crt) + import .cer в Windows Root.
- Чекбокс Setup переименован: «Установить/обновить SSL CA… Mozilla + Госуслуги/НУЦ Минцифры для T-Bank API».
- Docs: https://developer.tbank.ru/invest/intro/developer/network
- Схема **v64**. Installers **v1.0.125**.

### 2026-08-04 (Канал заявок T-Bank: Postgres | Node API)

- Шестерёнка → radio **Канал боевых заявок**: `postgres` (default, pgsql-http) / `node` (прокси через локальный Express, системный TLS).
- `APP_TBANK_ORDER_CHANNEL` + `APP_TBANK_ORDER_NODE_URL`; `tbank_post_order` при `node` → `POST /api/internal/tbank/post-order` (только localhost, нужен UI heartbeat).
- Обход SSL `self-signed certificate in certificate chain` на libcurl: PostOrder идёт из Node `fetch`.
- Схема **v63**. Installers **v1.0.124**.

### 2026-08-04 (Installer: opt-in обновление SSL CA)

- В Windows Setup на странице Tasks — чекбокс **«Обновить SSL CA-сертификаты PostgreSQL»**, по умолчанию **выкл.**
- Если включить: post-install вызывает `scripts/fix_pgsql_http_ssl.ps1` и `SELECT configure_http_ssl()` (ошибка SSL не валит всю установку).
- Флаг: `installer/windows/update-ssl-certs.txt` (`1`/`0`); Linux: `--update-ssl-certs`.
- Нужно при reject’ах T-Bank вида `SSL certificate problem: …` (libcurl/pgsql-http, не браузер).
- Installers **v1.0.123**.

### 2026-08-02 (EOD close ≠ use_non_trading_periods)

- `close_positions_eod`: закрытие в конце каждого торгового дня **не зависит** от чекбокса «Учитывать неторговые периоды» (тот только блокирует новые входы).
- `logic_is_eod_session_bar`: интервалы — только тайминг; плюс последняя сессионная свеча до вечернего окна (18:30 при окне с 18:40), иначе EOD мог не сработать.
- Фонды TMON/LQDT/SBMM по-прежнему не закрываются (`logic_close_positions_eod_except_funds`).
- Схема **v62**. Installers **v1.0.121**.

### 2026-08-01 (hotfix: NG1 rejectAlert.message)

- `ng serve` падал: `Object is possibly 'null'` на `rejectAlert.message` в шаблоне панели позиций.
- Фикс: `@if (rejectAlert; as alert)` + `alert.message`. Installers **v1.0.120**.

### 2026-08-01 (зелёная зона при красной паузе портфеля)

- Красный чекбокс = `portfolio_trading_paused` (реал остановлен, тень портфеля) — это не баг.
- Баг UI: зоны эквити снова становились зелёными («обычная»), если после LTP/SL в истории был реальный Open; серую зону только удлиняли, зелёный хвост рисовался сверху.
- Фикс: `forceLivePortfolioShadowShading` — с `portfolio_stop_resume_at` до now только shadow; зелёный хвост срезается.
- Installers **v1.0.119**.

### 2026-08-01 (баннер массовых rejected в боевых позициях)

- `GET /api/logic-trades/reject-alert`: за последние **24 ч** warn если `rejected >= 8` или `rejected >= 5` и span first→last ≥ **30 мин** (1–2 отказа без баннера).
- UI: жёлтый баннер в блоке «Позиции» + компактный бейдж `отказы ×N` в summary; текст с примером `note`.
- Installers **v1.0.118**.

### 2026-08-01 (rejected не съедают LIMIT live-сделок)

- Проблема: панель боя (логика 1720 и др.) показывала FinRes 0 / Positions 0/0 / пустую equity при полном export с filled — ночные `rejected` (T-Bank overnight) заполняли `ORDER BY executed_at DESC LIMIT N`.
- Фикс: `GET /api/logic-trades` — `lt.status IS DISTINCT FROM 'rejected'`; LIMIT считается только по остальным статусам. Полный дамп с rejected — по-прежнему `/api/logic-trades/export`.
- Installers **v1.0.117**.

### 2026-07-31 (без DELETE Futures Price Channel в installer)

- Убран целевой `DELETE` имён Futures Price Channel / Fuge из `01` + `ensure_seed_logics`.
- Seed этих логик **по-прежнему не ставится** (нет в INSERT); уже существующие в БД инсталлятор **не трогает**.
- Contango / base_asset / DONCHIAN без изменений.
- Схема **v61**. Installers **v1.0.116**.

### 2026-07-31 (убран seed Futures Price Channel)

- Удалена seed-логика **Futures Price Channel and LNREG Base Asset** (и старое имя Fuge) из INSERT в `01` + `ensure_seed_logics` (v60 имел ещё `DELETE` — снят в v61).
- **Остаются:** DONCHIAN, `signal_acts_on` security|base_asset|**contango**, `contango_securities` / sync, sell-before-expiry params, UI.
- Схема **v60**. Installers **v1.0.114**.

### 2026-07-31 (signal_acts_on = contango)

- Третий режим «Действует на»: **Контанго** — синтетический ряд цен `OHLC(fut) − OHLC(und)`.
- Таблица `contango_securities` + `logic_ensure_contango_security` / `sync_contango_prices`.
- Индикаторы считаются на синтетике стандартным пайплайном; `pp` в формуле = спред (допускается ≤0).
- Бой/бэктест/рейтинг: грузят базу, материализуют contango, sync индикаторов на eval security.
- UI select + API/bundle; схема **v59**. Installers **v1.0.113**.

### 2026-07-31 (Backtest: дробные tip при загрузке цен)

- Проблема: tip «Natural Gas» (и др. фьючерсы) долго не менялся — один `CALL load_prices` на весь период; в `phase_detail` писалось только имя бумаги.
- Фикс Node `api/logic-backtest.js`: загрузка кусками **~30 дней** (`BACKTEST_PRICE_CHUNK_DAYS`); tip `Цены Name: from–to (i/n)`; в прогресс идёт полный detail.
- Дополнительно: загрузка цен **базового актива** (`signal_acts_on=base_asset`) с отдельными tip.
- Installers: bump к **v1.0.112**.

### 2026-07-31 (Futures Price Channel: rename + продажа до экспирации)

- Rename seed: **Futures Price Channel and LNREG Base Asset** (было «…Fuge…»); upgrade `UPDATE` в `01` + `ensure_seed_logics`.
- Параметры: `sell_futures_before_expiry` (checkbox) + `sell_futures_days_before_expiry` (integer, default 3).
- EOD: `logic_is_eod_session_bar` (тайминг) отдельно от `close_positions_eod`; на том же баре — `logic_close_futures_near_expiry` / backtest-аналог.
- Порог: `(expiration_date − date) ≤ N`; вечные фьючерсы пропускаются.
- Seed этой логики: checkbox **on**, N=**3**.
- Схема **v58**. Installers: bump к **v1.0.111**.

### 2026-07-31 (Futures: сигнал «Действует на» + Price Channel / DONCHIAN)

- Колонка `logic_indicator_signals.signal_acts_on`: `security` (по умолчанию) | `base_asset`.
- `security_prefixes.underlying_security_id` + mapping (SBRF→SBER, GAZR→GAZP, CR→CNYRUBF, Si→USDRUBF, …).
- **DONCHIAN** = Price Channel (Tun-Chan/Дончиан): calc UPPER/MIDDLE/LOWER; UI name «Price Channel (Donchian)».
- Оценка/sync/backtest: индикаторы и цены для `base_asset` берутся с underlying.
- UI: колонка «Действует на»; график бумаги + график базового актива (бой и тест).
- Seed-логика Futures Price Channel… — не в INSERT (v60+); целевой DELETE снят в **v61**.
- Схема **v57** (+contango v59; seed убран v60; DELETE убран v61).
- Installers: bump к **v1.0.110** при выкладке.

### 2026-07-31 (Crypt v1.22 — тоньше перо в режиме Заметка)

- Перо на холсте заметки: `INK_LINE_WIDTH` **22 → 6** (на планшете палец/стилус давал слишком толстую линию); ластик **28 → 14**.
- `tools/parity-stego.html` + assets; push **main** → GitHub Pages.

### 2026-07-31 (Equity: цель 26801 / «пик прилип к бару» — short MTM + headroom)

- Проблема (логика 1720, export): цель возобновления прыгала до **~26801** при реальном провале ~сотни; shadow не догоняет; пик пунктира визуально «упирается» в оранжевую линию на самой верхней кромке.
- Причина SQL: `logic_portfolio_equity` считал только **cash + long×price**, без **− short×price**. При открытых шортах cash раздут выручкой; после mass-close `track_before − track_after` ≈ нотионал шортов → завышенная `portfolio_stop_resume_*`.
- Фикс SQL: `logic_portfolio_equity` = cash + long×price − short×price (как `logic_backtest_portfolio_equity`); `sql/logic_stop_runner.sql` + `02` + COMMENT.
- UI: запас по Y над/под серией; цель вне шкалы не на самом padT; `portfolioShadowResumeTarget` не трактует `null` baseline как 0 (`Number(null)`).
- Уже записанная «цель 26801» в БД сама не исправится — нужна **новая пауза** после применения SQL (или сброс `portfolio_stop_resume_*`).
- Installers: bump к **v1.0.109** при выкладке.

### 2026-07-30 (Crypt v1.21 — decrypt на холст + перо/ластик)

- Расшифровка **заметки/картинки** кладётся сразу на **холст редактирования** (не в отдельную зону снизу) — можно править и снова «Шифровать».
- Рядом с холстом: **Перо** (по умолчанию) / **Ластик** (белый штрих).
- Версия формы: **Crypt v1.21** (`tools/parity-stego.html` + assets); push **main** → GitHub Pages.
- **Pages fix:** деплой падал на `logics.component.css` > 24kb budget → `anyComponentStyle` maximumError **40kb** (`angular.json`).

### 2026-07-30 (Equity: цель 2680 не ломает шкалу; shadow с момента паузы)

- Проблема: горизонталь «цель 2680» раздувала Y-ось, shadow-кривая прилипала к нулю (выглядело как «дичь»).
- Фикс UI: шкала по сериям эквити; если цель далеко выше — линия сверху с меткой `цель N ↑ · сейчас X (P%)`.
- SQL: `logic_portfolio_shadow_pnl` считает shadow только с `portfolio_stop_resume_at` (как в комментарии «после паузы»).
- График shadow в тени портфеля — с той же метки; API отдаёт `portfolio_stop_resume_at`.
- Число цели = equity_before − equity_after при закрытии портфеля (нужный shadow PnL), не «пик пунктира ~2000».
- Installers **v1.0.107**.

### 2026-07-30 (Equity: горизонталь цели возобновления в тени портфеля)

- На «Эквити портфеля» (бой), пока `portfolio_trading_paused`: оранжевая горизонталь **цель возобновления**.
- Уровень = `portfolio_stop_resume_equity − portfolio_stop_resume_baseline` (тот же порог, что в SQL: baseline + shadow_pnl ≥ target).
- API `/api/logics` отдаёт `portfolio_stop_resume_equity` / `portfolio_stop_resume_baseline`.
- Installers **v1.0.106**.

### 2026-07-30 (Equity: белый хвост + фантомный пунктир в зелёной зоне)

- Проблема: после серой (shadow) зоны оставался **белый хвост**, а пунктир shadow шёл с нуля через всю **зелёную** зону.
- Причина: заливка обрывалась по date-only `papersDateTo()` (полночь); shadow-серия якорилась на `periodStart`.
- Фикс: shadow-линия с первого shadow Close; `buildShadedDisabledRanges` не урезает intraday; в бою при `portfolio_trading_paused` серая зона до «сейчас»; ось времени учитывает концы заливок.
- Installers **v1.0.105**.

### 2026-07-30 (Equity: shadow пунктир + красный чекбокс при тени портфеля)

- Красный чекбокс «вкл.» и бейдж — если **весь портфель в shadow** (`portfolio_trading_paused`); это нормально, не только при asleep runner.
- Эквити портфеля/бумаги: рисуется **даже без закрытий** (ноль с начала периода); **shadow-эквити** — серый пунктир; периоды shadow — **серая заливка** (в т.ч. portfolio_ltp_renew / portfolio_resume).
- API `/logic-trades/equity-curve`: shadow closes + `shadow_total`.

### 2026-07-30 (Trade runner watchdog — сон цикла + UI)

- Проблема: на удалённом сервере бой ночью «засыпает» (нет сделок), после hotfix install-over снова откатывалось.
- **Node:** `trade-runner.js` — heartbeat `APP_TRADE_RUNNER_LAST_OK`; watchdog каждые ~30 с; при stale / busy>3 мин — `trade_runner_kick_stuck` + force cycle; per-logic `statement_timeout` 120 с.
- **Postgres:** `sql/trade_runner_watchdog.sql` → `02`: `touch_trade_runner_last_ok`, `trade_runner_health`, `trade_runner_kick_stuck`, `trade_runner_watchdog_tick`; `run_trade_cycle` пишет last_ok; pg_cron `multilogictrade_trade_watchdog` каждую минуту.
- **API:** `GET /api/trade-runner/health`, `POST /api/trade-runner/watchdog`.
- **UI:** чекбокс «включено» — яркий зелёный пульс (цикл жив) / красный пульс (остановка); бейдж у имени «торговля остановлена (бой|фейк)»; при stale Angular подталкивает watchdog.
- Бейдж портфеля «тень»: длинная подпись только при `portfolio_trading_paused`.

### 2026-07-30 (Crypt v1.20 — короткий Ключ на Обновить)

- Если Ключ длиной **1–2** символа: **Обновить** ничего не делает (не decrypt).
- Статус: ключ должен быть **пустым** или **от 3 символов и больше**.
- Placeholder Ключа: «пусто или от 3 символов».

### 2026-07-30 (Crypt v1.19 — Обновить = только decrypt уже загруженного файла)

- **Обновить / Refresh** стоит сразу после поля **Ключ** (не слева в группе кнопок).
- Кнопка **disabled**, пока не был выбран файл через **Расшифровать**.
- По нажатию: снова расшифровать **тот же** загруженный файл текущим Ключом — без file picker, без Encrypt/скачивания.
- Encrypt больше не активирует Обновить.

### 2026-07-30 (Crypt v1.18 — RU/EN на строке с именем Crypt + merge main)

- Чекбоксы **Русский / English** перенесены в `brand-row` сразу после имени **Crypt** (над режимом/ключом).
- Merge в **main** для немедленной публикации на GitHub Pages.

### 2026-07-30 (Crypt v1.17 — Обновить / Refresh после смены Ключа)

- Кнопка **Обновить** (RU) / **Refresh** (EN) в шапке Crypt рядом с Шифровать/Расшифровать.
- После **Расшифровать** или **Шифровать** файл и plaintext остаются в памяти.
- Смена **Ключа** → **Обновить**: перешифрование текущим ключом и скачивание PNG **без** повторного выбора файла и без повторного Encrypt/Decrypt через picker.
- Если plaintext ещё нет, а carrier есть — Refresh снова расшифровывает тот же файл текущим Ключом; при удачной расшифровке сразу перешифровывает и скачивает.
- Версия формы: **Crypt v1.18** (`tools/parity-stego.html` + assets copy).

## Что сделано (актуально на 2026-07-29)

### 2026-07-29 (бейдж портфеля: понятная подпись «тень»)

- Вместо «портфель: теневой» — длиннее: «реал пауза: линейный TP портфеля → тень до возобновления» (или стоп портфеля).
- Бейдж только при `portfolio_trading_paused`; тени отдельных бумаг — только в списке бумаг, не на строке логики.

### 2026-07-29 (после установки всегда открывать Angular UI)

- Запрос: при установке всегда запускать Angular-форму, если явно не указано «не открывать»; при запуске торговли форма тоже должна открываться.
- Installer post-install: **Open MultiLogic Trade UI** включено по умолчанию; **API only** — unchecked.
- Desktop shortcut — только UI-launcher; Server Start — в меню «Пуск» как явный opt-in.
- Linux `start-multilogic-trade.sh` — `xdg-open` браузера на :4200.

### 2026-07-29 (Server Start «тишина» = норма)

- После `balances synced` API **работает**; циклы шли без `console.log` → окно казалось зависшим.
- Добавлен лог каждые ~15 с: `Trade cycle: processed=… created=…`; при старте — число enabled logics.

### 2026-07-29 (hotfix: Server Start crash)

- `resumeOrphanWarmups is not a function` — функция была только в `createRouteContext()`, не в `module.exports`.
- Фикс: экспорт из `api/lib/server-shared.js`; ASCII в `Server_Start.bat` (без mojibake em-dash).

### 2026-07-29 (headless live trading после install-over)

- Запрос: после GitHub update + install-over включённые логики должны снова торговать надёжно, без обязательного Angular (сервер лёгкий).
- **По умолчанию UI не требуется:** `TRADE_RUNNER_REQUIRE_UI=0` / `APP_TRADE_RUNNER_REQUIRE_UI` default `0`; Node + `run_trade_cycle` гейтят UI только если флаг включён.
- **`MultiLogic_Trade_Server_Start.bat`** (+ Linux `start-multilogic-trade-server.sh`): только API; installer post-install запускает Server Start по умолчанию (UI — опционально).
- При старте API: sync real balances + `resumeOrphanWarmups` (дожать warm-up после рестарта).
- Старый режим «только с открытым Angular»: `TRADE_RUNNER_REQUIRE_UI=1` или параметр `APP_TRADE_RUNNER_REQUIRE_UI=1`.

### 2026-07-29 (security_inversion: бумага×сторона как resume)

- Remake SL `security_inversion` по образцу `security_resume`: просадка **стороны** ≥ % → close + shadow **только этой** стороны; другая сторона остаётся в бою.
- Возврат shadow стороны к пику («ноль») → unpause стороны + **toggle** `real_trading_inverted` по бумаге.
- В инверсии DD/close по **противоположной** позиции (long-сигналы → short).
- Shadow fills: **базовая** логика (игнор paper inverted) — иначе после inverted SL shadow не возвращался к нулю.
- UI/Help: «По бумаге и стороне (инверсия при достижении суммы прерывания)»; live + backtest + `02` sync.
- Диагноз churn: track-HWM DD на нормали давал ~10× SL vs resume — убран; затем полный переход на side-machine.

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
- **`security_inversion`** (2026-07-29): как `security_resume` — бумага×сторона (long/short); DD стороны ≥ % → close+shadow стороны; shadow→ноль → unpause + toggle `real_trading_inverted`; в инверсии DD/close на opposite position side; shadow на базовой логике. `inversion_value` не используется.
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
45. **v29 runner UI heartbeat (устарело как обязательное):** heartbeat Angular → `APP_TRADE_RUNNER_HB`; с 2026-07-29 по умолчанию **headless** (`APP_TRADE_RUNNER_REQUIRE_UI=0`); UI-gate только при флаге.
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
99a. **Installer SSL CA (opt-in):** Tasks → `updatesslcerts` (default unchecked) → `update-ssl-certs.txt` + `install.ps1 -UpdateSslCerts` → `fix_pgsql_http_ssl.ps1` + `configure_http_ssl()`. Linux: `--update-ssl-certs`.
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
- [x] Remake `security_inversion` → paper×side как `security_resume` + toggle; shadow base logic (2026-07-29).
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
- [ ] Apply `02` equity-cap fix on remote (logic 359 / **1720 MTLRP 05.08** ~25k на ~33k) and confirm no oversized short/long opens; optionally harden: real `equity=0` → не открывать (не fallback на сырой cash).
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
| 2026-08-25 | Release **optimize-and-real-trade-safe** published (v1.0.156: Setup.exe/.ex_ + linux tar.gz) |
| 2026-08-25 | #844: remote margin again — equity<=0 now stops trading (was raw-sizing fallback); real net equity subtracts open-short notional |
| 2026-08-25 | #843: per-signal timeframes — tf=BASE[×k] in formula, M7-style auto-catalog, no-lookahead aligned bars; runner/backtest/OPT multi-TF load+eval; UI TF base×mult controls |
| 2026-08-25 | #842: revert LinReg Fade Trend seed (#840, never pushed) + sync window back to 200/150; keep #841 |
| 2026-08-25 | #838: no-borrow audit long+short; gap guards order_gap_buffer_pct/max_open_gap_pct + fresh-price check (stop TF); exact fill price into exposure; park excludes short proceeds; installers v1.0.151 |
| 2026-08-25 | #837: installer No=upgrade verified; SHIPPED local-only sizing fix into 02 (no portfolio fallback + order pause); push-permission rule; installers v1.0.149 |
| 2026-08-24 | Papers: drop График/Эквити buttons; LINREG/SQUARE bands back on price scale (#836) |
| 2026-08-24 | Portfolio equity: long/short pale zones (#835); price charts: candles/line toggle |
| 2026-08-24 | Fix #834: disk cleanup keeps each logic's LAST finished backtest run (results always visible) |
| 2026-08-24 | Linear TP (portfolio_ltp_renew) selectable again in stop-loss/TP blocks (#833) |
| 2026-08-24 | Rule #832: local-only changes must be packaged — rebuild both installers; push only after explicit confirmation |
| 2026-08-24 | Drop UNIQUE on logic signals (duplicates allowed, v65); «?» button inside formula field (#831); installers pending |
| 2026-08-24 | Signal formula editor: arithmetic (+ − * / #, parens) in condition over pp/VALUE; «?» help button with indicator params (#830); installers pending |
| 2026-08-04 | Checkbox green = runner heartbeat (~15s), not TF/trades; bar_skip pulses check_at; v1.0.134 |
| 2026-08-04 | Fix red enable-checkbox while live trades run (Node health reconcile); v1.0.133 |
| 2026-08-04 | Fix close-all via Node like sell-all; drop UI heartbeat gate on Node PostOrder; v1.0.132 |
| 2026-08-04 | Live block «Сделки отклонённые (rejected)» + reject reason column; API /rejected; v1.0.131 |
| 2026-08-04 | Dismissible × on reject/token warning banners; reappear on new data; v1.0.130 |
| 2026-08-04 | Hotfix fetch failed: T-Bank via https.Agent + Russian CA; v1.0.129 |
| 2026-08-05 | Indicator cache 3+2 clusters; v1.0.135; diagnose 1720 MTLRP margin (no code) |
| 2026-08-04 | sell-all/bonds/close-all honor order channel; figi/bond via tbank_http_post; v1.0.128 |
| 2026-08-04 | Token/account check via Node + russiantrustedca.pem; tbank_http_post node proxy; v1.0.127 |
| 2026-08-04 | Hotfix preview-connection: pgResolveTbankAccount from ctx; v1.0.126 |
| 2026-08-04 | T-Bank API → invest-public-api.tbank.ru; SSL checkbox + Russian Trusted CA; v64 / v1.0.125 |
| 2026-08-04 | Order channel postgres|node in gear settings; Node PostOrder proxy; v63 / v1.0.124 |
| 2026-08-04 | Installer opt-in SSL CA update checkbox (default off); fix_pgsql_http_ssl + configure_http_ssl; v1.0.123 |
| 2026-08-02 | EOD close ignores use_non_trading_periods; last bar before evening window; v62 / v1.0.121 |
| 2026-08-01 | Hotfix NG1 rejectAlert template null; installers v1.0.120 |
| 2026-08-01 | Equity shade: force gray while portfolio_trading_paused; installers v1.0.119 |
| 2026-08-01 | Live reject-alert banner (≥8/24h or ≥5 spanning 30m); installers v1.0.118 |
| 2026-08-01 | Live logic-trades: exclude rejected from LIMIT; installers v1.0.117 |
| 2026-07-31 | Drop intentional DELETE of Futures Price Channel seeds; v61 / v1.0.116 |
| 2026-07-31 | Remove seed Futures Price Channel; keep contango/base_asset; v60 / v1.0.114 |
| 2026-07-31 | signal_acts_on=contango (fut−und price series); v59 / v1.0.113 |
| 2026-07-31 | Backtest price tips: chunked ~30d load + full phase_detail; v1.0.112 |
| 2026-07-31 | Futures Price Channel rename + sell N days before expiry (EOD); v58 / v1.0.111 |
| 2026-07-31 | Futures signal_acts_on + DONCHIAN Price Channel; seed Futures Price Channel + LNREG Base |
| 2026-07-31 | Crypt v1.22: thinner pen/eraser in Note (picture) mode for tablet stylus |
| 2026-07-31 | Equity: portfolio equity − short MTM; chart headroom; resume target null-safe; (цель 26801) |
| 2026-07-30 | Crypt v1.21: decrypt note onto edit canvas + pen/eraser; merge main → Pages |
| 2026-07-30 | Equity: resume target no scale crush; shadow PnL since pause; installers 107 |
| 2026-07-30 | Equity: horizontal resume target line while portfolio in shadow; installers 106 |
| 2026-07-30 | Equity fix: no white trailing gap; shadow dashed starts at first shadow close; installers 105 |
| 2026-07-30 | Equity: draw without closes; shadow dashed + gray zones; red enable when portfolio shadow |
| 2026-07-30 | Trade runner watchdog: auto-raise asleep cycle (Node+PG) + green/red enable checkbox + «торговля остановлена» badge |
| 2026-07-30 | Crypt v1.20: Refresh no-op if Key length 1–2 + message (empty or ≥3); merge main |
| 2026-07-30 | Crypt v1.19: Refresh = decrypt loaded file with new Key only; button after Key; disabled until Decrypt; merge main |
| 2026-07-30 | Crypt v1.18: RU/EN checkboxes after Crypt name; merge main → Pages |
| 2026-07-30 | Crypt v1.17: Обновить/Refresh — смена Ключа, тот же файл из памяти, перешифрование без picker; Pages |
| 2026-07-29 | Push: always open Angular UI after install (API-only opt-in); Trade cycle console logs; installers 102 |
| 2026-07-29 | Hotfix: export resumeOrphanWarmups (Server Start TypeError); installers 101 |
| 2026-07-29 | Push: headless trade runner + Server_Start after install-over; warm-up/balance resume; installers 100 |
| 2026-07-29 | Headless trade runner (no UI by default); Server_Start after install-over; warm-up/balance resume on API boot |
| 2026-07-29 | Push: security_inversion paper×side like resume + toggle; shadow base; Help/UI; installers 99 |
| 2026-07-29 | Merge Crypt + My Projects hub to main (GitHub Pages publish) || 2026-07-29 | Push: equity-curve let fix; sticky CSS vars; Testing header full-width; installers |
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

Последние (см. USER_INSTRUCTIONS): **825** — push; **824** — маржа remote 1720; **823** — кэш индикаторов 3+2; **822** — чекбокс не от TF.
