-- ============================================
-- Глобальное техническое логирование (parameter_values + app_tech_log)
-- Вставляется в 02 после set_tbank_token
-- ============================================

CREATE OR REPLACE FUNCTION app_tech_logging_enabled()
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (
            SELECT lower(btrim(pv.value)) IN ('1', 'true', 'yes', 'on')
            FROM parameter_values pv
            JOIN parameter_types pt ON pt.id = pv.parameter_type_id
            JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
            WHERE ps.name = 'Default'
              AND pt.short_name = 'APP_TECH_LOGGING'
            LIMIT 1
        ),
        FALSE
    );
$$;

COMMENT ON FUNCTION app_tech_logging_enabled() IS
'TRUE, если в parameter_values (Default) включён APP_TECH_LOGGING';

CREATE OR REPLACE PROCEDURE set_app_tech_logging(p_enabled BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
BEGIN
    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'APP_TECH_LOGGING' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RAISE EXCEPTION 'APP_TECH_LOGGING not found in parameter_types';
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (v_set_id, v_type_id, CASE WHEN COALESCE(p_enabled, FALSE) THEN '1' ELSE '0' END)
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON PROCEDURE set_app_tech_logging(BOOLEAN) IS
'Вкл/выкл глобальное техническое логирование (галочка в шапке UI)';

CREATE OR REPLACE FUNCTION app_tech_log_event(
    p_thread_key TEXT,
    p_operation TEXT,
    p_message TEXT DEFAULT NULL,
    p_source TEXT DEFAULT 'system',
    p_phase TEXT DEFAULT 'event',
    p_logic_id INTEGER DEFAULT NULL,
    p_security_id INTEGER DEFAULT NULL,
    p_timeframe_id INTEGER DEFAULT NULL,
    p_payload JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT app_tech_logging_enabled() THEN
        RETURN;
    END IF;
    IF COALESCE(btrim(p_thread_key), '') = '' OR COALESCE(btrim(p_operation), '') = '' THEN
        RETURN;
    END IF;
    IF p_phase IS NOT NULL AND p_phase NOT IN ('start', 'end', 'event') THEN
        RETURN;
    END IF;

    INSERT INTO app_tech_log (
        trace_id, span_id, thread_key, source, operation, phase,
        message, logic_id, security_id, timeframe_id, payload
    ) VALUES (
        gen_random_uuid(),
        replace(gen_random_uuid()::TEXT, '-', ''),
        btrim(p_thread_key),
        COALESCE(NULLIF(btrim(p_source), ''), 'system'),
        btrim(p_operation),
        COALESCE(NULLIF(btrim(p_phase), ''), 'event'),
        p_message,
        p_logic_id,
        p_security_id,
        p_timeframe_id,
        p_payload
    );
END;
$$;

COMMENT ON FUNCTION app_tech_log_event(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, JSONB) IS
'Запись в app_tech_log, если APP_TECH_LOGGING включён';

CREATE OR REPLACE FUNCTION logic_trade_log(
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
    -- Шум на каждой бумаге/сигнале блокирует UI (раскрытие графика) при включённом tech log
    IF p_operation IN (
        'trade.signal_skip',
        'trade.signal_hit',
        'trade.not_ready',
        'trade.prices.loaded',
        'trade.indicator.synced',
        'trade.bar_skip'
    ) THEN
        RETURN;
    END IF;

    PERFORM app_tech_log_event(
        'logic:' || COALESCE(p_logic_id::TEXT, '0') || ':trade',
        p_operation,
        p_message,
        'postgresql',
        'event',
        p_logic_id,
        p_security_id,
        p_timeframe_id,
        p_payload
    );
END;
$$;

COMMENT ON FUNCTION logic_trade_log(INTEGER, TEXT, TEXT, JSONB, INTEGER, INTEGER) IS
'События trade runner по конкретной логике (без спама skip/loaded на каждый бар)';
