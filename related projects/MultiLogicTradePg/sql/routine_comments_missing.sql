-- @include sql/routine_comments_missing.sql
-- Комментарии к функциям/процедурам без COMMENT ON (для UI «Структура БД» / obj_description).
-- Файл генерируется: node scripts/generate-missing-routine-comments.mjs

COMMENT ON FUNCTION calc_ind_atr IS
  'Расчёт ATR (Average True Range) для бумаги/таймфрейма; пишет серии индикатора.';

COMMENT ON FUNCTION calc_ind_atr_array IS
  'ATR массивом по барам (TABLE dt,value) для sync серий.';

COMMENT ON FUNCTION calc_ind_bb IS
  'Расчёт Bollinger Bands (UPPER/MIDDLE/LOWER).';

COMMENT ON FUNCTION calc_ind_bb_array IS
  'Bollinger Bands массивом по барам.';

COMMENT ON FUNCTION calc_ind_ema IS
  'Расчёт EMA (Exponential Moving Average).';

COMMENT ON FUNCTION calc_ind_ema_array IS
  'EMA массивом по барам.';

COMMENT ON FUNCTION calc_ind_macd IS
  'Расчёт MACD / SIGNAL / HISTOGRAM.';

COMMENT ON FUNCTION calc_ind_macd_array IS
  'MACD массивом по барам.';

COMMENT ON FUNCTION calc_ind_rsi IS
  'Расчёт RSI.';

COMMENT ON FUNCTION calc_ind_rsi_array IS
  'RSI массивом по барам.';

COMMENT ON FUNCTION calc_ind_sma IS
  'Расчёт SMA.';

COMMENT ON FUNCTION calc_ind_sma_array IS
  'SMA массивом по барам.';

COMMENT ON FUNCTION calc_ind_stoch IS
  'Расчёт Stochastic (K/D).';

COMMENT ON FUNCTION calc_ind_stoch_array IS
  'Stochastic массивом по барам.';

COMMENT ON FUNCTION calc_indicator_series_array IS
  'Универсальный расчёт серии индикатора (calc_ind_* или poly-формула).';

COMMENT ON FUNCTION default_invoke_formula IS
  'Формула вызова индикатора по умолчанию из справочника.';

COMMENT ON PROCEDURE ensure_security_indicator_series IS
  'Создаёт строки security_indicator_series для индикатора на бумаге.';

COMMENT ON FUNCTION evaluate_signal_condition IS
  'Проверяет условие сигнала (@CODE …) на закрытом баре.';

COMMENT ON FUNCTION get_logic_param_numeric IS
  'Числовой параметр логики из logic_params (EAV).';

COMMENT ON FUNCTION get_logic_param_text IS
  'Текстовый параметр логики из logic_params (EAV).';

COMMENT ON FUNCTION ind_resolve_end_dt IS
  'Конечная дата/время окна расчёта индикатора.';

COMMENT ON FUNCTION ind_warmup_bars IS
  'Число баров прогрева для индикатора/формулы.';

COMMENT ON FUNCTION is_perpetual_future_group IS
  'Признак вечного фьючерса (CNYRUBF и т.п.) по группе префикса.';

COMMENT ON FUNCTION logic_backtest_cancel_requested IS
  'Проверка: пользователь запросил остановку бэктеста.';

COMMENT ON FUNCTION logic_backtest_close_security IS
  'Закрытие позиции по бумаге в бэктесте.';

COMMENT ON FUNCTION logic_backtest_count_open_positions IS
  'Число открытых позиций в прогоне бэктеста.';

COMMENT ON FUNCTION logic_backtest_diagnose IS
  'Диагностика состояния бэктеста (отладка).';

COMMENT ON FUNCTION logic_backtest_insert_trade IS
  'Вставка тестовой сделки (logic_trades, is_test=1, run_id).';

COMMENT ON FUNCTION logic_backtest_price_at IS
  'Цена бумаги на баре бэктеста.';

COMMENT ON FUNCTION logic_backtest_process_risk IS
  'Стопы/риск в бэктесте на баре.';

COMMENT ON FUNCTION logic_backtest_process_signals IS
  'Сигналы open/close в бэктесте на баре.';

COMMENT ON FUNCTION logic_backtest_request_cancel IS
  'Помечает прогон бэктеста к отмене (UI Стоп).';

COMMENT ON FUNCTION logic_backtest_sec_inverted IS
  'Локальная инверсия бумаги в бэктесте (security_inversion).';

COMMENT ON FUNCTION logic_backtest_sec_shadow IS
  'Теневой режим бумаги в бэктесте (пауза/resume).';

COMMENT ON FUNCTION logic_backtest_security_drawdown_pct IS
  'Просадка по бумаге в бэктесте, %.';

COMMENT ON FUNCTION logic_backtest_security_gain_pct IS
  'Прирост по бумаге в бэктесте, %.';

COMMENT ON FUNCTION logic_backtest_update_run IS
  'Обновление статуса/прогресса logic_backtest_runs.';

COMMENT ON FUNCTION logic_check_security_resume IS
  'Проверка условий security_resume для возобновления торговли.';

COMMENT ON FUNCTION logic_close_security_positions_market IS
  'Закрытие боевых позиций по бумаге по рынку.';

COMMENT ON FUNCTION logic_count_open_positions IS
  'Число открытых боевых позиций логики.';

COMMENT ON FUNCTION logic_ensure_balance IS
  'Fake: current_balance/initial. Real: кэш с T-Bank → current_balance.';

COMMENT ON FUNCTION logic_long_position_qty IS
  'Объём открытого лонга по бумаге.';

COMMENT ON FUNCTION logic_portfolio_drawdown_pct IS
  'Просадка портфеля логики, %.';

COMMENT ON FUNCTION logic_portfolio_equity IS
  'Эквити портфеля логики (баланс ± позиции).';

COMMENT ON FUNCTION logic_security_drawdown_pct IS
  'Просадка по бумаге в боевом режиме, %.';

COMMENT ON FUNCTION logic_security_position_cost IS
  'Себестоимость позиции по бумаге.';

COMMENT ON FUNCTION logic_security_position_market IS
  'Рыночная оценка позиции по бумаге.';

COMMENT ON FUNCTION logic_security_track_value IS
  'Учётная стоимость позиции для стопов.';

COMMENT ON FUNCTION logic_short_position_qty IS
  'Объём открытого шорта по бумаге.';

COMMENT ON FUNCTION logic_signal_evaluate_at IS
  'Оценка сигнала логики на заданном баре.';

COMMENT ON FUNCTION logic_signal_record_fire IS
  'Фиксация срабатывания сигнала (pending рейтинга и т.п.).';

COMMENT ON FUNCTION logic_upsert_param IS
  'UPSERT параметра в logic_params.';

COMMENT ON FUNCTION parse_signal_formula IS
  'Разбор формулы сигнала @CODE(…) condition.';

COMMENT ON FUNCTION parse_signal_param_num IS
  'Числовой параметр из текста формулы сигнала.';

COMMENT ON FUNCTION parse_signal_series IS
  'Код серии (VALUE/UPPER/…) из формулы сигнала.';

COMMENT ON FUNCTION poly_add IS
  'Сложение рядов в poly-парсере.';

COMMENT ON FUNCTION poly_align2 IS
  'Выравнивание двух рядов по длине.';

COMMENT ON FUNCTION poly_build_ema_kernel IS
  'Ядро EMA для свёртки.';

COMMENT ON FUNCTION poly_build_sma_kernel IS
  'Ядро SMA для свёртки.';

COMMENT ON FUNCTION poly_comp_div IS
  'Покомпонентное деление рядов.';

COMMENT ON FUNCTION poly_comp_mul IS
  'Покомпонентное умножение рядов.';

COMMENT ON FUNCTION poly_ctx_period IS
  'Период из контекста poly-формулы.';

COMMENT ON FUNCTION poly_delta_kernel IS
  'Ядро дельты (производной) для свёртки.';

COMMENT ON FUNCTION poly_eval_node IS
  'Вычисление узла AST poly-формулы.';

COMMENT ON FUNCTION poly_extend IS
  'Дополнение ряда до нужной длины.';

COMMENT ON FUNCTION poly_fn_empty_args IS
  'Проверка пустых аргументов функции sma/ema/…';

COMMENT ON FUNCTION poly_fn_resolve_period IS
  'Период из аргументов sma(period=…).';

COMMENT ON FUNCTION poly_fn_resolve_series IS
  'Серия из аргументов sma(…, series=…).';

COMMENT ON FUNCTION poly_fn_validate_args IS
  'Валидация аргументов встроенных poly-функций.';

COMMENT ON FUNCTION poly_formula_conv_depth IS
  'Глубина свёрток формулы (для warmup).';

COMMENT ON FUNCTION poly_formula_warmup_bars IS
  'Бары прогрева для poly-формулы.';

COMMENT ON FUNCTION poly_is_formula IS
  'Признак, что invoke — многочленная формула.';

COMMENT ON FUNCTION poly_len IS
  'Длина числового ряда.';

COMMENT ON FUNCTION poly_load_indicator_array IS
  'Загрузка ряда индикатора @CODE в poly-контекст.';

COMMENT ON FUNCTION poly_load_market_array IS
  'Загрузка OHLC/V ряда (pp/oo/…) в poly-контекст.';

COMMENT ON FUNCTION poly_load_market_dts IS
  'Метки времени баров рынка для poly.';

COMMENT ON FUNCTION poly_neg IS
  'Унарный минус ряда.';

COMMENT ON FUNCTION poly_parse IS
  'Разбор текста poly-формулы в AST.';

COMMENT ON FUNCTION poly_parse_add IS
  'Разбор сложения/вычитания.';

COMMENT ON FUNCTION poly_parse_atom IS
  'Разбор атома (число, ряд, скобки).';

COMMENT ON FUNCTION poly_parse_comp IS
  'Разбор покомпонентных операций.';

COMMENT ON FUNCTION poly_parse_conv IS
  'Разбор свёртки (*).';

COMMENT ON FUNCTION poly_parse_fn_args IS
  'Разбор аргументов sma(…)/ema(…).';

COMMENT ON FUNCTION poly_parse_unary IS
  'Разбор унарных операций.';

COMMENT ON FUNCTION poly_peek_token IS
  'Просмотр текущего токена без потребления.';

COMMENT ON FUNCTION poly_pp_from_ctx IS
  'Ряд Close (pp) из контекста.';

COMMENT ON FUNCTION poly_sub IS
  'Вычитание рядов.';

COMMENT ON FUNCTION poly_tokenize IS
  'Лексер poly-формулы.';

COMMENT ON FUNCTION resolve_indicator_params IS
  'Параметры индикатора (period и др.) для расчёта.';

COMMENT ON PROCEDURE sync_security_indicator_series IS
  'Синхронизация (пересчёт) серий индикатора на бумаге.';

COMMENT ON PROCEDURE sync_security_indicator_series_all IS
  'Синхронизация всех серий индикаторов на бумаге.';

