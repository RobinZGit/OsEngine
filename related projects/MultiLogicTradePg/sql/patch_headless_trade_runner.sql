-- Headless trade runner (default): UI heartbeat optional.
-- Applied via 01 (parameter type) + 02 (functions). Safe to re-run on existing DBs.

ALTER TABLE parameter_types ALTER COLUMN short_name TYPE VARCHAR(40);

INSERT INTO parameter_types (name, short_name, value_type, default_value) VALUES
    ('Trade runner требует открытый UI', 'APP_TRADE_RUNNER_REQUIRE_UI', 'boolean', '0')
ON CONFLICT (short_name) DO NOTHING;

CREATE OR REPLACE FUNCTION trade_runner_require_ui()
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_raw TEXT;
BEGIN
    SELECT lower(btrim(pv.value))
    INTO v_raw
    FROM parameter_values pv
    JOIN parameter_types pt ON pt.id = pv.parameter_type_id
    JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
    WHERE ps.name = 'Default'
      AND pt.short_name = 'APP_TRADE_RUNNER_REQUIRE_UI'
    LIMIT 1;

    IF v_raw IS NULL OR v_raw = '' THEN
        RETURN FALSE;
    END IF;
    RETURN v_raw IN ('1', 'true', 'yes', 'on', 't');
END;
$$;

COMMENT ON FUNCTION trade_runner_require_ui() IS
'TRUE только если APP_TRADE_RUNNER_REQUIRE_UI включён; по умолчанию FALSE (headless / сервер)';
