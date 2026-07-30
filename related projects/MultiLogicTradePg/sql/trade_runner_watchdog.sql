-- Trade runner watchdog: last-ok heartbeat, health status, kick stuck cycles.
-- Applied via 02 (after UI heartbeat helpers). Safe to re-run (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION trade_runner_stale_sec()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE AS $$
    SELECT 90;
$$;

COMMENT ON FUNCTION trade_runner_stale_sec() IS
'Сколько секунд без успешного цикла = торговля «спит» (Node/pg_cron watchdog)';

CREATE OR REPLACE PROCEDURE touch_trade_runner_last_ok(p_source TEXT DEFAULT 'node')
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
    v_src TEXT := COALESCE(NULLIF(btrim(p_source), ''), 'node');
BEGIN
    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'APP_TRADE_RUNNER_LAST_OK' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (
        v_set_id,
        v_type_id,
        to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS') || '|' || left(v_src, 32)
    )
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON PROCEDURE touch_trade_runner_last_ok(TEXT) IS
'Записать время последнего успешного/живого торгового цикла (APP_TRADE_RUNNER_LAST_OK)';

CREATE OR REPLACE FUNCTION trade_runner_last_ok_at()
RETURNS TIMESTAMP
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_raw TEXT;
    v_ts_part TEXT;
BEGIN
    SELECT btrim(pv.value)
    INTO v_raw
    FROM parameter_values pv
    JOIN parameter_types pt ON pt.id = pv.parameter_type_id
    JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
    WHERE ps.name = 'Default'
      AND pt.short_name = 'APP_TRADE_RUNNER_LAST_OK'
    LIMIT 1;

    IF COALESCE(v_raw, '') = '' THEN
        RETURN NULL;
    END IF;

    v_ts_part := split_part(v_raw, '|', 1);
    BEGIN
        RETURN v_ts_part::TIMESTAMP;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN NULL;
    END;
END;
$$;

COMMENT ON FUNCTION trade_runner_last_ok_at() IS
'TIMESTAMP последнего живого цикла из APP_TRADE_RUNNER_LAST_OK';

CREATE OR REPLACE FUNCTION trade_runner_enabled_count()
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT COUNT(*)::int
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.is_enabled = TRUE
      AND a.is_active = TRUE;
$$;

CREATE OR REPLACE FUNCTION trade_runner_is_stale()
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_last TIMESTAMP;
    v_ttl INTEGER;
BEGIN
    IF trade_runner_enabled_count() <= 0 THEN
        RETURN FALSE;
    END IF;
    IF trade_runner_require_ui() AND NOT trade_runner_ui_is_active() THEN
        RETURN TRUE;
    END IF;
    v_last := trade_runner_last_ok_at();
    IF v_last IS NULL THEN
        RETURN TRUE;
    END IF;
    v_ttl := trade_runner_stale_sec();
    RETURN v_last < (LOCALTIMESTAMP - make_interval(secs => v_ttl));
END;
$$;

COMMENT ON FUNCTION trade_runner_is_stale() IS
'TRUE если есть включённые логики и цикл давно не отмечался (или UI обязателен, но мёртв)';

CREATE OR REPLACE FUNCTION trade_runner_kick_stuck(p_max_age_sec INTEGER DEFAULT 180)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_killed INTEGER := 0;
    v_unlocked BOOLEAN := FALSE;
    r RECORD;
    v_max INTEGER := GREATEST(COALESCE(p_max_age_sec, 180), 30);
BEGIN
    -- Рвём зависшие бэкенды с торговым циклом / process_logic_* дольше v_max сек.
    FOR r IN
        SELECT a.pid
        FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.pid <> pg_backend_pid()
          AND a.state <> 'idle'
          AND a.query_start IS NOT NULL
          AND a.query_start < (clock_timestamp() - make_interval(secs => v_max))
          AND (
              a.query ILIKE '%process_logic_trades%'
              OR a.query ILIKE '%process_logic_stops%'
              OR a.query ILIKE '%run_trade_cycle%'
              OR a.query ILIKE '%logic_park_excess_cash%'
              OR a.query ILIKE '%logic_refresh_market_data%'
          )
    LOOP
        IF pg_terminate_backend(r.pid) THEN
            v_killed := v_killed + 1;
        END IF;
    END LOOP;

    BEGIN
        v_unlocked := pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));
    EXCEPTION
        WHEN OTHERS THEN
            v_unlocked := FALSE;
    END;

    PERFORM app_tech_log_event(
        'trade-runner',
        'watchdog.kick',
        format('kick_stuck killed=%s unlocked=%s max_age=%s', v_killed, v_unlocked, v_max),
        'postgresql',
        'event',
        NULL,
        NULL,
        NULL,
        jsonb_build_object('killed', v_killed, 'unlocked', v_unlocked, 'max_age_sec', v_max)
    );

    RETURN jsonb_build_object(
        'killed', v_killed,
        'unlocked', v_unlocked,
        'max_age_sec', v_max
    );
END;
$$;

COMMENT ON FUNCTION trade_runner_kick_stuck(INTEGER) IS
'Снять зависшие сессии process_logic_* / run_trade_cycle и попытаться снять advisory lock';

CREATE OR REPLACE FUNCTION trade_runner_health()
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_last TIMESTAMP;
    v_ttl INTEGER := trade_runner_stale_sec();
    v_enabled INTEGER := trade_runner_enabled_count();
    v_age NUMERIC;
    v_stale BOOLEAN;
    v_status TEXT;
    v_logics JSONB := '[]'::jsonb;
BEGIN
    v_last := trade_runner_last_ok_at();
    IF v_last IS NULL THEN
        v_age := NULL;
    ELSE
        v_age := EXTRACT(EPOCH FROM (LOCALTIMESTAMP - v_last));
    END IF;

    v_stale := trade_runner_is_stale();

    IF v_enabled <= 0 THEN
        v_status := 'idle';
    ELSIF trade_runner_require_ui() AND NOT trade_runner_ui_is_active() THEN
        v_status := 'ui_required';
    ELSIF v_stale THEN
        v_status := 'stale';
    ELSE
        v_status := 'ok';
    END IF;

    SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.id), '[]'::jsonb)
    INTO v_logics
    FROM (
        SELECT
            l.id,
            l.name,
            a.account_type,
            a.account_code,
            l.is_enabled,
            NULLIF(btrim(lp.param_value), '') AS last_trade_check_at,
            CASE
                WHEN NOT l.is_enabled OR NOT a.is_active THEN FALSE
                WHEN NULLIF(btrim(lp.param_value), '') IS NULL THEN TRUE
                WHEN (
                    CASE
                        WHEN NULLIF(btrim(lp.param_value), '') ~ '^\d{4}-\d{2}-\d{2}'
                        THEN NULLIF(btrim(lp.param_value), '')::TIMESTAMP
                        ELSE NULL
                    END
                ) IS NULL THEN TRUE
                ELSE (
                    CASE
                        WHEN NULLIF(btrim(lp.param_value), '') ~ '^\d{4}-\d{2}-\d{2}'
                        THEN NULLIF(btrim(lp.param_value), '')::TIMESTAMP
                        ELSE NULL
                    END
                ) < (LOCALTIMESTAMP - make_interval(secs => v_ttl))
            END AS stale
        FROM logics l
        JOIN accounts a ON a.id = l.account_id
        LEFT JOIN logic_params lp
          ON lp.logic_id = l.id
         AND lp.param_key = 'last_trade_check_at'
        WHERE l.is_enabled = TRUE
          AND a.is_active = TRUE
        ORDER BY l.id
    ) x;

    RETURN jsonb_build_object(
        'status', v_status,
        'ok', (v_status = 'ok' OR v_status = 'idle'),
        'stale', v_stale,
        'last_ok_at', CASE WHEN v_last IS NULL THEN NULL ELSE to_char(v_last, 'YYYY-MM-DD"T"HH24:MI:SS') END,
        'age_sec', v_age,
        'stale_sec', v_ttl,
        'enabled_count', v_enabled,
        'require_ui', trade_runner_require_ui(),
        'ui_active', trade_runner_ui_is_active(),
        'logics', v_logics,
        'at', to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS')
    );
END;
$$;

COMMENT ON FUNCTION trade_runner_health() IS
'Сводка для UI/API: жив ли цикл, stale-логики (real/fake), require_ui';

CREATE OR REPLACE FUNCTION trade_runner_watchdog_tick()
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_kick JSONB;
    v_cycle JSONB;
BEGIN
    IF NOT trade_runner_is_stale() THEN
        RETURN jsonb_build_object(
            'ok', TRUE,
            'action', 'none',
            'health', trade_runner_health()
        );
    END IF;

    v_kick := trade_runner_kick_stuck(180);
    v_cycle := run_trade_cycle();

    IF COALESCE((v_cycle->>'skipped')::boolean, FALSE) IS NOT TRUE THEN
        CALL touch_trade_runner_last_ok('postgresql-watchdog');
    ELSIF (v_cycle->>'reason') = 'ui_inactive' THEN
        -- UI обязателен и мёртв — last_ok не трогаем (остаётся stale/красный)
        NULL;
    ELSE
        -- locked / другой skip: цикл «жив» на стороне PG, отметим pulse
        CALL touch_trade_runner_last_ok('postgresql-watchdog-skip');
    END IF;

    PERFORM app_tech_log_event(
        'trade-runner',
        'watchdog.tick',
        format('stale→kick+cycle reason=%s', COALESCE(v_cycle->>'reason', 'ran')),
        'postgresql',
        'event',
        NULL,
        NULL,
        NULL,
        jsonb_build_object('kick', v_kick, 'cycle', v_cycle)
    );

    RETURN jsonb_build_object(
        'ok', TRUE,
        'action', 'raised',
        'kick', v_kick,
        'cycle', v_cycle,
        'health', trade_runner_health()
    );
END;
$$;

COMMENT ON FUNCTION trade_runner_watchdog_tick() IS
'Если цикл спит — kick stuck + run_trade_cycle; иначе no-op. Для pg_cron / Node.';
