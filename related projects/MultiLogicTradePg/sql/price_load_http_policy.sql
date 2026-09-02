-- Политика источников: сначала T-Bank; при ошибке или 0 свечей — MOEX (+ M1 resample)

CREATE OR REPLACE FUNCTION price_load_use_moex_fallback()
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT TRUE;
$$;

COMMENT ON FUNCTION price_load_use_moex_fallback() IS
'MOEX разрешён как fallback после неудачи T-Bank (ошибка или 0 записей)';

CREATE OR REPLACE PROCEDURE load_prices_http(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tbank_ok BOOLEAN := FALSE;
    v_tbank_records INTEGER := 0;
    v_tbank_error TEXT;
    v_moex_records INTEGER := 0;
    v_is_future BOOLEAN := FALSE;
    v_group_prefix VARCHAR(50);
    v_note TEXT;
    v_tf_sec INTEGER;
BEGIN
    PERFORM set_config('lock_timeout', '15000', true);
    PERFORM set_config(
        'statement_timeout',
        LEAST(3600000, GREATEST(180000, (p_date_to - p_date_from + 1) * 3000))::TEXT,
        true
    );
    PERFORM configure_http_ssl();

    SELECT (st.name = 'Futures') INTO v_is_future
    FROM securities s
    JOIN security_types st ON s.security_type_id = st.id
    WHERE s.id = p_security_id;

    SELECT sp.prefix, sp.note INTO v_group_prefix, v_note
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    IF v_is_future AND is_perpetual_future_group(v_group_prefix, v_note) THEN
        BEGIN
            CALL load_prices_from_tbank_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
            SELECT records_loaded INTO v_tbank_records
            FROM price_load_log
            WHERE security_id = p_security_id
              AND timeframe_id = p_timeframe_id
              AND date_from = p_date_from
              AND date_to = p_date_to
              AND source = 'T-BANK'
            ORDER BY id DESC
            LIMIT 1;
            v_tbank_ok := COALESCE(v_tbank_records, 0) > 0;
        EXCEPTION
            WHEN OTHERS THEN
                v_tbank_error := SQLERRM;
                INSERT INTO price_load_log (
                    security_id, timeframe_id, date_from, date_to,
                    source, records_loaded, error_message
                )
                VALUES (
                    p_security_id, p_timeframe_id, p_date_from, p_date_to,
                    'T-BANK', 0, v_tbank_error
                );
        END;
        IF NOT v_tbank_ok THEN
            RAISE NOTICE 'T-Bank: нет данных (%), пробуем MOEX...', COALESCE(v_tbank_error, '0 свечей');
            BEGIN
                CALL load_prices_from_moex_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
            EXCEPTION
                WHEN OTHERS THEN
                    IF v_tbank_error IS NOT NULL THEN
                        RAISE EXCEPTION 'Оба источника недоступны. T-Bank: %; MOEX: %', v_tbank_error, SQLERRM;
                    ELSE
                        RAISE;
                    END IF;
            END;
        END IF;
        RETURN;
    END IF;

    -- Dated futures: rollover + T-Bank → MOEX (MOEX M15/M5… → M1 resample внутри load_prices_from_moex_http)
    IF v_is_future THEN
        CALL load_prices_futures_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
        RETURN;
    END IF;

    BEGIN
        CALL load_prices_from_tbank_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
        SELECT records_loaded INTO v_tbank_records
        FROM price_load_log
        WHERE security_id = p_security_id
          AND timeframe_id = p_timeframe_id
          AND date_from = p_date_from
          AND date_to = p_date_to
          AND source = 'T-BANK'
        ORDER BY id DESC
        LIMIT 1;
        v_tbank_ok := COALESCE(v_tbank_records, 0) > 0;
        IF v_tbank_ok THEN
            RAISE NOTICE 'Цены успешно загружены из T-Bank: % свечей', v_tbank_records;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            v_tbank_error := SQLERRM;
            INSERT INTO price_load_log (
                security_id, timeframe_id, date_from, date_to,
                source, records_loaded, error_message
            )
            VALUES (
                p_security_id, p_timeframe_id, p_date_from, p_date_to,
                'T-BANK', 0, v_tbank_error
            );
            RAISE NOTICE 'T-Bank недоступен: %', v_tbank_error;
    END;

    IF NOT v_tbank_ok THEN
        RAISE NOTICE 'T-Bank не дал данных, пробуем MOEX...';
        BEGIN
            CALL load_prices_from_moex_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
            SELECT records_loaded INTO v_moex_records
            FROM price_load_log
            WHERE security_id = p_security_id
              AND timeframe_id = p_timeframe_id
              AND date_from = p_date_from
              AND date_to = p_date_to
              AND source = 'MOEX'
            ORDER BY id DESC
            LIMIT 1;
            IF COALESCE(v_moex_records, 0) > 0 THEN
                RAISE NOTICE 'Цены успешно загружены из MOEX: % свечей', v_moex_records;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                IF v_tbank_error IS NOT NULL THEN
                    RAISE EXCEPTION 'Оба источника недоступны. T-Bank: %; MOEX: %', v_tbank_error, SQLERRM;
                ELSE
                    RAISE EXCEPTION 'MOEX: %', SQLERRM;
                END IF;
        END;

        -- Интрадей-TF: даже если T-Bank/MOEX что-то дали, но в `prices` мало баров
        -- целевого TF — докачиваем M10→M15 чанками по дням (MOEX не отдаёт 15/30 напрямую,
        -- а большой диапазон в один вызов не успевает в statement_timeout).
        SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;
        IF COALESCE(v_tf_sec, 0) > 60 AND COALESCE(v_tf_sec, 0) < 86400 THEN
            PERFORM load_prices_moex_resample_chunked(
                p_security_id, p_timeframe_id, p_date_from, p_date_to
            );
        END IF;
    END IF;
END;
$$;
