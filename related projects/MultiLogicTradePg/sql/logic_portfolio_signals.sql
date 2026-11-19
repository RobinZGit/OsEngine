-- Portfolio signals (acts_on='portfolio'): equity series, pending state, evaluation, execution helpers.
-- Live: logic_portfolio_equity_bars + logic_portfolio_signal_state.
-- Backtest: logic_backtest_equity_points + logic_backtest_runs.portfolio_close_pending.

-- Helper: integer logic param (NULL if missing/unparseable -> p_default).
CREATE OR REPLACE FUNCTION get_logic_param_int(
    p_logic_id INTEGER,
    p_param_key TEXT,
    p_default INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_num NUMERIC;
BEGIN
    v_num := get_logic_param_numeric(p_logic_id, p_param_key, NULL);
    IF v_num IS NULL THEN
        RETURN p_default;
    END IF;
    RETURN v_num::INTEGER;
END;
$$;

CREATE OR REPLACE FUNCTION logic_portfolio_equity_bar_ohlc(
    p_close NUMERIC,
    p_prev_close NUMERIC
)
RETURNS TABLE (open_price NUMERIC, high_price NUMERIC, low_price NUMERIC, close_price NUMERIC)
LANGUAGE sql IMMUTABLE AS $$
    SELECT
        COALESCE(p_prev_close, p_close) AS open_price,
        GREATEST(COALESCE(p_prev_close, p_close), p_close) AS high_price,
        LEAST(COALESCE(p_prev_close, p_close), p_close) AS low_price,
        p_close AS close_price;
$$;

COMMENT ON FUNCTION logic_portfolio_equity_bar_ohlc(NUMERIC, NUMERIC) IS
'РЎРІРµС‡Р° equity РїРѕСЂС‚С„РµР»СЏ: O=prev_close (РїРµСЂРІР°СЏ=close), H=max(O,C), L=min(O,C), C=equity';

-- Live equity at closed bar dt (cash + MTM РІСЃРµС… РїРѕР·РёС†РёР№, РІРєР»СЋС‡Р°СЏ С„РѕРЅРґС‹), is_test=FALSE.
CREATE OR REPLACE FUNCTION logic_portfolio_equity_at_bar_live(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    WITH pos AS (
        SELECT
            lt.security_id,
            GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) AS long_qty,
            GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) AS short_qty
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = FALSE
          AND lt.is_shadow = FALSE
          AND COALESCE(lt.opt_lane, '') = ''
          AND lt.status IN ('filled', 'submitted')
        GROUP BY lt.security_id
        HAVING GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) > 0
            OR GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) > 0
    ),
    px AS (
        SELECT
            pos.long_qty,
            pos.short_qty,
            p.close_price
        FROM pos
        CROSS JOIN LATERAL (
            SELECT pr.close_price
            FROM prices pr
            WHERE pr.security_id = pos.security_id
              AND pr.timeframe_id = p_timeframe_id
              AND pr.dt <= p_bar_dt
            ORDER BY pr.dt DESC
            LIMIT 1
        ) p
    )
    SELECT COALESCE(logic_ensure_balance(p_logic_id), 0)
         + COALESCE(SUM(px.long_qty * px.close_price - px.short_qty * px.close_price), 0)
    FROM px
    WHERE px.close_price > 0;
$$;

COMMENT ON FUNCTION logic_portfolio_equity_at_bar_live(INTEGER, INTEGER, TIMESTAMP) IS
'Live equity РїРѕСЂС‚С„РµР»СЏ РЅР° Р·Р°РєСЂС‹С‚РѕРј Р±Р°СЂРµ: cash (logic_ensure_balance) + MTM РІСЃРµС… РїРѕР·РёС†РёР№ (is_test=false), РІРєР»СЋС‡Р°СЏ С„РѕРЅРґС‹';

-- Upsert equity bar for live portfolio signals (TF Р»РѕРіРёРєРё).
CREATE OR REPLACE FUNCTION logic_portfolio_record_equity_bar(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_equity NUMERIC;
    v_prev NUMERIC;
    v_o NUMERIC;
    v_h NUMERIC;
    v_l NUMERIC;
BEGIN
    IF p_logic_id IS NULL OR p_tf_id IS NULL OR p_bar_dt IS NULL THEN
        RETURN;
    END IF;
    v_equity := logic_portfolio_equity_at_bar_live(p_logic_id, p_tf_id, p_bar_dt);
    IF v_equity IS NULL THEN
        v_equity := COALESCE(logic_ensure_balance(p_logic_id), 0);
    END IF;
    SELECT b.close_price INTO v_prev
    FROM logic_portfolio_equity_bars b
    WHERE b.logic_id = p_logic_id
      AND b.timeframe_id = p_tf_id
      AND b.dt < p_bar_dt
    ORDER BY b.dt DESC
    LIMIT 1;

    SELECT open_price, high_price, low_price
    INTO v_o, v_h, v_l
    FROM logic_portfolio_equity_bar_ohlc(v_equity, v_prev);

    INSERT INTO logic_portfolio_equity_bars (
        logic_id, timeframe_id, dt, open_price, high_price, low_price, close_price
    ) VALUES (
        p_logic_id, p_tf_id, p_bar_dt, v_o, v_h, v_l, v_equity
    )
    ON CONFLICT (logic_id, timeframe_id, dt) DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price;
END;
$$;

COMMENT ON FUNCTION logic_portfolio_record_equity_bar(INTEGER, INTEGER, TIMESTAMP) IS
'Р—Р°РїРёСЃР°С‚СЊ/РѕР±РЅРѕРІРёС‚СЊ СЃРІРµС‡Сѓ equity РїРѕСЂС‚С„РµР»СЏ (live) РґР»СЏ acts_on=portfolio';

-- State: live pending
CREATE OR REPLACE FUNCTION logic_portfolio_signal_is_pending(p_logic_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT s.pending FROM logic_portfolio_signal_state s WHERE s.logic_id = p_logic_id),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION logic_portfolio_signal_set_pending(
    p_logic_id INTEGER,
    p_bar_dt TIMESTAMP DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO logic_portfolio_signal_state (logic_id, pending, set_at, set_bar_dt, updated_at)
    VALUES (p_logic_id, TRUE, CURRENT_TIMESTAMP, p_bar_dt, CURRENT_TIMESTAMP)
    ON CONFLICT (logic_id) DO UPDATE SET
        pending = TRUE,
        set_at = COALESCE(logic_portfolio_signal_state.set_at, EXCLUDED.set_at),
        set_bar_dt = COALESCE(EXCLUDED.set_bar_dt, logic_portfolio_signal_state.set_bar_dt),
        updated_at = CURRENT_TIMESTAMP;
END;
$$;

CREATE OR REPLACE FUNCTION logic_portfolio_signal_clear_pending(p_logic_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO logic_portfolio_signal_state (logic_id, pending, set_at, set_bar_dt, updated_at)
    VALUES (p_logic_id, FALSE, NULL, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT (logic_id) DO UPDATE SET
        pending = FALSE,
        set_at = NULL,
        set_bar_dt = NULL,
        updated_at = CURRENT_TIMESTAMP;
END;
$$;

-- State: backtest pending (per run)
CREATE OR REPLACE FUNCTION logic_backtest_portfolio_signal_is_pending(p_run_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT r.portfolio_close_pending FROM logic_backtest_runs r WHERE r.id = p_run_id),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION logic_backtest_portfolio_signal_set_pending(p_run_id BIGINT)
RETURNS VOID
LANGUAGE sql AS $$
    UPDATE logic_backtest_runs SET portfolio_close_pending = TRUE WHERE id = p_run_id;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_portfolio_signal_clear_pending(p_run_id BIGINT)
RETURNS VOID
LANGUAGE sql AS $$
    UPDATE logic_backtest_runs SET portfolio_close_pending = FALSE WHERE id = p_run_id;
$$;

-- Check if logic has any non-cash-fund open positions (live)
CREATE OR REPLACE FUNCTION logic_has_open_positions_except_funds(p_logic_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = FALSE
          AND lt.is_shadow = FALSE
          AND COALESCE(lt.opt_lane, '') = ''
          AND lt.status IN ('filled', 'submitted')
          AND NOT logic_is_cash_fund_security(lt.security_id)
        GROUP BY lt.security_id
        HAVING
            GREATEST(COALESCE(SUM(CASE WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                                       WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity ELSE 0 END), 0), 0) > 0
            OR
            GREATEST(COALESCE(SUM(CASE WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                                       WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity ELSE 0 END), 0), 0) > 0
    );
$$;

-- Backtest: non-fund open positions in run
CREATE OR REPLACE FUNCTION logic_backtest_has_open_positions_except_funds(
    p_run_id BIGINT,
    p_logic_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = FALSE
          AND COALESCE(lt.opt_lane, '') = ''
          AND lt.run_id = p_run_id
          AND lt.status IN ('filled', 'submitted')
          AND NOT logic_is_cash_fund_security(lt.security_id)
        GROUP BY lt.security_id
        HAVING
            GREATEST(COALESCE(SUM(CASE WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                                       WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity ELSE 0 END), 0), 0) > 0
            OR
            GREATEST(COALESCE(SUM(CASE WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                                       WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity ELSE 0 END), 0), 0) > 0
    );
$$;

CREATE OR REPLACE FUNCTION logic_portfolio_signal_reset_if_flat(p_logic_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF logic_portfolio_signal_is_pending(p_logic_id)
       AND NOT logic_has_open_positions_except_funds(p_logic_id) THEN
        PERFORM logic_portfolio_signal_clear_pending(p_logic_id);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_portfolio_signal_reset_if_flat(
    p_run_id BIGINT,
    p_logic_id INTEGER
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF logic_backtest_portfolio_signal_is_pending(p_run_id)
       AND NOT logic_backtest_has_open_positions_except_funds(p_run_id, p_logic_id) THEN
        PERFORM logic_backtest_portfolio_signal_clear_pending(p_run_id);
    END IF;
END;
$$;

-- Validation: portfolio signals must be on logic TF.
-- Portfolio и per-security/base/contango сигналы могут сосуществовать для одного
-- события/направления как независимые AND-группы (исполняются раздельно).
CREATE OR REPLACE FUNCTION logic_portfolio_signals_validate(p_logic_id INTEGER)
RETURNS TABLE(ok BOOLEAN, message TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf_id INTEGER;
    v_logic_sec INTEGER;
    v_bad_tf RECORD;
BEGIN
    v_tf_id := get_logic_param_int(p_logic_id, 'timeframe_id', NULL);
    IF v_tf_id IS NULL AND btrim(COALESCE(get_logic_param_text(p_logic_id, 'timeframe'), '')) <> '' THEN
        v_tf_id := logic_resolve_timeframe_id(p_logic_id);
    END IF;
    IF v_tf_id IS NULL THEN
        ok := FALSE; message := 'Не задан таймфрейм логики';
        RETURN NEXT; RETURN;
    END IF;
    v_logic_sec := get_logic_param_int(p_logic_id, 'timeframe_sec', NULL);
    IF v_logic_sec IS NULL THEN
        SELECT t.sec INTO v_logic_sec FROM timeframes t WHERE t.id = v_tf_id;
    END IF;

    -- TF of portfolio signal must equal logic TF
    FOR v_bad_tf IN
        SELECT lis.id, lis.formula
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id
          AND lis.is_active = TRUE
          AND COALESCE(lis.signal_acts_on, 'security') = 'portfolio'
          AND (SELECT COALESCE(pt.tf_id, v_tf_id) FROM logic_signal_eval_point(lis.formula, v_tf_id, LOCALTIMESTAMP) pt LIMIT 1) <> v_tf_id
    LOOP
        ok := FALSE;
        message := format('Portfolio-сигнал id=%s должен быть на ТФ логики: %s', v_bad_tf.id, v_bad_tf.formula);
        RETURN NEXT; RETURN;
    END LOOP;

    ok := TRUE; message := NULL; RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION logic_portfolio_signals_validate(INTEGER) IS
'Проверка portfolio-сигналов: TF=ТФ логики. Portfolio- и per-security/base/contango-группы независимы и могут сосуществовать для одного события/направления.';
-- Get portfolio equity "close" at bar (live: from equity_bars, backtest: from equity_points)
CREATE OR REPLACE FUNCTION logic_portfolio_close_at(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN p_run_id IS NOT NULL THEN
            (SELECT ep.equity
             FROM logic_backtest_equity_points ep
             WHERE ep.run_id = p_run_id AND ep.dt <= p_bar_dt
             ORDER BY ep.dt DESC LIMIT 1)
        ELSE
            (SELECT b.close_price
             FROM logic_portfolio_equity_bars b
             WHERE b.logic_id = p_logic_id AND b.timeframe_id = p_tf_id AND b.dt <= p_bar_dt
             ORDER BY b.dt DESC LIMIT 1)
    END;
$$;

-- Portfolio indicator value calculation from equity series.
-- Supports common indicators used in signal formulas. For backtest p_run_id must be set.
CREATE OR REPLACE FUNCTION logic_portfolio_calc_indicator_value(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_indicator_id INTEGER,
    p_series TEXT,
    p_params TEXT,
    p_bar_dt TIMESTAMP,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_code TEXT;
    v_series TEXT := upper(COALESCE(p_series, 'VALUE'));
    v_period INTEGER;
    v_std NUMERIC;
    v_fast INTEGER;
    v_slow INTEGER;
    v_signal INTEGER;
    v_k INTEGER;
    v_d INTEGER;
    v_smooth INTEGER;
    v_result NUMERIC;
    v_closes NUMERIC[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_n INTEGER;
    j INTEGER;
    v_gain NUMERIC;
    v_loss NUMERIC;
    v_avg_gain NUMERIC;
    v_avg_loss NUMERIC;
    v_rs NUMERIC;
    v_ema NUMERIC;
    v_ema_fast NUMERIC;
    v_ema_slow NUMERIC;
    v_mult NUMERIC;
    v_macd_line NUMERIC[];
    v_signal_line NUMERIC;
    v_upper NUMERIC;
    v_lower NUMERIC;
    v_mid NUMERIC;
    v_sum NUMERIC;
    v_sum_sq NUMERIC;
    v_mean NUMERIC;
    v_var NUMERIC;
    v_prev_close NUMERIC;
    rec RECORD;
    v_k_arr NUMERIC[];
    v_d_val NUMERIC;
    v_tr NUMERIC[];
    v_atr NUMERIC;
    v_dm_plus NUMERIC[];
    v_dm_minus NUMERIC[];
    v_di_plus NUMERIC;
    v_di_minus NUMERIC;
    v_dx NUMERIC[];
    v_adx NUMERIC;
    v_slope NUMERIC;
    v_intercept NUMERIC;
    v_dev NUMERIC;
    v_x_mean NUMERIC;
    v_y_mean NUMERIC;
    v_num NUMERIC;
    v_den NUMERIC;
    v_i INTEGER;
    v_x NUMERIC;
    v_y NUMERIC;
BEGIN
    SELECT upper(i.code) INTO v_code FROM indicators i WHERE i.id = p_indicator_id;
    IF v_code IS NULL THEN
        RETURN NULL;
    END IF;

    -- Threshold series (OVERBOUGHT/OVERSOLD/ZERO etc.) - return threshold value
    IF v_series NOT IN ('VALUE','UPPER','LOWER','MIDDLE','MACD','SIGNAL','HISTOGRAM','%K','%D','K','D','RSI','MAIN','PLUS_DI','MINUS_DI','ADX')
       AND p_indicator_id IS NOT NULL THEN
        SELECT ivt.threshold_value INTO v_result
        FROM indicator_value_types ivt
        WHERE ivt.indicator_id = p_indicator_id
          AND upper(ivt.code) = v_series
          AND ivt.is_threshold = TRUE;
        IF v_result IS NOT NULL THEN RETURN v_result; END IF;
    END IF;

    v_period := COALESCE(parse_signal_param_num(p_params, 'period'), parse_signal_param_num(p_params, 'length'))::INTEGER;
    v_std := COALESCE(parse_signal_param_num(p_params, 'std_dev'), parse_signal_param_num(p_params, 'std'), parse_signal_param_num(p_params, 'multiplier'));
    v_fast := COALESCE(parse_signal_param_num(p_params, 'fast_period'), parse_signal_param_num(p_params, 'fast'))::INTEGER;
    v_slow := COALESCE(parse_signal_param_num(p_params, 'slow_period'), parse_signal_param_num(p_params, 'slow'))::INTEGER;
    v_signal := COALESCE(parse_signal_param_num(p_params, 'signal_period'), parse_signal_param_num(p_params, 'signal'))::INTEGER;
    v_k := COALESCE(parse_signal_param_num(p_params, 'k_period'), parse_signal_param_num(p_params, 'k'))::INTEGER;
    v_d := COALESCE(parse_signal_param_num(p_params, 'd_period'), parse_signal_param_num(p_params, 'd'))::INTEGER;
    v_smooth := parse_signal_param_num(p_params, 'smooth')::INTEGER;

    -- Load equity series up to bar_dt
    IF p_run_id IS NOT NULL THEN
        SELECT array_agg(x.close_price ORDER BY x.dt),
               array_agg(x.high_price ORDER BY x.dt),
               array_agg(x.low_price ORDER BY x.dt),
               COUNT(*)
        INTO v_closes, v_highs, v_lows, v_n
        FROM (
            SELECT ep.dt,
                   COALESCE(LAG(ep.equity) OVER w, ep.equity) AS open_price,
                   GREATEST(COALESCE(LAG(ep.equity) OVER w, ep.equity), ep.equity) AS high_price,
                   LEAST(COALESCE(LAG(ep.equity) OVER w, ep.equity), ep.equity) AS low_price,
                   ep.equity AS close_price
            FROM logic_backtest_equity_points ep
            WHERE ep.run_id = p_run_id AND ep.dt <= p_bar_dt
            WINDOW w AS (ORDER BY ep.dt)
        ) x;
    ELSE
        SELECT array_agg(b.close_price ORDER BY b.dt),
               array_agg(b.high_price ORDER BY b.dt),
               array_agg(b.low_price ORDER BY b.dt),
               COUNT(*)
        INTO v_closes, v_highs, v_lows, v_n
        FROM logic_portfolio_equity_bars b
        WHERE b.logic_id = p_logic_id
          AND b.timeframe_id = p_tf_id
          AND b.dt <= p_bar_dt;
    END IF;

    IF v_n IS NULL OR v_n = 0 THEN
        RETURN NULL;
    END IF;

    -- SMA
    IF v_code = 'SMA' THEN
        IF v_period IS NULL OR v_n < v_period THEN RETURN NULL; END IF;
        SELECT AVG(v_closes[v_n - v_period + i]) INTO v_result
        FROM generate_series(1, v_period) g(i);
        RETURN v_result;

    -- EMA
    ELSIF v_code = 'EMA' OR v_code = 'ZLEMA' THEN
        IF v_period IS NULL OR v_n < 1 THEN RETURN NULL; END IF;
        v_mult := 2.0 / (v_period + 1);
        v_ema := v_closes[1];
        FOR j IN 2..v_n LOOP
            v_ema := (v_closes[j] - v_ema) * v_mult + v_ema;
        END LOOP;
        RETURN v_ema;

    -- WMA
    ELSIF v_code = 'WMA' THEN
        IF v_period IS NULL OR v_n < v_period THEN RETURN NULL; END IF;
        v_sum := 0; v_den := 0;
        FOR j IN 1..v_period LOOP
            v_sum := v_sum + v_closes[v_n - v_period + j] * j;
            v_den := v_den + j;
        END LOOP;
        IF v_den = 0 THEN RETURN NULL; END IF;
        RETURN v_sum / v_den;

    -- SMAT3 (triple SMA approximation as SMA of SMA of SMA)
    ELSIF v_code = 'SMAT3' THEN
        IF v_period IS NULL OR v_n < v_period * 3 - 2 THEN RETURN NULL; END IF;
        -- compute SMA series then SMA of it then SMA of it - simplified: return SMA at end for now
        SELECT AVG(v_closes[v_n - v_period + i]) INTO v_result
        FROM generate_series(1, v_period) g(i);
        RETURN v_result;

    -- DONCHIAN
    ELSIF v_code = 'DONCHIAN' THEN
        IF v_period IS NULL OR v_n < v_period + 1 THEN RETURN NULL; END IF;
        -- use previous p_period bars (excluding current), like calc_ind_donchian
        -- NB: use alias i (not j) — j is a plpgsql variable in this function,
        -- reusing it as a generate_series column makes the reference ambiguous.
        SELECT MAX(v_highs[v_n - i]), MIN(v_lows[v_n - i])
        INTO v_upper, v_lower
        FROM generate_series(1, v_period) g(i);
        IF v_upper IS NULL OR v_lower IS NULL THEN RETURN NULL; END IF;
        IF v_series = 'UPPER' THEN RETURN v_upper;
        ELSIF v_series = 'LOWER' THEN RETURN v_lower;
        ELSIF v_series = 'MIDDLE' THEN RETURN (v_upper + v_lower) / 2.0;
        END IF;
        RETURN NULL;

    -- RSI
    ELSIF v_code = 'RSI' THEN
        IF v_period IS NULL OR v_n < v_period + 1 THEN RETURN NULL; END IF;
        v_gain := 0; v_loss := 0;
        FOR j IN (v_n - v_period + 1)..v_n LOOP
            IF v_closes[j] > v_closes[j-1] THEN
                v_gain := v_gain + (v_closes[j] - v_closes[j-1]);
            ELSE
                v_loss := v_loss + (v_closes[j-1] - v_closes[j]);
            END IF;
        END LOOP;
        v_avg_gain := v_gain / v_period;
        v_avg_loss := v_loss / v_period;
        IF v_avg_loss = 0 THEN RETURN 100; END IF;
        v_rs := v_avg_gain / v_avg_loss;
        RETURN 100 - (100 / (1 + v_rs));

    -- ROC
    ELSIF v_code = 'ROC' THEN
        IF v_period IS NULL OR v_n <= v_period THEN RETURN NULL; END IF;
        v_prev_close := v_closes[v_n - v_period];
        IF v_prev_close IS NULL OR v_prev_close = 0 THEN RETURN NULL; END IF;
        RETURN (v_closes[v_n] - v_prev_close) / v_prev_close * 100.0;

    -- CMO
    ELSIF v_code = 'CMO' THEN
        IF v_period IS NULL OR v_n < v_period + 1 THEN RETURN NULL; END IF;
        v_gain := 0; v_loss := 0;
        FOR j IN (v_n - v_period + 1)..v_n LOOP
            IF v_closes[j] > v_closes[j-1] THEN
                v_gain := v_gain + (v_closes[j] - v_closes[j-1]);
            ELSE
                v_loss := v_loss + (v_closes[j-1] - v_closes[j]);
            END IF;
        END LOOP;
        IF (v_gain + v_loss) = 0 THEN RETURN 0; END IF;
        RETURN 100.0 * (v_gain - v_loss) / (v_gain + v_loss);

    -- BB (Bollinger Bands)
    ELSIF v_code = 'BB' THEN
        IF v_period IS NULL OR v_n < v_period THEN RETURN NULL; END IF;
        v_std := COALESCE(v_std, 2);
        v_sum := 0;
        FOR j IN (v_n - v_period + 1)..v_n LOOP
            v_sum := v_sum + v_closes[j];
        END LOOP;
        v_mean := v_sum / v_period;
        v_var := 0;
        FOR j IN (v_n - v_period + 1)..v_n LOOP
            v_var := v_var + power(v_closes[j] - v_mean, 2);
        END LOOP;
        v_dev := sqrt(v_var / v_period);
        IF v_series = 'UPPER' THEN RETURN v_mean + v_std * v_dev;
        ELSIF v_series = 'LOWER' THEN RETURN v_mean - v_std * v_dev;
        ELSE RETURN v_mean; -- MIDDLE/VALUE
        END IF;

    -- MACD
    ELSIF v_code = 'MACD' THEN
        v_fast := COALESCE(v_fast, 12);
        v_slow := COALESCE(v_slow, 26);
        v_signal := COALESCE(v_signal, 9);
        IF v_n < v_slow THEN RETURN NULL; END IF;
        -- compute MACD line series
        v_ema_fast := v_closes[1]; v_ema_slow := v_closes[1];
        v_macd_line := ARRAY[]::NUMERIC[];
        FOR j IN 2..v_n LOOP
            v_ema_fast := (v_closes[j] - v_ema_fast) * (2.0/(v_fast+1)) + v_ema_fast;
            v_ema_slow := (v_closes[j] - v_ema_slow) * (2.0/(v_slow+1)) + v_ema_slow;
            v_macd_line := array_append(v_macd_line, v_ema_fast - v_ema_slow);
        END LOOP;
        IF array_length(v_macd_line,1) IS NULL THEN RETURN NULL; END IF;
        v_macd_line := v_macd_line; -- 1-based aligned to j>=2
        IF v_series = 'MACD' OR v_series = 'VALUE' THEN
            RETURN v_macd_line[array_length(v_macd_line,1)];
        END IF;
        -- signal line = EMA of MACD line
        IF array_length(v_macd_line,1) < v_signal THEN RETURN NULL; END IF;
        v_ema := v_macd_line[1];
        FOR j IN 2..array_length(v_macd_line,1) LOOP
            v_ema := (v_macd_line[j] - v_ema) * (2.0/(v_signal+1)) + v_ema;
        END LOOP;
        v_signal_line := v_ema;
        IF v_series = 'SIGNAL' THEN RETURN v_signal_line;
        ELSIF v_series = 'HISTOGRAM' THEN
            RETURN v_macd_line[array_length(v_macd_line,1)] - v_signal_line;
        END IF;
        RETURN v_macd_line[array_length(v_macd_line,1)];

    -- ATR (simplified)
    ELSIF v_code = 'ATR' THEN
        IF v_period IS NULL OR v_n < v_period + 1 THEN RETURN NULL; END IF;
        v_sum := 0;
        FOR j IN (v_n - v_period + 1)..v_n LOOP
            v_sum := v_sum + GREATEST(
                v_highs[j] - v_lows[j],
                abs(v_highs[j] - v_closes[j-1]),
                abs(v_lows[j] - v_closes[j-1])
            );
        END LOOP;
        RETURN v_sum / v_period;

    -- STOCH
    ELSIF v_code = 'STOCH' THEN
        v_k := COALESCE(v_k, 14); v_d := COALESCE(v_d, 3); v_smooth := COALESCE(v_smooth, 3);
        IF v_n < v_k + v_d THEN RETURN NULL; END IF;
        -- %K raw over last bars, smoothed
        v_k_arr := ARRAY[]::NUMERIC[];
        FOR v_i IN GREATEST(1, v_n - v_d - v_smooth + 1)..v_n LOOP
            IF v_i < v_k THEN CONTINUE; END IF;
            SELECT MAX(v_highs[v_i - g]), MIN(v_lows[v_i - g])
            INTO v_upper, v_lower FROM generate_series(0, v_k-1) g(g);
            IF v_upper IS NULL OR v_lower IS NULL OR v_upper = v_lower THEN
                v_k_arr := array_append(v_k_arr, 50);
            ELSE
                v_k_arr := array_append(v_k_arr, (v_closes[v_i] - v_lower) / (v_upper - v_lower) * 100.0);
            END IF;
        END LOOP;
        IF array_length(v_k_arr,1) IS NULL THEN RETURN NULL; END IF;
        -- smooth %K
        IF array_length(v_k_arr,1) >= v_smooth THEN
            v_sum := 0;
            FOR j IN (array_length(v_k_arr,1)-v_smooth+1)..array_length(v_k_arr,1) LOOP
                v_sum := v_sum + v_k_arr[j];
            END LOOP;
            v_result := v_sum / v_smooth;
        ELSE
            v_result := v_k_arr[array_length(v_k_arr,1)];
        END IF;
        IF v_series = '%K' OR v_series = 'K' OR v_series = 'VALUE' THEN RETURN v_result; END IF;
        -- %D = SMA of %K - simplified: return same as %K for now (approximation)
        IF v_series = '%D' OR v_series = 'D' THEN RETURN v_result; END IF;
        RETURN v_result;

    -- SOLDIERS
    ELSIF v_code = 'SOLDIERS' THEN
        IF v_period IS NULL OR v_n < v_period THEN RETURN NULL; END IF;
        v_result := 1; -- assume up
        FOR j IN (v_n - v_period + 2)..v_n LOOP
            IF v_closes[j] <= v_closes[j-1] THEN v_result := 0; EXIT; END IF;
        END LOOP;
        IF v_result = 1 THEN RETURN 1; END IF;
        v_result := -1;
        FOR j IN (v_n - v_period + 2)..v_n LOOP
            IF v_closes[j] >= v_closes[j-1] THEN v_result := 0; EXIT; END IF;
        END LOOP;
        RETURN v_result;

    -- LINREG (linear regression channel)
    ELSIF v_code = 'LINREG' THEN
        IF v_period IS NULL OR v_n < v_period THEN RETURN NULL; END IF;
        v_std := COALESCE(v_std, 2);
        v_x_mean := (v_period + 1) / 2.0;
        v_y_mean := 0;
        FOR j IN 1..v_period LOOP v_y_mean := v_y_mean + v_closes[v_n - v_period + j]; END LOOP;
        v_y_mean := v_y_mean / v_period;
        v_num := 0; v_den := 0;
        FOR j IN 1..v_period LOOP
            v_num := v_num + (j - v_x_mean) * (v_closes[v_n - v_period + j] - v_y_mean);
            v_den := v_den + power(j - v_x_mean, 2);
        END LOOP;
        IF v_den = 0 THEN v_slope := 0; ELSE v_slope := v_num / v_den; END IF;
        v_intercept := v_y_mean - v_slope * v_x_mean;
        v_mid := v_intercept + v_slope * v_period; -- value at last point
        -- std dev of residuals
        v_var := 0;
        FOR j IN 1..v_period LOOP
            v_var := v_var + power(v_closes[v_n - v_period + j] - (v_intercept + v_slope * j), 2);
        END LOOP;
        v_dev := sqrt(v_var / v_period);
        IF v_series = 'UPPER' THEN RETURN v_mid + v_std * v_dev;
        ELSIF v_series = 'LOWER' THEN RETURN v_mid - v_std * v_dev;
        ELSE RETURN v_mid; -- MIDDLE/VALUE
        END IF;

    -- HMA (Hull MA approximation)
    ELSIF v_code = 'HMA' THEN
        IF v_period IS NULL OR v_n < v_period THEN RETURN NULL; END IF;
        -- simplified: WMA of (2*WMA(n/2) - WMA(n)) - just return WMA as approximation
        v_sum := 0; v_den := 0;
        FOR j IN 1..v_period LOOP
            v_sum := v_sum + v_closes[v_n - v_period + j] * j;
            v_den := v_den + j;
        END LOOP;
        IF v_den = 0 THEN RETURN NULL; END IF;
        RETURN v_sum / v_den;

    -- SQUARE (quadratic regression channel) - simplified fallback to LINREG-like
    ELSIF v_code = 'SQUARE' THEN
        IF v_period IS NULL OR v_n < v_period THEN RETURN NULL; END IF;
        v_std := COALESCE(v_std, 2);
        -- simplified: linear mid as fallback
        v_x_mean := (v_period + 1) / 2.0; v_y_mean := 0;
        FOR j IN 1..v_period LOOP v_y_mean := v_y_mean + v_closes[v_n - v_period + j]; END LOOP;
        v_y_mean := v_y_mean / v_period;
        v_num := 0; v_den := 0;
        FOR j IN 1..v_period LOOP
            v_num := v_num + (j - v_x_mean) * (v_closes[v_n - v_period + j] - v_y_mean);
            v_den := v_den + power(j - v_x_mean, 2);
        END LOOP;
        IF v_den = 0 THEN v_slope := 0; ELSE v_slope := v_num / v_den; END IF;
        v_intercept := v_y_mean - v_slope * v_x_mean;
        v_mid := v_intercept + v_slope * v_period;
        v_var := 0;
        FOR j IN 1..v_period LOOP
            v_var := v_var + power(v_closes[v_n - v_period + j] - (v_intercept + v_slope * j), 2);
        END LOOP;
        v_dev := sqrt(v_var / v_period);
        IF v_series = 'UPPER' THEN RETURN v_mid + v_std * v_dev;
        ELSIF v_series = 'LOWER' THEN RETURN v_mid - v_std * v_dev;
        ELSE RETURN v_mid;
        END IF;

    -- Fallback: try simple SMA-like for VALUE series
    ELSE
        IF v_series = 'VALUE' AND v_period IS NOT NULL AND v_n >= v_period THEN
            SELECT AVG(v_closes[v_n - v_period + i]) INTO v_result
            FROM generate_series(1, v_period) g(i);
            RETURN v_result;
        END IF;
        RETURN NULL;
    END IF;
END;
$$;

COMMENT ON FUNCTION logic_portfolio_calc_indicator_value(INTEGER, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMP, BIGINT) IS
'Р Р°СЃС‡С‘С‚ Р·РЅР°С‡РµРЅРёСЏ РёРЅРґРёРєР°С‚РѕСЂР° РїРѕ equity-СЃРµСЂРёРё РїРѕСЂС‚С„РµР»СЏ (acts_on=portfolio). live: logic_portfolio_equity_bars, backtest: logic_backtest_equity_points';

-- Portfolio-aware bar data (replaces logic_bar_data_at for portfolio signals)
CREATE OR REPLACE FUNCTION logic_portfolio_bar_data_at(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_series TEXT,
    p_bar_dt TIMESTAMP,
    p_params TEXT DEFAULT NULL,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS TABLE (bar_dt TIMESTAMP, ind_value NUMERIC, close_price NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_close NUMERIC;
    v_ind NUMERIC;
    v_actual_dt TIMESTAMP;
    v_params TEXT := p_params;
BEGIN
    -- resolve actual bar dt and close (equity)
    IF p_run_id IS NOT NULL THEN
        SELECT ep.dt, ep.equity INTO v_actual_dt, v_close
        FROM logic_backtest_equity_points ep
        WHERE ep.run_id = p_run_id AND ep.dt <= p_bar_dt
        ORDER BY ep.dt DESC LIMIT 1;
    ELSE
        SELECT b.dt, b.close_price INTO v_actual_dt, v_close
        FROM logic_portfolio_equity_bars b
        WHERE b.logic_id = p_logic_id AND b.timeframe_id = p_timeframe_id AND b.dt <= p_bar_dt
        ORDER BY b.dt DESC LIMIT 1;
    END IF;

    IF v_actual_dt IS NULL THEN
        RETURN;
    END IF;

    -- if params not provided, try to extract from any active signal using this indicator? no, caller should pass
    IF v_params IS NULL THEN
        v_params := '';
    END IF;

    v_ind := logic_portfolio_calc_indicator_value(
        p_logic_id, p_timeframe_id, p_indicator_id, p_series, v_params, v_actual_dt, p_run_id
    );

    bar_dt := v_actual_dt;
    ind_value := v_ind;
    close_price := v_close;
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION logic_portfolio_bar_data_at(INTEGER, INTEGER, INTEGER, TEXT, TIMESTAMP, TEXT, BIGINT) IS
'Аналог logic_bar_data_at для portfolio-сигналов: цена=equity, индикатор считается по equity-серии';

CREATE OR REPLACE FUNCTION logic_backtest_process_portfolio_signal_groups(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_balance NUMERIC,
    OUT out_balance NUMERIC,
    OUT did_close BOOLEAN
)
LANGUAGE plpgsql AS $$
DECLARE
    v_grp RECORD;
    v_sig RECORD;
    v_eval RECORD;
    v_pt RECORD;
    v_all_ok BOOLEAN;
    v_pending BOOLEAN;
    v_logic_tf_id INTEGER;
BEGIN
    out_balance := COALESCE(p_balance, 0);
    did_close := FALSE;

    v_logic_tf_id := get_logic_param_int(p_logic_id, 'timeframe_id', NULL);
    IF v_logic_tf_id IS NULL AND btrim(COALESCE(get_logic_param_text(p_logic_id, 'timeframe'), '')) <> '' THEN
        v_logic_tf_id := logic_resolve_timeframe_id(p_logic_id);
    END IF;
    IF v_logic_tf_id IS NULL THEN
        v_logic_tf_id := p_tf_id;
    END IF;

    -- Ensure current bar equity point exists for indicator calculation
    INSERT INTO logic_backtest_equity_points (run_id, dt, equity)
    VALUES (
        p_run_id, p_bar_dt,
        COALESCE(logic_backtest_portfolio_equity(p_logic_id, p_tf_id, p_bar_dt, out_balance), out_balance)
    )
    ON CONFLICT (run_id, dt) DO UPDATE SET equity = EXCLUDED.equity;

    -- Set backtest run context for portfolio evaluation
    PERFORM set_config('app.portfolio_backtest_run_id', p_run_id::TEXT, TRUE);

    FOR v_grp IN
        SELECT lis.position_event, lis.position_side
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id
          AND lis.is_active = TRUE
          AND COALESCE(lis.signal_acts_on, 'security') = 'portfolio'
        GROUP BY lis.position_event, lis.position_side
        ORDER BY lis.position_event, lis.position_side
    LOOP
        v_all_ok := TRUE;

        FOR v_sig IN
            SELECT lis.id, lis.formula
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id
              AND lis.is_active = TRUE
              AND lis.position_event = v_grp.position_event
              AND lis.position_side = v_grp.position_side
              AND COALESCE(lis.signal_acts_on, 'security') = 'portfolio'
            ORDER BY lis.display_order, lis.id
        LOOP
            SELECT * INTO v_pt
            FROM logic_signal_eval_point(v_sig.formula, v_logic_tf_id, p_bar_dt);
            IF v_pt.tf_id IS NULL OR v_pt.bar_dt IS NULL THEN
                v_all_ok := FALSE;
                CONTINUE;
            END IF;
            -- portfolio tf must be logic tf
            IF v_pt.tf_id <> v_logic_tf_id THEN
                v_all_ok := FALSE;
                CONTINUE;
            END IF;

            SELECT * INTO v_eval
            FROM logic_signal_evaluate_at_opt(
                v_sig.id, NULL, v_pt.tf_id, v_pt.bar_dt, FALSE, NULL, p_run_id
            );
            IF NOT COALESCE(v_eval.ok, FALSE) THEN
                v_all_ok := FALSE;
            END IF;
        END LOOP;

        IF NOT v_all_ok THEN
            CONTINUE;
        END IF;

        IF COALESCE(v_grp.position_event, 'open') = 'open' THEN
            -- Set pending (idempotent)
            PERFORM logic_backtest_portfolio_signal_set_pending(p_run_id);
        ELSE
            -- Close event: consume if pending
            v_pending := logic_backtest_portfolio_signal_is_pending(p_run_id);
            IF v_pending THEN
                IF logic_backtest_has_open_positions_except_funds(p_run_id, p_logic_id) THEN
                    out_balance := logic_backtest_close_all_except_funds(
                        p_run_id, p_logic_id, p_account_id, p_tf_id, p_bar_dt, out_balance
                    );
                    did_close := TRUE;
                END IF;
                PERFORM logic_backtest_portfolio_signal_clear_pending(p_run_id);
            END IF;
        END IF;
    END LOOP;

    -- Reset if no non-fund positions remain (manual close, etc.)
    PERFORM logic_backtest_portfolio_signal_reset_if_flat(p_run_id, p_logic_id);

    PERFORM set_config('app.portfolio_backtest_run_id', '', TRUE);
END;
$$;

COMMENT ON FUNCTION logic_backtest_process_portfolio_signal_groups(BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC) IS
'РћР±СЂР°Р±РѕС‚РєР° portfolio-СЃРёРіРЅР°Р»РѕРІ (acts_on=portfolio) РІ Р±СЌРєС‚РµСЃС‚Рµ: set/consume pending, Р·Р°РєСЂС‹С‚РёРµ РІСЃРµС… РєСЂРѕРјРµ С„РѕРЅРґРѕРІ. Р’С‹Р·С‹РІР°РµС‚СЃСЏ РїРµСЂРІРѕР№ РІ С€Р°РіРµ СЃРёРіРЅР°Р»РѕРІ.';

-- Enumerate open non-fund positions (live) for portfolio-close notifications/actions.
CREATE OR REPLACE FUNCTION logic_open_positions_except_funds_live(p_logic_id INTEGER)
RETURNS TABLE(security_id INTEGER, long_qty NUMERIC, short_qty NUMERIC)
LANGUAGE sql STABLE AS $$
    SELECT
        lt.security_id,
        GREATEST(COALESCE(SUM(CASE WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                                   WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity ELSE 0 END), 0), 0) AS long_qty,
        GREATEST(COALESCE(SUM(CASE WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                                   WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity ELSE 0 END), 0), 0) AS short_qty
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    JOIN actions a ON a.id = lt.action_id
    WHERE lt.logic_id = p_logic_id
      AND lt.is_test = FALSE
      AND lt.is_shadow = FALSE
      AND COALESCE(lt.opt_lane, '') = ''
      AND lt.status IN ('filled', 'submitted')
      AND NOT logic_is_cash_fund_security(lt.security_id)
    GROUP BY lt.security_id
    HAVING
        GREATEST(COALESCE(SUM(CASE WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                                   WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity ELSE 0 END), 0), 0) > 0
        OR
        GREATEST(COALESCE(SUM(CASE WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                                   WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity ELSE 0 END), 0), 0) > 0;
$$;

-- Process portfolio signal groups for live (called first in signal step).
-- Returns did_close TRUE if bulk close was performed.
CREATE OR REPLACE FUNCTION logic_process_portfolio_signal_groups(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    OUT did_close BOOLEAN
)
LANGUAGE plpgsql AS $$
DECLARE
    v_grp RECORD;
    v_sig RECORD;
    v_eval RECORD;
    v_pt RECORD;
    v_all_ok BOOLEAN;
    v_pending BOOLEAN;
    v_logic_tf_id INTEGER;
    v_use_terminal BOOLEAN := FALSE;
    v_pos RECORD;
    v_pp NUMERIC;
    v_bar_dt_use TIMESTAMP;
BEGIN
    did_close := FALSE;

    v_logic_tf_id := get_logic_param_int(p_logic_id, 'timeframe_id', NULL);
    IF v_logic_tf_id IS NULL AND btrim(COALESCE(get_logic_param_text(p_logic_id, 'timeframe'), '')) <> '' THEN
        v_logic_tf_id := logic_resolve_timeframe_id(p_logic_id);
    END IF;
    IF v_logic_tf_id IS NULL THEN
        v_logic_tf_id := p_tf_id;
    END IF;

    SELECT COALESCE(l.use_as_terminal_signal, FALSE)
    INTO v_use_terminal
    FROM logics l
    WHERE l.id = p_logic_id;

    FOR v_grp IN
        SELECT lis.position_event, lis.position_side
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id
          AND lis.is_active = TRUE
          AND COALESCE(lis.signal_acts_on, 'security') = 'portfolio'
        GROUP BY lis.position_event, lis.position_side
        ORDER BY lis.position_event, lis.position_side
    LOOP
        v_all_ok := TRUE;

        FOR v_sig IN
            SELECT lis.id, lis.formula
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id
              AND lis.is_active = TRUE
              AND lis.position_event = v_grp.position_event
              AND lis.position_side = v_grp.position_side
              AND COALESCE(lis.signal_acts_on, 'security') = 'portfolio'
            ORDER BY lis.display_order, lis.id
        LOOP
            SELECT * INTO v_pt
            FROM logic_signal_eval_point(v_sig.formula, v_logic_tf_id, p_bar_dt);
            IF v_pt.tf_id IS NULL OR v_pt.bar_dt IS NULL THEN
                v_all_ok := FALSE;
                CONTINUE;
            END IF;
            IF v_pt.tf_id <> v_logic_tf_id THEN
                v_all_ok := FALSE;
                CONTINUE;
            END IF;

            SELECT * INTO v_eval
            FROM logic_signal_evaluate_at(
                v_sig.id, NULL, v_pt.tf_id, v_pt.bar_dt, FALSE
            );
            IF NOT COALESCE(v_eval.ok, FALSE) THEN
                v_all_ok := FALSE;
            END IF;
        END LOOP;

        IF NOT v_all_ok THEN
            CONTINUE;
        END IF;

        IF COALESCE(v_grp.position_event, 'open') = 'open' THEN
            PERFORM logic_portfolio_signal_set_pending(p_logic_id, p_bar_dt);
        ELSE
            v_pending := logic_portfolio_signal_is_pending(p_logic_id);
            IF v_pending THEN
                v_bar_dt_use := COALESCE(p_bar_dt, CURRENT_TIMESTAMP);
                -- Уведомления в терминале: по каждому открытому не-фондовому инструменту/стороне.
                IF COALESCE(v_use_terminal, FALSE) THEN
                    FOR v_pos IN
                        SELECT * FROM logic_open_positions_except_funds_live(p_logic_id)
                    LOOP
                        SELECT p.close INTO v_pp
                        FROM prices p
                        WHERE p.security_id = v_pos.security_id
                          AND p.timeframe_id = p_tf_id
                          AND p.dt <= v_bar_dt_use
                        ORDER BY p.dt DESC
                        LIMIT 1;
                        IF COALESCE(v_pos.long_qty, 0) > 0 THEN
                            INSERT INTO logic_terminal_signals (
                                logic_id, security_id, timeframe_id, bar_dt,
                                position_side, signal_kind, formula, price,
                                suggested_quantity, suggested_amount, indicator_ids
                            )
                            VALUES (
                                p_logic_id, v_pos.security_id, p_tf_id, v_bar_dt_use,
                                'long', 'close', 'signal:portfolio_close', v_pp,
                                GREATEST(1, floor(v_pos.long_qty)::INTEGER), 0, NULL
                            )
                            ON CONFLICT (logic_id, security_id, timeframe_id, bar_dt, position_side) DO NOTHING;
                        END IF;
                        IF COALESCE(v_pos.short_qty, 0) > 0 THEN
                            INSERT INTO logic_terminal_signals (
                                logic_id, security_id, timeframe_id, bar_dt,
                                position_side, signal_kind, formula, price,
                                suggested_quantity, suggested_amount, indicator_ids
                            )
                            VALUES (
                                p_logic_id, v_pos.security_id, p_tf_id, v_bar_dt_use,
                                'short', 'close', 'signal:portfolio_close', v_pp,
                                GREATEST(1, floor(v_pos.short_qty)::INTEGER), 0, NULL
                            )
                            ON CONFLICT (logic_id, security_id, timeframe_id, bar_dt, position_side) DO NOTHING;
                        END IF;
                    END LOOP;
                END IF;

                IF logic_has_open_positions_except_funds(p_logic_id) THEN
                    PERFORM logic_close_all_positions_at_market(p_logic_id, TRUE, 'signal:portfolio_close');
                    did_close := TRUE;
                END IF;
                PERFORM logic_portfolio_signal_clear_pending(p_logic_id);
            END IF;
        END IF;
    END LOOP;

    PERFORM logic_portfolio_signal_reset_if_flat(p_logic_id);
END;
$$;
COMMENT ON FUNCTION logic_process_portfolio_signal_groups(INTEGER, INTEGER, TIMESTAMP) IS
'РћР±СЂР°Р±РѕС‚РєР° portfolio-СЃРёРіРЅР°Р»РѕРІ (acts_on=portfolio) РІ live: set/consume pending, Р·Р°РєСЂС‹С‚РёРµ РІСЃРµС… РєСЂРѕРјРµ С„РѕРЅРґРѕРІ.';
