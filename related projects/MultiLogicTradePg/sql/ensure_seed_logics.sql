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
        ('BB Volume Fade', NULL)
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
        'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
    )
      AND EXISTS (SELECT 1 FROM logic_param_defs d WHERE d.param_key = v.param_key)
    ON CONFLICT (logic_id, param_key) DO NOTHING;

    INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
    SELECT l.id, 'opt_eval_candles', '200', 'integer'
    FROM logics l
    WHERE l.name IN ('LinReg Fade Optimized', 'LinReg Fade Twice Optimized')
      AND EXISTS (SELECT 1 FROM logic_param_defs d WHERE d.param_key = 'opt_eval_candles')
    ON CONFLICT (logic_id, param_key) DO NOTHING;

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
        'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
    )
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
        'SuperTrend CMO Fade', 'Force Index Fade', 'BB StdDev Fade', 'BB Volume Fade'
    )
      AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

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

    RAISE NOTICE 'ensure_seed_logics: OK — Optimized + Twice Optimized present; logics total=%',
        (SELECT COUNT(*) FROM logics);
END $$;
