-- ============================================
-- Очистка диска: старые/лишние цены, тесты, tech log
-- Вызов: SELECT cleanup_trading_disk_space();
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
BEGIN
    v_cutoff_active := CURRENT_TIMESTAMP - (GREATEST(COALESCE(p_keep_days_active, 90), 1) || ' days')::INTERVAL;
    v_cutoff_other := CURRENT_TIMESTAMP - (GREATEST(COALESCE(p_keep_days_other, 14), 1) || ' days')::INTERVAL;
    v_cutoff_tech := CURRENT_TIMESTAMP - (GREATEST(COALESCE(p_tech_log_keep_days, 7), 1) || ' days')::INTERVAL;

    -- Цены: для бумаг с активными сериями индикаторов или в бумагах enabled-логик
    -- оставляем окно keep_days_active; остальное — короче (keep_days_other).
    DELETE FROM prices p
    WHERE p.dt < CASE
        WHEN EXISTS (
            SELECT 1
            FROM security_indicator_series sis
            WHERE sis.security_id = p.security_id
              AND sis.is_active
        )
        OR EXISTS (
            SELECT 1
            FROM logic_securities ls
            JOIN logics l ON l.id = ls.logic_id
            WHERE ls.security_id = p.security_id
              AND l.is_enabled
        )
        THEN v_cutoff_active
        ELSE v_cutoff_other
    END;
    GET DIAGNOSTICS v_prices_deleted = ROW_COUNT;

    -- Тестовые сделки
    DELETE FROM logic_trades
    WHERE is_test;
    GET DIAGNOSTICS v_test_trades_deleted = ROW_COUNT;

    -- История рейтинга только для тестов
    DELETE FROM logic_signal_rating_history
    WHERE is_test;
    GET DIAGNOSTICS v_rating_test_deleted = ROW_COUNT;

    -- Завершённые прогоны бэктеста (security_state — CASCADE)
    DELETE FROM logic_backtest_runs
    WHERE status IN ('completed', 'cancelled', 'failed');
    GET DIAGNOSTICS v_backtest_runs_deleted = ROW_COUNT;

    -- Значения индикаторов без активной серии и старше окна
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

    -- Техжурнал старше окна
    IF to_regclass('public.app_tech_log') IS NOT NULL THEN
        DELETE FROM app_tech_log
        WHERE created_at < v_cutoff_tech;
        GET DIAGNOSTICS v_tech_deleted = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
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
END;
$$;

COMMENT ON FUNCTION cleanup_trading_disk_space(INTEGER, INTEGER, INTEGER) IS
'Удаляет лишние цены/тесты/логи для экономии диска; сохраняет недавние цены для активных индикаторов и enabled-логик.';
