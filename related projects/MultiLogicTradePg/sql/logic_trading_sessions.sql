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

-- p_prev_bar_dt / p_next_bar_dt — соседние бары прогона (могут быть NULL).
CREATE OR REPLACE FUNCTION logic_is_eod_close_bar(
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
    IF NOT get_logic_param_boolean(p_logic_id, 'close_positions_eod', FALSE) THEN
        RETURN FALSE;
    END IF;

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
    -- (нужен следующий бар / теоретический следующий; NULL = неизвестно → не закрывать)
    IF p_next_bar_dt IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN p_next_bar_dt::DATE > p_bar_dt::DATE;
END;
$$;

COMMENT ON FUNCTION logic_is_eod_close_bar(INTEGER, TIMESTAMP, TIMESTAMP, TIMESTAMP) IS
'True: закрыть позиции (кроме фондов) на этом баре — конец сессии или последняя свеча дня';

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
