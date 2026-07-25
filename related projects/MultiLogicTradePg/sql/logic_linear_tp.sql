-- ============================================
-- Linear Take Profit on paper with renewal (security_ltp_renew)
-- Порог: track бумаги / initial_balance (%) >= base_annual_rate×годы + TP%
-- Взведение → продажа на падении цены → shadow → возобновление (как security_resume)
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

CREATE OR REPLACE FUNCTION logic_security_track_pct_of_initial(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_initial NUMERIC;
    v_track NUMERIC;
BEGIN
    v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', NULL);
    IF v_initial IS NULL OR v_initial <= 0 THEN
        RETURN NULL;
    END IF;
    v_track := logic_security_track_value(
        p_logic_id, p_security_id, p_timeframe_id, p_is_shadow
    );
    RETURN COALESCE(v_track, 0) / v_initial * 100.0;
END;
$$;

COMMENT ON FUNCTION logic_security_track_pct_of_initial(INTEGER, INTEGER, INTEGER, BOOLEAN) IS
'Трек бумаги (FINRES) в % от initial_balance логики (бой).';

-- Бой: один бар / одна бумага для security_ltp_renew
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
DECLARE
    v_ls RECORD;
    v_track_pct NUMERIC;
    v_base_pct NUMERIC;
    v_arm_pct NUMERIC;
    v_actions INTEGER := 0;
    v_closed INTEGER;
    v_track_before NUMERIC;
    v_track_after NUMERIC;
    v_has_pos BOOLEAN;
BEGIN
    IF logic_is_cash_fund_security(p_security_id) THEN
        RETURN 0;
    END IF;
    IF p_price IS NULL OR p_price <= 0 OR p_tp_extra_pct IS NULL OR p_tp_extra_pct <= 0 THEN
        RETURN 0;
    END IF;

    SELECT
        COALESCE(ls.real_trading_paused, FALSE) AS paused,
        COALESCE(ls.linear_tp_armed, FALSE) AS armed,
        ls.linear_tp_last_price,
        ls.linear_tp_arm_bar_dt
    INTO v_ls
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id AND ls.security_id = p_security_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- Пауза после продажи — возобновление уже в process_logic_stops
    IF v_ls.paused THEN
        RETURN 0;
    END IF;

    v_track_pct := logic_security_track_pct_of_initial(
        p_logic_id, p_security_id, p_timeframe_id, FALSE
    );
    IF v_track_pct IS NULL THEN
        RETURN 0;
    END IF;

    v_base_pct := logic_linear_base_pct(p_logic_id, p_bar_dt, FALSE, NULL);
    v_arm_pct := v_base_pct + p_tp_extra_pct;

    v_has_pos :=
        logic_long_position_qty(p_logic_id, p_security_id, FALSE, FALSE) > 0
        OR logic_short_position_qty(p_logic_id, p_security_id, FALSE, FALSE) > 0;

    -- Ниже линейной базы → полное снятие взведения (логика идёт дальше)
    IF v_track_pct < v_base_pct THEN
        IF v_ls.armed THEN
            UPDATE logic_securities
            SET linear_tp_armed = FALSE,
                linear_tp_last_price = NULL,
                linear_tp_arm_bar_dt = NULL
            WHERE logic_id = p_logic_id AND security_id = p_security_id;
            PERFORM logic_trade_log(
                p_logic_id, 'take_profit.linear.disarm',
                format(
                    'Линейный TP снят sec=%s: track%%=%s < base%%=%s',
                    p_security_id, round(v_track_pct, 4), round(v_base_pct, 4)
                ),
                jsonb_build_object(
                    'security_id', p_security_id,
                    'track_pct', v_track_pct,
                    'base_pct', v_base_pct,
                    'arm_pct', v_arm_pct
                ),
                p_security_id, p_timeframe_id
            );
            v_actions := v_actions + 1;
        END IF;
        RETURN v_actions;
    END IF;

    -- Взведение
    IF NOT v_ls.armed AND v_track_pct >= v_arm_pct AND v_has_pos THEN
        UPDATE logic_securities
        SET linear_tp_armed = TRUE,
            linear_tp_last_price = p_price,
            linear_tp_arm_bar_dt = p_bar_dt
        WHERE logic_id = p_logic_id AND security_id = p_security_id;
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.arm',
            format(
                'Линейный TP взведён sec=%s: track%%=%s >= base+tp%%=%s, price=%s',
                p_security_id, round(v_track_pct, 4), round(v_arm_pct, 4), p_price
            ),
            jsonb_build_object(
                'security_id', p_security_id,
                'track_pct', v_track_pct,
                'base_pct', v_base_pct,
                'arm_pct', v_arm_pct,
                'price', p_price
            ),
            p_security_id, p_timeframe_id
        );
        RETURN v_actions + 1;
    END IF;

    IF NOT v_ls.armed THEN
        RETURN v_actions;
    END IF;

    -- Взведён: падение цены → продажа + shadow renew
    IF v_ls.linear_tp_last_price IS NOT NULL
       AND p_price < v_ls.linear_tp_last_price
       AND v_has_pos
       AND (v_ls.linear_tp_arm_bar_dt IS NULL OR p_bar_dt > v_ls.linear_tp_arm_bar_dt)
    THEN
        v_track_before := logic_security_track_value(
            p_logic_id, p_security_id, p_timeframe_id, FALSE
        );
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.trigger',
            format(
                'Линейный TP: продажа sec=%s price %s < %s, track%%=%s',
                p_security_id, p_price, v_ls.linear_tp_last_price, round(v_track_pct, 4)
            ),
            jsonb_build_object(
                'security_id', p_security_id,
                'price', p_price,
                'last_price', v_ls.linear_tp_last_price,
                'track_pct', v_track_pct,
                'base_pct', v_base_pct,
                'arm_pct', v_arm_pct,
                'track_before', v_track_before
            ),
            p_security_id, p_timeframe_id
        );
        v_closed := logic_close_security_positions_market(
            p_logic_id, p_security_id, FALSE,
            format('take_profit:security_ltp_renew (%s%%)', round(v_track_pct, 2))
        );
        v_actions := v_actions + COALESCE(v_closed, 0);
        v_track_after := logic_security_track_value(
            p_logic_id, p_security_id, p_timeframe_id, FALSE
        );
        UPDATE logic_securities
        SET real_trading_paused = TRUE,
            stop_resume_equity = v_track_before,
            stop_resume_baseline = v_track_after,
            stop_resume_triggered_at = CURRENT_TIMESTAMP,
            linear_tp_armed = FALSE,
            linear_tp_last_price = NULL,
            linear_tp_arm_bar_dt = NULL
        WHERE logic_id = p_logic_id AND security_id = p_security_id;
        RETURN v_actions + 1;
    END IF;

    -- Цена не упала — подтянуть ориентир (трейлинг пика)
    IF p_price > COALESCE(v_ls.linear_tp_last_price, 0) THEN
        UPDATE logic_securities
        SET linear_tp_last_price = p_price
        WHERE logic_id = p_logic_id AND security_id = p_security_id;
    END IF;

    RETURN v_actions;
END;
$$;

COMMENT ON FUNCTION logic_process_linear_tp_security(INTEGER, INTEGER, INTEGER, NUMERIC, TIMESTAMP, NUMERIC) IS
'Бой: линейный TP по бумаге — взведение / продажа на падении / сброс ниже base%.';
