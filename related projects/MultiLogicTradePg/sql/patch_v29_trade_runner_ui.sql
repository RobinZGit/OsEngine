-- v29: trade runner only when Angular UI sends heartbeat
INSERT INTO parameter_types (name, short_name, value_type, description, default_value)
VALUES (
    'Heartbeat UI trade runner',
    'APP_TRADE_RUNNER_HB',
    'text',
    'Last Angular heartbeat; run_trade_cycle skips without it',
    ''
)
ON CONFLICT (short_name) DO NOTHING;

CREATE OR REPLACE FUNCTION trade_runner_ui_heartbeat_ttl_sec()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE AS $$
    SELECT 90;
$$;

CREATE OR REPLACE FUNCTION trade_runner_ui_is_active()
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_raw TEXT;
    v_ts TIMESTAMP;
    v_ttl INTEGER;
BEGIN
    SELECT btrim(pv.value)
    INTO v_raw
    FROM parameter_values pv
    JOIN parameter_types pt ON pt.id = pv.parameter_type_id
    JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
    WHERE ps.name = 'Default'
      AND pt.short_name = 'APP_TRADE_RUNNER_HB'
    LIMIT 1;

    IF COALESCE(v_raw, '') = '' THEN
        RETURN FALSE;
    END IF;

    BEGIN
        v_ts := v_raw::TIMESTAMP;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN FALSE;
    END;

    v_ttl := trade_runner_ui_heartbeat_ttl_sec();
    RETURN v_ts >= (LOCALTIMESTAMP - make_interval(secs => v_ttl));
END;
$$;

CREATE OR REPLACE PROCEDURE touch_trade_runner_ui_heartbeat()
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
BEGIN
    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'APP_TRADE_RUNNER_HB' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RAISE EXCEPTION 'APP_TRADE_RUNNER_HB not found';
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (v_set_id, v_type_id, to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS'))
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = EXCLUDED.value, record_date = CURRENT_TIMESTAMP;
END;
$$;

CREATE OR REPLACE PROCEDURE clear_trade_runner_ui_heartbeat()
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
BEGIN
    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'APP_TRADE_RUNNER_HB' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (v_set_id, v_type_id, '')
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = '', record_date = CURRENT_TIMESTAMP;
END;
$$;

CREATE OR REPLACE FUNCTION run_trade_cycle()
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_total_created INTEGER := 0;
    v_processed INTEGER := 0;
    v_got_lock BOOLEAN;
BEGIN
    v_got_lock := pg_try_advisory_lock(hashtext('multilogictrade_run_trade_cycle'));
    IF NOT v_got_lock THEN
        PERFORM app_tech_log_event('trade-runner', 'cycle.skip', 'locked', 'postgresql');
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'locked');
    END IF;

    IF NOT trade_runner_ui_is_active() THEN
        PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));
        PERFORM app_tech_log_event('trade-runner', 'cycle.skip', 'ui_inactive', 'postgresql');
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'ui_inactive');
    END IF;

    PERFORM app_tech_log_event('trade-runner', 'cycle.start', 'run_trade_cycle', 'postgresql');

    FOR v_logic IN
        SELECT l.id
        FROM logics l
        JOIN accounts a ON a.id = l.account_id
        WHERE l.is_enabled = TRUE AND a.is_active = TRUE
        ORDER BY l.id
    LOOP
        v_processed := v_processed + 1;
        v_total_created := v_total_created + process_logic_trades(v_logic.id);
    END LOOP;

    PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));

    PERFORM app_tech_log_event(
        'trade-runner',
        'cycle.end',
        format('processed=%s created=%s', v_processed, v_total_created),
        'postgresql',
        'event',
        NULL,
        NULL,
        NULL,
        jsonb_build_object('processed', v_processed, 'created', v_total_created)
    );

    RETURN jsonb_build_object(
        'processed', v_processed,
        'created', v_total_created,
        'at', CURRENT_TIMESTAMP
    );
EXCEPTION
    WHEN OTHERS THEN
        PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));
        RAISE;
END;
$$;
