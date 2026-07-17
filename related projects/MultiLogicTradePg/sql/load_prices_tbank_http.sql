-- T-Bank GetCandles: лимит периода на один запрос зависит от TF (M15 = 1 день).
-- Процедура load_prices_from_tbank_http бьёт диапазон на чанки.

CREATE OR REPLACE FUNCTION get_tbank_max_request_days(p_tf VARCHAR)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_tf
        WHEN 'M1' THEN 1
        WHEN 'M2' THEN 1
        WHEN 'M3' THEN 1
        WHEN 'M5' THEN 1
        WHEN 'M10' THEN 1
        WHEN 'M15' THEN 1
        WHEN 'M20' THEN 1
        WHEN 'M30' THEN 2
        WHEN 'H1' THEN 7
        WHEN 'H2' THEN 30
        WHEN 'H4' THEN 30
        WHEN 'D1' THEN 365
        WHEN 'W1' THEN 730
        WHEN 'MN1' THEN 3650
        ELSE 1
    END;
$$;

COMMENT ON FUNCTION get_tbank_max_request_days(VARCHAR) IS
'Макс. длина периода (календарных дней) для одного GetCandles T-Bank по TF';

CREATE OR REPLACE PROCEDURE load_prices_from_tbank_http(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL,
    p_contract_figi VARCHAR DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix VARCHAR(50);
    v_tbank_figi VARCHAR(50);
    v_tf_name VARCHAR(20);
    v_is_future BOOLEAN;
    v_token TEXT;
    v_api_url TEXT;
    v_payload TEXT;
    v_headers http_header[];
    v_response http_response;
    v_status INTEGER;
    v_content JSONB;
    v_candles JSONB;
    v_candle JSONB;
    v_candle_time TIMESTAMP;
    v_candle_open NUMERIC(18,6);
    v_candle_high NUMERIC(18,6);
    v_candle_low NUMERIC(18,6);
    v_candle_close NUMERIC(18,6);
    v_candle_volume NUMERIC(20,2);
    v_records_loaded INTEGER := 0;
    v_i INTEGER;
    v_instrument_id VARCHAR(100);
    v_store_contract VARCHAR(50);
    v_moex_secid VARCHAR(20);
    v_note TEXT;
    v_max_days INTEGER;
    v_chunk_from DATE;
    v_chunk_to DATE;
BEGIN
    PERFORM configure_http_ssl();

    SELECT tf INTO v_tf_name FROM timeframes WHERE id = p_timeframe_id;
    v_max_days := GREATEST(1, get_tbank_max_request_days(v_tf_name));

    IF p_contract_prefix IS NOT NULL THEN
        v_prefix := p_contract_prefix;
        v_tbank_figi := p_contract_figi;
        v_is_future := TRUE;
        v_store_contract := p_contract_prefix;
        SELECT fe.moex_secid INTO v_moex_secid
        FROM futures_expirations fe
        WHERE fe.security_id = p_security_id
          AND fe.prefix = p_contract_prefix
        LIMIT 1;
    ELSE
        SELECT sp.prefix, sp.tbank_figi, sp.note
        INTO v_prefix, v_tbank_figi, v_note
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

        IF v_prefix IS NULL THEN
            RAISE EXCEPTION 'Префикс не найден для security_id=%', p_security_id;
        END IF;

        SELECT (st.name = 'Futures') INTO v_is_future
        FROM securities s
        JOIN security_types st ON s.security_type_id = st.id
        WHERE s.id = p_security_id;

        v_store_contract := NULL;

        IF v_is_future THEN
            IF is_perpetual_future_group(v_prefix, v_note) THEN
                v_store_contract := v_prefix;
            ELSE
                SELECT fe.prefix, fe.tbank_figi INTO v_prefix, v_tbank_figi
                FROM futures_expirations fe
                WHERE fe.security_id = p_security_id
                  AND fe.expiration_date > p_date_to
                  AND fe.is_active = TRUE
                ORDER BY fe.expiration_date ASC
                LIMIT 1;
                IF v_prefix IS NULL THEN
                    RAISE EXCEPTION 'Активный фьючерс не найден для security_id=% на дату %',
                        p_security_id, p_date_to;
                END IF;
                v_store_contract := v_prefix;
                SELECT fe.moex_secid INTO v_moex_secid
                FROM futures_expirations fe
                WHERE fe.security_id = p_security_id
                  AND fe.prefix = v_prefix
                LIMIT 1;
            END IF;
        END IF;
    END IF;

    v_token := get_tbank_token();
    IF v_token IS NULL THEN
        RAISE EXCEPTION 'T-Bank токен не найден. Задайте TBANK_API_TOKEN в параметрах или token_encrypted в accounts.';
    END IF;

    v_instrument_id := resolve_tbank_instrument_id(
        p_security_id, v_prefix, v_tbank_figi, v_is_future, 'TQBR', v_moex_secid
    );

    v_api_url := 'https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles';

    v_headers := ARRAY[
        http_header('Authorization', 'Bearer ' || v_token),
        http_header('Accept', 'application/json')
    ];

    v_chunk_from := p_date_from;
    WHILE v_chunk_from <= p_date_to LOOP
        v_chunk_to := LEAST(v_chunk_from + v_max_days - 1, p_date_to);

        v_payload := jsonb_build_object(
            'instrumentId', v_instrument_id,
            'from', tbank_iso_utc(v_chunk_from),
            'to', tbank_iso_utc(v_chunk_to + 1),
            'interval', get_tbank_candle_interval(v_tf_name)
        )::TEXT;

        SELECT * INTO v_response FROM http((
            'POST',
            v_api_url,
            v_headers,
            'application/json',
            v_payload
        )::http_request);

        v_status := v_response.status;

        IF v_status != 200 THEN
            IF v_status IN (401, 403) OR v_response.content ILIKE '%unauthenticated%' THEN
                RAISE EXCEPTION 'T-Bank API вернул статус %: %', v_status, v_response.content;
            END IF;
            RAISE NOTICE 'T-Bank chunk %..%: HTTP %', v_chunk_from, v_chunk_to, v_status;
        ELSE
            v_content := v_response.content::JSONB;
            v_candles := v_content->'candles';

            IF v_candles IS NOT NULL AND jsonb_array_length(v_candles) > 0 THEN
                FOR v_i IN 0 .. jsonb_array_length(v_candles) - 1
                LOOP
                    v_candle := v_candles->v_i;
                    v_candle_time := market_candle_dt_from_iso(v_candle->>'time');
                    v_candle_open := parse_tbank_quotation(v_candle->'open');
                    v_candle_high := parse_tbank_quotation(v_candle->'high');
                    v_candle_low := parse_tbank_quotation(v_candle->'low');
                    v_candle_close := parse_tbank_quotation(v_candle->'close');
                    v_candle_volume := COALESCE(
                        parse_tbank_quotation(v_candle->'volume'),
                        (v_candle->>'volume')::NUMERIC
                    );

                    CALL insert_candle(
                        p_security_id,
                        p_timeframe_id,
                        v_candle_time,
                        v_candle_open,
                        v_candle_high,
                        v_candle_low,
                        v_candle_close,
                        v_candle_volume,
                        NULL,
                        v_store_contract
                    );

                    v_records_loaded := v_records_loaded + 1;
                END LOOP;
            END IF;
        END IF;

        v_chunk_from := v_chunk_to + 1;
    END LOOP;

    IF v_records_loaded = 0 THEN
        INSERT INTO price_load_log (
            security_id, timeframe_id, date_from, date_to,
            source, records_loaded, contract_prefix, error_message
        )
        VALUES (
            p_security_id, p_timeframe_id, p_date_from, p_date_to,
            'T-BANK', 0, v_store_contract, 'T-Bank вернул 0 свечей за период'
        );
        RAISE NOTICE 'T-Bank: 0 свечей (% — %)', p_date_from, p_date_to;
        RETURN;
    END IF;

    INSERT INTO price_load_log (
        security_id, timeframe_id, date_from, date_to,
        source, records_loaded, contract_prefix
    )
    VALUES (
        p_security_id, p_timeframe_id, p_date_from, p_date_to,
        'T-BANK', v_records_loaded, v_store_contract
    );

    RAISE NOTICE 'Загружено % свечей из T-Bank (% — %, контракт %)',
        v_records_loaded, p_date_from, p_date_to, v_store_contract;

EXCEPTION
    WHEN OTHERS THEN
        IF v_records_loaded > 0 THEN
            INSERT INTO price_load_log (
                security_id, timeframe_id, date_from, date_to,
                source, records_loaded, contract_prefix, error_message
            )
            VALUES (
                p_security_id, p_timeframe_id, p_date_from, p_date_to,
                'T-BANK', v_records_loaded, v_store_contract,
                format('Частичная загрузка, затем ошибка: %s', SQLERRM)
            );
            RAISE NOTICE 'T-Bank: частично % свечей, ошибка: %', v_records_loaded, SQLERRM;
            RETURN;
        END IF;
        INSERT INTO price_load_log (
            security_id, timeframe_id, date_from, date_to,
            source, records_loaded, contract_prefix, error_message
        )
        VALUES (
            p_security_id, p_timeframe_id, p_date_from, p_date_to,
            'T-BANK', 0, v_store_contract, SQLERRM
        );
        RAISE;
END;
$$;

COMMENT ON PROCEDURE load_prices_from_tbank_http(INTEGER, INTEGER, DATE, DATE, VARCHAR, VARCHAR) IS
'Загрузка свечей T-Bank по чанкам (лимит периода API). p_contract_prefix — тикер контракта для фьючерсов.';
