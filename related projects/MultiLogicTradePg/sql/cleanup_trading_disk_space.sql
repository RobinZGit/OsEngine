-- ============================================
-- Очистка диска: старые/лишние цены, тесты, tech log, indicator_values
-- Вызов: SELECT cleanup_trading_disk_space();
--         SELECT cleanup_unused_indicator_values();
-- Advisory lock: не пересекается с торговлей / второй очисткой.
-- ============================================

-- Обрезка indicator_values:
-- 1) сироты (нет активной security_indicator_series на бумагу+индикатор+серию);
-- 2) старше окна хранения, кроме защиты running/pending бэктестов (date_from − warmup).
CREATE OR REPLACE FUNCTION cleanup_unused_indicator_values(
    p_keep_days INTEGER DEFAULT 120,
    p_warmup_days INTEGER DEFAULT 45,
    p_batch_size INTEGER DEFAULT 50000
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_keep_from TIMESTAMP;
    v_test_from TIMESTAMP;
    v_batch INTEGER := GREATEST(COALESCE(p_batch_size, 50000), 1000);
    v_orphans INTEGER := 0;
    v_aged INTEGER := 0;
    v_n INTEGER;
    v_got_lock BOOLEAN := FALSE;
    v_lock_key BIGINT := hashtext('multilogictrade_disk_cleanup');
BEGIN
    PERFORM set_config('lock_timeout', '5s', TRUE);
    PERFORM set_config('statement_timeout', '600s', TRUE);

    v_got_lock := pg_try_advisory_lock(v_lock_key);
    IF NOT v_got_lock THEN
        RETURN jsonb_build_object(
            'skipped', TRUE,
            'reason', 'cleanup_lock_busy',
            'message', 'Очистка уже выполняется или lock занят — повторите позже'
        );
    END IF;

    BEGIN
        v_keep_from := CURRENT_TIMESTAMP
            - (GREATEST(COALESCE(p_keep_days, 120), 14) || ' days')::INTERVAL;

        SELECT MIN(r.date_from::TIMESTAMP)
            - (GREATEST(COALESCE(p_warmup_days, 45), 7) || ' days')::INTERVAL
        INTO v_test_from
        FROM logic_backtest_runs r
        WHERE r.status IN (
            'pending', 'loading_prices', 'loading_indicators', 'running'
        );

        IF v_test_from IS NOT NULL AND v_test_from < v_keep_from THEN
            v_keep_from := v_test_from;
        END IF;

        -- 1) Сироты: нет активной серии sis на (security, indicator, series_code)
        LOOP
            DELETE FROM indicator_values iv
            WHERE iv.id IN (
                SELECT x.id
                FROM indicator_values x
                JOIN indicator_value_types ivt ON ivt.id = x.indicator_value_type_id
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM security_indicator_series sis
                    WHERE sis.security_id = x.security_id
                      AND sis.indicator_id = x.indicator_id
                      AND sis.is_active
                      AND upper(btrim(sis.series_code)) = upper(btrim(ivt.code))
                )
                LIMIT v_batch
            );
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_orphans := v_orphans + v_n;
            EXIT WHEN v_n = 0;
        END LOOP;

        -- 2) Старые точки даже у активных серий (окно + защита running-тестов)
        LOOP
            DELETE FROM indicator_values iv
            WHERE iv.id IN (
                SELECT x.id
                FROM indicator_values x
                WHERE x.dt < v_keep_from
                LIMIT v_batch
            );
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_aged := v_aged + v_n;
            EXIT WHEN v_n = 0;
        END LOOP;

        PERFORM pg_advisory_unlock(v_lock_key);

        RETURN jsonb_build_object(
            'ok', TRUE,
            'orphans_deleted', v_orphans,
            'aged_deleted', v_aged,
            'keep_from', v_keep_from,
            'keep_days', GREATEST(COALESCE(p_keep_days, 120), 14),
            'warmup_days', GREATEST(COALESCE(p_warmup_days, 45), 7),
            'protected_test_from', v_test_from
        );
    EXCEPTION
        WHEN OTHERS THEN
            PERFORM pg_advisory_unlock(v_lock_key);
            RAISE;
    END;
END;
$$;

COMMENT ON FUNCTION cleanup_unused_indicator_values(INTEGER, INTEGER, INTEGER) IS
'Автообрезка indicator_values: сироты без активной sis + старше keep_days; running бэктесты защищены (date_from-warmup).';

CREATE OR REPLACE FUNCTION cleanup_trading_disk_space(
    p_keep_days_active INTEGER DEFAULT 90,
    p_keep_days_other INTEGER DEFAULT 14,
    p_tech_log_keep_days INTEGER DEFAULT 7
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_cutoff_active TIMESTAMP;
    v_cutoff_other TIMESTAMP;
    v_cutoff_tech TIMESTAMP;
    v_prices_deleted INTEGER := 0;
    v_tech_deleted INTEGER := 0;
    v_test_trades_deleted INTEGER := 0;
    v_rating_test_deleted INTEGER := 0;
    v_backtest_runs_deleted INTEGER := 0;
    v_indicator_cleanup JSONB;
    v_got_lock BOOLEAN := FALSE;
    v_lock_key BIGINT := hashtext('multilogictrade_disk_cleanup');
BEGIN
    PERFORM set_config('lock_timeout', '5s', TRUE);
    PERFORM set_config('statement_timeout', '600s', TRUE);

    v_got_lock := pg_try_advisory_lock(v_lock_key);
    IF NOT v_got_lock THEN
        RETURN jsonb_build_object(
            'skipped', TRUE,
            'reason', 'cleanup_lock_busy',
            'message', 'Очистка уже выполняется или lock занят — повторите позже'
        );
    END IF;

    BEGIN
        v_cutoff_active := CURRENT_TIMESTAMP - (GREATEST(COALESCE(p_keep_days_active, 90), 1) || ' days')::INTERVAL;
        v_cutoff_other := CURRENT_TIMESTAMP - (GREATEST(COALESCE(p_keep_days_other, 14), 1) || ' days')::INTERVAL;
        v_cutoff_tech := CURRENT_TIMESTAMP - (GREATEST(COALESCE(p_tech_log_keep_days, 7), 1) || ' days')::INTERVAL;

        CREATE TEMP TABLE IF NOT EXISTS _cleanup_active_securities (
            security_id INTEGER PRIMARY KEY
        ) ON COMMIT DROP;
        TRUNCATE _cleanup_active_securities;

        INSERT INTO _cleanup_active_securities (security_id)
        SELECT DISTINCT security_id
        FROM (
            SELECT sis.security_id
            FROM security_indicator_series sis
            WHERE sis.is_active
            UNION
            SELECT ls.security_id
            FROM logic_securities ls
            JOIN logics l ON l.id = ls.logic_id
            WHERE l.is_enabled
        ) u
        ON CONFLICT DO NOTHING;

        ANALYZE _cleanup_active_securities;

        DELETE FROM prices p
        WHERE p.dt < CASE
            WHEN EXISTS (
                SELECT 1 FROM _cleanup_active_securities a WHERE a.security_id = p.security_id
            )
            THEN v_cutoff_active
            ELSE v_cutoff_other
        END;
        GET DIAGNOSTICS v_prices_deleted = ROW_COUNT;

        DELETE FROM logic_trades
        WHERE is_test;
        GET DIAGNOSTICS v_test_trades_deleted = ROW_COUNT;

        DELETE FROM logic_signal_rating_history
        WHERE is_test;
        GET DIAGNOSTICS v_rating_test_deleted = ROW_COUNT;

        DELETE FROM logic_backtest_runs
        WHERE status IN ('completed', 'cancelled', 'failed');
        GET DIAGNOSTICS v_backtest_runs_deleted = ROW_COUNT;

        IF to_regclass('public.app_tech_log') IS NOT NULL THEN
            DELETE FROM app_tech_log
            WHERE created_at < v_cutoff_tech;
            GET DIAGNOSTICS v_tech_deleted = ROW_COUNT;
        END IF;

        -- Release lock before indicator trim (same lock key inside that function).
        PERFORM pg_advisory_unlock(v_lock_key);
        v_got_lock := FALSE;

        -- keep_days for indicators: max(active price keep, 120)
        v_indicator_cleanup := cleanup_unused_indicator_values(
            GREATEST(COALESCE(p_keep_days_active, 90), 120),
            45,
            50000
        );

        RETURN jsonb_build_object(
            'ok', TRUE,
            'prices_deleted', v_prices_deleted,
            'test_trades_deleted', v_test_trades_deleted,
            'rating_test_history_deleted', v_rating_test_deleted,
            'backtest_runs_deleted', v_backtest_runs_deleted,
            'indicator_values', v_indicator_cleanup,
            'tech_log_deleted', v_tech_deleted,
            'keep_days_active', GREATEST(COALESCE(p_keep_days_active, 90), 1),
            'keep_days_other', GREATEST(COALESCE(p_keep_days_other, 14), 1),
            'tech_log_keep_days', GREATEST(COALESCE(p_tech_log_keep_days, 7), 1)
        );
    EXCEPTION
        WHEN OTHERS THEN
            IF v_got_lock THEN
                PERFORM pg_advisory_unlock(v_lock_key);
            END IF;
            RAISE;
    END;
END;
$$;

COMMENT ON FUNCTION cleanup_trading_disk_space(INTEGER, INTEGER, INTEGER) IS
'Удаляет лишние цены/тесты/логи + cleanup_unused_indicator_values; advisory lock; timeouts.';
