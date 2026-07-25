-- ============================================
-- Linear Take Profit on whole portfolio with renewal (portfolio_ltp_renew)
-- Порог взведения: track% = (equity−initial)/initial >= base_annual_rate×годы + TP%
-- Пик (всплеск) трейлится вверх; продажа только если откат от пика >= TP% (не любой тик вниз)
-- После продажи — latch: снова взводить только когда track% ушёл ниже arm%
-- Затем portfolio pause/shadow → renew; сброс armed при track% < base%
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
    v_fade_pct NUMERIC;
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
        COALESCE(l.portfolio_linear_tp_latched, FALSE) AS latched,
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

    -- Снять latch после отката ниже линии взведения (ждём следующий всплеск)
    IF v_logic.latched AND v_track_pct < v_arm_pct THEN
        UPDATE logics
        SET portfolio_linear_tp_latched = FALSE
        WHERE id = p_logic_id;
        v_logic.latched := FALSE;
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.unlatch',
            format(
                'Линейный TP: latch снят (track%%=%s < arm%%=%s) — можно снова взводить на всплеске',
                round(v_track_pct, 4), round(v_arm_pct, 4)
            ),
            jsonb_build_object(
                'track_pct', v_track_pct,
                'arm_pct', v_arm_pct,
                'equity', v_equity
            ),
            NULL, p_timeframe_id
        );
        v_actions := v_actions + 1;
    END IF;

    -- Ниже линейной базы → снять взведение (+ latch)
    IF v_track_pct < v_base_pct THEN
        IF v_logic.armed OR v_logic.latched THEN
            UPDATE logics
            SET portfolio_linear_tp_armed = FALSE,
                portfolio_linear_tp_peak_equity = NULL,
                portfolio_linear_tp_arm_bar_dt = NULL,
                portfolio_linear_tp_latched = FALSE
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

    -- Взведение на всплеске (не сразу после предыдущей продажи — нужен unlatch)
    IF NOT v_logic.armed
       AND NOT v_logic.latched
       AND v_track_pct >= v_arm_pct
       AND v_has_pos
    THEN
        UPDATE logics
        SET portfolio_linear_tp_armed = TRUE,
            portfolio_linear_tp_peak_equity = v_equity,
            portfolio_linear_tp_arm_bar_dt = p_bar_dt
        WHERE id = p_logic_id;
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.arm',
            format(
                'Линейный TP портфеля взведён (всплеск): track%%=%s >= arm%%=%s, equity=%s',
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

    -- Взведён: фиксируем всплеск — продаём только при откате от пика >= TP%
    v_fade_pct := 0;
    IF v_logic.peak_equity IS NOT NULL AND v_logic.peak_equity > 0 AND v_equity < v_logic.peak_equity THEN
        v_fade_pct := (v_logic.peak_equity - v_equity) / v_logic.peak_equity * 100.0;
    END IF;

    IF v_logic.peak_equity IS NOT NULL
       AND v_fade_pct >= p_tp_extra_pct
       AND v_has_pos
       AND (v_logic.arm_bar_dt IS NULL OR p_bar_dt > v_logic.arm_bar_dt)
    THEN
        v_track_before := v_equity;
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.trigger',
            format(
                'Линейный TP портфеля: откат от пика %s%% >= %s%% (equity %s, peak %s), track%%=%s',
                round(v_fade_pct, 4), round(p_tp_extra_pct, 4),
                round(v_equity, 2), round(v_logic.peak_equity, 2), round(v_track_pct, 4)
            ),
            jsonb_build_object(
                'equity', v_equity,
                'peak_equity', v_logic.peak_equity,
                'fade_pct', v_fade_pct,
                'tp_extra_pct', p_tp_extra_pct,
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
            portfolio_linear_tp_arm_bar_dt = NULL,
            portfolio_linear_tp_latched = TRUE
        WHERE id = p_logic_id;
        RETURN v_actions + 1;
    END IF;

    -- Новый всплеск — подтянуть пик
    IF v_equity > COALESCE(v_logic.peak_equity, 0) THEN
        UPDATE logics
        SET portfolio_linear_tp_peak_equity = v_equity
        WHERE id = p_logic_id;
    END IF;

    RETURN v_actions;
END;
$$;

COMMENT ON FUNCTION logic_process_linear_tp_portfolio(INTEGER, INTEGER, NUMERIC, TIMESTAMP) IS
'Бой: линейный TP портфеля — взведение на всплеске; продажа при откате от пика >= TP%; latch против чопа; renew как portfolio_resume';

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
