-- ============================================
-- Неторговые периоды логики + закрытие в конце дня
-- ============================================
-- day_of_week: 1=Пн … 7=Вс (ISO). Интервал [time_from, time_to] в MSK.
-- time_to включительно до секунды (сравнение <= time_to).

CREATE OR REPLACE FUNCTION logic_moex_equity_non_trading_template()
RETURNS TABLE (
    day_of_week SMALLINT,
    time_from TIME,
    time_to TIME,
    note TEXT
)
LANGUAGE sql IMMUTABLE AS $$
    -- TQBR основная сессия ≈ 10:00–18:40 МСК (пн–пт).
    -- Неторговые: ночь до открытия, вечер после сессии, выходные целиком.
    SELECT * FROM (VALUES
        (1::SMALLINT, TIME '00:00', TIME '09:59:59', 'Пн до открытия'),
        (1::SMALLINT, TIME '18:40', TIME '23:59:59', 'Пн после сессии'),
        (2::SMALLINT, TIME '00:00', TIME '09:59:59', 'Вт до открытия'),
        (2::SMALLINT, TIME '18:40', TIME '23:59:59', 'Вт после сессии'),
        (3::SMALLINT, TIME '00:00', TIME '09:59:59', 'Ср до открытия'),
        (3::SMALLINT, TIME '18:40', TIME '23:59:59', 'Ср после сессии'),
        (4::SMALLINT, TIME '00:00', TIME '09:59:59', 'Чт до открытия'),
        (4::SMALLINT, TIME '18:40', TIME '23:59:59', 'Чт после сессии'),
        (5::SMALLINT, TIME '00:00', TIME '09:59:59', 'Пт до открытия'),
        (5::SMALLINT, TIME '18:40', TIME '23:59:59', 'Пт после сессии'),
        (6::SMALLINT, TIME '00:00', TIME '23:59:59', 'Суббота'),
        (7::SMALLINT, TIME '00:00', TIME '23:59:59', 'Воскресенье')
    ) AS t(day_of_week, time_from, time_to, note);
$$;

COMMENT ON FUNCTION logic_moex_equity_non_trading_template() IS
'Шаблон неторговых окон TQBR (MOEX акции): вне 10:00–18:40 МСК пн–пт + выходные';

CREATE OR REPLACE FUNCTION logic_apply_moex_non_trading_periods(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_n INTEGER;
BEGIN
    IF p_logic_id IS NULL OR p_logic_id <= 0 THEN
        RAISE EXCEPTION 'logic_id required';
    END IF;

    DELETE FROM logic_non_trading_intervals WHERE logic_id = p_logic_id;

    INSERT INTO logic_non_trading_intervals (
        logic_id, day_of_week, time_from, time_to, note, display_order, is_active
    )
    SELECT
        p_logic_id,
        t.day_of_week,
        t.time_from,
        t.time_to,
        t.note,
        ROW_NUMBER() OVER (ORDER BY t.day_of_week, t.time_from)::INTEGER,
        TRUE
    FROM logic_moex_equity_non_trading_template() t;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION logic_apply_moex_non_trading_periods(INTEGER) IS
'Заменить неторговые интервалы логики шаблоном MOEX TQBR';

CREATE OR REPLACE FUNCTION logic_ensure_non_trading_periods(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_cnt INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_cnt
    FROM logic_non_trading_intervals
    WHERE logic_id = p_logic_id;

    IF v_cnt > 0 THEN
        RETURN v_cnt;
    END IF;

    RETURN logic_apply_moex_non_trading_periods(p_logic_id);
END;
$$;

COMMENT ON FUNCTION logic_ensure_non_trading_periods(INTEGER) IS
'Если у логики нет интервалов — поставить MOEX по умолчанию';

CREATE OR REPLACE FUNCTION logic_is_non_trading_dt(
    p_logic_id INTEGER,
    p_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_use BOOLEAN;
    v_dow SMALLINT;
    v_t TIME;
BEGIN
    v_use := get_logic_param_boolean(p_logic_id, 'use_non_trading_periods', TRUE);
    IF NOT v_use THEN
        RETURN FALSE;
    END IF;

    -- ISO: Monday=1 … Sunday=7 (PostgreSQL DOW: 0=Sun … 6=Sat)
    v_dow := EXTRACT(ISODOW FROM p_dt)::SMALLINT;
    v_t := p_dt::TIME;

    RETURN EXISTS (
        SELECT 1
        FROM logic_non_trading_intervals i
        WHERE i.logic_id = p_logic_id
          AND i.is_active
          AND i.day_of_week = v_dow
          AND v_t >= i.time_from
          AND v_t <= i.time_to
    );
END;
$$;

COMMENT ON FUNCTION logic_is_non_trading_dt(INTEGER, TIMESTAMP) IS
'True если момент в неторговом окне логики (при use_non_trading_periods)';

-- Старт вечернего неторгового окна дня (MSK), или NULL.
CREATE OR REPLACE FUNCTION logic_eod_session_end_dt(
    p_logic_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS TIMESTAMP
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_dow SMALLINT;
    v_day DATE := p_bar_dt::DATE;
    v_from TIME;
BEGIN
    v_dow := EXTRACT(ISODOW FROM p_bar_dt)::SMALLINT;
    SELECT i.time_from
    INTO v_from
    FROM logic_non_trading_intervals i
    WHERE i.logic_id = p_logic_id
      AND i.is_active
      AND i.day_of_week = v_dow
      AND i.time_from >= TIME '12:00'
    ORDER BY i.time_from ASC
    LIMIT 1;

    IF v_from IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN (v_day + v_from);
END;
$$;

COMMENT ON FUNCTION logic_eod_session_end_dt(INTEGER, TIMESTAMP) IS
'Начало вечернего неторгового окна (после основной сессии MOEX)';

-- Момент EOD-сессии (вечернее окно / последняя свеча дня) — без чекбоксов закрытия.
CREATE OR REPLACE FUNCTION logic_is_eod_session_bar(
    p_logic_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_prev_bar_dt TIMESTAMP,
    p_next_bar_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_trigger TIMESTAMP;
BEGIN
    IF get_logic_param_boolean(p_logic_id, 'use_non_trading_periods', TRUE) THEN
        v_trigger := logic_eod_session_end_dt(p_logic_id, p_bar_dt);
        IF v_trigger IS NULL THEN
            RETURN FALSE;
        END IF;
        -- Первая свеча дня с open >= старта вечернего неторгового окна
        RETURN p_bar_dt >= v_trigger
           AND (p_prev_bar_dt IS NULL OR p_prev_bar_dt < v_trigger);
    END IF;

    -- Без неторговых периодов — последняя свеча календарного дня
    IF p_next_bar_dt IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN p_next_bar_dt::DATE > p_bar_dt::DATE;
END;
$$;

COMMENT ON FUNCTION logic_is_eod_session_bar(INTEGER, TIMESTAMP, TIMESTAMP, TIMESTAMP) IS
'True: бар конца торговой сессии (вечернее неторговое окно или последняя свеча дня)';

-- p_prev_bar_dt / p_next_bar_dt — соседние бары прогона (могут быть NULL).
CREATE OR REPLACE FUNCTION logic_is_eod_close_bar(
    p_logic_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_prev_bar_dt TIMESTAMP,
    p_next_bar_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF NOT get_logic_param_boolean(p_logic_id, 'close_positions_eod', FALSE) THEN
        RETURN FALSE;
    END IF;
    RETURN logic_is_eod_session_bar(p_logic_id, p_bar_dt, p_prev_bar_dt, p_next_bar_dt);
END;
$$;

COMMENT ON FUNCTION logic_is_eod_close_bar(INTEGER, TIMESTAMP, TIMESTAMP, TIMESTAMP) IS
'True: закрыть позиции (кроме фондов) на этом баре — конец сессии и close_positions_eod';

-- Календарных дней до экспирации активного контракта; NULL = не фьючерс / вечный / нет даты.
CREATE OR REPLACE FUNCTION logic_futures_days_to_expiry(
    p_security_id INTEGER,
    p_date DATE
)
RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_prefix VARCHAR(50);
    v_note TEXT;
    v_exp DATE;
BEGIN
    IF p_security_id IS NULL OR p_date IS NULL THEN
        RETURN NULL;
    END IF;

    IF NOT logic_security_is_futures(p_security_id) THEN
        RETURN NULL;
    END IF;

    SELECT sp.prefix, sp.note
    INTO v_prefix, v_note
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id
      AND sp.instrument_market = 'futures'
    ORDER BY sp.exchange_id
    LIMIT 1;

    IF is_perpetual_future_group(v_prefix, v_note) THEN
        RETURN NULL;
    END IF;

    SELECT c.expiration_date
    INTO v_exp
    FROM get_future_contract_for_date(p_security_id, p_date) c
    LIMIT 1;

    IF v_exp IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN (v_exp - p_date)::INTEGER;
END;
$$;

COMMENT ON FUNCTION logic_futures_days_to_expiry(INTEGER, DATE) IS
'Дней до экспирации ближайшего контракта (expiration_date − date); NULL для вечных/не-фьючерсов';

-- Живой бой: закрыть фьючерсы с days_to_expiry ≤ N (параметр sell_futures_*).
CREATE OR REPLACE FUNCTION logic_close_futures_near_expiry(
    p_logic_id INTEGER,
    p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_threshold INTEGER;
    v_sec RECORD;
    v_days_left INTEGER;
    v_n INTEGER;
    v_closed INTEGER := 0;
    v_checked INTEGER := 0;
BEGIN
    IF NOT get_logic_param_boolean(p_logic_id, 'sell_futures_before_expiry', FALSE) THEN
        RETURN jsonb_build_object('ok', TRUE, 'closed', 0, 'checked', 0, 'reason', 'disabled');
    END IF;

    v_threshold := GREATEST(
        0,
        ROUND(COALESCE(
            get_logic_param_numeric(p_logic_id, 'sell_futures_days_before_expiry', 3),
            3
        ))::INTEGER
    );

    FOR v_sec IN
        SELECT DISTINCT lt.security_id
        FROM logic_trades lt
        WHERE lt.logic_id = p_logic_id
          AND COALESCE(lt.is_test, FALSE) = FALSE
          AND lt.status IN ('filled', 'submitted')
          AND logic_security_is_futures(lt.security_id)
    LOOP
        IF COALESCE(logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE), 0) <= 0
           AND COALESCE(logic_short_position_qty(p_logic_id, v_sec.security_id, FALSE), 0) <= 0
           AND COALESCE(logic_long_position_qty(p_logic_id, v_sec.security_id, TRUE), 0) <= 0
           AND COALESCE(logic_short_position_qty(p_logic_id, v_sec.security_id, TRUE), 0) <= 0
        THEN
            CONTINUE;
        END IF;

        v_checked := v_checked + 1;
        v_days_left := logic_futures_days_to_expiry(v_sec.security_id, p_as_of_date);
        IF v_days_left IS NULL OR v_days_left > v_threshold THEN
            CONTINUE;
        END IF;

        v_n := logic_close_security_positions_market(
            p_logic_id, v_sec.security_id, FALSE, 'futures_expiry:close'
        );
        v_closed := v_closed + COALESCE(v_n, 0);
        v_n := logic_close_security_positions_market(
            p_logic_id, v_sec.security_id, TRUE, 'futures_expiry:close'
        );
        v_closed := v_closed + COALESCE(v_n, 0);
    END LOOP;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'closed', v_closed,
        'checked', v_checked,
        'days_threshold', v_threshold,
        'as_of_date', p_as_of_date
    );
END;
$$;

COMMENT ON FUNCTION logic_close_futures_near_expiry(INTEGER, DATE) IS
'Бой: на EOD закрыть открытые фьючерсы с days_to_expiry ≤ sell_futures_days_before_expiry';

-- Живой бой: закрыть все позиции кроме TMON/LQDT/SBMM.
CREATE OR REPLACE FUNCTION logic_close_positions_eod_except_funds(p_logic_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT get_logic_param_boolean(p_logic_id, 'close_positions_eod', FALSE) THEN
        RETURN jsonb_build_object('ok', TRUE, 'closed', 0, 'skipped', 0, 'reason', 'disabled');
    END IF;
    RETURN logic_close_all_positions_at_market(p_logic_id, TRUE);
END;
$$;

COMMENT ON FUNCTION logic_close_positions_eod_except_funds(INTEGER) IS
'Бой: закрыть позиции в конце дня, кроме денежных фондов TMON/LQDT/SBMM';
