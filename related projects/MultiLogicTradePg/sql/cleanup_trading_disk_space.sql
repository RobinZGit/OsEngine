-- ============================================
-- Очистка диска: старые/лишние цены, тесты, tech log
-- Вызов: SELECT cleanup_trading_disk_space();
-- Advisory lock: не пересекается с торговлей / второй очисткой.
-- ============================================

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
    v_indicator_values_deleted INTEGER := 0;
    v_got_lock BOOLEAN := FALSE;
    v_lock_key BIGINT := hashtext('multilogictrade_disk_cleanup');
BEGIN
    -- Не ждать чужие lock'и минутами (типичная ошибка на боевой БД).
    PERFORM set_config('lock_timeout', '5s', TRUE);
    PERFORM set_config('statement_timeout', '120s', TRUE);

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

        -- Активные бумаги: серии индикаторов + бумаги включённых логик (без correlated EXISTS на prices).
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

        -- Тестовые сделки (lots CASCADE / SET NULL по FK)
        DELETE FROM logic_trades
        WHERE is_test;
        GET DIAGNOSTICS v_test_trades_deleted = ROW_COUNT;

        DELETE FROM logic_signal_rating_history
        WHERE is_test;
        GET DIAGNOSTICS v_rating_test_deleted = ROW_COUNT;

        -- Завершённые прогоны (reports/security_state — CASCADE)
        DELETE FROM logic_backtest_runs
        WHERE status IN ('completed', 'cancelled', 'failed');
        GET DIAGNOSTICS v_backtest_runs_deleted = ROW_COUNT;

        DELETE FROM indicator_values iv
        WHERE iv.dt < v_cutoff_active
          AND NOT EXISTS (
              SELECT 1
              FROM security_indicator_series sis
              JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
              WHERE sis.security_id = iv.security_id
                AND sis.indicator_id = iv.indicator_id
                AND sis.is_active
                AND upper(btrim(sis.series_code)) = upper(btrim(ivt.code))
          );
        GET DIAGNOSTICS v_indicator_values_deleted = ROW_COUNT;

        IF to_regclass('public.app_tech_log') IS NOT NULL THEN
            DELETE FROM app_tech_log
            WHERE created_at < v_cutoff_tech;
            GET DIAGNOSTICS v_tech_deleted = ROW_COUNT;
        END IF;

        PERFORM pg_advisory_unlock(v_lock_key);

        RETURN jsonb_build_object(
            'ok', TRUE,
            'prices_deleted', v_prices_deleted,
            'test_trades_deleted', v_test_trades_deleted,
            'rating_test_history_deleted', v_rating_test_deleted,
            'backtest_runs_deleted', v_backtest_runs_deleted,
            'indicator_values_deleted', v_indicator_values_deleted,
            'tech_log_deleted', v_tech_deleted,
            'keep_days_active', GREATEST(COALESCE(p_keep_days_active, 90), 1),
            'keep_days_other', GREATEST(COALESCE(p_keep_days_other, 14), 1),
            'tech_log_keep_days', GREATEST(COALESCE(p_tech_log_keep_days, 7), 1)
        );
    EXCEPTION
        WHEN OTHERS THEN
            PERFORM pg_advisory_unlock(v_lock_key);
            RAISE;
    END;
END;
$$;

COMMENT ON FUNCTION cleanup_trading_disk_space(INTEGER, INTEGER, INTEGER) IS
'Удаляет лишние цены/тесты/логи; advisory lock multilogictrade_disk_cleanup; lock/statement timeout; temp list активных бумаг.';
