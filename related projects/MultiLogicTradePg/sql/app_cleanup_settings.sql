-- ============================================
-- Настройка очистки лишних данных (APP_CLEANUP_DISK)
-- Вставляется в 02 после set_app_tech_logging
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_unused_market_data_enabled()
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (
            SELECT lower(btrim(pv.value)) IN ('1', 'true', 'yes', 'on')
            FROM parameter_values pv
            JOIN parameter_types pt ON pt.id = pv.parameter_type_id
            JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
            WHERE ps.name = 'Default'
              AND pt.short_name = 'APP_CLEANUP_DISK'
            LIMIT 1
        ),
        FALSE
    );
$$;

COMMENT ON FUNCTION cleanup_unused_market_data_enabled() IS
'TRUE, если в parameter_values (Default) включён APP_CLEANUP_DISK';

CREATE OR REPLACE PROCEDURE set_cleanup_unused_market_data(p_enabled BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
BEGIN
    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'APP_CLEANUP_DISK' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RAISE EXCEPTION 'APP_CLEANUP_DISK not found in parameter_types';
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (v_set_id, v_type_id, CASE WHEN COALESCE(p_enabled, FALSE) THEN '1' ELSE '0' END)
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON PROCEDURE set_cleanup_unused_market_data(BOOLEAN) IS
'Вкл/выкл предпочтение очистки лишних цен/тестов/логов (общие настройки UI)';
