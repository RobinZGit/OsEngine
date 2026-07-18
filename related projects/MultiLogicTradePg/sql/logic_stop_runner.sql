-- ============================================
-- Stop-loss runner: security / security_resume / security_inversion / portfolio
-- ============================================

CREATE OR REPLACE FUNCTION logic_resolve_stop_timeframe_id(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf TEXT;
    v_id INTEGER;
BEGIN
    v_tf := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'stop_loss_timeframe'), 'M5')));
    SELECT t.id INTO v_id
    FROM timeframes t
    WHERE upper(t.tf) = v_tf AND COALESCE(t.is_active, TRUE)
    ORDER BY t.sec
    LIMIT 1;
    IF v_id IS NULL THEN
        SELECT t.id INTO v_id FROM timeframes t WHERE upper(t.tf) = 'M5' LIMIT 1;
    END IF;
    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION logic_resolve_stop_timeframe_id(INTEGER) IS
'timeframe_id из logic_params.stop_loss_timeframe (по умолчанию M5)';

CREATE OR REPLACE FUNCTION logic_long_position_qty(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE,
    p_is_test BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(COALESCE(SUM(
        CASE
            WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
            WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
            ELSE 0
        END
    ), 0), 0)
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    JOIN actions a ON a.id = lt.action_id
    WHERE lt.logic_id = p_logic_id
      AND lt.security_id = p_security_id
      AND lt.is_shadow = p_is_shadow
      AND lt.is_test = p_is_test
      AND lt.status IN ('filled', 'submitted');
$$;

CREATE OR REPLACE FUNCTION logic_short_position_qty(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE,
    p_is_test BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(COALESCE(SUM(
        CASE
            WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
            WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
            ELSE 0
        END
    ), 0), 0)
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    JOIN actions a ON a.id = lt.action_id
    WHERE lt.logic_id = p_logic_id
      AND lt.security_id = p_security_id
      AND lt.is_shadow = p_is_shadow
      AND lt.is_test = p_is_test
      AND lt.status IN ('filled', 'submitted');
$$;

CREATE OR REPLACE FUNCTION logic_count_open_positions(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT COUNT(*)::INTEGER FROM (
        SELECT lt.security_id
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND NOT lt.is_shadow
          AND NOT lt.is_test
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

CREATE OR REPLACE FUNCTION logic_security_position_cost(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN,
    p_is_test BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_long_cost NUMERIC := 0;
    v_short_cost NUMERIC := 0;
    v_open RECORD;
    v_rem NUMERIC;
BEGIN
    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow, p_is_test);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow, p_is_test);

    IF v_long_qty > 0 THEN
        FOR v_open IN
            SELECT lt.id, lt.quantity, lt.price
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND lt.security_id = p_security_id
              AND lt.is_shadow = p_is_shadow
              AND lt.is_test = p_is_test
              AND s.name = 'Open' AND a.name = 'Long'
              AND lt.status IN ('filled', 'submitted')
            ORDER BY lt.executed_at ASC, lt.id ASC
        LOOP
            v_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_rem > 0 THEN
                v_long_cost := v_long_cost + v_rem * v_open.price;
            END IF;
        END LOOP;
    END IF;

    IF v_short_qty > 0 THEN
        FOR v_open IN
            SELECT lt.id, lt.quantity, lt.price
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND lt.security_id = p_security_id
              AND lt.is_shadow = p_is_shadow
              AND s.name = 'Open' AND a.name = 'Short'
              AND lt.status IN ('filled', 'submitted')
            ORDER BY lt.executed_at ASC, lt.id ASC
        LOOP
            v_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_rem > 0 THEN
                v_short_cost := v_short_cost + v_rem * v_open.price;
            END IF;
        END LOOP;
    END IF;

    RETURN COALESCE(v_long_cost, 0) + COALESCE(v_short_cost, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_security_position_market(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_price NUMERIC;
    v_market NUMERIC := 0;
BEGIN
    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, p_timeframe_id);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN NULL;
    END IF;
    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow);
    v_market := (COALESCE(v_long_qty, 0) + COALESCE(v_short_qty, 0)) * v_price;
    RETURN v_market;
END;
$$;

CREATE OR REPLACE FUNCTION logic_security_drawdown_pct(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cost NUMERIC;
    v_market NUMERIC;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_long_cost NUMERIC := 0;
    v_short_cost NUMERIC := 0;
    v_long_mkt NUMERIC := 0;
    v_short_mkt NUMERIC := 0;
    v_price NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
    v_loss NUMERIC := 0;
    v_base NUMERIC := 0;
BEGIN
    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, p_timeframe_id);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;

    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow);
    IF v_long_qty <= 0 AND v_short_qty <= 0 THEN
        RETURN 0;
    END IF;

    IF v_long_qty > 0 THEN
        FOR v_open IN
            SELECT lt.id, lt.price
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND lt.security_id = p_security_id
              AND lt.is_shadow = p_is_shadow
              AND s.name = 'Open' AND a.name = 'Long'
              AND lt.status IN ('filled', 'submitted')
        LOOP
            v_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_rem > 0 THEN
                v_long_cost := v_long_cost + v_rem * v_open.price;
                v_long_mkt := v_long_mkt + v_rem * v_price;
                IF v_open.price > v_price THEN
                    v_loss := v_loss + v_rem * (v_open.price - v_price);
                END IF;
                v_base := v_base + v_rem * v_open.price;
            END IF;
        END LOOP;
    END IF;

    IF v_short_qty > 0 THEN
        FOR v_open IN
            SELECT lt.id, lt.price
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND lt.security_id = p_security_id
              AND lt.is_shadow = p_is_shadow
              AND s.name = 'Open' AND a.name = 'Short'
              AND lt.status IN ('filled', 'submitted')
        LOOP
            v_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_rem > 0 THEN
                v_short_cost := v_short_cost + v_rem * v_open.price;
                IF v_price > v_open.price THEN
                    v_loss := v_loss + v_rem * (v_price - v_open.price);
                END IF;
                v_base := v_base + v_rem * v_open.price;
            END IF;
        END LOOP;
    END IF;

    IF v_base <= 0 THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(v_loss / v_base * 100.0, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_security_track_value(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_realized NUMERIC := 0;
    v_unrealized NUMERIC := 0;
    v_price NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
BEGIN
    SELECT COALESCE(SUM(lt.financial_result), 0)
    INTO v_realized
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    WHERE lt.logic_id = p_logic_id
      AND lt.security_id = p_security_id
      AND lt.is_shadow = p_is_shadow
      AND s.name = 'Close'
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL;

    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, p_timeframe_id);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN v_realized;
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price, a.name AS action_name
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_shadow = p_is_shadow
          AND s.name = 'Open'
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        IF v_open.action_name = 'Long' THEN
            v_unrealized := v_unrealized + v_rem * (v_price - v_open.price);
        ELSE
            v_unrealized := v_unrealized + v_rem * (v_open.price - v_price);
        END IF;
    END LOOP;

    RETURN COALESCE(v_realized, 0) + COALESCE(v_unrealized, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_portfolio_equity(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cash NUMERIC;
    v_sec RECORD;
    v_price NUMERIC;
    v_long_qty NUMERIC;
    v_total NUMERIC := 0;
BEGIN
    v_cash := logic_ensure_balance(p_logic_id);
    v_total := COALESCE(v_cash, 0);

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        v_long_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE);
        IF v_long_qty <= 0 THEN
            CONTINUE;
        END IF;
        v_price := logic_ensure_security_market_price(p_logic_id, v_sec.security_id, p_timeframe_id);
        IF v_price IS NOT NULL AND v_price > 0 THEN
            v_total := v_total + v_long_qty * v_price;
        END IF;
    END LOOP;

    RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION logic_portfolio_drawdown_pct(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_initial NUMERIC;
    v_equity NUMERIC;
BEGIN
    v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', 0);
    IF v_initial IS NULL OR v_initial <= 0 THEN
        RETURN 0;
    END IF;
    v_equity := logic_portfolio_equity(p_logic_id, p_timeframe_id);
    IF v_equity IS NULL OR v_equity >= v_initial THEN
        RETURN 0;
    END IF;
    RETURN (v_initial - v_equity) / v_initial * 100.0;
END;
$$;

CREATE OR REPLACE FUNCTION logic_close_security_positions_market(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_result JSONB;
    v_closed INTEGER := 0;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_tf_id INTEGER;
    v_logic RECORD;
    v_balance NUMERIC;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_price NUMERIC;
    v_trade_id BIGINT;
    v_quantity INTEGER;
    v_bar_dt TIMESTAMP;
    v_formula TEXT := 'stop_loss:close';
    v_notional NUMERIC;
    v_is_simulated BOOLEAN;
    v_close_idx INTEGER := 0;
BEGIN
    v_tf_id := logic_resolve_timeframe_id(p_logic_id);

    SELECT l.id, l.account_id, a.account_type
    INTO v_logic
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    v_balance := logic_ensure_balance(p_logic_id);
    v_is_simulated := v_logic.account_type = 'fake';
    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, v_tf_id);

    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;

    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow);

    IF v_long_qty > 0 THEN
        v_close_idx := v_close_idx + 1;
        v_bar_dt := clock_timestamp() + (v_close_idx * interval '1 millisecond');
        v_quantity := floor(v_long_qty)::INTEGER;
        IF v_quantity >= 1 THEN
            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, signal_kind, signal_formula,
                quantity, price, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                status
            )
            VALUES (
                p_logic_id, v_logic.account_id, p_security_id, v_tf_id,
                v_side_close_id, v_action_long_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE, p_is_shadow, FALSE,
                'filled'
            )
            RETURNING id INTO v_trade_id;

            IF NOT p_is_shadow AND v_is_simulated AND v_balance IS NOT NULL THEN
                v_balance := logic_trade_finalize(v_trade_id, v_balance);
                v_notional := v_quantity * v_price;
                v_balance := v_balance + v_notional;
                PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_balance::TEXT, 'money');
            ELSIF NOT p_is_shadow THEN
                PERFORM logic_trade_finalize(v_trade_id, v_balance);
            ELSE
                PERFORM logic_trade_finalize(v_trade_id, NULL);
            END IF;
            v_closed := v_closed + 1;
        END IF;
    END IF;

    IF v_short_qty > 0 THEN
        v_close_idx := v_close_idx + 1;
        v_bar_dt := clock_timestamp() + (v_close_idx * interval '1 millisecond');
        v_quantity := floor(v_short_qty)::INTEGER;
        IF v_quantity >= 1 THEN
            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, signal_kind, signal_formula,
                quantity, price, bar_dt, is_simulated, is_fictitious, is_shadow,
                status
            )
            VALUES (
                p_logic_id, v_logic.account_id, p_security_id, v_tf_id,
                v_side_close_id, v_action_short_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE, p_is_shadow,
                'filled'
            )
            RETURNING id INTO v_trade_id;

            IF NOT p_is_shadow AND v_is_simulated AND v_balance IS NOT NULL THEN
                v_balance := logic_trade_finalize(v_trade_id, v_balance);
                v_notional := v_quantity * v_price;
                v_balance := v_balance - v_notional;
                PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_balance::TEXT, 'money');
            ELSIF NOT p_is_shadow THEN
                PERFORM logic_trade_finalize(v_trade_id, v_balance);
            ELSE
                PERFORM logic_trade_finalize(v_trade_id, NULL);
            END IF;
            v_closed := v_closed + 1;
        END IF;
    END IF;

    RETURN v_closed;
END;
$$;

CREATE OR REPLACE FUNCTION logic_check_security_resume(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    v_ls RECORD;
    v_shadow_track NUMERIC;
    v_resumed BOOLEAN := FALSE;
BEGIN
    SELECT ls.real_trading_paused, ls.stop_resume_equity, ls.stop_resume_baseline
    INTO v_ls
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id
      AND ls.security_id = p_security_id;

    IF NOT FOUND OR NOT COALESCE(v_ls.real_trading_paused, FALSE) THEN
        RETURN FALSE;
    END IF;
    IF v_ls.stop_resume_equity IS NULL OR v_ls.stop_resume_baseline IS NULL THEN
        RETURN FALSE;
    END IF;

    v_shadow_track := logic_security_track_value(
        p_logic_id, p_security_id, p_timeframe_id, TRUE
    );

    IF COALESCE(v_ls.stop_resume_baseline, 0) + COALESCE(v_shadow_track, 0)
       >= COALESCE(v_ls.stop_resume_equity, 0) THEN
        UPDATE logic_securities
        SET real_trading_paused = FALSE,
            stop_resume_equity = NULL,
            stop_resume_baseline = NULL,
            stop_resume_triggered_at = NULL
        WHERE logic_id = p_logic_id
          AND security_id = p_security_id;

        PERFORM logic_trade_log(
            p_logic_id,
            'stop.resume',
            format(
                'Возобновление реальной торговли sec=%s (baseline=%s shadow=%s target=%s)',
                p_security_id,
                v_ls.stop_resume_baseline,
                v_shadow_track,
                v_ls.stop_resume_equity
            ),
            jsonb_build_object(
                'security_id', p_security_id,
                'baseline', v_ls.stop_resume_baseline,
                'shadow_track', v_shadow_track,
                'target', v_ls.stop_resume_equity
            ),
            p_security_id,
            p_timeframe_id
        );
        v_resumed := TRUE;
    END IF;

    RETURN v_resumed;
END;
$$;

CREATE OR REPLACE FUNCTION process_logic_stops(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_stop RECORD;
    v_tf_id INTEGER;
    v_tf_sec INTEGER;
    v_closed_bar_dt TIMESTAMP;
    v_last_bar_raw TEXT;
    v_last_bar_dt TIMESTAMP;
    v_sec RECORD;
    v_drawdown NUMERIC;
    v_port_dd NUMERIC;
    v_actions INTEGER := 0;
    v_track_before NUMERIC;
    v_track_after NUMERIC;
    v_closed INTEGER;
    v_skip_http BOOLEAN := FALSE;
    v_date_from DATE;
    v_date_to DATE;
BEGIN
    SELECT l.id, l.is_enabled
    INTO v_logic
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id
      AND l.is_enabled = TRUE
      AND a.is_active = TRUE;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    v_tf_id := logic_resolve_stop_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = v_tf_id;
    v_closed_bar_dt := logic_last_closed_bar_dt(v_tf_sec);
    IF v_closed_bar_dt IS NULL THEN
        RETURN 0;
    END IF;

    v_last_bar_raw := btrim(COALESCE(get_logic_param_text(p_logic_id, 'last_stop_bar_dt'), ''));
    IF v_last_bar_raw <> '' THEN
        BEGIN
            v_last_bar_dt := v_last_bar_raw::TIMESTAMP;
            IF v_closed_bar_dt <= v_last_bar_dt THEN
                FOR v_sec IN
                    SELECT ls.security_id
                    FROM logic_securities ls
                    WHERE ls.logic_id = p_logic_id
                      AND ls.is_active = TRUE
                      AND (ls.real_trading_paused = TRUE OR ls.real_trading_inverted = TRUE)
                LOOP
                    IF logic_check_security_resume(p_logic_id, v_sec.security_id, v_tf_id) THEN
                        v_actions := v_actions + 1;
                    END IF;
                END LOOP;
                RETURN v_actions;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
    END IF;

    SELECT * INTO v_stop
    FROM logic_stops ls
    WHERE ls.logic_id = p_logic_id
      AND ls.rule_kind = 'stop_loss'
      AND ls.is_active = TRUE
    ORDER BY ls.display_order, ls.id
    LIMIT 1;

    -- Не грузим все 34 бумаги через HTTP на каждом баре: это блокирует пул и UI
    -- (раскрытие бумаги / график). Только позиции / pause + skip если свеча уже есть.
    SELECT EXISTS (
        SELECT 1
        FROM logic_backtest_runs r
        WHERE r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
    ) INTO v_skip_http;

    v_date_to := GREATEST(v_closed_bar_dt::date, CURRENT_DATE);
    v_date_from := logic_trade_load_date_from(
        v_tf_sec, logic_trade_sync_point_count(v_tf_sec), v_closed_bar_dt
    );

    FOR v_sec IN
        SELECT DISTINCT q.security_id
        FROM (
            SELECT lt.security_id
            FROM logic_trades lt
            WHERE lt.logic_id = p_logic_id
              AND NOT lt.is_test
              AND NOT lt.is_shadow
              AND lt.status IN ('filled', 'submitted')
            UNION
            SELECT ls.security_id
            FROM logic_securities ls
            WHERE ls.logic_id = p_logic_id
              AND ls.is_active = TRUE
              AND (ls.real_trading_paused = TRUE OR ls.real_trading_inverted = TRUE)
        ) q
    LOOP
        IF NOT v_skip_http
           AND NOT prices_have_closed_bar(v_sec.security_id, v_tf_id, v_closed_bar_dt) THEN
            BEGIN
                CALL load_prices(
                    v_sec.security_id,
                    v_tf_id,
                    prices_topup_date_from(
                        v_sec.security_id, v_tf_id, v_closed_bar_dt, v_date_from
                    ),
                    v_date_to
                );
            EXCEPTION
                WHEN OTHERS THEN
                    NULL;
            END;
        END IF;

        IF logic_check_security_resume(p_logic_id, v_sec.security_id, v_tf_id) THEN
            v_actions := v_actions + 1;
        END IF;
    END LOOP;

    IF v_stop.id IS NULL THEN
        PERFORM logic_upsert_param(
            p_logic_id, 'last_stop_bar_dt',
            to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'), 'text'
        );
        RETURN v_actions;
    END IF;

    IF v_stop.value_unit <> 'percent' THEN
        PERFORM logic_trade_log(
            p_logic_id, 'stop.skip',
            format('Стоп-лосс: единица %s пока не поддерживается (только percent)', v_stop.value_unit),
            NULL, NULL, v_tf_id
        );
        PERFORM logic_upsert_param(
            p_logic_id, 'last_stop_bar_dt',
            to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'), 'text'
        );
        RETURN v_actions;
    END IF;

    IF v_stop.scope_type = 'portfolio' THEN
        v_port_dd := logic_portfolio_drawdown_pct(p_logic_id, v_tf_id);
        IF v_port_dd >= v_stop.value THEN
            PERFORM logic_trade_log(
                p_logic_id, 'stop.trigger',
                format('Портфельный SL: просадка %s%% >= %s%%', round(v_port_dd, 4), v_stop.value),
                jsonb_build_object('drawdown_pct', v_port_dd, 'threshold', v_stop.value),
                NULL, v_tf_id
            );
            FOR v_sec IN
                SELECT DISTINCT lt.security_id
                FROM logic_trades lt
                WHERE lt.logic_id = p_logic_id
                  AND NOT lt.is_shadow
                  AND NOT lt.is_test
                  AND lt.status IN ('filled', 'submitted')
            LOOP
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
            END LOOP;
        END IF;
    ELSE
        FOR v_sec IN
            SELECT ls.security_id
            FROM logic_securities ls
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        LOOP
            IF v_stop.scope_type = 'security_resume'
               AND EXISTS (
                   SELECT 1 FROM logic_securities ls2
                   WHERE ls2.logic_id = p_logic_id
                     AND ls2.security_id = v_sec.security_id
                     AND ls2.real_trading_paused = TRUE
               ) THEN
                CONTINUE;
            END IF;

            v_drawdown := logic_security_drawdown_pct(
                p_logic_id, v_sec.security_id, v_tf_id, FALSE
            );

            IF v_drawdown < v_stop.value THEN
                CONTINUE;
            END IF;

            IF v_stop.scope_type = 'security' THEN
                PERFORM logic_trade_log(
                    p_logic_id, 'stop.trigger',
                    format(
                        'SL по бумаге sec=%s: просадка %s%% >= %s%%',
                        v_sec.security_id, round(v_drawdown, 4), v_stop.value
                    ),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'drawdown_pct', v_drawdown,
                        'scope', 'security'
                    ),
                    v_sec.security_id, v_tf_id
                );
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
            ELSIF v_stop.scope_type = 'security_resume' THEN
                v_track_before := logic_security_track_value(
                    p_logic_id, v_sec.security_id, v_tf_id, FALSE
                );
                PERFORM logic_trade_log(
                    p_logic_id, 'stop.trigger',
                    format(
                        'SL с возобновлением sec=%s: просадка %s%% >= %s%%, track=%s',
                        v_sec.security_id, round(v_drawdown, 4), v_stop.value, v_track_before
                    ),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'drawdown_pct', v_drawdown,
                        'scope', 'security_resume',
                        'track_before', v_track_before
                    ),
                    v_sec.security_id, v_tf_id
                );
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
                v_track_after := logic_security_track_value(
                    p_logic_id, v_sec.security_id, v_tf_id, FALSE
                );
                UPDATE logic_securities
                SET real_trading_paused = TRUE,
                    stop_resume_equity = v_track_before,
                    stop_resume_baseline = v_track_after,
                    stop_resume_triggered_at = CURRENT_TIMESTAMP
                WHERE logic_id = p_logic_id
                  AND security_id = v_sec.security_id;
                v_actions := v_actions + 1;
            ELSIF v_stop.scope_type = 'security_inversion' THEN
                PERFORM logic_trade_log(
                    p_logic_id, 'stop.trigger',
                    format(
                        'SL inversion sec=%s: просадка %s%% >= %s%%',
                        v_sec.security_id, round(v_drawdown, 4), v_stop.value
                    ),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'drawdown_pct', v_drawdown,
                        'scope', 'security_inversion'
                    ),
                    v_sec.security_id, v_tf_id
                );
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
                UPDATE logic_securities
                SET real_trading_inverted = NOT COALESCE(real_trading_inverted, FALSE),
                    stop_resume_triggered_at = CURRENT_TIMESTAMP
                WHERE logic_id = p_logic_id
                  AND security_id = v_sec.security_id;
                v_actions := v_actions + 1;
            END IF;
        END LOOP;
    END IF;

    PERFORM logic_upsert_param(
        p_logic_id, 'last_stop_bar_dt',
        to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'), 'text'
    );

    RETURN v_actions;
END;
$$;

COMMENT ON FUNCTION process_logic_stops(INTEGER) IS
'Цикл стоп-лоссов: security / security_resume / security_inversion / portfolio; TF из stop_loss_timeframe';
