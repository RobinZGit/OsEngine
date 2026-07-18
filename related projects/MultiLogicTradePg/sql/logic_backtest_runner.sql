-- ============================================
-- Historical backtest runner (is_test=TRUE book)
-- ============================================

CREATE OR REPLACE FUNCTION logic_backtest_price_at(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT p.close_price
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt = p_bar_dt
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_log(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_operation TEXT,
    p_message TEXT,
    p_payload JSONB DEFAULT NULL,
    p_security_id INTEGER DEFAULT NULL,
    p_timeframe_id INTEGER DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO app_tech_log (
        trace_id, span_id, thread_key, source, operation, phase,
        message, logic_id, security_id, timeframe_id, payload
    ) VALUES (
        gen_random_uuid(),
        replace(gen_random_uuid()::TEXT, '-', ''),
        format('logic:%s:backtest:%s', COALESCE(p_logic_id, 0), COALESCE(p_run_id, 0)),
        'backtest',
        btrim(p_operation),
        'event',
        p_message,
        p_logic_id,
        p_security_id,
        p_timeframe_id,
        COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('run_id', p_run_id)
    );
END;
$$;

COMMENT ON FUNCTION logic_backtest_log(BIGINT, INTEGER, TEXT, TEXT, JSONB, INTEGER, INTEGER) IS
'Журнал backtest в app_tech_log (milestone: start/progress/done/error; не на каждую сделку)';

CREATE OR REPLACE FUNCTION logic_backtest_diagnose(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_prices INTEGER;
    v_indicators INTEGER;
    v_bars INTEGER;
    v_securities INTEGER;
    v_signals INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_securities
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE;

    SELECT COUNT(*)::INTEGER INTO v_signals
    FROM logic_indicator_signals lis
    WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE;

    SELECT COUNT(*)::INTEGER INTO v_prices
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = p_tf_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to;

    SELECT COUNT(*)::INTEGER INTO v_indicators
    FROM indicator_values iv
    JOIN logic_securities ls ON ls.security_id = iv.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND iv.timeframe_id = p_tf_id
      AND iv.dt::date BETWEEN p_date_from AND p_date_to;

    SELECT COUNT(DISTINCT p.dt)::INTEGER INTO v_bars
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = p_tf_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to;

    RETURN jsonb_build_object(
        'run_id', p_run_id,
        'securities', v_securities,
        'signals', v_signals,
        'prices_in_period', v_prices,
        'indicator_values_in_period', v_indicators,
        'distinct_bars', v_bars,
        'securities_detail', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'security_id', ls.security_id,
                'name', s.name,
                'prices_in_period', (
                    SELECT COUNT(*)::INTEGER FROM prices p
                    WHERE p.security_id = ls.security_id
                      AND p.timeframe_id = p_tf_id
                      AND p.dt::date BETWEEN p_date_from AND p_date_to
                ),
                'indicators_in_period', (
                    SELECT COUNT(*)::INTEGER FROM indicator_values iv
                    WHERE iv.security_id = ls.security_id
                      AND iv.timeframe_id = p_tf_id
                      AND iv.dt::date BETWEEN p_date_from AND p_date_to
                ),
                'test_trades', (
                    SELECT COUNT(*)::INTEGER FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE
                      AND lt.security_id = ls.security_id
                )
            ) ORDER BY ls.display_order, ls.id), '[]'::jsonb)
            FROM logic_securities ls
            JOIN securities s ON s.id = ls.security_id
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION backtest_prices_cached(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_warmup_from DATE,
    p_date_from DATE,
    p_date_to DATE,
    p_min_warmup INTEGER DEFAULT 20
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf_sec INTEGER;
    v_span_days INTEGER;
    v_in_period INTEGER;
    v_warmup_count INTEGER;
    v_min_date DATE;
    v_max_date DATE;
    v_edge_slack INTEGER;
    v_min_bars INTEGER;
    v_date_to DATE;
BEGIN
    IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
        RETURN FALSE;
    END IF;

    -- Будущие даты в date_to недостижимы для рынка — иначе вечный re-fetch T-Bank.
    v_date_to := LEAST(p_date_to, CURRENT_DATE);
    IF p_date_from > v_date_to THEN
        RETURN FALSE;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;
    v_tf_sec := COALESCE(v_tf_sec, 86400);
    v_span_days := GREATEST(1, (v_date_to - p_date_from) + 1);
    v_edge_slack := GREATEST(3, LEAST(14, v_span_days / 20));

    SELECT COUNT(*)::INTEGER, MIN(p.dt::date), MAX(p.dt::date)
    INTO v_in_period, v_min_date, v_max_date
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt::date BETWEEN p_date_from AND v_date_to;

    IF v_in_period = 0 OR v_min_date IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_min_date > p_date_from + v_edge_slack THEN
        RETURN FALSE;
    END IF;
    IF v_max_date < v_date_to - v_edge_slack THEN
        RETURN FALSE;
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_warmup_count
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt::date BETWEEN p_warmup_from AND v_date_to;

    IF v_warmup_count < GREATEST(p_min_warmup, 1) THEN
        RETURN FALSE;
    END IF;

    IF v_tf_sec >= 86400 THEN
        v_min_bars := GREATEST(5, (v_span_days * 2) / 5);
    ELSE
        v_min_bars := GREATEST(
            p_min_warmup,
            GREATEST(20, (v_span_days * 8 * 3600 / v_tf_sec / 4)::INTEGER)
        );
    END IF;

    RETURN v_in_period >= v_min_bars;
END;
$$;

COMMENT ON FUNCTION backtest_prices_cached(INTEGER, INTEGER, DATE, DATE, DATE, INTEGER) IS
'True если свечи покрывают период теста до LEAST(date_to, сегодня); иначе load_prices. Будущий date_to не форсит HTTP.';

CREATE OR REPLACE FUNCTION backtest_indicators_cached(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM indicator_values iv
        WHERE iv.security_id = p_security_id
          AND iv.timeframe_id = p_timeframe_id
          AND iv.indicator_id = p_indicator_id
          AND iv.dt::date BETWEEN p_date_from AND p_date_to
        LIMIT 1
    );
$$;

COMMENT ON FUNCTION backtest_indicators_cached(INTEGER, INTEGER, INTEGER, DATE, DATE) IS
'True если индикатор уже рассчитан на периоде теста';

CREATE OR REPLACE PROCEDURE logic_backtest_ensure_security_data(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_warmup_from DATE,
    p_date_from DATE,
    p_date_to DATE,
    p_end_dt TIMESTAMP,
    p_point_count INTEGER,
    p_prices_loaded OUT INTEGER,
    p_prices_cached OUT INTEGER,
    p_ind_synced OUT INTEGER,
    p_ind_cached OUT INTEGER,
    p_ind_errors OUT INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_ind RECORD;
    v_need_prices BOOLEAN;
BEGIN
    p_prices_loaded := 0;
    p_prices_cached := 0;
    p_ind_synced := 0;
    p_ind_cached := 0;
    p_ind_errors := 0;

    v_need_prices := NOT backtest_prices_cached(
        p_security_id, p_tf_id, p_warmup_from, p_date_from, p_date_to, 20
    );

    IF v_need_prices THEN
        BEGIN
            CALL load_prices(p_security_id, p_tf_id, p_warmup_from, p_date_to);
            p_prices_loaded := 1;
        EXCEPTION WHEN OTHERS THEN
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.prices.error', SQLERRM,
                jsonb_build_object('security_id', p_security_id),
                p_security_id, p_tf_id
            );
            RETURN;
        END;
    ELSE
        p_prices_cached := 1;
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.prices.cached',
            format('Кэш цен sec=%s (%s — %s)', p_security_id, p_warmup_from, p_date_to),
            jsonb_build_object('security_id', p_security_id),
            p_security_id, p_tf_id
        );
    END IF;

    FOR v_ind IN
        SELECT DISTINCT lis.indicator_id
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
    LOOP
        IF NOT v_need_prices AND backtest_indicators_cached(
            p_security_id, p_tf_id, v_ind.indicator_id, p_date_from, p_date_to
        ) THEN
            p_ind_cached := p_ind_cached + 1;
            CONTINUE;
        END IF;
        BEGIN
            CALL ensure_security_indicator_series(p_security_id, v_ind.indicator_id);
            CALL logic_apply_indicator_params_from_signals(p_logic_id, p_security_id);
            CALL sync_security_indicator_series_for_indicator(
                p_security_id, v_ind.indicator_id, p_tf_id, p_end_dt, p_point_count, FALSE
            );
            p_ind_synced := p_ind_synced + 1;
        EXCEPTION WHEN OTHERS THEN
            p_ind_errors := p_ind_errors + 1;
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.indicator.error', SQLERRM,
                jsonb_build_object('security_id', p_security_id, 'indicator_id', v_ind.indicator_id),
                p_security_id, p_tf_id
            );
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_backtest_ensure_security_data IS
'Backtest: load_prices только если нет кэша; sync индикаторов по активным сигналам логики';

CREATE OR REPLACE FUNCTION logic_backtest_update_run(
    p_run_id BIGINT,
    p_status TEXT DEFAULT NULL,
    p_progress_pct NUMERIC DEFAULT NULL,
    p_phase_message TEXT DEFAULT NULL,
    p_phase_detail TEXT DEFAULT NULL,
    p_current_bar_dt TIMESTAMP DEFAULT NULL,
    p_processed_bars INTEGER DEFAULT NULL,
    p_trades_created INTEGER DEFAULT NULL,
    p_test_balance NUMERIC DEFAULT NULL,
    p_financial_result NUMERIC DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE logic_backtest_runs r
    SET status = COALESCE(p_status, r.status),
        progress_pct = COALESCE(p_progress_pct, r.progress_pct),
        phase_message = COALESCE(p_phase_message, r.phase_message),
        phase_detail = COALESCE(p_phase_detail, r.phase_detail),
        current_bar_dt = COALESCE(p_current_bar_dt, r.current_bar_dt),
        processed_bars = COALESCE(p_processed_bars, r.processed_bars),
        trades_created = COALESCE(p_trades_created, r.trades_created),
        test_balance = COALESCE(p_test_balance, r.test_balance),
        financial_result = COALESCE(p_financial_result, r.financial_result),
        error_message = COALESCE(p_error_message, r.error_message),
        finished_at = CASE
            WHEN p_status IN ('completed', 'cancelled', 'failed') THEN CURRENT_TIMESTAMP
            ELSE r.finished_at
        END
    WHERE r.id = p_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_cancel_requested(p_run_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT cancel_requested FROM logic_backtest_runs WHERE id = p_run_id),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION logic_backtest_sec_shadow(
    p_run_id BIGINT,
    p_security_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT real_trading_paused FROM logic_backtest_security_state
         WHERE run_id = p_run_id AND security_id = p_security_id),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION logic_backtest_sec_inverted(
    p_run_id BIGINT,
    p_security_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT real_trading_inverted FROM logic_backtest_security_state
         WHERE run_id = p_run_id AND security_id = p_security_id),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION logic_backtest_count_open_positions(
    p_logic_id INTEGER,
    p_is_shadow BOOLEAN
)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT COUNT(*)::INTEGER FROM (
        SELECT lt.security_id
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND lt.status IN ('filled', 'submitted')
        GROUP BY lt.security_id
        HAVING COALESCE(SUM(
            CASE
                WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
                ELSE 0
            END
        ), 0) > 0
    ) q;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_insert_trade(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_side_id INTEGER,
    p_action_id INTEGER,
    p_signal_kind TEXT,
    p_formula TEXT,
    p_quantity INTEGER,
    p_price NUMERIC,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN,
    p_trade_reason TEXT,
    p_balance NUMERIC,
    p_position_event TEXT DEFAULT NULL,
    OUT o_trade_id BIGINT,
    OUT o_new_balance NUMERIC
)
LANGUAGE plpgsql AS $$
DECLARE
    v_side_name TEXT;
    v_action_name TEXT;
    v_notional NUMERIC;
    v_trade_id BIGINT;
    v_balance NUMERIC := p_balance;
    v_position_event TEXT;
BEGIN
    SELECT sd.name INTO v_side_name FROM sides sd WHERE sd.id = p_side_id;
    v_position_event := COALESCE(
        NULLIF(btrim(p_position_event), ''),
        CASE WHEN v_side_name = 'Close' THEN 'close' ELSE 'open' END
    );

    INSERT INTO logic_trades (
        logic_id, account_id, security_id, timeframe_id,
        side_id, action_id, position_event, signal_kind, signal_formula,
        quantity, price, bar_dt, is_simulated, is_fictitious,
        is_shadow, is_test, run_id, trade_reason, status
    )
    VALUES (
        p_logic_id, p_account_id, p_security_id, p_timeframe_id,
        p_side_id, p_action_id, v_position_event, p_signal_kind, p_formula,
        p_quantity, p_price, p_bar_dt, TRUE, FALSE,
        p_is_shadow, TRUE, p_run_id, p_trade_reason, 'filled'
    )
    ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow) DO NOTHING
    RETURNING id INTO v_trade_id;

    IF v_trade_id IS NULL THEN
        o_trade_id := NULL;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    v_balance := logic_trade_finalize(v_trade_id, v_balance);

    SELECT sd.name, ac.name INTO v_side_name, v_action_name
    FROM sides sd, actions ac
    WHERE sd.id = p_side_id AND ac.id = p_action_id;

    v_notional := p_quantity * p_price;
    IF v_side_name = 'Open' AND v_action_name = 'Long' THEN
        v_balance := v_balance - v_notional;
    ELSIF v_side_name = 'Open' AND v_action_name = 'Short' THEN
        v_balance := v_balance + v_notional;
    ELSIF v_side_name = 'Close' AND v_action_name = 'Long' THEN
        v_balance := v_balance + v_notional;
    ELSIF v_side_name = 'Close' AND v_action_name = 'Short' THEN
        v_balance := v_balance - v_notional;
    END IF;

    UPDATE logic_backtest_runs
    SET trades_created = trades_created + 1
    WHERE id = p_run_id;

    o_trade_id := v_trade_id;
    o_new_balance := v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_close_security(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN,
    p_trade_reason TEXT,
    p_balance NUMERIC,
    OUT o_closed INTEGER,
    OUT o_new_balance NUMERIC
)
LANGUAGE plpgsql AS $$
DECLARE
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_price NUMERIC;
    v_quantity INTEGER;
    v_trade_id BIGINT;
    v_closed INTEGER := 0;
    v_balance NUMERIC := p_balance;
BEGIN
    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        o_closed := 0;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);

    IF v_long_qty >= 1 THEN
        v_quantity := floor(v_long_qty)::INTEGER;
        SELECT *
        INTO v_trade_id, v_balance
        FROM logic_backtest_insert_trade(
            p_run_id, p_logic_id, p_account_id, p_security_id, p_timeframe_id,
            v_side_close_id, v_action_long_id, 'counter', 'backtest:close',
            v_quantity, v_price, p_bar_dt, p_is_shadow, p_trade_reason, v_balance
        );
        IF v_trade_id IS NOT NULL THEN
            v_closed := v_closed + 1;
        END IF;
    END IF;

    IF v_short_qty >= 1 THEN
        v_quantity := floor(v_short_qty)::INTEGER;
        SELECT *
        INTO v_trade_id, v_balance
        FROM logic_backtest_insert_trade(
            p_run_id, p_logic_id, p_account_id, p_security_id, p_timeframe_id,
            v_side_close_id, v_action_short_id, 'counter', 'backtest:close',
            v_quantity, v_price, p_bar_dt, p_is_shadow, p_trade_reason, v_balance
        );
        IF v_trade_id IS NOT NULL THEN
            v_closed := v_closed + 1;
        END IF;
    END IF;

    o_closed := v_closed;
    o_new_balance := v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_security_drawdown_pct(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_price NUMERIC;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
    v_loss NUMERIC := 0;
    v_base NUMERIC := 0;
BEGIN
    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;
    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);
    IF v_long_qty <= 0 AND v_short_qty <= 0 THEN
        RETURN 0;
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price, a.name AS action_name
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND s.name = 'Open'
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        v_base := v_base + v_rem * v_open.price;
        IF v_open.action_name = 'Long' AND v_open.price > v_price THEN
            v_loss := v_loss + v_rem * (v_open.price - v_price);
        ELSIF v_open.action_name = 'Short' AND v_price > v_open.price THEN
            v_loss := v_loss + v_rem * (v_price - v_open.price);
        END IF;
    END LOOP;

    IF v_base <= 0 THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(v_loss / v_base * 100.0, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_security_gain_pct(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_price NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
    v_gain NUMERIC := 0;
    v_base NUMERIC := 0;
BEGIN
    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price, a.name AS action_name
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND s.name = 'Open'
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        v_base := v_base + v_rem * v_open.price;
        IF v_open.action_name = 'Long' AND v_price > v_open.price THEN
            v_gain := v_gain + v_rem * (v_price - v_open.price);
        ELSIF v_open.action_name = 'Short' AND v_open.price > v_price THEN
            v_gain := v_gain + v_rem * (v_open.price - v_price);
        END IF;
    END LOOP;

    IF v_base <= 0 THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(v_gain / v_base * 100.0, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_process_risk(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    INOUT p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_stop RECORD;
    v_sec RECORD;
    v_drawdown NUMERIC;
    v_gain NUMERIC;
    v_track_before NUMERIC;
    v_track_after NUMERIC;
    v_state RECORD;
    v_closed INTEGER;
    v_reason TEXT;
BEGIN
    FOR v_stop IN
        SELECT * FROM logic_stops ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        ORDER BY ls.rule_kind, ls.display_order, ls.id
    LOOP
        IF v_stop.value_unit <> 'percent' THEN
            CONTINUE;
        END IF;

        IF v_stop.rule_kind = 'stop_loss' AND v_stop.scope_type = 'portfolio' THEN
            SELECT COALESCE(SUM(lt.financial_result), 0) INTO v_track_before
            FROM logic_trades lt
            WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND lt.is_shadow = FALSE
              AND lt.status IN ('filled', 'submitted');

            v_drawdown := 0;
            IF p_balance < COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) THEN
                v_drawdown := (
                    COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) - p_balance
                ) / NULLIF(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) * 100.0;
            END IF;

            IF v_drawdown >= v_stop.value THEN
                v_reason := format('stop_loss:portfolio (%s%%)', round(v_drawdown, 2));
                FOR v_sec IN
                    SELECT DISTINCT lt.security_id
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                      AND lt.status IN ('filled', 'submitted')
                LOOP
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                    );
                END LOOP;
            END IF;
        ELSIF v_stop.rule_kind = 'stop_loss' THEN
            FOR v_sec IN
                SELECT ls.security_id FROM logic_securities ls
                WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
            LOOP
                IF v_stop.scope_type = 'security_resume'
                   AND logic_backtest_sec_shadow(p_run_id, v_sec.security_id) THEN
                    CONTINUE;
                END IF;

                v_drawdown := logic_backtest_security_drawdown_pct(
                    p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE
                );
                IF v_drawdown < v_stop.value THEN
                    CONTINUE;
                END IF;

                v_reason := format('stop_loss:%s (%s%%)', v_stop.scope_type, round(v_drawdown, 2));
                SELECT *
                INTO v_closed, p_balance
                FROM logic_backtest_close_security(
                    p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                    p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                );

                IF v_stop.scope_type = 'security_resume' THEN
                    INSERT INTO logic_backtest_security_state (
                        run_id, security_id, real_trading_paused,
                        stop_resume_equity, stop_resume_baseline
                    )
                    VALUES (p_run_id, v_sec.security_id, TRUE, p_balance, p_balance)
                    ON CONFLICT (run_id, security_id) DO UPDATE SET
                        real_trading_paused = TRUE,
                        stop_resume_equity = EXCLUDED.stop_resume_equity,
                        stop_resume_baseline = EXCLUDED.stop_resume_baseline;
                ELSIF v_stop.scope_type = 'security_inversion' THEN
                    INSERT INTO logic_backtest_security_state (
                        run_id, security_id, real_trading_inverted
                    )
                    VALUES (p_run_id, v_sec.security_id, TRUE)
                    ON CONFLICT (run_id, security_id) DO UPDATE SET
                        real_trading_inverted = NOT COALESCE(logic_backtest_security_state.real_trading_inverted, FALSE);
                END IF;
            END LOOP;
        ELSIF v_stop.rule_kind = 'take_profit' AND v_stop.scope_type = 'portfolio' THEN
            v_gain := 0;
            IF p_balance > COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) THEN
                v_gain := (
                    p_balance - COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0)
                ) / NULLIF(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) * 100.0;
            END IF;
            IF v_gain >= v_stop.value THEN
                v_reason := format('take_profit:portfolio (%s%%)', round(v_gain, 2));
                FOR v_sec IN
                    SELECT DISTINCT lt.security_id
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                      AND lt.status IN ('filled', 'submitted')
                LOOP
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                    );
                END LOOP;
            END IF;
        ELSIF v_stop.rule_kind = 'take_profit' AND v_stop.scope_type = 'security' THEN
            FOR v_sec IN
                SELECT ls.security_id FROM logic_securities ls
                WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
            LOOP
                v_gain := logic_backtest_security_gain_pct(
                    p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE
                );
                IF v_gain >= v_stop.value THEN
                    v_reason := format('take_profit:security (%s%%)', round(v_gain, 2));
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                    );
                END IF;
            END LOOP;
        END IF;
    END LOOP;

    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_process_signals(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    INOUT p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_position_size_pct NUMERIC;
    v_max_positions INTEGER;
    v_open_positions INTEGER;
    v_side_open_id INTEGER;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_sec RECORD;
    v_grp RECORD;
    v_sig RECORD;
    v_eval RECORD;
    v_is_shadow BOOLEAN;
    v_held_long NUMERIC;
    v_held_short NUMERIC;
    v_is_open_event BOOLEAN;
    v_quantity INTEGER;
    v_side_id INTEGER;
    v_action_id INTEGER;
    v_trade_id BIGINT;
    v_reason TEXT;
    v_bar_dt TIMESTAMP;
    v_all_ok BOOLEAN;
    v_formulas TEXT;
    v_signal_kind TEXT;
    v_pp NUMERIC;
    v_lot_size INTEGER;
    v_inversion BOOLEAN;
    v_eff_inversion BOOLEAN;
    v_eff_side TEXT;
BEGIN
    SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    v_position_size_pct := get_logic_param_numeric(p_logic_id, 'position_size_pct', 10);
    v_max_positions := GREATEST(1, get_logic_param_numeric(p_logic_id, 'max_open_positions', 5)::INTEGER);
    v_inversion := get_logic_param_boolean(p_logic_id, 'inversion', FALSE);
    v_open_positions := logic_backtest_count_open_positions(p_logic_id, FALSE);

    FOR v_sec IN
        SELECT ls.security_id FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        v_is_shadow := logic_backtest_sec_shadow(p_run_id, v_sec.security_id);
        v_eff_inversion := (
            v_inversion <> COALESCE(
                (SELECT st.real_trading_inverted
                 FROM logic_backtest_security_state st
                 WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id),
                FALSE
            )
        );
        v_lot_size := logic_security_lot_size(v_sec.security_id);

        FOR v_grp IN
            SELECT lis.position_event, lis.position_side
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            GROUP BY lis.position_event, lis.position_side
            ORDER BY lis.position_event, lis.position_side
        LOOP
            v_all_ok := TRUE;
            v_formulas := NULL;
            v_signal_kind := NULL;
            v_pp := NULL;
            v_bar_dt := NULL;

            FOR v_sig IN
                SELECT lis.id, lis.position_event, lis.position_side, lis.signal_kind, lis.formula, lis.indicator_id
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id
                  AND lis.is_active = TRUE
                  AND lis.position_event = v_grp.position_event
                  AND lis.position_side = v_grp.position_side
                ORDER BY lis.display_order, lis.id
            LOOP
                SELECT * INTO v_eval
                FROM logic_signal_evaluate_at(
                    v_sig.id, v_sec.security_id, p_tf_id, p_bar_dt, v_eff_inversion
                );

                IF v_eval.close_price IS NULL THEN
                    v_all_ok := FALSE;
                    CONTINUE;
                END IF;

                IF v_signal_kind IS NULL THEN
                    v_signal_kind := v_sig.signal_kind;
                    v_pp := v_eval.close_price;
                    v_bar_dt := v_eval.bar_dt;
                END IF;
                v_formulas := CASE
                    WHEN v_formulas IS NULL THEN v_sig.formula
                    ELSE v_formulas || ' AND ' || v_sig.formula
                END;

                IF NOT COALESCE(v_eval.ok, FALSE) THEN
                    v_all_ok := FALSE;
                END IF;
            END LOOP;

            IF NOT v_all_ok OR v_pp IS NULL OR v_formulas IS NULL THEN
                CONTINUE;
            END IF;

            v_eff_side := lower(COALESCE(v_grp.position_side, 'long'));
            IF v_eff_inversion THEN
                v_eff_side := CASE WHEN v_eff_side = 'long' THEN 'short' ELSE 'long' END;
            END IF;

            v_held_long := CASE WHEN v_eff_side = 'long'
                THEN logic_long_position_qty(p_logic_id, v_sec.security_id, v_is_shadow, TRUE) ELSE 0 END;
            v_held_short := CASE WHEN v_eff_side = 'short'
                THEN logic_short_position_qty(p_logic_id, v_sec.security_id, v_is_shadow, TRUE) ELSE 0 END;
            v_is_open_event := COALESCE(v_grp.position_event, 'open') = 'open';
            v_reason := format(
                'signal:AND%s:%s/%s→%s %s',
                CASE WHEN v_eff_inversion THEN ':inv' ELSE '' END,
                v_grp.position_event, v_grp.position_side, v_eff_side, v_formulas
            );

            IF v_eff_side = 'long' THEN
                IF v_is_open_event THEN
                    IF v_held_long > 0 OR (NOT v_is_shadow AND v_open_positions >= v_max_positions) THEN
                        CONTINUE;
                    END IF;
                    v_quantity := logic_calc_open_quantity(
                        p_balance, v_position_size_pct, v_pp, v_lot_size
                    );
                    IF v_quantity < v_lot_size THEN
                        IF p_balance >= v_pp * v_lot_size THEN
                            v_quantity := v_lot_size;
                        ELSE
                            CONTINUE;
                        END IF;
                    END IF;
                    v_side_id := v_side_open_id;
                    v_action_id := v_action_long_id;
                ELSE
                    IF v_held_long <= 0 THEN CONTINUE; END IF;
                    v_quantity := GREATEST(v_lot_size, v_held_long::INTEGER);
                    v_side_id := v_side_close_id;
                    v_action_id := v_action_long_id;
                END IF;
            ELSE
                IF v_is_open_event THEN
                    IF v_held_short > 0 OR (NOT v_is_shadow AND v_open_positions >= v_max_positions) THEN
                        CONTINUE;
                    END IF;
                    v_quantity := logic_calc_open_quantity(
                        p_balance, v_position_size_pct, v_pp, v_lot_size
                    );
                    IF v_quantity < v_lot_size THEN
                        IF p_balance >= v_pp * v_lot_size THEN
                            v_quantity := v_lot_size;
                        ELSE
                            CONTINUE;
                        END IF;
                    END IF;
                    v_side_id := v_side_open_id;
                    v_action_id := v_action_short_id;
                ELSE
                    IF v_held_short <= 0 THEN CONTINUE; END IF;
                    v_quantity := GREATEST(v_lot_size, v_held_short::INTEGER);
                    v_side_id := v_side_close_id;
                    v_action_id := v_action_short_id;
                END IF;
            END IF;

            SELECT *
            INTO v_trade_id, p_balance
            FROM logic_backtest_insert_trade(
                p_run_id, p_logic_id, p_account_id, v_sec.security_id, p_tf_id,
                v_side_id, v_action_id, v_signal_kind, v_formulas,
                v_quantity, v_pp, v_bar_dt, v_is_shadow, v_reason,
                p_balance, v_grp.position_event
            );

            IF v_trade_id IS NOT NULL AND v_is_open_event AND NOT v_is_shadow
               AND v_side_id = v_side_open_id THEN
                v_open_positions := v_open_positions + 1;
            ELSIF v_trade_id IS NOT NULL AND NOT v_is_open_event AND NOT v_is_shadow THEN
                v_open_positions := GREATEST(0, v_open_positions - 1);
            END IF;
        END LOOP;
    END LOOP;

    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION run_logic_backtest(
    p_logic_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    v_run_id BIGINT;
    v_logic RECORD;
    v_tf_id INTEGER;
    v_tf_sec INTEGER;
    v_balance NUMERIC;
    v_secs INTEGER;
    v_sec_i INTEGER := 0;
    v_sec RECORD;
    v_ind RECORD;
    v_bars TIMESTAMP[];
    v_total INTEGER;
    v_i INTEGER;
    v_bar_dt TIMESTAMP;
    v_pnl NUMERIC;
    v_date_from DATE;
    v_date_to DATE;
    v_load_from DATE;
    v_end_dt TIMESTAMP;
    v_point_count INTEGER;
    v_prices_in_period INTEGER;
    v_ind_in_period INTEGER;
    v_trades_created INTEGER;
    v_diag JSONB;
    v_days_span INTEGER;
    v_tbank JSONB;
    v_pl INTEGER;
    v_pc INTEGER;
    v_is INTEGER;
    v_ic INTEGER;
    v_ie INTEGER;
BEGIN
    v_date_from := LEAST(p_date_from, p_date_to);
    v_date_to := GREATEST(p_date_from, p_date_to);
    v_load_from := v_date_from - 30;
    v_end_dt := (v_date_to::TEXT || ' 23:59:59')::TIMESTAMP;

    SELECT l.id, l.account_id INTO v_logic
    FROM logics l WHERE l.id = p_logic_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Логика % не найдена', p_logic_id;
    END IF;

    v_tf_id := logic_resolve_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        RAISE EXCEPTION 'Не задан timeframe';
    END IF;
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = v_tf_id;

    v_balance := COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 1000000);
    v_days_span := GREATEST(1, (v_date_to - v_load_from) + 1);
    v_point_count := GREATEST(500, CEIL(v_days_span * (86400.0 / GREATEST(v_tf_sec, 60)))::INTEGER + 200);

    DELETE FROM logic_trades WHERE logic_id = p_logic_id AND is_test = TRUE;
    PERFORM logic_backtest_reset_signal_ratings(p_logic_id);

    INSERT INTO logic_backtest_runs (
        logic_id, date_from, date_to, status, progress_pct,
        phase_message, test_balance, started_at
    )
    VALUES (
        p_logic_id, v_date_from, v_date_to, 'loading_prices', 0,
        'Загрузка цен', v_balance, CURRENT_TIMESTAMP
    )
    RETURNING id INTO v_run_id;

    IF v_tf_sec < 86400 THEN
        v_tbank := tbank_verify_token();
        IF NOT COALESCE((v_tbank->>'valid')::BOOLEAN, FALSE) THEN
            PERFORM logic_backtest_log(
                v_run_id, p_logic_id, 'backtest.failed',
                COALESCE(v_tbank->>'error_message', 'Нужен токен T-Bank для intraday'),
                v_tbank
            );
            PERFORM logic_backtest_update_run(
                v_run_id, 'failed', 100, 'Нужен T-Bank', NULL, NULL, NULL, NULL, v_balance, 0,
                COALESCE(v_tbank->>'error_message', 'Для M15 нужен валидный токен T-Bank')
            );
            RETURN v_run_id;
        END IF;
    END IF;

    PERFORM logic_backtest_log(
        v_run_id, p_logic_id, 'backtest.start',
        format('Старт %s — %s', v_date_from, v_date_to),
        jsonb_build_object('date_from', v_date_from, 'date_to', v_date_to, 'load_from', v_load_from)
    );

    SELECT COUNT(*)::INTEGER INTO v_secs
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE;

    FOR v_sec IN
        SELECT ls.security_id FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        ORDER BY ls.display_order, ls.id
    LOOP
        IF logic_backtest_cancel_requested(v_run_id) THEN
            PERFORM logic_backtest_log(v_run_id, p_logic_id, 'backtest.cancelled', 'Отменено на загрузке', NULL);
            PERFORM logic_backtest_update_run(v_run_id, 'cancelled', NULL, 'Отменено', NULL);
            RETURN v_run_id;
        END IF;
        v_sec_i := v_sec_i + 1;
        BEGIN
            CALL logic_backtest_ensure_security_data(
                v_run_id, p_logic_id, v_sec.security_id, v_tf_id,
                v_load_from, v_date_from, v_date_to, v_end_dt, v_point_count,
                v_pl, v_pc, v_is, v_ic, v_ie
            );
        EXCEPTION WHEN OTHERS THEN
            PERFORM logic_backtest_log(
                v_run_id, p_logic_id, 'backtest.prices.error', SQLERRM,
                jsonb_build_object('security_id', v_sec.security_id), v_sec.security_id, v_tf_id
            );
        END;
        PERFORM logic_backtest_update_run(
            v_run_id, 'loading_prices',
            round(v_sec_i::NUMERIC / GREATEST(v_secs, 1) * 35, 2),
            'Подготовка данных',
            format('Бумага %s/%s', v_sec_i, v_secs)
        );
    END LOOP;

    SELECT COUNT(*)::INTEGER INTO v_prices_in_period
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = v_tf_id
      AND p.dt::date BETWEEN v_date_from AND v_date_to;

    PERFORM logic_backtest_log(
        v_run_id, p_logic_id, 'backtest.prices.done',
        format('Цены в периоде=%s', v_prices_in_period),
        jsonb_build_object('prices_in_period', v_prices_in_period),
        NULL, v_tf_id
    );

    IF v_prices_in_period = 0 THEN
        PERFORM logic_backtest_update_run(
            v_run_id, 'failed', 100, 'Нет свечей', NULL, NULL, NULL, NULL, v_balance, 0,
            'Не загружены цены. Задайте токен T-Bank (M15) или см. price_load_log.'
        );
        RETURN v_run_id;
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_ind_in_period
    FROM indicator_values iv
    JOIN logic_securities ls ON ls.security_id = iv.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND iv.timeframe_id = v_tf_id
      AND iv.dt::date BETWEEN v_date_from AND v_date_to;

    PERFORM logic_backtest_log(
        v_run_id, p_logic_id, 'backtest.indicators.done',
        format('Индикаторы в периоде=%s', v_ind_in_period),
        jsonb_build_object('indicator_values_in_period', v_ind_in_period),
        NULL, v_tf_id
    );

    IF v_ind_in_period = 0 THEN
        PERFORM logic_backtest_update_run(
            v_run_id, 'failed', 100, 'Нет индикаторов', NULL, NULL, NULL, NULL, v_balance, 0,
            'Индикаторы не рассчитаны. См. backtest.indicator.error.'
        );
        RETURN v_run_id;
    END IF;

    SELECT array_agg(DISTINCT p.dt ORDER BY p.dt)
    INTO v_bars
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = v_tf_id
      AND p.dt::date BETWEEN v_date_from AND v_date_to;

    v_total := COALESCE(array_length(v_bars, 1), 0);
    UPDATE logic_backtest_runs SET total_bars = v_total WHERE id = v_run_id;

    IF v_total = 0 THEN
        PERFORM logic_backtest_update_run(
            v_run_id, 'failed', 100, 'Нет свечей', NULL, NULL, NULL, NULL, v_balance, 0,
            'Нет цен в выбранном периоде'
        );
        RETURN v_run_id;
    END IF;

    PERFORM logic_backtest_update_run(
        v_run_id, 'running', 40, 'Прогон по свечам',
        format('0 / %s баров', v_total)
    );

    FOR v_i IN 1..v_total LOOP
        IF logic_backtest_cancel_requested(v_run_id) THEN
            SELECT COALESCE(SUM(financial_result), 0) INTO v_pnl
            FROM logic_trades WHERE logic_id = p_logic_id AND is_test = TRUE;
            PERFORM logic_backtest_log(v_run_id, p_logic_id, 'backtest.cancelled', format('Отменено на %s/%s', v_i, v_total), NULL);
            PERFORM logic_backtest_update_run(
                v_run_id, 'cancelled',
                round(40 + v_i::NUMERIC / v_total * 60, 2),
                'Отменено пользователем', NULL, v_bars[v_i], v_i, NULL, v_balance, v_pnl
            );
            RETURN v_run_id;
        END IF;

        v_bar_dt := v_bars[v_i];
        PERFORM logic_backtest_rate_signals(v_run_id, p_logic_id, v_tf_id, v_bar_dt);
        v_balance := logic_backtest_process_risk(
            v_run_id, p_logic_id, v_logic.account_id, v_tf_id, v_bar_dt, v_balance
        );
        v_balance := logic_backtest_process_signals(
            v_run_id, p_logic_id, v_logic.account_id, v_tf_id, v_bar_dt, v_balance
        );

        IF v_i % 5 = 0 OR v_i = v_total THEN
            PERFORM logic_backtest_update_run(
                v_run_id, 'running',
                round(40 + v_i::NUMERIC / v_total * 60, 2),
                'Прогон по свечам',
                format('%s / %s баров', v_i, v_total),
                v_bar_dt, v_i, NULL, v_balance
            );
        END IF;
    END LOOP;

    SELECT COALESCE(SUM(financial_result), 0) INTO v_pnl
    FROM logic_trades WHERE logic_id = p_logic_id AND is_test = TRUE;

    SELECT COUNT(*)::INTEGER INTO v_trades_created
    FROM logic_trades WHERE logic_id = p_logic_id AND is_test = TRUE;

    v_diag := logic_backtest_diagnose(v_run_id, p_logic_id, v_tf_id, v_date_from, v_date_to);

    PERFORM logic_backtest_log(
        v_run_id, p_logic_id, 'backtest.complete',
        CASE WHEN v_trades_created > 0
            THEN format('Завершено: %s сделок, PnL=%s', v_trades_created, round(v_pnl, 2))
            ELSE format('Завершено без сделок (%s баров)', v_total)
        END,
        v_diag || jsonb_build_object(
            'trades_created', v_trades_created,
            'financial_result', v_pnl,
            'total_bars', v_total
        ),
        NULL, v_tf_id
    );

    PERFORM logic_backtest_update_run(
        v_run_id, 'completed', 100,
        CASE WHEN v_trades_created > 0 THEN 'Тестирование завершено' ELSE 'Тест завершён — сделок нет' END,
        format('%s баров, сделок: %s', v_total, v_trades_created),
        v_bars[v_total], v_total, v_trades_created, v_balance, v_pnl
    );

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION run_logic_backtest(INTEGER, DATE, DATE) IS
'Исторический backtest: is_test=TRUE сделки, прогресс в logic_backtest_runs';

CREATE OR REPLACE FUNCTION logic_backtest_request_cancel(p_run_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE logic_backtest_runs
    SET cancel_requested = TRUE
    WHERE id = p_run_id
      AND status IN ('pending', 'loading_prices', 'loading_indicators', 'running');
    RETURN FOUND;
END;
$$;
