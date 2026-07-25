-- ============================================
-- Stop-loss runner: security / security_resume / security_inversion / portfolio / portfolio_resume
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

-- Нормализация стороны: long|short (NULL/пусто → NULL).
CREATE OR REPLACE FUNCTION logic_normalize_position_side(p_position_side TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE lower(btrim(COALESCE(p_position_side, '')))
        WHEN 'long' THEN 'long'
        WHEN 'short' THEN 'short'
        ELSE NULL
    END;
$$;

-- Просадка % только по одной стороне (Long или Short) на бумаге.
CREATE OR REPLACE FUNCTION logic_security_side_drawdown_pct(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN,
    p_position_side TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_side TEXT;
    v_action TEXT;
    v_price NUMERIC;
    v_qty NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
    v_loss NUMERIC := 0;
    v_base NUMERIC := 0;
BEGIN
    v_side := logic_normalize_position_side(p_position_side);
    IF v_side IS NULL THEN
        RETURN 0;
    END IF;
    v_action := CASE WHEN v_side = 'long' THEN 'Long' ELSE 'Short' END;

    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, p_timeframe_id);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;

    IF v_side = 'long' THEN
        v_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow);
    ELSE
        v_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow);
    END IF;
    IF COALESCE(v_qty, 0) <= 0 THEN
        RETURN 0;
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_shadow = p_is_shadow
          AND NOT lt.is_test
          AND s.name = 'Open' AND a.name = v_action
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        v_base := v_base + v_rem * v_open.price;
        IF v_side = 'long' AND v_open.price > v_price THEN
            v_loss := v_loss + v_rem * (v_open.price - v_price);
        ELSIF v_side = 'short' AND v_price > v_open.price THEN
            v_loss := v_loss + v_rem * (v_price - v_open.price);
        END IF;
    END LOOP;

    IF v_base <= 0 THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(v_loss / v_base * 100.0, 0);
END;
$$;

-- Track (realized Close + unrealized Open) только по одной стороне.
CREATE OR REPLACE FUNCTION logic_security_side_track_value(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN,
    p_position_side TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_side TEXT;
    v_action TEXT;
    v_realized NUMERIC := 0;
    v_unrealized NUMERIC := 0;
    v_price NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
BEGIN
    v_side := logic_normalize_position_side(p_position_side);
    IF v_side IS NULL THEN
        RETURN 0;
    END IF;
    v_action := CASE WHEN v_side = 'long' THEN 'Long' ELSE 'Short' END;

    SELECT COALESCE(SUM(lt.financial_result), 0)
    INTO v_realized
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    JOIN actions a ON a.id = lt.action_id
    WHERE lt.logic_id = p_logic_id
      AND lt.security_id = p_security_id
      AND lt.is_shadow = p_is_shadow
      AND NOT lt.is_test
      AND s.name = 'Close'
      AND a.name = v_action
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL;

    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, p_timeframe_id);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN COALESCE(v_realized, 0);
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_shadow = p_is_shadow
          AND NOT lt.is_test
          AND s.name = 'Open'
          AND a.name = v_action
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        IF v_side = 'long' THEN
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

-- Пик equity (обновляется, пока нет portfolio_resume pause).
CREATE OR REPLACE FUNCTION logic_update_portfolio_equity_peak(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_equity NUMERIC;
    v_peak NUMERIC;
    v_initial NUMERIC;
    v_paused BOOLEAN;
BEGIN
    SELECT COALESCE(portfolio_trading_paused, FALSE), portfolio_equity_peak
    INTO v_paused, v_peak
    FROM logics
    WHERE id = p_logic_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_paused THEN
        RETURN v_peak;
    END IF;

    v_equity := logic_portfolio_equity(p_logic_id, p_timeframe_id);
    v_initial := COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0);
    IF v_peak IS NULL OR v_peak <= 0 THEN
        v_peak := GREATEST(COALESCE(v_equity, 0), v_initial, 0);
    ELSIF v_equity IS NOT NULL AND v_equity > v_peak THEN
        v_peak := v_equity;
    END IF;

    UPDATE logics
    SET portfolio_equity_peak = v_peak
    WHERE id = p_logic_id;

    RETURN v_peak;
END;
$$;

-- Просадка % от пика equity (для portfolio_resume).
CREATE OR REPLACE FUNCTION logic_portfolio_peak_drawdown_pct(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_peak NUMERIC;
    v_equity NUMERIC;
BEGIN
    v_peak := logic_update_portfolio_equity_peak(p_logic_id, p_timeframe_id);
    IF v_peak IS NULL OR v_peak <= 0 THEN
        RETURN 0;
    END IF;
    v_equity := logic_portfolio_equity(p_logic_id, p_timeframe_id);
    IF v_equity IS NULL OR v_equity >= v_peak THEN
        RETURN 0;
    END IF;
    RETURN (v_peak - v_equity) / v_peak * 100.0;
END;
$$;

-- Теневой track портфеля: sum(shadow financial_result) после паузы.
CREATE OR REPLACE FUNCTION logic_portfolio_shadow_pnl(p_logic_id INTEGER)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(lt.financial_result), 0)
    FROM logic_trades lt
    WHERE lt.logic_id = p_logic_id
      AND NOT lt.is_test
      AND lt.is_shadow = TRUE
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL;
$$;

DROP FUNCTION IF EXISTS logic_close_security_positions_market(INTEGER, INTEGER, BOOLEAN);
DROP FUNCTION IF EXISTS logic_close_security_positions_market(INTEGER, INTEGER, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS logic_close_security_positions_market(INTEGER, INTEGER, BOOLEAN, TEXT, TEXT);

CREATE OR REPLACE FUNCTION logic_close_security_positions_market(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE,
    p_reason TEXT DEFAULT NULL,
    p_position_side TEXT DEFAULT NULL
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
    v_formula TEXT;
    v_notional NUMERIC;
    v_is_simulated BOOLEAN;
    v_close_idx INTEGER := 0;
    v_side TEXT;
    v_close_long BOOLEAN := TRUE;
    v_close_short BOOLEAN := TRUE;
BEGIN
    -- Денежный фонд остаётся купленным: портфельный/бумажный SL не продаёт TMON/LQDT/SBMM.
    IF logic_is_cash_fund_security(p_security_id) THEN
        RETURN 0;
    END IF;

    v_side := logic_normalize_position_side(p_position_side);
    IF v_side = 'long' THEN
        v_close_short := FALSE;
    ELSIF v_side = 'short' THEN
        v_close_long := FALSE;
    END IF;

    v_formula := COALESCE(NULLIF(btrim(p_reason), ''), 'stop_loss:close');
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

    v_long_qty := CASE WHEN v_close_long
        THEN logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow) ELSE 0 END;
    v_short_qty := CASE WHEN v_close_short
        THEN logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow) ELSE 0 END;

    IF v_long_qty > 0 THEN
        v_close_idx := v_close_idx + 1;
        v_bar_dt := clock_timestamp() + (v_close_idx * interval '1 millisecond');
        v_quantity := floor(v_long_qty)::INTEGER;
        IF v_quantity >= 1 THEN
            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, signal_kind, signal_formula,
                quantity, price, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                trade_reason, status
            )
            VALUES (
                p_logic_id, v_logic.account_id, p_security_id, v_tf_id,
                v_side_close_id, v_action_long_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE, p_is_shadow, FALSE,
                v_formula, 'filled'
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
                trade_reason, status
            )
            VALUES (
                p_logic_id, v_logic.account_id, p_security_id, v_tf_id,
                v_side_close_id, v_action_short_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE, p_is_shadow,
                v_formula, 'filled'
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
    v_paused_long BOOLEAN;
    v_paused_short BOOLEAN;
BEGIN
    SELECT
        COALESCE(ls.real_trading_paused_long, FALSE) AS paused_long,
        COALESCE(ls.real_trading_paused_short, FALSE) AS paused_short,
        ls.stop_resume_equity_long,
        ls.stop_resume_baseline_long,
        ls.stop_resume_equity_short,
        ls.stop_resume_baseline_short,
        -- legacy paper-level (до v48)
        COALESCE(ls.real_trading_paused, FALSE) AS paused_paper,
        ls.stop_resume_equity,
        ls.stop_resume_baseline
    INTO v_ls
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id
      AND ls.security_id = p_security_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    v_paused_long := v_ls.paused_long;
    v_paused_short := v_ls.paused_short;

    -- Legacy: paper pause without side flags → treat as both sides
    IF v_ls.paused_paper AND NOT v_paused_long AND NOT v_paused_short THEN
        v_paused_long := TRUE;
        v_paused_short := TRUE;
        IF v_ls.stop_resume_equity_long IS NULL THEN
            v_ls.stop_resume_equity_long := v_ls.stop_resume_equity;
            v_ls.stop_resume_baseline_long := v_ls.stop_resume_baseline;
        END IF;
        IF v_ls.stop_resume_equity_short IS NULL THEN
            v_ls.stop_resume_equity_short := v_ls.stop_resume_equity;
            v_ls.stop_resume_baseline_short := v_ls.stop_resume_baseline;
        END IF;
    END IF;

    IF v_paused_long
       AND v_ls.stop_resume_equity_long IS NOT NULL
       AND v_ls.stop_resume_baseline_long IS NOT NULL THEN
        v_shadow_track := logic_security_side_track_value(
            p_logic_id, p_security_id, p_timeframe_id, TRUE, 'long'
        );
        IF COALESCE(v_ls.stop_resume_baseline_long, 0) + COALESCE(v_shadow_track, 0)
           >= COALESCE(v_ls.stop_resume_equity_long, 0) THEN
            UPDATE logic_securities
            SET real_trading_paused_long = FALSE,
                stop_resume_equity_long = NULL,
                stop_resume_baseline_long = NULL,
                stop_resume_triggered_at_long = NULL,
                real_trading_paused = COALESCE(real_trading_paused_short, FALSE),
                stop_resume_equity = CASE
                    WHEN COALESCE(real_trading_paused_short, FALSE) THEN stop_resume_equity
                    ELSE NULL
                END,
                stop_resume_baseline = CASE
                    WHEN COALESCE(real_trading_paused_short, FALSE) THEN stop_resume_baseline
                    ELSE NULL
                END,
                stop_resume_triggered_at = CASE
                    WHEN COALESCE(real_trading_paused_short, FALSE) THEN stop_resume_triggered_at
                    ELSE NULL
                END
            WHERE logic_id = p_logic_id
              AND security_id = p_security_id;

            PERFORM logic_trade_log(
                p_logic_id,
                'stop.resume',
                format(
                    'Возобновление реальной Long sec=%s (baseline=%s shadow=%s target=%s)',
                    p_security_id,
                    v_ls.stop_resume_baseline_long,
                    v_shadow_track,
                    v_ls.stop_resume_equity_long
                ),
                jsonb_build_object(
                    'security_id', p_security_id,
                    'position_side', 'long',
                    'baseline', v_ls.stop_resume_baseline_long,
                    'shadow_track', v_shadow_track,
                    'target', v_ls.stop_resume_equity_long
                ),
                p_security_id,
                p_timeframe_id
            );
            v_resumed := TRUE;
            v_paused_long := FALSE;
        END IF;
    END IF;

    IF v_paused_short
       AND v_ls.stop_resume_equity_short IS NOT NULL
       AND v_ls.stop_resume_baseline_short IS NOT NULL THEN
        v_shadow_track := logic_security_side_track_value(
            p_logic_id, p_security_id, p_timeframe_id, TRUE, 'short'
        );
        IF COALESCE(v_ls.stop_resume_baseline_short, 0) + COALESCE(v_shadow_track, 0)
           >= COALESCE(v_ls.stop_resume_equity_short, 0) THEN
            UPDATE logic_securities
            SET real_trading_paused_short = FALSE,
                stop_resume_equity_short = NULL,
                stop_resume_baseline_short = NULL,
                stop_resume_triggered_at_short = NULL,
                real_trading_paused = COALESCE(real_trading_paused_long, FALSE),
                stop_resume_equity = CASE
                    WHEN COALESCE(real_trading_paused_long, FALSE) THEN stop_resume_equity
                    ELSE NULL
                END,
                stop_resume_baseline = CASE
                    WHEN COALESCE(real_trading_paused_long, FALSE) THEN stop_resume_baseline
                    ELSE NULL
                END,
                stop_resume_triggered_at = CASE
                    WHEN COALESCE(real_trading_paused_long, FALSE) THEN stop_resume_triggered_at
                    ELSE NULL
                END
            WHERE logic_id = p_logic_id
              AND security_id = p_security_id;

            PERFORM logic_trade_log(
                p_logic_id,
                'stop.resume',
                format(
                    'Возобновление реальной Short sec=%s (baseline=%s shadow=%s target=%s)',
                    p_security_id,
                    v_ls.stop_resume_baseline_short,
                    v_shadow_track,
                    v_ls.stop_resume_equity_short
                ),
                jsonb_build_object(
                    'security_id', p_security_id,
                    'position_side', 'short',
                    'baseline', v_ls.stop_resume_baseline_short,
                    'shadow_track', v_shadow_track,
                    'target', v_ls.stop_resume_equity_short
                ),
                p_security_id,
                p_timeframe_id
            );
            v_resumed := TRUE;
        END IF;
    END IF;

    RETURN v_resumed;
END;
$$;

CREATE OR REPLACE FUNCTION logic_check_portfolio_resume(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_shadow_pnl NUMERIC;
    v_track NUMERIC;
BEGIN
    SELECT
        COALESCE(portfolio_trading_paused, FALSE) AS paused,
        portfolio_stop_resume_equity AS target,
        portfolio_stop_resume_baseline AS baseline
    INTO v_logic
    FROM logics
    WHERE id = p_logic_id;

    IF NOT FOUND OR NOT v_logic.paused THEN
        RETURN FALSE;
    END IF;
    IF v_logic.target IS NULL OR v_logic.baseline IS NULL THEN
        RETURN FALSE;
    END IF;

    v_shadow_pnl := logic_portfolio_shadow_pnl(p_logic_id);
    v_track := COALESCE(v_logic.baseline, 0) + COALESCE(v_shadow_pnl, 0);

    IF v_track >= COALESCE(v_logic.target, 0) THEN
        UPDATE logics
        SET portfolio_trading_paused = FALSE,
            portfolio_stop_resume_equity = NULL,
            portfolio_stop_resume_baseline = NULL,
            portfolio_stop_resume_at = NULL,
            portfolio_equity_peak = GREATEST(
                COALESCE(portfolio_equity_peak, 0),
                COALESCE(v_logic.target, 0),
                COALESCE(v_track, 0)
            )
        WHERE id = p_logic_id;

        PERFORM logic_trade_log(
            p_logic_id,
            'stop.portfolio_resume',
            format(
                'Возобновление реальной торговли портфеля (baseline=%s shadow=%s track=%s target=%s)',
                v_logic.baseline, v_shadow_pnl, v_track, v_logic.target
            ),
            jsonb_build_object(
                'baseline', v_logic.baseline,
                'shadow_pnl', v_shadow_pnl,
                'track', v_track,
                'target', v_logic.target
            ),
            NULL,
            p_timeframe_id
        );
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$;

-- ============================================
-- Linear Take Profit on whole portfolio with renewal (portfolio_ltp_renew)
-- Порог: (equity − initial) / initial (%) >= base_annual_rate×годы + TP%
-- Взведение → закрытие всех на падении equity с пика → portfolio pause/shadow → renew
-- Сброс взведения при track% < линейной базы (без TP%)
-- ============================================

CREATE OR REPLACE FUNCTION logic_linear_elapsed_year_fraction(
    p_logic_id INTEGER,
    p_asof TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_start TIMESTAMP;
BEGIN
    SELECT MIN(lt.bar_dt)
    INTO v_start
    FROM logic_trades lt
    WHERE lt.logic_id = p_logic_id
      AND lt.is_test = COALESCE(p_is_test, FALSE)
      AND (p_run_id IS NULL OR lt.run_id = p_run_id)
      AND COALESCE(lt.is_shadow, FALSE) = FALSE
      AND lt.status IN ('filled', 'submitted');

    IF v_start IS NULL THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(
        0,
        EXTRACT(EPOCH FROM (COALESCE(p_asof, clock_timestamp()) - v_start))
            / (365.25 * 24 * 3600)
    );
END;
$$;

COMMENT ON FUNCTION logic_linear_elapsed_year_fraction(INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'Доля года с первой боевой/тестовой сделки логики (для линейного роста initial_balance).';

CREATE OR REPLACE FUNCTION logic_linear_base_pct(
    p_logic_id INTEGER,
    p_asof TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_rate NUMERIC;
    v_frac NUMERIC;
BEGIN
    v_rate := COALESCE(get_logic_param_numeric(p_logic_id, 'base_annual_rate_pct', 20), 20);
    IF v_rate < 0 THEN
        v_rate := 0;
    END IF;
    v_frac := logic_linear_elapsed_year_fraction(p_logic_id, p_asof, p_is_test, p_run_id);
    RETURN v_rate * v_frac;
END;
$$;

COMMENT ON FUNCTION logic_linear_base_pct(INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'Линейный % роста initial: base_annual_rate_pct × (дни сделок / 365.25).';

CREATE OR REPLACE FUNCTION logic_portfolio_track_pct_of_initial(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_initial NUMERIC;
    v_equity NUMERIC;
BEGIN
    v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', NULL);
    IF v_initial IS NULL OR v_initial <= 0 THEN
        RETURN NULL;
    END IF;
    v_equity := logic_portfolio_equity(p_logic_id, p_timeframe_id);
    RETURN (COALESCE(v_equity, 0) - v_initial) / v_initial * 100.0;
END;
$$;

COMMENT ON FUNCTION logic_portfolio_track_pct_of_initial(INTEGER, INTEGER) IS
'Прирост equity портфеля в % от initial_balance (бой).';

CREATE OR REPLACE FUNCTION logic_portfolio_has_open_positions(
    p_logic_id INTEGER,
    p_is_test BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_sec RECORD;
BEGIN
    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
          AND NOT logic_is_cash_fund_security(ls.security_id)
    LOOP
        IF logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE, p_is_test) > 0
           OR logic_short_position_qty(p_logic_id, v_sec.security_id, FALSE, p_is_test) > 0
        THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    RETURN FALSE;
END;
$$;

-- Бой: линейный TP по всему портфелю
CREATE OR REPLACE FUNCTION logic_process_linear_tp_portfolio(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_tp_extra_pct NUMERIC,
    p_bar_dt TIMESTAMP
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_track_pct NUMERIC;
    v_base_pct NUMERIC;
    v_arm_pct NUMERIC;
    v_equity NUMERIC;
    v_actions INTEGER := 0;
    v_closed INTEGER;
    v_track_before NUMERIC;
    v_track_after NUMERIC;
    v_sec RECORD;
    v_has_pos BOOLEAN;
BEGIN
    IF p_tp_extra_pct IS NULL OR p_tp_extra_pct <= 0 THEN
        RETURN 0;
    END IF;

    SELECT
        COALESCE(l.portfolio_trading_paused, FALSE) AS paused,
        COALESCE(l.portfolio_linear_tp_armed, FALSE) AS armed,
        l.portfolio_linear_tp_peak_equity AS peak_equity,
        l.portfolio_linear_tp_arm_bar_dt AS arm_bar_dt
    INTO v_logic
    FROM logics l
    WHERE l.id = p_logic_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- Пауза после продажи — возобновление через logic_check_portfolio_resume
    IF v_logic.paused THEN
        RETURN 0;
    END IF;

    v_track_pct := logic_portfolio_track_pct_of_initial(p_logic_id, p_timeframe_id);
    IF v_track_pct IS NULL THEN
        RETURN 0;
    END IF;

    v_equity := logic_portfolio_equity(p_logic_id, p_timeframe_id);
    v_base_pct := logic_linear_base_pct(p_logic_id, p_bar_dt, FALSE, NULL);
    v_arm_pct := v_base_pct + p_tp_extra_pct;
    v_has_pos := logic_portfolio_has_open_positions(p_logic_id, FALSE);

    -- Ниже линейной базы → снять взведение
    IF v_track_pct < v_base_pct THEN
        IF v_logic.armed THEN
            UPDATE logics
            SET portfolio_linear_tp_armed = FALSE,
                portfolio_linear_tp_peak_equity = NULL,
                portfolio_linear_tp_arm_bar_dt = NULL
            WHERE id = p_logic_id;
            PERFORM logic_trade_log(
                p_logic_id, 'take_profit.linear.disarm',
                format(
                    'Линейный TP портфеля снят: track%%=%s < base%%=%s',
                    round(v_track_pct, 4), round(v_base_pct, 4)
                ),
                jsonb_build_object(
                    'track_pct', v_track_pct,
                    'base_pct', v_base_pct,
                    'arm_pct', v_arm_pct,
                    'equity', v_equity
                ),
                NULL, p_timeframe_id
            );
            v_actions := v_actions + 1;
        END IF;
        RETURN v_actions;
    END IF;

    -- Взведение
    IF NOT v_logic.armed AND v_track_pct >= v_arm_pct AND v_has_pos THEN
        UPDATE logics
        SET portfolio_linear_tp_armed = TRUE,
            portfolio_linear_tp_peak_equity = v_equity,
            portfolio_linear_tp_arm_bar_dt = p_bar_dt
        WHERE id = p_logic_id;
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.arm',
            format(
                'Линейный TP портфеля взведён: track%%=%s >= base+tp%%=%s, equity=%s',
                round(v_track_pct, 4), round(v_arm_pct, 4), round(v_equity, 2)
            ),
            jsonb_build_object(
                'track_pct', v_track_pct,
                'base_pct', v_base_pct,
                'arm_pct', v_arm_pct,
                'equity', v_equity
            ),
            NULL, p_timeframe_id
        );
        RETURN v_actions + 1;
    END IF;

    IF NOT v_logic.armed THEN
        RETURN v_actions;
    END IF;

    -- Взведён: падение equity с пика → закрыть всё + portfolio pause/renew
    IF v_logic.peak_equity IS NOT NULL
       AND v_equity < v_logic.peak_equity
       AND v_has_pos
       AND (v_logic.arm_bar_dt IS NULL OR p_bar_dt > v_logic.arm_bar_dt)
    THEN
        v_track_before := v_equity;
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.trigger',
            format(
                'Линейный TP портфеля: equity %s < peak %s, track%%=%s',
                round(v_equity, 2), round(v_logic.peak_equity, 2), round(v_track_pct, 4)
            ),
            jsonb_build_object(
                'equity', v_equity,
                'peak_equity', v_logic.peak_equity,
                'track_pct', v_track_pct,
                'base_pct', v_base_pct,
                'arm_pct', v_arm_pct
            ),
            NULL, p_timeframe_id
        );
        FOR v_sec IN
            SELECT DISTINCT lt.security_id
            FROM logic_trades lt
            WHERE lt.logic_id = p_logic_id
              AND NOT lt.is_shadow
              AND NOT lt.is_test
              AND lt.status IN ('filled', 'submitted')
              AND NOT logic_is_cash_fund_security(lt.security_id)
        LOOP
            v_closed := logic_close_security_positions_market(
                p_logic_id, v_sec.security_id, FALSE,
                format('take_profit:portfolio_ltp_renew (%s%%)', round(v_track_pct, 2))
            );
            v_actions := v_actions + COALESCE(v_closed, 0);
        END LOOP;
        v_track_after := logic_portfolio_equity(p_logic_id, p_timeframe_id);
        UPDATE logics
        SET portfolio_trading_paused = TRUE,
            portfolio_stop_resume_equity = v_track_before,
            portfolio_stop_resume_baseline = v_track_after,
            portfolio_stop_resume_at = CURRENT_TIMESTAMP,
            portfolio_linear_tp_armed = FALSE,
            portfolio_linear_tp_peak_equity = NULL,
            portfolio_linear_tp_arm_bar_dt = NULL
        WHERE id = p_logic_id;
        RETURN v_actions + 1;
    END IF;

    -- Equity не упала — подтянуть пик
    IF v_equity > COALESCE(v_logic.peak_equity, 0) THEN
        UPDATE logics
        SET portfolio_linear_tp_peak_equity = v_equity
        WHERE id = p_logic_id;
    END IF;

    RETURN v_actions;
END;
$$;

COMMENT ON FUNCTION logic_process_linear_tp_portfolio(INTEGER, INTEGER, NUMERIC, TIMESTAMP) IS
'Бой: линейный TP по всему портфелю — взведение / закрытие на падении equity / renew как portfolio_resume';

-- Совместимость: старый per-paper обработчик больше не используется
CREATE OR REPLACE FUNCTION logic_process_linear_tp_security(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_tp_extra_pct NUMERIC,
    p_bar_dt TIMESTAMP,
    p_price NUMERIC
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
BEGIN
    RETURN 0;
END;
$$;

COMMENT ON FUNCTION logic_process_linear_tp_security(INTEGER, INTEGER, INTEGER, NUMERIC, TIMESTAMP, NUMERIC) IS
'Deprecated: линейный TP перенесён на portfolio_ltp_renew (logic_process_linear_tp_portfolio).';

CREATE OR REPLACE FUNCTION process_logic_stops(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_stop RECORD;
    v_tp RECORD;
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
    v_price NUMERIC;
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
                IF logic_check_portfolio_resume(p_logic_id, v_tf_id) THEN
                    v_actions := v_actions + 1;
                END IF;
                FOR v_sec IN
                    SELECT ls.security_id
                    FROM logic_securities ls
                    WHERE ls.logic_id = p_logic_id
                      AND ls.is_active = TRUE
                      AND (
                          ls.real_trading_paused = TRUE
                          OR ls.real_trading_paused_long = TRUE
                          OR ls.real_trading_paused_short = TRUE
                          OR ls.real_trading_inverted = TRUE
                      )
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
              AND (
                  ls.real_trading_paused = TRUE
                  OR ls.real_trading_paused_long = TRUE
                  OR ls.real_trading_paused_short = TRUE
                  OR ls.real_trading_inverted = TRUE
              )
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

    IF logic_check_portfolio_resume(p_logic_id, v_tf_id) THEN
        v_actions := v_actions + 1;
    END IF;

    -- SL может отсутствовать — линейный TP всё равно обрабатываем ниже
    IF v_stop.id IS NOT NULL AND v_stop.value_unit <> 'percent' THEN
        PERFORM logic_trade_log(
            p_logic_id, 'stop.skip',
            format('Стоп-лосс: единица %s пока не поддерживается (только percent)', v_stop.value_unit),
            NULL, NULL, v_tf_id
        );
    ELSIF v_stop.id IS NOT NULL AND v_stop.scope_type = 'portfolio' THEN
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
                  AND NOT logic_is_cash_fund_security(lt.security_id)
            LOOP
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
            END LOOP;
        END IF;
    ELSIF v_stop.id IS NOT NULL AND v_stop.scope_type = 'portfolio_resume' THEN
        -- Уже в паузе — только проверка возобновления (выше); не триггерим повторно.
        IF EXISTS (
            SELECT 1 FROM logics l
            WHERE l.id = p_logic_id AND COALESCE(l.portfolio_trading_paused, FALSE)
        ) THEN
            NULL;
        ELSE
            v_port_dd := logic_portfolio_peak_drawdown_pct(p_logic_id, v_tf_id);
            IF v_port_dd >= v_stop.value THEN
                v_track_before := logic_portfolio_equity(p_logic_id, v_tf_id);
                PERFORM logic_trade_log(
                    p_logic_id, 'stop.trigger',
                    format(
                        'Портфельный SL с возобновлением: просадка от пика %s%% >= %s%%, equity=%s',
                        round(v_port_dd, 4), v_stop.value, round(COALESCE(v_track_before, 0), 2)
                    ),
                    jsonb_build_object(
                        'drawdown_pct', v_port_dd,
                        'threshold', v_stop.value,
                        'scope', 'portfolio_resume',
                        'equity_before', v_track_before
                    ),
                    NULL, v_tf_id
                );
                FOR v_sec IN
                    SELECT DISTINCT lt.security_id
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id
                      AND NOT lt.is_shadow
                      AND NOT lt.is_test
                      AND lt.status IN ('filled', 'submitted')
                      AND NOT logic_is_cash_fund_security(lt.security_id)
                LOOP
                    v_closed := logic_close_security_positions_market(
                        p_logic_id, v_sec.security_id, FALSE
                    );
                    v_actions := v_actions + v_closed;
                END LOOP;
                v_track_after := logic_portfolio_equity(p_logic_id, v_tf_id);
                UPDATE logics
                SET portfolio_trading_paused = TRUE,
                    portfolio_stop_resume_equity = v_track_before,
                    portfolio_stop_resume_baseline = v_track_after,
                    portfolio_stop_resume_at = CURRENT_TIMESTAMP
                WHERE id = p_logic_id;
                v_actions := v_actions + 1;
            END IF;
        END IF;
    ELSIF v_stop.id IS NOT NULL THEN
        FOR v_sec IN
            SELECT ls.security_id
            FROM logic_securities ls
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
              AND NOT logic_is_cash_fund_security(ls.security_id)
        LOOP
            IF v_stop.scope_type = 'security_resume' THEN
                -- Просадка и пауза по стороне (long/short) независимо.
                DECLARE
                    v_side_name TEXT;
                    v_side_paused BOOLEAN;
                BEGIN
                    FOREACH v_side_name IN ARRAY ARRAY['long', 'short']
                    LOOP
                        SELECT CASE
                            WHEN v_side_name = 'long'
                                THEN COALESCE(ls.real_trading_paused_long, FALSE)
                            ELSE COALESCE(ls.real_trading_paused_short, FALSE)
                        END
                        INTO v_side_paused
                        FROM logic_securities ls
                        WHERE ls.logic_id = p_logic_id
                          AND ls.security_id = v_sec.security_id;

                        IF COALESCE(v_side_paused, FALSE) THEN
                            CONTINUE;
                        END IF;

                        v_drawdown := logic_security_side_drawdown_pct(
                            p_logic_id, v_sec.security_id, v_tf_id, FALSE, v_side_name
                        );
                        IF v_drawdown < v_stop.value THEN
                            CONTINUE;
                        END IF;

                        v_track_before := logic_security_side_track_value(
                            p_logic_id, v_sec.security_id, v_tf_id, FALSE, v_side_name
                        );
                        PERFORM logic_trade_log(
                            p_logic_id, 'stop.trigger',
                            format(
                                'SL с возобновлением sec=%s side=%s: просадка %s%% >= %s%%, track=%s',
                                v_sec.security_id, v_side_name,
                                round(v_drawdown, 4), v_stop.value, v_track_before
                            ),
                            jsonb_build_object(
                                'security_id', v_sec.security_id,
                                'position_side', v_side_name,
                                'drawdown_pct', v_drawdown,
                                'scope', 'security_resume',
                                'track_before', v_track_before
                            ),
                            v_sec.security_id, v_tf_id
                        );
                        v_closed := logic_close_security_positions_market(
                            p_logic_id, v_sec.security_id, FALSE,
                            format('stop_loss:security_resume:%s', v_side_name),
                            v_side_name
                        );
                        v_actions := v_actions + v_closed;
                        v_track_after := logic_security_side_track_value(
                            p_logic_id, v_sec.security_id, v_tf_id, FALSE, v_side_name
                        );

                        IF v_side_name = 'long' THEN
                            UPDATE logic_securities
                            SET real_trading_paused_long = TRUE,
                                stop_resume_equity_long = v_track_before,
                                stop_resume_baseline_long = v_track_after,
                                stop_resume_triggered_at_long = CURRENT_TIMESTAMP,
                                real_trading_paused = TRUE
                            WHERE logic_id = p_logic_id
                              AND security_id = v_sec.security_id;
                        ELSE
                            UPDATE logic_securities
                            SET real_trading_paused_short = TRUE,
                                stop_resume_equity_short = v_track_before,
                                stop_resume_baseline_short = v_track_after,
                                stop_resume_triggered_at_short = CURRENT_TIMESTAMP,
                                real_trading_paused = TRUE
                            WHERE logic_id = p_logic_id
                              AND security_id = v_sec.security_id;
                        END IF;
                        v_actions := v_actions + 1;
                    END LOOP;
                END;
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

    -- Линейный TP по всему портфелю с возобновлением
    SELECT * INTO v_tp
    FROM logic_stops ls
    WHERE ls.logic_id = p_logic_id
      AND ls.rule_kind = 'take_profit'
      AND ls.scope_type = 'portfolio_ltp_renew'
      AND ls.is_active = TRUE
    ORDER BY ls.display_order, ls.id
    LIMIT 1;

    IF v_tp.id IS NOT NULL AND v_tp.value_unit = 'percent' THEN
        v_actions := v_actions + COALESCE(
            logic_process_linear_tp_portfolio(
                p_logic_id, v_tf_id, v_tp.value, v_closed_bar_dt
            ),
            0
        );
    END IF;

    PERFORM logic_upsert_param(
        p_logic_id, 'last_stop_bar_dt',
        to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'), 'text'
    );

    RETURN v_actions;
END;
$$;

COMMENT ON FUNCTION process_logic_stops(INTEGER) IS
'Стоп-лоссы + линейный TP (portfolio_ltp_renew); TF из stop_loss_timeframe';
