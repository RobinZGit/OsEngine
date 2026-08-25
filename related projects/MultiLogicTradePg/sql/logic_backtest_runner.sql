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

    IF v_tf_sec >= 86400 THEN
        v_min_bars := GREATEST(5, (v_span_days * 2) / 5);
    ELSE
        v_min_bars := GREATEST(
            p_min_warmup,
            GREATEST(20, (v_span_days * 8 * 3600 / v_tf_sec / 4)::INTEGER)
        );
    END IF;

    -- Конец периода обязан быть свежим — иначе догружаем.
    IF v_max_date < v_date_to - v_edge_slack THEN
        RETURN FALSE;
    END IF;

    -- Старт истории: строгий край только если баров мало.
    -- У M15 брокер часто отдаёт окно короче date_from (напр. с 27.04 при from=01.04) —
    -- повторный HTTP не удлиняет историю и каждый прогон «висит» на load_prices.
    IF v_min_date > p_date_from + v_edge_slack
       AND v_in_period < v_min_bars THEN
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

    RETURN v_in_period >= v_min_bars;
END;
$$;

COMMENT ON FUNCTION backtest_prices_cached(INTEGER, INTEGER, DATE, DATE, DATE, INTEGER) IS
'True если свечей достаточно до LEAST(date_to, сегодня). Поздний старт истории при достаточном числе баров — кэш (без вечного HTTP).';

CREATE OR REPLACE FUNCTION backtest_indicators_cached(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf_sec INTEGER;
    v_date_to DATE;
    v_span_days INTEGER;
    v_edge_slack INTEGER;
    v_sep_days INTEGER;
    v_min_ind DATE;
    v_max_ind DATE;
    v_min_price DATE;
    v_streak_cnt INTEGER := 0;
    v_has_two_clusters BOOLEAN := FALSE;
BEGIN
    -- Раньше хватало EXISTS(1 точка) → дырявый Stoch (хвост с мая) считался «закэширован».
    -- Теперь: ≥1 серия из 3 баров подряд без пропуска шага TF; на длинном периоде —
    -- две такие серии с разнесением; плюс края рядом с ценами/date_to.
    IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
        RETURN FALSE;
    END IF;

    v_date_to := LEAST(p_date_to, CURRENT_DATE);
    IF p_date_from > v_date_to THEN
        RETURN FALSE;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;
    v_tf_sec := COALESCE(v_tf_sec, 86400);
    v_span_days := GREATEST(1, (v_date_to - p_date_from) + 1);
    v_edge_slack := GREATEST(3, LEAST(14, v_span_days / 20));
    -- Вторую «тройку» требуем, если период ≥ 10 дней; разнос ≈ четверть окна, мин. 3 дня.
    v_sep_days := GREATEST(3, v_span_days / 4);

    SELECT MIN(iv.dt::date), MAX(iv.dt::date)
    INTO v_min_ind, v_max_ind
    FROM indicator_values iv
    WHERE iv.security_id = p_security_id
      AND iv.timeframe_id = p_timeframe_id
      AND iv.indicator_id = p_indicator_id
      AND iv.dt::date BETWEEN p_date_from AND v_date_to;

    IF v_min_ind IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT MIN(p.dt::date)
    INTO v_min_price
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt::date BETWEEN p_date_from AND v_date_to;

    -- Конец индикатора должен быть свежим относительно конца периода (как у цен).
    IF v_max_ind < v_date_to - v_edge_slack THEN
        RETURN FALSE;
    END IF;

    -- Старт: не позже начала ценовой истории (+ slack). Нет цен — относительно date_from.
    IF v_min_price IS NOT NULL THEN
        IF v_min_ind > v_min_price + v_edge_slack THEN
            RETURN FALSE;
        END IF;
    ELSIF v_min_ind > p_date_from + v_edge_slack THEN
        RETURN FALSE;
    END IF;

    -- Серии из ≥3 баров подряд: шаг между соседями ровно tf_sec (без skip).
    WITH pts AS (
        SELECT DISTINCT iv.dt AS dt
        FROM indicator_values iv
        WHERE iv.security_id = p_security_id
          AND iv.timeframe_id = p_timeframe_id
          AND iv.indicator_id = p_indicator_id
          AND iv.dt::date BETWEEN p_date_from AND v_date_to
    ),
    ordered AS (
        SELECT
            dt,
            LAG(dt, 1) OVER (ORDER BY dt) AS prev1,
            LAG(dt, 2) OVER (ORDER BY dt) AS prev2
        FROM pts
    ),
    streaks AS (
        SELECT prev2 AS start_dt, dt AS end_dt
        FROM ordered
        WHERE prev1 IS NOT NULL
          AND prev2 IS NOT NULL
          AND prev1 = dt - make_interval(secs => v_tf_sec)
          AND prev2 = dt - make_interval(secs => v_tf_sec * 2)
    )
    SELECT COUNT(*)::INTEGER INTO v_streak_cnt FROM streaks;

    IF COALESCE(v_streak_cnt, 0) < 1 THEN
        RETURN FALSE;
    END IF;

    -- Длинный период: нужна вторая «тройка» спустя sep_days (если окно позволяет).
    IF v_span_days >= 10 THEN
        WITH pts AS (
            SELECT DISTINCT iv.dt AS dt
            FROM indicator_values iv
            WHERE iv.security_id = p_security_id
              AND iv.timeframe_id = p_timeframe_id
              AND iv.indicator_id = p_indicator_id
              AND iv.dt::date BETWEEN p_date_from AND v_date_to
        ),
        ordered AS (
            SELECT
                dt,
                LAG(dt, 1) OVER (ORDER BY dt) AS prev1,
                LAG(dt, 2) OVER (ORDER BY dt) AS prev2
            FROM pts
        ),
        streaks AS (
            SELECT prev2 AS start_dt
            FROM ordered
            WHERE prev1 IS NOT NULL
              AND prev2 IS NOT NULL
              AND prev1 = dt - make_interval(secs => v_tf_sec)
              AND prev2 = dt - make_interval(secs => v_tf_sec * 2)
        )
        SELECT EXISTS (
            SELECT 1
            FROM streaks a
            JOIN streaks b ON b.start_dt >= a.start_dt + make_interval(days => v_sep_days)
        ) INTO v_has_two_clusters;

        IF NOT COALESCE(v_has_two_clusters, FALSE) THEN
            RETURN FALSE;
        END IF;
    END IF;

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION backtest_indicators_cached(INTEGER, INTEGER, INTEGER, DATE, DATE) IS
'True если индикатор на периоде достаточно полный: ≥3 бара подряд без skip TF; на периоде ≥10д — две такие серии с разнесением; края у цен/date_to. Не путать с EXISTS(1 точка).';

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
    v_mtf RECORD;
    v_mtf_point_count INTEGER;
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

    -- Цены базовых активов для signal_acts_on=base_asset|contango
    FOR v_ind IN
        SELECT DISTINCT logic_future_underlying_security_id(p_security_id) AS und_id
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id
          AND lis.is_active = TRUE
          AND COALESCE(lis.signal_acts_on, 'security') IN ('base_asset', 'contango')
    LOOP
        IF v_ind.und_id IS NULL OR v_ind.und_id = p_security_id THEN
            CONTINUE;
        END IF;
        IF backtest_prices_cached(
            v_ind.und_id, p_tf_id, p_warmup_from, p_date_from, p_date_to, 20
        ) THEN
            CONTINUE;
        END IF;
        BEGIN
            CALL load_prices(v_ind.und_id, p_tf_id, p_warmup_from, p_date_to);
        EXCEPTION WHEN OTHERS THEN
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.prices.error', SQLERRM,
                jsonb_build_object(
                    'security_id', v_ind.und_id,
                    'trade_security_id', p_security_id,
                    'role', 'base_asset'
                ),
                p_security_id, p_tf_id
            );
        END;
    END LOOP;

    -- Синтетика contango (fut − und) как ряд цен для индикаторов
    IF EXISTS (
        SELECT 1 FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active
          AND COALESCE(lis.signal_acts_on, 'security') = 'contango'
    ) THEN
        BEGIN
            PERFORM sync_contango_prices(
                p_security_id, p_tf_id, p_warmup_from::DATE, p_date_to
            );
        EXCEPTION WHEN OTHERS THEN
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.prices.contango_error', SQLERRM,
                jsonb_build_object('security_id', p_security_id, 'role', 'contango'),
                p_security_id, p_tf_id
            );
        END;
    END IF;

    -- Apply @CODE(...period/std_dev...) from signals onto series BEFORE cache skip,
    -- otherwise indicator_values stay on old defaults (e.g. std_dev=2).
    CREATE TEMP TABLE IF NOT EXISTS _bt_ind_fp (
        indicator_id INTEGER PRIMARY KEY,
        params_fp TEXT NOT NULL
    ) ON COMMIT DROP;
    DELETE FROM _bt_ind_fp;

    FOR v_ind IN
        SELECT DISTINCT lis.indicator_id
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
    LOOP
        BEGIN
            CALL ensure_security_indicator_series(p_security_id, v_ind.indicator_id);
            INSERT INTO _bt_ind_fp (indicator_id, params_fp)
            SELECT
                v_ind.indicator_id,
                COALESCE(string_agg(
                    concat_ws('|',
                        param_period::text,
                        param_std_dev::text,
                        param_fast_period::text,
                        param_slow_period::text,
                        param_signal_period::text,
                        param_k_period::text,
                        param_d_period::text,
                        param_smooth::text
                    ),
                    ';' ORDER BY id
                ), '')
            FROM security_indicator_series
            WHERE security_id = p_security_id
              AND indicator_id = v_ind.indicator_id
              AND is_active = TRUE
            ON CONFLICT (indicator_id) DO UPDATE SET params_fp = EXCLUDED.params_fp;
        EXCEPTION WHEN OTHERS THEN
            p_ind_errors := p_ind_errors + 1;
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.indicator.error', SQLERRM,
                jsonb_build_object(
                    'security_id', p_security_id,
                    'indicator_id', v_ind.indicator_id,
                    'phase', 'ensure'
                ),
                p_security_id, p_tf_id
            );
        END;
    END LOOP;

    BEGIN
        CALL logic_apply_indicator_params_from_signals(p_logic_id, p_security_id);
    EXCEPTION WHEN OTHERS THEN
        p_ind_errors := p_ind_errors + 1;
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.indicator.error', SQLERRM,
            jsonb_build_object('security_id', p_security_id, 'phase', 'apply_params'),
            p_security_id, p_tf_id
        );
    END;

    FOR v_ind IN
        SELECT DISTINCT lis.indicator_id
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
    LOOP
        DECLARE
            v_fp_before TEXT;
            v_fp_after TEXT;
            v_params_changed BOOLEAN;
        BEGIN
            SELECT params_fp INTO v_fp_before
            FROM _bt_ind_fp
            WHERE indicator_id = v_ind.indicator_id;

            SELECT COALESCE(string_agg(
                concat_ws('|',
                    param_period::text,
                    param_std_dev::text,
                    param_fast_period::text,
                    param_slow_period::text,
                    param_signal_period::text,
                    param_k_period::text,
                    param_d_period::text,
                    param_smooth::text
                ),
                ';' ORDER BY id
            ), '') INTO v_fp_after
            FROM security_indicator_series
            WHERE security_id = p_security_id
              AND indicator_id = v_ind.indicator_id
              AND is_active = TRUE;

            v_params_changed := COALESCE(v_fp_before, '') IS DISTINCT FROM COALESCE(v_fp_after, '');

            IF NOT v_need_prices
               AND NOT v_params_changed
               AND backtest_indicators_cached(
                   p_security_id, p_tf_id, v_ind.indicator_id, p_date_from, p_date_to
               ) THEN
                p_ind_cached := p_ind_cached + 1;
                CONTINUE;
            END IF;

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

    -- Мультитаймфрейм-сигналы (#843): цены + серии на ТФ каждого tf= сигнала.
    -- Окно точек масштабируется от ТФ логики (M5-сигнал на M15-логике → ×3 баров).
    FOR v_mtf IN
        SELECT x.tf_id, GREATEST(t.sec, 60) AS tf_sec
        FROM logic_signal_extra_tf_ids(p_logic_id, p_tf_id) x
        JOIN timeframes t ON t.id = x.tf_id
    LOOP
        BEGIN
            v_mtf_point_count := CEIL(
                p_point_count * GREATEST((SELECT t.sec FROM timeframes t WHERE t.id = p_tf_id), 60)::NUMERIC
                / v_mtf.tf_sec
            )::INTEGER + 50;

            BEGIN
                CALL load_prices(p_security_id, v_mtf.tf_id, p_warmup_from, p_date_to);
                p_prices_loaded := p_prices_loaded + 1;
            EXCEPTION WHEN OTHERS THEN
                PERFORM logic_backtest_log(
                    p_run_id, p_logic_id, 'backtest.prices.error', SQLERRM,
                    jsonb_build_object('security_id', p_security_id, 'role', 'signal_tf'),
                    p_security_id, v_mtf.tf_id
                );
            END;

            FOR v_ind IN
                SELECT DISTINCT lis.indicator_id
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            LOOP
                BEGIN
                    CALL ensure_security_indicator_series(p_security_id, v_ind.indicator_id);
                    CALL logic_apply_indicator_params_from_signals(p_logic_id, p_security_id);
                    CALL sync_security_indicator_series_for_indicator(
                        p_security_id, v_ind.indicator_id, v_mtf.tf_id, p_end_dt, v_mtf_point_count, FALSE
                    );
                    p_ind_synced := p_ind_synced + 1;
                EXCEPTION WHEN OTHERS THEN
                    p_ind_errors := p_ind_errors + 1;
                    PERFORM logic_backtest_log(
                        p_run_id, p_logic_id, 'backtest.indicator.error', SQLERRM,
                        jsonb_build_object('security_id', p_security_id, 'indicator_id', v_ind.indicator_id, 'role', 'signal_tf'),
                        p_security_id, v_mtf.tf_id
                    );
                END;
            END LOOP;
        EXCEPTION WHEN OTHERS THEN
            p_ind_errors := p_ind_errors + 1;
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.signal_tf.error', SQLERRM,
                jsonb_build_object('security_id', p_security_id, 'tf_id', v_mtf.tf_id),
                p_security_id, v_mtf.tf_id
            );
        END;
    END LOOP;

    -- Индикаторы на базовом активе (signal_acts_on=base_asset)
    FOR v_ind IN
        SELECT DISTINCT
            lis.indicator_id,
            logic_future_underlying_security_id(p_security_id) AS eval_sec_id
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id
          AND lis.is_active = TRUE
          AND COALESCE(lis.signal_acts_on, 'security') = 'base_asset'
    LOOP
        IF v_ind.eval_sec_id IS NULL OR v_ind.eval_sec_id = p_security_id THEN
            CONTINUE;
        END IF;
        BEGIN
            CALL ensure_security_indicator_series(v_ind.eval_sec_id, v_ind.indicator_id);
            CALL logic_apply_indicator_params_from_signals(p_logic_id, v_ind.eval_sec_id);
            CALL sync_security_indicator_series_for_indicator(
                v_ind.eval_sec_id, v_ind.indicator_id, p_tf_id, p_end_dt, p_point_count, FALSE
            );
            p_ind_synced := p_ind_synced + 1;
        EXCEPTION WHEN OTHERS THEN
            p_ind_errors := p_ind_errors + 1;
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.indicator.error', SQLERRM,
                jsonb_build_object(
                    'security_id', v_ind.eval_sec_id,
                    'trade_security_id', p_security_id,
                    'indicator_id', v_ind.indicator_id,
                    'role', 'base_asset'
                ),
                p_security_id, p_tf_id
            );
        END;
    END LOOP;

    -- Индикаторы на контанго (signal_acts_on=contango)
    FOR v_ind IN
        SELECT DISTINCT
            lis.indicator_id,
            logic_contango_security_id(p_security_id) AS eval_sec_id
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id
          AND lis.is_active = TRUE
          AND COALESCE(lis.signal_acts_on, 'security') = 'contango'
    LOOP
        IF v_ind.eval_sec_id IS NULL OR v_ind.eval_sec_id = p_security_id THEN
            CONTINUE;
        END IF;
        BEGIN
            CALL ensure_security_indicator_series(v_ind.eval_sec_id, v_ind.indicator_id);
            CALL logic_apply_indicator_params_from_signals(p_logic_id, v_ind.eval_sec_id);
            CALL sync_security_indicator_series_for_indicator(
                v_ind.eval_sec_id, v_ind.indicator_id, p_tf_id, p_end_dt, p_point_count, FALSE
            );
            p_ind_synced := p_ind_synced + 1;
        EXCEPTION WHEN OTHERS THEN
            p_ind_errors := p_ind_errors + 1;
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.indicator.error', SQLERRM,
                jsonb_build_object(
                    'security_id', v_ind.eval_sec_id,
                    'trade_security_id', p_security_id,
                    'indicator_id', v_ind.indicator_id,
                    'role', 'contango'
                ),
                p_security_id, p_tf_id
            );
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_backtest_ensure_security_data IS
'Backtest: load_prices; sync contango; apply signal params; sync indicators. '
'Also loads/syncs base_asset and contango synthetics for futures signals.';

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
        (SELECT
            COALESCE(real_trading_paused, FALSE)
            OR COALESCE(real_trading_paused_long, FALSE)
            OR COALESCE(real_trading_paused_short, FALSE)
         FROM logic_backtest_security_state
         WHERE run_id = p_run_id AND security_id = p_security_id),
        FALSE
    );
$$;

-- Shadow только для указанной стороны (long/short).
CREATE OR REPLACE FUNCTION logic_backtest_sec_side_shadow(
    p_run_id BIGINT,
    p_security_id INTEGER,
    p_position_side TEXT
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT CASE logic_normalize_position_side(p_position_side)
        WHEN 'long' THEN COALESCE(
            (SELECT
                COALESCE(real_trading_paused_long, FALSE)
                OR (
                    COALESCE(real_trading_paused, FALSE)
                    AND NOT COALESCE(real_trading_paused_long, FALSE)
                    AND NOT COALESCE(real_trading_paused_short, FALSE)
                )
             FROM logic_backtest_security_state
             WHERE run_id = p_run_id AND security_id = p_security_id),
            FALSE
        )
        WHEN 'short' THEN COALESCE(
            (SELECT
                COALESCE(real_trading_paused_short, FALSE)
                OR (
                    COALESCE(real_trading_paused, FALSE)
                    AND NOT COALESCE(real_trading_paused_long, FALSE)
                    AND NOT COALESCE(real_trading_paused_short, FALSE)
                )
             FROM logic_backtest_security_state
             WHERE run_id = p_run_id AND security_id = p_security_id),
            FALSE
        )
        ELSE COALESCE(
            (SELECT COALESCE(real_trading_paused, FALSE)
             FROM logic_backtest_security_state
             WHERE run_id = p_run_id AND security_id = p_security_id),
            FALSE
        )
    END;
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
          AND COALESCE(lt.opt_lane, '') = ''
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
    -- Денежный фонд после покупки не продаём: запрет Close (SL/TP/сигналы/EOD).
    IF v_side_name = 'Close' AND logic_is_cash_fund_security(p_security_id) THEN
        o_trade_id := NULL;
        o_new_balance := v_balance;
        RETURN;
    END IF;
    v_position_event := COALESCE(
        NULLIF(btrim(p_position_event), ''),
        CASE WHEN v_side_name = 'Close' THEN 'close' ELSE 'open' END
    );

    INSERT INTO logic_trades (
        logic_id, account_id, security_id, timeframe_id,
        side_id, action_id, position_event, signal_kind, signal_formula,
        quantity, price, bar_dt, executed_at, is_simulated, is_fictitious,
        is_shadow, is_test, run_id, trade_reason, status, opt_lane
    )
    VALUES (
        p_logic_id, p_account_id, p_security_id, p_timeframe_id,
        p_side_id, p_action_id, v_position_event, p_signal_kind, p_formula,
        p_quantity, p_price, p_bar_dt, p_bar_dt, TRUE, FALSE,
        p_is_shadow, TRUE, p_run_id, p_trade_reason, 'filled', ''
    )
    ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow, opt_lane)
    DO NOTHING
    RETURNING id INTO v_trade_id;

    IF v_trade_id IS NULL THEN
        o_trade_id := NULL;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    -- Shadow: считаем FR/комиссии, но не трогаем тестовый cash (как в бою).
    IF p_is_shadow THEN
        PERFORM logic_trade_finalize(v_trade_id, NULL);
        UPDATE logic_backtest_runs
        SET trades_created = trades_created + 1
        WHERE id = p_run_id;
        o_trade_id := v_trade_id;
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

DROP FUNCTION IF EXISTS logic_backtest_close_security(BIGINT, INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMP, BOOLEAN, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS logic_backtest_close_security(BIGINT, INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMP, BOOLEAN, TEXT, NUMERIC, TEXT);

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
    p_position_side TEXT DEFAULT NULL,
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
    v_side TEXT;
    v_close_long BOOLEAN := TRUE;
    v_close_short BOOLEAN := TRUE;
BEGIN
    -- Денежный фонд остаётся купленным: SL/TP/сигналы не закрывают TMON/LQDT/SBMM.
    IF logic_is_cash_fund_security(p_security_id) THEN
        o_closed := 0;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    v_side := logic_normalize_position_side(p_position_side);
    IF v_side = 'long' THEN
        v_close_short := FALSE;
    ELSIF v_side = 'short' THEN
        v_close_long := FALSE;
    END IF;

    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        o_closed := 0;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    v_long_qty := CASE WHEN v_close_long
        THEN logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE) ELSE 0 END;
    v_short_qty := CASE WHEN v_close_short
        THEN logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE) ELSE 0 END;

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
          AND COALESCE(lt.opt_lane, '') = ''
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

-- Track бумаги в тесте (realized + unrealized на баре), аналог logic_security_track_value.
CREATE OR REPLACE FUNCTION logic_backtest_security_track_value(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
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
      AND lt.is_test = TRUE
      AND lt.is_shadow = p_is_shadow
      AND s.name = 'Close'
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL;

    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN COALESCE(v_realized, 0);
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
          AND COALESCE(lt.opt_lane, '') = ''
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

CREATE OR REPLACE FUNCTION logic_backtest_security_side_drawdown_pct(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
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

    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;

    IF v_side = 'long' THEN
        v_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);
    ELSE
        v_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);
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
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND COALESCE(lt.opt_lane, '') = ''
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

CREATE OR REPLACE FUNCTION logic_backtest_security_side_track_value(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
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
      AND lt.is_test = TRUE
      AND lt.is_shadow = p_is_shadow
      AND s.name = 'Close'
      AND a.name = v_action
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL;

    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
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
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND COALESCE(lt.opt_lane, '') = ''
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
          AND COALESCE(lt.opt_lane, '') = ''
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
    v_initial NUMERIC;
    v_base_pct NUMERIC;
    v_arm_pct NUMERIC;
    v_track NUMERIC;
    v_track_pct NUMERIC;
    v_price NUMERIC;
    v_ltp_armed BOOLEAN;
    v_ltp_latched BOOLEAN;
    v_ltp_last_price NUMERIC;
    v_ltp_arm_bar TIMESTAMP;
    v_fade_pct NUMERIC;
    v_resume_equity NUMERIC;
    v_resume_baseline NUMERIC;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_equity NUMERIC;
    v_tp_latched BOOLEAN;
    v_has_pos BOOLEAN;
    v_port_paused BOOLEAN;
    v_side_name TEXT;
    v_side_paused BOOLEAN;
    v_hwm NUMERIC;
    v_target NUMERIC;
    v_no_reduce BOOLEAN;
BEGIN
    v_no_reduce := COALESCE(
        get_logic_param_boolean(p_logic_id, 'resume_sl_no_reduce', FALSE),
        FALSE
    );
    FOR v_stop IN
        SELECT * FROM logic_stops ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        ORDER BY ls.rule_kind, ls.display_order, ls.id
    LOOP
        IF v_stop.value_unit <> 'percent' THEN
            CONTINUE;
        END IF;

        IF v_stop.rule_kind = 'stop_loss' AND v_stop.scope_type = 'portfolio' THEN
            v_initial := COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0);
            v_equity := COALESCE(
                logic_backtest_portfolio_equity(p_logic_id, p_tf_id, p_bar_dt, p_balance),
                p_balance
            );
            v_drawdown := 0;
            IF v_initial > 0 AND v_equity < v_initial THEN
                v_drawdown := (v_initial - v_equity) / v_initial * 100.0;
            END IF;

            IF v_drawdown >= v_stop.value THEN
                v_reason := format('stop_loss:portfolio (%s%%)', round(v_drawdown, 2));
                FOR v_sec IN
                    SELECT DISTINCT lt.security_id
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                      AND lt.status IN ('filled', 'submitted')
                      AND NOT logic_is_cash_fund_security(lt.security_id)
                LOOP
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                    );
                END LOOP;
            END IF;
        ELSIF v_stop.rule_kind = 'stop_loss' AND v_stop.scope_type = 'portfolio_resume' THEN
            -- Resume check while paused (mirror live: baseline + shadow FR ≥ equity before close)
            SELECT COALESCE(r.portfolio_trading_paused, FALSE) AS portfolio_trading_paused,
                   r.portfolio_stop_resume_equity,
                   r.portfolio_stop_resume_baseline,
                   r.portfolio_equity_peak
            INTO v_state
            FROM logic_backtest_runs r
            WHERE r.id = p_run_id;

            IF COALESCE(v_state.portfolio_trading_paused, FALSE) THEN
                SELECT COALESCE(SUM(lt.financial_result), 0) INTO v_track_after
                FROM logic_trades lt
                WHERE lt.logic_id = p_logic_id
                  AND lt.run_id = p_run_id
                  AND lt.is_test = TRUE
                  AND lt.is_shadow = TRUE
                  AND lt.status IN ('filled', 'submitted')
                  AND lt.financial_result IS NOT NULL;

                IF COALESCE(v_state.portfolio_stop_resume_baseline, 0) + COALESCE(v_track_after, 0)
                   >= COALESCE(v_state.portfolio_stop_resume_equity, 0) THEN
                    UPDATE logic_backtest_runs
                    SET portfolio_trading_paused = FALSE,
                        portfolio_stop_resume_equity = NULL,
                        portfolio_stop_resume_baseline = NULL,
                        portfolio_equity_peak = GREATEST(
                            COALESCE(portfolio_equity_peak, 0),
                            COALESCE(v_state.portfolio_stop_resume_equity, 0),
                            p_balance
                        )
                    WHERE id = p_run_id;
                END IF;
            ELSE
                -- Peak for DD%; resume target = cash equity before close (как в бою)
                UPDATE logic_backtest_runs
                SET portfolio_equity_peak = GREATEST(
                    COALESCE(portfolio_equity_peak, 0),
                    COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0),
                    p_balance
                )
                WHERE id = p_run_id
                  AND COALESCE(portfolio_trading_paused, FALSE) = FALSE;

                SELECT COALESCE(portfolio_equity_peak, p_balance) INTO v_track_before
                FROM logic_backtest_runs WHERE id = p_run_id;

                v_drawdown := 0;
                IF v_track_before > 0 AND p_balance < v_track_before THEN
                    v_drawdown := (v_track_before - p_balance) / v_track_before * 100.0;
                END IF;

                IF v_drawdown >= v_stop.value THEN
                    v_reason := format('stop_loss:portfolio_resume (%s%%)', round(v_drawdown, 2));
                    -- Цель возобновления = equity до закрытия, не пик
                    v_track_before := p_balance;
                    FOR v_sec IN
                        SELECT DISTINCT lt.security_id
                        FROM logic_trades lt
                        WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                          AND lt.status IN ('filled', 'submitted')
                          AND NOT logic_is_cash_fund_security(lt.security_id)
                    LOOP
                        SELECT *
                        INTO v_closed, p_balance
                        FROM logic_backtest_close_security(
                            p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                            p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                        );
                    END LOOP;
                    UPDATE logic_backtest_runs
                    SET portfolio_trading_paused = TRUE,
                        portfolio_stop_resume_equity = v_track_before,
                        portfolio_stop_resume_baseline = p_balance
                    WHERE id = p_run_id;
                END IF;
            END IF;
        ELSIF v_stop.rule_kind = 'stop_loss' AND v_stop.scope_type = 'security_resume' THEN
            FOR v_sec IN
                SELECT ls.security_id FROM logic_securities ls
                WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
                  AND NOT logic_is_cash_fund_security(ls.security_id)
            LOOP
                FOREACH v_side_name IN ARRAY ARRAY['long', 'short']
                LOOP
                    SELECT
                        CASE WHEN v_side_name = 'long'
                            THEN COALESCE(st.real_trading_paused_long, FALSE)
                                 OR (
                                     COALESCE(st.real_trading_paused, FALSE)
                                     AND NOT COALESCE(st.real_trading_paused_long, FALSE)
                                     AND NOT COALESCE(st.real_trading_paused_short, FALSE)
                                 )
                            ELSE COALESCE(st.real_trading_paused_short, FALSE)
                                 OR (
                                     COALESCE(st.real_trading_paused, FALSE)
                                     AND NOT COALESCE(st.real_trading_paused_long, FALSE)
                                     AND NOT COALESCE(st.real_trading_paused_short, FALSE)
                                 )
                        END,
                        CASE WHEN v_side_name = 'long'
                            THEN COALESCE(st.stop_resume_equity_long, st.stop_resume_equity)
                            ELSE COALESCE(st.stop_resume_equity_short, st.stop_resume_equity)
                        END,
                        CASE WHEN v_side_name = 'long'
                            THEN COALESCE(st.stop_resume_baseline_long, st.stop_resume_baseline)
                            ELSE COALESCE(st.stop_resume_baseline_short, st.stop_resume_baseline)
                        END,
                        CASE WHEN v_side_name = 'long'
                            THEN st.stop_resume_hwm_long
                            ELSE st.stop_resume_hwm_short
                        END
                    INTO v_side_paused, v_resume_equity, v_resume_baseline, v_hwm
                    FROM logic_backtest_security_state st
                    WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id;

                    IF NOT FOUND THEN
                        v_side_paused := FALSE;
                        v_resume_equity := NULL;
                        v_resume_baseline := NULL;
                        v_hwm := NULL;
                    END IF;

                    IF v_side_paused THEN
                        IF v_resume_equity IS NOT NULL AND v_resume_baseline IS NOT NULL THEN
                            v_track_after := logic_backtest_security_side_track_value(
                                p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, TRUE, v_side_name
                            );
                            IF COALESCE(v_resume_baseline, 0) + COALESCE(v_track_after, 0)
                               >= COALESCE(v_resume_equity, 0) THEN
                                IF v_side_name = 'long' THEN
                                    UPDATE logic_backtest_security_state
                                    SET real_trading_paused_long = FALSE,
                                        stop_resume_equity_long = NULL,
                                        stop_resume_baseline_long = NULL,
                                        real_trading_paused = COALESCE(real_trading_paused_short, FALSE),
                                        stop_resume_equity = NULL,
                                        stop_resume_baseline = NULL
                                    WHERE run_id = p_run_id AND security_id = v_sec.security_id;
                                ELSE
                                    UPDATE logic_backtest_security_state
                                    SET real_trading_paused_short = FALSE,
                                        stop_resume_equity_short = NULL,
                                        stop_resume_baseline_short = NULL,
                                        real_trading_paused = COALESCE(real_trading_paused_long, FALSE),
                                        stop_resume_equity = NULL,
                                        stop_resume_baseline = NULL
                                    WHERE run_id = p_run_id AND security_id = v_sec.security_id;
                                END IF;
                            END IF;
                        END IF;
                        CONTINUE;
                    END IF;

                    v_drawdown := logic_backtest_security_side_drawdown_pct(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE, v_side_name
                    );
                    IF v_drawdown < v_stop.value THEN
                        CONTINUE;
                    END IF;

                    v_reason := format(
                        'stop_loss:security_resume:%s (%s%%)',
                        v_side_name, round(v_drawdown, 2)
                    );
                    v_track_before := logic_backtest_security_side_track_value(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE, v_side_name
                    );
                    v_target := logic_resume_sl_peak_target(
                        p_logic_id, v_track_before, v_hwm
                    );
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance, v_side_name
                    );
                    v_track_after := logic_backtest_security_side_track_value(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE, v_side_name
                    );

                    IF v_side_name = 'long' THEN
                        INSERT INTO logic_backtest_security_state (
                            run_id, security_id, real_trading_paused,
                            real_trading_paused_long,
                            stop_resume_equity_long, stop_resume_baseline_long,
                            stop_resume_hwm_long
                        )
                        VALUES (
                            p_run_id, v_sec.security_id, TRUE,
                            TRUE, v_target, v_track_after,
                            CASE WHEN v_no_reduce THEN v_target ELSE NULL END
                        )
                        ON CONFLICT (run_id, security_id) DO UPDATE SET
                            real_trading_paused = TRUE,
                            real_trading_paused_long = TRUE,
                            stop_resume_equity_long = EXCLUDED.stop_resume_equity_long,
                            stop_resume_baseline_long = EXCLUDED.stop_resume_baseline_long,
                            stop_resume_hwm_long = CASE
                                WHEN v_no_reduce THEN EXCLUDED.stop_resume_hwm_long
                                ELSE logic_backtest_security_state.stop_resume_hwm_long
                            END;
                    ELSE
                        INSERT INTO logic_backtest_security_state (
                            run_id, security_id, real_trading_paused,
                            real_trading_paused_short,
                            stop_resume_equity_short, stop_resume_baseline_short,
                            stop_resume_hwm_short
                        )
                        VALUES (
                            p_run_id, v_sec.security_id, TRUE,
                            TRUE, v_target, v_track_after,
                            CASE WHEN v_no_reduce THEN v_target ELSE NULL END
                        )
                        ON CONFLICT (run_id, security_id) DO UPDATE SET
                            real_trading_paused = TRUE,
                            real_trading_paused_short = TRUE,
                            stop_resume_equity_short = EXCLUDED.stop_resume_equity_short,
                            stop_resume_baseline_short = EXCLUDED.stop_resume_baseline_short,
                            stop_resume_hwm_short = CASE
                                WHEN v_no_reduce THEN EXCLUDED.stop_resume_hwm_short
                                ELSE logic_backtest_security_state.stop_resume_hwm_short
                            END;
                    END IF;
                END LOOP;
            END LOOP;
        ELSIF v_stop.rule_kind = 'stop_loss' AND v_stop.scope_type = 'security_inversion' THEN
            -- Like security_resume (paper × side), but on shadow→zero toggle real_trading_inverted.
            -- Signal-side pause/shadow; when inverted, DD/close use opposite position side
            -- (long signals open shorts). Shadow recovery uses base logic (ignore inverted).
            FOR v_sec IN
                SELECT ls.security_id FROM logic_securities ls
                WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
                  AND NOT logic_is_cash_fund_security(ls.security_id)
            LOOP
                SELECT COALESCE(st.real_trading_inverted, FALSE)
                INTO v_has_pos -- reuse: paper inverted
                FROM logic_backtest_security_state st
                WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id;
                IF NOT FOUND THEN
                    v_has_pos := FALSE;
                END IF;

                FOREACH v_side_name IN ARRAY ARRAY['long', 'short']
                LOOP
                    -- Position side to measure/close (flipped when paper inverted)
                    v_reason := CASE
                        WHEN v_has_pos THEN
                            CASE WHEN v_side_name = 'long' THEN 'short' ELSE 'long' END
                        ELSE v_side_name
                    END; -- reuse v_reason as pos_side text until format below

                    SELECT
                        CASE WHEN v_side_name = 'long'
                            THEN COALESCE(st.real_trading_paused_long, FALSE)
                                 OR (
                                     COALESCE(st.real_trading_paused, FALSE)
                                     AND NOT COALESCE(st.real_trading_paused_long, FALSE)
                                     AND NOT COALESCE(st.real_trading_paused_short, FALSE)
                                 )
                            ELSE COALESCE(st.real_trading_paused_short, FALSE)
                                 OR (
                                     COALESCE(st.real_trading_paused, FALSE)
                                     AND NOT COALESCE(st.real_trading_paused_long, FALSE)
                                     AND NOT COALESCE(st.real_trading_paused_short, FALSE)
                                 )
                        END,
                        CASE WHEN v_side_name = 'long'
                            THEN COALESCE(st.stop_resume_equity_long, st.stop_resume_equity)
                            ELSE COALESCE(st.stop_resume_equity_short, st.stop_resume_equity)
                        END,
                        CASE WHEN v_side_name = 'long'
                            THEN COALESCE(st.stop_resume_baseline_long, st.stop_resume_baseline)
                            ELSE COALESCE(st.stop_resume_baseline_short, st.stop_resume_baseline)
                        END,
                        CASE WHEN v_side_name = 'long'
                            THEN st.stop_resume_hwm_long
                            ELSE st.stop_resume_hwm_short
                        END
                    INTO v_side_paused, v_resume_equity, v_resume_baseline, v_hwm
                    FROM logic_backtest_security_state st
                    WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id;

                    IF NOT FOUND THEN
                        v_side_paused := FALSE;
                        v_resume_equity := NULL;
                        v_resume_baseline := NULL;
                        v_hwm := NULL;
                    END IF;

                    -- Shadow on this signal-side: recover to peak → unpause + toggle inverted
                    IF v_side_paused THEN
                        IF v_resume_equity IS NOT NULL AND v_resume_baseline IS NOT NULL THEN
                            v_track_after := logic_backtest_security_side_track_value(
                                p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, TRUE, v_side_name
                            );
                            IF COALESCE(v_resume_baseline, 0) + COALESCE(v_track_after, 0)
                               >= COALESCE(v_resume_equity, 0) THEN
                                IF v_side_name = 'long' THEN
                                    UPDATE logic_backtest_security_state
                                    SET real_trading_paused_long = FALSE,
                                        stop_resume_equity_long = NULL,
                                        stop_resume_baseline_long = NULL,
                                        real_trading_paused = COALESCE(real_trading_paused_short, FALSE),
                                        stop_resume_equity = NULL,
                                        stop_resume_baseline = NULL,
                                        real_trading_inverted = NOT COALESCE(real_trading_inverted, FALSE)
                                    WHERE run_id = p_run_id AND security_id = v_sec.security_id;
                                ELSE
                                    UPDATE logic_backtest_security_state
                                    SET real_trading_paused_short = FALSE,
                                        stop_resume_equity_short = NULL,
                                        stop_resume_baseline_short = NULL,
                                        real_trading_paused = COALESCE(real_trading_paused_long, FALSE),
                                        stop_resume_equity = NULL,
                                        stop_resume_baseline = NULL,
                                        real_trading_inverted = NOT COALESCE(real_trading_inverted, FALSE)
                                    WHERE run_id = p_run_id AND security_id = v_sec.security_id;
                                END IF;
                                -- Refresh inverted for the other side in this bar
                                SELECT COALESCE(st.real_trading_inverted, FALSE)
                                INTO v_has_pos
                                FROM logic_backtest_security_state st
                                WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id;
                            END IF;
                        END IF;
                        CONTINUE;
                    END IF;

                    v_drawdown := logic_backtest_security_side_drawdown_pct(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE, v_reason
                    );
                    IF v_drawdown < v_stop.value THEN
                        CONTINUE;
                    END IF;

                    v_track_before := logic_backtest_security_side_track_value(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE, v_reason
                    );
                    v_target := logic_resume_sl_peak_target(
                        p_logic_id, v_track_before, v_hwm
                    );
                    v_reason := format(
                        CASE
                            WHEN v_has_pos THEN
                                'stop_loss:security_inversion:inverted:%s (%s%%)'
                            ELSE
                                'stop_loss:security_inversion:%s (%s%%)'
                        END,
                        v_side_name, round(v_drawdown, 2)
                    );
                    -- Close the position side that this signal group is holding
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance,
                        CASE
                            WHEN v_has_pos THEN
                                CASE WHEN v_side_name = 'long' THEN 'short' ELSE 'long' END
                            ELSE v_side_name
                        END
                    );
                    v_track_after := logic_backtest_security_side_track_value(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE,
                        CASE
                            WHEN v_has_pos THEN
                                CASE WHEN v_side_name = 'long' THEN 'short' ELSE 'long' END
                            ELSE v_side_name
                        END
                    );

                    IF v_side_name = 'long' THEN
                        INSERT INTO logic_backtest_security_state (
                            run_id, security_id, real_trading_paused,
                            real_trading_paused_long, real_trading_inverted,
                            stop_resume_equity_long, stop_resume_baseline_long,
                            stop_resume_hwm_long
                        )
                        VALUES (
                            p_run_id, v_sec.security_id, TRUE,
                            TRUE, v_has_pos,
                            v_target, v_track_after,
                            CASE WHEN v_no_reduce THEN v_target ELSE NULL END
                        )
                        ON CONFLICT (run_id, security_id) DO UPDATE SET
                            real_trading_paused = TRUE,
                            real_trading_paused_long = TRUE,
                            real_trading_inverted = EXCLUDED.real_trading_inverted,
                            stop_resume_equity_long = EXCLUDED.stop_resume_equity_long,
                            stop_resume_baseline_long = EXCLUDED.stop_resume_baseline_long,
                            stop_resume_hwm_long = CASE
                                WHEN v_no_reduce THEN EXCLUDED.stop_resume_hwm_long
                                ELSE logic_backtest_security_state.stop_resume_hwm_long
                            END;
                    ELSE
                        INSERT INTO logic_backtest_security_state (
                            run_id, security_id, real_trading_paused,
                            real_trading_paused_short, real_trading_inverted,
                            stop_resume_equity_short, stop_resume_baseline_short,
                            stop_resume_hwm_short
                        )
                        VALUES (
                            p_run_id, v_sec.security_id, TRUE,
                            TRUE, v_has_pos,
                            v_target, v_track_after,
                            CASE WHEN v_no_reduce THEN v_target ELSE NULL END
                        )
                        ON CONFLICT (run_id, security_id) DO UPDATE SET
                            real_trading_paused = TRUE,
                            real_trading_paused_short = TRUE,
                            real_trading_inverted = EXCLUDED.real_trading_inverted,
                            stop_resume_equity_short = EXCLUDED.stop_resume_equity_short,
                            stop_resume_baseline_short = EXCLUDED.stop_resume_baseline_short,
                            stop_resume_hwm_short = CASE
                                WHEN v_no_reduce THEN EXCLUDED.stop_resume_hwm_short
                                ELSE logic_backtest_security_state.stop_resume_hwm_short
                            END;
                    END IF;
                END LOOP;
            END LOOP;
        ELSIF v_stop.rule_kind = 'stop_loss' THEN
            FOR v_sec IN
                SELECT ls.security_id FROM logic_securities ls
                WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
                  AND NOT logic_is_cash_fund_security(ls.security_id)
            LOOP
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
            END LOOP;
        ELSIF v_stop.rule_kind = 'take_profit' AND v_stop.scope_type = 'portfolio' THEN
            -- Equity (cash+MTM), не свободный кэш: иначе TP спамит при «жирном» кэше
            -- при падающем портфеле. Latch: после срабатывания ждём возврат ниже порога.
            v_initial := COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0);
            v_equity := COALESCE(
                logic_backtest_portfolio_equity(p_logic_id, p_tf_id, p_bar_dt, p_balance),
                p_balance
            );
            v_gain := 0;
            IF v_initial > 0 AND v_equity > v_initial THEN
                v_gain := (v_equity - v_initial) / v_initial * 100.0;
            END IF;

            SELECT COALESCE(r.portfolio_tp_latched, FALSE)
            INTO v_tp_latched
            FROM logic_backtest_runs r
            WHERE r.id = p_run_id;

            IF v_tp_latched AND v_gain < v_stop.value THEN
                UPDATE logic_backtest_runs
                SET portfolio_tp_latched = FALSE
                WHERE id = p_run_id;
                v_tp_latched := FALSE;
            END IF;

            IF NOT COALESCE(v_tp_latched, FALSE) AND v_gain >= v_stop.value THEN
                v_reason := format('take_profit:portfolio (%s%%)', round(v_gain, 2));
                FOR v_sec IN
                    SELECT DISTINCT lt.security_id
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                      AND lt.status IN ('filled', 'submitted')
                      AND NOT logic_is_cash_fund_security(lt.security_id)
                LOOP
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                    );
                END LOOP;
                UPDATE logic_backtest_runs
                SET portfolio_tp_latched = TRUE
                WHERE id = p_run_id;
            END IF;
        ELSIF v_stop.rule_kind = 'take_profit' AND v_stop.scope_type = 'security' THEN
            FOR v_sec IN
                SELECT ls.security_id FROM logic_securities ls
                WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
                  AND NOT logic_is_cash_fund_security(ls.security_id)
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
        ELSIF v_stop.rule_kind = 'take_profit' AND v_stop.scope_type = 'portfolio_ltp_renew' THEN
            -- Линейный TP: arm на всплеске; продажа при откате от пика >= TP%; latch против чопа
            v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', NULL);
            IF v_initial IS NOT NULL AND v_initial > 0 THEN
                SELECT COALESCE(r.portfolio_trading_paused, FALSE)
                INTO v_port_paused
                FROM logic_backtest_runs r
                WHERE r.id = p_run_id;

                IF v_port_paused THEN
                    SELECT COALESCE(SUM(lt.financial_result), 0) INTO v_track_after
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id
                      AND lt.run_id = p_run_id
                      AND lt.is_test = TRUE
                      AND lt.is_shadow = TRUE
                      AND lt.status IN ('filled', 'submitted')
                      AND lt.financial_result IS NOT NULL;

                    SELECT r.portfolio_stop_resume_equity, r.portfolio_stop_resume_baseline
                    INTO v_resume_equity, v_resume_baseline
                    FROM logic_backtest_runs r WHERE r.id = p_run_id;

                    IF v_resume_equity IS NOT NULL AND v_resume_baseline IS NOT NULL
                       AND COALESCE(v_resume_baseline, 0) + COALESCE(v_track_after, 0)
                          >= COALESCE(v_resume_equity, 0)
                    THEN
                        UPDATE logic_backtest_runs
                        SET portfolio_trading_paused = FALSE,
                            portfolio_stop_resume_equity = NULL,
                            portfolio_stop_resume_baseline = NULL,
                            portfolio_equity_peak = GREATEST(
                                COALESCE(portfolio_equity_peak, 0),
                                COALESCE(v_resume_equity, 0),
                                p_balance
                            )
                        WHERE id = p_run_id;
                    END IF;
                ELSE
                    v_equity := COALESCE(
                        logic_backtest_portfolio_equity(p_logic_id, p_tf_id, p_bar_dt, p_balance),
                        p_balance
                    );
                    v_track_pct := (v_equity - v_initial) / v_initial * 100.0;
                    v_base_pct := logic_linear_base_pct(p_logic_id, p_bar_dt, TRUE, p_run_id);
                    v_arm_pct := v_base_pct + v_stop.value;

                    SELECT
                        COALESCE(r.portfolio_linear_tp_armed, FALSE),
                        COALESCE(r.portfolio_linear_tp_latched, FALSE),
                        r.portfolio_linear_tp_peak_equity,
                        r.portfolio_linear_tp_arm_bar_dt
                    INTO v_ltp_armed, v_ltp_latched, v_ltp_last_price, v_ltp_arm_bar
                    FROM logic_backtest_runs r
                    WHERE r.id = p_run_id;

                    SELECT EXISTS (
                        SELECT 1
                        FROM logic_securities ls
                        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
                          AND NOT logic_is_cash_fund_security(ls.security_id)
                          AND (
                              logic_long_position_qty(p_logic_id, ls.security_id, FALSE, TRUE) > 0
                              OR logic_short_position_qty(p_logic_id, ls.security_id, FALSE, TRUE) > 0
                          )
                    ) INTO v_has_pos;

                    IF v_ltp_latched AND v_track_pct < v_arm_pct THEN
                        UPDATE logic_backtest_runs
                        SET portfolio_linear_tp_latched = FALSE
                        WHERE id = p_run_id;
                        v_ltp_latched := FALSE;
                    END IF;

                    IF v_track_pct < v_base_pct THEN
                        IF v_ltp_armed OR v_ltp_latched THEN
                            UPDATE logic_backtest_runs
                            SET portfolio_linear_tp_armed = FALSE,
                                portfolio_linear_tp_peak_equity = NULL,
                                portfolio_linear_tp_arm_bar_dt = NULL,
                                portfolio_linear_tp_latched = FALSE
                            WHERE id = p_run_id;
                        END IF;
                    ELSIF NOT v_ltp_armed
                       AND NOT v_ltp_latched
                       AND v_track_pct >= v_arm_pct
                       AND v_has_pos
                    THEN
                        UPDATE logic_backtest_runs
                        SET portfolio_linear_tp_armed = TRUE,
                            portfolio_linear_tp_peak_equity = v_equity,
                            portfolio_linear_tp_arm_bar_dt = p_bar_dt
                        WHERE id = p_run_id;
                    ELSIF v_ltp_armed THEN
                        v_fade_pct := 0;
                        IF v_ltp_last_price IS NOT NULL
                           AND v_ltp_last_price > 0
                           AND v_equity < v_ltp_last_price
                        THEN
                            v_fade_pct :=
                                (v_ltp_last_price - v_equity) / v_ltp_last_price * 100.0;
                        END IF;

                        IF v_ltp_last_price IS NOT NULL
                           AND v_fade_pct >= v_stop.value
                           AND v_has_pos
                           AND (v_ltp_arm_bar IS NULL OR p_bar_dt > v_ltp_arm_bar)
                        THEN
                            v_track_before := v_equity;
                            v_reason := format(
                                'take_profit:portfolio_ltp_renew fade=%s%% (%s%%)',
                                round(v_fade_pct, 2), round(v_track_pct, 2)
                            );
                            FOR v_sec IN
                                SELECT DISTINCT lt.security_id
                                FROM logic_trades lt
                                WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                                  AND lt.status IN ('filled', 'submitted')
                                  AND NOT logic_is_cash_fund_security(lt.security_id)
                            LOOP
                                SELECT *
                                INTO v_closed, p_balance
                                FROM logic_backtest_close_security(
                                    p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                                    p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                                );
                            END LOOP;
                            v_equity := COALESCE(
                                logic_backtest_portfolio_equity(p_logic_id, p_tf_id, p_bar_dt, p_balance),
                                p_balance
                            );
                            UPDATE logic_backtest_runs
                            SET portfolio_trading_paused = TRUE,
                                portfolio_stop_resume_equity = v_track_before,
                                portfolio_stop_resume_baseline = v_equity,
                                portfolio_linear_tp_armed = FALSE,
                                portfolio_linear_tp_peak_equity = NULL,
                                portfolio_linear_tp_arm_bar_dt = NULL,
                                portfolio_linear_tp_latched = TRUE
                            WHERE id = p_run_id;
                        ELSIF v_equity > COALESCE(v_ltp_last_price, 0) THEN
                            UPDATE logic_backtest_runs
                            SET portfolio_linear_tp_peak_equity = v_equity
                            WHERE id = p_run_id;
                        END IF;
                    END IF;
                END IF;
            END IF;
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
    v_max_order_amount NUMERIC;
    v_sizing_base NUMERIC;
    v_size_mode TEXT;
    v_open_positions INTEGER;
    v_side_open_id INTEGER;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_sec RECORD;
    v_grp RECORD;
    v_sig RECORD;
    v_eval RECORD;
    v_pt RECORD;
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
    v_is_futures BOOLEAN;
    v_inversion BOOLEAN;
    v_eff_inversion BOOLEAN;
    v_eff_side TEXT;
    v_use_opt BOOLEAN;
    v_cycle_budget NUMERIC;
    v_max_exposure NUMERIC;
    v_spent_notional NUMERIC := 0;
    v_room NUMERIC;
    v_order_notional NUMERIC;
BEGIN
    SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    v_position_size_pct := get_logic_param_numeric(p_logic_id, 'position_size_pct', 10);
    v_max_positions := GREATEST(1, get_logic_param_numeric(p_logic_id, 'max_open_positions', 5)::INTEGER);
    v_max_order_amount := get_logic_param_numeric(p_logic_id, 'max_order_amount', NULL);
    v_size_mode := lower(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'position_size_base'),
        'free_cash'
    )));
    IF v_size_mode NOT IN ('free_cash', 'portfolio', 'portfolio_incl_fund') THEN
        v_size_mode := 'free_cash';
    END IF;
    v_inversion := get_logic_param_boolean(p_logic_id, 'inversion', FALSE);
    v_use_opt := logic_opt_logic_has_opt(p_logic_id);
    v_open_positions := logic_backtest_count_open_positions(p_logic_id, FALSE);
    -- База на весь бар (как в live): short-выручка / заём не в базе (только equity).
    IF v_size_mode = 'free_cash' THEN
        -- p_balance растёт от short Open; equity = cash + long − short уже «свой» капитал.
        v_cycle_budget := LEAST(
            GREATEST(0, COALESCE(p_balance, 0)),
            GREATEST(
                0,
                COALESCE(logic_backtest_portfolio_equity(
                    p_logic_id, p_tf_id, p_bar_dt, p_balance
                ), 0)
            )
        );
    ELSIF v_size_mode = 'portfolio_incl_fund' THEN
        v_cycle_budget := GREATEST(
            0,
            COALESCE(logic_backtest_portfolio_equity(
                p_logic_id, p_tf_id, p_bar_dt, p_balance
            ), 0)
        );
    ELSE
        v_cycle_budget := GREATEST(
            0,
            COALESCE(logic_backtest_portfolio_equity(
                p_logic_id, p_tf_id, p_bar_dt, p_balance
            ), 0)
            - logic_backtest_selected_cash_fund_mtm(
                p_logic_id, p_tf_id, p_bar_dt
            )
        );
    END IF;
    v_max_exposure := v_cycle_budget
        * (GREATEST(0, COALESCE(v_position_size_pct, 0)) / 100.0)
        * v_max_positions;
    v_spent_notional := logic_open_notional_exposure(p_logic_id, TRUE, '', p_run_id);

    -- Один агрегат PnL на бар (не коррелированный SUM на каждую бумагу — иначе mid-run
    -- test-panel/UI пустеет из‑за долгих локов, а /pnl-summary ещё успевает).
    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        LEFT JOIN (
            SELECT lt.security_id,
                   COALESCE(SUM(lt.financial_result), 0) AS pnl
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            WHERE lt.logic_id = p_logic_id
              AND lt.is_test = TRUE
              AND lt.run_id = p_run_id
              AND NOT lt.is_shadow
              AND COALESCE(lt.opt_lane, '') = ''
              AND s.name = 'Close'
              AND lt.status IN ('filled', 'submitted')
            GROUP BY lt.security_id
        ) pnl ON pnl.security_id = ls.security_id
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
          AND NOT logic_is_cash_fund_security(ls.security_id)
        ORDER BY COALESCE(pnl.pnl, 0) DESC,
                 ls.display_order NULLS LAST,
                 ls.id
    LOOP
        v_lot_size := logic_security_lot_size(v_sec.security_id);
        v_is_futures := logic_security_is_futures(v_sec.security_id);

        FOR v_grp IN
            SELECT lis.position_event, lis.position_side
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            GROUP BY lis.position_event, lis.position_side
            ORDER BY lis.position_event, lis.position_side
        LOOP
            v_is_shadow := logic_backtest_sec_side_shadow(
                    p_run_id, v_sec.security_id, v_grp.position_side
                )
                OR COALESCE(
                    (SELECT r.portfolio_trading_paused FROM logic_backtest_runs r WHERE r.id = p_run_id),
                    FALSE
                );
            -- Shadow recovery to "zero" must use base logic (checkbox only).
            -- If shadow kept paper inverted, recovery after inverted SL used the
            -- losing book → stuck inverted; ON was easy, OFF was hard.
            v_eff_inversion := (
                v_inversion <> CASE
                    WHEN v_is_shadow THEN FALSE
                    ELSE COALESCE(
                        (SELECT st.real_trading_inverted
                         FROM logic_backtest_security_state st
                         WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id),
                        FALSE
                    )
                END
            );
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
                -- Inversion = ReverseSides only (Long↔Short). Do NOT invert
                -- comparison ops: for band fades (pp<=LOWER) that would become
                -- pp>=LOWER (almost always true) → trade spam, no equity mirror.
                -- ТФ сигнала (tf=) и его закрытый бар до close бара логики.
                SELECT * INTO v_pt
                FROM logic_signal_eval_point(v_sig.formula, p_tf_id, p_bar_dt);
                IF v_pt.tf_id IS NULL OR v_pt.bar_dt IS NULL THEN
                    v_all_ok := FALSE;
                    CONTINUE;
                END IF;

                IF v_use_opt THEN
                    SELECT * INTO v_eval
                    FROM logic_signal_evaluate_at_opt(
                        v_sig.id, v_sec.security_id, v_pt.tf_id, v_pt.bar_dt,
                        FALSE, NULL
                    );
                ELSE
                    SELECT * INTO v_eval
                    FROM logic_signal_evaluate_at(
                        v_sig.id, v_sec.security_id, v_pt.tf_id, v_pt.bar_dt, FALSE
                    );
                END IF;

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
                    v_sizing_base := v_cycle_budget;
                    v_room := GREATEST(0, v_max_exposure - v_spent_notional);
                    IF v_max_order_amount IS NOT NULL AND v_max_order_amount > 0 THEN
                        v_room := LEAST(v_room, v_max_order_amount);
                    END IF;
                    v_quantity := logic_calc_open_quantity(
                        v_sizing_base, v_position_size_pct, v_pp, v_lot_size, v_room
                    );
                    IF v_quantity < v_lot_size THEN
                        -- Фьючерсы: нотионал контракта >> % депозита → 1 лот при сигнале
                        IF v_is_futures AND v_lot_size * v_pp <= v_room THEN
                            v_quantity := v_lot_size;
                        ELSE
                            CONTINUE;
                        END IF;
                    END IF;
                    v_order_notional := v_quantity * v_pp;
                    IF v_order_notional > v_room + 0.000001 THEN
                        CONTINUE;
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
                    v_sizing_base := v_cycle_budget;
                    v_room := GREATEST(0, v_max_exposure - v_spent_notional);
                    IF v_max_order_amount IS NOT NULL AND v_max_order_amount > 0 THEN
                        v_room := LEAST(v_room, v_max_order_amount);
                    END IF;
                    v_quantity := logic_calc_open_quantity(
                        v_sizing_base, v_position_size_pct, v_pp, v_lot_size, v_room
                    );
                    IF v_quantity < v_lot_size THEN
                        IF v_is_futures AND v_lot_size * v_pp <= v_room THEN
                            v_quantity := v_lot_size;
                        ELSE
                            CONTINUE;
                        END IF;
                    END IF;
                    v_order_notional := v_quantity * v_pp;
                    IF v_order_notional > v_room + 0.000001 THEN
                        CONTINUE;
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
                v_spent_notional := v_spent_notional + (v_quantity * v_pp);
            ELSIF v_trade_id IS NOT NULL AND NOT v_is_open_event AND NOT v_is_shadow THEN
                v_open_positions := GREATEST(0, v_open_positions - 1);
                -- Switch same bar: free exposure + refresh % base from post-close cash/equity.
                -- Open still does not refresh the base (short must not inflate mid-bar).
                v_spent_notional := logic_open_notional_exposure(
                    p_logic_id, TRUE, '', p_run_id
                );
                IF v_size_mode = 'free_cash' THEN
                    v_cycle_budget := LEAST(
                        GREATEST(0, COALESCE(p_balance, 0)),
                        GREATEST(
                            0,
                            COALESCE(logic_backtest_portfolio_equity(
                                p_logic_id, p_tf_id, p_bar_dt, p_balance
                            ), 0)
                        )
                    );
                ELSIF v_size_mode = 'portfolio_incl_fund' THEN
                    v_cycle_budget := GREATEST(
                        0,
                        COALESCE(logic_backtest_portfolio_equity(
                            p_logic_id, p_tf_id, p_bar_dt, p_balance
                        ), 0)
                    );
                ELSE
                    v_cycle_budget := GREATEST(
                        0,
                        COALESCE(logic_backtest_portfolio_equity(
                            p_logic_id, p_tf_id, p_bar_dt, p_balance
                        ), 0)
                        - logic_backtest_selected_cash_fund_mtm(
                            p_logic_id, p_tf_id, p_bar_dt
                        )
                    );
                END IF;
                v_max_exposure := v_cycle_budget
                    * (GREATEST(0, COALESCE(v_position_size_pct, 0)) / 100.0)
                    * v_max_positions;
            END IF;
        END LOOP;
    END LOOP;

    RETURN;
END;
$$;

-- Цена фонда для парковки на баре: только prices (+ fallback 100).
-- Без HTTP: иначе при отсутствии свечей TMON каждый бар зовёт T-Bank (~2с) и тест «висит».
CREATE OR REPLACE FUNCTION logic_cash_fund_price_at(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_code TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_price NUMERIC;
BEGIN
    SELECT p.close_price
    INTO v_price
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt <= p_bar_dt
    ORDER BY p.dt DESC
    LIMIT 1;

    IF v_price IS NOT NULL AND v_price > 0 THEN
        RETURN v_price;
    END IF;

    SELECT p.close_price
    INTO v_price
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.dt <= p_bar_dt
    ORDER BY p.dt DESC
    LIMIT 1;

    IF v_price IS NOT NULL AND v_price > 0 THEN
        RETURN v_price;
    END IF;

    -- БПИФ денежного рынка ~100 ₽/пай. HTTP — только в live logic_park_excess_cash (resolve).
    RETURN 100;
END;
$$;

COMMENT ON FUNCTION logic_cash_fund_price_at(INTEGER, INTEGER, TIMESTAMP, TEXT) IS
'Цена TMON/LQDT/SBMM для парковки: prices → fallback 100 (без HTTP на каждый бар)';

-- Equity теста на баре: один set-based запрос (без цикла по бумагам на каждый бар).
CREATE OR REPLACE FUNCTION logic_backtest_portfolio_equity(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_cash_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    -- LATERAL … ORDER BY dt DESC LIMIT 1 uses idx_prices_unique_candle (backward).
    -- Old DISTINCT ON (security_id) … JOIN prices caused huge temp sorts (~0.4s+/call).
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
          AND lt.is_test = TRUE
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
    SELECT COALESCE(p_cash_balance, 0)
         + COALESCE(SUM(px.long_qty * px.close_price - px.short_qty * px.close_price), 0)
    FROM px
    WHERE px.close_price > 0;
$$;

COMMENT ON FUNCTION logic_backtest_portfolio_equity(INTEGER, INTEGER, TIMESTAMP, NUMERIC) IS
'Тест: equity чемпиона (без opt_lane) = cash + long×price − short×price';

-- MTM выбранного денежного фонда в тесте (исключается из базы лота «весь портфель»).
CREATE OR REPLACE FUNCTION logic_backtest_selected_cash_fund_mtm(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_code TEXT;
    v_mtm NUMERIC;
BEGIN
    v_code := upper(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'cash_fund_code'),
        ''
    )));
    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN 0;
    END IF;

    SELECT COALESCE(SUM(q.long_qty * px.close_price), 0)
    INTO v_mtm
    FROM (
        SELECT
            lt.security_id,
            GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) AS long_qty
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        JOIN security_prefixes sp ON sp.security_id = lt.security_id
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = FALSE
          AND COALESCE(lt.opt_lane, '') = ''
          AND lt.status IN ('filled', 'submitted')
          AND upper(sp.prefix) = v_code
        GROUP BY lt.security_id
    ) q
    JOIN LATERAL (
        SELECT p.close_price
        FROM prices p
        WHERE p.security_id = q.security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt <= p_bar_dt
          AND p.close_price > 0
        ORDER BY p.dt DESC
        LIMIT 1
    ) px ON TRUE
    WHERE q.long_qty > 0;

    RETURN GREATEST(0, COALESCE(v_mtm, 0));
END;
$$;

COMMENT ON FUNCTION logic_backtest_selected_cash_fund_mtm(INTEGER, INTEGER, TIMESTAMP) IS
'Тест: MTM выбранного cash_fund_code на bar_dt (только чемпион, без opt_lane)';

-- Парковка: BUY фонда на min(свободный кэш, equity−порог−уже_в_фонде); без продажи фонда.
CREATE OR REPLACE FUNCTION logic_backtest_park_excess_cash(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
    v_threshold NUMERIC;
    v_park_amount NUMERIC;
    v_security_id INTEGER;
    v_price NUMERIC;
    v_lot INTEGER;
    v_qty INTEGER;
    v_side_open_id INTEGER;
    v_action_long_id INTEGER;
    v_trade_id BIGINT;
    v_balance NUMERIC := p_balance;
    v_equity NUMERIC;
    v_fund_qty NUMERIC;
    v_fund_mtm NUMERIC;
    v_excess NUMERIC;
BEGIN
    v_code := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'cash_fund_code'), '')));
    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN v_balance;
    END IF;

    v_threshold := COALESCE(get_logic_param_numeric(p_logic_id, 'cash_fund_threshold', 1000000), 1000000);
    IF v_threshold < 0 THEN
        v_threshold := 0;
    END IF;

    IF v_balance IS NULL OR v_balance <= 0 THEN
        RETURN COALESCE(v_balance, p_balance);
    END IF;

    PERFORM logic_ensure_cash_fund_security(p_logic_id, v_code);

    SELECT s.id
    INTO v_security_id
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id
    WHERE upper(sp.prefix) = v_code
    ORDER BY sp.exchange_id
    LIMIT 1;

    IF v_security_id IS NULL THEN
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.cash_fund.skip',
            format('Фонд %s не найден в securities', v_code),
            jsonb_build_object('fund', v_code, 'balance', v_balance, 'threshold', v_threshold),
            NULL, p_timeframe_id
        );
        RETURN v_balance;
    END IF;

    v_price := logic_cash_fund_price_at(v_security_id, p_timeframe_id, p_bar_dt, v_code);
    IF v_price IS NULL OR v_price <= 0 THEN
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.cash_fund.skip',
            format('Нет цены для %s на %s', v_code, p_bar_dt),
            jsonb_build_object('fund', v_code, 'bar_dt', p_bar_dt),
            v_security_id, p_timeframe_id
        );
        RETURN v_balance;
    END IF;

    -- Избыток портфеля над порогом; уже купленный фонд в equity учитываем, чтобы не докупать снова.
    v_equity := logic_backtest_portfolio_equity(p_logic_id, p_timeframe_id, p_bar_dt, v_balance);
    v_fund_qty := logic_long_position_qty(p_logic_id, v_security_id, FALSE, TRUE);
    v_fund_mtm := COALESCE(v_fund_qty, 0) * v_price;
    v_excess := COALESCE(v_equity, 0) - v_threshold;
    v_park_amount := LEAST(v_balance, GREATEST(0, v_excess - v_fund_mtm));

    IF v_park_amount <= 0 THEN
        RETURN v_balance;
    END IF;

    v_lot := GREATEST(1, logic_security_lot_size(v_security_id));
    v_qty := (FLOOR(v_park_amount / (v_price * v_lot)))::INTEGER * v_lot;
    -- Не логируем «мало для лота» на каждом баре — засоряет app_tech_log и тормозит прогон.
    IF v_qty < v_lot THEN
        RETURN v_balance;
    END IF;

    SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    IF v_side_open_id IS NULL OR v_action_long_id IS NULL THEN
        RETURN v_balance;
    END IF;

    SELECT o_trade_id, o_new_balance
    INTO v_trade_id, v_balance
    FROM logic_backtest_insert_trade(
        p_run_id, p_logic_id, p_account_id, v_security_id, p_timeframe_id,
        v_side_open_id, v_action_long_id,
        'cash_fund',
        format('cash_fund.park %s', v_code),
        v_qty, v_price, p_bar_dt, FALSE,
        format('cash_fund.park:%s', v_code),
        v_balance,
        'open'
    );

    IF v_trade_id IS NOT NULL THEN
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.cash_fund.park',
            format('Тест: куплено %s qty=%s price=%s bar=%s', v_code, v_qty, v_price, p_bar_dt),
            jsonb_build_object(
                'fund', v_code,
                'quantity', v_qty,
                'price', v_price,
                'park_amount', v_park_amount,
                'equity', v_equity,
                'fund_mtm', v_fund_mtm,
                'excess', v_excess,
                'trade_id', v_trade_id,
                'bar_dt', p_bar_dt
            ),
            v_security_id, p_timeframe_id
        );
    END IF;

    RETURN v_balance;
END;
$$;

COMMENT ON FUNCTION logic_backtest_park_excess_cash(BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC) IS
'Тест: на каждом баре BUY фонда на min(кэш, equity−порог−уже_в_фонде); фонд не продаём';

-- Закрыть все test-позиции кроме денежного фонда (TMON/LQDT/SBMM).
CREATE OR REPLACE FUNCTION logic_backtest_close_all_except_funds(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_balance NUMERIC := p_balance;
    v_closed INTEGER;
    v_new NUMERIC;
BEGIN
    FOR v_sec IN
        SELECT DISTINCT lt.security_id
        FROM logic_trades lt
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = TRUE
          AND lt.status IN ('filled', 'submitted')
          AND NOT EXISTS (
              SELECT 1 FROM security_prefixes sp
              WHERE sp.security_id = lt.security_id
                AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
          )
    LOOP
        SELECT o_closed, o_new_balance
        INTO v_closed, v_new
        FROM logic_backtest_close_security(
            p_run_id, p_logic_id, p_account_id, v_sec.security_id, p_timeframe_id,
            p_bar_dt, FALSE, 'eod.close', v_balance
        );
        v_balance := v_new;
        SELECT o_closed, o_new_balance
        INTO v_closed, v_new
        FROM logic_backtest_close_security(
            p_run_id, p_logic_id, p_account_id, v_sec.security_id, p_timeframe_id,
            p_bar_dt, TRUE, 'eod.close', v_balance
        );
        v_balance := v_new;
    END LOOP;
    RETURN v_balance;
END;
$$;

COMMENT ON FUNCTION logic_backtest_close_all_except_funds(BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC) IS
'EOD: закрыть все test-позиции кроме TMON/LQDT/SBMM';

-- Тест: закрыть фьючерсы с days_to_expiry ≤ N (sell_futures_*).
CREATE OR REPLACE FUNCTION logic_backtest_close_futures_near_expiry(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_balance NUMERIC := COALESCE(p_balance, 0);
    v_threshold INTEGER;
    v_sec RECORD;
    v_days_left INTEGER;
    v_closed INTEGER;
    v_new NUMERIC;
BEGIN
    IF NOT get_logic_param_boolean(p_logic_id, 'sell_futures_before_expiry', FALSE) THEN
        RETURN v_balance;
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
          AND lt.is_test = TRUE
          AND lt.status IN ('filled', 'submitted')
          AND logic_security_is_futures(lt.security_id)
    LOOP
        v_days_left := logic_futures_days_to_expiry(v_sec.security_id, p_bar_dt::DATE);
        IF v_days_left IS NULL OR v_days_left > v_threshold THEN
            CONTINUE;
        END IF;

        SELECT o_closed, o_new_balance
        INTO v_closed, v_new
        FROM logic_backtest_close_security(
            p_run_id, p_logic_id, p_account_id, v_sec.security_id, p_timeframe_id,
            p_bar_dt, FALSE, 'futures_expiry:close', v_balance
        );
        v_balance := v_new;
        SELECT o_closed, o_new_balance
        INTO v_closed, v_new
        FROM logic_backtest_close_security(
            p_run_id, p_logic_id, p_account_id, v_sec.security_id, p_timeframe_id,
            p_bar_dt, TRUE, 'futures_expiry:close', v_balance
        );
        v_balance := v_new;
    END LOOP;

    RETURN v_balance;
END;
$$;

COMMENT ON FUNCTION logic_backtest_close_futures_near_expiry(BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC) IS
'EOD/тест: закрыть фьючерсы с days_to_expiry ≤ sell_futures_days_before_expiry';

-- Один бар теста (Node + SQL path): меньше round-trip, чем 5 отдельных CALL.
CREATE OR REPLACE FUNCTION logic_backtest_process_bar(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_prev_bar TIMESTAMP,
    p_next_bar TIMESTAMP,
    p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_balance NUMERIC := COALESCE(p_balance, 0);
BEGIN
    PERFORM logic_backtest_rate_signals(p_run_id, p_logic_id, p_tf_id, p_bar_dt);
    v_balance := logic_backtest_process_risk(
        p_run_id, p_logic_id, p_account_id, p_tf_id, p_bar_dt, v_balance
    );

    IF logic_is_eod_session_bar(p_logic_id, p_bar_dt, p_prev_bar, p_next_bar) THEN
        IF get_logic_param_boolean(p_logic_id, 'close_positions_eod', FALSE) THEN
            v_balance := logic_backtest_close_all_except_funds(
                p_run_id, p_logic_id, p_account_id, p_tf_id, p_bar_dt, v_balance
            );
        END IF;
        v_balance := logic_backtest_close_futures_near_expiry(
            p_run_id, p_logic_id, p_account_id, p_tf_id, p_bar_dt, v_balance
        );
    END IF;

    IF NOT logic_is_non_trading_dt(p_logic_id, p_bar_dt) THEN
        v_balance := logic_backtest_process_signals(
            p_run_id, p_logic_id, p_account_id, p_tf_id, p_bar_dt, v_balance
        );
        -- Same test run: formula OPT() and/or offline grid paper lanes (opt_lane).
        -- Grid: no promote — rank FinRes at finish.
        IF logic_opt_logic_has_opt(p_logic_id)
           OR EXISTS (
                SELECT 1 FROM logic_backtest_runs r
                WHERE r.id = p_run_id
                  AND r.opt_grid_arms IS NOT NULL
                  AND jsonb_typeof(r.opt_grid_arms) = 'array'
                  AND jsonb_array_length(r.opt_grid_arms) > 0
           ) THEN
            PERFORM process_logic_opt_trades(
                p_logic_id, p_tf_id, p_bar_dt, TRUE, p_run_id, v_balance
            );
            PERFORM logic_opt_maybe_promote(
                p_logic_id, p_tf_id, p_bar_dt, TRUE, p_run_id
            );
        END IF;
    END IF;

    v_balance := logic_backtest_park_excess_cash(
        p_run_id, p_logic_id, p_account_id, p_tf_id, p_bar_dt, v_balance
    );
    RETURN v_balance;
END;
$$;

COMMENT ON FUNCTION logic_backtest_process_bar(BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMP, TIMESTAMP, TIMESTAMP, NUMERIC) IS
'Тест: rate → risk → EOD → signals → OPT(paper/promote) → park.';

-- Прогон по свечам (единый мозг теста): rate → risk → EOD → signals → park.
-- PROCEDURE + COMMIT каждые N баров: иначе одна длинная tx держит локи и UI не видит прогресс.
DROP ROUTINE IF EXISTS logic_backtest_run_bars(BIGINT);

CREATE OR REPLACE PROCEDURE logic_backtest_run_bars(p_run_id BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
    v_run RECORD;
    v_logic RECORD;
    v_tf_id INTEGER;
    v_balance NUMERIC;
    v_bars TIMESTAMP[];
    v_total INTEGER;
    v_i INTEGER;
    v_bar_dt TIMESTAMP;
    v_prev_bar TIMESTAMP;
    v_next_bar TIMESTAMP;
    v_pnl NUMERIC;
    v_trades_created INTEGER;
    v_diag JSONB;
    v_commit_every INTEGER := 5;
BEGIN
    SELECT r.id, r.logic_id, r.date_from, r.date_to, r.status, r.cancel_requested, r.test_balance
    INTO v_run
    FROM logic_backtest_runs r
    WHERE r.id = p_run_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'backtest run % не найден', p_run_id;
    END IF;

    IF v_run.status IN ('completed', 'cancelled', 'failed') THEN
        RETURN;
    END IF;

    IF COALESCE(v_run.cancel_requested, FALSE) THEN
        PERFORM logic_backtest_update_run(p_run_id, 'cancelled', NULL, 'Отменено', NULL);
        COMMIT;
        RETURN;
    END IF;

    SELECT l.id, l.account_id INTO v_logic
    FROM logics l WHERE l.id = v_run.logic_id;
    IF NOT FOUND THEN
        PERFORM logic_backtest_update_run(
            p_run_id, 'failed', 100, 'Логика не найдена', NULL, NULL, NULL, NULL, NULL, 0,
            format('Логика %s не найдена', v_run.logic_id)
        );
        COMMIT;
        RETURN;
    END IF;

    PERFORM logic_ensure_non_trading_periods(v_run.logic_id);

    v_tf_id := logic_resolve_timeframe_id(v_run.logic_id);
    IF v_tf_id IS NULL THEN
        PERFORM logic_backtest_update_run(
            p_run_id, 'failed', 100, 'Не задан timeframe', NULL, NULL, NULL, NULL, NULL, 0,
            'Не задан timeframe'
        );
        COMMIT;
        RETURN;
    END IF;

    v_balance := COALESCE(
        NULLIF(v_run.test_balance, 0),
        NULLIF(get_logic_param_numeric(v_run.logic_id, 'initial_balance', NULL), 0),
        1000000
    );

    SELECT array_agg(DISTINCT p.dt ORDER BY p.dt)
    INTO v_bars
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = v_run.logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = v_tf_id
      AND p.dt::date BETWEEN v_run.date_from AND v_run.date_to;

    v_total := COALESCE(array_length(v_bars, 1), 0);
    UPDATE logic_backtest_runs
    SET total_bars = v_total,
        trades_created = 0,
        processed_bars = 0
    WHERE id = p_run_id;

    IF v_total = 0 THEN
        PERFORM logic_backtest_update_run(
            p_run_id, 'failed', 100, 'Нет свечей', NULL, NULL, NULL, NULL, v_balance, 0,
            'Нет цен в выбранном периоде'
        );
        COMMIT;
        RETURN;
    END IF;

    PERFORM logic_backtest_update_run(
        p_run_id, 'running', 40, 'Прогон по свечам',
        format('0 / %s баров', v_total),
        NULL, 0, NULL, v_balance
    );
    COMMIT;

    FOR v_i IN 1..v_total LOOP
        IF logic_backtest_cancel_requested(p_run_id) THEN
            SELECT COALESCE(SUM(financial_result), 0) INTO v_pnl
            FROM logic_trades
            WHERE logic_id = v_run.logic_id
              AND is_test = TRUE
              AND COALESCE(opt_lane, '') = '';
            PERFORM logic_opt_restore_formulas_from_run(p_run_id);
            PERFORM logic_backtest_log(
                p_run_id, v_run.logic_id, 'backtest.cancelled',
                format('Отменено на %s/%s', v_i, v_total), NULL
            );
            PERFORM logic_backtest_update_run(
                p_run_id, 'cancelled',
                round(40 + v_i::NUMERIC / v_total * 60, 2),
                'Отменено пользователем', NULL, v_bars[v_i], v_i, NULL, v_balance, v_pnl
            );
            COMMIT;
            RETURN;
        END IF;

        v_bar_dt := v_bars[v_i];
        v_prev_bar := CASE WHEN v_i > 1 THEN v_bars[v_i - 1] ELSE NULL END;
        v_next_bar := CASE WHEN v_i < v_total THEN v_bars[v_i + 1] ELSE NULL END;

        v_balance := logic_backtest_process_bar(
            p_run_id, v_run.logic_id, v_logic.account_id, v_tf_id,
            v_bar_dt, v_prev_bar, v_next_bar, v_balance
        );

        IF v_i % v_commit_every = 0 OR v_i = v_total THEN
            PERFORM logic_backtest_update_run(
                p_run_id, 'running',
                round(40 + v_i::NUMERIC / v_total * 60, 2),
                'Прогон по свечам',
                format('%s / %s баров', v_i, v_total),
                v_bar_dt, v_i, NULL, v_balance
            );
            COMMIT;
        END IF;
    END LOOP;

    IF v_total > 0 THEN
        v_balance := logic_backtest_park_excess_cash(
            p_run_id, v_run.logic_id, v_logic.account_id, v_tf_id, v_bars[v_total], v_balance
        );
    END IF;

    SELECT COALESCE(SUM(financial_result), 0) INTO v_pnl
    FROM logic_trades
    WHERE logic_id = v_run.logic_id
      AND is_test = TRUE
      AND COALESCE(opt_lane, '') = '';

    SELECT COUNT(*)::INTEGER INTO v_trades_created
    FROM logic_trades
    WHERE logic_id = v_run.logic_id
      AND is_test = TRUE
      AND COALESCE(opt_lane, '') = '';

    v_diag := logic_backtest_diagnose(
        p_run_id, v_run.logic_id, v_tf_id, v_run.date_from, v_run.date_to
    );

    PERFORM logic_opt_restore_formulas_from_run(p_run_id);

    PERFORM logic_backtest_log(
        p_run_id, v_run.logic_id, 'backtest.complete',
        CASE WHEN v_trades_created > 0
            THEN format('Завершено: %s сделок, PnL=%s', v_trades_created, round(v_pnl, 2))
            ELSE format('Завершено без сделок (%s баров)', v_total)
        END,
        v_diag || jsonb_build_object(
            'trades_created', v_trades_created,
            'financial_result', v_pnl,
            'total_bars', v_total,
            'engine', 'sql_procedure'
        ),
        NULL, v_tf_id
    );

    PERFORM logic_backtest_update_run(
        p_run_id, 'completed', 100,
        CASE WHEN v_trades_created > 0 THEN 'Тестирование завершено' ELSE 'Тест завершён — сделок нет' END,
        format('%s баров, сделок: %s', v_total, v_trades_created),
        v_bars[v_total], v_total, v_trades_created, v_balance, v_pnl
    );
    COMMIT;
END;
$$;

COMMENT ON PROCEDURE logic_backtest_run_bars(BIGINT) IS
'SQL-робот теста: прогон баров с COMMIT каждые 5 свечей (без длинного лока на весь тест)';

DROP ROUTINE IF EXISTS run_logic_backtest(INTEGER, DATE, DATE);
DROP ROUTINE IF EXISTS run_logic_backtest(INTEGER, DATE, DATE, BIGINT);

CREATE OR REPLACE PROCEDURE run_logic_backtest(
    p_logic_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    INOUT o_run_id BIGINT DEFAULT NULL
)
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
    v_date_from DATE;
    v_date_to DATE;
    v_load_from DATE;
    v_cash_fund_code TEXT;
    v_cash_fund_id INTEGER;
    v_end_dt TIMESTAMP;
    v_point_count INTEGER;
    v_prices_in_period INTEGER;
    v_ind_in_period INTEGER;
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

    PERFORM logic_ensure_non_trading_periods(p_logic_id);

    v_tf_id := logic_resolve_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        RAISE EXCEPTION 'Не задан timeframe';
    END IF;
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = v_tf_id;

    v_balance := COALESCE(
        NULLIF(get_logic_param_numeric(p_logic_id, 'initial_balance', NULL), 0),
        1000000
    );
    v_days_span := GREATEST(1, (v_date_to - v_load_from) + 1);
    v_point_count := GREATEST(500, CEIL(v_days_span * (86400.0 / GREATEST(v_tf_sec, 60)))::INTEGER + 200);

    DELETE FROM logic_trades WHERE logic_id = p_logic_id AND is_test = TRUE;
    PERFORM logic_backtest_reset_signal_ratings(p_logic_id);

    v_cash_fund_code := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'cash_fund_code'), '')));
    IF v_cash_fund_code IN ('TMON', 'LQDT', 'SBMM') THEN
        PERFORM logic_ensure_cash_fund_security(p_logic_id, v_cash_fund_code);
        SELECT s.id
        INTO v_cash_fund_id
        FROM securities s
        JOIN security_prefixes sp ON sp.security_id = s.id
        WHERE upper(sp.prefix) = v_cash_fund_code
        ORDER BY sp.exchange_id
        LIMIT 1;
    ELSE
        v_cash_fund_id := NULL;
    END IF;

    INSERT INTO logic_backtest_runs (
        logic_id, date_from, date_to, status, progress_pct,
        phase_message, test_balance, started_at
    )
    VALUES (
        p_logic_id, v_date_from, v_date_to, 'loading_prices', 0,
        'Загрузка цен', v_balance, CURRENT_TIMESTAMP
    )
    RETURNING id INTO v_run_id;
    o_run_id := v_run_id;
    COMMIT;

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
            COMMIT;
            RETURN;
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
          AND NOT EXISTS (
              SELECT 1 FROM security_prefixes sp
              WHERE sp.security_id = ls.security_id
                AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
          )
        ORDER BY ls.display_order, ls.id
    LOOP
        IF logic_backtest_cancel_requested(v_run_id) THEN
            PERFORM logic_backtest_log(v_run_id, p_logic_id, 'backtest.cancelled', 'Отменено на загрузке', NULL);
            PERFORM logic_backtest_update_run(v_run_id, 'cancelled', NULL, 'Отменено', NULL);
            COMMIT;
            RETURN;
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
        COMMIT;
    END LOOP;

    -- Цены денежного фонда (сигналы по нему не гоняем, но парковка в тесте нужна).
    IF v_cash_fund_id IS NOT NULL THEN
        BEGIN
            CALL logic_backtest_ensure_security_data(
                v_run_id, p_logic_id, v_cash_fund_id, v_tf_id,
                v_load_from, v_date_from, v_date_to, v_end_dt, v_point_count,
                v_pl, v_pc, v_is, v_ic, v_ie
            );
        EXCEPTION WHEN OTHERS THEN
            PERFORM logic_backtest_log(
                v_run_id, p_logic_id, 'backtest.cash_fund.prices.error', SQLERRM,
                jsonb_build_object('security_id', v_cash_fund_id, 'fund', v_cash_fund_code),
                v_cash_fund_id, v_tf_id
            );
        END;
        COMMIT;
    END IF;

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
        COMMIT;
        RETURN;
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
    COMMIT;

    IF v_ind_in_period = 0 THEN
        PERFORM logic_backtest_update_run(
            v_run_id, 'failed', 100, 'Нет индикаторов', NULL, NULL, NULL, NULL, v_balance, 0,
            'Индикаторы не рассчитаны. См. backtest.indicator.error.'
        );
        COMMIT;
        RETURN;
    END IF;

    -- Единый SQL-прогон баров (тот же путь, что вызывает Node после parallel prep).
    CALL logic_backtest_run_bars(v_run_id);
    o_run_id := v_run_id;
END;
$$;

COMMENT ON PROCEDURE run_logic_backtest(INTEGER, DATE, DATE, BIGINT) IS
'Исторический backtest (SQL PROCEDURE): загрузка + logic_backtest_run_bars с частыми COMMIT';

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
