-- Рейтинг сигнала на логике: боевой (rating) и тестовый (rating_test) раздельно.
-- Не путать с рейтингом индикатора в справочнике indicators.
--
-- Алгоритм успеха (не «просто сработал»):
--   1) сигнал сработал на свече → pending (запомнить цену);
--   2) на СЛЕДУЮЩЕЙ свече TF: ход цены → % годовых за длительность TF;
--   3) сравнить с base_annual_rate_pct логики (по умолчанию 20);
--   4) успех → +1, неуспех → −1 (рейтинг может быть отрицательным).
-- История пишется по (signal × security); график — по бумаге.

DROP FUNCTION IF EXISTS logic_signal_record_fire(INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS logic_signal_rating_resolve_pending(INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_signal_rating_resolve_pending(INTEGER, INTEGER, TIMESTAMP, BOOLEAN);
DROP FUNCTION IF EXISTS logic_signal_rating_resolve_pending(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT);
DROP FUNCTION IF EXISTS logic_backtest_rate_signals(BIGINT, INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_backtest_reset_signal_ratings(INTEGER);
DROP FUNCTION IF EXISTS logic_signal_rating_reset_live(INTEGER);
DROP FUNCTION IF EXISTS logic_signal_rate_bar(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT);
DROP FUNCTION IF EXISTS logic_signal_move_success(TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS logic_signal_move_success(TEXT, TEXT, NUMERIC, NUMERIC, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS logic_signal_annualized_move_pct(NUMERIC, NUMERIC, INTEGER);
DROP FUNCTION IF EXISTS logic_signal_evaluate_at(INTEGER, INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_signal_evaluate_at(INTEGER, INTEGER, INTEGER, TIMESTAMP, BOOLEAN);

CREATE OR REPLACE FUNCTION get_logic_param_boolean(
    p_logic_id INTEGER,
    p_param_key TEXT,
    p_default BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_raw TEXT;
BEGIN
    v_raw := lower(btrim(COALESCE(get_logic_param_text(p_logic_id, p_param_key), '')));
    IF v_raw = '' THEN
        RETURN COALESCE(p_default, FALSE);
    END IF;
    IF v_raw IN ('true', '1', 'yes', 't', 'on', 'y') THEN
        RETURN TRUE;
    END IF;
    IF v_raw IN ('false', '0', 'no', 'f', 'off', 'n') THEN
        RETURN FALSE;
    END IF;
    RETURN COALESCE(p_default, FALSE);
END;
$$;

COMMENT ON FUNCTION get_logic_param_boolean(INTEGER, TEXT, BOOLEAN) IS
'Булев параметр logic_params (true/1/yes …); пусто → p_default';

-- Инверсия сравнения: >=↔<=, >↔< (legacy helper).
-- Param «inversion» / ReverseSides больше НЕ вызывает это на сигналах:
-- для каналов (pp<=LOWER) инверсия условия даёт pp>=LOWER ≈ всегда true → спам сделок.
-- Инверсия логики = только Long↔Short при том же условии.
CREATE OR REPLACE FUNCTION logic_invert_comparison_condition(p_condition TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v TEXT;
BEGIN
    v := btrim(COALESCE(p_condition, ''));
    IF v = '' THEN
        RETURN v;
    END IF;
    -- Сначала двухсимвольные операторы через маркеры
    v := replace(v, '>=', E'\x01');
    v := replace(v, '<=', E'\x02');
    v := replace(v, '<>', E'\x03');
    v := replace(v, '!=', E'\x04');
    -- Односимвольные > и <
    v := replace(v, '>', E'\x05');
    v := replace(v, '<', '>');
    v := replace(v, E'\x05', '<');
    -- Восстановить двухсимвольные с инверсией
    v := replace(v, E'\x01', '<=');
    v := replace(v, E'\x02', '>=');
    v := replace(v, E'\x03', '<>');
    v := replace(v, E'\x04', '!=');
    RETURN v;
END;
$$;

COMMENT ON FUNCTION logic_invert_comparison_condition(TEXT) IS
'Инверсия операторов сравнения в условии сигнала (≥↔≤, >↔<)';

CREATE OR REPLACE FUNCTION logic_signal_annualized_move_pct(
    p_move_pct NUMERIC,
    p_tf_sec INTEGER
)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(p_move_pct, 0)
         * ((365.25 * 24 * 3600) / GREATEST(COALESCE(p_tf_sec, 900), 1)::NUMERIC);
$$;

COMMENT ON FUNCTION logic_signal_annualized_move_pct(NUMERIC, INTEGER) IS
'Переводит % хода за одну свечу TF в эквивалент % годовых';

CREATE OR REPLACE FUNCTION logic_bar_annual_threshold_pct(
    p_tf_sec INTEGER,
    p_base_annual_pct NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(
        0::NUMERIC,
        COALESCE(p_base_annual_pct, 20)
            * (GREATEST(COALESCE(p_tf_sec, 900), 1)::NUMERIC / (365.25 * 24 * 3600))
    );
$$;

COMMENT ON FUNCTION logic_bar_annual_threshold_pct(INTEGER, NUMERIC) IS
'Эквивалент порога на 1 свече: base_annual × (tf_sec / год). Согласован с annualized_move >= base.';

-- Успех: годовая ставка хода в ожидаемую сторону >= base_annual_rate_pct
CREATE OR REPLACE FUNCTION logic_signal_move_success(
    p_position_side TEXT,
    p_signal_kind TEXT,
    p_price_from NUMERIC,
    p_price_to NUMERIC,
    p_tf_sec INTEGER,
    p_base_annual_pct NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_raw_pct NUMERIC;
    v_dir_pct NUMERIC;
    v_annual NUMERIC;
BEGIN
    IF p_price_from IS NULL OR p_price_to IS NULL OR p_price_from <= 0 THEN
        RETURN FALSE;
    END IF;
    v_raw_pct := ((p_price_to - p_price_from) / p_price_from) * 100.0;

    -- Ожидаемое направление: long/trend и short/counter — рост; иначе — падение
    IF lower(p_position_side) = 'long' THEN
        IF lower(p_signal_kind) = 'trend' THEN
            v_dir_pct := v_raw_pct;
        ELSE
            v_dir_pct := -v_raw_pct;
        END IF;
    ELSE
        IF lower(p_signal_kind) = 'trend' THEN
            v_dir_pct := -v_raw_pct;
        ELSE
            v_dir_pct := v_raw_pct;
        END IF;
    END IF;

    v_annual := logic_signal_annualized_move_pct(v_dir_pct, p_tf_sec);
    RETURN v_annual >= COALESCE(p_base_annual_pct, 20);
END;
$$;

COMMENT ON FUNCTION logic_signal_move_success(TEXT, TEXT, NUMERIC, NUMERIC, INTEGER, NUMERIC) IS
'Успех сигнала: (ход к следующей свече → % годовых в сторону сигнала) >= base_annual_rate_pct';

-- Базовый актив фьючерса (security_prefixes.underlying_security_id).
CREATE OR REPLACE FUNCTION logic_future_underlying_security_id(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT sp.underlying_security_id
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id
      AND sp.instrument_market = 'futures'
      AND sp.underlying_security_id IS NOT NULL
    ORDER BY sp.exchange_id
    LIMIT 1;
$$;

COMMENT ON FUNCTION logic_future_underlying_security_id(INTEGER) IS
'security_id базового актива для фьючерса; NULL если не futures или нет mapping';

-- На какой security_id считать сигнал: торгуемая бумага или underlying.
CREATE OR REPLACE FUNCTION logic_signal_eval_security_id(
    p_signal_id INTEGER,
    p_trade_security_id INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_acts TEXT;
    v_und INTEGER;
BEGIN
    SELECT COALESCE(NULLIF(btrim(lis.signal_acts_on), ''), 'security')
    INTO v_acts
    FROM logic_indicator_signals lis
    WHERE lis.id = p_signal_id;

    IF v_acts IS NULL THEN
        RETURN NULL;
    END IF;
    IF v_acts <> 'base_asset' THEN
        RETURN p_trade_security_id;
    END IF;

    v_und := logic_future_underlying_security_id(p_trade_security_id);
    RETURN v_und; -- NULL → evaluate fails (нет базового актива)
END;
$$;

COMMENT ON FUNCTION logic_signal_eval_security_id(INTEGER, INTEGER) IS
'signal_acts_on=security → trade security; base_asset → underlying (или NULL)';

CREATE OR REPLACE FUNCTION logic_signal_evaluate_at(
    p_signal_id INTEGER,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_invert BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    ok BOOLEAN,
    close_price NUMERIC,
    ind_value NUMERIC,
    bar_dt TIMESTAMP,
    formula TEXT,
    position_event TEXT,
    position_side TEXT,
    signal_kind TEXT,
    indicator_id INTEGER
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_sig RECORD;
    v_parsed RECORD;
    v_series TEXT;
    v_bar RECORD;
    v_condition TEXT;
    v_eval_sec INTEGER;
BEGIN
    ok := FALSE;
    SELECT lis.id, lis.formula, lis.position_event, lis.position_side, lis.signal_kind, lis.indicator_id
    INTO v_sig
    FROM logic_indicator_signals lis
    WHERE lis.id = p_signal_id AND lis.is_active = TRUE;
    IF NOT FOUND THEN
        RETURN NEXT;
        RETURN;
    END IF;

    formula := v_sig.formula;
    position_event := v_sig.position_event;
    position_side := v_sig.position_side;
    signal_kind := v_sig.signal_kind;
    indicator_id := v_sig.indicator_id;

    v_eval_sec := logic_signal_eval_security_id(p_signal_id, p_security_id);
    IF v_eval_sec IS NULL THEN
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT * INTO v_parsed FROM parse_signal_formula(v_sig.formula);
    IF NOT COALESCE(v_parsed.valid, FALSE) THEN
        RETURN NEXT;
        RETURN;
    END IF;
    v_series := parse_signal_series(v_parsed.params);
    SELECT * INTO v_bar FROM logic_bar_data_at(
        v_eval_sec, p_tf_id, v_sig.indicator_id, v_series, p_bar_dt
    );
    IF NOT FOUND THEN
        RETURN NEXT;
        RETURN;
    END IF;
    close_price := v_bar.close_price;
    ind_value := v_bar.ind_value;
    bar_dt := v_bar.bar_dt;
    v_condition := v_parsed.condition;
    IF COALESCE(p_invert, FALSE) THEN
        v_condition := logic_invert_comparison_condition(v_condition);
    END IF;
    ok := evaluate_signal_condition(v_condition, v_bar.close_price, v_bar.ind_value);
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION logic_signal_record_fire(
    p_signal_id INTEGER,
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_price NUMERIC,
    p_position_side TEXT,
    p_signal_kind TEXT,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    -- Только запоминаем: ±1 ставится на следующей свече в resolve_pending
    INSERT INTO logic_signal_rating_pending (
        signal_id, logic_id, security_id, timeframe_id,
        bar_dt, price, position_side, signal_kind, is_test, run_id
    )
    VALUES (
        p_signal_id, p_logic_id, p_security_id, p_tf_id,
        p_bar_dt, p_price, p_position_side, p_signal_kind,
        COALESCE(p_is_test, FALSE), p_run_id
    )
    ON CONFLICT (signal_id, security_id, bar_dt, is_test) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION logic_signal_rating_resolve_pending(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_asof_bar_dt TIMESTAMP DEFAULT NULL,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_tf_sec INTEGER;
    v_annual NUMERIC;
    v_pend RECORD;
    v_next_dt TIMESTAMP;
    v_next_close NUMERIC;
    v_ok BOOLEAN;
    v_delta INTEGER;
    v_new_rating INTEGER;
    v_sec_rating INTEGER;
    v_resolved INTEGER := 0;
BEGIN
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_tf_id;
    v_annual := get_logic_param_numeric(p_logic_id, 'base_annual_rate_pct', 20);

    FOR v_pend IN
        SELECT p.*
        FROM logic_signal_rating_pending p
        WHERE p.logic_id = p_logic_id
          AND p.timeframe_id = p_tf_id
          AND p.is_test = COALESCE(p_is_test, FALSE)
          AND (p_run_id IS NULL OR p.run_id IS NULL OR p.run_id = p_run_id)
          AND (p_asof_bar_dt IS NULL OR p.bar_dt < p_asof_bar_dt)
        ORDER BY p.bar_dt, p.id
    LOOP
        IF p_run_id IS NOT NULL
           AND v_resolved > 0
           AND (v_resolved % 50) = 0
           AND logic_backtest_cancel_requested(p_run_id) THEN
            RETURN v_resolved;
        END IF;

        SELECT p.dt, p.close_price
        INTO v_next_dt, v_next_close
        FROM prices p
        WHERE p.security_id = v_pend.security_id
          AND p.timeframe_id = p_tf_id
          AND p.dt > v_pend.bar_dt
          AND (p_asof_bar_dt IS NULL OR p.dt <= p_asof_bar_dt)
        ORDER BY p.dt
        LIMIT 1;

        IF v_next_dt IS NULL THEN
            CONTINUE;
        END IF;

        v_ok := logic_signal_move_success(
            v_pend.position_side, v_pend.signal_kind,
            v_pend.price, v_next_close, v_tf_sec, v_annual
        );
        v_delta := CASE WHEN v_ok THEN 1 ELSE -1 END;

        -- Глобальный рейтинг сигнала (сумма по всем бумагам), может быть < 0
        IF COALESCE(p_is_test, FALSE) THEN
            UPDATE logic_indicator_signals lis
            SET rating_test = lis.rating_test + v_delta
            WHERE lis.id = v_pend.signal_id
            RETURNING rating_test INTO v_new_rating;
        ELSE
            UPDATE logic_indicator_signals lis
            SET rating = lis.rating + v_delta
            WHERE lis.id = v_pend.signal_id
            RETURNING rating INTO v_new_rating;
        END IF;

        -- Рейтинг на бумаге для графика
        SELECT COALESCE((
            SELECT h.rating
            FROM logic_signal_rating_history h
            WHERE h.signal_id = v_pend.signal_id
              AND h.security_id = v_pend.security_id
              AND h.is_test = COALESCE(p_is_test, FALSE)
              AND (p_run_id IS NULL OR h.run_id IS NULL OR h.run_id = p_run_id OR h.run_id = v_pend.run_id)
            ORDER BY h.bar_dt DESC, h.id DESC
            LIMIT 1
        ), 0) + v_delta
        INTO v_sec_rating;

        INSERT INTO logic_signal_rating_history (
            signal_id, logic_id, security_id, run_id, bar_dt, rating, delta, is_test
        )
        VALUES (
            v_pend.signal_id, p_logic_id, v_pend.security_id,
            COALESCE(p_run_id, v_pend.run_id),
            v_next_dt, v_sec_rating, v_delta,
            COALESCE(p_is_test, FALSE)
        );

        DELETE FROM logic_signal_rating_pending WHERE id = v_pend.id;
        v_resolved := v_resolved + 1;
    END LOOP;

    RETURN v_resolved;
END;
$$;

COMMENT ON FUNCTION logic_signal_rating_resolve_pending(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'На следующей свече: годовая ставка хода vs base_annual_rate_pct → ±1; history по бумаге';

-- Общий проход по бару: resolve pending + запись срабатываний (бой или тест)
CREATE OR REPLACE FUNCTION logic_signal_rate_bar(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_sig RECORD;
    v_eval RECORD;
    v_fires INTEGER := 0;
BEGIN
    IF p_run_id IS NOT NULL AND logic_backtest_cancel_requested(p_run_id) THEN
        RETURN 0;
    END IF;

    PERFORM logic_signal_rating_resolve_pending(
        p_logic_id, p_tf_id, p_bar_dt, COALESCE(p_is_test, FALSE), p_run_id
    );

    IF p_run_id IS NOT NULL AND logic_backtest_cancel_requested(p_run_id) THEN
        RETURN v_fires;
    END IF;

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        IF p_run_id IS NOT NULL AND logic_backtest_cancel_requested(p_run_id) THEN
            RETURN v_fires;
        END IF;

        FOR v_sig IN
            SELECT lis.id, lis.position_side, lis.signal_kind
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            ORDER BY lis.display_order, lis.id
        LOOP
            SELECT * INTO v_eval
            FROM logic_signal_evaluate_at(
                v_sig.id, v_sec.security_id, p_tf_id, p_bar_dt
            );
            IF COALESCE(v_eval.ok, FALSE) AND v_eval.close_price IS NOT NULL THEN
                PERFORM logic_signal_record_fire(
                    v_sig.id, p_logic_id, v_sec.security_id, p_tf_id,
                    v_eval.bar_dt, v_eval.close_price,
                    v_sig.position_side, v_sig.signal_kind,
                    COALESCE(p_is_test, FALSE), p_run_id
                );
                v_fires := v_fires + 1;
            END IF;
        END LOOP;
    END LOOP;

    RETURN v_fires;
END;
$$;

COMMENT ON FUNCTION logic_signal_rate_bar(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'По одной свече TF: resolve pending ±1 + record_fire для всех сигналов×бумаг (бой/тест)';

CREATE OR REPLACE FUNCTION logic_backtest_rate_signals(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
BEGIN
    RETURN logic_signal_rate_bar(p_logic_id, p_tf_id, p_bar_dt, TRUE, p_run_id);
END;
$$;

COMMENT ON FUNCTION logic_backtest_rate_signals(BIGINT, INTEGER, INTEGER, TIMESTAMP) IS
'Бэктест: обёртка logic_signal_rate_bar(..., is_test=true)';

CREATE OR REPLACE FUNCTION logic_backtest_reset_signal_ratings(p_logic_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE logic_indicator_signals
    SET rating_test = 0
    WHERE logic_id = p_logic_id;

    DELETE FROM logic_signal_rating_pending
    WHERE logic_id = p_logic_id AND is_test = TRUE;

    DELETE FROM logic_signal_rating_history
    WHERE logic_id = p_logic_id AND is_test = TRUE;
END;
$$;

COMMENT ON FUNCTION logic_backtest_reset_signal_ratings(INTEGER) IS
'Сброс тестового рейтинга и истории перед новым прогоном бэктеста';

CREATE OR REPLACE FUNCTION logic_signal_rating_reset_live(p_logic_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE logic_indicator_signals
    SET rating = 0
    WHERE logic_id = p_logic_id;

    DELETE FROM logic_signal_rating_pending
    WHERE logic_id = p_logic_id AND is_test = FALSE;

    DELETE FROM logic_signal_rating_history
    WHERE logic_id = p_logic_id AND is_test = FALSE;
END;
$$;

COMMENT ON FUNCTION logic_signal_rating_reset_live(INTEGER) IS
'Сброс боевого рейтинга и истории перед предрасчётом при включении логики';

-- Подготовка данных окна предрасчёта: цены + индикаторы сигналов логики
CREATE OR REPLACE PROCEDURE logic_rating_precalc_ensure_data(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_lookback_days INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_sig RECORD;
    v_tf_sec INTEGER;
    v_date_from DATE;
    v_date_to DATE;
    v_point_count INTEGER;
    v_end_dt TIMESTAMP;
    v_days INTEGER;
    v_err TEXT;
BEGIN
    v_days := GREATEST(1, LEAST(90, COALESCE(p_lookback_days, 7)));
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;
    IF v_tf_sec IS NULL OR v_tf_sec <= 0 THEN
        RAISE EXCEPTION 'logic_rating_precalc_ensure_data: неизвестный timeframe_id %', p_timeframe_id;
    END IF;

    v_date_to := CURRENT_DATE;
    -- M1/M2: у T-Bank обычно только текущий день
    IF COALESCE(v_tf_sec, 0) <= 120 THEN
        v_date_from := v_date_to;
    ELSE
        v_date_from := v_date_to - v_days;
    END IF;

    v_point_count := GREATEST(
        logic_trade_sync_point_count(v_tf_sec),
        (CEIL(v_days * 86400.0 / v_tf_sec)::INTEGER) + 80
    );
    v_end_dt := logic_last_closed_bar_dt(v_tf_sec, LOCALTIMESTAMP);

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        ORDER BY ls.display_order, ls.security_id
    LOOP
        BEGIN
            CALL load_prices(v_sec.security_id, p_timeframe_id, v_date_from, v_date_to);
        EXCEPTION
            WHEN undefined_function THEN
                NULL;
            WHEN OTHERS THEN
                v_err := SQLERRM;
                PERFORM logic_trade_log(
                    p_logic_id,
                    'rating.precalc.prices.error',
                    format('Предрасчёт: ошибка цен sec=%s: %s', v_sec.security_id, v_err),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'date_from', v_date_from,
                        'date_to', v_date_to,
                        'error', v_err
                    ),
                    v_sec.security_id,
                    p_timeframe_id
                );
        END;

        FOR v_sig IN
            SELECT DISTINCT
                lis.indicator_id,
                CASE
                    WHEN COALESCE(lis.signal_acts_on, 'security') = 'base_asset'
                        THEN logic_future_underlying_security_id(v_sec.security_id)
                    ELSE v_sec.security_id
                END AS eval_sec_id
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
        LOOP
            IF v_sig.eval_sec_id IS NULL THEN
                CONTINUE;
            END IF;
            BEGIN
                CALL ensure_security_indicator_series(v_sig.eval_sec_id, v_sig.indicator_id);
                CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sig.eval_sec_id);
                CALL sync_security_indicator_series_for_indicator(
                    v_sig.eval_sec_id,
                    v_sig.indicator_id,
                    p_timeframe_id,
                    v_end_dt,
                    v_point_count,
                    FALSE
                );
            EXCEPTION WHEN OTHERS THEN
                v_err := SQLERRM;
                PERFORM logic_trade_log(
                    p_logic_id,
                    'rating.precalc.indicator.error',
                    format('Предрасчёт: ошибка индикатора sec=%s ind=%s: %s',
                           v_sig.eval_sec_id, v_sig.indicator_id, v_err),
                    jsonb_build_object(
                        'security_id', v_sig.eval_sec_id,
                        'trade_security_id', v_sec.security_id,
                        'indicator_id', v_sig.indicator_id,
                        'error', v_err
                    ),
                    v_sec.security_id,
                    p_timeframe_id
                );
            END;
        END LOOP;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_rating_precalc_ensure_data(INTEGER, INTEGER, INTEGER) IS
'Перед боевым предрасчётом рейтинга: load_prices на lookback + sync индикаторов сигналов логики';
