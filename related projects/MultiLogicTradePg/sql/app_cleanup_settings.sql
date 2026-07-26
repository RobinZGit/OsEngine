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

CREATE OR REPLACE FUNCTION app_cleanup_last_at()
RETURNS TIMESTAMP
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(btrim(pv.value), '')::TIMESTAMP
    FROM parameter_values pv
    JOIN parameter_types pt ON pt.id = pv.parameter_type_id
    JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
    WHERE ps.name = 'Default'
      AND pt.short_name = 'APP_CLEANUP_LAST_AT'
    LIMIT 1;
$$;

COMMENT ON FUNCTION app_cleanup_last_at() IS
'Время последней автоочистки диска (parameter_values APP_CLEANUP_LAST_AT)';

-- CURRENT_TIMESTAMP is timestamptz; CALL with it must match this signature (not TIMESTAMP).
DROP PROCEDURE IF EXISTS set_app_cleanup_last_at(TIMESTAMP);
DROP PROCEDURE IF EXISTS set_app_cleanup_last_at(TIMESTAMPTZ);

CREATE OR REPLACE PROCEDURE set_app_cleanup_last_at(p_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
BEGIN
    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'APP_CLEANUP_LAST_AT' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RAISE EXCEPTION 'APP_CLEANUP_LAST_AT not found in parameter_types';
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (
        v_set_id,
        v_type_id,
        to_char(COALESCE(p_at, CURRENT_TIMESTAMP), 'YYYY-MM-DD"T"HH24:MI:SS')
    )
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON PROCEDURE set_app_cleanup_last_at(TIMESTAMPTZ) IS
'Записать время последней автоочистки диска';

CREATE OR REPLACE FUNCTION run_cleanup_if_enabled()
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_result JSONB;
BEGIN
    IF NOT cleanup_unused_market_data_enabled() THEN
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'disabled');
    END IF;
    v_result := cleanup_trading_disk_space();
    CALL set_app_cleanup_last_at(CURRENT_TIMESTAMP);
    RETURN jsonb_build_object('ok', TRUE, 'result', v_result);
END;
$$;

COMMENT ON FUNCTION run_cleanup_if_enabled() IS
'Если APP_CLEANUP_DISK включён — выполнить cleanup_trading_disk_space и обновить APP_CLEANUP_LAST_AT';
