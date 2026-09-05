-- ============================================
-- Ensure default seed logics (install-on-top / upgrade).
-- Run after 01_multilogictrade_tables_and_data.sql.
-- Does not overwrite user copies or edits (INSERT … ON CONFLICT DO NOTHING).
-- ============================================

CREATE UNIQUE INDEX IF NOT EXISTS logics_name_key ON logics (name);

DO $$
DECLARE
    v_account_id INTEGER;
    v_opt_count INTEGER;
    v_twice_count INTEGER;
    v_cci_count INTEGER;
BEGIN
    SELECT acc.id INTO v_account_id
    FROM accounts acc
    JOIN brokers br ON br.id = acc.broker_id
    WHERE br.code = 'T-BANK'
      AND (acc.account_code = 'FAKE-EFF-001' OR lower(acc.account_type::text) = 'fake')
    ORDER BY CASE WHEN acc.account_code = 'FAKE-EFF-001' THEN 0 ELSE 1 END, acc.id
    LIMIT 1;

    IF v_account_id IS NULL THEN
        SELECT acc.id INTO v_account_id
        FROM accounts acc
        JOIN brokers br ON br.id = acc.broker_id
        WHERE br.code = 'T-BANK'
        ORDER BY CASE WHEN lower(acc.account_type::text) = 'fake' THEN 0 ELSE 1 END, acc.id
        LIMIT 1;
    END IF;

    IF v_account_id IS NULL THEN
        SELECT id INTO v_account_id FROM accounts ORDER BY id LIMIT 1;
    END IF;

    IF v_account_id IS NULL THEN
        RAISE EXCEPTION 'ensure_seed_logics: no accounts row — cannot seed logics';
    END IF;

    RAISE NOTICE 'ensure_seed_logics: using account_id=%', v_account_id;

    INSERT INTO logics (name, account_id, is_enabled, note)
    SELECT v.name, v_account_id, FALSE, v.note
    FROM (VALUES
        ('SMA Price Cross Demo', 'Демо: пересечение цены и SMA.'),
        ('RSI Mean Reversion', NULL),
        ('Bollinger Bounce', NULL),
        ('Bollinger Breakout', NULL),
        ('MACD Zero Line', NULL),
        ('Stochastic Levels', NULL),
        ('EMA Price Cross', NULL),
        ('Dual MA Trend', NULL),
        ('SMA Stoch Pullback', NULL),
        ('BB Stoch Bounce', NULL),
        ('SMAT3 Trend', NULL),
        ('L1 — лонг, тренд', NULL),
        ('L2 — лонг, боковик', NULL),
        ('L3 — шорт, тренд', NULL),
        ('L4 — шорт, боковик', NULL),
        ('CCI Countertrade', 'Контртрендовая. OsEngine-style CCI fade.'),
        ('LinReg Fade', 'Контртрендовая. Fade по каналу LinReg.'),
        ('LinReg Fade Optimized', 'Как LinReg Fade + OPT(std_dev,10).'),
        ('LinReg Fade Twice Optimized', 'Как LinReg Fade + OPT(std_dev,10)+OPT(period,10).'),
        ('Square Fade', 'Контртрендовая. Fade по каналу SQUARE.'),
        ('ADX Range RSI', NULL),
        ('MACD Hist Fade', NULL),
        ('ATR Spike Reversal', NULL),
        ('MACD Signal Cross', NULL),
        ('ADX DI Trend', NULL),
        ('SMA100 Trend', NULL),
        ('LinReg Slope Trend', NULL),
        ('PACC Momentum Trend', NULL),
        ('RSI Extreme 20/80', NULL),
        ('Stoch D Fade', NULL),
        ('CCI Extreme 200', NULL),
        ('MACD Signal Fade', NULL),
        ('ADX Exhaustion Fade', NULL),
        ('ATR Quiet RSI', NULL),
        ('SMA Stretch Fade', NULL),
        ('Stoch RSI Combo', NULL),
        ('PACC Reversal', NULL),
        ('EMA RSI Fade', NULL),
        ('NRTR ROC Fade', NULL),
        ('RAVI BB Fade', NULL),
        ('Stoch Aroon Fade', NULL),
        ('MI SMA Reversal', NULL),
        ('SuperTrend CMO Fade', NULL),
        ('Force Index Fade', NULL),
        ('BB StdDev Fade', NULL),
        ('BB Volume Fade', NULL),
        ('LinReg Fade Trend', 'Двухтаймфреймовая fade по LinReg. TF=H2 + M15, оптимизированная.'),
        ('CCI Fade Trend 2023', 'Fade по CCI20 на M15 + trend-фильтр H2 LinReg100. Как боевая логика 8511.'),
        ('CMO Stoch Trend', 'Трендовая CMO(14)+Стохастик %K(14,3,3). Лонг CMO>0 и K>50, шорт CMO<0 и K<50. СПЯЩАЯ: бэктест #367 ≈ −384 528₽.'),
        ('CMO Stoch Counter', 'Контр-тренд CMO(14)+Стохастик %K(14,3,3). Лонг CMO<0 и K<50, шорт CMO>0 и K>50. Версия по умолчанию: бэктест #368 ≈ +93 441₽.')
    ) AS v(name, note)
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
    SELECT l.id, v.param_key, v.param_value, v.value_type
    FROM logics l
    CROSS JOIN (VALUES
        ('timeframe', 'M15', 'text'),
        ('position_size_pct', '10', 'number'),
        ('max_open_positions', '3', 'integer'),
        ('initial_balance', '1000000', 'money'),
        ('current_balance', '1000000', 'money'),
        ('commission_pct', '0.03', 'number'),
        ('cost_method', 'FIFO', 'text')
    ) AS v(param_key, param_value, value_type)
    WHERE l.name IN (
        'SMA Price Cross Demo',
        'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
        'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
        'BB Stoch Bounce', 'SMAT3 Trend',
        'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик',
        'CCI Countertrade', 'LinReg Fade', 'LinReg Fade Optimized', 'LinReg Fade Twice Optimized', 'Square Fade',
        'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal',
        'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
        'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
        'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade',
        'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
        'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade',
        'CCI Fade Trend 2023',
        'CMO Stoch Trend', 'CMO Stoch Counter'
    )
      AND EXISTS (SELECT 1 FROM logic_param_defs d WHERE d.param_key = v.param_key)
    ON CONFLICT (logic_id, param_key) DO NOTHING;

    INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
    SELECT l.id, 'opt_eval_candles', '200', 'integer'
    FROM logics l
    WHERE l.name IN ('LinReg Fade Optimized', 'LinReg Fade Twice Optimized', 'LinReg Fade Trend', 'CCI Fade Trend 2023', 'CMO Stoch Trend', 'CMO Stoch Counter')
      AND EXISTS (SELECT 1 FROM logic_param_defs d WHERE d.param_key = 'opt_eval_candles')
    ON CONFLICT (logic_id, param_key) DO NOTHING;

    INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
    SELECT l.id, v.param_key, v.param_value, v.value_type
    FROM logics l
    CROSS JOIN (VALUES
        ('stop_loss_timeframe', 'M5', 'text'),
        ('use_non_trading_periods', 'true', 'boolean'),
        ('warmup_pretest', 'true', 'boolean'),
        ('close_positions_eod', 'false', 'boolean'),
        ('inversion', 'false', 'boolean'),
        ('resume_sl_no_reduce', 'false', 'boolean'),
        ('sell_futures_before_expiry', 'false', 'boolean'),
        ('sell_futures_days_before_expiry', '3', 'integer'),
        ('position_size_base', 'free_cash', 'text'),
        ('rating_lookback_days', '7', 'integer'),
        ('order_execution', 'market', 'text'),
        ('base_annual_rate_pct', '20', 'number')
    ) AS v(param_key, param_value, value_type)
    WHERE l.name IN ('LinReg Fade Trend', 'CCI Fade Trend 2023', 'CMO Stoch Trend', 'CMO Stoch Counter')
      AND EXISTS (SELECT 1 FROM logic_param_defs d WHERE d.param_key = v.param_key)
    ON CONFLICT (logic_id, param_key) DO NOTHING;

    -- CCI Fade Trend 2023: как боевая 8511 — до 15 одновременно открытых позций.
    UPDATE logic_params lp
    SET param_value = '15', value_type = 'integer', updated_at = CURRENT_TIMESTAMP
    FROM logics l
    WHERE lp.logic_id = l.id
      AND l.name = 'CCI Fade Trend 2023'
      AND lp.param_key = 'max_open_positions';

    UPDATE logic_params
    SET param_value = '200',
        value_type = 'integer',
        updated_at = CURRENT_TIMESTAMP
    WHERE param_key = 'opt_eval_candles'
      AND param_value IS DISTINCT FROM '200';

    INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
    )
    SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
    FROM logics l
    CROSS JOIN (VALUES
        ('LINREG', 'open',  'long',  'counter', '@LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10)) pp <= VALUE', 0),
        ('LINREG', 'close', 'long',  'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10)) pp >= VALUE', 1),
        ('LINREG', 'open',  'short', 'counter', '@LINREG(period=20,std_dev=2,series=UPPER,OPT(std_dev,10)) pp >= VALUE', 2),
        ('LINREG', 'close', 'short', 'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10)) pp <= VALUE', 3)
    ) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
    JOIN indicators i ON i.code = v.ind_code
    WHERE l.name = 'LinReg Fade Optimized'
      AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

    INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
    )
    SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
    FROM logics l
    CROSS JOIN (VALUES
        ('LINREG', 'open',  'long',  'counter', '@LINREG(period=20,std_dev=1.6,series=LOWER) pp <= VALUE', 0),
        ('LINREG', 'open',  'long',  'trend',   '@LINREG(tf=H2,period=100,std_dev=2,series=MIDDLE) pp >= VALUE', 1),
        ('LINREG', 'close', 'long',  'trend',   '@LINREG(period=20,std_dev=1.6,series=MIDDLE) pp >= VALUE', 2),
        ('LINREG', 'open',  'short', 'counter', '@LINREG(period=20,std_dev=1.6,series=UPPER) pp >= VALUE', 3),
        ('LINREG', 'open',  'short', 'trend',   '@LINREG(tf=H2,period=100,std_dev=2,series=MIDDLE) pp <= VALUE', 4),
        ('LINREG', 'close', 'short', 'trend',   '@LINREG(period=20,std_dev=1.6,series=MIDDLE) pp <= VALUE', 5)
    ) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
    JOIN indicators i ON i.code = v.ind_code
    WHERE l.name = 'LinReg Fade Trend'
      AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

    INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
    )
    SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
    FROM logics l
    CROSS JOIN (VALUES
        ('CCI',    'open',  'long',  'counter', '@CCI(period=20,series=VALUE) VALUE <= -100', 0),
        ('LINREG', 'open',  'long',  'trend',   '@LINREG(tf=H2,period=100,std_dev=2,series=MIDDLE) pp >= VALUE', 1),
        ('CCI',    'close', 'long',  'trend',   '@CCI(period=20,series=VALUE) VALUE >= 0', 2),
        ('CCI',    'open',  'short', 'counter', '@CCI(period=20,series=VALUE) VALUE >= 100', 3),
        ('LINREG', 'open',  'short', 'trend',   '@LINREG(tf=H2,period=100,std_dev=2,series=MIDDLE) pp <= VALUE', 4),
        ('CCI',    'close', 'short', 'trend',   '@CCI(period=20,series=VALUE) VALUE <= 0', 5)
    ) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
    JOIN indicators i ON i.code = v.ind_code
    WHERE l.name = 'CCI Fade Trend 2023'
      AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

    INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
    )
    SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
    FROM logics l
    CROSS JOIN (VALUES
        ('LINREG', 'open',  'long',  'counter', '@LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10),OPT(period,10)) pp <= VALUE', 0),
        ('LINREG', 'close', 'long',  'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10),OPT(period,10)) pp >= VALUE', 1),
        ('LINREG', 'open',  'short', 'counter', '@LINREG(period=20,std_dev=2,series=UPPER,OPT(std_dev,10),OPT(period,10)) pp >= VALUE', 2),
        ('LINREG', 'close', 'short', 'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10),OPT(period,10)) pp <= VALUE', 3)
    ) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
    JOIN indicators i ON i.code = v.ind_code
    WHERE l.name = 'LinReg Fade Twice Optimized'
      AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

    INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
    SELECT dst.id, ls.security_id, ls.display_order, ls.is_active
    FROM logics src
    JOIN logic_securities ls ON ls.logic_id = src.id
    JOIN logics dst ON dst.name IN ('LinReg Fade Optimized', 'LinReg Fade Twice Optimized')
    WHERE src.name = 'LinReg Fade'
      AND NOT EXISTS (SELECT 1 FROM logic_securities z WHERE z.logic_id = dst.id)
    ON CONFLICT (logic_id, security_id) DO NOTHING;

    INSERT INTO logic_securities (logic_id, security_id, display_order)
    SELECT l.id, q.security_id, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY q.sort_key) - 1
    FROM logics l
    CROSS JOIN LATERAL (
        SELECT DISTINCT ON (s.id)
            s.id AS security_id,
            COALESCE(sp.prefix, s.name) AS sort_key
        FROM securities s
        JOIN security_prefixes sp ON sp.security_id = s.id AND sp.instrument_market = 'stock'
        ORDER BY s.id, sp.prefix
    ) q
    WHERE l.name IN (
        'SMA Price Cross Demo',
        'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
        'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
        'BB Stoch Bounce', 'SMAT3 Trend',
        'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик',
        'CCI Countertrade', 'LinReg Fade', 'LinReg Fade Optimized', 'LinReg Fade Twice Optimized', 'Square Fade',
        'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal',
        'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
        'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
        'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade',
        'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
        'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade',
        'LinReg Fade Trend'
    )
      AND NOT EXISTS (SELECT 1 FROM logic_securities z WHERE z.logic_id = l.id)
    ON CONFLICT (logic_id, security_id) DO NOTHING;

    -- CCI Fade Trend 2023: точный список бумаг боевой логики 8511 (34 тикера MOEX).
    INSERT INTO logic_securities (logic_id, security_id, display_order)
    SELECT l.id, q.security_id, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY q.sort_key) - 1
    FROM logics l
    CROSS JOIN LATERAL (
        SELECT DISTINCT ON (srt.id)
            srt.id AS security_id,
            sprt.prefix AS sort_key
        FROM securities srt
        JOIN security_prefixes sprt ON sprt.security_id = srt.id AND sprt.instrument_market = 'stock'
        WHERE sprt.prefix IN (
            'SBER','SBERP','GAZP','LKOH','ROSN','NVTK','GMKN','TATN','TATNP',
            'PLZL','ALRS','CHMF','NLMK','MAGN','MTLR','MTLRP','MGNT','MTSS',
            'RUAL','HYDR','PHOR','MOEX','TRNFP','UPRO','SNGS','SNGSP','VTBR',
            'IRAO','FEES','RTKM','YDEX','AFLT','FLOT','AFKS'
        )
        ORDER BY srt.id, sprt.prefix
    ) q
    WHERE l.name = 'CCI Fade Trend 2023'
      AND NOT EXISTS (SELECT 1 FROM logic_securities z WHERE z.logic_id = l.id)
    ON CONFLICT (logic_id, security_id) DO NOTHING;

    INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
    SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
    FROM logics l
    CROSS JOIN (VALUES
        ('stop_loss',   'security_resume', 1.0, 'percent', 0),
        ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
    ) AS v(rule_kind, scope_type, value, value_unit, display_order)
    WHERE l.name IN (
        'SMA Price Cross Demo',
        'RSI Mean Reversion', 'Bollinger Bounce', 'Bollinger Breakout', 'MACD Zero Line',
        'Stochastic Levels', 'EMA Price Cross', 'Dual MA Trend', 'SMA Stoch Pullback',
        'BB Stoch Bounce', 'SMAT3 Trend',
        'L1 — лонг, тренд', 'L2 — лонг, боковик', 'L3 — шорт, тренд', 'L4 — шорт, боковик',
        'CCI Countertrade', 'LinReg Fade', 'LinReg Fade Optimized', 'LinReg Fade Twice Optimized', 'Square Fade',
        'ADX Range RSI', 'MACD Hist Fade', 'ATR Spike Reversal',
        'MACD Signal Cross', 'ADX DI Trend', 'SMA100 Trend', 'LinReg Slope Trend', 'PACC Momentum Trend',
        'RSI Extreme 20/80', 'Stoch D Fade', 'CCI Extreme 200', 'MACD Signal Fade', 'ADX Exhaustion Fade',
        'ATR Quiet RSI', 'SMA Stretch Fade', 'Stoch RSI Combo', 'PACC Reversal', 'EMA RSI Fade',
        'NRTR ROC Fade', 'RAVI BB Fade', 'Stoch Aroon Fade', 'MI SMA Reversal',
        'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade',
        'LinReg Fade Trend',
        'CCI Fade Trend 2023',
        'CMO Stoch Trend', 'CMO Stoch Counter'
    )
      AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

    INSERT INTO logic_non_trading_intervals (logic_id, day_of_week, time_from, time_to, is_active, display_order)
    SELECT l.id, v.day_of_week, v.time_from, v.time_to, TRUE, v.display_order
    FROM logics l
    CROSS JOIN (VALUES
        (1, '00:00:00'::time, '09:59:59'::time, 0),
        (1, '18:40:00'::time, '23:59:59'::time, 1),
        (2, '00:00:00'::time, '09:59:59'::time, 2),
        (2, '18:40:00'::time, '23:59:59'::time, 3),
        (3, '00:00:00'::time, '09:59:59'::time, 4),
        (3, '18:40:00'::time, '23:59:59'::time, 5),
        (4, '00:00:00'::time, '09:59:59'::time, 6),
        (4, '18:40:00'::time, '23:59:59'::time, 7),
        (5, '00:00:00'::time, '09:59:59'::time, 8),
        (5, '18:40:00'::time, '23:59:59'::time, 9),
        (6, '00:00:00'::time, '23:59:59'::time, 10),
        (7, '00:00:00'::time, '23:59:59'::time, 11)
    ) AS v(day_of_week, time_from, time_to, display_order)
    WHERE l.name IN ('LinReg Fade Trend', 'CCI Fade Trend 2023', 'CMO Stoch Trend', 'CMO Stoch Counter')
      AND NOT EXISTS (SELECT 1 FROM logic_non_trading_intervals z WHERE z.logic_id = l.id);

    -- CMO Stoch Trend (спящая) и CMO Stoch Counter (по умолчанию): до 15 позиций.
    UPDATE logic_params lp
    SET param_value = '15', value_type = 'integer', updated_at = CURRENT_TIMESTAMP
    FROM logics l
    WHERE lp.logic_id = l.id
      AND l.name IN ('CMO Stoch Trend', 'CMO Stoch Counter')
      AND lp.param_key = 'max_open_positions';

    -- CMO-логики по умолчанию ВЫКЛЮЧЕНЫ (is_enabled=FALSE). Принудительно на каждом прогоне:
    -- это «install-on-top», и существующие (в т.ч. включённые прошлой версией) строки INSERT не
    -- затронет — только явный UPDATE гарантирует спящее состояние на свежей И уже существующей БД.
    -- Включение — явный шаг: переключатель в UI либо run api/scripts/seed-cmo-stoch-counter.sql
    -- («включение из установщика»). ВНИМАНИЕ: повторный прогон ensure_seed снова выключит обе.
    UPDATE logics SET is_enabled = FALSE WHERE name IN ('CMO Stoch Trend', 'CMO Stoch Counter');

    INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
    )
    SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
    FROM logics l
    CROSS JOIN (VALUES
        ('CMO',   'open',  'long',  'trend', '@CMO(period=14,series=VALUE) VALUE > 0',                       0),
        ('STOCH', 'open',  'long',  'trend', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE > 50',  1),
        ('CMO',   'close', 'long',  'trend', '@CMO(period=14,series=VALUE) VALUE < 0',                       2),
        ('STOCH', 'close', 'long',  'trend', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE < 50',  3),
        ('CMO',   'open',  'short', 'trend', '@CMO(period=14,series=VALUE) VALUE < 0',                       4),
        ('STOCH', 'open',  'short', 'trend', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE < 50',  5),
        ('CMO',   'close', 'short', 'trend', '@CMO(period=14,series=VALUE) VALUE > 0',                       6),
        ('STOCH', 'close', 'short', 'trend', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE > 50',  7)
    ) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
    JOIN indicators i ON i.code = v.ind_code
    WHERE l.name = 'CMO Stoch Trend'
      AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

    INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
    )
    SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
    FROM logics l
    CROSS JOIN (VALUES
        ('CMO',   'open',  'long',  'counter', '@CMO(period=14,series=VALUE) VALUE < 0',                       0),
        ('STOCH', 'open',  'long',  'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE < 50',  1),
        ('CMO',   'close', 'long',  'counter', '@CMO(period=14,series=VALUE) VALUE > 0',                       2),
        ('STOCH', 'close', 'long',  'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE > 50',  3),
        ('CMO',   'open',  'short', 'counter', '@CMO(period=14,series=VALUE) VALUE > 0',                       4),
        ('STOCH', 'open',  'short', 'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE > 50',  5),
        ('CMO',   'close', 'short', 'counter', '@CMO(period=14,series=VALUE) VALUE < 0',                       6),
        ('STOCH', 'close', 'short', 'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE < 50',  7)
    ) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
    JOIN indicators i ON i.code = v.ind_code
    WHERE l.name = 'CMO Stoch Counter'
      AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

    INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
    SELECT dst.id, ls.security_id, ls.display_order, ls.is_active
    FROM logics src
    JOIN logic_securities ls ON ls.logic_id = src.id
    JOIN logics dst ON dst.name IN ('CMO Stoch Trend', 'CMO Stoch Counter')
    WHERE src.name = 'LinReg Fade Trend'
      AND NOT EXISTS (SELECT 1 FROM logic_securities z WHERE z.logic_id = dst.id)
    ON CONFLICT (logic_id, security_id) DO NOTHING;

    SELECT COUNT(*) INTO v_opt_count
    FROM logics
    WHERE name = 'LinReg Fade Optimized';

    IF v_opt_count < 1 THEN
        RAISE EXCEPTION 'ensure_seed_logics: LinReg Fade Optimized still missing after seed (account_id=%)', v_account_id;
    END IF;

    SELECT COUNT(*) INTO v_twice_count
    FROM logics
    WHERE name = 'LinReg Fade Twice Optimized';

    IF v_twice_count < 1 THEN
        RAISE EXCEPTION 'ensure_seed_logics: LinReg Fade Twice Optimized still missing after seed (account_id=%)', v_account_id;
    END IF;

    SELECT COUNT(*) INTO v_cci_count
    FROM logics
    WHERE name = 'CCI Fade Trend 2023';

    IF v_cci_count < 1 THEN
        RAISE EXCEPTION 'ensure_seed_logics: CCI Fade Trend 2023 still missing after seed (account_id=%)', v_account_id;
    END IF;

    RAISE NOTICE 'ensure_seed_logics: OK — Optimized + Twice Optimized + CCI Fade Trend 2023 present; logics total=%',
        (SELECT COUNT(*) FROM logics);
END $$;
