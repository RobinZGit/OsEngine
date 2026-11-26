-- ============================================
-- Фоновый предрасчёт значений индикаторов (default/average params)
-- Некритичный, прерываемый, запускается из Node scheduler.
-- ============================================

-- Гарантирует профиль параметров по умолчанию для индикатора.
CREATE OR REPLACE FUNCTION ensure_indicator_default_param_profile(p_indicator_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_code VARCHAR(20);
    v_params RECORD;
    v_profile_id INTEGER;
BEGIN
    SELECT id INTO v_profile_id
    FROM indicator_param_profiles
    WHERE indicator_id = p_indicator_id AND is_default = TRUE
    LIMIT 1;
    IF v_profile_id IS NOT NULL THEN
        RETURN v_profile_id;
    END IF;

    SELECT code INTO v_code FROM indicators WHERE id = p_indicator_id;
    IF v_code IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_params FROM resolve_indicator_params(v_code);

    INSERT INTO indicator_param_profiles (
        indicator_id, profile_key,
        param_period, param_fast_period, param_slow_period, param_signal_period,
        param_std_dev, param_k_period, param_d_period, param_smooth,
        is_default, updated_at
    ) VALUES (
        p_indicator_id, 'default',
        v_params.param_period, v_params.param_fast_period, v_params.param_slow_period,
        v_params.param_signal_period, v_params.param_std_dev,
        v_params.param_k_period, v_params.param_d_period, v_params.param_smooth,
        TRUE, CURRENT_TIMESTAMP
    )
    ON CONFLICT (indicator_id, profile_key) DO UPDATE SET
        param_period = EXCLUDED.param_period,
        param_fast_period = EXCLUDED.param_fast_period,
        param_slow_period = EXCLUDED.param_slow_period,
        param_signal_period = EXCLUDED.param_signal_period,
        param_std_dev = EXCLUDED.param_std_dev,
        param_k_period = EXCLUDED.param_k_period,
        param_d_period = EXCLUDED.param_d_period,
        param_smooth = EXCLUDED.param_smooth,
        is_default = TRUE,
        updated_at = CURRENT_TIMESTAMP
    RETURNING id INTO v_profile_id;

    RETURN v_profile_id;
END;
$$;

COMMENT ON FUNCTION ensure_indicator_default_param_profile(INTEGER) IS
'Создаёт/возвращает default/average профиль параметров индикатора для фонового предрасчёта.';

-- Привязывает default-профиль к security_indicator_series БЕЗ перезаписи пользовательских параметров.
-- Параметры серии не трогаем: значения считаем по тем сериям, которые уже соответствуют default-профилю.
CREATE OR REPLACE PROCEDURE ensure_indicator_default_series_profile(
    p_security_id INTEGER,
    p_indicator_id INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_profile_id INTEGER;
BEGIN
    v_profile_id := ensure_indicator_default_param_profile(p_indicator_id);
    IF v_profile_id IS NULL THEN
        RETURN;
    END IF;

    CALL ensure_security_indicator_series(p_security_id, p_indicator_id);

    -- Только помечаем профиль, если параметры серии совпадают с default или профиль ещё не задан.
    UPDATE security_indicator_series sis
    SET param_profile_id = v_profile_id
    FROM indicator_param_profiles pp
    WHERE pp.id = v_profile_id
      AND sis.security_id = p_security_id
      AND sis.indicator_id = p_indicator_id
      AND (
        sis.param_profile_id IS NULL
        OR sis.param_profile_id = v_profile_id
      )
      AND COALESCE(sis.param_period, -1) = COALESCE(pp.param_period, COALESCE(sis.param_period, -1))
      AND COALESCE(sis.param_fast_period, -1) = COALESCE(pp.param_fast_period, COALESCE(sis.param_fast_period, -1))
      AND COALESCE(sis.param_slow_period, -1) = COALESCE(pp.param_slow_period, COALESCE(sis.param_slow_period, -1))
      AND COALESCE(sis.param_signal_period, -1) = COALESCE(pp.param_signal_period, COALESCE(sis.param_signal_period, -1))
      AND COALESCE(sis.param_std_dev::numeric, -1) = COALESCE(pp.param_std_dev::numeric, COALESCE(sis.param_std_dev::numeric, -1))
      AND COALESCE(sis.param_k_period, -1) = COALESCE(pp.param_k_period, COALESCE(sis.param_k_period, -1))
      AND COALESCE(sis.param_d_period, -1) = COALESCE(pp.param_d_period, COALESCE(sis.param_d_period, -1))
      AND COALESCE(sis.param_smooth, -1) = COALESCE(pp.param_smooth, COALESCE(sis.param_smooth, -1));
END;
$$;

COMMENT ON PROCEDURE ensure_indicator_default_series_profile(INTEGER, INTEGER) IS
'Гарантирует серии индикатора на бумаге и помечает default-профиль, не перезаписывая пользовательские параметры.';

-- Окно хранения/догрузки цен для фонового предрасчёта.
CREATE OR REPLACE FUNCTION indicator_precalc_price_window_days(p_timeframe_id INTEGER)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_timeframe_id = 1 THEN 30        -- M1: 1 месяц
        WHEN p_timeframe_id IN (4) THEN 90     -- M5: 3 месяца
        WHEN p_timeframe_id IN (6, 8) THEN 180 -- M15, M30: 6 месяцев
        WHEN p_timeframe_id IN (9, 10, 11, 12, 13) THEN 180 -- H1..H12: 6 месяцев
        WHEN p_timeframe_id >= 14 THEN 180     -- D1+: 6 месяцев
        ELSE 180
    END;
$$;

COMMENT ON FUNCTION indicator_precalc_price_window_days(INTEGER) IS
'Окно цен/хранения для фонового предрасчёта: M1=30д, M5=90д, M15+ =180д.';

-- Приоритет таймфреймов: старшие к младшим, до M15 включительно в первую очередь.
CREATE OR REPLACE FUNCTION indicator_precalc_timeframe_priority(p_timeframe_id INTEGER)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_timeframe_id
        WHEN 21 THEN 10 -- MN6
        WHEN 20 THEN 20 -- MN3
        WHEN 19 THEN 30 -- MN2
        WHEN 18 THEN 40 -- MN1
        WHEN 17 THEN 50 -- W3
        WHEN 16 THEN 60 -- W2
        WHEN 15 THEN 70 -- W1
        WHEN 14 THEN 80 -- D1
        WHEN 13 THEN 90 -- H12
        WHEN 12 THEN 100 -- H8
        WHEN 11 THEN 110 -- H6
        WHEN 10 THEN 120 -- H4
        WHEN 9  THEN 130 -- H2
        WHEN 8  THEN 140 -- H1
        WHEN 7  THEN 150 -- M30
        WHEN 6  THEN 160 -- M15
        WHEN 4  THEN 170 -- M5
        WHEN 1  THEN 180 -- M1
        ELSE 999
    END;
$$;

-- Кандидаты бумаг для фонового предрасчёта: в первую очередь акции.
CREATE OR REPLACE FUNCTION indicator_precalc_security_priority(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT CASE st.name
        WHEN 'Stock' THEN 10
        WHEN 'PreferredStock' THEN 20
        WHEN 'ETF' THEN 30
        WHEN 'Bond' THEN 40
        WHEN 'Futures' THEN 90
        ELSE 100
    END
    FROM securities s
    LEFT JOIN security_types st ON st.id = s.security_type_id
    WHERE s.id = p_security_id;
$$;

-- Удаляет старые цены по правилам роста БД для фонового предрасчёта.
-- Аккуратно: только M1/M5 старше окна, только если нет активного бэктеста.
CREATE OR REPLACE FUNCTION indicator_precalc_cleanup_old_prices(p_batch_limit INTEGER DEFAULT 20000)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_m1_cutoff TIMESTAMP := CURRENT_TIMESTAMP - INTERVAL '30 days';
    v_m5_cutoff TIMESTAMP := CURRENT_TIMESTAMP - INTERVAL '90 days';
    v_deleted_m1 INTEGER := 0;
    v_deleted_m5 INTEGER := 0;
BEGIN
    IF EXISTS (
        SELECT 1 FROM logic_backtest_runs
        WHERE status IN ('pending','loading_prices','loading_indicators','running')
        LIMIT 1
    ) THEN
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'active_backtest');
    END IF;

    WITH del AS (
        DELETE FROM prices
        WHERE id IN (
            SELECT p.id FROM prices p
            WHERE p.timeframe_id = 1 AND p.dt < v_m1_cutoff
            LIMIT GREATEST(1000, COALESCE(p_batch_limit, 20000))
        )
        RETURNING 1
    ) SELECT count(*) INTO v_deleted_m1 FROM del;

    WITH del AS (
        DELETE FROM prices
        WHERE id IN (
            SELECT p.id FROM prices p
            WHERE p.timeframe_id = 4 AND p.dt < v_m5_cutoff
            LIMIT GREATEST(1000, COALESCE(p_batch_limit, 20000))
        )
        RETURNING 1
    ) SELECT count(*) INTO v_deleted_m5 FROM del;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'deleted_m1', v_deleted_m1,
        'deleted_m5', v_deleted_m5,
        'm1_cutoff', v_m1_cutoff,
        'm5_cutoff', v_m5_cutoff
    );
END;
$$;

COMMENT ON FUNCTION indicator_precalc_cleanup_old_prices(INTEGER) IS
'Удаляет старые M1 (>30д) и M5 (>90д) цены пакетами для контроля роста БД.';

-- Один шаг фонового предрасчёта. Возвращает JSONB со статусом.
-- Прерываемый: короткая работа, вызывается периодически Node scheduler.
CREATE OR REPLACE FUNCTION run_indicator_precalc_bg_step(
    p_max_indicators INTEGER DEFAULT 1,
    p_max_securities INTEGER DEFAULT 3,
    p_max_timeframes INTEGER DEFAULT 2,
    p_bars INTEGER DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_started TIMESTAMP := LOCALTIMESTAMP;
    v_ind RECORD;
    v_sec RECORD;
    v_tf RECORD;
    v_processed INTEGER := 0;
    v_pairs INTEGER := 0;
    v_skipped_busy BOOLEAN := FALSE;
    v_msg TEXT := NULL;
    v_window_days INTEGER;
    v_from TIMESTAMP;
    v_activity TEXT;
BEGIN
    IF NOT indicator_precalc_bg_enabled() THEN
        UPDATE indicator_precalc_state
        SET current_activity = NULL, last_status = 'disabled', updated_at = CURRENT_TIMESTAMP
        WHERE id = TRUE;
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'disabled');
    END IF;

    -- Не мешаем активным тестам/боевым расчётам.
    IF EXISTS (
        SELECT 1 FROM logic_backtest_runs
        WHERE status IN ('pending','loading_prices','loading_indicators','running')
        LIMIT 1
    ) THEN
        UPDATE indicator_precalc_state
        SET current_activity = 'Пауза: идёт тест/расчёт', last_status = 'paused', updated_at = CURRENT_TIMESTAMP
        WHERE id = TRUE;
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'active_backtest');
    END IF;

    -- Лёгкая проверка: если есть давно активные запросы кроме нас - уступаем.
    IF EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE state = 'active'
          AND pid <> pg_backend_pid()
          AND query_start < CURRENT_TIMESTAMP - INTERVAL '20 seconds'
          AND coalesce(wait_event_type, '') <> 'Client'
        LIMIT 1
    ) THEN
        UPDATE indicator_precalc_state
        SET current_activity = 'Пауза: БД занята', last_status = 'paused_busy', updated_at = CURRENT_TIMESTAMP
        WHERE id = TRUE;
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'db_busy');
    END IF;

    PERFORM set_config('statement_timeout', '120000', TRUE);
    PERFORM set_config('lock_timeout', '5s', TRUE);

    UPDATE indicator_precalc_state
    SET last_run_at = v_started, last_status = 'running', current_activity = 'Подготовка фонового предрасчёта...', updated_at = CURRENT_TIMESTAMP
    WHERE id = TRUE;

    CREATE TEMP TABLE IF NOT EXISTS tmp_indicator_precalc_targets (
        indicator_id INTEGER,
        security_id INTEGER,
        timeframe_id INTEGER
    ) ON COMMIT DROP;
    TRUNCATE tmp_indicator_precalc_targets;

    -- Индикаторы: сначала с лучшим рейтингом, потом остальные активные.
    FOR v_ind IN
        SELECT i.id AS indicator_id, COALESCE(NULLIF(btrim(i.name),''), i.code, 'indicator#'||i.id::text) AS indicator_name, i.code AS indicator_code
        FROM indicators i
        LEFT JOIN indicator_rating ir ON ir.indicator_id = i.id
        WHERE COALESCE(i.is_active, TRUE)
          AND (COALESCE(btrim(i.formula), '') <> '' OR COALESCE(btrim(i.script), '') <> '')
          AND EXISTS (
              SELECT 1 FROM indicator_value_types ivt
              WHERE ivt.indicator_id = i.id AND ivt.is_threshold = FALSE
          )
        ORDER BY (ir.rating IS NULL), ir.rating DESC NULLS LAST, i.id
        LIMIT GREATEST(1, COALESCE(p_max_indicators, 1))
    LOOP
        v_processed := v_processed + 1;
        PERFORM ensure_indicator_default_param_profile(v_ind.indicator_id);

        -- Бумаги: акции/ETF с недавними ценами, только те, где есть свежие цены.
        FOR v_sec IN
            SELECT s.id AS security_id, COALESCE(NULLIF(btrim(s.name),''), NULLIF(btrim(s.code),''), 'security#'||s.id::text) AS security_name
            FROM securities s
            WHERE EXISTS (
                SELECT 1 FROM prices p
                WHERE p.security_id = s.id AND p.close_price > 0
                  AND p.dt >= CURRENT_TIMESTAMP - INTERVAL '30 days'
            )
            ORDER BY indicator_precalc_security_priority(s.id), s.id
            LIMIT GREATEST(1, COALESCE(p_max_securities, 3))
        LOOP
            -- Таймфреймы: старшие к младшим.
            FOR v_tf IN
                SELECT tf.id AS timeframe_id, COALESCE(NULLIF(btrim(tf.code),''), NULLIF(btrim(tf.name),''), 'tf#'||tf.id::text) AS tf_name
                FROM timeframes tf
                WHERE COALESCE(tf.is_active, TRUE)
                  AND tf.id IN (21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,4,1)
                ORDER BY indicator_precalc_timeframe_priority(tf.id), tf.id
                LIMIT GREATEST(1, COALESCE(p_max_timeframes, 2))
            LOOP
                v_pairs := v_pairs + 1;
                v_activity := format('Расчёт: %s / %s / %s', v_ind.indicator_name, v_sec.security_name, v_tf.tf_name);
                UPDATE indicator_precalc_state
                SET current_activity = v_activity, last_status = 'running', updated_at = CURRENT_TIMESTAMP,
                    cursor_indicator_id = v_ind.indicator_id, cursor_security_id = v_sec.security_id, cursor_timeframe_id = v_tf.timeframe_id
                WHERE id = TRUE;

                BEGIN
                    CALL ensure_indicator_default_series_profile(v_sec.security_id, v_ind.indicator_id);

                    v_window_days := indicator_precalc_price_window_days(v_tf.timeframe_id);
                    v_from := CURRENT_TIMESTAMP - make_interval(days => v_window_days);

                    -- Безопасность: если есть серия с пользовательскими параметрами, не трогаем её.
                    IF EXISTS (
                        SELECT 1
                        FROM security_indicator_series sis
                        LEFT JOIN indicator_param_profiles pp
                          ON pp.indicator_id = sis.indicator_id AND pp.is_default = TRUE
                        WHERE sis.security_id = v_sec.security_id
                          AND sis.indicator_id = v_ind.indicator_id
                          AND sis.is_active = TRUE
                          AND (
                            pp.id IS NULL
                            OR COALESCE(sis.param_period, -1) <> COALESCE(pp.param_period, COALESCE(sis.param_period, -1))
                            OR COALESCE(sis.param_fast_period, -1) <> COALESCE(pp.param_fast_period, COALESCE(sis.param_fast_period, -1))
                            OR COALESCE(sis.param_slow_period, -1) <> COALESCE(pp.param_slow_period, COALESCE(sis.param_slow_period, -1))
                            OR COALESCE(sis.param_signal_period, -1) <> COALESCE(pp.param_signal_period, COALESCE(sis.param_signal_period, -1))
                            OR COALESCE(sis.param_std_dev::numeric, -1) <> COALESCE(pp.param_std_dev::numeric, COALESCE(sis.param_std_dev::numeric, -1))
                            OR COALESCE(sis.param_k_period, -1) <> COALESCE(pp.param_k_period, COALESCE(sis.param_k_period, -1))
                            OR COALESCE(sis.param_d_period, -1) <> COALESCE(pp.param_d_period, COALESCE(sis.param_d_period, -1))
                            OR COALESCE(sis.param_smooth, -1) <> COALESCE(pp.param_smooth, COALESCE(sis.param_smooth, -1))
                          )
                    ) THEN
                        CONTINUE;
                    END IF;

                    CALL sync_security_indicator_series_for_indicator(
                        v_sec.security_id,
                        v_ind.indicator_id,
                        v_tf.timeframe_id,
                        NULL,
                        GREATEST(100, COALESCE(p_bars, 500)),
                        TRUE
                    );

                    UPDATE indicator_values iv
                    SET param_profile_id = pp.id
                    FROM indicator_param_profiles pp
                    WHERE pp.indicator_id = v_ind.indicator_id
                      AND pp.is_default = TRUE
                      AND iv.indicator_id = v_ind.indicator_id
                      AND iv.security_id = v_sec.security_id
                      AND iv.timeframe_id = v_tf.timeframe_id
                      AND iv.dt >= v_from
                      AND iv.param_profile_id IS NULL;
                EXCEPTION WHEN OTHERS THEN
                    v_msg := COALESCE(v_msg, SQLERRM);
                    CONTINUE;
                END;
            END LOOP;
        END LOOP;
    END LOOP;

    UPDATE indicator_precalc_state
    SET last_run_at = v_started,
        last_ok_at = CURRENT_TIMESTAMP,
        last_status = CASE WHEN v_msg IS NULL THEN 'ok' ELSE 'partial' END,
        last_message = COALESCE(v_msg, 'Готово'),
        current_activity = NULL,
        processed_count = processed_count + v_pairs,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = TRUE;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'processed_indicators', v_processed,
        'processed_pairs', v_pairs,
        'message', v_msg,
        'finished_at', CURRENT_TIMESTAMP
    );
END;
$$;

COMMENT ON FUNCTION run_indicator_precalc_bg_step(INTEGER, INTEGER, INTEGER, INTEGER) IS
'Один небольшой шаг фонового предрасчёта индикаторов (default params). Прерываемый, низкий приоритет.';
