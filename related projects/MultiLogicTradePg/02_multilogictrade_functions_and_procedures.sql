-- ============================================
-- MultiLogicTrade — шаг 2: функции и процедуры
-- Версия: v12 (идемпотентный запуск)
-- ============================================
-- Подключение: база multilogictrade
-- Предварительно выполните: 00 → 01
-- Можно выполнять многократно (CREATE OR REPLACE).
--
-- ================================================================
-- СТРУКТУРА ФАЙЛА
-- ================================================================
--
-- Часть A (этот файл, начало → строка «HTTP-ЗАГРУЗКА»):
--   parse_tbank_quotation, insert_candle, calculate_indicator,
--   load_prices_from_tbank/moex (заглушки без HTTP) и др.
--   Расширения НЕ требуются.
--
-- Часть B (блок «HTTP-ЗАГРУЗКА» в конце файла):
--   CREATE EXTENSION http;
--   load_prices_from_tbank_http, load_prices_from_moex_http,
--   load_prices_http, load_prices_batch_http, load_all_timeframes_http
--   Требует предварительной установки pgsql-http НА СЕРВЕРЕ PostgreSQL.
--
-- Если pgsql-http ещё не установлен:
--   • выполните только часть A (остановитесь перед CREATE EXTENSION http), ИЛИ
--   • установите расширение (ниже) и запустите весь файл целиком.
--
-- ================================================================
-- УСТАНОВКА pgsql-http — WINDOWS (PostgreSQL 15, один раз на машине)
-- ================================================================
--
-- 1. Скачать готовые бинарники для PG 15 x64:
--      https://www.postgresonline.com/downloads/pg15http_w64.zip
--
-- 2. Распаковать в каталог проекта:
--      _tmp_http_ext\pg15http_w64\
--    (должны появиться lib\http.dll, share\extension\http*, bin\*.dll)
--
-- 3. Скопировать файлы в установку PostgreSQL (нужны права администратора):
--      scripts\install_pgsql_http.ps1
--    Запуск: PowerShell → правой кнопкой → «Запуск от имени администратора»
--
--    Скрипт install_pgsql_http.ps1 выполняет:
--      Copy-Item ...\lib\http.dll          → C:\Program Files\PostgreSQL\15\lib\
--      Copy-Item ...\share\extension\http* → C:\Program Files\PostgreSQL\15\share\extension\
--      Copy-Item ...\bin\*.dll             → C:\Program Files\PostgreSQL\15\bin\
--      Copy-Item ...\ssl\certs\*           → C:\Program Files\PostgreSQL\15\ssl\certs\
--      Restart-Service postgresql-x64-15
--
-- 4. Проверка на диске:
--      Test-Path "C:\Program Files\PostgreSQL\15\lib\http.dll"
--      Test-Path "C:\Program Files\PostgreSQL\15\share\extension\http.control"
--
-- 5. Включить расширение в базе (выполняется ниже в блоке HTTP, или вручную):
--      CREATE EXTENSION IF NOT EXISTS http;
--
-- 6. Проверка в multilogictrade:
--      SELECT extname, extversion FROM pg_extension WHERE extname = 'http';
--      SELECT status FROM http_get('https://httpbin.org/get');
--    При ошибке SSL-сертификата:
--      SELECT http_set_curlopt('CURLOPT_CAINFO',
--        'C:/Program Files/PostgreSQL/15/ssl/certs/curl-ca-bundle.crt');
--
-- 7. Повторно выполнить этот файл (02), если часть B не создалась с первого раза:
--      .\scripts\run_multilogictrade.ps1 -Steps 2
--
-- Linux / macOS: см. комментарии перед блоком «HTTP-ЗАГРУЗКА» (сборка из git).
-- ================================================================
-- ============================================

-- ============================================
-- Вспомогательная функция: parse_tbank_quotation
-- Разбор цены T-Bank: {units, nano} или число
-- ============================================
CREATE OR REPLACE FUNCTION parse_tbank_quotation(p_value JSONB)
RETURNS NUMERIC(18,6) AS $$
DECLARE
    v_units BIGINT;
    v_nano INTEGER;
BEGIN
    IF p_value IS NULL OR p_value = 'null'::JSONB THEN
        RETURN NULL;
    END IF;

    IF jsonb_typeof(p_value) = 'number' THEN
        RETURN p_value::TEXT::NUMERIC(18,6);
    END IF;

    IF jsonb_typeof(p_value) = 'string' THEN
        RETURN (p_value #>> '{}')::NUMERIC(18,6);
    END IF;

    v_units := COALESCE((p_value->>'units')::BIGINT, 0);
    v_nano := COALESCE((p_value->>'nano')::INTEGER, 0);
    RETURN v_units + (v_nano / 1000000000.0);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION parse_tbank_quotation(JSONB) IS
'Преобразует Quotation T-Bank API (units+nano) или число в NUMERIC';

-- ============================================
-- Вспомогательная функция: get_moex_candle_interval
-- Код интервала для MOEX ISS API
-- ============================================
CREATE OR REPLACE FUNCTION get_moex_candle_interval(p_tf VARCHAR)
RETURNS INTEGER AS $$
BEGIN
    RETURN CASE p_tf
        WHEN 'M1' THEN 1
        WHEN 'M2' THEN 2
        WHEN 'M3' THEN 3
        WHEN 'M5' THEN 5
        WHEN 'M10' THEN 10
        WHEN 'M15' THEN 15
        WHEN 'M20' THEN 20
        WHEN 'M30' THEN 30
        WHEN 'M60' THEN 60
        WHEN 'H1' THEN 60
        WHEN 'H2' THEN 120
        WHEN 'H4' THEN 240
        WHEN 'D1' THEN 24
        WHEN 'W1' THEN 7
        WHEN 'MN1' THEN 31
        ELSE 1
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION get_moex_candle_interval(VARCHAR) IS
'Возвращает параметр interval для MOEX ISS candles API';

-- ============================================
-- Вспомогательная функция: get_tbank_candle_interval
-- Интервал свечи для T-Bank Invest API
-- ============================================
CREATE OR REPLACE FUNCTION get_tbank_candle_interval(p_tf VARCHAR)
RETURNS TEXT AS $$
BEGIN
    RETURN CASE p_tf
        WHEN 'M1' THEN 'CANDLE_INTERVAL_1_MIN'
        WHEN 'M2' THEN 'CANDLE_INTERVAL_2_MIN'
        WHEN 'M3' THEN 'CANDLE_INTERVAL_3_MIN'
        WHEN 'M5' THEN 'CANDLE_INTERVAL_5_MIN'
        WHEN 'M10' THEN 'CANDLE_INTERVAL_10_MIN'
        WHEN 'M15' THEN 'CANDLE_INTERVAL_15_MIN'
        WHEN 'M30' THEN 'CANDLE_INTERVAL_30_MIN'
        WHEN 'H1' THEN 'CANDLE_INTERVAL_HOUR'
        WHEN 'H2' THEN 'CANDLE_INTERVAL_2_HOUR'
        WHEN 'H4' THEN 'CANDLE_INTERVAL_4_HOUR'
        WHEN 'D1' THEN 'CANDLE_INTERVAL_DAY'
        WHEN 'W1' THEN 'CANDLE_INTERVAL_WEEK'
        WHEN 'MN1' THEN 'CANDLE_INTERVAL_MONTH'
        ELSE 'CANDLE_INTERVAL_DAY'
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION get_tbank_candle_interval(VARCHAR) IS
'Возвращает CANDLE_INTERVAL_* для T-Bank GetCandles API';

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

-- ISO-8601 UTC для T-Bank GetCandles (обязателен символ T, иначе HTTP 400)
CREATE OR REPLACE FUNCTION tbank_iso_utc(p_date DATE, p_time TIME DEFAULT TIME '00:00:00')
RETURNS TEXT
LANGUAGE sql
IMMUTABLE AS $$
    SELECT to_char(p_date::timestamp + p_time, 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
$$;

COMMENT ON FUNCTION tbank_iso_utc(DATE, TIME) IS
'Дата/время в формате 2026-07-05T00:00:00Z для T-Bank Invest API';

-- ISO-8601 UTC из T-Bank/MOEX → локальная wall-clock (prices.dt, logic_last_closed_bar_dt)
CREATE OR REPLACE FUNCTION market_candle_dt_from_iso(p_iso TEXT)
RETURNS TIMESTAMP
LANGUAGE sql
STABLE AS $$
    SELECT timezone(current_setting('TimeZone'), p_iso::timestamptz)::timestamp;
$$;

COMMENT ON FUNCTION market_candle_dt_from_iso(TEXT) IS
'UTC ISO из API (…Z) → TIMESTAMP в session TimeZone (Europe/Moscow)';

-- Вечные фьючерсы MOEX (CNYRUBF, USDRUBF …) — без rollover по контрактам
CREATE OR REPLACE FUNCTION is_perpetual_future_group(
    p_group_prefix VARCHAR,
    p_note TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT btrim(p_group_prefix) IN ('CNYRUBF', 'USDRUBF', 'GLDRUBF', 'IMOEXF')
        OR coalesce(p_note, '') ILIKE '%вечн%';
$$;

-- Функция: get_active_future_prefix
-- Определяет активный фьючерс на заданную дату
-- ============================================
CREATE OR REPLACE FUNCTION get_active_future_prefix(
    p_security_id INTEGER,
    p_date DATE
)
RETURNS VARCHAR(50) AS $$
DECLARE
    v_group_prefix VARCHAR(50);
    v_note TEXT;
    v_prefix VARCHAR(50);
BEGIN
    SELECT sp.prefix, sp.note INTO v_group_prefix, v_note
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    IF is_perpetual_future_group(v_group_prefix, v_note) THEN
        RETURN v_group_prefix;
    END IF;

    SELECT fe.prefix INTO v_prefix
    FROM futures_expirations fe
    WHERE fe.security_id = p_security_id
      AND fe.expiration_date > p_date
      AND fe.is_active = TRUE
    ORDER BY fe.expiration_date ASC
    LIMIT 1;

    RETURN v_prefix;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_active_future_prefix(INTEGER, DATE) IS 
'Тикер активного фьючерса на дату; для вечных (CNYRUBF …) — групповой префикс из security_prefixes';

-- Контракт фьючерса на дату + дата начала торгов (день после экспирации предыдущего)
CREATE OR REPLACE FUNCTION get_future_contract_for_date(
    p_security_id INTEGER,
    p_date DATE
)
RETURNS TABLE (
    prefix VARCHAR(50),
    moex_secid VARCHAR(20),
    expiration_date DATE,
    tbank_figi VARCHAR(50),
    start_date DATE
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        fe.prefix,
        fe.moex_secid,
        fe.expiration_date,
        fe.tbank_figi,
        COALESCE(
            (
                SELECT fe2.expiration_date + 1
                FROM futures_expirations fe2
                WHERE fe2.security_id = fe.security_id
                  AND fe2.expiration_date < fe.expiration_date
                  AND fe2.is_active = TRUE
                ORDER BY fe2.expiration_date DESC
                LIMIT 1
            ),
            DATE '2000-01-01'
        ) AS start_date
    FROM futures_expirations fe
    WHERE fe.security_id = p_security_id
      AND fe.expiration_date > p_date
      AND fe.is_active = TRUE
    ORDER BY fe.expiration_date ASC
    LIMIT 1;
END;
$$;

COMMENT ON FUNCTION get_future_contract_for_date(INTEGER, DATE) IS
'Контракт фьючерса на дату (ближайшая экспирация после даты) и start_date для загрузки истории';

-- ============================================
-- Функция: get_tbank_token
-- Получает зашифрованный токен T-Bank из счета
-- ============================================
CREATE OR REPLACE FUNCTION get_tbank_token(
    p_account_code VARCHAR(100) DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
    v_token TEXT;
BEGIN
    SELECT btrim(pv.value) INTO v_token
    FROM parameter_values pv
    JOIN parameter_types pt ON pt.id = pv.parameter_type_id
    JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
    WHERE ps.name = 'Default'
      AND pt.short_name = 'TBANK_API_TOKEN'
      AND btrim(COALESCE(pv.value, '')) <> ''
    LIMIT 1;
    IF v_token IS NOT NULL THEN
        RETURN v_token;
    END IF;

    IF p_account_code IS NOT NULL AND btrim(p_account_code) <> '' THEN
        SELECT btrim(a.token_encrypted) INTO v_token
        FROM accounts a
        JOIN brokers b ON a.broker_id = b.id
        WHERE b.code = 'T-BANK'
          AND a.account_code = p_account_code
          AND a.is_active = TRUE
          AND a.token_encrypted IS NOT NULL
          AND btrim(a.token_encrypted) <> '';
        IF v_token IS NOT NULL THEN
            RETURN v_token;
        END IF;
    END IF;

    SELECT btrim(a.token_encrypted) INTO v_token
    FROM accounts a
    JOIN brokers b ON a.broker_id = b.id
    WHERE b.code = 'T-BANK'
      AND a.is_active = TRUE
      AND a.token_encrypted IS NOT NULL
      AND btrim(a.token_encrypted) <> ''
    ORDER BY a.is_efficient DESC, a.id
    LIMIT 1;

    RETURN NULLIF(v_token, '');
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_tbank_token(VARCHAR) IS 
'Токен T-Bank: сначала parameter_values TBANK_API_TOKEN (Default), иначе token_encrypted в accounts';

CREATE OR REPLACE FUNCTION tbank_token_is_configured()
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT get_tbank_token() IS NOT NULL;
$$;

COMMENT ON FUNCTION tbank_token_is_configured IS
'TRUE, если задан глобальный TBANK_API_TOKEN или токен в accounts';

CREATE OR REPLACE FUNCTION tbank_verify_token()
RETURNS JSONB
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'has_token', tbank_token_is_configured(),
        'valid', tbank_token_is_configured(),
        'error_message', CASE
            WHEN tbank_token_is_configured() THEN NULL
            ELSE 'Токен T-Bank не задан'
        END
    );
$$;

COMMENT ON FUNCTION tbank_verify_token() IS
'Заглушка без pgsql-http: только наличие токена; HTTP-блок переопределяет реальной проверкой';

CREATE OR REPLACE PROCEDURE set_tbank_token(p_token TEXT)
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
BEGIN
    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'TBANK_API_TOKEN' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RAISE EXCEPTION 'TBANK_API_TOKEN not found in parameter_types';
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (v_set_id, v_type_id, COALESCE(btrim(p_token), ''))
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON PROCEDURE set_tbank_token IS
'Сохраняет глобальный T-Bank API токен в parameter_values (набор Default)';

-- ============================================
-- Процедура: insert_candle
-- Вставляет/обновляет одну свечу (UPSERT)
-- ============================================
DROP PROCEDURE IF EXISTS insert_candle(INTEGER, INTEGER, TIMESTAMP, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, INTEGER, VARCHAR);
DROP PROCEDURE IF EXISTS insert_candle(INTEGER, INTEGER, TIMESTAMP, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, INTEGER);

CREATE OR REPLACE PROCEDURE insert_candle(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_open NUMERIC(18,6),
    p_high NUMERIC(18,6),
    p_low NUMERIC(18,6),
    p_close NUMERIC(18,6),
    p_volume NUMERIC(20,2) DEFAULT NULL,
    p_value NUMERIC(20,2) DEFAULT NULL,
    p_contract_prefix VARCHAR DEFAULT NULL
)
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO prices (
        security_id, timeframe_id, dt,
        open_price, high_price, low_price, close_price,
        volume, value, contract_prefix
    )
    VALUES (
        p_security_id, p_timeframe_id, p_dt,
        p_open, p_high, p_low, p_close,
        p_volume, p_value, p_contract_prefix
    )
    ON CONFLICT (security_id, timeframe_id, dt)
    DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        volume = EXCLUDED.volume,
        value = EXCLUDED.value,
        contract_prefix = COALESCE(EXCLUDED.contract_prefix, prices.contract_prefix);
END;
$$;

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

-- @include sql/app_cleanup_settings.sql
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

CREATE OR REPLACE PROCEDURE set_app_cleanup_last_at(p_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)
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

COMMENT ON PROCEDURE set_app_cleanup_last_at(TIMESTAMP) IS
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

CREATE OR REPLACE FUNCTION trade_runner_ui_heartbeat_ttl_sec()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE AS $$
    SELECT 90;
$$;

COMMENT ON FUNCTION trade_runner_ui_heartbeat_ttl_sec() IS
'Сколько секунд heartbeat Angular считается активным';

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

COMMENT ON FUNCTION trade_runner_ui_is_active() IS
'TRUE, если Angular недавно слал heartbeat (APP_TRADE_RUNNER_HB)';

CREATE OR REPLACE PROCEDURE touch_trade_runner_ui_heartbeat()
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
BEGIN
    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'APP_TRADE_RUNNER_HB' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RAISE EXCEPTION 'APP_TRADE_RUNNER_HB not found in parameter_types';
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (v_set_id, v_type_id, to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS'))
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON PROCEDURE touch_trade_runner_ui_heartbeat() IS
'Обновляет heartbeat UI (Angular открыт)';

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
    DO UPDATE SET value = '';
END;
$$;

COMMENT ON PROCEDURE clear_trade_runner_ui_heartbeat() IS
'Сбрасывает heartbeat UI (Angular закрыт)';

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
'События trade runner по конкретной логике (без спама skip/hit/loaded на каждый бар)';


COMMENT ON PROCEDURE insert_candle(INTEGER, INTEGER, TIMESTAMP, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, VARCHAR) IS 
'Вставляет/обновляет одну свечу. contract_prefix — тикер контракта (Si-6.26) для фьючерсов';

-- ============================================
-- Процедура: load_prices_from_tbank
-- Загружает цены через API T-Bank (TData)
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_from_tbank(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix VARCHAR(50);
    v_tf_sec INTEGER;
    v_tf_name VARCHAR(20);
    v_is_future BOOLEAN;
    v_token TEXT;
    v_start_ts TIMESTAMP;
    v_end_ts TIMESTAMP;
    v_records_loaded INTEGER := 0;
BEGIN
    -- Получаем префикс
    SELECT sp.prefix INTO v_prefix
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    IF v_prefix IS NULL THEN
        RAISE EXCEPTION 'Префикс не найден для security_id=%', p_security_id;
    END IF;

    SELECT sec, tf INTO v_tf_sec, v_tf_name
    FROM timeframes WHERE id = p_timeframe_id;

    -- Проверяем, это фьючерс или нет
    SELECT (st.name = 'Futures') INTO v_is_future
    FROM securities s
    JOIN security_types st ON s.security_type_id = st.id
    WHERE s.id = p_security_id;

    -- Для фьючерса определяем активный контракт
    IF v_is_future THEN
        v_prefix := get_active_future_prefix(p_security_id, p_date_from);
        IF v_prefix IS NULL THEN
            RAISE EXCEPTION 'Активный фьючерс не найден для security_id=% на дату %', p_security_id, p_date_from;
        END IF;
    END IF;

    -- Получаем токен
    v_token := get_tbank_token();
    IF v_token IS NULL THEN
        RAISE EXCEPTION 'T-Bank токен не найден. Задайте TBANK_API_TOKEN в параметрах или token_encrypted в accounts.';
    END IF;

    v_start_ts := p_date_from::TIMESTAMP;
    v_end_ts := (p_date_to + INTERVAL '1 day')::TIMESTAMP;

    RAISE NOTICE 'T-Bank API запрос: figi=%, interval=%, from=%, to=%', 
        v_prefix, v_tf_name, v_start_ts, v_end_ts;

    -- Логируем попытку
    INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded)
    VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'T-BANK', 0);

EXCEPTION
    WHEN OTHERS THEN
        INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded, error_message)
        VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'T-BANK', 0, SQLERRM);
        RAISE;
END;
$$;

COMMENT ON PROCEDURE load_prices_from_tbank(INTEGER, INTEGER, DATE, DATE) IS 
'Загружает цены через API T-Bank. Для фьючерсов автоматически выбирает активный контракт.';

-- ============================================
-- Процедура: load_prices_from_moex
-- Загружает цены через API MOEX (ISS)
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_from_moex(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix VARCHAR(50);
    v_tf_name VARCHAR(20);
    v_is_future BOOLEAN;
    v_engine VARCHAR(20) := 'stock';
    v_market VARCHAR(20) := 'shares';
    v_board VARCHAR(20) := 'TQBR';
    v_start_dt TIMESTAMP;
    v_end_dt TIMESTAMP;
    v_url TEXT;
    v_records_loaded INTEGER := 0;
BEGIN
    SELECT sp.prefix INTO v_prefix
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    IF v_prefix IS NULL THEN
        RAISE EXCEPTION 'Префикс не найден для security_id=%', p_security_id;
    END IF;

    SELECT tf INTO v_tf_name
    FROM timeframes WHERE id = p_timeframe_id;

    -- Определяем рынок
    SELECT 
        CASE st.name
            WHEN 'Stock' THEN 'stock'
            WHEN 'Futures' THEN 'futures'
            WHEN 'Bond' THEN 'bonds'
            WHEN 'Index' THEN 'stock'
            ELSE 'stock'
        END,
        CASE st.name
            WHEN 'Stock' THEN 'shares'
            WHEN 'Futures' THEN 'forts'
            WHEN 'Bond' THEN 'bonds'
            WHEN 'Index' THEN 'index'
            ELSE 'shares'
        END,
        CASE st.name
            WHEN 'Stock' THEN 'TQBR'
            WHEN 'Futures' THEN 'RFUD'
            ELSE 'TQBR'
        END
    INTO v_engine, v_market, v_board
    FROM securities s
    JOIN security_types st ON s.security_type_id = st.id
    WHERE s.id = p_security_id;

    -- Для фьючерсов определяем активный контракт
    IF v_engine = 'futures' THEN
        v_prefix := get_active_future_prefix(p_security_id, p_date_from);
        IF v_prefix IS NULL THEN
            RAISE EXCEPTION 'Активный фьючерс не найден для security_id=% на дату %', p_security_id, p_date_from;
        END IF;
    END IF;

    v_start_dt := p_date_from::TIMESTAMP;
    v_end_dt := (p_date_to + INTERVAL '1 day')::TIMESTAMP;

    -- Формируем URL MOEX ISS API
    v_url := format(
        'https://iss.moex.com/iss/engines/%s/markets/%s/boards/%s/securities/%s/candles.json?from=%s&till=%s&interval=%s',
        v_engine, v_market, v_board, v_prefix,
        to_char(v_start_dt, 'YYYY-MM-DD'),
        to_char(v_end_dt, 'YYYY-MM-DD'),
        get_moex_candle_interval(v_tf_name)::TEXT
    );

    RAISE NOTICE 'MOEX API URL: %', v_url;

    -- Логируем попытку
    INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded)
    VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'MOEX', 0);

EXCEPTION
    WHEN OTHERS THEN
        INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded, error_message)
        VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'MOEX', 0, SQLERRM);
        RAISE;
END;
$$;

COMMENT ON PROCEDURE load_prices_from_moex(INTEGER, INTEGER, DATE, DATE) IS 
'Загружает цены через открытое API MOEX ISS. Для фьючерсов выбирает активный контракт.';

-- ============================================
-- ГЛАВНАЯ ПРОЦЕДУРА: load_prices
-- Сначала T-Bank, если не сработало -- MOEX
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tbank_ok BOOLEAN := FALSE;
    v_error_msg TEXT;
BEGIN
    -- Попытка 1: T-Bank
    BEGIN
        CALL load_prices_from_tbank(p_security_id, p_timeframe_id, p_date_from, p_date_to);
        v_tbank_ok := TRUE;
        RAISE NOTICE 'Цены успешно загружены из T-Bank';
    EXCEPTION
        WHEN OTHERS THEN
            v_error_msg := SQLERRM;
            RAISE NOTICE 'T-Bank недоступен: %. Переключаемся на MOEX...', v_error_msg;
    END;

    -- Попытка 2: MOEX (если T-Bank не сработал)
    IF NOT v_tbank_ok THEN
        BEGIN
            CALL load_prices_from_moex(p_security_id, p_timeframe_id, p_date_from, p_date_to);
            RAISE NOTICE 'Цены успешно загружены из MOEX';
        EXCEPTION
            WHEN OTHERS THEN
                v_error_msg := SQLERRM;
                RAISE EXCEPTION 'Оба источника недоступны. T-Bank: %; MOEX: %', v_error_msg, SQLERRM;
        END;
    END IF;
END;
$$;

COMMENT ON PROCEDURE load_prices(INTEGER, INTEGER, DATE, DATE) IS 
'Главная процедура загрузки цен: сначала T-Bank, если не отвечает -- MOEX. Для фьючерсов автоматически выбирает активный контракт на дату периода.';

-- ============================================
-- Процедура: load_prices_batch
-- Загрузка цен для нескольких бумаг сразу
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_batch(
    p_security_ids INTEGER[],
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_security_id INTEGER;
BEGIN
    FOREACH v_security_id IN ARRAY p_security_ids
    LOOP
        BEGIN
            CALL load_prices(v_security_id, p_timeframe_id, p_date_from, p_date_to);
            RAISE NOTICE 'Загружены цены для security_id=%', v_security_id;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Ошибка загрузки для security_id=%: %', v_security_id, SQLERRM;
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_prices_batch(INTEGER[], INTEGER, DATE, DATE) IS 
'Загружает цены для массива бумаг по одному таймфрейму и периоду.';

-- ============================================
-- Процедура: load_all_timeframes
-- Загрузка всех таймфреймов для одной бумаги
-- ============================================
CREATE OR REPLACE PROCEDURE load_all_timeframes(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tf RECORD;
BEGIN
    FOR v_tf IN SELECT id FROM timeframes WHERE COALESCE(is_active, TRUE) = TRUE ORDER BY sec
    LOOP
        BEGIN
            CALL load_prices(p_security_id, v_tf.id, p_date_from, p_date_to);
            RAISE NOTICE 'Загружен таймфрейм id=% для security_id=%', v_tf.id, p_security_id;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Ошибка загрузки таймфрейма id=%: %', v_tf.id, SQLERRM;
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_all_timeframes(INTEGER, DATE, DATE) IS 
'Загружает все таймфреймы для одной бумаги за указанный период.';

-- ============================================
-- Процедура: cleanup_old_prices
-- Очистка старых цен (архивирование)
-- ============================================
CREATE OR REPLACE PROCEDURE cleanup_old_prices(
    p_days_to_keep INTEGER DEFAULT 365
)
LANGUAGE plpgsql AS $$
DECLARE
    v_cutoff_date TIMESTAMP;
    v_deleted_count INTEGER;
BEGIN
    v_cutoff_date := CURRENT_TIMESTAMP - (p_days_to_keep || ' days')::INTERVAL;

    DELETE FROM prices
    WHERE dt < v_cutoff_date;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RAISE NOTICE 'Удалено % старых свечей (старше % дней)', v_deleted_count, p_days_to_keep;
END;
$$;

COMMENT ON PROCEDURE cleanup_old_prices(INTEGER) IS 
'Удаляет цены старше указанного количества дней (по умолчанию 365).';

-- @include sql/cleanup_trading_disk_space.sql
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

    DELETE FROM logic_trades
    WHERE is_test;
    GET DIAGNOSTICS v_test_trades_deleted = ROW_COUNT;

    DELETE FROM logic_signal_rating_history
    WHERE is_test;
    GET DIAGNOSTICS v_rating_test_deleted = ROW_COUNT;

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

-- ============================================
-- Индикаторы: подстановка плейсхолдеров и функции calc_ind_*
-- (вставляется в 02_multilogictrade_functions_and_procedures.sql)
-- ============================================

CREATE OR REPLACE FUNCTION get_ind_series_threshold(
    p_indicator_id INTEGER,
    p_series VARCHAR
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
    SELECT threshold_value
    FROM indicator_value_types
    WHERE indicator_id = p_indicator_id
      AND code = p_series
      AND is_threshold = TRUE;
$$;

COMMENT ON FUNCTION get_ind_series_threshold(INTEGER, VARCHAR) IS
'Пороговое значение серии индикатора (OVERBOUGHT, ZERO и т.д.).';

-- Подстановка плейсхолдеров в indicators.script перед EXECUTE.
-- Длинные имена (:fast_period) заменяются раньше коротких (:period).
CREATE OR REPLACE FUNCTION substitute_indicator_script(
    p_template TEXT,
    p_period INTEGER DEFAULT NULL,
    p_fast_period INTEGER DEFAULT NULL,
    p_slow_period INTEGER DEFAULT NULL,
    p_signal_period INTEGER DEFAULT NULL,
    p_std_dev NUMERIC DEFAULT NULL,
    p_k_period INTEGER DEFAULT NULL,
    p_d_period INTEGER DEFAULT NULL,
    p_smooth INTEGER DEFAULT NULL,
    p_series VARCHAR DEFAULT NULL,
    p_security_id INTEGER DEFAULT NULL,
    p_timeframe_id INTEGER DEFAULT NULL,
    p_dt TIMESTAMP DEFAULT NULL,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_sql TEXT := p_template;
BEGIN
    IF v_sql IS NULL OR TRIM(v_sql) = '' THEN
        RETURN NULL;
    END IF;

    v_sql := REPLACE(v_sql, ':fast_period', COALESCE(p_fast_period::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':slow_period', COALESCE(p_slow_period::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':signal_period', COALESCE(p_signal_period::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':k_period', COALESCE(p_k_period::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':d_period', COALESCE(p_d_period::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':std_dev', COALESCE(p_std_dev::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':smooth', COALESCE(p_smooth::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':security_id', COALESCE(p_security_id::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':timeframe_id', COALESCE(p_timeframe_id::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':indicator_id', COALESCE(p_indicator_id::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':period', COALESCE(p_period::TEXT, 'NULL'));
    v_sql := REPLACE(v_sql, ':series', quote_literal(COALESCE(p_series, '')));
    v_sql := REPLACE(v_sql, ':dt', quote_literal(p_dt));

    RETURN v_sql;
END;
$$;

COMMENT ON FUNCTION substitute_indicator_script(TEXT, INTEGER, INTEGER, INTEGER, INTEGER, NUMERIC, INTEGER, INTEGER, INTEGER, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Подставляет значения параметров и :series в шаблон indicators.script для EXECUTE.';

CREATE OR REPLACE FUNCTION exec_indicator_script(
    p_template TEXT,
    p_period INTEGER DEFAULT NULL,
    p_fast_period INTEGER DEFAULT NULL,
    p_slow_period INTEGER DEFAULT NULL,
    p_signal_period INTEGER DEFAULT NULL,
    p_std_dev NUMERIC DEFAULT NULL,
    p_k_period INTEGER DEFAULT NULL,
    p_d_period INTEGER DEFAULT NULL,
    p_smooth INTEGER DEFAULT NULL,
    p_series VARCHAR DEFAULT NULL,
    p_security_id INTEGER DEFAULT NULL,
    p_timeframe_id INTEGER DEFAULT NULL,
    p_dt TIMESTAMP DEFAULT NULL,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
    v_sql TEXT;
    v_result NUMERIC;
BEGIN
    v_sql := substitute_indicator_script(
        p_template, p_period, p_fast_period, p_slow_period, p_signal_period,
        p_std_dev, p_k_period, p_d_period, p_smooth, p_series,
        p_security_id, p_timeframe_id, p_dt, p_indicator_id
    );
    IF v_sql IS NULL THEN
        RETURN NULL;
    END IF;
    EXECUTE v_sql INTO v_result;
    RETURN v_result;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'exec_indicator_script [%]: %', p_series, SQLERRM;
        RETURN NULL;
END;
$$;

COMMENT ON FUNCTION exec_indicator_script(TEXT, INTEGER, INTEGER, INTEGER, INTEGER, NUMERIC, INTEGER, INTEGER, INTEGER, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Выполняет indicators.script (аналог EXECUTE IMMEDIATE) и возвращает NUMERIC.';

-- RSI
CREATE OR REPLACE FUNCTION calc_ind_rsi(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_closes NUMERIC[];
    v_idx INTEGER;
    v_gain NUMERIC := 0;
    v_loss NUMERIC := 0;
    v_avg_gain NUMERIC;
    v_avg_loss NUMERIC;
    v_rs NUMERIC;
    v_thr NUMERIC;
    j INTEGER;
BEGIN
    IF p_series IS NOT NULL AND p_series <> 'RSI' AND p_indicator_id IS NOT NULL THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN
            RETURN v_thr;
        END IF;
        RETURN NULL;
    END IF;

    SELECT array_agg(close_price ORDER BY dt), COUNT(*)
    INTO v_closes, v_idx
    FROM prices
    WHERE security_id = p_security_id
      AND timeframe_id = p_timeframe_id
      AND dt <= p_dt;

    IF v_idx IS NULL OR v_idx < p_period + 1 THEN
        RETURN NULL;
    END IF;

    FOR j IN v_idx - p_period + 1 .. v_idx LOOP
        IF v_closes[j] > v_closes[j - 1] THEN
            v_gain := v_gain + (v_closes[j] - v_closes[j - 1]);
        ELSE
            v_loss := v_loss + (v_closes[j - 1] - v_closes[j]);
        END IF;
    END LOOP;

    v_avg_gain := v_gain / p_period;
    v_avg_loss := v_loss / p_period;
    IF v_avg_loss = 0 THEN
        RETURN 100;
    END IF;
    v_rs := v_avg_gain / v_avg_loss;
    RETURN 100 - (100 / (1 + v_rs));
END;
$$;

-- SMA
CREATE OR REPLACE FUNCTION calc_ind_sma(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_thr NUMERIC;
BEGIN
    IF p_series IS NOT NULL AND p_series <> 'VALUE' AND p_indicator_id IS NOT NULL THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN RETURN v_thr; END IF;
        RETURN NULL;
    END IF;

    RETURN (
        SELECT AVG(close_price)
        FROM (
            SELECT close_price
            FROM prices
            WHERE security_id = p_security_id
              AND timeframe_id = p_timeframe_id
              AND dt <= p_dt
            ORDER BY dt DESC
            LIMIT p_period
        ) s
    );
END;
$$;

-- EMA (значение на свече p_dt)
CREATE OR REPLACE FUNCTION calc_ind_ema(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_thr NUMERIC;
    v_ema NUMERIC;
    v_mult NUMERIC;
    r RECORD;
BEGIN
    IF p_series IS NOT NULL AND p_series <> 'VALUE' AND p_indicator_id IS NOT NULL THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN RETURN v_thr; END IF;
        RETURN NULL;
    END IF;

    v_mult := 2.0 / (p_period + 1);
    v_ema := NULL;
    FOR r IN
        SELECT close_price
        FROM prices
        WHERE security_id = p_security_id
          AND timeframe_id = p_timeframe_id
          AND dt <= p_dt
        ORDER BY dt
    LOOP
        IF v_ema IS NULL THEN
            v_ema := r.close_price;
        ELSE
            v_ema := (r.close_price - v_ema) * v_mult + v_ema;
        END IF;
    END LOOP;
    RETURN v_ema;
END;
$$;

-- MACD
CREATE OR REPLACE FUNCTION calc_ind_macd(
    p_fast_period INTEGER,
    p_slow_period INTEGER,
    p_signal_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_closes NUMERIC[];
    v_idx INTEGER;
    v_mult_fast NUMERIC;
    v_mult_slow NUMERIC;
    v_mult_signal NUMERIC;
    v_ema_fast NUMERIC;
    v_ema_slow NUMERIC;
    v_macd NUMERIC;
    v_macd_signal NUMERIC;
    v_macd_line NUMERIC[];
    i INTEGER;
    v_thr NUMERIC;
BEGIN
    IF p_indicator_id IS NOT NULL AND p_series IN ('ZERO', 'OVERBOUGHT', 'OVERSOLD') THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN RETURN v_thr; END IF;
    END IF;

    SELECT array_agg(close_price ORDER BY dt), COUNT(*)
    INTO v_closes, v_idx
    FROM prices
    WHERE security_id = p_security_id
      AND timeframe_id = p_timeframe_id
      AND dt <= p_dt;

    IF v_idx IS NULL OR v_idx < p_slow_period THEN
        RETURN NULL;
    END IF;

    v_mult_fast := 2.0 / (p_fast_period + 1);
    v_mult_slow := 2.0 / (p_slow_period + 1);
    v_mult_signal := 2.0 / (p_signal_period + 1);
    v_ema_fast := v_closes[1];
    v_ema_slow := v_closes[1];
    v_macd_line := ARRAY[]::NUMERIC[];

    FOR i IN 2 .. v_idx LOOP
        v_ema_fast := (v_closes[i] - v_ema_fast) * v_mult_fast + v_ema_fast;
        v_ema_slow := (v_closes[i] - v_ema_slow) * v_mult_slow + v_ema_slow;
        v_macd := v_ema_fast - v_ema_slow;
        v_macd_line := array_append(v_macd_line, v_macd);
    END LOOP;

    IF array_length(v_macd_line, 1) IS NULL THEN
        RETURN NULL;
    END IF;

    v_macd_signal := v_macd_line[1];
    FOR i IN 2 .. array_length(v_macd_line, 1) LOOP
        v_macd_signal := (v_macd_line[i] - v_macd_signal) * v_mult_signal + v_macd_signal;
    END LOOP;

    v_macd := v_macd_line[array_length(v_macd_line, 1)];

    RETURN CASE p_series
        WHEN 'MACD' THEN v_macd
        WHEN 'SIGNAL' THEN v_macd_signal
        WHEN 'HISTOGRAM' THEN v_macd - v_macd_signal
        WHEN 'ZERO' THEN 0
        ELSE NULL
    END;
END;
$$;

-- Bollinger Bands
CREATE OR REPLACE FUNCTION calc_ind_bb(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_middle NUMERIC;
    v_std NUMERIC;
    v_thr NUMERIC;
BEGIN
    IF p_indicator_id IS NOT NULL AND p_series NOT IN ('UPPER', 'MIDDLE', 'LOWER', 'BANDWIDTH') THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN RETURN v_thr; END IF;
        RETURN NULL;
    END IF;

    SELECT AVG(close_price), STDDEV_SAMP(close_price)
    INTO v_middle, v_std
    FROM (
        SELECT close_price
        FROM prices
        WHERE security_id = p_security_id
          AND timeframe_id = p_timeframe_id
          AND dt <= p_dt
        ORDER BY dt DESC
        LIMIT p_period
    ) s;

    IF v_middle IS NULL THEN
        RETURN NULL;
    END IF;
    v_std := COALESCE(v_std, 0);

    RETURN CASE p_series
        WHEN 'MIDDLE' THEN v_middle
        WHEN 'UPPER' THEN v_middle + p_std_dev * v_std
        WHEN 'LOWER' THEN v_middle - p_std_dev * v_std
        WHEN 'BANDWIDTH' THEN
            CASE WHEN v_middle = 0 THEN NULL
                 ELSE (2 * p_std_dev * v_std) / v_middle * 100
            END
        ELSE NULL
    END;
END;
$$;

-- ATR
CREATE OR REPLACE FUNCTION calc_ind_atr(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_idx INTEGER;
    v_atr NUMERIC;
    v_tr NUMERIC;
    v_tr_high NUMERIC;
    v_tr_low NUMERIC;
    v_tr_close NUMERIC;
    i INTEGER;
    v_thr NUMERIC;
BEGIN
    IF p_series = 'ATR_PCT' THEN
        v_atr := calc_ind_atr(p_period, 'ATR', p_security_id, p_timeframe_id, p_dt, p_indicator_id);
        SELECT close_price INTO v_tr_close
        FROM prices
        WHERE security_id = p_security_id AND timeframe_id = p_timeframe_id AND dt = p_dt;
        IF v_atr IS NULL OR v_tr_close IS NULL OR v_tr_close = 0 THEN
            RETURN NULL;
        END IF;
        RETURN v_atr / v_tr_close * 100;
    END IF;

    IF p_series IS NOT NULL AND p_series <> 'ATR' AND p_indicator_id IS NOT NULL THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN RETURN v_thr; END IF;
        RETURN NULL;
    END IF;

    SELECT
        array_agg(sub.high_price ORDER BY sub.dt),
        array_agg(sub.low_price ORDER BY sub.dt),
        array_agg(sub.close_price ORDER BY sub.dt),
        COUNT(*)
    INTO v_highs, v_lows, v_closes, v_idx
    FROM (
        SELECT high_price, low_price, close_price, dt
        FROM prices
        WHERE security_id = p_security_id
          AND timeframe_id = p_timeframe_id
          AND dt <= p_dt
        ORDER BY dt DESC
        LIMIT LEAST(5000, GREATEST(p_period * 30, 200))
    ) sub;

    IF v_idx IS NULL OR v_idx < p_period + 1 THEN
        RETURN NULL;
    END IF;

    v_atr := 0;
    FOR i IN 2 .. v_idx LOOP
        v_tr_high := v_highs[i] - v_lows[i];
        v_tr_low := ABS(v_highs[i] - v_closes[i - 1]);
        v_tr_close := ABS(v_lows[i] - v_closes[i - 1]);
        v_tr := GREATEST(v_tr_high, v_tr_low, v_tr_close);
        IF i <= p_period THEN
            v_atr := v_atr + v_tr;
            IF i = p_period THEN
                v_atr := v_atr / p_period;
            END IF;
        ELSE
            v_atr := (v_atr * (p_period - 1) + v_tr) / p_period;
        END IF;
    END LOOP;

    RETURN v_atr;
END;
$$;

-- Stochastic
CREATE OR REPLACE FUNCTION calc_ind_stoch(
    p_k_period INTEGER,
    p_d_period INTEGER,
    p_smooth INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_idx INTEGER;
    v_k_values NUMERIC[] := ARRAY[]::NUMERIC[];
    v_stoch_k NUMERIC;
    v_stoch_d NUMERIC;
    i INTEGER;
    j INTEGER;
    v_lowest NUMERIC;
    v_highest NUMERIC;
    v_sum NUMERIC;
    v_thr NUMERIC;
BEGIN
    IF p_indicator_id IS NOT NULL AND p_series IN ('OVERBOUGHT', 'OVERSOLD') THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN RETURN v_thr; END IF;
    END IF;

    SELECT
        array_agg(high_price ORDER BY dt),
        array_agg(low_price ORDER BY dt),
        array_agg(close_price ORDER BY dt),
        COUNT(*)
    INTO v_highs, v_lows, v_closes, v_idx
    FROM prices
    WHERE security_id = p_security_id
      AND timeframe_id = p_timeframe_id
      AND dt <= p_dt;

    IF v_idx IS NULL OR v_idx < p_k_period THEN
        RETURN NULL;
    END IF;

    FOR i IN p_k_period .. v_idx LOOP
        v_lowest := v_lows[i];
        v_highest := v_highs[i];
        FOR j IN i - p_k_period + 1 .. i LOOP
            IF v_lows[j] < v_lowest THEN v_lowest := v_lows[j]; END IF;
            IF v_highs[j] > v_highest THEN v_highest := v_highs[j]; END IF;
        END LOOP;
        IF v_highest = v_lowest THEN
            v_stoch_k := 50;
        ELSE
            v_stoch_k := (v_closes[i] - v_lowest) / (v_highest - v_lowest) * 100;
        END IF;
        v_k_values := array_append(v_k_values, v_stoch_k);
    END LOOP;

    IF array_length(v_k_values, 1) IS NULL THEN
        RETURN NULL;
    END IF;

    v_stoch_k := v_k_values[array_length(v_k_values, 1)];

    IF p_series = 'K' THEN
        RETURN v_stoch_k;
    END IF;

    IF p_series = 'D' THEN
        v_sum := 0;
        FOR i IN GREATEST(1, array_length(v_k_values, 1) - p_d_period + 1) .. array_length(v_k_values, 1) LOOP
            v_sum := v_sum + v_k_values[i];
        END LOOP;
        RETURN v_sum / LEAST(p_d_period, array_length(v_k_values, 1));
    END IF;

    RETURN NULL;
END;
$$;

-- ============================================
-- Массивные функции индикаторов (один проход по ценам)
-- Сигнатура: (параметры индикатора…, series, security_id, timeframe_id, point_count, end_dt)
-- Возвращает TABLE(dt, value) — последние point_count точек до end_dt
-- ============================================

CREATE OR REPLACE FUNCTION ind_resolve_end_dt(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_end_dt TIMESTAMP
)
RETURNS TIMESTAMP
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        p_end_dt,
        (SELECT MAX(dt) FROM prices
         WHERE security_id = p_security_id AND timeframe_id = p_timeframe_id)
    );
$$;

CREATE OR REPLACE FUNCTION ind_warmup_bars(p_period INTEGER, p_point_count INTEGER)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(COALESCE(p_period, 14) * 4, COALESCE(p_point_count, 100) + COALESCE(p_period, 14) + 20);
$$;

-- RSI array
CREATE OR REPLACE FUNCTION calc_ind_rsi_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_gain NUMERIC;
    v_loss NUMERIC;
    v_avg_gain NUMERIC;
    v_avg_loss NUMERIC;
    v_rs NUMERIC;
    v_rsi NUMERIC;
    i INTEGER;
    j INTEGER;
    v_start INTEGER;
BEGIN
    IF p_series IS NOT NULL AND p_series <> 'RSI' THEN
        RETURN;
    END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt <= v_end
        ORDER BY p.dt DESC
        LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < p_period + 1 THEN RETURN; END IF;

    v_start := GREATEST(p_period + 1, v_n - p_point_count + 1);
    FOR i IN v_start .. v_n LOOP
        v_gain := 0;
        v_loss := 0;
        FOR j IN i - p_period + 1 .. i LOOP
            IF v_closes[j] > v_closes[j - 1] THEN
                v_gain := v_gain + (v_closes[j] - v_closes[j - 1]);
            ELSE
                v_loss := v_loss + (v_closes[j - 1] - v_closes[j]);
            END IF;
        END LOOP;
        v_avg_gain := v_gain / p_period;
        v_avg_loss := v_loss / p_period;
        IF v_avg_loss = 0 THEN
            v_rsi := 100;
        ELSE
            v_rs := v_avg_gain / v_avg_loss;
            v_rsi := 100 - (100 / (1 + v_rs));
        END IF;
        dt := v_dts[i];
        value := v_rsi;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- SMA array
CREATE OR REPLACE FUNCTION calc_ind_sma_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_sum NUMERIC;
    i INTEGER;
    v_start INTEGER;
BEGIN
    IF p_series IS NOT NULL AND p_series <> 'VALUE' THEN RETURN; END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < p_period THEN RETURN; END IF;

    v_start := GREATEST(p_period, v_n - p_point_count + 1);
    FOR i IN v_start .. v_n LOOP
        v_sum := 0;
        FOR j IN i - p_period + 1 .. i LOOP
            v_sum := v_sum + v_closes[j];
        END LOOP;
        dt := v_dts[i];
        value := v_sum / p_period;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- EMA array
CREATE OR REPLACE FUNCTION calc_ind_ema_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_mult NUMERIC;
    v_ema NUMERIC;
    i INTEGER;
    v_start INTEGER;
BEGIN
    IF p_series IS NOT NULL AND p_series <> 'VALUE' THEN RETURN; END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_period, p_point_count);
    v_mult := 2.0 / (p_period + 1);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < 1 THEN RETURN; END IF;

    v_ema := v_closes[1];
    v_start := GREATEST(2, v_n - p_point_count + 1);
    FOR i IN 2 .. v_n LOOP
        v_ema := (v_closes[i] - v_ema) * v_mult + v_ema;
        IF i >= GREATEST(p_period, v_start) THEN
            dt := v_dts[i];
            value := v_ema;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

-- MACD array (один проход → MACD / SIGNAL / HISTOGRAM)
CREATE OR REPLACE FUNCTION calc_ind_macd_array(
    p_fast_period INTEGER,
    p_slow_period INTEGER,
    p_signal_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_mult_fast NUMERIC;
    v_mult_slow NUMERIC;
    v_mult_signal NUMERIC;
    v_ema_fast NUMERIC;
    v_ema_slow NUMERIC;
    v_macd NUMERIC;
    v_macd_signal NUMERIC;
    v_macd_line NUMERIC[];
    v_signal_line NUMERIC[];
    i INTEGER;
    v_start INTEGER;
BEGIN
    IF p_series NOT IN ('MACD', 'SIGNAL', 'HISTOGRAM') THEN RETURN; END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_slow_period + p_signal_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < p_slow_period THEN RETURN; END IF;

    v_mult_fast := 2.0 / (p_fast_period + 1);
    v_mult_slow := 2.0 / (p_slow_period + 1);
    v_mult_signal := 2.0 / (p_signal_period + 1);
    v_ema_fast := v_closes[1];
    v_ema_slow := v_closes[1];
    v_macd_line := ARRAY[]::NUMERIC[];
    v_signal_line := ARRAY[]::NUMERIC[];

    FOR i IN 2 .. v_n LOOP
        v_ema_fast := (v_closes[i] - v_ema_fast) * v_mult_fast + v_ema_fast;
        v_ema_slow := (v_closes[i] - v_ema_slow) * v_mult_slow + v_ema_slow;
        v_macd := v_ema_fast - v_ema_slow;
        v_macd_line := array_append(v_macd_line, v_macd);
        IF array_length(v_macd_line, 1) = 1 THEN
            v_macd_signal := v_macd;
        ELSE
            v_macd_signal := (v_macd - v_macd_signal) * v_mult_signal + v_macd_signal;
        END IF;
        v_signal_line := array_append(v_signal_line, v_macd_signal);
    END LOOP;

    v_start := GREATEST(1, array_length(v_macd_line, 1) - p_point_count + 1);
    FOR i IN v_start .. array_length(v_macd_line, 1) LOOP
        dt := v_dts[i + 1];
        v_macd := v_macd_line[i];
        v_macd_signal := v_signal_line[i];
        value := CASE p_series
            WHEN 'MACD' THEN v_macd
            WHEN 'SIGNAL' THEN v_macd_signal
            WHEN 'HISTOGRAM' THEN v_macd - v_macd_signal
        END;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- BB array
CREATE OR REPLACE FUNCTION calc_ind_bb_array(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_middle NUMERIC;
    v_std NUMERIC;
    v_sum NUMERIC;
    v_sum_sq NUMERIC;
    i INTEGER;
    j INTEGER;
    v_start INTEGER;
BEGIN
    IF p_series NOT IN ('UPPER', 'MIDDLE', 'LOWER', 'BANDWIDTH') THEN RETURN; END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < p_period THEN RETURN; END IF;

    v_start := GREATEST(p_period, v_n - p_point_count + 1);
    FOR i IN v_start .. v_n LOOP
        v_sum := 0;
        v_sum_sq := 0;
        FOR j IN i - p_period + 1 .. i LOOP
            v_sum := v_sum + v_closes[j];
            v_sum_sq := v_sum_sq + v_closes[j] * v_closes[j];
        END LOOP;
        v_middle := v_sum / p_period;
        v_std := sqrt(GREATEST(v_sum_sq / p_period - v_middle * v_middle, 0));
        dt := v_dts[i];
        value := CASE p_series
            WHEN 'MIDDLE' THEN v_middle
            WHEN 'UPPER' THEN v_middle + p_std_dev * v_std
            WHEN 'LOWER' THEN v_middle - p_std_dev * v_std
            WHEN 'BANDWIDTH' THEN CASE WHEN v_middle = 0 THEN NULL ELSE (2 * p_std_dev * v_std) / v_middle * 100 END
        END;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- ATR array
CREATE OR REPLACE FUNCTION calc_ind_atr_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_atr NUMERIC;
    v_tr NUMERIC;
    v_tr_high NUMERIC;
    v_tr_low NUMERIC;
    v_tr_close NUMERIC;
    i INTEGER;
    v_start INTEGER;
BEGIN
    IF p_series NOT IN ('ATR', 'ATR_PCT') THEN RETURN; END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.high_price ORDER BY x.dt),
           array_agg(x.low_price ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_highs, v_lows, v_closes, v_n
    FROM (
        SELECT p.dt, p.high_price, p.low_price, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < p_period + 1 THEN RETURN; END IF;

    v_atr := 0;
    v_start := GREATEST(p_period, v_n - p_point_count + 1);
    FOR i IN 2 .. v_n LOOP
        v_tr_high := v_highs[i] - v_lows[i];
        v_tr_low := ABS(v_highs[i] - v_closes[i - 1]);
        v_tr_close := ABS(v_lows[i] - v_closes[i - 1]);
        v_tr := GREATEST(v_tr_high, v_tr_low, v_tr_close);
        IF i <= p_period THEN
            v_atr := v_atr + v_tr;
            IF i = p_period THEN v_atr := v_atr / p_period; END IF;
        ELSE
            v_atr := (v_atr * (p_period - 1) + v_tr) / p_period;
        END IF;
        IF i >= v_start AND i >= p_period THEN
            dt := v_dts[i];
            value := CASE p_series
                WHEN 'ATR' THEN v_atr
                WHEN 'ATR_PCT' THEN CASE WHEN v_closes[i] = 0 THEN NULL ELSE v_atr / v_closes[i] * 100 END
            END;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

-- Stochastic array
CREATE OR REPLACE FUNCTION calc_ind_stoch_array(
    p_k_period INTEGER,
    p_d_period INTEGER,
    p_smooth INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_k_values NUMERIC[];
    v_stoch_k NUMERIC;
    v_stoch_d NUMERIC;
    i INTEGER;
    j INTEGER;
    v_lowest NUMERIC;
    v_highest NUMERIC;
    v_sum NUMERIC;
    v_start INTEGER;
BEGIN
    IF p_series NOT IN ('K', 'D') THEN RETURN; END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_k_period + p_d_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.high_price ORDER BY x.dt),
           array_agg(x.low_price ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_highs, v_lows, v_closes, v_n
    FROM (
        SELECT p.dt, p.high_price, p.low_price, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < p_k_period THEN RETURN; END IF;

    v_k_values := ARRAY[]::NUMERIC[];
    FOR i IN p_k_period .. v_n LOOP
        v_lowest := v_lows[i];
        v_highest := v_highs[i];
        FOR j IN i - p_k_period + 1 .. i LOOP
            IF v_lows[j] < v_lowest THEN v_lowest := v_lows[j]; END IF;
            IF v_highs[j] > v_highest THEN v_highest := v_highs[j]; END IF;
        END LOOP;
        IF v_highest = v_lowest THEN v_stoch_k := 50;
        ELSE v_stoch_k := (v_closes[i] - v_lowest) / (v_highest - v_lowest) * 100;
        END IF;
        v_k_values := array_append(v_k_values, v_stoch_k);
    END LOOP;

    v_start := GREATEST(1, array_length(v_k_values, 1) - p_point_count + 1);
    FOR i IN v_start .. array_length(v_k_values, 1) LOOP
        dt := v_dts[p_k_period + i - 1];
        IF p_series = 'K' THEN
            value := v_k_values[i];
            RETURN NEXT;
        ELSE
            v_sum := 0;
            FOR j IN GREATEST(1, i - p_d_period + 1) .. i LOOP
                v_sum := v_sum + v_k_values[j];
            END LOOP;
            value := v_sum / LEAST(p_d_period, i);
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

-- ============================================
-- Многочленные индикаторы: парсинг и вычисление
-- Синтаксис по MultiLogic PolynomialIndicators:
--   pp oo hh ll vv — OHLCV; (a; b; c) — ядро; * — свёртка; # /# — покомпонентно; @CODE — индикатор
-- ============================================

CREATE OR REPLACE FUNCTION poly_is_formula(p_formula TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(btrim(p_formula), '') <> ''
       AND btrim(p_formula) !~* '^calc_';
$$;

CREATE OR REPLACE FUNCTION poly_len(p_arr NUMERIC[])
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(array_length(p_arr, 1), 0);
$$;

CREATE OR REPLACE FUNCTION poly_extend(p_arr NUMERIC[], p_len INTEGER)
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_n INTEGER := poly_len(p_arr);
    v_out NUMERIC[];
    i INTEGER;
BEGIN
    IF p_len <= 0 THEN RETURN ARRAY[]::NUMERIC[]; END IF;
    IF v_n = 0 THEN RETURN array_fill(0::NUMERIC, ARRAY[p_len]); END IF;
    IF v_n = 1 THEN RETURN array_fill(p_arr[1], ARRAY[p_len]); END IF;
    IF v_n >= p_len THEN RETURN p_arr[1:p_len]; END IF;
    v_out := p_arr;
    FOR i IN v_n + 1 .. p_len LOOP
        v_out := array_append(v_out, 0::NUMERIC);
    END LOOP;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION poly_align2(
    p_a NUMERIC[],
    p_b NUMERIC[]
)
RETURNS TABLE (a NUMERIC[], b NUMERIC[])
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_len INTEGER;
BEGIN
    v_len := GREATEST(poly_len(p_a), poly_len(p_b));
    a := poly_extend(p_a, v_len);
    b := poly_extend(p_b, v_len);
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION poly_add(p_a NUMERIC[], p_b NUMERIC[])
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_row RECORD;
    v_i INTEGER;
    v_out NUMERIC[];
BEGIN
    SELECT * INTO v_row FROM poly_align2(p_a, p_b);
    v_out := ARRAY[]::NUMERIC[];
    FOR v_i IN 1 .. poly_len(v_row.a) LOOP
        v_out := array_append(v_out, COALESCE(v_row.a[v_i], 0) + COALESCE(v_row.b[v_i], 0));
    END LOOP;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION poly_sub(p_a NUMERIC[], p_b NUMERIC[])
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_row RECORD;
    v_i INTEGER;
    v_out NUMERIC[];
BEGIN
    SELECT * INTO v_row FROM poly_align2(p_a, p_b);
    v_out := ARRAY[]::NUMERIC[];
    FOR v_i IN 1 .. poly_len(v_row.a) LOOP
        v_out := array_append(v_out, COALESCE(v_row.a[v_i], 0) - COALESCE(v_row.b[v_i], 0));
    END LOOP;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION poly_neg(p_a NUMERIC[])
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_i INTEGER;
    v_out NUMERIC[] := ARRAY[]::NUMERIC[];
BEGIN
    FOR v_i IN 1 .. poly_len(p_a) LOOP
        v_out := array_append(v_out, -p_a[v_i]);
    END LOOP;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION poly_comp_mul(p_a NUMERIC[], p_b NUMERIC[])
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_row RECORD;
    v_i INTEGER;
    v_out NUMERIC[];
BEGIN
    SELECT * INTO v_row FROM poly_align2(p_a, p_b);
    v_out := ARRAY[]::NUMERIC[];
    FOR v_i IN 1 .. poly_len(v_row.a) LOOP
        v_out := array_append(v_out, COALESCE(v_row.a[v_i], 0) * COALESCE(v_row.b[v_i], 0));
    END LOOP;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION poly_comp_div(p_a NUMERIC[], p_b NUMERIC[])
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_row RECORD;
    v_i INTEGER;
    v_out NUMERIC[];
    v_den NUMERIC;
BEGIN
    SELECT * INTO v_row FROM poly_align2(p_a, p_b);
    v_out := ARRAY[]::NUMERIC[];
    FOR v_i IN 1 .. poly_len(v_row.a) LOOP
        v_den := COALESCE(v_row.b[v_i], 0);
        IF v_den = 0 THEN
            v_out := array_append(v_out, NULL);
        ELSE
            v_out := array_append(v_out, COALESCE(v_row.a[v_i], 0) / v_den);
        END IF;
    END LOOP;
    RETURN v_out;
END;
$$;

DROP FUNCTION IF EXISTS poly_convolve(NUMERIC[], NUMERIC[]);

CREATE OR REPLACE FUNCTION poly_convolve(
    p_a NUMERIC[],
    p_b NUMERIC[],
    p_max_lag INTEGER DEFAULT NULL
)
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_na INTEGER := poly_len(p_a);
    v_nb INTEGER := poly_len(p_b);
    v_out NUMERIC[];
    v_normalize BOOLEAN;
    v_lag_cap INTEGER;
    i INTEGER;
    j INTEGER;
    v_sum NUMERIC;
    v_weight NUMERIC;
BEGIN
    IF v_na = 0 OR v_nb = 0 THEN RETURN ARRAY[]::NUMERIC[]; END IF;
    -- Два ряда одинаковой длины (sma*sma…): взвешенная свёртка, шкала ~ цена.
    -- p_max_lag ограничивает глубину (period): значение не зависит от длины всего массива.
    -- Короткое ядро (ww, PACC): без деления — как раньше.
    v_normalize := (v_na = v_nb AND v_na > 8);
    v_lag_cap := CASE
        WHEN v_normalize AND p_max_lag IS NOT NULL AND p_max_lag > 0 THEN p_max_lag
        ELSE v_nb
    END;
    v_out := array_fill(0::NUMERIC, ARRAY[v_na]);
    FOR i IN 1 .. v_na LOOP
        v_sum := 0;
        v_weight := 0;
        FOR j IN 1 .. LEAST(v_nb, v_lag_cap) LOOP
            IF i - j + 1 >= 1 AND i - j + 1 <= v_na THEN
                v_sum := v_sum + p_a[i - j + 1] * p_b[j];
                IF v_normalize THEN
                    v_weight := v_weight + p_b[j];
                END IF;
            END IF;
        END LOOP;
        IF v_normalize AND ABS(v_weight) > 1e-12 THEN
            v_out[i] := v_sum / v_weight;
        ELSE
            v_out[i] := v_sum;
        END IF;
    END LOOP;
    RETURN v_out;
END;
$$;

COMMENT ON FUNCTION poly_convolve(NUMERIC[], NUMERIC[], INTEGER) IS
'Свёртка рядов; при равной длине >8 — нормализация; p_max_lag=period для локальной sma*sma';

CREATE OR REPLACE FUNCTION poly_delta_kernel(p_k INTEGER)
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_out NUMERIC[];
    i INTEGER;
BEGIN
    IF p_k < 0 THEN
        RAISE EXCEPTION 'poly_delta_kernel: k must be >= 0, got %', p_k;
    END IF;
    v_out := array_fill(0::NUMERIC, ARRAY[p_k + 1]);
    v_out[p_k + 1] := 1;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION poly_ctx_period(p_ctx JSONB)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(COALESCE(NULLIF(p_ctx ->> 'param_period', '')::INTEGER, 20), 2);
$$;

CREATE OR REPLACE FUNCTION poly_formula_conv_depth(p_formula TEXT)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(
        (length(btrim(COALESCE(p_formula, ''))) - length(replace(btrim(COALESCE(p_formula, '')), '*', ''))),
        0
    );
$$;

CREATE OR REPLACE FUNCTION poly_formula_warmup_bars(
    p_formula TEXT,
    p_period INTEGER,
    p_point_count INTEGER
)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(
        COALESCE(p_point_count, 100)
            + GREATEST(COALESCE(p_period, 14), 2)
              * (poly_formula_conv_depth(p_formula) + 1)
              * 4,
        ind_warmup_bars(p_period, p_point_count)
    );
$$;

CREATE OR REPLACE FUNCTION poly_pp_from_ctx(p_ctx JSONB)
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF p_ctx ? 'm_pp' THEN
        RETURN ARRAY(SELECT jsonb_array_elements_text(p_ctx -> 'm_pp')::NUMERIC);
    END IF;
    RAISE EXCEPTION 'poly_eval: pp not loaded in context';
END;
$$;

CREATE OR REPLACE FUNCTION poly_build_sma_kernel(p_period INTEGER)
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_n INTEGER := GREATEST(COALESCE(p_period, 20), 1);
    v_out NUMERIC[] := ARRAY[]::NUMERIC[];
    i INTEGER;
BEGIN
    FOR i IN 1 .. v_n LOOP
        v_out := array_append(v_out, 1.0 / v_n);
    END LOOP;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION poly_build_ema_kernel(p_period INTEGER)
RETURNS NUMERIC[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_n INTEGER := GREATEST(COALESCE(p_period, 20), 2);
    v_alpha NUMERIC := 2.0 / (v_n + 1);
    v_len INTEGER := GREATEST(v_n * 4, 24);
    v_out NUMERIC[] := ARRAY[]::NUMERIC[];
    i INTEGER;
BEGIN
    FOR i IN 0 .. v_len - 1 LOOP
        v_out := array_append(v_out, v_alpha * power(1 - v_alpha, i));
    END LOOP;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION poly_tokenize(p_formula TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_src TEXT := COALESCE(p_formula, '');
    v_len INTEGER := length(v_src);
    v_i INTEGER := 1;
    v_c TEXT;
    v_tokens TEXT[] := ARRAY[]::TEXT[];
    v_buf TEXT;
    v_num TEXT;
    v_peek TEXT;
    v_j INTEGER;
BEGIN
    WHILE v_i <= v_len LOOP
        v_c := substr(v_src, v_i, 1);
        IF v_c ~ '\s' THEN
            v_i := v_i + 1;
            CONTINUE;
        END IF;

        IF v_c = '(' THEN
            v_j := v_i + 1;
            WHILE v_j <= v_len AND substr(v_src, v_j, 1) ~ '\s' LOOP v_j := v_j + 1; END LOOP;
            IF v_j <= v_len AND substr(v_src, v_j, 1) ~ '[0-9.\-+]' THEN
                v_buf := '';
                v_j := v_i + 1;
                WHILE v_j <= v_len LOOP
                    v_peek := substr(v_src, v_j, 1);
                    IF v_peek ~ '[0-9.\-+eE,; ]' THEN
                        IF v_peek !~ '\s' THEN v_buf := v_buf || v_peek; END IF;
                        v_j := v_j + 1;
                    ELSE
                        EXIT;
                    END IF;
                END LOOP;
                IF v_j <= v_len AND substr(v_src, v_j, 1) = ')'
                   AND (position(';' IN v_buf) > 0 OR position(',' IN v_buf) > 0) THEN
                    v_buf := replace(replace(v_buf, ';', ','), ' ', '');
                    v_tokens := array_append(v_tokens, 'VEC:' || v_buf);
                    v_i := v_j + 1;
                    CONTINUE;
                END IF;
            END IF;
            v_tokens := array_append(v_tokens, 'LP');
            v_i := v_i + 1;
            CONTINUE;
        END IF;

        IF v_c = ')' THEN
            v_tokens := array_append(v_tokens, 'RP');
            v_i := v_i + 1;
            CONTINUE;
        END IF;

        IF v_c = '@' THEN
            v_buf := '';
            v_i := v_i + 1;
            WHILE v_i <= v_len LOOP
                v_peek := substr(v_src, v_i, 1);
                EXIT WHEN v_peek !~ '[A-Za-z0-9_]';
                v_buf := v_buf || v_peek;
                v_i := v_i + 1;
            END LOOP;
            IF v_buf = '' THEN
                RAISE EXCEPTION 'poly_tokenize: empty indicator reference at position %', v_i;
            END IF;
            IF v_i <= v_len AND substr(v_src, v_i, 1) = ':' THEN
                v_i := v_i + 1;
                v_num := '';
                WHILE v_i <= v_len LOOP
                    v_peek := substr(v_src, v_i, 1);
                    EXIT WHEN v_peek !~ '[A-Za-z0-9_]';
                    v_num := v_num || v_peek;
                    v_i := v_i + 1;
                END LOOP;
                v_tokens := array_append(v_tokens, 'IND:' || upper(v_buf) || ':' || upper(v_num));
            ELSE
                v_tokens := array_append(v_tokens, 'IND:' || upper(v_buf));
            END IF;
            CONTINUE;
        END IF;

        IF v_c ~ '[A-Za-z]' THEN
            v_buf := v_c;
            v_i := v_i + 1;
            WHILE v_i <= v_len LOOP
                v_peek := substr(v_src, v_i, 1);
                EXIT WHEN v_peek !~ '[A-Za-z0-9_]';
                v_buf := v_buf || v_peek;
                v_i := v_i + 1;
            END LOOP;
            IF lower(v_buf) IN ('dd', 'delta') THEN
                WHILE v_i <= v_len AND substr(v_src, v_i, 1) ~ '\s' LOOP v_i := v_i + 1; END LOOP;
                IF v_i > v_len OR substr(v_src, v_i, 1) <> '(' THEN
                    RAISE EXCEPTION 'poly_tokenize: expected ( after %', v_buf;
                END IF;
                v_i := v_i + 1;
                v_num := '';
                WHILE v_i <= v_len LOOP
                    v_peek := substr(v_src, v_i, 1);
                    IF v_peek ~ '[0-9]' THEN
                        v_num := v_num || v_peek;
                        v_i := v_i + 1;
                    ELSIF v_peek ~ '\s' THEN
                        v_i := v_i + 1;
                    ELSE
                        EXIT;
                    END IF;
                END LOOP;
                IF v_i > v_len OR substr(v_src, v_i, 1) <> ')' OR v_num = '' THEN
                    RAISE EXCEPTION 'poly_tokenize: invalid dd(k) at position %', v_i;
                END IF;
                v_tokens := array_append(v_tokens, 'DD:' || v_num);
                v_i := v_i + 1;
                CONTINUE;
            END IF;
            v_tokens := array_append(v_tokens, 'ID:' || lower(v_buf));
            CONTINUE;
        END IF;

        IF v_c ~ '[0-9.]' OR (v_c = '-' AND v_i < v_len AND substr(v_src, v_i + 1, 1) ~ '[0-9.]') THEN
            v_num := v_c;
            v_i := v_i + 1;
            WHILE v_i <= v_len AND substr(v_src, v_i, 1) ~ '[0-9.eE+-]' LOOP
                v_num := v_num || substr(v_src, v_i, 1);
                v_i := v_i + 1;
            END LOOP;
            v_tokens := array_append(v_tokens, 'NUM:' || v_num);
            CONTINUE;
        END IF;

        IF v_c = '/' AND v_i < v_len AND substr(v_src, v_i + 1, 1) = '#' THEN
            v_tokens := array_append(v_tokens, 'OP:/#');
            v_i := v_i + 2;
            CONTINUE;
        END IF;

        IF v_c = '=' THEN
            v_tokens := array_append(v_tokens, 'OP:=');
            v_i := v_i + 1;
            CONTINUE;
        END IF;

        IF v_c = ',' THEN
            v_tokens := array_append(v_tokens, 'COMMA');
            v_i := v_i + 1;
            CONTINUE;
        END IF;

        IF v_c IN ('+', '-', '*', '#') THEN
            v_tokens := array_append(v_tokens, 'OP:' || v_c);
            v_i := v_i + 1;
            CONTINUE;
        END IF;

        RAISE EXCEPTION 'poly_tokenize: unexpected character % at position %', v_c, v_i;
    END LOOP;
    RETURN v_tokens;
END;
$$;

CREATE OR REPLACE FUNCTION poly_peek_token(p_tokens TEXT[], p_pos INTEGER)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p_pos >= 1 AND p_pos <= COALESCE(array_length(p_tokens, 1), 0)
                THEN p_tokens[p_pos] ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION poly_fn_empty_args()
RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_object('named', '{}'::JSONB, 'positional', '[]'::JSONB);
$$;

CREATE OR REPLACE FUNCTION poly_parse_fn_args(
    p_tokens TEXT[],
    p_pos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_pos INTEGER := p_pos;
    v_t TEXT;
    v_name TEXT;
    v_named JSONB := '{}'::JSONB;
    v_positional JSONB := '[]'::JSONB;
BEGIN
    IF poly_peek_token(p_tokens, v_pos) = 'RP' THEN
        RETURN jsonb_build_object('named', v_named, 'positional', v_positional, 'p', v_pos);
    END IF;

    LOOP
        v_t := poly_peek_token(p_tokens, v_pos);
        EXIT WHEN v_t IS NULL OR v_t = 'RP';

        IF v_t LIKE 'ID:%' THEN
            v_name := lower(substr(v_t, 4));
            IF poly_peek_token(p_tokens, v_pos + 1) = 'OP:=' THEN
                v_pos := v_pos + 2;
                v_t := poly_peek_token(p_tokens, v_pos);
                IF v_t LIKE 'NUM:%' THEN
                    v_named := v_named || jsonb_build_object(v_name, (substr(v_t, 5))::NUMERIC);
                    v_pos := v_pos + 1;
                ELSIF v_t LIKE 'ID:%' THEN
                    v_named := v_named || jsonb_build_object(v_name, to_jsonb(upper(substr(v_t, 4))));
                    v_pos := v_pos + 1;
                ELSE
                    RAISE EXCEPTION 'poly_parse_fn_args: expected value after %=%', v_name, v_name;
                END IF;
            ELSE
                v_positional := v_positional || jsonb_build_array(to_jsonb(upper(substr(v_t, 4))));
                v_pos := v_pos + 1;
            END IF;
        ELSIF v_t LIKE 'NUM:%' THEN
            v_positional := v_positional || jsonb_build_array(to_jsonb((substr(v_t, 5))::NUMERIC));
            v_pos := v_pos + 1;
        ELSE
            RAISE EXCEPTION 'poly_parse_fn_args: unexpected token %', v_t;
        END IF;

        IF poly_peek_token(p_tokens, v_pos) = 'COMMA' THEN
            v_pos := v_pos + 1;
            CONTINUE;
        END IF;
        EXIT WHEN poly_peek_token(p_tokens, v_pos) = 'RP';
    END LOOP;

    IF poly_peek_token(p_tokens, v_pos) <> 'RP' THEN
        RAISE EXCEPTION 'poly_parse_fn_args: expected )';
    END IF;

    RETURN jsonb_build_object('named', v_named, 'positional', v_positional, 'p', v_pos + 1);
END;
$$;

CREATE OR REPLACE FUNCTION poly_fn_validate_args(p_fn TEXT, p_args JSONB)
RETURNS VOID
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_pos JSONB;
    v_n INTEGER;
    v_i INTEGER;
    v_s TEXT;
    v_has_num BOOLEAN := FALSE;
BEGIN
    v_pos := COALESCE(p_args -> 'positional', '[]'::JSONB);
    v_n := COALESCE(jsonb_array_length(v_pos), 0);
    FOR v_i IN 0 .. GREATEST(v_n - 1, 0) LOOP
        IF jsonb_typeof(v_pos -> v_i) = 'string' THEN
            v_s := lower(v_pos ->> v_i);
            IF v_s IN ('pp', 'oo', 'hh', 'll', 'vv') THEN
                RAISE EXCEPTION 'poly_fn: use bare % for close; () does not take market columns', p_fn;
            END IF;
            IF v_i < v_n - 1 THEN
                RAISE EXCEPTION 'poly_fn: series must be the last positional argument in %()', p_fn;
            END IF;
        ELSIF jsonb_typeof(v_pos -> v_i) = 'number' THEN
            v_has_num := TRUE;
        END IF;
    END LOOP;

    IF v_n = 1 AND jsonb_typeof(v_pos -> 0) = 'string' AND NOT v_has_num THEN
        IF lower(p_fn) IN ('sma', 'ema', 'ww') AND lower(v_pos ->> 0) NOT IN ('value') THEN
            RAISE EXCEPTION 'poly_fn: %() needs period before series; use % or %(period=N)', p_fn, p_fn, p_fn;
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION poly_fn_resolve_period(p_node JSONB, p_ctx JSONB)
RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_args JSONB;
    v_named JSONB;
    v_pos JSONB;
    v_i INTEGER;
    v_n INTEGER;
BEGIN
    v_args := COALESCE(p_node -> 'args', poly_fn_empty_args());
    v_named := COALESCE(v_args -> 'named', '{}'::JSONB);
    v_pos := COALESCE(v_args -> 'positional', '[]'::JSONB);

    IF v_named ? 'period' THEN
        RETURN GREATEST((v_named ->> 'period')::INTEGER, 1);
    END IF;

    v_n := COALESCE(jsonb_array_length(v_pos), 0);
    FOR v_i IN 0 .. GREATEST(v_n - 1, 0) LOOP
        IF jsonb_typeof(v_pos -> v_i) = 'number' THEN
            RETURN GREATEST((v_pos ->> v_i)::INTEGER, 1);
        END IF;
    END LOOP;

    RETURN poly_ctx_period(p_ctx);
END;
$$;

CREATE OR REPLACE FUNCTION poly_fn_resolve_series(p_node JSONB, p_default TEXT DEFAULT 'VALUE')
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_args JSONB;
    v_named JSONB;
    v_pos JSONB;
    v_n INTEGER;
BEGIN
    v_args := COALESCE(p_node -> 'args', poly_fn_empty_args());
    v_named := COALESCE(v_args -> 'named', '{}'::JSONB);
    v_pos := COALESCE(v_args -> 'positional', '[]'::JSONB);

    IF v_named ? 'series' THEN
        RETURN upper(v_named ->> 'series');
    END IF;

    v_n := COALESCE(jsonb_array_length(v_pos), 0);
    IF v_n > 0 AND jsonb_typeof(v_pos -> (v_n - 1)) = 'string' THEN
        RETURN upper(v_pos ->> (v_n - 1));
    END IF;

    RETURN upper(COALESCE(p_default, 'VALUE'));
END;
$$;

CREATE OR REPLACE FUNCTION poly_parse_atom(
    p_tokens TEXT[],
    p_pos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_t TEXT;
    v_parts TEXT[];
    v_vec NUMERIC[];
    v_inner JSONB;
    v_args JSONB;
    v_fn TEXT;
    i INTEGER;
    v_pos INTEGER := p_pos;
BEGIN
    v_t := poly_peek_token(p_tokens, v_pos);
    IF v_t IS NULL THEN
        RAISE EXCEPTION 'poly_parse: unexpected end of formula';
    END IF;

    IF v_t = 'LP' THEN
        v_pos := v_pos + 1;
        v_inner := poly_parse_add(p_tokens, v_pos);
        v_pos := (v_inner ->> 'p')::INTEGER;
        IF poly_peek_token(p_tokens, v_pos) <> 'RP' THEN
            RAISE EXCEPTION 'poly_parse: expected )';
        END IF;
        RETURN jsonb_build_object('n', v_inner -> 'n', 'p', v_pos + 1);
    END IF;

    IF v_t LIKE 'ID:%' AND lower(substr(v_t, 4)) IN ('sma', 'ema', 'ww') THEN
        v_fn := lower(substr(v_t, 4));
        IF poly_peek_token(p_tokens, v_pos + 1) IS DISTINCT FROM 'LP' THEN
            RETURN jsonb_build_object(
                'n', jsonb_build_object('fn', v_fn, 'args', poly_fn_empty_args()),
                'p', v_pos + 1
            );
        END IF;
        v_pos := v_pos + 2;
        v_args := poly_parse_fn_args(p_tokens, v_pos);
        v_pos := (v_args ->> 'p')::INTEGER;
        PERFORM poly_fn_validate_args(
            v_fn,
            jsonb_build_object(
                'named', COALESCE(v_args -> 'named', '{}'::JSONB),
                'positional', COALESCE(v_args -> 'positional', '[]'::JSONB)
            )
        );
        RETURN jsonb_build_object(
            'n', jsonb_build_object(
                'fn', v_fn,
                'args', jsonb_build_object(
                    'named', COALESCE(v_args -> 'named', '{}'::JSONB),
                    'positional', COALESCE(v_args -> 'positional', '[]'::JSONB)
                )
            ),
            'p', v_pos
        );
    END IF;

    IF v_t LIKE 'ID:%' THEN
        RETURN jsonb_build_object('n', jsonb_build_object('var', substr(v_t, 4)), 'p', v_pos + 1);
    END IF;

    IF v_t LIKE 'NUM:%' THEN
        RETURN jsonb_build_object('n', jsonb_build_object('num', substr(v_t, 5)::NUMERIC), 'p', v_pos + 1);
    END IF;

    IF v_t LIKE 'VEC:%' THEN
        v_parts := string_to_array(substr(v_t, 5), ',');
        v_vec := ARRAY[]::NUMERIC[];
        FOR i IN 1 .. COALESCE(array_length(v_parts, 1), 0) LOOP
            v_vec := array_append(v_vec, btrim(v_parts[i])::NUMERIC);
        END LOOP;
        RETURN jsonb_build_object('n', jsonb_build_object('vec', to_jsonb(v_vec)), 'p', v_pos + 1);
    END IF;

    IF v_t LIKE 'DD:%' THEN
        RETURN jsonb_build_object('n', jsonb_build_object('dd', (substr(v_t, 4))::INTEGER), 'p', v_pos + 1);
    END IF;

    IF v_t LIKE 'IND:%' THEN
        v_parts := string_to_array(substr(v_t, 5), ':');
        IF array_length(v_parts, 1) = 1 THEN
            RETURN jsonb_build_object(
                'n', jsonb_build_object('ind', jsonb_build_object('code', v_parts[1], 'series', NULL)),
                'p', v_pos + 1
            );
        END IF;
        RETURN jsonb_build_object(
            'n', jsonb_build_object('ind', jsonb_build_object('code', v_parts[1], 'series', v_parts[2])),
            'p', v_pos + 1
        );
    END IF;

    RAISE EXCEPTION 'poly_parse: unexpected token %', v_t;
END;
$$;

CREATE OR REPLACE FUNCTION poly_parse_unary(
    p_tokens TEXT[],
    p_pos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_inner JSONB;
BEGIN
    IF poly_peek_token(p_tokens, p_pos) = 'OP:-' THEN
        v_inner := poly_parse_unary(p_tokens, p_pos + 1);
        RETURN jsonb_build_object(
            'n', jsonb_build_object('op', 'neg', 'arg', v_inner -> 'n'),
            'p', (v_inner ->> 'p')::INTEGER
        );
    END IF;
    RETURN poly_parse_atom(p_tokens, p_pos);
END;
$$;

CREATE OR REPLACE FUNCTION poly_parse_comp(
    p_tokens TEXT[],
    p_pos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_left JSONB;
    v_right JSONB;
    v_op TEXT;
    v_pos INTEGER;
BEGIN
    v_left := poly_parse_unary(p_tokens, p_pos);
    v_pos := (v_left ->> 'p')::INTEGER;
    v_left := v_left -> 'n';

    WHILE poly_peek_token(p_tokens, v_pos) IN ('OP:#', 'OP:/#') LOOP
        v_op := substr(poly_peek_token(p_tokens, v_pos), 4);
        v_pos := v_pos + 1;
        v_right := poly_parse_unary(p_tokens, v_pos);
        v_pos := (v_right ->> 'p')::INTEGER;
        IF v_op = '#' THEN
            v_left := jsonb_build_object('op', 'cmul', 'left', v_left, 'right', v_right -> 'n');
        ELSE
            v_left := jsonb_build_object('op', 'cdiv', 'left', v_left, 'right', v_right -> 'n');
        END IF;
    END LOOP;

    RETURN jsonb_build_object('n', v_left, 'p', v_pos);
END;
$$;

CREATE OR REPLACE FUNCTION poly_parse_conv(
    p_tokens TEXT[],
    p_pos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_left JSONB;
    v_right JSONB;
    v_pos INTEGER;
BEGIN
    v_left := poly_parse_comp(p_tokens, p_pos);
    v_pos := (v_left ->> 'p')::INTEGER;
    v_left := v_left -> 'n';

    WHILE poly_peek_token(p_tokens, v_pos) = 'OP:*' LOOP
        v_pos := v_pos + 1;
        v_right := poly_parse_comp(p_tokens, v_pos);
        v_pos := (v_right ->> 'p')::INTEGER;
        v_left := jsonb_build_object('op', 'conv', 'left', v_left, 'right', v_right -> 'n');
    END LOOP;

    RETURN jsonb_build_object('n', v_left, 'p', v_pos);
END;
$$;

CREATE OR REPLACE FUNCTION poly_parse_add(
    p_tokens TEXT[],
    p_pos INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_left JSONB;
    v_right JSONB;
    v_op TEXT;
    v_pos INTEGER;
BEGIN
    v_left := poly_parse_conv(p_tokens, p_pos);
    v_pos := (v_left ->> 'p')::INTEGER;
    v_left := v_left -> 'n';

    WHILE poly_peek_token(p_tokens, v_pos) IN ('OP:+', 'OP:-') LOOP
        v_op := substr(poly_peek_token(p_tokens, v_pos), 4);
        v_pos := v_pos + 1;
        v_right := poly_parse_conv(p_tokens, v_pos);
        v_pos := (v_right ->> 'p')::INTEGER;
        IF v_op = '+' THEN
            v_left := jsonb_build_object('op', 'add', 'left', v_left, 'right', v_right -> 'n');
        ELSE
            v_left := jsonb_build_object('op', 'sub', 'left', v_left, 'right', v_right -> 'n');
        END IF;
    END LOOP;

    RETURN jsonb_build_object('n', v_left, 'p', v_pos);
END;
$$;

CREATE OR REPLACE FUNCTION poly_parse(p_formula TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tokens TEXT[];
    v_pos INTEGER := 1;
    v_step JSONB;
BEGIN
    v_tokens := poly_tokenize(p_formula);
    IF COALESCE(array_length(v_tokens, 1), 0) = 0 THEN
        RAISE EXCEPTION 'poly_parse: empty formula';
    END IF;
    v_step := poly_parse_add(v_tokens, v_pos);
    v_pos := (v_step ->> 'p')::INTEGER;
    IF v_pos <= COALESCE(array_length(v_tokens, 1), 0) THEN
        RAISE EXCEPTION 'poly_parse: trailing tokens at position % (%)', v_pos, v_tokens[v_pos];
    END IF;
    RETURN v_step -> 'n';
END;
$$;

CREATE OR REPLACE FUNCTION poly_load_market_array(
    p_field TEXT,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_end_dt TIMESTAMP,
    p_bars INTEGER
)
RETURNS NUMERIC[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_arr NUMERIC[];
    v_field TEXT := lower(btrim(p_field));
BEGIN
    SELECT array_agg(x.v ORDER BY x.dt)
    INTO v_arr
    FROM (
        SELECT p.dt,
               CASE v_field
                   WHEN 'pp' THEN p.close_price
                   WHEN 'oo' THEN p.open_price
                   WHEN 'hh' THEN p.high_price
                   WHEN 'll' THEN p.low_price
                   WHEN 'vv' THEN p.volume::NUMERIC
                   ELSE NULL
               END AS v
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt <= p_end_dt
        ORDER BY p.dt DESC
        LIMIT p_bars
    ) x;
    RETURN COALESCE(v_arr, ARRAY[]::NUMERIC[]);
END;
$$;

CREATE OR REPLACE FUNCTION poly_load_market_dts(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_end_dt TIMESTAMP,
    p_bars INTEGER
)
RETURNS TIMESTAMP[]
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(array_agg(x.dt ORDER BY x.dt), ARRAY[]::TIMESTAMP[])
    FROM (
        SELECT p.dt
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt <= p_end_dt
        ORDER BY p.dt DESC
        LIMIT p_bars
    ) x;
$$;

CREATE OR REPLACE FUNCTION poly_load_indicator_array(
    p_indicator_code TEXT,
    p_series TEXT,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_end_dt TIMESTAMP,
    p_bars INTEGER,
    p_period INTEGER DEFAULT NULL,
    p_fast_period INTEGER DEFAULT NULL,
    p_slow_period INTEGER DEFAULT NULL,
    p_signal_period INTEGER DEFAULT NULL,
    p_std_dev NUMERIC DEFAULT NULL,
    p_k_period INTEGER DEFAULT NULL,
    p_d_period INTEGER DEFAULT NULL,
    p_smooth INTEGER DEFAULT NULL,
    p_target_dts TIMESTAMP[] DEFAULT NULL
)
RETURNS NUMERIC[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_series TEXT := COALESCE(NULLIF(btrim(p_series), ''), 'VALUE');
    v_map JSONB := '{}'::JSONB;
    v_arr NUMERIC[] := ARRAY[]::NUMERIC[];
    v_dt TIMESTAMP;
    v_val NUMERIC;
    i INTEGER;
BEGIN
    FOR v_dt, v_val IN
        SELECT t.dt, t.value
        FROM calc_indicator_series_array(
            p_indicator_code, v_series,
            p_security_id, p_timeframe_id, p_bars, p_end_dt,
            p_period, p_fast_period, p_slow_period, p_signal_period,
            p_std_dev, p_k_period, p_d_period, p_smooth
        ) t
    LOOP
        v_map := v_map || jsonb_build_object(to_char(v_dt, 'YYYY-MM-DD HH24:MI:SS'), to_jsonb(v_val));
    END LOOP;

    IF p_target_dts IS NULL THEN
        SELECT COALESCE(array_agg((v_map ->> to_char(d, 'YYYY-MM-DD HH24:MI:SS'))::NUMERIC ORDER BY ord), ARRAY[]::NUMERIC[])
        INTO v_arr
        FROM unnest(
            (SELECT poly_load_market_dts(p_security_id, p_timeframe_id, p_end_dt, p_bars))
        ) WITH ORDINALITY AS t(d, ord);
        RETURN v_arr;
    END IF;

    FOR i IN 1 .. COALESCE(array_length(p_target_dts, 1), 0) LOOP
        v_dt := p_target_dts[i];
        v_val := (v_map ->> to_char(v_dt, 'YYYY-MM-DD HH24:MI:SS'))::NUMERIC;
        v_arr := array_append(v_arr, v_val);
    END LOOP;
    RETURN v_arr;
END;
$$;

CREATE OR REPLACE FUNCTION poly_eval_node(
    p_node JSONB,
    p_ctx JSONB
)
RETURNS NUMERIC[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_op TEXT;
    v_var TEXT;
    v_num NUMERIC;
    v_vec NUMERIC[];
    v_left NUMERIC[];
    v_right NUMERIC[];
    v_ind JSONB;
    v_code TEXT;
    v_series TEXT;
    v_fn TEXT;
    v_period INTEGER;
    i INTEGER;
BEGIN
    IF p_node ? 'num' THEN
        RETURN ARRAY[(p_node ->> 'num')::NUMERIC];
    END IF;

    IF p_node ? 'vec' THEN
        v_vec := ARRAY[]::NUMERIC[];
        FOR i IN 0 .. jsonb_array_length(p_node -> 'vec') - 1 LOOP
            v_vec := array_append(v_vec, ((p_node -> 'vec' ->> i)::NUMERIC));
        END LOOP;
        RETURN v_vec;
    END IF;

    IF p_node ? 'dd' THEN
        RETURN poly_delta_kernel((p_node ->> 'dd')::INTEGER);
    END IF;

    IF p_node ? 'fn' THEN
        v_fn := lower(p_node ->> 'fn');
        PERFORM poly_fn_validate_args(v_fn, COALESCE(p_node -> 'args', poly_fn_empty_args()));
        v_period := poly_fn_resolve_period(p_node, p_ctx);
        v_series := poly_fn_resolve_series(p_node, 'VALUE');
        CASE v_fn
            WHEN 'ww' THEN
                RETURN poly_build_sma_kernel(v_period);
            WHEN 'sma' THEN
                RETURN poly_convolve(
                    poly_pp_from_ctx(p_ctx),
                    poly_build_sma_kernel(v_period)
                );
            WHEN 'ema' THEN
                RETURN poly_convolve(
                    poly_pp_from_ctx(p_ctx),
                    poly_build_ema_kernel(v_period)
                );
            ELSE
                RAISE EXCEPTION 'poly_eval: unknown function %', v_fn;
        END CASE;
    END IF;

    IF p_node ? 'var' THEN
        v_var := p_node ->> 'var';
        IF p_ctx ? ('m_' || v_var) THEN
            v_vec := ARRAY(SELECT jsonb_array_elements_text(p_ctx -> ('m_' || v_var))::NUMERIC);
            RETURN v_vec;
        END IF;
        RAISE EXCEPTION 'poly_eval: unknown market variable %', v_var;
    END IF;

    IF p_node ? 'ind' THEN
        v_ind := p_node -> 'ind';
        v_code := v_ind ->> 'code';
        v_series := v_ind ->> 'series';
        RETURN poly_load_indicator_array(
            v_code, v_series,
            (p_ctx ->> 'security_id')::INTEGER,
            (p_ctx ->> 'timeframe_id')::INTEGER,
            (p_ctx ->> 'end_dt')::TIMESTAMP,
            (p_ctx ->> 'bars')::INTEGER,
            NULLIF(p_ctx ->> 'param_period', '')::INTEGER,
            NULLIF(p_ctx ->> 'param_fast_period', '')::INTEGER,
            NULLIF(p_ctx ->> 'param_slow_period', '')::INTEGER,
            NULLIF(p_ctx ->> 'param_signal_period', '')::INTEGER,
            NULLIF(p_ctx ->> 'param_std_dev', '')::NUMERIC,
            NULLIF(p_ctx ->> 'param_k_period', '')::INTEGER,
            NULLIF(p_ctx ->> 'param_d_period', '')::INTEGER,
            NULLIF(p_ctx ->> 'param_smooth', '')::INTEGER,
            ARRAY(SELECT jsonb_array_elements_text(p_ctx -> 'dts')::TIMESTAMP)
        );
    END IF;

    IF p_node ? 'op' THEN
        v_op := p_node ->> 'op';
        IF v_op = 'neg' THEN
            RETURN poly_neg(poly_eval_node(p_node -> 'arg', p_ctx));
        END IF;
        v_left := poly_eval_node(p_node -> 'left', p_ctx);
        v_right := poly_eval_node(p_node -> 'right', p_ctx);
        CASE v_op
            WHEN 'add' THEN RETURN poly_add(v_left, v_right);
            WHEN 'sub' THEN RETURN poly_sub(v_left, v_right);
            WHEN 'conv' THEN RETURN poly_convolve(v_left, v_right, poly_ctx_period(p_ctx));
            WHEN 'cmul' THEN RETURN poly_comp_mul(v_left, v_right);
            WHEN 'cdiv' THEN RETURN poly_comp_div(v_left, v_right);
            ELSE RAISE EXCEPTION 'poly_eval: unknown op %', v_op;
        END CASE;
    END IF;

    RAISE EXCEPTION 'poly_eval: invalid node %', p_node;
END;
$$;

CREATE OR REPLACE FUNCTION calc_poly_formula_array(
    p_formula TEXT,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL,
    p_period INTEGER DEFAULT NULL,
    p_fast_period INTEGER DEFAULT NULL,
    p_slow_period INTEGER DEFAULT NULL,
    p_signal_period INTEGER DEFAULT NULL,
    p_std_dev NUMERIC DEFAULT NULL,
    p_k_period INTEGER DEFAULT NULL,
    p_d_period INTEGER DEFAULT NULL,
    p_smooth INTEGER DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_ast JSONB;
    v_ctx JSONB;
    v_values NUMERIC[];
    v_n INTEGER;
    v_start INTEGER;
    i INTEGER;
BEGIN
    IF p_series IS NOT NULL AND btrim(p_series) = '' THEN
        RETURN;
    END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;

    v_bars := poly_formula_warmup_bars(p_formula, COALESCE(p_period, 14), p_point_count);

    v_dts := poly_load_market_dts(p_security_id, p_timeframe_id, v_end, v_bars);
    v_n := COALESCE(array_length(v_dts, 1), 0);
    IF v_n = 0 THEN RETURN; END IF;

    v_ctx := jsonb_build_object(
        'security_id', p_security_id,
        'timeframe_id', p_timeframe_id,
        'end_dt', to_char(v_end, 'YYYY-MM-DD HH24:MI:SS'),
        'bars', v_bars,
        'param_period', p_period,
        'param_fast_period', p_fast_period,
        'param_slow_period', p_slow_period,
        'param_signal_period', p_signal_period,
        'param_std_dev', p_std_dev,
        'param_k_period', p_k_period,
        'param_d_period', p_d_period,
        'param_smooth', p_smooth,
        'dts', to_jsonb(v_dts)
    );

    IF position('pp' IN lower(btrim(p_formula))) > 0
       OR position('sma' IN lower(btrim(p_formula))) > 0
       OR position('ema' IN lower(btrim(p_formula))) > 0
       OR position('ww' IN lower(btrim(p_formula))) > 0 THEN
        v_ctx := v_ctx || jsonb_build_object(
            'm_pp', to_jsonb(poly_load_market_array('pp', p_security_id, p_timeframe_id, v_end, v_bars))
        );
    END IF;
    IF position('oo' IN lower(btrim(p_formula))) > 0 THEN
        v_ctx := v_ctx || jsonb_build_object(
            'm_oo', to_jsonb(poly_load_market_array('oo', p_security_id, p_timeframe_id, v_end, v_bars))
        );
    END IF;
    IF position('hh' IN lower(btrim(p_formula))) > 0 THEN
        v_ctx := v_ctx || jsonb_build_object(
            'm_hh', to_jsonb(poly_load_market_array('hh', p_security_id, p_timeframe_id, v_end, v_bars))
        );
    END IF;
    IF position('ll' IN lower(btrim(p_formula))) > 0 THEN
        v_ctx := v_ctx || jsonb_build_object(
            'm_ll', to_jsonb(poly_load_market_array('ll', p_security_id, p_timeframe_id, v_end, v_bars))
        );
    END IF;
    IF position('vv' IN lower(btrim(p_formula))) > 0 THEN
        v_ctx := v_ctx || jsonb_build_object(
            'm_vv', to_jsonb(poly_load_market_array('vv', p_security_id, p_timeframe_id, v_end, v_bars))
        );
    END IF;

    v_ast := poly_parse(p_formula);
    v_values := poly_eval_node(v_ast, v_ctx);
    v_n := LEAST(COALESCE(array_length(v_values, 1), 0), COALESCE(array_length(v_dts, 1), 0));
    IF v_n = 0 THEN RETURN; END IF;

    v_start := GREATEST(1, v_n - COALESCE(p_point_count, 100) + 1);
    FOR i IN v_start .. v_n LOOP
        dt := v_dts[i];
        value := v_values[i];
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION calc_poly_formula_array IS
'Вычисляет многочленную формулу индикатора (pp * (1;-2;1), @SMA # pp, …) и возвращает последние point_count точек.';

-- @begin calc_ind_extra
-- Доп. индикаторы для логик L1–L4 (из MultiLogicTradeA / FINRESP):
-- ADX, CCI, LINREG (+ ATR series GROWTH5).
-- Подключается в 02 через маркеры begin/end calc_ind_extra (см. sync-sql-modules-to-02.mjs)

-- ========== ATR: GROWTH5 = % роста ATR за 5 баров (бывший GrOk: Gr=3%, Lb=5) ==========
CREATE OR REPLACE FUNCTION calc_ind_atr_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_atr NUMERIC;
    v_tr NUMERIC;
    v_tr_high NUMERIC;
    v_tr_low NUMERIC;
    v_tr_close NUMERIC;
    v_atr_hist NUMERIC[] := ARRAY[]::NUMERIC[];
    i INTEGER;
    v_start INTEGER;
    v_lb INTEGER := 5;
    v_prev NUMERIC;
BEGIN
    IF upper(btrim(p_series)) NOT IN ('ATR', 'ATR_PCT', 'GROWTH5') THEN
        RETURN;
    END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_period + v_lb + 5, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.high_price ORDER BY x.dt),
           array_agg(x.low_price ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_highs, v_lows, v_closes, v_n
    FROM (
        SELECT p.dt, p.high_price, p.low_price, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < p_period + 1 THEN RETURN; END IF;

    v_atr := 0;
    v_start := GREATEST(p_period, v_n - p_point_count + 1);
    FOR i IN 2 .. v_n LOOP
        v_tr_high := v_highs[i] - v_lows[i];
        v_tr_low := ABS(v_highs[i] - v_closes[i - 1]);
        v_tr_close := ABS(v_lows[i] - v_closes[i - 1]);
        v_tr := GREATEST(v_tr_high, v_tr_low, v_tr_close);
        IF i <= p_period THEN
            v_atr := v_atr + v_tr;
            IF i = p_period THEN v_atr := v_atr / p_period; END IF;
        ELSE
            v_atr := (v_atr * (p_period - 1) + v_tr) / p_period;
        END IF;
        IF i >= p_period THEN
            v_atr_hist := array_append(v_atr_hist, v_atr);
        END IF;
        IF i >= v_start AND i >= p_period THEN
            dt := v_dts[i];
            IF upper(btrim(p_series)) = 'ATR' THEN
                value := v_atr;
            ELSIF upper(btrim(p_series)) = 'ATR_PCT' THEN
                value := CASE WHEN v_closes[i] = 0 THEN NULL ELSE v_atr / v_closes[i] * 100 END;
            ELSE
                -- GROWTH5
                IF array_length(v_atr_hist, 1) > v_lb THEN
                    v_prev := v_atr_hist[array_length(v_atr_hist, 1) - v_lb];
                    value := CASE
                        WHEN v_prev IS NULL OR v_prev = 0 THEN NULL
                        ELSE (v_atr / v_prev - 1.0) * 100.0
                    END;
                ELSE
                    value := NULL;
                END IF;
            END IF;
            IF value IS NOT NULL THEN
                RETURN NEXT;
            END IF;
        END IF;
    END LOOP;
END;
$$;

-- ========== CCI ==========
CREATE OR REPLACE FUNCTION calc_ind_cci_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_tp NUMERIC[];
    v_n INTEGER;
    i INTEGER;
    j INTEGER;
    v_start INTEGER;
    v_sma NUMERIC;
    v_md NUMERIC;
    v_period INTEGER;
BEGIN
    IF upper(btrim(COALESCE(p_series, 'VALUE'))) NOT IN ('VALUE', 'CCI') THEN
        RETURN;
    END IF;
    v_period := GREATEST(COALESCE(p_period, 20), 2);
    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(v_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.high_price ORDER BY x.dt),
           array_agg(x.low_price ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_highs, v_lows, v_closes, v_n
    FROM (
        SELECT p.dt, p.high_price, p.low_price, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < v_period THEN RETURN; END IF;

    v_tp := ARRAY[]::NUMERIC[];
    FOR i IN 1 .. v_n LOOP
        v_tp := array_append(v_tp, (v_highs[i] + v_lows[i] + v_closes[i]) / 3.0);
    END LOOP;

    v_start := GREATEST(v_period, v_n - p_point_count + 1);
    FOR i IN v_period .. v_n LOOP
        IF i < v_start THEN CONTINUE; END IF;
        v_sma := 0;
        FOR j IN (i - v_period + 1) .. i LOOP
            v_sma := v_sma + v_tp[j];
        END LOOP;
        v_sma := v_sma / v_period;
        v_md := 0;
        FOR j IN (i - v_period + 1) .. i LOOP
            v_md := v_md + ABS(v_tp[j] - v_sma);
        END LOOP;
        v_md := v_md / v_period;
        dt := v_dts[i];
        value := CASE
            WHEN v_md = 0 THEN 0
            ELSE (v_tp[i] - v_sma) / (0.015 * v_md)
        END;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- ========== ADX (Wilder) ==========
CREATE OR REPLACE FUNCTION calc_ind_adx_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_period INTEGER;
    v_ser TEXT;
    i INTEGER;
    v_start INTEGER;
    v_tr NUMERIC;
    v_plus_dm NUMERIC;
    v_minus_dm NUMERIC;
    v_atr NUMERIC := 0;
    v_plus_dm_s NUMERIC := 0;
    v_minus_dm_s NUMERIC := 0;
    v_plus_di NUMERIC;
    v_minus_di NUMERIC;
    v_dx NUMERIC;
    v_adx NUMERIC := NULL;
    v_dx_sum NUMERIC := 0;
    v_dx_n INTEGER := 0;
BEGIN
    v_ser := upper(btrim(COALESCE(p_series, 'ADX')));
    IF v_ser NOT IN ('ADX', 'PDI', 'MDI', 'VALUE') THEN
        RETURN;
    END IF;
    IF v_ser = 'VALUE' THEN v_ser := 'ADX'; END IF;
    v_period := GREATEST(COALESCE(p_period, 14), 2);

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(v_period * 3, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.high_price ORDER BY x.dt),
           array_agg(x.low_price ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_highs, v_lows, v_closes, v_n
    FROM (
        SELECT p.dt, p.high_price, p.low_price, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < v_period + 2 THEN RETURN; END IF;

    v_start := GREATEST(v_period * 2, v_n - p_point_count + 1);

    FOR i IN 2 .. v_n LOOP
        v_tr := GREATEST(
            v_highs[i] - v_lows[i],
            ABS(v_highs[i] - v_closes[i - 1]),
            ABS(v_lows[i] - v_closes[i - 1])
        );
        v_plus_dm := CASE
            WHEN (v_highs[i] - v_highs[i - 1]) > (v_lows[i - 1] - v_lows[i])
                 AND (v_highs[i] - v_highs[i - 1]) > 0
            THEN v_highs[i] - v_highs[i - 1]
            ELSE 0
        END;
        v_minus_dm := CASE
            WHEN (v_lows[i - 1] - v_lows[i]) > (v_highs[i] - v_highs[i - 1])
                 AND (v_lows[i - 1] - v_lows[i]) > 0
            THEN v_lows[i - 1] - v_lows[i]
            ELSE 0
        END;

        IF i <= v_period THEN
            v_atr := v_atr + v_tr;
            v_plus_dm_s := v_plus_dm_s + v_plus_dm;
            v_minus_dm_s := v_minus_dm_s + v_minus_dm;
            IF i = v_period THEN
                v_atr := v_atr / v_period;
                v_plus_dm_s := v_plus_dm_s / v_period;
                v_minus_dm_s := v_minus_dm_s / v_period;
            END IF;
        ELSE
            v_atr := (v_atr * (v_period - 1) + v_tr) / v_period;
            v_plus_dm_s := (v_plus_dm_s * (v_period - 1) + v_plus_dm) / v_period;
            v_minus_dm_s := (v_minus_dm_s * (v_period - 1) + v_minus_dm) / v_period;
        END IF;

        IF i < v_period THEN
            CONTINUE;
        END IF;

        IF v_atr = 0 THEN
            v_plus_di := 0;
            v_minus_di := 0;
        ELSE
            v_plus_di := 100.0 * v_plus_dm_s / v_atr;
            v_minus_di := 100.0 * v_minus_dm_s / v_atr;
        END IF;

        IF (v_plus_di + v_minus_di) = 0 THEN
            v_dx := 0;
        ELSE
            v_dx := 100.0 * ABS(v_plus_di - v_minus_di) / (v_plus_di + v_minus_di);
        END IF;

        IF i < v_period * 2 THEN
            v_dx_sum := v_dx_sum + v_dx;
            v_dx_n := v_dx_n + 1;
            IF i = v_period * 2 - 1 THEN
                v_adx := v_dx_sum / GREATEST(v_dx_n, 1);
            END IF;
        ELSIF v_adx IS NOT NULL THEN
            v_adx := (v_adx * (v_period - 1) + v_dx) / v_period;
        END IF;

        IF i >= v_start AND v_adx IS NOT NULL THEN
            dt := v_dts[i];
            value := CASE v_ser
                WHEN 'ADX' THEN v_adx
                WHEN 'PDI' THEN v_plus_di
                WHEN 'MDI' THEN v_minus_di
            END;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

-- ========== LINREG канал (mid ± Dev·σ остатков) ==========
CREATE OR REPLACE FUNCTION calc_ind_linreg_array(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_period INTEGER;
    v_dev NUMERIC;
    v_ser TEXT;
    i INTEGER;
    j INTEGER;
    v_start INTEGER;
    v_sum_x NUMERIC;
    v_sum_y NUMERIC;
    v_sum_xy NUMERIC;
    v_sum_xx NUMERIC;
    v_slope NUMERIC;
    v_intercept NUMERIC;
    v_mid NUMERIC;
    v_var NUMERIC;
    v_std NUMERIC;
    v_pred NUMERIC;
    n NUMERIC;
BEGIN
    v_ser := upper(btrim(COALESCE(p_series, 'VALUE')));
    IF v_ser NOT IN ('VALUE', 'MIDDLE', 'UPPER', 'LOWER', 'SLOPE') THEN
        RETURN;
    END IF;
    IF v_ser = 'VALUE' THEN v_ser := 'MIDDLE'; END IF;
    v_period := GREATEST(COALESCE(p_period, 20), 3);
    v_dev := GREATEST(COALESCE(p_std_dev, 2.0), 0.1);

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(v_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < v_period THEN RETURN; END IF;

    v_start := GREATEST(v_period, v_n - p_point_count + 1);
    n := v_period;

    FOR i IN v_period .. v_n LOOP
        IF i < v_start THEN CONTINUE; END IF;
        v_sum_x := 0;
        v_sum_y := 0;
        v_sum_xy := 0;
        v_sum_xx := 0;
        FOR j IN 0 .. (v_period - 1) LOOP
            -- x = 0..period-1 на окне, y = close
            v_sum_x := v_sum_x + j;
            v_sum_y := v_sum_y + v_closes[i - v_period + 1 + j];
            v_sum_xy := v_sum_xy + j * v_closes[i - v_period + 1 + j];
            v_sum_xx := v_sum_xx + j * j;
        END LOOP;
        v_slope := (n * v_sum_xy - v_sum_x * v_sum_y) / NULLIF(n * v_sum_xx - v_sum_x * v_sum_x, 0);
        v_intercept := (v_sum_y - v_slope * v_sum_x) / n;
        v_mid := v_intercept + v_slope * (v_period - 1);

        v_var := 0;
        FOR j IN 0 .. (v_period - 1) LOOP
            v_pred := v_intercept + v_slope * j;
            v_var := v_var + power(v_closes[i - v_period + 1 + j] - v_pred, 2);
        END LOOP;
        v_std := sqrt(v_var / n);

        dt := v_dts[i];
        value := CASE v_ser
            WHEN 'MIDDLE' THEN v_mid
            WHEN 'UPPER' THEN v_mid + v_dev * v_std
            WHEN 'LOWER' THEN v_mid - v_dev * v_std
            WHEN 'SLOPE' THEN v_slope
        END;
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION calc_ind_cci_array(INTEGER, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'CCI (Commodity Channel Index), серия VALUE';
COMMENT ON FUNCTION calc_ind_adx_array(INTEGER, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'ADX / +DI / −DI (Wilder), серии ADX|PDI|MDI';
COMMENT ON FUNCTION calc_ind_linreg_array(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'Линейная регрессия по close: MIDDLE/UPPER/LOWER/SLOPE (канал Dev·σ остатков)';

-- Upgrade: drop removed LINREGV functions if present
DROP FUNCTION IF EXISTS calc_ind_linregv(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER);
DROP FUNCTION IF EXISTS calc_ind_linregv_array(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP);

-- =====================================================================
-- Скалярные calc_ind_* (тот же контракт, что у SMA/STOCH: script → calc_ind_*)
-- =====================================================================
CREATE OR REPLACE FUNCTION calc_ind_cci(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT a.value
        FROM calc_ind_cci_array(
            p_period, p_series, p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

CREATE OR REPLACE FUNCTION calc_ind_adx(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT a.value
        FROM calc_ind_adx_array(
            p_period, p_series, p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

CREATE OR REPLACE FUNCTION calc_ind_linreg(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT a.value
        FROM calc_ind_linreg_array(
            p_period, COALESCE(p_std_dev, 2.0), p_series,
            p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

-- ATR: серия GROWTH5 через array (старый scalar умел только ATR / ATR_PCT)
CREATE OR REPLACE FUNCTION calc_ind_atr(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_ser TEXT := upper(btrim(COALESCE(p_series, 'ATR')));
    v_thr NUMERIC;
BEGIN
    IF v_ser = 'GROWTH5' THEN
        RETURN (
            SELECT a.value
            FROM calc_ind_atr_array(
                p_period, 'GROWTH5', p_security_id, p_timeframe_id, 1, p_dt
            ) a
            ORDER BY a.dt DESC
            LIMIT 1
        );
    END IF;

    IF v_ser = 'ATR_PCT' THEN
        RETURN (
            SELECT a.value
            FROM calc_ind_atr_array(
                p_period, 'ATR_PCT', p_security_id, p_timeframe_id, 1, p_dt
            ) a
            ORDER BY a.dt DESC
            LIMIT 1
        );
    END IF;

    IF v_ser <> 'ATR' AND p_indicator_id IS NOT NULL THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN RETURN v_thr; END IF;
        RETURN NULL;
    END IF;

    RETURN (
        SELECT a.value
        FROM calc_ind_atr_array(
            p_period, 'ATR', p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

COMMENT ON FUNCTION calc_ind_cci(INTEGER, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Скаляр CCI на баре (как calc_ind_sma) — через calc_ind_cci_array';
COMMENT ON FUNCTION calc_ind_adx(INTEGER, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Скаляр ADX/+DI/−DI на баре — через calc_ind_adx_array';
COMMENT ON FUNCTION calc_ind_linreg(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Скаляр LinReg-канала на баре — через calc_ind_linreg_array';

-- ========== SQUARE: квадратичный канал (y = b + a·x + c·x²; mid ± Dev·σ остатков) ==========
-- Те же серии, что у LINREG (MIDDLE/UPPER/LOWER/SLOPE) + C (квадратичный коэффициент).
-- SLOPE = мгновенный наклон в конце окна: a + 2·c·(period−1).
CREATE OR REPLACE FUNCTION calc_ind_square_array(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_period INTEGER;
    v_dev NUMERIC;
    v_ser TEXT;
    i INTEGER;
    j INTEGER;
    x NUMERIC;
    y NUMERIC;
    v_start INTEGER;
    s0 NUMERIC;
    s1 NUMERIC;
    s2 NUMERIC;
    s3 NUMERIC;
    s4 NUMERIC;
    sy NUMERIC;
    sxy NUMERIC;
    sx2y NUMERIC;
    det NUMERIC;
    det_b NUMERIC;
    det_a NUMERIC;
    det_c NUMERIC;
    v_b NUMERIC;
    v_a NUMERIC;
    v_c NUMERIC;
    v_mid NUMERIC;
    v_var NUMERIC;
    v_std NUMERIC;
    v_pred NUMERIC;
    v_x_end NUMERIC;
BEGIN
    v_ser := upper(btrim(COALESCE(p_series, 'VALUE')));
    IF v_ser NOT IN ('VALUE', 'MIDDLE', 'UPPER', 'LOWER', 'SLOPE', 'C') THEN
        RETURN;
    END IF;
    IF v_ser = 'VALUE' THEN v_ser := 'MIDDLE'; END IF;
    -- Минимум 3 точки для трёх коэффициентов (b, a, c).
    v_period := GREATEST(COALESCE(p_period, 20), 3);
    v_dev := GREATEST(COALESCE(p_std_dev, 2.0), 0.1);

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(v_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < v_period THEN RETURN; END IF;

    v_start := GREATEST(v_period, v_n - p_point_count + 1);
    s0 := v_period;
    v_x_end := v_period - 1;

    FOR i IN v_period .. v_n LOOP
        IF i < v_start THEN CONTINUE; END IF;

        s1 := 0; s2 := 0; s3 := 0; s4 := 0;
        sy := 0; sxy := 0; sx2y := 0;
        FOR j IN 0 .. (v_period - 1) LOOP
            x := j;
            y := v_closes[i - v_period + 1 + j];
            s1 := s1 + x;
            s2 := s2 + x * x;
            s3 := s3 + x * x * x;
            s4 := s4 + x * x * x * x;
            sy := sy + y;
            sxy := sxy + x * y;
            sx2y := sx2y + x * x * y;
        END LOOP;

        -- Нормальные уравнения: [s0 s1 s2; s1 s2 s3; s2 s3 s4] · [b;a;c] = [sy;sxy;sx2y]
        det := s0 * (s2 * s4 - s3 * s3)
             - s1 * (s1 * s4 - s2 * s3)
             + s2 * (s1 * s3 - s2 * s2);
        IF det IS NULL OR abs(det) < 1e-18 THEN
            CONTINUE;
        END IF;

        det_b := sy * (s2 * s4 - s3 * s3)
               - s1 * (sxy * s4 - s3 * sx2y)
               + s2 * (sxy * s3 - s2 * sx2y);
        det_a := s0 * (sxy * s4 - s3 * sx2y)
               - sy * (s1 * s4 - s2 * s3)
               + s2 * (s1 * sx2y - s2 * sxy);
        det_c := s0 * (s2 * sx2y - s3 * sxy)
               - s1 * (s1 * sx2y - s2 * sxy)
               + sy * (s1 * s3 - s2 * s2);

        v_b := det_b / det;
        v_a := det_a / det;
        v_c := det_c / det;
        v_mid := v_b + v_a * v_x_end + v_c * v_x_end * v_x_end;

        v_var := 0;
        FOR j IN 0 .. (v_period - 1) LOOP
            x := j;
            v_pred := v_b + v_a * x + v_c * x * x;
            v_var := v_var + power(v_closes[i - v_period + 1 + j] - v_pred, 2);
        END LOOP;
        v_std := sqrt(v_var / s0);

        dt := v_dts[i];
        value := CASE v_ser
            WHEN 'MIDDLE' THEN v_mid
            WHEN 'UPPER' THEN v_mid + v_dev * v_std
            WHEN 'LOWER' THEN v_mid - v_dev * v_std
            WHEN 'SLOPE' THEN v_a + 2 * v_c * v_x_end
            WHEN 'C' THEN v_c
        END;
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION calc_ind_square_array(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'Квадратичная регрессия по close (b+a·x+c·x²): MIDDLE/UPPER/LOWER/SLOPE/C (канал Dev·σ остатков)';

CREATE OR REPLACE FUNCTION calc_ind_square(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT a.value
        FROM calc_ind_square_array(
            p_period, COALESCE(p_std_dev, 2.0), p_series,
            p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

COMMENT ON FUNCTION calc_ind_square(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Скаляр SQUARE-канала на баре — через calc_ind_square_array';

-- =====================================================================
-- Параметры серии из @IND(...period=N...) в formula сигнала (до sync)
-- тот же парсер сигналов, что у SMA (@SMA(period=20,series=VALUE) …)
-- =====================================================================
CREATE OR REPLACE FUNCTION parse_signal_param_num(p_params TEXT, p_key TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_part TEXT;
    v_key TEXT;
    v_val TEXT;
BEGIN
    IF p_params IS NULL OR btrim(p_params) = '' OR p_key IS NULL THEN
        RETURN NULL;
    END IF;
    FOREACH v_part IN ARRAY string_to_array(p_params, ',')
    LOOP
        v_part := btrim(v_part);
        IF position('=' IN v_part) > 0 THEN
            v_key := lower(btrim(split_part(v_part, '=', 1)));
            v_val := btrim(split_part(v_part, '=', 2));
            IF v_key = lower(btrim(p_key)) AND v_val <> '' THEN
                BEGIN
                    RETURN replace(v_val, ',', '.')::NUMERIC;
                EXCEPTION WHEN OTHERS THEN
                    RETURN NULL;
                END;
            END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE PROCEDURE logic_apply_indicator_params_from_signals(
    p_logic_id INTEGER,
    p_security_id INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_sig RECORD;
    v_parsed RECORD;
    v_period NUMERIC;
    v_std NUMERIC;
    v_fast NUMERIC;
    v_slow NUMERIC;
    v_signal NUMERIC;
    v_k NUMERIC;
    v_d NUMERIC;
    v_smooth NUMERIC;
BEGIN
    FOR v_sig IN
        SELECT lis.indicator_id, lis.formula
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
    LOOP
        SELECT * INTO v_parsed FROM parse_signal_formula(v_sig.formula);
        IF NOT COALESCE(v_parsed.valid, FALSE) THEN
            CONTINUE;
        END IF;
        v_period := parse_signal_param_num(v_parsed.params, 'period');
        v_std := parse_signal_param_num(v_parsed.params, 'std_dev');
        v_fast := parse_signal_param_num(v_parsed.params, 'fast_period');
        v_slow := parse_signal_param_num(v_parsed.params, 'slow_period');
        v_signal := parse_signal_param_num(v_parsed.params, 'signal_period');
        v_k := parse_signal_param_num(v_parsed.params, 'k_period');
        v_d := parse_signal_param_num(v_parsed.params, 'd_period');
        v_smooth := parse_signal_param_num(v_parsed.params, 'smooth');

        UPDATE security_indicator_series sis
        SET
            param_period = COALESCE(v_period::INTEGER, sis.param_period),
            param_std_dev = COALESCE(v_std, sis.param_std_dev),
            param_fast_period = COALESCE(v_fast::INTEGER, sis.param_fast_period),
            param_slow_period = COALESCE(v_slow::INTEGER, sis.param_slow_period),
            param_signal_period = COALESCE(v_signal::INTEGER, sis.param_signal_period),
            param_k_period = COALESCE(v_k::INTEGER, sis.param_k_period),
            param_d_period = COALESCE(v_d::INTEGER, sis.param_d_period),
            param_smooth = COALESCE(v_smooth::INTEGER, sis.param_smooth)
        WHERE sis.security_id = p_security_id
          AND sis.indicator_id = v_sig.indicator_id
          AND sis.is_active = TRUE;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_apply_indicator_params_from_signals(INTEGER, INTEGER) IS
'Проставляет param_* серий бумаги из formula сигналов логики перед sync.';
-- @end calc_ind_extra











































-- Диспетчер массивного расчёта по коду индикатора
CREATE OR REPLACE FUNCTION calc_indicator_series_array(
    p_indicator_code VARCHAR,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL,
    p_period INTEGER DEFAULT NULL,
    p_fast_period INTEGER DEFAULT NULL,
    p_slow_period INTEGER DEFAULT NULL,
    p_signal_period INTEGER DEFAULT NULL,
    p_std_dev NUMERIC DEFAULT NULL,
    p_k_period INTEGER DEFAULT NULL,
    p_d_period INTEGER DEFAULT NULL,
    p_smooth INTEGER DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_formula TEXT;
BEGIN
    SELECT NULLIF(btrim(formula), '') INTO v_formula
    FROM indicators WHERE code = upper(btrim(p_indicator_code));

    IF poly_is_formula(v_formula) THEN
        RETURN QUERY SELECT * FROM calc_poly_formula_array(
            v_formula, p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt,
            p_period, p_fast_period, p_slow_period, p_signal_period,
            p_std_dev, p_k_period, p_d_period, p_smooth);
        RETURN;
    END IF;

    CASE upper(btrim(p_indicator_code))
        WHEN 'RSI' THEN
            RETURN QUERY SELECT * FROM calc_ind_rsi_array(
                COALESCE(p_period, 14), p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'SMA' THEN
            RETURN QUERY SELECT * FROM calc_ind_sma_array(
                COALESCE(p_period, 20), p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'EMA' THEN
            RETURN QUERY SELECT * FROM calc_ind_ema_array(
                COALESCE(p_period, 20), p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'MACD' THEN
            RETURN QUERY SELECT * FROM calc_ind_macd_array(
                COALESCE(p_fast_period, 12), COALESCE(p_slow_period, 26), COALESCE(p_signal_period, 9),
                p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'BB' THEN
            RETURN QUERY SELECT * FROM calc_ind_bb_array(
                COALESCE(p_period, 20), COALESCE(p_std_dev, 2.0), p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'ATR' THEN
            RETURN QUERY SELECT * FROM calc_ind_atr_array(
                COALESCE(p_period, 14), p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'STOCH' THEN
            RETURN QUERY SELECT * FROM calc_ind_stoch_array(
                COALESCE(p_k_period, 14), COALESCE(p_d_period, 3), COALESCE(p_smooth, 3),
                p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'CCI' THEN
            RETURN QUERY SELECT * FROM calc_ind_cci_array(
                COALESCE(p_period, 20), p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'ADX' THEN
            RETURN QUERY SELECT * FROM calc_ind_adx_array(
                COALESCE(p_period, 14), p_series, p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'LINREG' THEN
            RETURN QUERY SELECT * FROM calc_ind_linreg_array(
                COALESCE(p_period, 20), COALESCE(p_std_dev, 2.0), p_series,
                p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        WHEN 'SQUARE' THEN
            RETURN QUERY SELECT * FROM calc_ind_square_array(
                COALESCE(p_period, 20), COALESCE(p_std_dev, 2.0), p_series,
                p_security_id, p_timeframe_id, p_point_count, p_end_dt);
        ELSE
            RETURN;
    END CASE;
END;
$$;

-- Дефолтные параметры из parameter_values / indicator code
CREATE OR REPLACE FUNCTION resolve_indicator_params(
    p_indicator_code VARCHAR,
    OUT param_period INTEGER,
    OUT param_fast_period INTEGER,
    OUT param_slow_period INTEGER,
    OUT param_signal_period INTEGER,
    OUT param_std_dev NUMERIC,
    OUT param_k_period INTEGER,
    OUT param_d_period INTEGER,
    OUT param_smooth INTEGER
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    param_period := CASE upper(p_indicator_code)
        WHEN 'RSI' THEN 14 WHEN 'SMA' THEN 20 WHEN 'EMA' THEN 20 WHEN 'BB' THEN 20
        WHEN 'ATR' THEN 14 WHEN 'STOCH' THEN 14 WHEN 'SMAT3' THEN 20
        WHEN 'CCI' THEN 20 WHEN 'ADX' THEN 14 WHEN 'LINREG' THEN 20 WHEN 'SQUARE' THEN 20
        ELSE 14 END;
    BEGIN
        SELECT pv.value::INTEGER INTO param_period
        FROM parameter_values pv
        JOIN parameter_types pt ON pt.id = pv.parameter_type_id
        JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
        WHERE ps.name = 'Default' AND pt.short_name = upper(p_indicator_code) || '_PERIOD'
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    param_fast_period := 12;
    param_slow_period := 26;
    param_signal_period := 9;
    param_std_dev := 2.0;
    param_k_period := COALESCE(param_period, 14);
    param_d_period := 3;
    param_smooth := 3;
END;
$$;

CREATE OR REPLACE FUNCTION default_invoke_formula(p_indicator_code VARCHAR)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        NULLIF(btrim(i.formula), ''),
        'calc_indicator_series_array(:indicator_code, :series, :security_id, :timeframe_id, :point_count, :end_dt)'
    )
    FROM indicators i
    WHERE i.code = upper(btrim(p_indicator_code));
$$;

-- Создать все серии индикатора на бумаге (при drop)
CREATE OR REPLACE PROCEDURE ensure_security_indicator_series(
    p_security_id INTEGER,
    p_indicator_id INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_code VARCHAR(20);
    v_params RECORD;
    v_vt RECORD;
    v_ord INTEGER := 0;
BEGIN
    SELECT code INTO v_code FROM indicators WHERE id = p_indicator_id;
    IF v_code IS NULL THEN
        RAISE EXCEPTION 'indicator_id=% not found', p_indicator_id;
    END IF;

    SELECT * INTO v_params FROM resolve_indicator_params(v_code);

    FOR v_vt IN
        SELECT id, code, display_order
        FROM indicator_value_types
        WHERE indicator_id = p_indicator_id AND is_threshold = FALSE
        ORDER BY display_order, id
    LOOP
        v_ord := v_ord + 1;
        INSERT INTO security_indicator_series (
            security_id, indicator_id, series_code, invoke_formula,
            param_period, param_fast_period, param_slow_period, param_signal_period,
            param_std_dev, param_k_period, param_d_period, param_smooth,
            point_count, display_order
        )
        VALUES (
            p_security_id, p_indicator_id, v_vt.code, default_invoke_formula(v_code),
            v_params.param_period, v_params.param_fast_period, v_params.param_slow_period,
            v_params.param_signal_period, v_params.param_std_dev,
            v_params.param_k_period, v_params.param_d_period, v_params.param_smooth,
            100, v_ord
        )
        ON CONFLICT (security_id, indicator_id, series_code) DO UPDATE SET
            is_active = TRUE,
            invoke_formula = EXCLUDED.invoke_formula;
    END LOOP;
END;
$$;

-- Синхронизация одной серии → indicator_values (инкрементально)
CREATE OR REPLACE PROCEDURE sync_security_indicator_series(
    p_series_id INTEGER,
    p_timeframe_id INTEGER,
    p_end_dt TIMESTAMP DEFAULT NULL,
    p_point_count INTEGER DEFAULT NULL,
    p_incremental BOOLEAN DEFAULT TRUE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_row security_indicator_series%ROWTYPE;
    v_code VARCHAR(20);
    v_vt_id INTEGER;
    v_count INTEGER;
    v_pt RECORD;
BEGIN
    SELECT * INTO v_row FROM security_indicator_series WHERE id = p_series_id AND is_active = TRUE;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT code INTO v_code FROM indicators WHERE id = v_row.indicator_id;
    SELECT id INTO v_vt_id FROM indicator_value_types
    WHERE indicator_id = v_row.indicator_id AND code = v_row.series_code;

    v_count := COALESCE(p_point_count, v_row.point_count, 100);

    IF NOT EXISTS (
        SELECT 1 FROM prices
        WHERE security_id = v_row.security_id
          AND timeframe_id = p_timeframe_id
          AND (p_end_dt IS NULL OR dt <= p_end_dt)
        LIMIT 1
    ) THEN
        RETURN;
    END IF;

    IF poly_is_formula(v_row.invoke_formula) THEN
        FOR v_pt IN
            SELECT * FROM calc_poly_formula_array(
                v_row.invoke_formula, v_row.series_code,
                v_row.security_id, p_timeframe_id, v_count, p_end_dt,
                v_row.param_period, v_row.param_fast_period, v_row.param_slow_period,
                v_row.param_signal_period, v_row.param_std_dev,
                v_row.param_k_period, v_row.param_d_period, v_row.param_smooth
            )
        LOOP
            PERFORM insert_indicator_value(v_row.indicator_id, v_vt_id, v_row.security_id, p_timeframe_id, v_pt.dt, v_pt.value, NOT p_incremental
            );
        END LOOP;
    ELSE
        FOR v_pt IN
            SELECT * FROM calc_indicator_series_array(
                v_code, v_row.series_code,
                v_row.security_id, p_timeframe_id, v_count, p_end_dt,
                v_row.param_period, v_row.param_fast_period, v_row.param_slow_period,
                v_row.param_signal_period, v_row.param_std_dev,
                v_row.param_k_period, v_row.param_d_period, v_row.param_smooth
            )
        LOOP
            PERFORM insert_indicator_value(v_row.indicator_id, v_vt_id, v_row.security_id, p_timeframe_id, v_pt.dt, v_pt.value, NOT p_incremental
            );
        END LOOP;
    END IF;
END;
$$;

-- Синхронизация всех серий одного индикатора на бумаге
CREATE OR REPLACE PROCEDURE sync_security_indicator_series_for_indicator(
    p_security_id INTEGER,
    p_indicator_id INTEGER,
    p_timeframe_id INTEGER,
    p_end_dt TIMESTAMP DEFAULT NULL,
    p_point_count INTEGER DEFAULT NULL,
    p_incremental BOOLEAN DEFAULT TRUE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_id INTEGER;
BEGIN
    FOR v_id IN
        SELECT id FROM security_indicator_series
        WHERE security_id = p_security_id
          AND indicator_id = p_indicator_id
          AND is_active = TRUE
        ORDER BY display_order, id
    LOOP
        CALL sync_security_indicator_series(
            v_id, p_timeframe_id, p_end_dt, p_point_count, p_incremental
        );
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE sync_security_indicator_series_for_indicator IS
'Пересчёт только серий указанного индикатора на бумаге (фоновый sync после drag-and-drop).';

-- Синхронизация всех серий бумаги
CREATE OR REPLACE PROCEDURE sync_security_indicator_series_all(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_end_dt TIMESTAMP DEFAULT NULL,
    p_point_count INTEGER DEFAULT NULL,
    p_incremental BOOLEAN DEFAULT TRUE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_id INTEGER;
BEGIN
    FOR v_id IN
        SELECT id FROM security_indicator_series
        WHERE security_id = p_security_id AND is_active = TRUE
        ORDER BY display_order, id
    LOOP
        CALL sync_security_indicator_series(v_id, p_timeframe_id, p_end_dt, p_point_count, p_incremental);
    END LOOP;
END;
$$;

-- ============================================
-- Процедура: refresh_indicator_values
-- Пересчет индикаторов для свежих цен
-- ============================================
CREATE OR REPLACE PROCEDURE refresh_indicator_values(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_script TEXT;
    v_indicator_code VARCHAR(20);
    v_date_from DATE;
    v_date_to DATE;
BEGIN
    SELECT code, script INTO v_indicator_code, v_script
    FROM indicators WHERE id = p_indicator_id;

    IF NOT FOUND THEN
        RAISE NOTICE 'Индикатор id=% не найден', p_indicator_id;
        RETURN;
    END IF;

    IF v_script IS NULL OR TRIM(v_script) = '' THEN
        RAISE NOTICE 'Скрипт для индикатора % не заполнен', v_indicator_code;
        RETURN;
    END IF;

    v_date_to := CURRENT_DATE;
    v_date_from := (CURRENT_DATE - INTERVAL '30 days')::DATE;

    RAISE NOTICE 'Пересчёт индикатора % по script за % — %', v_indicator_code, v_date_from, v_date_to;

    CALL calculate_indicator(
        p_security_id,
        p_timeframe_id,
        p_indicator_id,
        v_date_from,
        v_date_to,
        TRUE
    );

EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Ошибка пересчёта индикатора %: %', v_indicator_code, SQLERRM;
END;
$$;

COMMENT ON PROCEDURE refresh_indicator_values(INTEGER, INTEGER, INTEGER) IS 
'Пересчитывает значения индикатора для свежих цен через indicators.script и calculate_indicator.';


-- ============================================
-- Процедура: calculate_indicator
-- Расчет значений индикатора и запись в таблицу indicator_values
-- ============================================
-- ============================================
-- Процедура: calculate_indicator
-- Расчет значений технического индикатора и запись в таблицу indicator_values
-- ============================================
--
-- ПАРАМЕТРЫ:
--   p_security_id   INTEGER  - ID ценной бумаги из таблицы securities
--                              (например: 1 = SBER, 3 = GAZP, 35 = Si фьючерс)
--   p_timeframe_id   INTEGER  - ID таймфрейма из таблицы timeframes
--                              (например: 4 = M5, 15 = D1, 22 = MN1)
--   p_indicator_id   INTEGER  - ID индикатора из таблицы indicators
--                              (например: 4 = RSI, 5 = MACD, 7 = BB)
--   p_date_from      DATE     - Начальная дата периода расчета (включительно)
--   p_date_to        DATE     - Конечная дата периода расчета (включительно)
--   p_overwrite      BOOLEAN  - Флаг перезаписи существующих записей:
--                              TRUE  = удалить старые значения и записать новые
--                              FALSE = пропустить свечи, где значения уже есть
--
-- ПОДДЕРЖИВАЕМЫЕ ИНДИКАТОРЫ:
--   RSI      - Индекс относительной силы (0-100), период по умолчанию 14
--   SMA      - Простое скользящее среднее, период по умолчанию 20
--   EMA      - Экспоненциальное скользящее среднее, период по умолчанию 20
--   MACD     - Схождение/расхождение MA (fast=12, slow=26, signal=9)
--   BB       - Полосы Боллинджера (период=20, std_dev=2.0)
--   ATR      - Средний истинный диапазон, период по умолчанию 14
--   STOCH    - Стохастик (%K период=14, %D период=3, сглаживание=3)
--
-- ПРИМЕР ВЫЗОВА:
--   CALL calculate_indicator(1, 4, 4, '2026-06-17', '2026-06-24', TRUE);
--   -- Расчет RSI для SBER (id=1) на M5 (id=4) за неделю с перезаписью
-- ============================================
CREATE OR REPLACE PROCEDURE calculate_indicator(
    p_security_id INTEGER,           -- ID бумаги (ссылка на securities.id)
    p_timeframe_id INTEGER,          -- ID таймфрейма (ссылка на timeframes.id)
    p_indicator_id INTEGER,          -- ID индикатора (ссылка на indicators.id)
    p_date_from DATE,                -- Начало периода расчета (YYYY-MM-DD)
    p_date_to DATE,                  -- Конец периода расчета (YYYY-MM-DD)
    p_overwrite BOOLEAN DEFAULT FALSE -- Перезаписывать существующие записи?
)
LANGUAGE plpgsql AS $$
DECLARE
    -- ============================================================
    -- ПЕРЕМЕННЫЕ ИНФОРМАЦИИ ОБ ИНДИКАТОРЕ
    -- ============================================================
    v_indicator_code VARCHAR(20);    -- Код индикатора (RSI, MACD, BB и т.д.)
    v_indicator_name VARCHAR(100);   -- Полное имя индикатора
    v_indicator_category VARCHAR(50);-- Категория: trend, momentum, volatility, volume
    v_script TEXT;                   -- Шаблон indicators.script → EXECUTE (calc_ind_* + :series)

    -- ============================================================
    -- ПАРАМЕТРЫ ИНДИКАТОРА (загружаются из parameter_values или берутся по умолчанию)
    -- ============================================================
    v_period INTEGER := 14;          -- Основной период (для RSI, SMA, EMA, ATR, STOCH)
    v_fast_period INTEGER := 12;     -- Период быстрой линии (только для MACD)
    v_slow_period INTEGER := 26;     -- Период медленной линии (только для MACD)
    v_signal_period INTEGER := 9;    -- Период сигнальной линии (MACD, STOCH)
    v_std_dev NUMERIC := 2.0;        -- Количество стандартных отклонений (только для BB)
    v_k_period INTEGER := 14;        -- Период %K линии (только для Stochastic)
    v_d_period INTEGER := 3;         -- Период %D линии (только для Stochastic)
    v_smooth INTEGER := 3;           -- Период сглаживания (только для Stochastic)

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА RSI
    -- ============================================================
    v_gain NUMERIC(18,6) := 0;       -- Сумма положительных изменений цены
    v_loss NUMERIC(18,6) := 0;       -- Сумма отрицательных изменений цены
    v_avg_gain NUMERIC(18,6) := 0;   -- Средний прирост за период
    v_avg_loss NUMERIC(18,6) := 0;   -- Средняя потеря за период
    v_rsi NUMERIC(18,6);             -- Итоговое значение RSI (0-100)
    v_rs NUMERIC(18,6);              -- Отношение avg_gain / avg_loss

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА SMA / EMA
    -- ============================================================
    v_sma NUMERIC(18,6);             -- Значение простого скользящего среднего
    v_ema NUMERIC(18,6);             -- Значение экспоненциального скользящего среднего
    v_ema_prev NUMERIC(18,6);        -- Предыдущее значение EMA (для рекурсии)
    v_multiplier NUMERIC(18,6);    -- Множитель сглаживания EMA = 2/(period+1)
    v_sum NUMERIC(18,6) := 0;        -- Аккумулятор суммы (для SMA)
    v_count INTEGER := 0;            -- Счетчик итераций

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА BOLLINGER BANDS
    -- ============================================================
    v_bb_middle NUMERIC(18,6);       -- Средняя полоса (SMA)
    v_bb_upper NUMERIC(18,6);        -- Верхняя полоса (SMA + k*σ)
    v_bb_lower NUMERIC(18,6);        -- Нижняя полоса (SMA - k*σ)
    v_bb_stddev NUMERIC(18,6);       -- Стандартное отклонение
    v_bb_sum_sq NUMERIC(18,6) := 0;  -- Сумма квадратов отклонений (для σ)

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА MACD
    -- ============================================================
    v_ema_fast NUMERIC(18,6);        -- Быстрая EMA (период 12)
    v_ema_slow NUMERIC(18,6);        -- Медленная EMA (период 26)
    v_macd NUMERIC(18,6);            -- Линия MACD = EMA_fast - EMA_slow
    v_macd_signal NUMERIC(18,6);     -- Сигнальная линия (EMA от MACD, период 9)
    v_macd_histogram NUMERIC(18,6);  -- Гистограмма = MACD - Signal
    v_mult_fast NUMERIC(18,6);       -- Множитель быстрой EMA = 2/(12+1)
    v_mult_slow NUMERIC(18,6);       -- Множитель медленной EMA = 2/(26+1)
    v_mult_signal NUMERIC(18,6);     -- Множитель сигнальной EMA = 2/(9+1)

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА STOCHASTIC
    -- ============================================================
    v_stoch_k NUMERIC(18,6);         -- %K линия = (Close - Low) / (High - Low) * 100
    v_stoch_d NUMERIC(18,6);         -- %D линия = SMA(%K, 3)
    v_stoch_j NUMERIC(18,6);         -- J линия = 3K - 2D (не используется)
    v_lowest_low NUMERIC(18,6);      -- Минимум low за период %K
    v_highest_high NUMERIC(18,6);    -- Максимум high за период %K
    v_k_sum NUMERIC(18,6) := 0;      -- Аккумулятор для SMA %K
    v_k_count INTEGER := 0;          -- Счетчик для SMA %K

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАСЧЕТА ATR
    -- ============================================================
    v_atr NUMERIC(18,6);             -- Текущее значение ATR
    v_atr_prev NUMERIC(18,6);        -- Предыдущее значение ATR (для Wilder's smoothing)
    v_tr NUMERIC(18,6);              -- True Range = max(High-Low, |High-Close_prev|, |Low-Close_prev|)
    v_tr_high NUMERIC(18,6);         -- High - Low (компонент TR)
    v_tr_low NUMERIC(18,6);          -- |High - Close_prev| (компонент TR)
    v_tr_close NUMERIC(18,6);        -- |Low - Close_prev| (компонент TR)

    -- ============================================================
    -- ПОРОГОВЫЕ ЗНАЧЕНИЯ (загружаются из indicator_value_types.threshold_value)
    -- ============================================================
    v_overbought NUMERIC(18,6) := 70;-- Порог перекупленности (RSI=70, STOCH=80)
    v_oversold NUMERIC(18,6) := 30;  -- Порог перепроданности (RSI=30, STOCH=20)
    v_neutral NUMERIC(18,6) := 50;  -- Нейтральный уровень

    -- ============================================================
    -- СЧЕТЧИКИ РЕЗУЛЬТАТОВ ОПЕРАЦИЙ
    -- ============================================================
    v_records_inserted INTEGER := 0; -- Количество вставленных новых записей
    v_records_updated INTEGER := 0;  -- Количество обновленных записей (при overwrite=TRUE)
    v_records_skipped INTEGER := 0;  -- Количество пропущенных записей (при overwrite=FALSE)
    v_dt TIMESTAMP;                  -- Текущая дата/время свечи

    -- ============================================================
    -- КУРСОР ДЛЯ ЗАГРУЗКИ ЦЕНОВЫХ ДАННЫХ
    -- ============================================================
    -- Загружаем OHLCV из таблицы prices для указанной бумаги, таймфрейма и периода
    cur_prices CURSOR(p_sec INTEGER, p_tf INTEGER, p_from TIMESTAMP, p_to TIMESTAMP) FOR
        SELECT dt, open_price, high_price, low_price, close_price, volume
        FROM prices
        WHERE security_id = p_sec AND timeframe_id = p_tf
          AND dt >= p_from AND dt <= p_to
        ORDER BY dt;

    -- ============================================================
    -- МАССИВЫ ДЛЯ ХРАНЕНИЯ ЦЕНОВЫХ ДАННЫХ В ПАМЯТИ
    -- ============================================================
    -- Загружаем все цены в массивы для быстрого доступа по индексу
    -- Это быстрее, чем многократные обращения к курсору
    v_closes NUMERIC(18,6)[];      -- Массив цен закрытия
    v_highs NUMERIC(18,6)[];       -- Массив максимальных цен
    v_lows NUMERIC(18,6)[];        -- Массив минимальных цен
    v_dts TIMESTAMP[];             -- Массив дат/времени свечей
    v_idx INTEGER := 0;            -- Текущий индекс в массивах (количество свечей)

    -- ============================================================
    -- ПЕРЕМЕННЫЕ ДЛЯ РАБОТЫ С ТИПАМИ ЗНАЧЕНИЙ ИНДИКАТОРА
    -- ============================================================
    v_value_type_id INTEGER;       -- ID типа значения из indicator_value_types.id
    v_value_type_code VARCHAR(20);   -- Код типа значения (RSI, K, D, UPPER и т.д.)

    -- ============================================================
    -- ПЕРЕМЕННАЯ ДЛЯ ПРОВЕРКИ СУЩЕСТВОВАНИЯ ЗАПИСИ
    -- ============================================================
    v_existing_count INTEGER;        -- Количество существующих записей (0 или 1)
    v_price RECORD;                  -- Строка курсора цен
    v_load_from TIMESTAMP;           -- Начало загрузки цен (прогрев до date_from)
BEGIN
    -- ============================================================
    -- БЛОК 1: ЗАГРУЗКА ИНФОРМАЦИИ ОБ ИНДИКАТОРЕ
    -- ============================================================
    -- Получаем код, имя, категорию и SQL-скрипт индикатора из таблицы indicators
    -- Если индикатор не найден -- выбрасываем исключение
    SELECT code, name, category, script
    INTO v_indicator_code, v_indicator_name, v_indicator_category, v_script
    FROM indicators
    WHERE id = p_indicator_id;

    IF v_indicator_code IS NULL THEN
        RAISE EXCEPTION 'Индикатор с id=% не найден в таблице indicators', p_indicator_id;
    END IF;

    RAISE NOTICE '=== РАСЧЕТ ИНДИКАТОРА % ===', v_indicator_code;
    RAISE NOTICE 'Бумага: %, Таймфрейм: %, Период: % - %', 
        p_security_id, p_timeframe_id, p_date_from, p_date_to;

    -- ============================================================
    -- БЛОК 2: ЗАГРУЗКА ПАРАМЕТРОВ ИНДИКАТОРА
    -- ============================================================
    -- Пытаемся загрузить период из таблицы parameter_values
    -- Если параметр не найден -- используем значение по умолчанию
    BEGIN
        SELECT value::INTEGER INTO v_period
        FROM parameter_values pv
        JOIN parameter_types pt ON pv.parameter_type_id = pt.id
        WHERE pt.short_name = v_indicator_code || '_PERIOD'
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        -- Параметр не найден -- используем дефолтные значения по типу индикатора
        v_period := CASE v_indicator_code
            WHEN 'RSI' THEN 14
            WHEN 'SMA' THEN 20
            WHEN 'EMA' THEN 20
            WHEN 'BB' THEN 20
            WHEN 'ATR' THEN 14
            WHEN 'STOCH' THEN 14
            ELSE 14
        END;
    END;

    -- ============================================================
    -- БЛОК 3: УСТАНОВКА СПЕЦИФИЧНЫХ ПАРАМЕТРОВ ПО ТИПУ ИНДИКАТОРА
    -- ============================================================
    IF v_indicator_code = 'MACD' THEN
        -- MACD: fast=12, slow=26, signal=9 (стандартные параметры)
        v_fast_period := 12;
        v_slow_period := 26;
        v_signal_period := 9;
    ELSIF v_indicator_code = 'BB' THEN
        -- Bollinger Bands: std_dev = 2 (2 стандартных отклонения)
        v_std_dev := 2.0;
    ELSIF v_indicator_code = 'STOCH' THEN
        -- Stochastic: %K=14, %D=3, сглаживание=3
        v_k_period := 14;
        v_d_period := 3;
        v_smooth := 3;
    END IF;

    -- ============================================================
    -- БЛОК 4: ЗАГРУЗКА ЦЕНОВЫХ ДАННЫХ В МАССИВЫ (с прогревом до date_from)
    -- ============================================================
    SELECT COALESCE(
        (
            SELECT MIN(w.dt)
            FROM (
                SELECT dt
                FROM prices
                WHERE security_id = p_security_id
                  AND timeframe_id = p_timeframe_id
                  AND dt < p_date_from::TIMESTAMP
                ORDER BY dt DESC
                LIMIT GREATEST(v_period, v_k_period, 14) + 10
            ) w
        ),
        p_date_from::TIMESTAMP
    ) INTO v_load_from;

    FOR v_price IN
        SELECT dt, open_price, high_price, low_price, close_price, volume
        FROM prices
        WHERE security_id = p_security_id
          AND timeframe_id = p_timeframe_id
          AND dt >= v_load_from
          AND dt < (p_date_to + INTERVAL '1 day')::TIMESTAMP
        ORDER BY dt
    LOOP
        v_idx := v_idx + 1;
        v_closes[v_idx] := v_price.close_price;   -- Цена закрытия
        v_highs[v_idx] := v_price.high_price;     -- Максимальная цена
        v_lows[v_idx] := v_price.low_price;       -- Минимальная цена
        v_dts[v_idx] := v_price.dt;               -- Дата/время свечи
    END LOOP;

    -- ============================================================
    -- БЛОК 5: ПРОВЕРКА ДОСТАТОЧНОСТИ ДАННЫХ
    -- ============================================================
    -- Если свечей меньше, чем период индикатора -- расчет невозможен
    IF v_idx < v_period THEN
        RAISE NOTICE 'Недостаточно данных: загружено % свечей, нужно минимум % для периода %', 
            v_idx, v_period, v_indicator_code;
        RETURN;  -- Выходим из процедуры
    END IF;

    RAISE NOTICE 'Загружено % свечей для расчета индикатора %', v_idx, v_indicator_code;

    -- ============================================================
    -- БЛОК 5.1: РАСЧЁТ ПО ШАБЛОНУ indicators.script (EXECUTE)
    -- ============================================================
    -- Для RSI/SMA/EMA/MACD/BB/ATR/STOCH — inline O(n); via_script вызывает calc_ind_*
    -- на каждую свечу и сканирует всю историю → зависание на длинных рядах.
    IF COALESCE(TRIM(v_script), '') <> ''
       AND v_indicator_code NOT IN ('RSI', 'SMA', 'EMA', 'MACD', 'BB', 'ATR', 'STOCH') THEN
        EXECUTE 'CALL calculate_indicator_via_script($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)'
        USING p_security_id, p_timeframe_id, p_indicator_id,
              p_date_from, p_date_to, p_overwrite, v_script,
              v_period, v_fast_period, v_slow_period, v_signal_period,
              v_std_dev, v_k_period, v_d_period, v_smooth;
        RETURN;
    END IF;

    -- ============================================================
    -- БЛОК 6: РАСЧЕТ ИНДИКАТОРА (ветвление по типу, legacy)
    -- ============================================================

    -- ==========================================
    -- 6.1 РАСЧЕТ RSI (Relative Strength Index)
    -- ==========================================
    -- Формула: RSI = 100 - (100 / (1 + RS))
    -- Где RS = средний прирост / средняя потеря за период
    -- Значение от 0 до 100. >70 = перекупленность, <30 = перепроданность
    IF v_indicator_code = 'RSI' THEN

        -- Загружаем пороговые значения из indicator_value_types
        -- OVERBOUGHT (по умолчанию 70), OVERSOLD (по умолчанию 30), NEUTRAL (50)
        FOREACH v_value_type_code IN ARRAY ARRAY['RSI', 'OVERBOUGHT', 'OVERSOLD', 'NEUTRAL']::VARCHAR(20)[]
        LOOP
            SELECT id INTO v_value_type_id
            FROM indicator_value_types
            WHERE indicator_id = p_indicator_id AND code = v_value_type_code;

            IF v_value_type_id IS NULL THEN
                RAISE NOTICE 'Тип значения % не найден для индикатора RSI', v_value_type_code;
                CONTINUE;
            END IF;

            -- Сохраняем пороговые значения для последующей проверки сигналов
            IF v_value_type_code = 'OVERBOUGHT' THEN
                v_overbought := COALESCE((SELECT threshold_value FROM indicator_value_types WHERE id = v_value_type_id), 70);
            ELSIF v_value_type_code = 'OVERSOLD' THEN
                v_oversold := COALESCE((SELECT threshold_value FROM indicator_value_types WHERE id = v_value_type_id), 30);
            ELSIF v_value_type_code = 'NEUTRAL' THEN
                v_neutral := COALESCE((SELECT threshold_value FROM indicator_value_types WHERE id = v_value_type_id), 50);
            END IF;
        END LOOP;

        -- Основной цикл расчета RSI для каждой свечи, начиная с (period+1)
        FOR i IN v_period + 1 .. v_idx
        LOOP
            -- Сброс аккумуляторов прироста и потерь
            v_gain := 0;
            v_loss := 0;

            -- Суммируем приросты и потери за период
            FOR j IN i - v_period + 1 .. i
            LOOP
                IF v_closes[j] > v_closes[j - 1] THEN
                    -- Цена выросла -- добавляем прирост
                    v_gain := v_gain + (v_closes[j] - v_closes[j - 1]);
                ELSE
                    -- Цена упала -- добавляем потерю
                    v_loss := v_loss + (v_closes[j - 1] - v_closes[j]);
                END IF;
            END LOOP;

            -- Средние прирост и потеря
            v_avg_gain := v_gain / v_period;
            v_avg_loss := v_loss / v_period;

            -- Расчет RS и RSI
            IF v_avg_loss = 0 THEN
                v_rsi := 100;  -- Если потерь нет -- RSI = 100 (максимум)
            ELSE
                v_rs := v_avg_gain / v_avg_loss;
                v_rsi := 100 - (100 / (1 + v_rs));
            END IF;

            v_dt := v_dts[i];

            -- ============================================================
            -- БЛОК 6.1.1: ЗАПИСЬ ЗНАЧЕНИЯ RSI В БАЗУ
            -- ============================================================
            SELECT id INTO v_value_type_id
            FROM indicator_value_types
            WHERE indicator_id = p_indicator_id AND code = 'RSI';

            IF v_value_type_id IS NOT NULL THEN
                -- Проверяем, есть ли уже запись для этой свечи
                SELECT COUNT(*) INTO v_existing_count
                FROM indicator_values
                WHERE indicator_id = p_indicator_id
                  AND indicator_value_type_id = v_value_type_id
                  AND security_id = p_security_id
                  AND timeframe_id = p_timeframe_id
                  AND dt = v_dt;

                -- Если запись есть и overwrite=FALSE -- пропускаем
                IF v_existing_count > 0 AND NOT p_overwrite THEN
                    v_records_skipped := v_records_skipped + 1;
                ELSE
                    -- Удаляем старую запись, если overwrite=TRUE
                    IF v_existing_count > 0 THEN
                        DELETE FROM indicator_values
                        WHERE indicator_id = p_indicator_id
                          AND indicator_value_type_id = v_value_type_id
                          AND security_id = p_security_id
                          AND timeframe_id = p_timeframe_id
                          AND dt = v_dt;
                        v_records_updated := v_records_updated + 1;
                    ELSE
                        v_records_inserted := v_records_inserted + 1;
                    END IF;

                    -- Вставляем новое значение RSI
                    INSERT INTO indicator_values (indicator_id, indicator_value_type_id, security_id, timeframe_id, dt, value)
                    VALUES (p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_rsi);
                END IF;
            END IF;

            -- ============================================================
            -- БЛОК 6.1.2: ПРОВЕРКА ПОРОГОВЫХ ЗНАЧЕНИЙ И СИГНАЛОВ
            -- ============================================================
            -- Если RSI >= overbought -- создаем сигнал перекупленности
            IF v_rsi >= v_overbought THEN
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'OVERBOUGHT';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_overbought, p_overwrite);
                END IF;
            -- Если RSI <= oversold -- создаем сигнал перепроданности
            ELSIF v_rsi <= v_oversold THEN
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'OVERSOLD';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_oversold, p_overwrite);
                END IF;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.2 РАСЧЕТ SMA (Simple Moving Average)
    -- ==========================================
    -- Формула: SMA = сумма(close, period) / period
    -- Простое среднее арифметическое цен закрытия за период
    ELSIF v_indicator_code = 'SMA' THEN
        -- Цикл по всем свечам, начиная с периода
        FOR i IN v_period .. v_idx
        LOOP
            -- Суммируем цены закрытия за период
            v_sum := 0;
            FOR j IN i - v_period + 1 .. i
            LOOP
                v_sum := v_sum + v_closes[j];
            END LOOP;
            v_sma := v_sum / v_period;  -- Делим на количество свечей
            v_dt := v_dts[i];

            -- Записываем значение SMA
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'VALUE';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_sma, p_overwrite);
                v_records_inserted := v_records_inserted + 1;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.3 РАСЧЕТ EMA (Exponential Moving Average)
    -- ==========================================
    -- Формула: EMA(today) = (Close(today) - EMA(yesterday)) * multiplier + EMA(yesterday)
    -- Где multiplier = 2 / (period + 1)
    -- Первое EMA = SMA за период
    ELSIF v_indicator_code = 'EMA' THEN
        -- Множитель сглаживания: 2/(N+1)
        v_multiplier := 2.0 / (v_period + 1);

        -- Расчет начального SMA (первое EMA = SMA)
        v_sum := 0;
        FOR j IN 1 .. v_period
        LOOP
            v_sum := v_sum + v_closes[j];
        END LOOP;
        v_ema := v_sum / v_period;

        -- Основной цикл расчета EMA
        FOR i IN v_period .. v_idx
        LOOP
            -- Если не первая точка -- применяем формулу EMA
            IF i > v_period THEN
                v_ema := (v_closes[i] - v_ema) * v_multiplier + v_ema;
            END IF;
            v_dt := v_dts[i];

            -- Записываем значение EMA
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'VALUE';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_ema, p_overwrite);
                v_records_inserted := v_records_inserted + 1;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.4 РАСЧЕТ MACD
    -- ==========================================
    -- MACD Line = EMA(12) - EMA(26)
    -- Signal Line = EMA(9) от MACD Line
    -- Histogram = MACD Line - Signal Line
    ELSIF v_indicator_code = 'MACD' THEN
        -- Множители для EMA
        v_mult_fast := 2.0 / (v_fast_period + 1);
        v_mult_slow := 2.0 / (v_slow_period + 1);
        v_mult_signal := 2.0 / (v_signal_period + 1);

        -- Начальные EMA (первые значения = SMA)
        v_sum := 0;
        FOR j IN 1 .. v_fast_period LOOP v_sum := v_sum + v_closes[j]; END LOOP;
        v_ema_fast := v_sum / v_fast_period;

        v_sum := 0;
        FOR j IN 1 .. v_slow_period LOOP v_sum := v_sum + v_closes[j]; END LOOP;
        v_ema_slow := v_sum / v_slow_period;

        v_macd_signal := 0;

        -- Основной цикл расчета MACD
        FOR i IN GREATEST(v_fast_period, v_slow_period) .. v_idx
        LOOP
            -- Обновляем быструю EMA (период 12)
            IF i > v_fast_period THEN
                v_ema_fast := (v_closes[i] - v_ema_fast) * v_mult_fast + v_ema_fast;
            END IF;
            -- Обновляем медленную EMA (период 26)
            IF i > v_slow_period THEN
                v_ema_slow := (v_closes[i] - v_ema_slow) * v_mult_slow + v_ema_slow;
            END IF;

            -- Линия MACD = разница EMA
            v_macd := v_ema_fast - v_ema_slow;

            -- Сигнальная линия = EMA(9) от MACD
            IF i = GREATEST(v_fast_period, v_slow_period) THEN
                v_macd_signal := v_macd;  -- Первое значение = MACD
            ELSE
                v_macd_signal := (v_macd - v_macd_signal) * v_mult_signal + v_macd_signal;
            END IF;

            -- Гистограмма = MACD - Signal
            v_macd_histogram := v_macd - v_macd_signal;
            v_dt := v_dts[i];

            -- Записываем MACD line
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'MACD';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_macd, p_overwrite);
            END IF;

            -- Записываем Signal line
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'SIGNAL';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_macd_signal, p_overwrite);
            END IF;

            -- Записываем Histogram
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'HISTOGRAM';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_macd_histogram, p_overwrite);
            END IF;

            -- Записываем нулевую линию (порог)
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'ZERO';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, 0, p_overwrite);
            END IF;

            v_records_inserted := v_records_inserted + 3;
        END LOOP;

    -- ==========================================
    -- 6.5 РАСЧЕТ BOLLINGER BANDS
    -- ==========================================
    -- Middle Band = SMA(period)
    -- Upper Band = SMA + (std_dev * σ)
    -- Lower Band = SMA - (std_dev * σ)
    -- Bandwidth = (Upper - Lower) / Middle
    ELSIF v_indicator_code = 'BB' THEN
        FOR i IN v_period .. v_idx
        LOOP
            -- Средняя полоса = SMA
            v_sum := 0;
            FOR j IN i - v_period + 1 .. i
            LOOP
                v_sum := v_sum + v_closes[j];
            END LOOP;
            v_bb_middle := v_sum / v_period;

            -- Стандартное отклонение
            v_bb_sum_sq := 0;
            FOR j IN i - v_period + 1 .. i
            LOOP
                v_bb_sum_sq := v_bb_sum_sq + POWER(v_closes[j] - v_bb_middle, 2);
            END LOOP;
            v_bb_stddev := SQRT(v_bb_sum_sq / v_period);

            -- Верхняя и нижняя полосы
            v_bb_upper := v_bb_middle + (v_std_dev * v_bb_stddev);
            v_bb_lower := v_bb_middle - (v_std_dev * v_bb_stddev);
            v_dt := v_dts[i];

            -- Записываем Upper band
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'UPPER';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_bb_upper, p_overwrite);
            END IF;

            -- Записываем Middle band
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'MIDDLE';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_bb_middle, p_overwrite);
            END IF;

            -- Записываем Lower band
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'LOWER';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_bb_lower, p_overwrite);
            END IF;

            -- Записываем Bandwidth
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'BANDWIDTH';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, (v_bb_upper - v_bb_lower) / v_bb_middle, p_overwrite);
            END IF;

            v_records_inserted := v_records_inserted + 4;
        END LOOP;

    -- ==========================================
    -- 6.6 РАСЧЕТ ATR (Average True Range)
    -- ==========================================
    -- TR = max(High - Low, |High - Close_prev|, |Low - Close_prev|)
    -- ATR = SMA(TR, period) или EMA(TR, period) -- здесь используется Wilder's smoothing
    ELSIF v_indicator_code = 'ATR' THEN
        v_atr := 0;

        FOR i IN 2 .. v_idx
        LOOP
            -- Вычисляем True Range
            v_tr_high := v_highs[i] - v_lows[i];                          -- High - Low
            v_tr_low := ABS(v_highs[i] - v_closes[i-1]);                  -- |High - Close_prev|
            v_tr_close := ABS(v_lows[i] - v_closes[i-1]);                 -- |Low - Close_prev|
            v_tr := GREATEST(v_tr_high, v_tr_low, v_tr_close);            -- Максимум из трех

            -- Wilder's smoothing: ATR = (ATR_prev * (N-1) + TR) / N
            IF i <= v_period THEN
                -- Накопление для первого ATR (простое среднее)
                v_atr := v_atr + v_tr;
                IF i = v_period THEN
                    v_atr := v_atr / v_period;  -- Первое значение = SMA
                END IF;
            ELSE
                -- Последующие значения -- Wilder's smoothing
                v_atr := (v_atr * (v_period - 1) + v_tr) / v_period;
            END IF;

            v_dt := v_dts[i];

            -- Записываем ATR (начиная с периода, только в запрошенном диапазоне)
            IF i >= v_period
               AND v_dts[i] >= p_date_from::TIMESTAMP
               AND v_dts[i] < (p_date_to + INTERVAL '1 day')::TIMESTAMP THEN
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'ATR';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_atr, p_overwrite);
                END IF;

                -- Записываем ATR в процентах от цены
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'ATR_PCT';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, (v_atr / v_closes[i]) * 100, p_overwrite);
                END IF;

                v_records_inserted := v_records_inserted + 2;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.7 РАСЧЕТ STOCHASTIC OSCILLATOR
    -- ==========================================
    -- %K = (Close - LowestLow) / (HighestHigh - LowestLow) * 100
    -- %D = SMA(%K, 3)
    -- J = 3K - 2D (не используется здесь)
    ELSIF v_indicator_code = 'STOCH' THEN
        FOR i IN v_k_period .. v_idx
        LOOP
            -- Находим минимум low и максимум high за период %K
            v_lowest_low := v_lows[i];
            v_highest_high := v_highs[i];

            FOR j IN i - v_k_period + 1 .. i
            LOOP
                IF v_lows[j] < v_lowest_low THEN v_lowest_low := v_lows[j]; END IF;
                IF v_highs[j] > v_highest_high THEN v_highest_high := v_highs[j]; END IF;
            END LOOP;

            -- Расчет %K
            IF v_highest_high - v_lowest_low = 0 THEN
                v_stoch_k := 50;  -- Если диапазон 0 -- нейтральное значение
            ELSE
                v_stoch_k := ((v_closes[i] - v_lowest_low) / (v_highest_high - v_lowest_low)) * 100;
            END IF;

            v_dt := v_dts[i];

            -- Записываем %K линию
            SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'K';
            IF v_value_type_id IS NOT NULL THEN
                PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_stoch_k, p_overwrite);
            END IF;

            -- Расчет %D (SMA от %K, период 3)
            IF i >= v_k_period + v_d_period - 1 THEN
                v_k_sum := 0;
                FOR j IN i - v_d_period + 1 .. i
                LOOP
                    -- Пересчитываем %K для каждой точки окна %D
                    v_lowest_low := v_lows[j];
                    v_highest_high := v_highs[j];
                    FOR m IN j - v_k_period + 1 .. j
                    LOOP
                        IF v_lows[m] < v_lowest_low THEN v_lowest_low := v_lows[m]; END IF;
                        IF v_highs[m] > v_highest_high THEN v_highest_high := v_highs[m]; END IF;
                    END LOOP;

                    IF v_highest_high - v_lowest_low = 0 THEN
                        v_k_sum := v_k_sum + 50;
                    ELSE
                        v_k_sum := v_k_sum + ((v_closes[j] - v_lowest_low) / (v_highest_high - v_lowest_low)) * 100;
                    END IF;
                END LOOP;
                v_stoch_d := v_k_sum / v_d_period;

                -- Записываем %D линию
                SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'D';
                IF v_value_type_id IS NOT NULL THEN
                    PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, v_stoch_d, p_overwrite);
                END IF;

                -- ============================================================
                -- БЛОК 6.7.1: ПРОВЕРКА ПОРОГОВЫХ СИГНАЛОВ СТОХАСТИКА
                -- ============================================================
                IF v_stoch_k >= 80 THEN
                    -- Перекупленность: %K >= 80
                    SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'OVERBOUGHT';
                    IF v_value_type_id IS NOT NULL THEN
                        PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, 80, p_overwrite);
                    END IF;
                ELSIF v_stoch_k <= 20 THEN
                    -- Перепроданность: %K <= 20
                    SELECT id INTO v_value_type_id FROM indicator_value_types WHERE indicator_id = p_indicator_id AND code = 'OVERSOLD';
                    IF v_value_type_id IS NOT NULL THEN
                        PERFORM insert_indicator_value(p_indicator_id, v_value_type_id, p_security_id, p_timeframe_id, v_dt, 20, p_overwrite);
                    END IF;
                END IF;

                v_records_inserted := v_records_inserted + 3;
            ELSE
                v_records_inserted := v_records_inserted + 1;
            END IF;
        END LOOP;

    -- ==========================================
    -- 6.8 НЕПОДДЕРЖИВАЕМЫЙ ИНДИКАТОР
    -- ==========================================
    ELSE
        RAISE NOTICE 'Расчет для индикатора % пока не реализован в данной процедуре', v_indicator_code;
    END IF;

    -- ============================================================
    -- БЛОК 7: ИТОГОВАЯ СТАТИСТИКА
    -- ============================================================
    RAISE NOTICE '=== РАСЧЕТ ЗАВЕРШЕН ===';
    RAISE NOTICE 'Индикатор: %, Бумага: %, Таймфрейм: %', v_indicator_code, p_security_id, p_timeframe_id;
    RAISE NOTICE 'Вставлено новых записей: %', v_records_inserted;
    RAISE NOTICE 'Обновлено существующих записей: %', v_records_updated;
    RAISE NOTICE 'Пропущено (уже существуют): %', v_records_skipped;

EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Ошибка расчета индикатора % (id=%): %', v_indicator_code, p_indicator_id, SQLERRM;
END;
$$;

-- ============================================
-- КОММЕНТАРИЙ К ПРОЦЕДУРЕ calculate_indicator
-- ============================================
COMMENT ON PROCEDURE calculate_indicator(INTEGER, INTEGER, INTEGER, DATE, DATE, BOOLEAN) IS 
'Рассчитывает значения технического индикатора для указанной бумаги, таймфрейма и периода.

ПАРАМЕТРЫ:
  p_security_id  - ID ценной бумаги (securities.id)
  p_timeframe_id - ID таймфрейма (timeframes.id)
  p_indicator_id - ID индикатора (indicators.id)
  p_date_from    - Начальная дата периода (YYYY-MM-DD)
  p_date_to      - Конечная дата периода (YYYY-MM-DD)
  p_overwrite    - TRUE = перезаписать существующие, FALSE = пропустить

ПОДДЕРЖИВАЕМЫЕ ИНДИКАТОРЫ:
  RSI   - Индекс относительной силы (период 14, пороги 70/30)
  SMA   - Простое скользящее среднее (период 20)
  EMA   - Экспоненциальное скользящее среднее (период 20)
  MACD  - Схождение/расхождение (fast=12, slow=26, signal=9)
  BB    - Полосы Боллинджера (период 20, std_dev=2.0)
  ATR   - Средний истинный диапазон (период 14)
  STOCH - Стохастик (%K=14, %D=3)

ПРИМЕРЫ ВЫЗОВА:
  CALL calculate_indicator(1, 4, 4, ''2026-06-17'', ''2026-06-24'', TRUE);
  -- RSI для SBER (id=1) на M5 (id=4) за неделю с перезаписью

  CALL calculate_indicator(3, 15, 5, ''2026-06-01'', ''2026-06-24'', FALSE);
  -- MACD для GAZP (id=3) на D1 (id=15), пропустить если есть
';

-- ============================================
-- Вспомогательная функция: insert_indicator_value
-- ============================================
-- Параметры:
--   p_indicator_id      - ID индикатора (indicators.id)
--   p_value_type_id     - ID типа значения (indicator_value_types.id)
--   p_security_id       - ID бумаги (securities.id)
--   p_timeframe_id      - ID таймфрейма (timeframes.id)
--   p_dt                - Дата/время свечи
--   p_value             - Значение индикатора
--   p_overwrite         - Перезаписать существующую запись?
-- ============================================
DROP FUNCTION IF EXISTS insert_indicator_value(INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC, BOOLEAN, VARCHAR, BOOLEAN);

CREATE OR REPLACE FUNCTION insert_indicator_value(
    p_indicator_id INTEGER,
    p_value_type_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_value NUMERIC(18,6),
    p_overwrite BOOLEAN
)
RETURNS VOID AS $$
BEGIN
    IF p_overwrite THEN
        INSERT INTO indicator_values (
            indicator_id, indicator_value_type_id, security_id, timeframe_id,
            dt, value
        ) VALUES (
            p_indicator_id, p_value_type_id, p_security_id, p_timeframe_id,
            p_dt, p_value
        )
        ON CONFLICT (indicator_id, indicator_value_type_id, security_id, timeframe_id, dt)
        DO UPDATE SET
            value = EXCLUDED.value;
    ELSE
        INSERT INTO indicator_values (
            indicator_id, indicator_value_type_id, security_id, timeframe_id,
            dt, value
        ) VALUES (
            p_indicator_id, p_value_type_id, p_security_id, p_timeframe_id,
            p_dt, p_value
        )
        ON CONFLICT (indicator_id, indicator_value_type_id, security_id, timeframe_id, dt)
        DO NOTHING;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Расчёт через indicators.script (EXECUTE)
CREATE OR REPLACE PROCEDURE calculate_indicator_via_script(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_overwrite BOOLEAN,
    p_script TEXT,
    p_period INTEGER,
    p_fast_period INTEGER,
    p_slow_period INTEGER,
    p_signal_period INTEGER,
    p_std_dev NUMERIC,
    p_k_period INTEGER,
    p_d_period INTEGER,
    p_smooth INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_value_type RECORD;
    v_dt TIMESTAMP;
    v_value NUMERIC;
    v_records_inserted INTEGER := 0;
    v_records_skipped INTEGER := 0;
BEGIN
    FOR v_dt IN
        SELECT dt
        FROM prices
        WHERE security_id = p_security_id
          AND timeframe_id = p_timeframe_id
          AND dt >= p_date_from::TIMESTAMP
          AND dt < (p_date_to + INTERVAL '1 day')::TIMESTAMP
        ORDER BY dt
    LOOP
        FOR v_value_type IN
            SELECT id, code, is_threshold
            FROM indicator_value_types
            WHERE indicator_id = p_indicator_id
              AND is_threshold = FALSE
            ORDER BY display_order, id
        LOOP
            v_value := exec_indicator_script(
                p_script, p_period, p_fast_period, p_slow_period, p_signal_period,
                p_std_dev, p_k_period, p_d_period, p_smooth, v_value_type.code,
                p_security_id, p_timeframe_id, v_dt, p_indicator_id
            );

            IF v_value IS NULL THEN
                CONTINUE;
            END IF;

            PERFORM insert_indicator_value(
                p_indicator_id,
                v_value_type.id,
                p_security_id,
                p_timeframe_id,
                v_dt,
                v_value,
                p_overwrite
            );
            v_records_inserted := v_records_inserted + 1;
        END LOOP;
    END LOOP;

    RAISE NOTICE 'calculate_indicator_via_script: записано % значений', v_records_inserted;
END;
$$;

COMMENT ON PROCEDURE calculate_indicator_via_script IS
'Расчёт индикатора по шаблону indicators.script (динамический EXECUTE, :series — код линии).';


-- ============================================
-- КОММЕНТАРИЙ К ФУНКЦИИ insert_indicator_value
-- ============================================
COMMENT ON FUNCTION insert_indicator_value(INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC, BOOLEAN) IS
'Вставка/обновление одного значения индикатора (UPSERT по уникальному индексу).';

-- ============================================
-- Процедура: calculate_all_indicators
-- ============================================
-- Параметры:
--   p_security_id  - ID ценной бумаги
--   p_timeframe_id - ID таймфрейма
--   p_date_from    - Начальная дата периода
--   p_date_to      - Конечная дата периода
--   p_overwrite    - Перезаписывать существующие записи?
-- ============================================
-- Рассчитывает ВСЕ активные индикаторы из таблицы indicators
-- для указанной бумаги, таймфрейма и периода.
-- Ошибки в расчете отдельных индикаторов не прерывают общий процесс.
-- ============================================
CREATE OR REPLACE PROCEDURE calculate_all_indicators(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_overwrite BOOLEAN DEFAULT FALSE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_indicator RECORD;  -- Курсор по активным индикаторам
BEGIN
    -- ============================================================
    -- БЛОК: ПЕРЕБОР ВСЕХ АКТИВНЫХ ИНДИКАТОРОВ
    -- ============================================================
    -- Выбираем все индикаторы где is_active = TRUE
    -- и по очереди вызываем для каждого calculate_indicator
    FOR v_indicator IN 
        SELECT id, code, name 
        FROM indicators 
        WHERE is_active = TRUE 
        ORDER BY id
    LOOP
        BEGIN
            -- Вызываем расчет для текущего индикатора
            CALL calculate_indicator(
                p_security_id,    -- Бумага
                p_timeframe_id,   -- Таймфрейм
                v_indicator.id,   -- ID индикатора
                p_date_from,      -- Начало периода
                p_date_to,        -- Конец периода
                p_overwrite       -- Флаг перезаписи
            );
            RAISE NOTICE 'Успешно рассчитан индикатор: % (%)', v_indicator.code, v_indicator.name;

        EXCEPTION
            WHEN OTHERS THEN
                -- Ошибка в одном индикаторе не прерывает расчет остальных
                RAISE NOTICE 'ОШИБКА расчета индикатора % (%): %', 
                    v_indicator.code, v_indicator.name, SQLERRM;
        END;
    END LOOP;

    RAISE NOTICE '=== Расчет всех индикаторов завершен ===';
END;
$$;

-- ============================================
-- КОММЕНТАРИЙ К ПРОЦЕДУРЕ calculate_all_indicators
-- ============================================
COMMENT ON PROCEDURE calculate_all_indicators(INTEGER, INTEGER, DATE, DATE, BOOLEAN) IS 
'Рассчитывает все активные индикаторы (indicators.is_active = TRUE) 
для указанной бумаги, таймфрейма и периода.

Перебирает все записи из таблицы indicators где is_active=TRUE
и вызывает для каждого calculate_indicator.

Ошибка в расчете одного индикатора НЕ прерывает расчет остальных.

ПРИМЕР:
  CALL calculate_all_indicators(1, 4, ''2026-06-17'', ''2026-06-24'', TRUE);
  -- Расчет ВСЕХ индикаторов для SBER на M5 за неделю';

-- ============================================
-- Процедура: calculate_indicators_batch
-- ============================================
-- Параметры:
--   p_security_ids - Массив ID бумаг (INTEGER[])
--   p_timeframe_id - ID таймфрейма
--   p_date_from    - Начальная дата периода
--   p_date_to      - Конечная дата периода
--   p_overwrite    - Перезаписывать существующие записи?
-- ============================================
-- Рассчитывает все индикаторы для массива бумаг.
-- Удобно для массового пересчета по портфелю.
-- ============================================
CREATE OR REPLACE PROCEDURE calculate_indicators_batch(
    p_security_ids INTEGER[],
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_overwrite BOOLEAN DEFAULT FALSE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_security_id INTEGER;  -- Текущая бумага из массива
BEGIN
    -- ============================================================
    -- БЛОК: ПЕРЕБОР ВСЕХ БУМАГ В МАССИВЕ
    -- ============================================================
    FOREACH v_security_id IN ARRAY p_security_ids
    LOOP
        BEGIN
            -- Вызываем расчет всех индикаторов для текущей бумаги
            CALL calculate_all_indicators(
                v_security_id,    -- Текущая бумага
                p_timeframe_id,   -- Таймфрейм
                p_date_from,      -- Начало периода
                p_date_to,        -- Конец периода
                p_overwrite       -- Флаг перезаписи
            );
            RAISE NOTICE 'Рассчитаны индикаторы для security_id=%', v_security_id;

        EXCEPTION
            WHEN OTHERS THEN
                -- Ошибка по одной бумаге не прерывает расчет остальных
                RAISE NOTICE 'ОШИБКА расчета для security_id=%: %', v_security_id, SQLERRM;
        END;
    END LOOP;

    RAISE NOTICE '=== Массовый расчет индикаторов завершен ===';
END;
$$;

-- ============================================
-- КОММЕНТАРИЙ К ПРОЦЕДУРЕ calculate_indicators_batch
-- ============================================
COMMENT ON PROCEDURE calculate_indicators_batch(INTEGER[], INTEGER, DATE, DATE, BOOLEAN) IS 
'Рассчитывает все активные индикаторы для массива бумаг.

Параметр p_security_ids -- массив ID из таблицы securities.

ПРИМЕР:
  CALL calculate_indicators_batch(ARRAY[1, 3, 4, 5], 4, ''2026-06-17'', ''2026-06-24'', FALSE);
  -- Расчет всех индикаторов для SBER, GAZP, LKOH, ROSN на M5';



-- ============================================
-- ЧАСТЬ B: HTTP-ЗАГРУЗКА (pgsql-http)
-- ============================================
--
-- СТОП. Перед выполнением команд ниже (CREATE EXTENSION и процедуры *_http)
-- расширение pgsql-http должно быть установлено на сервере PostgreSQL.
-- Краткая инструкция — в заголовке этого файла (шаг 2, раздел WINDOWS).
--
-- ================================================================
-- WINDOWS — установка pgsql-http (PostgreSQL 15, один раз)
-- ================================================================
--
--   1) Скачать:  https://www.postgresonline.com/downloads/pg15http_w64.zip
--   2) Распаковать в:  <репозиторий>\_tmp_http_ext\pg15http_w64\
--   3) От администратора выполнить:
--        .\scripts\install_pgsql_http.ps1
--      (копирует http.dll, http--*.sql, зависимости libcurl, перезапускает службу)
--   4) Проверить файлы:
--        C:\Program Files\PostgreSQL\15\lib\http.dll
--        C:\Program Files\PostgreSQL\15\share\extension\http.control
--   5) Далее — команды CREATE EXTENSION и процедуры в этом блоке.
--
-- ================================================================
-- LINUX / macOS — установка pgsql-http (сборка из исходников)
-- ================================================================
--
-- ШАГ 1: системные зависимости
--   Debian/Ubuntu:
--     sudo apt-get update
--     sudo apt-get install -y libcurl4-openssl-dev postgresql-server-dev-15
--   CentOS/RHEL/Fedora:
--     sudo yum install libcurl-devel postgresql-devel
--   macOS (Homebrew):
--     brew install curl postgresql
--
-- ШАГ 2: сборка
--   cd /tmp
--   git clone https://github.com/pramsey/pgsql-http.git
--   cd pgsql-http
--   make PG_CONFIG=/usr/lib/postgresql/15/bin/pg_config
--   sudo make install PG_CONFIG=/usr/lib/postgresql/15/bin/pg_config
--
-- ШАГ 3: проверка на диске
--   ls -la $(pg_config --sharedir)/extension/http*
--
-- ШАГ 4–5: CREATE EXTENSION и тест — см. команды ниже в этом блоке.
--
-- ================================================================
-- ПРОВЕРКА ПОСЛЕ CREATE EXTENSION http
-- ================================================================
--   SELECT extname, extversion FROM pg_extension WHERE extname = 'http';
--   SELECT status FROM http_get('https://httpbin.org/get');
--
-- ================================================================
-- БЕЗОПАСНОСТЬ (опционально)
-- ================================================================
--   ALTER SYSTEM SET http.whitelist = 'invest-public-api.tinkoff.ru,iss.moex.com';
--   SELECT pg_reload_conf();
--
-- ================================================================
-- ПЕРЕУСТАНОВКА
-- ================================================================
--   DROP EXTENSION http CASCADE;
--   Windows: удалить http.dll и http* из lib/ и share/extension/, перезапустить службу
--   Linux:   sudo rm $(pg_config --sharedir)/extension/http* $(pg_config --libdir)/http.so
--
-- ================================================================
-- Ниже: CREATE EXTENSION + процедуры load_*_http (часть B скрипта 02).
-- Если расширение не установлено — выполнение остановится на CREATE EXTENSION.
-- Закомментируйте блок до метки «КОНЕЦ ОПЦИОНАЛЬНОГО БЛОКА HTTP» или установите pgsql-http.
-- ================================================================

-- ============================================
-- Trade runner: оценка сигналов и logic_trades (PostgreSQL)
-- Вставляется в 02 перед @optional-pgcron-block
-- ============================================

CREATE OR REPLACE FUNCTION get_logic_param_text(p_logic_id INTEGER, p_param_key TEXT)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT lp.param_value
    FROM logic_params lp
    WHERE lp.logic_id = p_logic_id AND lp.param_key = p_param_key
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_logic_param_numeric(p_logic_id INTEGER, p_param_key TEXT, p_default NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_raw TEXT;
    v_num NUMERIC;
BEGIN
    v_raw := btrim(COALESCE(get_logic_param_text(p_logic_id, p_param_key), ''));
    IF v_raw = '' THEN
        RETURN p_default;
    END IF;
    v_num := replace(v_raw, ',', '.')::NUMERIC;
    IF v_num IS NULL THEN
        RETURN p_default;
    END IF;
    RETURN v_num;
END;
$$;

CREATE OR REPLACE FUNCTION logic_resolve_timeframe_id(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf TEXT;
    v_id INTEGER;
BEGIN
    v_tf := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'timeframe'), 'M15')));
    SELECT t.id INTO v_id
    FROM timeframes t
    WHERE upper(t.tf) = v_tf AND COALESCE(t.is_active, TRUE)
    ORDER BY t.sec
    LIMIT 1;
    IF v_id IS NULL THEN
        SELECT t.id INTO v_id FROM timeframes t WHERE upper(t.tf) = 'M15' LIMIT 1;
    END IF;
    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION logic_resolve_timeframe_id(INTEGER) IS
'timeframe_id из logic_params.timeframe (код TF, по умолчанию M15)';

CREATE OR REPLACE FUNCTION logic_last_closed_bar_dt(
    p_tf_sec INTEGER,
    p_at TIMESTAMP DEFAULT LOCALTIMESTAMP
)
RETURNS TIMESTAMP
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tz TEXT := current_setting('TimeZone');
    v_epoch NUMERIC;
    v_current_bar_start NUMERIC;
BEGIN
    IF p_tf_sec IS NULL OR p_tf_sec <= 0 THEN
        RETURN NULL;
    END IF;
    v_epoch := EXTRACT(EPOCH FROM (COALESCE(p_at, LOCALTIMESTAMP) AT TIME ZONE v_tz));
    v_current_bar_start := floor(v_epoch / p_tf_sec) * p_tf_sec;
    RETURN (to_timestamp(v_current_bar_start - p_tf_sec) AT TIME ZONE v_tz)::timestamp;
END;
$$;

COMMENT ON FUNCTION logic_last_closed_bar_dt(INTEGER, TIMESTAMP) IS
'Начало последней закрытой свечи (open time) для TF с периодом p_tf_sec секунд';

CREATE OR REPLACE FUNCTION logic_bar_data_at(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_series TEXT,
    p_bar_dt TIMESTAMP
)
RETURNS TABLE (bar_dt TIMESTAMP, ind_value NUMERIC, close_price NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf_sec INTEGER;
    v_ind_dt TIMESTAMP;
    v_ind_val NUMERIC;
    v_pp NUMERIC;
BEGIN
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;

    SELECT iv.dt, iv.value
    INTO v_ind_dt, v_ind_val
    FROM indicator_values iv
    JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
    WHERE iv.security_id = p_security_id
      AND iv.timeframe_id = p_timeframe_id
      AND iv.indicator_id = p_indicator_id
      AND upper(ivt.code) = upper(COALESCE(p_series, 'VALUE'))
      AND iv.dt = p_bar_dt
    LIMIT 1;

    IF v_ind_dt IS NULL AND v_tf_sec IS NOT NULL THEN
        SELECT iv.dt, iv.value
        INTO v_ind_dt, v_ind_val
        FROM indicator_values iv
        JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
        WHERE iv.security_id = p_security_id
          AND iv.timeframe_id = p_timeframe_id
          AND iv.indicator_id = p_indicator_id
          AND upper(ivt.code) = upper(COALESCE(p_series, 'VALUE'))
          AND iv.dt > p_bar_dt - make_interval(secs => v_tf_sec)
          AND iv.dt <= p_bar_dt
        ORDER BY iv.dt DESC
        LIMIT 1;
    END IF;

    IF v_ind_dt IS NULL THEN
        RETURN;
    END IF;

    SELECT p.close_price
    INTO v_pp
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt = v_ind_dt
    LIMIT 1;

    IF v_pp IS NULL THEN
        SELECT p.close_price
        INTO v_pp
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt <= v_ind_dt
        ORDER BY p.dt DESC
        LIMIT 1;
    END IF;

    IF v_pp IS NULL OR v_pp <= 0 THEN
        RETURN;
    END IF;

    bar_dt := v_ind_dt;
    ind_value := v_ind_val;
    close_price := v_pp;
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION logic_bar_data_at(INTEGER, INTEGER, INTEGER, TEXT, TIMESTAMP) IS
'Индикатор и close на конкретной закрытой свече (exact dt, затем fallback в пределах одного бара)';

CREATE OR REPLACE FUNCTION parse_signal_series(p_params TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_part TEXT;
    v_key TEXT;
    v_val TEXT;
BEGIN
    IF p_params IS NULL OR btrim(p_params) = '' THEN
        RETURN 'VALUE';
    END IF;
    FOREACH v_part IN ARRAY string_to_array(p_params, ',')
    LOOP
        v_part := btrim(v_part);
        IF position('=' IN v_part) > 0 THEN
            v_key := lower(btrim(split_part(v_part, '=', 1)));
            v_val := btrim(split_part(v_part, '=', 2));
            IF v_key = 'series' AND v_val <> '' THEN
                RETURN upper(v_val);
            END IF;
        END IF;
    END LOOP;
    RETURN 'VALUE';
END;
$$;

CREATE OR REPLACE FUNCTION evaluate_signal_condition(
    p_condition TEXT,
    p_pp NUMERIC,
    p_value NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_expr TEXT;
    v_left NUMERIC;
    v_right NUMERIC;
    v_op TEXT;
    v_m TEXT[];
BEGIN
    v_expr := btrim(COALESCE(p_condition, ''));
    IF v_expr = '' OR p_pp IS NULL OR p_value IS NULL THEN
        RETURN FALSE;
    END IF;
    IF p_pp IS NULL OR p_value IS NULL OR p_pp <= 0 THEN
        RETURN FALSE;
    END IF;

    v_expr := regexp_replace(v_expr, '\mpp\y', p_pp::TEXT, 'gi');
    v_expr := regexp_replace(v_expr, '\yVALUE\y', p_value::TEXT, 'gi');
    IF v_expr ~ '[A-Za-z_]' THEN
        RETURN FALSE;
    END IF;

    v_m := regexp_match(v_expr, '^\s*(-?\d+(?:\.\d+)?)\s*(>=|<=|<>|!=|=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$');
    IF v_m IS NULL THEN
        RETURN FALSE;
    END IF;

    v_left := v_m[1]::NUMERIC;
    v_op := v_m[2];
    v_right := v_m[3]::NUMERIC;

    CASE v_op
        WHEN '>' THEN RETURN v_left > v_right;
        WHEN '<' THEN RETURN v_left < v_right;
        WHEN '>=' THEN RETURN v_left >= v_right;
        WHEN '<=' THEN RETURN v_left <= v_right;
        WHEN '=' THEN RETURN v_left = v_right;
        WHEN '!=' THEN RETURN v_left <> v_right;
        WHEN '<>' THEN RETURN v_left <> v_right;
        ELSE RETURN FALSE;
    END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION parse_signal_formula(p_formula TEXT)
RETURNS TABLE (
    valid BOOLEAN,
    indicator_code TEXT,
    params TEXT,
    condition TEXT
)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_m TEXT[];
BEGIN
    valid := FALSE;
    indicator_code := NULL;
    params := NULL;
    condition := NULL;

    v_m := regexp_match(btrim(COALESCE(p_formula, '')), '^@([A-Za-z0-9_]+)\(([^)]*)\)\s+(.+)$', 'i');
    IF v_m IS NULL THEN
        RETURN NEXT;
        RETURN;
    END IF;

    valid := TRUE;
    indicator_code := upper(v_m[1]);
    params := btrim(v_m[2]);
    condition := btrim(v_m[3]);
    RETURN NEXT;
END;
$$;

-- @begin logic_stop_runner
-- ============================================
-- Stop-loss runner: security / security_resume / security_inversion / portfolio / portfolio_resume
-- ============================================

CREATE OR REPLACE FUNCTION logic_resolve_stop_timeframe_id(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf TEXT;
    v_id INTEGER;
BEGIN
    v_tf := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'stop_loss_timeframe'), 'M5')));
    SELECT t.id INTO v_id
    FROM timeframes t
    WHERE upper(t.tf) = v_tf AND COALESCE(t.is_active, TRUE)
    ORDER BY t.sec
    LIMIT 1;
    IF v_id IS NULL THEN
        SELECT t.id INTO v_id FROM timeframes t WHERE upper(t.tf) = 'M5' LIMIT 1;
    END IF;
    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION logic_resolve_stop_timeframe_id(INTEGER) IS
'timeframe_id из logic_params.stop_loss_timeframe (по умолчанию M5)';

CREATE OR REPLACE FUNCTION logic_long_position_qty(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE,
    p_is_test BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(COALESCE(SUM(
        CASE
            WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
            WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
            ELSE 0
        END
    ), 0), 0)
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    JOIN actions a ON a.id = lt.action_id
    WHERE lt.logic_id = p_logic_id
      AND lt.security_id = p_security_id
      AND lt.is_shadow = p_is_shadow
      AND lt.is_test = p_is_test
      AND lt.status IN ('filled', 'submitted');
$$;

CREATE OR REPLACE FUNCTION logic_short_position_qty(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE,
    p_is_test BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(COALESCE(SUM(
        CASE
            WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
            WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
            ELSE 0
        END
    ), 0), 0)
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    JOIN actions a ON a.id = lt.action_id
    WHERE lt.logic_id = p_logic_id
      AND lt.security_id = p_security_id
      AND lt.is_shadow = p_is_shadow
      AND lt.is_test = p_is_test
      AND lt.status IN ('filled', 'submitted');
$$;

CREATE OR REPLACE FUNCTION logic_count_open_positions(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT COUNT(*)::INTEGER FROM (
        SELECT lt.security_id
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND NOT lt.is_shadow
          AND NOT lt.is_test
          AND lt.status IN ('filled', 'submitted')
        GROUP BY lt.security_id
        HAVING COALESCE(SUM(
            CASE
                WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
                ELSE 0
            END
        ), 0) > 0
    ) q;
$$;

CREATE OR REPLACE FUNCTION logic_security_position_cost(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN,
    p_is_test BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_long_cost NUMERIC := 0;
    v_short_cost NUMERIC := 0;
    v_open RECORD;
    v_rem NUMERIC;
BEGIN
    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow, p_is_test);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow, p_is_test);

    IF v_long_qty > 0 THEN
        FOR v_open IN
            SELECT lt.id, lt.quantity, lt.price
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND lt.security_id = p_security_id
              AND lt.is_shadow = p_is_shadow
              AND lt.is_test = p_is_test
              AND s.name = 'Open' AND a.name = 'Long'
              AND lt.status IN ('filled', 'submitted')
            ORDER BY lt.executed_at ASC, lt.id ASC
        LOOP
            v_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_rem > 0 THEN
                v_long_cost := v_long_cost + v_rem * v_open.price;
            END IF;
        END LOOP;
    END IF;

    IF v_short_qty > 0 THEN
        FOR v_open IN
            SELECT lt.id, lt.quantity, lt.price
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND lt.security_id = p_security_id
              AND lt.is_shadow = p_is_shadow
              AND s.name = 'Open' AND a.name = 'Short'
              AND lt.status IN ('filled', 'submitted')
            ORDER BY lt.executed_at ASC, lt.id ASC
        LOOP
            v_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_rem > 0 THEN
                v_short_cost := v_short_cost + v_rem * v_open.price;
            END IF;
        END LOOP;
    END IF;

    RETURN COALESCE(v_long_cost, 0) + COALESCE(v_short_cost, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_security_position_market(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_price NUMERIC;
    v_market NUMERIC := 0;
BEGIN
    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, p_timeframe_id);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN NULL;
    END IF;
    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow);
    v_market := (COALESCE(v_long_qty, 0) + COALESCE(v_short_qty, 0)) * v_price;
    RETURN v_market;
END;
$$;

CREATE OR REPLACE FUNCTION logic_security_drawdown_pct(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cost NUMERIC;
    v_market NUMERIC;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_long_cost NUMERIC := 0;
    v_short_cost NUMERIC := 0;
    v_long_mkt NUMERIC := 0;
    v_short_mkt NUMERIC := 0;
    v_price NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
    v_loss NUMERIC := 0;
    v_base NUMERIC := 0;
BEGIN
    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, p_timeframe_id);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;

    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow);
    IF v_long_qty <= 0 AND v_short_qty <= 0 THEN
        RETURN 0;
    END IF;

    IF v_long_qty > 0 THEN
        FOR v_open IN
            SELECT lt.id, lt.price
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND lt.security_id = p_security_id
              AND lt.is_shadow = p_is_shadow
              AND s.name = 'Open' AND a.name = 'Long'
              AND lt.status IN ('filled', 'submitted')
        LOOP
            v_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_rem > 0 THEN
                v_long_cost := v_long_cost + v_rem * v_open.price;
                v_long_mkt := v_long_mkt + v_rem * v_price;
                IF v_open.price > v_price THEN
                    v_loss := v_loss + v_rem * (v_open.price - v_price);
                END IF;
                v_base := v_base + v_rem * v_open.price;
            END IF;
        END LOOP;
    END IF;

    IF v_short_qty > 0 THEN
        FOR v_open IN
            SELECT lt.id, lt.price
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND lt.security_id = p_security_id
              AND lt.is_shadow = p_is_shadow
              AND s.name = 'Open' AND a.name = 'Short'
              AND lt.status IN ('filled', 'submitted')
        LOOP
            v_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_rem > 0 THEN
                v_short_cost := v_short_cost + v_rem * v_open.price;
                IF v_price > v_open.price THEN
                    v_loss := v_loss + v_rem * (v_price - v_open.price);
                END IF;
                v_base := v_base + v_rem * v_open.price;
            END IF;
        END LOOP;
    END IF;

    IF v_base <= 0 THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(v_loss / v_base * 100.0, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_security_track_value(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_realized NUMERIC := 0;
    v_unrealized NUMERIC := 0;
    v_price NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
BEGIN
    SELECT COALESCE(SUM(lt.financial_result), 0)
    INTO v_realized
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    WHERE lt.logic_id = p_logic_id
      AND lt.security_id = p_security_id
      AND lt.is_shadow = p_is_shadow
      AND s.name = 'Close'
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL;

    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, p_timeframe_id);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN v_realized;
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price, a.name AS action_name
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_shadow = p_is_shadow
          AND s.name = 'Open'
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        IF v_open.action_name = 'Long' THEN
            v_unrealized := v_unrealized + v_rem * (v_price - v_open.price);
        ELSE
            v_unrealized := v_unrealized + v_rem * (v_open.price - v_price);
        END IF;
    END LOOP;

    RETURN COALESCE(v_realized, 0) + COALESCE(v_unrealized, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_portfolio_equity(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cash NUMERIC;
    v_sec RECORD;
    v_price NUMERIC;
    v_long_qty NUMERIC;
    v_total NUMERIC := 0;
BEGIN
    v_cash := logic_ensure_balance(p_logic_id);
    v_total := COALESCE(v_cash, 0);

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        v_long_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE);
        IF v_long_qty <= 0 THEN
            CONTINUE;
        END IF;
        v_price := logic_ensure_security_market_price(p_logic_id, v_sec.security_id, p_timeframe_id);
        IF v_price IS NOT NULL AND v_price > 0 THEN
            v_total := v_total + v_long_qty * v_price;
        END IF;
    END LOOP;

    RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION logic_portfolio_drawdown_pct(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_initial NUMERIC;
    v_equity NUMERIC;
BEGIN
    v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', 0);
    IF v_initial IS NULL OR v_initial <= 0 THEN
        RETURN 0;
    END IF;
    v_equity := logic_portfolio_equity(p_logic_id, p_timeframe_id);
    IF v_equity IS NULL OR v_equity >= v_initial THEN
        RETURN 0;
    END IF;
    RETURN (v_initial - v_equity) / v_initial * 100.0;
END;
$$;

-- Пик equity (обновляется, пока нет portfolio_resume pause).
CREATE OR REPLACE FUNCTION logic_update_portfolio_equity_peak(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_equity NUMERIC;
    v_peak NUMERIC;
    v_initial NUMERIC;
    v_paused BOOLEAN;
BEGIN
    SELECT COALESCE(portfolio_trading_paused, FALSE), portfolio_equity_peak
    INTO v_paused, v_peak
    FROM logics
    WHERE id = p_logic_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_paused THEN
        RETURN v_peak;
    END IF;

    v_equity := logic_portfolio_equity(p_logic_id, p_timeframe_id);
    v_initial := COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0);
    IF v_peak IS NULL OR v_peak <= 0 THEN
        v_peak := GREATEST(COALESCE(v_equity, 0), v_initial, 0);
    ELSIF v_equity IS NOT NULL AND v_equity > v_peak THEN
        v_peak := v_equity;
    END IF;

    UPDATE logics
    SET portfolio_equity_peak = v_peak
    WHERE id = p_logic_id;

    RETURN v_peak;
END;
$$;

-- Просадка % от пика equity (для portfolio_resume).
CREATE OR REPLACE FUNCTION logic_portfolio_peak_drawdown_pct(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_peak NUMERIC;
    v_equity NUMERIC;
BEGIN
    v_peak := logic_update_portfolio_equity_peak(p_logic_id, p_timeframe_id);
    IF v_peak IS NULL OR v_peak <= 0 THEN
        RETURN 0;
    END IF;
    v_equity := logic_portfolio_equity(p_logic_id, p_timeframe_id);
    IF v_equity IS NULL OR v_equity >= v_peak THEN
        RETURN 0;
    END IF;
    RETURN (v_peak - v_equity) / v_peak * 100.0;
END;
$$;

-- Теневой track портфеля: sum(shadow financial_result) после паузы.
CREATE OR REPLACE FUNCTION logic_portfolio_shadow_pnl(p_logic_id INTEGER)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(lt.financial_result), 0)
    FROM logic_trades lt
    WHERE lt.logic_id = p_logic_id
      AND NOT lt.is_test
      AND lt.is_shadow = TRUE
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL;
$$;

DROP FUNCTION IF EXISTS logic_close_security_positions_market(INTEGER, INTEGER, BOOLEAN);

CREATE OR REPLACE FUNCTION logic_close_security_positions_market(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE,
    p_reason TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_result JSONB;
    v_closed INTEGER := 0;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_tf_id INTEGER;
    v_logic RECORD;
    v_balance NUMERIC;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_price NUMERIC;
    v_trade_id BIGINT;
    v_quantity INTEGER;
    v_bar_dt TIMESTAMP;
    v_formula TEXT;
    v_notional NUMERIC;
    v_is_simulated BOOLEAN;
    v_close_idx INTEGER := 0;
BEGIN
    -- Денежный фонд остаётся купленным: портфельный/бумажный SL не продаёт TMON/LQDT/SBMM.
    IF logic_is_cash_fund_security(p_security_id) THEN
        RETURN 0;
    END IF;

    v_formula := COALESCE(NULLIF(btrim(p_reason), ''), 'stop_loss:close');
    v_tf_id := logic_resolve_timeframe_id(p_logic_id);

    SELECT l.id, l.account_id, a.account_type
    INTO v_logic
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    v_balance := logic_ensure_balance(p_logic_id);
    v_is_simulated := v_logic.account_type = 'fake';
    v_price := logic_ensure_security_market_price(p_logic_id, p_security_id, v_tf_id);

    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;

    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow);

    IF v_long_qty > 0 THEN
        v_close_idx := v_close_idx + 1;
        v_bar_dt := clock_timestamp() + (v_close_idx * interval '1 millisecond');
        v_quantity := floor(v_long_qty)::INTEGER;
        IF v_quantity >= 1 THEN
            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, signal_kind, signal_formula,
                quantity, price, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                trade_reason, status
            )
            VALUES (
                p_logic_id, v_logic.account_id, p_security_id, v_tf_id,
                v_side_close_id, v_action_long_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE, p_is_shadow, FALSE,
                v_formula, 'filled'
            )
            RETURNING id INTO v_trade_id;

            IF NOT p_is_shadow AND v_is_simulated AND v_balance IS NOT NULL THEN
                v_balance := logic_trade_finalize(v_trade_id, v_balance);
                v_notional := v_quantity * v_price;
                v_balance := v_balance + v_notional;
                PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_balance::TEXT, 'money');
            ELSIF NOT p_is_shadow THEN
                PERFORM logic_trade_finalize(v_trade_id, v_balance);
            ELSE
                PERFORM logic_trade_finalize(v_trade_id, NULL);
            END IF;
            v_closed := v_closed + 1;
        END IF;
    END IF;

    IF v_short_qty > 0 THEN
        v_close_idx := v_close_idx + 1;
        v_bar_dt := clock_timestamp() + (v_close_idx * interval '1 millisecond');
        v_quantity := floor(v_short_qty)::INTEGER;
        IF v_quantity >= 1 THEN
            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, signal_kind, signal_formula,
                quantity, price, bar_dt, is_simulated, is_fictitious, is_shadow,
                trade_reason, status
            )
            VALUES (
                p_logic_id, v_logic.account_id, p_security_id, v_tf_id,
                v_side_close_id, v_action_short_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE, p_is_shadow,
                v_formula, 'filled'
            )
            RETURNING id INTO v_trade_id;

            IF NOT p_is_shadow AND v_is_simulated AND v_balance IS NOT NULL THEN
                v_balance := logic_trade_finalize(v_trade_id, v_balance);
                v_notional := v_quantity * v_price;
                v_balance := v_balance - v_notional;
                PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_balance::TEXT, 'money');
            ELSIF NOT p_is_shadow THEN
                PERFORM logic_trade_finalize(v_trade_id, v_balance);
            ELSE
                PERFORM logic_trade_finalize(v_trade_id, NULL);
            END IF;
            v_closed := v_closed + 1;
        END IF;
    END IF;

    RETURN v_closed;
END;
$$;

CREATE OR REPLACE FUNCTION logic_check_security_resume(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    v_ls RECORD;
    v_shadow_track NUMERIC;
    v_resumed BOOLEAN := FALSE;
BEGIN
    SELECT ls.real_trading_paused, ls.stop_resume_equity, ls.stop_resume_baseline
    INTO v_ls
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id
      AND ls.security_id = p_security_id;

    IF NOT FOUND OR NOT COALESCE(v_ls.real_trading_paused, FALSE) THEN
        RETURN FALSE;
    END IF;
    IF v_ls.stop_resume_equity IS NULL OR v_ls.stop_resume_baseline IS NULL THEN
        RETURN FALSE;
    END IF;

    v_shadow_track := logic_security_track_value(
        p_logic_id, p_security_id, p_timeframe_id, TRUE
    );

    IF COALESCE(v_ls.stop_resume_baseline, 0) + COALESCE(v_shadow_track, 0)
       >= COALESCE(v_ls.stop_resume_equity, 0) THEN
        UPDATE logic_securities
        SET real_trading_paused = FALSE,
            stop_resume_equity = NULL,
            stop_resume_baseline = NULL,
            stop_resume_triggered_at = NULL
        WHERE logic_id = p_logic_id
          AND security_id = p_security_id;

        PERFORM logic_trade_log(
            p_logic_id,
            'stop.resume',
            format(
                'Возобновление реальной торговли sec=%s (baseline=%s shadow=%s target=%s)',
                p_security_id,
                v_ls.stop_resume_baseline,
                v_shadow_track,
                v_ls.stop_resume_equity
            ),
            jsonb_build_object(
                'security_id', p_security_id,
                'baseline', v_ls.stop_resume_baseline,
                'shadow_track', v_shadow_track,
                'target', v_ls.stop_resume_equity
            ),
            p_security_id,
            p_timeframe_id
        );
        v_resumed := TRUE;
    END IF;

    RETURN v_resumed;
END;
$$;

CREATE OR REPLACE FUNCTION logic_check_portfolio_resume(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_shadow_pnl NUMERIC;
    v_track NUMERIC;
BEGIN
    SELECT
        COALESCE(portfolio_trading_paused, FALSE) AS paused,
        portfolio_stop_resume_equity AS target,
        portfolio_stop_resume_baseline AS baseline
    INTO v_logic
    FROM logics
    WHERE id = p_logic_id;

    IF NOT FOUND OR NOT v_logic.paused THEN
        RETURN FALSE;
    END IF;
    IF v_logic.target IS NULL OR v_logic.baseline IS NULL THEN
        RETURN FALSE;
    END IF;

    v_shadow_pnl := logic_portfolio_shadow_pnl(p_logic_id);
    v_track := COALESCE(v_logic.baseline, 0) + COALESCE(v_shadow_pnl, 0);

    IF v_track >= COALESCE(v_logic.target, 0) THEN
        UPDATE logics
        SET portfolio_trading_paused = FALSE,
            portfolio_stop_resume_equity = NULL,
            portfolio_stop_resume_baseline = NULL,
            portfolio_stop_resume_at = NULL,
            portfolio_equity_peak = GREATEST(
                COALESCE(portfolio_equity_peak, 0),
                COALESCE(v_logic.target, 0),
                COALESCE(v_track, 0)
            )
        WHERE id = p_logic_id;

        PERFORM logic_trade_log(
            p_logic_id,
            'stop.portfolio_resume',
            format(
                'Возобновление реальной торговли портфеля (baseline=%s shadow=%s track=%s target=%s)',
                v_logic.baseline, v_shadow_pnl, v_track, v_logic.target
            ),
            jsonb_build_object(
                'baseline', v_logic.baseline,
                'shadow_pnl', v_shadow_pnl,
                'track', v_track,
                'target', v_logic.target
            ),
            NULL,
            p_timeframe_id
        );
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$;

-- ============================================
-- Linear Take Profit on paper with renewal (security_ltp_renew)
-- Порог: track бумаги / initial_balance (%) >= base_annual_rate×годы + TP%
-- Взведение → продажа на падении цены → shadow → возобновление (как security_resume)
-- Сброс взведения при track% < линейной базы (без TP%)
-- ============================================

CREATE OR REPLACE FUNCTION logic_linear_elapsed_year_fraction(
    p_logic_id INTEGER,
    p_asof TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_start TIMESTAMP;
BEGIN
    SELECT MIN(lt.bar_dt)
    INTO v_start
    FROM logic_trades lt
    WHERE lt.logic_id = p_logic_id
      AND lt.is_test = COALESCE(p_is_test, FALSE)
      AND (p_run_id IS NULL OR lt.run_id = p_run_id)
      AND COALESCE(lt.is_shadow, FALSE) = FALSE
      AND lt.status IN ('filled', 'submitted');

    IF v_start IS NULL THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(
        0,
        EXTRACT(EPOCH FROM (COALESCE(p_asof, clock_timestamp()) - v_start))
            / (365.25 * 24 * 3600)
    );
END;
$$;

COMMENT ON FUNCTION logic_linear_elapsed_year_fraction(INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'Доля года с первой боевой/тестовой сделки логики (для линейного роста initial_balance).';

CREATE OR REPLACE FUNCTION logic_linear_base_pct(
    p_logic_id INTEGER,
    p_asof TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_rate NUMERIC;
    v_frac NUMERIC;
BEGIN
    v_rate := COALESCE(get_logic_param_numeric(p_logic_id, 'base_annual_rate_pct', 20), 20);
    IF v_rate < 0 THEN
        v_rate := 0;
    END IF;
    v_frac := logic_linear_elapsed_year_fraction(p_logic_id, p_asof, p_is_test, p_run_id);
    RETURN v_rate * v_frac;
END;
$$;

COMMENT ON FUNCTION logic_linear_base_pct(INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'Линейный % роста initial: base_annual_rate_pct × (дни сделок / 365.25).';

CREATE OR REPLACE FUNCTION logic_security_track_pct_of_initial(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_is_shadow BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_initial NUMERIC;
    v_track NUMERIC;
BEGIN
    v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', NULL);
    IF v_initial IS NULL OR v_initial <= 0 THEN
        RETURN NULL;
    END IF;
    v_track := logic_security_track_value(
        p_logic_id, p_security_id, p_timeframe_id, p_is_shadow
    );
    RETURN COALESCE(v_track, 0) / v_initial * 100.0;
END;
$$;

COMMENT ON FUNCTION logic_security_track_pct_of_initial(INTEGER, INTEGER, INTEGER, BOOLEAN) IS
'Трек бумаги (FINRES) в % от initial_balance логики (бой).';

-- Бой: один бар / одна бумага для security_ltp_renew
CREATE OR REPLACE FUNCTION logic_process_linear_tp_security(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_tp_extra_pct NUMERIC,
    p_bar_dt TIMESTAMP,
    p_price NUMERIC
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_ls RECORD;
    v_track_pct NUMERIC;
    v_base_pct NUMERIC;
    v_arm_pct NUMERIC;
    v_actions INTEGER := 0;
    v_closed INTEGER;
    v_track_before NUMERIC;
    v_track_after NUMERIC;
    v_has_pos BOOLEAN;
BEGIN
    IF logic_is_cash_fund_security(p_security_id) THEN
        RETURN 0;
    END IF;
    IF p_price IS NULL OR p_price <= 0 OR p_tp_extra_pct IS NULL OR p_tp_extra_pct <= 0 THEN
        RETURN 0;
    END IF;

    SELECT
        COALESCE(ls.real_trading_paused, FALSE) AS paused,
        COALESCE(ls.linear_tp_armed, FALSE) AS armed,
        ls.linear_tp_last_price,
        ls.linear_tp_arm_bar_dt
    INTO v_ls
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id AND ls.security_id = p_security_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- Пауза после продажи — возобновление уже в process_logic_stops
    IF v_ls.paused THEN
        RETURN 0;
    END IF;

    v_track_pct := logic_security_track_pct_of_initial(
        p_logic_id, p_security_id, p_timeframe_id, FALSE
    );
    IF v_track_pct IS NULL THEN
        RETURN 0;
    END IF;

    v_base_pct := logic_linear_base_pct(p_logic_id, p_bar_dt, FALSE, NULL);
    v_arm_pct := v_base_pct + p_tp_extra_pct;

    v_has_pos :=
        logic_long_position_qty(p_logic_id, p_security_id, FALSE, FALSE) > 0
        OR logic_short_position_qty(p_logic_id, p_security_id, FALSE, FALSE) > 0;

    -- Ниже линейной базы → полное снятие взведения (логика идёт дальше)
    IF v_track_pct < v_base_pct THEN
        IF v_ls.armed THEN
            UPDATE logic_securities
            SET linear_tp_armed = FALSE,
                linear_tp_last_price = NULL,
                linear_tp_arm_bar_dt = NULL
            WHERE logic_id = p_logic_id AND security_id = p_security_id;
            PERFORM logic_trade_log(
                p_logic_id, 'take_profit.linear.disarm',
                format(
                    'Линейный TP снят sec=%s: track%%=%s < base%%=%s',
                    p_security_id, round(v_track_pct, 4), round(v_base_pct, 4)
                ),
                jsonb_build_object(
                    'security_id', p_security_id,
                    'track_pct', v_track_pct,
                    'base_pct', v_base_pct,
                    'arm_pct', v_arm_pct
                ),
                p_security_id, p_timeframe_id
            );
            v_actions := v_actions + 1;
        END IF;
        RETURN v_actions;
    END IF;

    -- Взведение
    IF NOT v_ls.armed AND v_track_pct >= v_arm_pct AND v_has_pos THEN
        UPDATE logic_securities
        SET linear_tp_armed = TRUE,
            linear_tp_last_price = p_price,
            linear_tp_arm_bar_dt = p_bar_dt
        WHERE logic_id = p_logic_id AND security_id = p_security_id;
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.arm',
            format(
                'Линейный TP взведён sec=%s: track%%=%s >= base+tp%%=%s, price=%s',
                p_security_id, round(v_track_pct, 4), round(v_arm_pct, 4), p_price
            ),
            jsonb_build_object(
                'security_id', p_security_id,
                'track_pct', v_track_pct,
                'base_pct', v_base_pct,
                'arm_pct', v_arm_pct,
                'price', p_price
            ),
            p_security_id, p_timeframe_id
        );
        RETURN v_actions + 1;
    END IF;

    IF NOT v_ls.armed THEN
        RETURN v_actions;
    END IF;

    -- Взведён: падение цены → продажа + shadow renew
    IF v_ls.linear_tp_last_price IS NOT NULL
       AND p_price < v_ls.linear_tp_last_price
       AND v_has_pos
       AND (v_ls.linear_tp_arm_bar_dt IS NULL OR p_bar_dt > v_ls.linear_tp_arm_bar_dt)
    THEN
        v_track_before := logic_security_track_value(
            p_logic_id, p_security_id, p_timeframe_id, FALSE
        );
        PERFORM logic_trade_log(
            p_logic_id, 'take_profit.linear.trigger',
            format(
                'Линейный TP: продажа sec=%s price %s < %s, track%%=%s',
                p_security_id, p_price, v_ls.linear_tp_last_price, round(v_track_pct, 4)
            ),
            jsonb_build_object(
                'security_id', p_security_id,
                'price', p_price,
                'last_price', v_ls.linear_tp_last_price,
                'track_pct', v_track_pct,
                'base_pct', v_base_pct,
                'arm_pct', v_arm_pct,
                'track_before', v_track_before
            ),
            p_security_id, p_timeframe_id
        );
        v_closed := logic_close_security_positions_market(
            p_logic_id, p_security_id, FALSE,
            format('take_profit:security_ltp_renew (%s%%)', round(v_track_pct, 2))
        );
        v_actions := v_actions + COALESCE(v_closed, 0);
        v_track_after := logic_security_track_value(
            p_logic_id, p_security_id, p_timeframe_id, FALSE
        );
        UPDATE logic_securities
        SET real_trading_paused = TRUE,
            stop_resume_equity = v_track_before,
            stop_resume_baseline = v_track_after,
            stop_resume_triggered_at = CURRENT_TIMESTAMP,
            linear_tp_armed = FALSE,
            linear_tp_last_price = NULL,
            linear_tp_arm_bar_dt = NULL
        WHERE logic_id = p_logic_id AND security_id = p_security_id;
        RETURN v_actions + 1;
    END IF;

    -- Цена не упала — подтянуть ориентир (трейлинг пика)
    IF p_price > COALESCE(v_ls.linear_tp_last_price, 0) THEN
        UPDATE logic_securities
        SET linear_tp_last_price = p_price
        WHERE logic_id = p_logic_id AND security_id = p_security_id;
    END IF;

    RETURN v_actions;
END;
$$;

COMMENT ON FUNCTION logic_process_linear_tp_security(INTEGER, INTEGER, INTEGER, NUMERIC, TIMESTAMP, NUMERIC) IS
'Бой: линейный TP по бумаге — взведение / продажа на падении / сброс ниже base%.';

CREATE OR REPLACE FUNCTION process_logic_stops(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_stop RECORD;
    v_tp RECORD;
    v_tf_id INTEGER;
    v_tf_sec INTEGER;
    v_closed_bar_dt TIMESTAMP;
    v_last_bar_raw TEXT;
    v_last_bar_dt TIMESTAMP;
    v_sec RECORD;
    v_drawdown NUMERIC;
    v_port_dd NUMERIC;
    v_actions INTEGER := 0;
    v_track_before NUMERIC;
    v_track_after NUMERIC;
    v_closed INTEGER;
    v_skip_http BOOLEAN := FALSE;
    v_date_from DATE;
    v_date_to DATE;
    v_price NUMERIC;
BEGIN
    SELECT l.id, l.is_enabled
    INTO v_logic
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id
      AND l.is_enabled = TRUE
      AND a.is_active = TRUE;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    v_tf_id := logic_resolve_stop_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = v_tf_id;
    v_closed_bar_dt := logic_last_closed_bar_dt(v_tf_sec);
    IF v_closed_bar_dt IS NULL THEN
        RETURN 0;
    END IF;

    v_last_bar_raw := btrim(COALESCE(get_logic_param_text(p_logic_id, 'last_stop_bar_dt'), ''));
    IF v_last_bar_raw <> '' THEN
        BEGIN
            v_last_bar_dt := v_last_bar_raw::TIMESTAMP;
            IF v_closed_bar_dt <= v_last_bar_dt THEN
                IF logic_check_portfolio_resume(p_logic_id, v_tf_id) THEN
                    v_actions := v_actions + 1;
                END IF;
                FOR v_sec IN
                    SELECT ls.security_id
                    FROM logic_securities ls
                    WHERE ls.logic_id = p_logic_id
                      AND ls.is_active = TRUE
                      AND (ls.real_trading_paused = TRUE OR ls.real_trading_inverted = TRUE)
                LOOP
                    IF logic_check_security_resume(p_logic_id, v_sec.security_id, v_tf_id) THEN
                        v_actions := v_actions + 1;
                    END IF;
                END LOOP;
                RETURN v_actions;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
    END IF;

    SELECT * INTO v_stop
    FROM logic_stops ls
    WHERE ls.logic_id = p_logic_id
      AND ls.rule_kind = 'stop_loss'
      AND ls.is_active = TRUE
    ORDER BY ls.display_order, ls.id
    LIMIT 1;

    -- Не грузим все 34 бумаги через HTTP на каждом баре: это блокирует пул и UI
    -- (раскрытие бумаги / график). Только позиции / pause + skip если свеча уже есть.
    SELECT EXISTS (
        SELECT 1
        FROM logic_backtest_runs r
        WHERE r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
    ) INTO v_skip_http;

    v_date_to := GREATEST(v_closed_bar_dt::date, CURRENT_DATE);
    v_date_from := logic_trade_load_date_from(
        v_tf_sec, logic_trade_sync_point_count(v_tf_sec), v_closed_bar_dt
    );

    FOR v_sec IN
        SELECT DISTINCT q.security_id
        FROM (
            SELECT lt.security_id
            FROM logic_trades lt
            WHERE lt.logic_id = p_logic_id
              AND NOT lt.is_test
              AND NOT lt.is_shadow
              AND lt.status IN ('filled', 'submitted')
            UNION
            SELECT ls.security_id
            FROM logic_securities ls
            WHERE ls.logic_id = p_logic_id
              AND ls.is_active = TRUE
              AND (ls.real_trading_paused = TRUE OR ls.real_trading_inverted = TRUE)
        ) q
    LOOP
        IF NOT v_skip_http
           AND NOT prices_have_closed_bar(v_sec.security_id, v_tf_id, v_closed_bar_dt) THEN
            BEGIN
                CALL load_prices(
                    v_sec.security_id,
                    v_tf_id,
                    prices_topup_date_from(
                        v_sec.security_id, v_tf_id, v_closed_bar_dt, v_date_from
                    ),
                    v_date_to
                );
            EXCEPTION
                WHEN OTHERS THEN
                    NULL;
            END;
        END IF;

        IF logic_check_security_resume(p_logic_id, v_sec.security_id, v_tf_id) THEN
            v_actions := v_actions + 1;
        END IF;
    END LOOP;

    IF logic_check_portfolio_resume(p_logic_id, v_tf_id) THEN
        v_actions := v_actions + 1;
    END IF;

    -- SL может отсутствовать — линейный TP всё равно обрабатываем ниже
    IF v_stop.id IS NOT NULL AND v_stop.value_unit <> 'percent' THEN
        PERFORM logic_trade_log(
            p_logic_id, 'stop.skip',
            format('Стоп-лосс: единица %s пока не поддерживается (только percent)', v_stop.value_unit),
            NULL, NULL, v_tf_id
        );
    ELSIF v_stop.id IS NOT NULL AND v_stop.scope_type = 'portfolio' THEN
        v_port_dd := logic_portfolio_drawdown_pct(p_logic_id, v_tf_id);
        IF v_port_dd >= v_stop.value THEN
            PERFORM logic_trade_log(
                p_logic_id, 'stop.trigger',
                format('Портфельный SL: просадка %s%% >= %s%%', round(v_port_dd, 4), v_stop.value),
                jsonb_build_object('drawdown_pct', v_port_dd, 'threshold', v_stop.value),
                NULL, v_tf_id
            );
            FOR v_sec IN
                SELECT DISTINCT lt.security_id
                FROM logic_trades lt
                WHERE lt.logic_id = p_logic_id
                  AND NOT lt.is_shadow
                  AND NOT lt.is_test
                  AND lt.status IN ('filled', 'submitted')
                  AND NOT logic_is_cash_fund_security(lt.security_id)
            LOOP
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
            END LOOP;
        END IF;
    ELSIF v_stop.id IS NOT NULL AND v_stop.scope_type = 'portfolio_resume' THEN
        -- Уже в паузе — только проверка возобновления (выше); не триггерим повторно.
        IF EXISTS (
            SELECT 1 FROM logics l
            WHERE l.id = p_logic_id AND COALESCE(l.portfolio_trading_paused, FALSE)
        ) THEN
            NULL;
        ELSE
            v_port_dd := logic_portfolio_peak_drawdown_pct(p_logic_id, v_tf_id);
            IF v_port_dd >= v_stop.value THEN
                v_track_before := logic_portfolio_equity(p_logic_id, v_tf_id);
                PERFORM logic_trade_log(
                    p_logic_id, 'stop.trigger',
                    format(
                        'Портфельный SL с возобновлением: просадка от пика %s%% >= %s%%, equity=%s',
                        round(v_port_dd, 4), v_stop.value, round(COALESCE(v_track_before, 0), 2)
                    ),
                    jsonb_build_object(
                        'drawdown_pct', v_port_dd,
                        'threshold', v_stop.value,
                        'scope', 'portfolio_resume',
                        'equity_before', v_track_before
                    ),
                    NULL, v_tf_id
                );
                FOR v_sec IN
                    SELECT DISTINCT lt.security_id
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id
                      AND NOT lt.is_shadow
                      AND NOT lt.is_test
                      AND lt.status IN ('filled', 'submitted')
                      AND NOT logic_is_cash_fund_security(lt.security_id)
                LOOP
                    v_closed := logic_close_security_positions_market(
                        p_logic_id, v_sec.security_id, FALSE
                    );
                    v_actions := v_actions + v_closed;
                END LOOP;
                v_track_after := logic_portfolio_equity(p_logic_id, v_tf_id);
                UPDATE logics
                SET portfolio_trading_paused = TRUE,
                    portfolio_stop_resume_equity = v_track_before,
                    portfolio_stop_resume_baseline = v_track_after,
                    portfolio_stop_resume_at = CURRENT_TIMESTAMP
                WHERE id = p_logic_id;
                v_actions := v_actions + 1;
            END IF;
        END IF;
    ELSIF v_stop.id IS NOT NULL THEN
        FOR v_sec IN
            SELECT ls.security_id
            FROM logic_securities ls
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
              AND NOT logic_is_cash_fund_security(ls.security_id)
        LOOP
            IF v_stop.scope_type = 'security_resume'
               AND EXISTS (
                   SELECT 1 FROM logic_securities ls2
                   WHERE ls2.logic_id = p_logic_id
                     AND ls2.security_id = v_sec.security_id
                     AND ls2.real_trading_paused = TRUE
               ) THEN
                CONTINUE;
            END IF;

            v_drawdown := logic_security_drawdown_pct(
                p_logic_id, v_sec.security_id, v_tf_id, FALSE
            );

            IF v_drawdown < v_stop.value THEN
                CONTINUE;
            END IF;

            IF v_stop.scope_type = 'security' THEN
                PERFORM logic_trade_log(
                    p_logic_id, 'stop.trigger',
                    format(
                        'SL по бумаге sec=%s: просадка %s%% >= %s%%',
                        v_sec.security_id, round(v_drawdown, 4), v_stop.value
                    ),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'drawdown_pct', v_drawdown,
                        'scope', 'security'
                    ),
                    v_sec.security_id, v_tf_id
                );
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
            ELSIF v_stop.scope_type = 'security_resume' THEN
                v_track_before := logic_security_track_value(
                    p_logic_id, v_sec.security_id, v_tf_id, FALSE
                );
                PERFORM logic_trade_log(
                    p_logic_id, 'stop.trigger',
                    format(
                        'SL с возобновлением sec=%s: просадка %s%% >= %s%%, track=%s',
                        v_sec.security_id, round(v_drawdown, 4), v_stop.value, v_track_before
                    ),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'drawdown_pct', v_drawdown,
                        'scope', 'security_resume',
                        'track_before', v_track_before
                    ),
                    v_sec.security_id, v_tf_id
                );
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
                v_track_after := logic_security_track_value(
                    p_logic_id, v_sec.security_id, v_tf_id, FALSE
                );
                UPDATE logic_securities
                SET real_trading_paused = TRUE,
                    stop_resume_equity = v_track_before,
                    stop_resume_baseline = v_track_after,
                    stop_resume_triggered_at = CURRENT_TIMESTAMP
                WHERE logic_id = p_logic_id
                  AND security_id = v_sec.security_id;
                v_actions := v_actions + 1;
            ELSIF v_stop.scope_type = 'security_inversion' THEN
                PERFORM logic_trade_log(
                    p_logic_id, 'stop.trigger',
                    format(
                        'SL inversion sec=%s: просадка %s%% >= %s%%',
                        v_sec.security_id, round(v_drawdown, 4), v_stop.value
                    ),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'drawdown_pct', v_drawdown,
                        'scope', 'security_inversion'
                    ),
                    v_sec.security_id, v_tf_id
                );
                v_closed := logic_close_security_positions_market(
                    p_logic_id, v_sec.security_id, FALSE
                );
                v_actions := v_actions + v_closed;
                UPDATE logic_securities
                SET real_trading_inverted = NOT COALESCE(real_trading_inverted, FALSE),
                    stop_resume_triggered_at = CURRENT_TIMESTAMP
                WHERE logic_id = p_logic_id
                  AND security_id = v_sec.security_id;
                v_actions := v_actions + 1;
            END IF;
        END LOOP;
    END IF;

    -- Линейный TP по бумаге с возобновлением (независимо от выбранного SL)
    SELECT * INTO v_tp
    FROM logic_stops ls
    WHERE ls.logic_id = p_logic_id
      AND ls.rule_kind = 'take_profit'
      AND ls.scope_type = 'security_ltp_renew'
      AND ls.is_active = TRUE
    ORDER BY ls.display_order, ls.id
    LIMIT 1;

    IF v_tp.id IS NOT NULL AND v_tp.value_unit = 'percent' THEN
        FOR v_sec IN
            SELECT ls.security_id
            FROM logic_securities ls
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
              AND NOT logic_is_cash_fund_security(ls.security_id)
        LOOP
            SELECT p.close_price INTO v_price
            FROM prices p
            WHERE p.security_id = v_sec.security_id
              AND p.timeframe_id = v_tf_id
              AND p.dt = v_closed_bar_dt
            LIMIT 1;
            IF v_price IS NULL OR v_price <= 0 THEN
                v_price := logic_ensure_security_market_price(
                    p_logic_id, v_sec.security_id, v_tf_id
                );
            END IF;
            v_actions := v_actions + COALESCE(
                logic_process_linear_tp_security(
                    p_logic_id, v_sec.security_id, v_tf_id,
                    v_tp.value, v_closed_bar_dt, v_price
                ),
                0
            );
        END LOOP;
    END IF;

    PERFORM logic_upsert_param(
        p_logic_id, 'last_stop_bar_dt',
        to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'), 'text'
    );

    RETURN v_actions;
END;
$$;

COMMENT ON FUNCTION process_logic_stops(INTEGER) IS
'Стоп-лоссы + линейный TP (security_ltp_renew); TF из stop_loss_timeframe';
-- @end logic_stop_runner
CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

DROP FUNCTION IF EXISTS logic_calc_open_quantity(NUMERIC, NUMERIC, NUMERIC, INTEGER);

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

DROP FUNCTION IF EXISTS logic_calc_open_quantity(NUMERIC, NUMERIC, NUMERIC, INTEGER);

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

DROP FUNCTION IF EXISTS logic_calc_open_quantity(NUMERIC, NUMERIC, NUMERIC, INTEGER);

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

DROP FUNCTION IF EXISTS logic_calc_open_quantity(NUMERIC, NUMERIC, NUMERIC, INTEGER);

CREATE OR REPLACE FUNCTION logic_calc_open_quantity(
    p_balance NUMERIC,
    p_position_size_pct NUMERIC,
    p_price NUMERIC,
    p_lot_size INTEGER DEFAULT 1,
    p_max_order_amount NUMERIC DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_amount NUMERIC;
    v_raw INTEGER;
    v_lot INTEGER;
    v_qty INTEGER;
BEGIN
    IF p_balance IS NULL OR p_balance <= 0 THEN
        RETURN 0;
    END IF;
    IF p_price IS NULL OR p_price <= 0 THEN
        RETURN 0;
    END IF;
    IF p_position_size_pct IS NULL OR p_position_size_pct <= 0 THEN
        RETURN 0;
    END IF;
    v_lot := GREATEST(1, COALESCE(p_lot_size, 1));
    v_amount := p_balance * (p_position_size_pct / 100.0);
    IF p_max_order_amount IS NOT NULL AND p_max_order_amount > 0 THEN
        v_amount := LEAST(v_amount, p_max_order_amount);
    END IF;
    v_raw := floor(v_amount / p_price)::INTEGER;
    -- Округление вниз до целого числа лотов
    v_qty := (v_raw / v_lot) * v_lot;
    IF v_qty >= v_lot THEN
        RETURN v_qty;
    END IF;
    RETURN 0;
END;
$$;

COMMENT ON FUNCTION logic_calc_open_quantity(NUMERIC, NUMERIC, NUMERIC, INTEGER, NUMERIC) IS
'Лот: % базы / цена (опц. потолок суммы), вниз до lot_size';

-- MTM выбранного денежного фонда логики (для исключения из базы «весь портфель»).
CREATE OR REPLACE FUNCTION logic_selected_cash_fund_mtm(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
    v_sec RECORD;
    v_price NUMERIC;
    v_qty NUMERIC;
    v_mtm NUMERIC := 0;
BEGIN
    v_code := upper(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'cash_fund_code'),
        ''
    )));
    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN 0;
    END IF;

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        JOIN security_prefixes sp ON sp.security_id = ls.security_id
        WHERE ls.logic_id = p_logic_id
          AND ls.is_active = TRUE
          AND upper(sp.prefix) = v_code
    LOOP
        v_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE);
        IF v_qty <= 0 THEN
            CONTINUE;
        END IF;
        v_price := logic_ensure_security_market_price(
            p_logic_id, v_sec.security_id, p_timeframe_id
        );
        IF v_price IS NOT NULL AND v_price > 0 THEN
            v_mtm := v_mtm + v_qty * v_price;
        END IF;
    END LOOP;

    RETURN GREATEST(0, v_mtm);
END;
$$;

COMMENT ON FUNCTION logic_selected_cash_fund_mtm(INTEGER, INTEGER) IS
'Рыночная оценка выбранного cash_fund_code в логике; 0 если фонд не выбран';

-- База для % лота: free_cash | portfolio (default). Real — брокер; test — current / equity.
-- portfolio: без суммы выбранного денежного фонда (если cash_fund_code задан).
CREATE OR REPLACE FUNCTION logic_position_sizing_base(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_account_id INTEGER;
    v_account_type VARCHAR;
    v_mode TEXT;
    v_fund_code TEXT;
    v_bal JSONB;
    v_cash NUMERIC;
    v_portfolio NUMERIC;
    v_sec RECORD;
    v_price NUMERIC;
    v_long_qty NUMERIC;
BEGIN
    SELECT l.account_id, lower(COALESCE(a.account_type, 'fake'))
    INTO v_account_id, v_account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    v_mode := lower(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'position_size_base'),
        'portfolio'
    )));
    IF v_mode NOT IN ('free_cash', 'portfolio') THEN
        v_mode := 'portfolio';
    END IF;

    v_fund_code := upper(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'cash_fund_code'),
        ''
    )));
    IF v_fund_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        v_fund_code := '';
    END IF;

    IF v_account_type <> 'fake' THEN
        BEGIN
            v_bal := fetch_tbank_account_balance(v_account_id);
            IF v_bal IS NULL OR (v_bal->>'error') IS NOT NULL THEN
                RETURN 0;
            END IF;
            IF v_mode = 'portfolio' THEN
                v_portfolio := GREATEST(0, COALESCE((v_bal->>'amount')::NUMERIC, 0));
                -- Выбранный фонд не участвует в базе открытия позиций
                IF v_fund_code <> '' THEN
                    v_portfolio := GREATEST(
                        0,
                        v_portfolio - logic_selected_cash_fund_mtm(p_logic_id, p_timeframe_id)
                    );
                END IF;
                RETURN v_portfolio;
            END IF;
            IF v_bal ? 'cash_amount' AND (v_bal->>'cash_amount') IS NOT NULL THEN
                RETURN GREATEST(0, COALESCE((v_bal->>'cash_amount')::NUMERIC, 0));
            END IF;
            RETURN GREATEST(0, COALESCE((v_bal->>'amount')::NUMERIC, 0));
        EXCEPTION
            WHEN OTHERS THEN
                RETURN 0;
        END;
    END IF;

    -- Test (fake): свободные = current; портфель = current + MTM бумаг (без выбранного фонда)
    v_cash := COALESCE(logic_ensure_balance(p_logic_id), 0);
    IF v_mode <> 'portfolio' THEN
        RETURN GREATEST(0, v_cash);
    END IF;

    v_portfolio := v_cash;
    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
          AND (
              v_fund_code = ''
              OR NOT EXISTS (
                  SELECT 1
                  FROM security_prefixes sp
                  WHERE sp.security_id = ls.security_id
                    AND upper(sp.prefix) = v_fund_code
              )
          )
    LOOP
        v_long_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE);
        IF v_long_qty <= 0 THEN
            CONTINUE;
        END IF;
        v_price := logic_ensure_security_market_price(
            p_logic_id, v_sec.security_id, p_timeframe_id
        );
        IF v_price IS NOT NULL AND v_price > 0 THEN
            v_portfolio := v_portfolio + v_long_qty * v_price;
        END IF;
    END LOOP;

    RETURN GREATEST(0, v_portfolio);
END;
$$;

COMMENT ON FUNCTION logic_position_sizing_base(INTEGER, INTEGER) IS
'База % лота: free_cash|portfolio (default portfolio); фонд из cash_fund_code исключается из portfolio';

CREATE OR REPLACE FUNCTION logic_upsert_param(
    p_logic_id INTEGER,
    p_param_key TEXT,
    p_value TEXT,
    p_value_type TEXT DEFAULT 'text'
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
    VALUES (p_logic_id, p_param_key, COALESCE(p_value, ''), p_value_type)
    ON CONFLICT (logic_id, param_key) DO UPDATE SET
        param_value = EXCLUDED.param_value,
        value_type = EXCLUDED.value_type,
        updated_at = CURRENT_TIMESTAMP;
END;
$$;

CREATE OR REPLACE FUNCTION logic_is_paper_balance_text(p_raw TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_raw IS NULL OR btrim(p_raw) = '' THEN TRUE
        WHEN replace(replace(btrim(p_raw), ' ', ''), ',', '.')
            IN ('1000000', '1000000.0', '1000000.00', '1000000.000', '1000000.000000')
        THEN TRUE
        ELSE FALSE
    END;
$$;

CREATE OR REPLACE FUNCTION logic_apply_real_account_balances(
    p_logic_id INTEGER,
    p_force_initial BOOLEAN DEFAULT TRUE
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_account_id INTEGER;
    v_account_type VARCHAR;
    v_bal JSONB;
    v_amount NUMERIC := 0;
    v_ok BOOLEAN := FALSE;
BEGIN
    SELECT l.account_id, lower(COALESCE(a.account_type, 'fake'))
    INTO v_account_id, v_account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    IF NOT FOUND OR v_account_type = 'fake' THEN
        RETURN NULL;
    END IF;

    BEGIN
        v_bal := fetch_tbank_account_balance(v_account_id);
        IF v_bal IS NOT NULL AND (v_bal->>'error') IS NULL THEN
            IF v_bal ? 'cash_amount' AND (v_bal->>'cash_amount') IS NOT NULL THEN
                v_amount := COALESCE((v_bal->>'cash_amount')::NUMERIC, 0);
            ELSE
                v_amount := COALESCE((v_bal->>'amount')::NUMERIC, 0);
            END IF;
            IF v_amount < 0 THEN
                v_amount := 0;
            END IF;
            v_ok := TRUE;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            v_ok := FALSE;
            v_amount := 0;
    END;

    IF NOT v_ok THEN
        v_amount := 0;
    END IF;

    -- Real: и начальный, и текущий — только с брокера (или 0). Не из параметров теста.
    -- p_force_initial: совместимость сигнатуры; для real оба поля всегда с брокера.
    PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_amount::TEXT, 'money');
    PERFORM logic_upsert_param(p_logic_id, 'initial_balance', v_amount::TEXT, 'money');

    RETURN v_amount;
END;
$$;

COMMENT ON FUNCTION logic_apply_real_account_balances(INTEGER, BOOLEAN) IS
'Real: initial+current = T-Bank cash или 0. Fake: no-op (остатки из параметров).';

CREATE OR REPLACE FUNCTION logic_sync_all_real_account_balances()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    r RECORD;
    v_n INTEGER := 0;
BEGIN
    FOR r IN
        SELECT l.id
        FROM logics l
        JOIN accounts a ON a.id = l.account_id
        WHERE lower(COALESCE(a.account_type, 'fake')) <> 'fake'
    LOOP
        PERFORM logic_apply_real_account_balances(r.id, TRUE);
        v_n := v_n + 1;
    END LOOP;
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION logic_sync_all_real_account_balances() IS
'Upgrade/install: для всех real-логик выставить остатки с брокера (или 0).';

CREATE OR REPLACE FUNCTION logic_ensure_balance(p_logic_id INTEGER)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_account_type VARCHAR;
    v_current NUMERIC;
    v_initial NUMERIC;
BEGIN
    SELECT lower(COALESCE(a.account_type, 'fake'))
    INTO v_account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    -- Реальный счёт: начальный и текущий — с брокера (или 0), не из параметров теста.
    IF FOUND AND v_account_type <> 'fake' THEN
        RETURN COALESCE(logic_apply_real_account_balances(p_logic_id, TRUE), 0);
    END IF;

    v_current := get_logic_param_numeric(p_logic_id, 'current_balance', NULL);
    IF v_current IS NOT NULL THEN
        RETURN v_current;
    END IF;
    v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', NULL);
    IF v_initial IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_initial::TEXT, 'money');
    RETURN v_initial;
END;
$$;

COMMENT ON FUNCTION logic_ensure_balance(INTEGER) IS
'Fake: параметры initial/current. Real: оба с T-Bank (или 0).';

CREATE OR REPLACE FUNCTION logic_trade_load_date_from(
    p_tf_sec INTEGER,
    p_point_count INTEGER,
    p_closed_bar_dt TIMESTAMP
)
RETURNS DATE
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_date_to DATE;
    v_need_days INTEGER;
    v_max_days INTEGER;
    v_span INTEGER;
BEGIN
    v_date_to := GREATEST(p_closed_bar_dt::date, CURRENT_DATE);
    v_need_days := GREATEST(1, CEIL(GREATEST(COALESCE(p_point_count, 100), 30) * COALESCE(NULLIF(p_tf_sec, 0), 900) / 86400.0)::INTEGER);

    v_max_days := CASE
        WHEN COALESCE(p_tf_sec, 0) <= 120 THEN 0
        WHEN p_tf_sec <= 600 THEN 3
        WHEN p_tf_sec <= 1800 THEN 7
        WHEN p_tf_sec <= 3600 THEN 14
        ELSE 30
    END;

    IF v_max_days = 0 THEN
        RETURN v_date_to;
    END IF;

    v_span := LEAST(GREATEST(v_need_days, 1), v_max_days);
    RETURN v_date_to - v_span;
END;
$$;

COMMENT ON FUNCTION logic_trade_load_date_from(INTEGER, INTEGER, TIMESTAMP) IS
'date_from для load_prices с учётом лимитов T-Bank по TF (M1/M2 — только текущий день)';

CREATE OR REPLACE FUNCTION logic_trade_sync_point_count(p_tf_sec INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE AS $$
    SELECT CASE
        WHEN COALESCE(p_tf_sec, 0) <= 60 THEN 400
        WHEN p_tf_sec <= 120 THEN 300
        WHEN p_tf_sec <= 300 THEN 200
        ELSE 150
    END;
$$;

COMMENT ON FUNCTION logic_trade_sync_point_count(INTEGER) IS
'Число свечей для sync индикаторов в runner: больше на M1/M2/M5';

CREATE OR REPLACE PROCEDURE logic_refresh_market_data(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_closed_bar_dt TIMESTAMP
)
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_sig RECORD;
    v_date_from DATE;
    v_date_to DATE;
    v_point_count INTEGER;
    v_tf_sec INTEGER;
    v_err TEXT;
BEGIN
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;

    v_point_count := logic_trade_sync_point_count(v_tf_sec);
    v_date_to := GREATEST(p_closed_bar_dt::date, CURRENT_DATE);
    v_date_from := logic_trade_load_date_from(v_tf_sec, v_point_count, p_closed_bar_dt);

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        BEGIN
            CALL load_prices(v_sec.security_id, p_timeframe_id, v_date_from, v_date_to);
            PERFORM logic_trade_log(
                p_logic_id,
                'trade.prices.loaded',
                format('Цены подгружены sec=%s (%s .. %s)', v_sec.security_id, v_date_from, v_date_to),
                jsonb_build_object(
                    'security_id', v_sec.security_id,
                    'date_from', v_date_from,
                    'date_to', v_date_to,
                    'timeframe_id', p_timeframe_id
                ),
                v_sec.security_id,
                p_timeframe_id
            );
        EXCEPTION
            WHEN undefined_function THEN
                PERFORM logic_trade_log(
                    p_logic_id,
                    'trade.prices.error',
                    'load_prices недоступен (нет HTTP-расширения)',
                    jsonb_build_object('security_id', v_sec.security_id),
                    v_sec.security_id,
                    p_timeframe_id
                );
            WHEN OTHERS THEN
                v_err := SQLERRM;
                PERFORM logic_trade_log(
                    p_logic_id,
                    'trade.prices.error',
                    format('Ошибка загрузки цен sec=%s: %s', v_sec.security_id, v_err),
                    jsonb_build_object('security_id', v_sec.security_id, 'error', v_err),
                    v_sec.security_id,
                    p_timeframe_id
                );
        END;

        FOR v_sig IN
            SELECT DISTINCT lis.indicator_id
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
        LOOP
            BEGIN
                CALL ensure_security_indicator_series(v_sec.security_id, v_sig.indicator_id);
                CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sec.security_id);
                CALL sync_security_indicator_series_for_indicator(
                    v_sec.security_id,
                    v_sig.indicator_id,
                    p_timeframe_id,
                    p_closed_bar_dt,
                    v_point_count,
                    TRUE
                );
                PERFORM logic_trade_log(
                    p_logic_id,
                    'trade.indicator.synced',
                    format('Индикатор id=%s пересчитан sec=%s', v_sig.indicator_id, v_sec.security_id),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'indicator_id', v_sig.indicator_id,
                        'closed_bar', p_closed_bar_dt,
                        'point_count', v_point_count
                    ),
                    v_sec.security_id,
                    p_timeframe_id
                );
            EXCEPTION
                WHEN OTHERS THEN
                    v_err := SQLERRM;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.indicator.error',
                        format('Ошибка расчёта индикатора id=%s sec=%s: %s', v_sig.indicator_id, v_sec.security_id, v_err),
                        jsonb_build_object(
                            'security_id', v_sec.security_id,
                            'indicator_id', v_sig.indicator_id,
                            'error', v_err
                        ),
                        v_sec.security_id,
                        p_timeframe_id
                    );
            END;
        END LOOP;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_refresh_market_data(INTEGER, INTEGER, TIMESTAMP) IS
'Перед проверкой сигналов: load_prices + ensure/sync индикаторов логики на TF (live trading)';

-- @include sql/logic_trade_pnl.sql (см. sql/logic_trade_pnl.sql — дублируется ниже)
-- Renamed arg p_balance → p_notional: CREATE OR REPLACE cannot rename args
DROP FUNCTION IF EXISTS logic_trade_calc_commission(INTEGER, NUMERIC);

CREATE OR REPLACE FUNCTION logic_trade_calc_commission(
    p_logic_id INTEGER,
    p_notional NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_pct NUMERIC;
    v_base NUMERIC;
BEGIN
    v_pct := get_logic_param_numeric(p_logic_id, 'commission_pct', 0);
    IF v_pct IS NULL OR v_pct <= 0 THEN
        RETURN 0;
    END IF;
    -- % от номинала сделки (цена × количество), не от депозита
    v_base := COALESCE(p_notional, 0);
    IF v_base <= 0 THEN
        RETURN 0;
    END IF;
    RETURN round(v_base * v_pct / 100.0, 6);
END;
$$;

COMMENT ON FUNCTION logic_trade_calc_commission(INTEGER, NUMERIC) IS
'Комиссия фейкового счёта: commission_pct % от номинала сделки (price × quantity)';

CREATE OR REPLACE FUNCTION logic_trade_open_remaining_qty(p_open_trade_id BIGINT)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(
        lt.quantity - COALESCE((
            SELECT SUM(l.quantity)
            FROM logic_trade_lots l
            WHERE l.open_trade_id = lt.id
        ), 0),
        0
    )
    FROM logic_trades lt
    WHERE lt.id = p_open_trade_id;
$$;

COMMENT ON FUNCTION logic_trade_open_remaining_qty(BIGINT) IS
'Остаток лота открывающей сделки (qty минус уже закрыто пакетами)';

CREATE OR REPLACE FUNCTION logic_trade_build_lots(p_close_trade_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_close RECORD;
    v_method TEXT;
    v_remaining NUMERIC;
    v_open RECORD;
    v_alloc NUMERIC;
    v_open_rem NUMERIC;
    v_close_comm_part NUMERIC;
    v_open_comm_part NUMERIC;
    v_close_amt NUMERIC;
    v_open_amt NUMERIC;
    v_pnl NUMERIC;
    v_total_pnl NUMERIC := 0;
    v_avg_price NUMERIC;
    v_total_open_qty NUMERIC;
    v_total_open_cost NUMERIC;
    v_total_open_comm NUMERIC;
BEGIN
    SELECT lt.*, sd.name AS side_name, ac.name AS action_name
    INTO v_close
    FROM logic_trades lt
    JOIN sides sd ON sd.id = lt.side_id
    JOIN actions ac ON ac.id = lt.action_id
    WHERE lt.id = p_close_trade_id;

    IF NOT FOUND OR v_close.side_name <> 'Close' THEN
        RETURN;
    END IF;
    IF v_close.status NOT IN ('filled', 'submitted') THEN
        RETURN;
    END IF;

    DELETE FROM logic_trade_lots WHERE close_trade_id = p_close_trade_id;

    v_method := upper(btrim(COALESCE(get_logic_param_text(v_close.logic_id, 'cost_method'), 'FIFO')));
    IF v_method NOT IN ('FIFO', 'AVERAGE') THEN
        v_method := 'FIFO';
    END IF;

    v_remaining := v_close.quantity;

    IF v_method = 'AVERAGE' THEN
        SELECT
            COALESCE(SUM(logic_trade_open_remaining_qty(lt.id)), 0),
            COALESCE(SUM(logic_trade_open_remaining_qty(lt.id) * lt.price), 0),
            COALESCE(SUM(
                CASE WHEN lt.quantity > 0
                    THEN COALESCE(lt.commission, 0) * logic_trade_open_remaining_qty(lt.id) / lt.quantity
                    ELSE 0
                END
            ), 0)
        INTO v_total_open_qty, v_total_open_cost, v_total_open_comm
        FROM logic_trades lt
        JOIN sides sd ON sd.id = lt.side_id
        JOIN actions ac ON ac.id = lt.action_id
        WHERE lt.logic_id = v_close.logic_id
          AND lt.security_id = v_close.security_id
          AND sd.name = 'Open'
          AND ac.name = v_close.action_name
          AND lt.status IN ('filled', 'submitted')
          AND lt.executed_at <= v_close.executed_at
          AND logic_trade_open_remaining_qty(lt.id) > 0;

        IF v_total_open_qty <= 0 THEN
            RETURN;
        END IF;

        v_avg_price := v_total_open_cost / v_total_open_qty;

        FOR v_open IN
            SELECT lt.id, lt.quantity, lt.commission
            FROM logic_trades lt
            JOIN sides sd ON sd.id = lt.side_id
            JOIN actions ac ON ac.id = lt.action_id
            WHERE lt.logic_id = v_close.logic_id
              AND lt.security_id = v_close.security_id
              AND sd.name = 'Open'
              AND ac.name = v_close.action_name
              AND lt.status IN ('filled', 'submitted')
              AND lt.executed_at <= v_close.executed_at
            ORDER BY lt.executed_at ASC, lt.id ASC
        LOOP
            EXIT WHEN v_remaining <= 0;
            v_open_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_open_rem <= 0 THEN
                CONTINUE;
            END IF;
            v_alloc := LEAST(v_remaining, v_open_rem);
            v_close_amt := v_alloc * v_close.price;
            v_open_amt := v_alloc * v_avg_price;
            v_close_comm_part := CASE WHEN v_close.quantity > 0
                THEN COALESCE(v_close.commission, 0) * v_alloc / v_close.quantity ELSE 0 END;
            v_open_comm_part := CASE WHEN v_total_open_qty > 0
                THEN v_total_open_comm * v_alloc / v_total_open_qty ELSE 0 END;

            IF v_close.action_name = 'Long' THEN
                v_pnl := v_close_amt - v_open_amt - v_close_comm_part - v_open_comm_part;
            ELSE
                v_pnl := v_open_amt - v_close_amt - v_close_comm_part - v_open_comm_part;
            END IF;

            INSERT INTO logic_trade_lots (
                logic_id, close_trade_id, open_trade_id,
                quantity, close_amount, open_amount,
                close_commission, open_commission, financial_result,
                action_id, cost_method
            )
            VALUES (
                v_close.logic_id, p_close_trade_id, v_open.id,
                v_alloc, v_close_amt, v_open_amt,
                v_close_comm_part, v_open_comm_part, v_pnl,
                v_close.action_id, 'AVERAGE'
            );
            v_total_pnl := v_total_pnl + v_pnl;
            v_remaining := v_remaining - v_alloc;
        END LOOP;
    ELSE
        FOR v_open IN
            SELECT lt.id, lt.quantity, lt.price, lt.commission, lt.executed_at
            FROM logic_trades lt
            JOIN sides sd ON sd.id = lt.side_id
            JOIN actions ac ON ac.id = lt.action_id
            WHERE lt.logic_id = v_close.logic_id
              AND lt.security_id = v_close.security_id
              AND sd.name = 'Open'
              AND ac.name = v_close.action_name
              AND lt.status IN ('filled', 'submitted')
              AND lt.executed_at <= v_close.executed_at
            ORDER BY lt.executed_at ASC, lt.id ASC
        LOOP
            EXIT WHEN v_remaining <= 0;
            v_open_rem := logic_trade_open_remaining_qty(v_open.id);
            IF v_open_rem <= 0 THEN
                CONTINUE;
            END IF;
            v_alloc := LEAST(v_remaining, v_open_rem);
            v_close_amt := v_alloc * v_close.price;
            v_open_amt := v_alloc * v_open.price;
            v_close_comm_part := CASE WHEN v_close.quantity > 0
                THEN COALESCE(v_close.commission, 0) * v_alloc / v_close.quantity ELSE 0 END;
            v_open_comm_part := CASE WHEN v_open.quantity > 0
                THEN COALESCE(v_open.commission, 0) * v_alloc / v_open.quantity ELSE 0 END;

            IF v_close.action_name = 'Long' THEN
                v_pnl := v_close_amt - v_open_amt - v_close_comm_part - v_open_comm_part;
            ELSE
                v_pnl := v_open_amt - v_close_amt - v_close_comm_part - v_open_comm_part;
            END IF;

            INSERT INTO logic_trade_lots (
                logic_id, close_trade_id, open_trade_id,
                quantity, close_amount, open_amount,
                close_commission, open_commission, financial_result,
                action_id, cost_method
            )
            VALUES (
                v_close.logic_id, p_close_trade_id, v_open.id,
                v_alloc, v_close_amt, v_open_amt,
                v_close_comm_part, v_open_comm_part, v_pnl,
                v_close.action_id, 'FIFO'
            );
            v_total_pnl := v_total_pnl + v_pnl;
            v_remaining := v_remaining - v_alloc;
        END LOOP;
    END IF;

    UPDATE logic_trades
    SET financial_result = CASE WHEN v_total_pnl <> 0 THEN v_total_pnl ELSE NULL END
    WHERE id = p_close_trade_id;
END;
$$;

COMMENT ON FUNCTION logic_trade_build_lots(BIGINT) IS
'Пакеты закрытия: FIFO или средняя; financial_result только на закрывающей сделке';

CREATE OR REPLACE FUNCTION logic_trade_finalize(p_trade_id BIGINT, p_balance NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_trade RECORD;
    v_comm NUMERIC := 0;
    v_new_balance NUMERIC := p_balance;
    v_side_name TEXT;
BEGIN
    SELECT lt.*, sd.name AS side_name
    INTO v_trade
    FROM logic_trades lt
    JOIN sides sd ON sd.id = lt.side_id
    WHERE lt.id = p_trade_id;

    IF NOT FOUND THEN
        RETURN p_balance;
    END IF;

    v_side_name := v_trade.side_name;

    IF v_trade.is_simulated THEN
        v_comm := logic_trade_calc_commission(
            v_trade.logic_id,
            COALESCE(v_trade.price, 0) * COALESCE(v_trade.quantity, 0)
        );
    ELSE
        v_comm := COALESCE(v_trade.commission, 0);
    END IF;

    UPDATE logic_trades SET commission = COALESCE(v_comm, 0) WHERE id = p_trade_id;

    IF v_side_name = 'Close' AND v_trade.status IN ('filled', 'submitted') THEN
        PERFORM logic_trade_build_lots(p_trade_id);
    END IF;

    IF v_trade.is_simulated AND v_new_balance IS NOT NULL AND v_comm > 0 THEN
        v_new_balance := v_new_balance - v_comm;
    END IF;

    RETURN v_new_balance;
END;
$$;

COMMENT ON FUNCTION logic_trade_finalize(BIGINT, NUMERIC) IS
'Комиссия на сделке; пакеты и PnL при закрытии; возвращает баланс после комиссии';

CREATE OR REPLACE FUNCTION logic_trade_rebuild_pnl(p_logic_id INTEGER DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_trade RECORD;
    v_balance NUMERIC;
    v_notional NUMERIC;
    v_count INTEGER := 0;
BEGIN
    FOR v_logic IN
        SELECT l.id
        FROM logics l
        WHERE p_logic_id IS NULL OR l.id = p_logic_id
        ORDER BY l.id
    LOOP
        v_balance := logic_ensure_balance(v_logic.id);

        FOR v_trade IN
            SELECT
                lt.id,
                lt.quantity,
                lt.price,
                lt.is_simulated,
                lt.status,
                sd.name AS side_name,
                ac.name AS action_name
            FROM logic_trades lt
            JOIN sides sd ON sd.id = lt.side_id
            JOIN actions ac ON ac.id = lt.action_id
            WHERE lt.logic_id = v_logic.id
              AND lt.status IN ('filled', 'submitted')
            ORDER BY lt.executed_at ASC, lt.id ASC
        LOOP
            IF v_trade.is_simulated THEN
                v_balance := logic_trade_finalize(v_trade.id, v_balance);
                v_notional := v_trade.quantity * v_trade.price;
                IF v_trade.action_name = 'Long' THEN
                    IF v_trade.side_name = 'Open' THEN
                        v_balance := v_balance - v_notional;
                    ELSE
                        v_balance := v_balance + v_notional;
                    END IF;
                ELSIF v_trade.action_name = 'Short' THEN
                    IF v_trade.side_name = 'Open' THEN
                        v_balance := v_balance + v_notional;
                    ELSE
                        v_balance := v_balance - v_notional;
                    END IF;
                END IF;
            ELSE
                PERFORM logic_trade_finalize(v_trade.id, NULL);
            END IF;
            v_count := v_count + 1;
        END LOOP;

        PERFORM logic_upsert_param(v_logic.id, 'current_balance', v_balance::TEXT, 'money');
    END LOOP;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION logic_trade_rebuild_pnl(INTEGER) IS
'Пересчёт комиссии, пакетов и PnL по истории сделок логики (NULL = все логики)';

-- @include sql/logic_close_all_positions.sql (см. sql/logic_close_all_positions.sql — дублируется ниже)
-- ============================================
-- Закрытие всех открытых позиций логики по рыночной (последней) цене
-- ============================================

CREATE OR REPLACE FUNCTION logic_security_latest_price(
    p_security_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT p.close_price
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
    ORDER BY p.dt DESC
    LIMIT 1;
$$;

COMMENT ON FUNCTION logic_security_latest_price(INTEGER, INTEGER) IS
'Последняя цена закрытия по бумаге и TF (для ручного закрытия по рынку)';

CREATE OR REPLACE FUNCTION logic_ensure_security_market_price(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_price NUMERIC;
    v_tf_sec INTEGER;
    v_date_from DATE;
    v_date_to DATE;
    v_point_count INTEGER;
    v_closed_bar_dt TIMESTAMP;
    v_err TEXT;
BEGIN
    v_price := logic_security_latest_price(p_security_id, p_timeframe_id);
    IF v_price IS NOT NULL AND v_price > 0 THEN
        RETURN v_price;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;
    v_closed_bar_dt := COALESCE(
        logic_last_closed_bar_dt(v_tf_sec),
        date_trunc('day', LOCALTIMESTAMP)::TIMESTAMP
    );
    v_point_count := logic_trade_sync_point_count(v_tf_sec);
    v_date_to := GREATEST(v_closed_bar_dt::date, CURRENT_DATE);
    v_date_from := logic_trade_load_date_from(v_tf_sec, v_point_count, v_closed_bar_dt);

    BEGIN
        CALL load_prices(p_security_id, p_timeframe_id, v_date_from, v_date_to);
        PERFORM logic_trade_log(
            p_logic_id,
            'trade.prices.loaded',
            format(
                'Цены для закрытия sec=%s TF=%s (%s .. %s)',
                p_security_id,
                p_timeframe_id,
                v_date_from,
                v_date_to
            ),
            jsonb_build_object(
                'security_id', p_security_id,
                'timeframe_id', p_timeframe_id,
                'date_from', v_date_from,
                'date_to', v_date_to,
                'reason', 'close_all_at_market'
            ),
            p_security_id,
            p_timeframe_id
        );
    EXCEPTION
        WHEN undefined_function THEN
            PERFORM logic_trade_log(
                p_logic_id,
                'trade.prices.error',
                'load_prices недоступен (нет HTTP-расширения)',
                jsonb_build_object('security_id', p_security_id, 'reason', 'close_all_at_market'),
                p_security_id,
                p_timeframe_id
            );
        WHEN OTHERS THEN
            v_err := SQLERRM;
            PERFORM logic_trade_log(
                p_logic_id,
                'trade.prices.error',
                format('Ошибка загрузки цен sec=%s: %s', p_security_id, v_err),
                jsonb_build_object(
                    'security_id', p_security_id,
                    'error', v_err,
                    'reason', 'close_all_at_market'
                ),
                p_security_id,
                p_timeframe_id
            );
    END;

    v_price := logic_security_latest_price(p_security_id, p_timeframe_id);
    IF v_price IS NOT NULL AND v_price > 0 THEN
        RETURN v_price;
    END IF;

    SELECT p.close_price
    INTO v_price
    FROM prices p
    WHERE p.security_id = p_security_id
    ORDER BY p.dt DESC
    LIMIT 1;

    RETURN v_price;
END;
$$;

COMMENT ON FUNCTION logic_ensure_security_market_price(INTEGER, INTEGER, INTEGER) IS
'Последняя цена для закрытия: из БД или load_prices (T-Bank/MOEX), затем fallback по любому TF';

-- Снять старую одноаргументную сигнатуру (иначе в PG останутся два overload).
DROP FUNCTION IF EXISTS logic_close_all_positions_at_market(INTEGER);

CREATE OR REPLACE FUNCTION logic_close_all_positions_at_market(
    p_logic_id INTEGER,
    p_except_cash_funds BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_tf_id INTEGER;
    v_balance NUMERIC;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_sec RECORD;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_price NUMERIC;
    v_trade_id BIGINT;
    v_closed INTEGER := 0;
    v_skipped INTEGER := 0;
    v_errors JSONB := '[]'::jsonb;
    v_bar_dt TIMESTAMP;
    v_formula TEXT := CASE
        WHEN p_except_cash_funds THEN 'eod.close'
        ELSE 'market:close_all'
    END;
    v_quantity INTEGER;
    v_notional NUMERIC;
    v_is_simulated BOOLEAN;
    v_broker_order_id TEXT;
    v_status TEXT;
    v_note TEXT;
    v_figi TEXT;
    v_order JSONB;
    v_direction TEXT;
    v_action_id INTEGER;
    v_close_idx INTEGER := 0;
BEGIN
    SELECT l.id, l.account_id, a.account_type
    INTO v_logic
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id
      AND a.is_active = TRUE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', FALSE,
            'error', 'Логика не найдена или счёт неактивен',
            'closed', 0
        );
    END IF;

    v_tf_id := logic_resolve_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', FALSE,
            'error', 'Не задан timeframe в logic_params',
            'closed', 0
        );
    END IF;

    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    IF v_side_close_id IS NULL OR v_action_long_id IS NULL OR v_action_short_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', FALSE,
            'error', 'Справочники sides/actions не настроены',
            'closed', 0
        );
    END IF;

    v_balance := logic_ensure_balance(p_logic_id);
    v_is_simulated := v_logic.account_type = 'fake';

    FOR v_sec IN
        SELECT DISTINCT lt.security_id
        FROM logic_trades lt
        WHERE lt.logic_id = p_logic_id
          AND NOT lt.is_shadow
          AND NOT lt.is_test
          AND lt.status IN ('filled', 'submitted')
          AND (
              NOT p_except_cash_funds
              OR NOT EXISTS (
                  SELECT 1 FROM security_prefixes sp
                  WHERE sp.security_id = lt.security_id
                    AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
              )
          )
    LOOP
        v_long_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE);
        v_short_qty := logic_short_position_qty(p_logic_id, v_sec.security_id, FALSE);

        IF v_long_qty <= 0 AND v_short_qty <= 0 THEN
            CONTINUE;
        END IF;

        v_price := logic_ensure_security_market_price(p_logic_id, v_sec.security_id, v_tf_id);
        IF v_price IS NULL OR v_price <= 0 THEN
            v_skipped := v_skipped + 1;
            v_errors := v_errors || jsonb_build_array(
                jsonb_build_object(
                    'security_id', v_sec.security_id,
                    'reason', 'Не удалось получить цену (загрузка и fallback не дали результат)'
                )
            );
            CONTINUE;
        END IF;

        IF v_long_qty > 0 THEN
            v_close_idx := v_close_idx + 1;
            v_bar_dt := clock_timestamp() + (v_close_idx * interval '1 millisecond');
            v_quantity := floor(v_long_qty)::INTEGER;
            IF v_quantity < 1 THEN
                v_skipped := v_skipped + 1;
                CONTINUE;
            END IF;

            v_action_id := v_action_long_id;
            v_direction := 'SELL';
            v_broker_order_id := NULL;
            v_status := 'filled';
            v_note := NULL;

            IF NOT v_is_simulated THEN
                BEGIN
                    SELECT sp.tbank_figi INTO v_figi
                    FROM security_prefixes sp
                    WHERE sp.security_id = v_sec.security_id
                      AND sp.tbank_figi IS NOT NULL
                    ORDER BY sp.exchange_id
                    LIMIT 1;

                    IF v_figi IS NULL THEN
                        v_status := 'rejected';
                        v_note := 'Нет tbank_figi для бумаги';
                    ELSE
                        v_order := tbank_post_order(
                            v_logic.account_id, v_figi, v_quantity, v_price, v_direction
                        );
                        v_broker_order_id := COALESCE(
                            v_order->>'orderId',
                            v_order->>'order_id',
                            v_order->'orderState'->>'orderId'
                        );
                        IF v_broker_order_id IS NOT NULL THEN
                            v_status := 'submitted';
                        ELSE
                            v_status := 'rejected';
                            v_note := v_order::TEXT;
                        END IF;
                    END IF;
                EXCEPTION
                    WHEN undefined_function THEN
                        v_status := 'rejected';
                        v_note := 'tbank_post_order недоступен (нет HTTP-расширения)';
                    WHEN OTHERS THEN
                        v_status := 'rejected';
                        v_note := SQLERRM;
                END;
            END IF;

            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, signal_kind, signal_formula,
                quantity, price, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                broker_order_id, status, note
            )
            VALUES (
                p_logic_id, v_logic.account_id, v_sec.security_id, v_tf_id,
                v_side_close_id, v_action_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE, FALSE, FALSE,
                v_broker_order_id, v_status, v_note
            )
            RETURNING id INTO v_trade_id;

            IF v_status <> 'rejected' THEN
                IF v_is_simulated AND v_balance IS NOT NULL THEN
                    v_balance := logic_trade_finalize(v_trade_id, v_balance);
                    v_notional := v_quantity * v_price;
                    v_balance := v_balance + v_notional;
                    PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_balance::TEXT, 'money');
                ELSE
                    PERFORM logic_trade_finalize(v_trade_id, v_balance);
                END IF;
                v_closed := v_closed + 1;
                PERFORM logic_trade_log(
                    p_logic_id,
                    'trade.closed_market',
                    format('Закрытие long #%s qty=%s price=%s', v_trade_id, v_quantity, v_price),
                    jsonb_build_object(
                        'trade_id', v_trade_id,
                        'security_id', v_sec.security_id,
                        'action', 'Long',
                        'quantity', v_quantity,
                        'price', v_price,
                        'status', v_status
                    ),
                    v_sec.security_id,
                    v_tf_id
                );
            ELSE
                v_skipped := v_skipped + 1;
                v_errors := v_errors || jsonb_build_array(
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'action', 'Long',
                        'reason', COALESCE(v_note, 'rejected')
                    )
                );
            END IF;
        END IF;

        IF v_short_qty > 0 THEN
            v_close_idx := v_close_idx + 1;
            v_bar_dt := clock_timestamp() + (v_close_idx * interval '1 millisecond');
            v_quantity := floor(v_short_qty)::INTEGER;
            IF v_quantity < 1 THEN
                v_skipped := v_skipped + 1;
                CONTINUE;
            END IF;

            v_action_id := v_action_short_id;
            v_direction := 'BUY';
            v_broker_order_id := NULL;
            v_status := 'filled';
            v_note := NULL;

            IF NOT v_is_simulated THEN
                BEGIN
                    SELECT sp.tbank_figi INTO v_figi
                    FROM security_prefixes sp
                    WHERE sp.security_id = v_sec.security_id
                      AND sp.tbank_figi IS NOT NULL
                    ORDER BY sp.exchange_id
                    LIMIT 1;

                    IF v_figi IS NULL THEN
                        v_status := 'rejected';
                        v_note := 'Нет tbank_figi для бумаги';
                    ELSE
                        v_order := tbank_post_order(
                            v_logic.account_id, v_figi, v_quantity, v_price, v_direction
                        );
                        v_broker_order_id := COALESCE(
                            v_order->>'orderId',
                            v_order->>'order_id',
                            v_order->'orderState'->>'orderId'
                        );
                        IF v_broker_order_id IS NOT NULL THEN
                            v_status := 'submitted';
                        ELSE
                            v_status := 'rejected';
                            v_note := v_order::TEXT;
                        END IF;
                    END IF;
                EXCEPTION
                    WHEN undefined_function THEN
                        v_status := 'rejected';
                        v_note := 'tbank_post_order недоступен (нет HTTP-расширения)';
                    WHEN OTHERS THEN
                        v_status := 'rejected';
                        v_note := SQLERRM;
                END;
            END IF;

            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, signal_kind, signal_formula,
                quantity, price, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                broker_order_id, status, note
            )
            VALUES (
                p_logic_id, v_logic.account_id, v_sec.security_id, v_tf_id,
                v_side_close_id, v_action_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE, FALSE, FALSE,
                v_broker_order_id, v_status, v_note
            )
            RETURNING id INTO v_trade_id;

            IF v_status <> 'rejected' THEN
                IF v_is_simulated AND v_balance IS NOT NULL THEN
                    v_balance := logic_trade_finalize(v_trade_id, v_balance);
                    v_notional := v_quantity * v_price;
                    v_balance := v_balance - v_notional;
                    PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_balance::TEXT, 'money');
                ELSE
                    PERFORM logic_trade_finalize(v_trade_id, v_balance);
                END IF;
                v_closed := v_closed + 1;
                PERFORM logic_trade_log(
                    p_logic_id,
                    'trade.closed_market',
                    format('Закрытие short #%s qty=%s price=%s', v_trade_id, v_quantity, v_price),
                    jsonb_build_object(
                        'trade_id', v_trade_id,
                        'security_id', v_sec.security_id,
                        'action', 'Short',
                        'quantity', v_quantity,
                        'price', v_price,
                        'status', v_status
                    ),
                    v_sec.security_id,
                    v_tf_id
                );
            ELSE
                v_skipped := v_skipped + 1;
                v_errors := v_errors || jsonb_build_array(
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'action', 'Short',
                        'reason', COALESCE(v_note, 'rejected')
                    )
                );
            END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'closed', v_closed,
        'skipped', v_skipped,
        'errors', v_errors
    );
END;
$$;

COMMENT ON FUNCTION logic_close_all_positions_at_market(INTEGER, BOOLEAN) IS
'Ручное закрытие long/short по рынку; p_except_cash_funds=TRUE — не трогать TMON/LQDT/SBMM';

-- Рейтинг сигнала на логике: боевой (rating) и тестовый (rating_test) раздельно.
-- Не путать с рейтингом индикатора в справочнике indicators.
--
-- Алгоритм успеха (не «просто сработал»):
--   1) сигнал сработал на свече → pending (запомнить цену);
--   2) на СЛЕДУЮЩЕЙ свече TF: ход цены → % годовых за длительность TF;
--   3) сравнить с base_annual_rate_pct логики (по умолчанию 20);
--   4) успех → +1, неуспех → −1 (рейтинг может быть отрицательным).
-- История пишется по (signal × security); график — по бумаге.

DROP FUNCTION IF EXISTS logic_signal_record_fire(INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS logic_signal_rating_resolve_pending(INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_signal_rating_resolve_pending(INTEGER, INTEGER, TIMESTAMP, BOOLEAN);
DROP FUNCTION IF EXISTS logic_signal_rating_resolve_pending(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT);
DROP FUNCTION IF EXISTS logic_backtest_rate_signals(BIGINT, INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_backtest_reset_signal_ratings(INTEGER);
DROP FUNCTION IF EXISTS logic_signal_rating_reset_live(INTEGER);
DROP FUNCTION IF EXISTS logic_signal_rate_bar(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT);
DROP FUNCTION IF EXISTS logic_signal_move_success(TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS logic_signal_move_success(TEXT, TEXT, NUMERIC, NUMERIC, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS logic_signal_annualized_move_pct(NUMERIC, NUMERIC, INTEGER);
DROP FUNCTION IF EXISTS logic_signal_evaluate_at(INTEGER, INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_signal_evaluate_at(INTEGER, INTEGER, INTEGER, TIMESTAMP, BOOLEAN);

CREATE OR REPLACE FUNCTION get_logic_param_boolean(
    p_logic_id INTEGER,
    p_param_key TEXT,
    p_default BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_raw TEXT;
BEGIN
    v_raw := lower(btrim(COALESCE(get_logic_param_text(p_logic_id, p_param_key), '')));
    IF v_raw = '' THEN
        RETURN COALESCE(p_default, FALSE);
    END IF;
    IF v_raw IN ('true', '1', 'yes', 't', 'on', 'y') THEN
        RETURN TRUE;
    END IF;
    IF v_raw IN ('false', '0', 'no', 'f', 'off', 'n') THEN
        RETURN FALSE;
    END IF;
    RETURN COALESCE(p_default, FALSE);
END;
$$;

COMMENT ON FUNCTION get_logic_param_boolean(INTEGER, TEXT, BOOLEAN) IS
'Булев параметр logic_params (true/1/yes …); пусто → p_default';

-- Инверсия сравнения: >=↔<=, >↔< (как ReverseSignals в FINRESP / OsEngine)
CREATE OR REPLACE FUNCTION logic_invert_comparison_condition(p_condition TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v TEXT;
BEGIN
    v := btrim(COALESCE(p_condition, ''));
    IF v = '' THEN
        RETURN v;
    END IF;
    -- Сначала двухсимвольные операторы через маркеры
    v := replace(v, '>=', E'\x01');
    v := replace(v, '<=', E'\x02');
    v := replace(v, '<>', E'\x03');
    v := replace(v, '!=', E'\x04');
    -- Односимвольные > и <
    v := replace(v, '>', E'\x05');
    v := replace(v, '<', '>');
    v := replace(v, E'\x05', '<');
    -- Восстановить двухсимвольные с инверсией
    v := replace(v, E'\x01', '<=');
    v := replace(v, E'\x02', '>=');
    v := replace(v, E'\x03', '<>');
    v := replace(v, E'\x04', '!=');
    RETURN v;
END;
$$;

COMMENT ON FUNCTION logic_invert_comparison_condition(TEXT) IS
'Инверсия операторов сравнения в условии сигнала (≥↔≤, >↔<)';

CREATE OR REPLACE FUNCTION logic_signal_annualized_move_pct(
    p_move_pct NUMERIC,
    p_tf_sec INTEGER
)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(p_move_pct, 0)
         * ((365.25 * 24 * 3600) / GREATEST(COALESCE(p_tf_sec, 900), 1)::NUMERIC);
$$;

COMMENT ON FUNCTION logic_signal_annualized_move_pct(NUMERIC, INTEGER) IS
'Переводит % хода за одну свечу TF в эквивалент % годовых';

CREATE OR REPLACE FUNCTION logic_bar_annual_threshold_pct(
    p_tf_sec INTEGER,
    p_base_annual_pct NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(
        0::NUMERIC,
        COALESCE(p_base_annual_pct, 20)
            * (GREATEST(COALESCE(p_tf_sec, 900), 1)::NUMERIC / (365.25 * 24 * 3600))
    );
$$;

COMMENT ON FUNCTION logic_bar_annual_threshold_pct(INTEGER, NUMERIC) IS
'Эквивалент порога на 1 свече: base_annual × (tf_sec / год). Согласован с annualized_move >= base.';

-- Успех: годовая ставка хода в ожидаемую сторону >= base_annual_rate_pct
CREATE OR REPLACE FUNCTION logic_signal_move_success(
    p_position_side TEXT,
    p_signal_kind TEXT,
    p_price_from NUMERIC,
    p_price_to NUMERIC,
    p_tf_sec INTEGER,
    p_base_annual_pct NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_raw_pct NUMERIC;
    v_dir_pct NUMERIC;
    v_annual NUMERIC;
BEGIN
    IF p_price_from IS NULL OR p_price_to IS NULL OR p_price_from <= 0 THEN
        RETURN FALSE;
    END IF;
    v_raw_pct := ((p_price_to - p_price_from) / p_price_from) * 100.0;

    -- Ожидаемое направление: long/trend и short/counter — рост; иначе — падение
    IF lower(p_position_side) = 'long' THEN
        IF lower(p_signal_kind) = 'trend' THEN
            v_dir_pct := v_raw_pct;
        ELSE
            v_dir_pct := -v_raw_pct;
        END IF;
    ELSE
        IF lower(p_signal_kind) = 'trend' THEN
            v_dir_pct := -v_raw_pct;
        ELSE
            v_dir_pct := v_raw_pct;
        END IF;
    END IF;

    v_annual := logic_signal_annualized_move_pct(v_dir_pct, p_tf_sec);
    RETURN v_annual >= COALESCE(p_base_annual_pct, 20);
END;
$$;

COMMENT ON FUNCTION logic_signal_move_success(TEXT, TEXT, NUMERIC, NUMERIC, INTEGER, NUMERIC) IS
'Успех сигнала: (ход к следующей свече → % годовых в сторону сигнала) >= base_annual_rate_pct';

CREATE OR REPLACE FUNCTION logic_signal_evaluate_at(
    p_signal_id INTEGER,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_invert BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    ok BOOLEAN,
    close_price NUMERIC,
    ind_value NUMERIC,
    bar_dt TIMESTAMP,
    formula TEXT,
    position_event TEXT,
    position_side TEXT,
    signal_kind TEXT,
    indicator_id INTEGER
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_sig RECORD;
    v_parsed RECORD;
    v_series TEXT;
    v_bar RECORD;
    v_condition TEXT;
BEGIN
    ok := FALSE;
    SELECT lis.id, lis.formula, lis.position_event, lis.position_side, lis.signal_kind, lis.indicator_id
    INTO v_sig
    FROM logic_indicator_signals lis
    WHERE lis.id = p_signal_id AND lis.is_active = TRUE;
    IF NOT FOUND THEN
        RETURN NEXT;
        RETURN;
    END IF;

    formula := v_sig.formula;
    position_event := v_sig.position_event;
    position_side := v_sig.position_side;
    signal_kind := v_sig.signal_kind;
    indicator_id := v_sig.indicator_id;

    SELECT * INTO v_parsed FROM parse_signal_formula(v_sig.formula);
    IF NOT COALESCE(v_parsed.valid, FALSE) THEN
        RETURN NEXT;
        RETURN;
    END IF;
    v_series := parse_signal_series(v_parsed.params);
    SELECT * INTO v_bar FROM logic_bar_data_at(
        p_security_id, p_tf_id, v_sig.indicator_id, v_series, p_bar_dt
    );
    IF NOT FOUND THEN
        RETURN NEXT;
        RETURN;
    END IF;
    close_price := v_bar.close_price;
    ind_value := v_bar.ind_value;
    bar_dt := v_bar.bar_dt;
    v_condition := v_parsed.condition;
    IF COALESCE(p_invert, FALSE) THEN
        v_condition := logic_invert_comparison_condition(v_condition);
    END IF;
    ok := evaluate_signal_condition(v_condition, v_bar.close_price, v_bar.ind_value);
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION logic_signal_record_fire(
    p_signal_id INTEGER,
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_price NUMERIC,
    p_position_side TEXT,
    p_signal_kind TEXT,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    -- Только запоминаем: ±1 ставится на следующей свече в resolve_pending
    INSERT INTO logic_signal_rating_pending (
        signal_id, logic_id, security_id, timeframe_id,
        bar_dt, price, position_side, signal_kind, is_test, run_id
    )
    VALUES (
        p_signal_id, p_logic_id, p_security_id, p_tf_id,
        p_bar_dt, p_price, p_position_side, p_signal_kind,
        COALESCE(p_is_test, FALSE), p_run_id
    )
    ON CONFLICT (signal_id, security_id, bar_dt, is_test) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION logic_signal_rating_resolve_pending(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_asof_bar_dt TIMESTAMP DEFAULT NULL,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_tf_sec INTEGER;
    v_annual NUMERIC;
    v_pend RECORD;
    v_next_dt TIMESTAMP;
    v_next_close NUMERIC;
    v_ok BOOLEAN;
    v_delta INTEGER;
    v_new_rating INTEGER;
    v_sec_rating INTEGER;
    v_resolved INTEGER := 0;
BEGIN
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_tf_id;
    v_annual := get_logic_param_numeric(p_logic_id, 'base_annual_rate_pct', 20);

    FOR v_pend IN
        SELECT p.*
        FROM logic_signal_rating_pending p
        WHERE p.logic_id = p_logic_id
          AND p.timeframe_id = p_tf_id
          AND p.is_test = COALESCE(p_is_test, FALSE)
          AND (p_run_id IS NULL OR p.run_id IS NULL OR p.run_id = p_run_id)
          AND (p_asof_bar_dt IS NULL OR p.bar_dt < p_asof_bar_dt)
        ORDER BY p.bar_dt, p.id
    LOOP
        IF p_run_id IS NOT NULL
           AND v_resolved > 0
           AND (v_resolved % 50) = 0
           AND logic_backtest_cancel_requested(p_run_id) THEN
            RETURN v_resolved;
        END IF;

        SELECT p.dt, p.close_price
        INTO v_next_dt, v_next_close
        FROM prices p
        WHERE p.security_id = v_pend.security_id
          AND p.timeframe_id = p_tf_id
          AND p.dt > v_pend.bar_dt
          AND (p_asof_bar_dt IS NULL OR p.dt <= p_asof_bar_dt)
        ORDER BY p.dt
        LIMIT 1;

        IF v_next_dt IS NULL THEN
            CONTINUE;
        END IF;

        v_ok := logic_signal_move_success(
            v_pend.position_side, v_pend.signal_kind,
            v_pend.price, v_next_close, v_tf_sec, v_annual
        );
        v_delta := CASE WHEN v_ok THEN 1 ELSE -1 END;

        -- Глобальный рейтинг сигнала (сумма по всем бумагам), может быть < 0
        IF COALESCE(p_is_test, FALSE) THEN
            UPDATE logic_indicator_signals lis
            SET rating_test = lis.rating_test + v_delta
            WHERE lis.id = v_pend.signal_id
            RETURNING rating_test INTO v_new_rating;
        ELSE
            UPDATE logic_indicator_signals lis
            SET rating = lis.rating + v_delta
            WHERE lis.id = v_pend.signal_id
            RETURNING rating INTO v_new_rating;
        END IF;

        -- Рейтинг на бумаге для графика
        SELECT COALESCE((
            SELECT h.rating
            FROM logic_signal_rating_history h
            WHERE h.signal_id = v_pend.signal_id
              AND h.security_id = v_pend.security_id
              AND h.is_test = COALESCE(p_is_test, FALSE)
              AND (p_run_id IS NULL OR h.run_id IS NULL OR h.run_id = p_run_id OR h.run_id = v_pend.run_id)
            ORDER BY h.bar_dt DESC, h.id DESC
            LIMIT 1
        ), 0) + v_delta
        INTO v_sec_rating;

        INSERT INTO logic_signal_rating_history (
            signal_id, logic_id, security_id, run_id, bar_dt, rating, delta, is_test
        )
        VALUES (
            v_pend.signal_id, p_logic_id, v_pend.security_id,
            COALESCE(p_run_id, v_pend.run_id),
            v_next_dt, v_sec_rating, v_delta,
            COALESCE(p_is_test, FALSE)
        );

        DELETE FROM logic_signal_rating_pending WHERE id = v_pend.id;
        v_resolved := v_resolved + 1;
    END LOOP;

    RETURN v_resolved;
END;
$$;

COMMENT ON FUNCTION logic_signal_rating_resolve_pending(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'На следующей свече: годовая ставка хода vs base_annual_rate_pct → ±1; history по бумаге';

-- Общий проход по бару: resolve pending + запись срабатываний (бой или тест)
CREATE OR REPLACE FUNCTION logic_signal_rate_bar(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_sig RECORD;
    v_eval RECORD;
    v_fires INTEGER := 0;
BEGIN
    IF p_run_id IS NOT NULL AND logic_backtest_cancel_requested(p_run_id) THEN
        RETURN 0;
    END IF;

    PERFORM logic_signal_rating_resolve_pending(
        p_logic_id, p_tf_id, p_bar_dt, COALESCE(p_is_test, FALSE), p_run_id
    );

    IF p_run_id IS NOT NULL AND logic_backtest_cancel_requested(p_run_id) THEN
        RETURN v_fires;
    END IF;

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        IF p_run_id IS NOT NULL AND logic_backtest_cancel_requested(p_run_id) THEN
            RETURN v_fires;
        END IF;

        FOR v_sig IN
            SELECT lis.id, lis.position_side, lis.signal_kind
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            ORDER BY lis.display_order, lis.id
        LOOP
            SELECT * INTO v_eval
            FROM logic_signal_evaluate_at(
                v_sig.id, v_sec.security_id, p_tf_id, p_bar_dt
            );
            IF COALESCE(v_eval.ok, FALSE) AND v_eval.close_price IS NOT NULL THEN
                PERFORM logic_signal_record_fire(
                    v_sig.id, p_logic_id, v_sec.security_id, p_tf_id,
                    v_eval.bar_dt, v_eval.close_price,
                    v_sig.position_side, v_sig.signal_kind,
                    COALESCE(p_is_test, FALSE), p_run_id
                );
                v_fires := v_fires + 1;
            END IF;
        END LOOP;
    END LOOP;

    RETURN v_fires;
END;
$$;

COMMENT ON FUNCTION logic_signal_rate_bar(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'По одной свече TF: resolve pending ±1 + record_fire для всех сигналов×бумаг (бой/тест)';

CREATE OR REPLACE FUNCTION logic_backtest_rate_signals(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
BEGIN
    RETURN logic_signal_rate_bar(p_logic_id, p_tf_id, p_bar_dt, TRUE, p_run_id);
END;
$$;

COMMENT ON FUNCTION logic_backtest_rate_signals(BIGINT, INTEGER, INTEGER, TIMESTAMP) IS
'Бэктест: обёртка logic_signal_rate_bar(..., is_test=true)';

CREATE OR REPLACE FUNCTION logic_backtest_reset_signal_ratings(p_logic_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE logic_indicator_signals
    SET rating_test = 0
    WHERE logic_id = p_logic_id;

    DELETE FROM logic_signal_rating_pending
    WHERE logic_id = p_logic_id AND is_test = TRUE;

    DELETE FROM logic_signal_rating_history
    WHERE logic_id = p_logic_id AND is_test = TRUE;
END;
$$;

COMMENT ON FUNCTION logic_backtest_reset_signal_ratings(INTEGER) IS
'Сброс тестового рейтинга и истории перед новым прогоном бэктеста';

CREATE OR REPLACE FUNCTION logic_signal_rating_reset_live(p_logic_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE logic_indicator_signals
    SET rating = 0
    WHERE logic_id = p_logic_id;

    DELETE FROM logic_signal_rating_pending
    WHERE logic_id = p_logic_id AND is_test = FALSE;

    DELETE FROM logic_signal_rating_history
    WHERE logic_id = p_logic_id AND is_test = FALSE;
END;
$$;

COMMENT ON FUNCTION logic_signal_rating_reset_live(INTEGER) IS
'Сброс боевого рейтинга и истории перед предрасчётом при включении логики';

-- Подготовка данных окна предрасчёта: цены + индикаторы сигналов логики
CREATE OR REPLACE PROCEDURE logic_rating_precalc_ensure_data(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_lookback_days INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_sig RECORD;
    v_tf_sec INTEGER;
    v_date_from DATE;
    v_date_to DATE;
    v_point_count INTEGER;
    v_end_dt TIMESTAMP;
    v_days INTEGER;
    v_err TEXT;
BEGIN
    v_days := GREATEST(1, LEAST(90, COALESCE(p_lookback_days, 7)));
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;
    IF v_tf_sec IS NULL OR v_tf_sec <= 0 THEN
        RAISE EXCEPTION 'logic_rating_precalc_ensure_data: неизвестный timeframe_id %', p_timeframe_id;
    END IF;

    v_date_to := CURRENT_DATE;
    -- M1/M2: у T-Bank обычно только текущий день
    IF COALESCE(v_tf_sec, 0) <= 120 THEN
        v_date_from := v_date_to;
    ELSE
        v_date_from := v_date_to - v_days;
    END IF;

    v_point_count := GREATEST(
        logic_trade_sync_point_count(v_tf_sec),
        (CEIL(v_days * 86400.0 / v_tf_sec)::INTEGER) + 80
    );
    v_end_dt := logic_last_closed_bar_dt(v_tf_sec, LOCALTIMESTAMP);

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        ORDER BY ls.display_order, ls.security_id
    LOOP
        BEGIN
            CALL load_prices(v_sec.security_id, p_timeframe_id, v_date_from, v_date_to);
        EXCEPTION
            WHEN undefined_function THEN
                NULL;
            WHEN OTHERS THEN
                v_err := SQLERRM;
                PERFORM logic_trade_log(
                    p_logic_id,
                    'rating.precalc.prices.error',
                    format('Предрасчёт: ошибка цен sec=%s: %s', v_sec.security_id, v_err),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'date_from', v_date_from,
                        'date_to', v_date_to,
                        'error', v_err
                    ),
                    v_sec.security_id,
                    p_timeframe_id
                );
        END;

        FOR v_sig IN
            SELECT DISTINCT lis.indicator_id
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
        LOOP
            BEGIN
                CALL ensure_security_indicator_series(v_sec.security_id, v_sig.indicator_id);
                CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sec.security_id);
                CALL sync_security_indicator_series_for_indicator(
                    v_sec.security_id,
                    v_sig.indicator_id,
                    p_timeframe_id,
                    v_end_dt,
                    v_point_count,
                    FALSE
                );
            EXCEPTION WHEN OTHERS THEN
                v_err := SQLERRM;
                PERFORM logic_trade_log(
                    p_logic_id,
                    'rating.precalc.indicator.error',
                    format('Предрасчёт: ошибка индикатора sec=%s ind=%s: %s',
                           v_sec.security_id, v_sig.indicator_id, v_err),
                    jsonb_build_object(
                        'security_id', v_sec.security_id,
                        'indicator_id', v_sig.indicator_id,
                        'error', v_err
                    ),
                    v_sec.security_id,
                    p_timeframe_id
                );
            END;
        END LOOP;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_rating_precalc_ensure_data(INTEGER, INTEGER, INTEGER) IS
'Перед боевым предрасчётом рейтинга: load_prices на lookback + sync индикаторов сигналов логики';

CREATE OR REPLACE FUNCTION prices_have_closed_bar(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_closed_bar_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt = p_closed_bar_dt
    );
$$;

COMMENT ON FUNCTION prices_have_closed_bar(INTEGER, INTEGER, TIMESTAMP) IS
'True если в prices уже есть свеча ровно на closed bar — load_prices можно пропустить';

-- Если история уже есть — догружаем только день закрытого бара (1 HTTP), не весь lookback.
CREATE OR REPLACE FUNCTION prices_topup_date_from(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_closed_bar_dt TIMESTAMP,
    p_fallback_from DATE
)
RETURNS DATE
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt >= (p_closed_bar_dt - INTERVAL '5 days')
        LIMIT 1
    ) THEN
        RETURN p_closed_bar_dt::date;
    END IF;
    RETURN p_fallback_from;
END;
$$;

COMMENT ON FUNCTION prices_topup_date_from(INTEGER, INTEGER, TIMESTAMP, DATE) IS
'date_from для load_prices: день closed bar, если в БД уже есть недавние свечи';

CREATE OR REPLACE FUNCTION indicator_has_closed_bar(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_closed_bar_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM indicator_values iv
        WHERE iv.security_id = p_security_id
          AND iv.timeframe_id = p_timeframe_id
          AND iv.indicator_id = p_indicator_id
          AND iv.dt = p_closed_bar_dt
        LIMIT 1
    );
$$;

COMMENT ON FUNCTION indicator_has_closed_bar(INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'True если индикатор уже посчитан на closed bar';

-- Early exit: все бумаги уже имеют closed-свечу — не трогаем HTTP/sync.
CREATE OR REPLACE PROCEDURE logic_refresh_market_data(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_closed_bar_dt TIMESTAMP
)
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_sig RECORD;
    v_date_from DATE;
    v_date_to DATE;
    v_point_count INTEGER;
    v_tf_sec INTEGER;
    v_err TEXT;
    v_skip_http BOOLEAN := FALSE;
    v_missing_prices INTEGER;
BEGIN
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;

    v_point_count := logic_trade_sync_point_count(v_tf_sec);
    v_date_to := GREATEST(p_closed_bar_dt::date, CURRENT_DATE);
    v_date_from := logic_trade_load_date_from(v_tf_sec, v_point_count, p_closed_bar_dt);

    SELECT EXISTS (
        SELECT 1
        FROM logic_backtest_runs r
        WHERE r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
    ) INTO v_skip_http;

    SELECT COUNT(*)::INTEGER INTO v_missing_prices
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id
      AND ls.is_active = TRUE
      AND NOT prices_have_closed_bar(ls.security_id, p_timeframe_id, p_closed_bar_dt);

    -- Быстрый путь: цены на closed bar есть у всех — только недостающие индикаторы, без HTTP.
    IF v_missing_prices = 0 THEN
        FOR v_sec IN
            SELECT ls.security_id
            FROM logic_securities ls
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        LOOP
            FOR v_sig IN
                SELECT DISTINCT lis.indicator_id
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            LOOP
                IF indicator_has_closed_bar(
                    v_sec.security_id, p_timeframe_id, v_sig.indicator_id, p_closed_bar_dt
                ) THEN
                    CONTINUE;
                END IF;
                BEGIN
                    CALL ensure_security_indicator_series(v_sec.security_id, v_sig.indicator_id);
                    CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sec.security_id);
                    CALL sync_security_indicator_series_for_indicator(
                        v_sec.security_id,
                        v_sig.indicator_id,
                        p_timeframe_id,
                        p_closed_bar_dt,
                        v_point_count,
                        TRUE
                    );
                EXCEPTION
                    WHEN OTHERS THEN
                        v_err := SQLERRM;
                        PERFORM logic_trade_log(
                            p_logic_id,
                            'trade.indicator.error',
                            format('Ошибка расчёта индикатора id=%s sec=%s: %s', v_sig.indicator_id, v_sec.security_id, v_err),
                            jsonb_build_object(
                                'security_id', v_sec.security_id,
                                'indicator_id', v_sig.indicator_id,
                                'error', v_err
                            ),
                            v_sec.security_id,
                            p_timeframe_id
                        );
                END;
            END LOOP;
        END LOOP;
        RETURN;
    END IF;

    IF v_skip_http THEN
        PERFORM logic_trade_log(
            p_logic_id,
            'trade.prices.skip_http',
            'Пропуск load_prices: активен бэктест (используем уже загруженные цены)',
            jsonb_build_object('closed_bar', p_closed_bar_dt),
            NULL,
            p_timeframe_id
        );
    END IF;

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        -- Повторный HTTP на уже имеющуюся closed-свечу блокирует API / раскрытие бумаги
        IF NOT v_skip_http
           AND NOT prices_have_closed_bar(v_sec.security_id, p_timeframe_id, p_closed_bar_dt) THEN
            BEGIN
                CALL load_prices(
                    v_sec.security_id,
                    p_timeframe_id,
                    prices_topup_date_from(
                        v_sec.security_id, p_timeframe_id, p_closed_bar_dt, v_date_from
                    ),
                    v_date_to
                );
            EXCEPTION
                WHEN undefined_function THEN
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.prices.error',
                        'load_prices недоступен (нет HTTP-расширения)',
                        jsonb_build_object('security_id', v_sec.security_id),
                        v_sec.security_id,
                        p_timeframe_id
                    );
                WHEN OTHERS THEN
                    v_err := SQLERRM;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.prices.error',
                        format('Ошибка загрузки цен sec=%s: %s', v_sec.security_id, v_err),
                        jsonb_build_object('security_id', v_sec.security_id, 'error', v_err),
                        v_sec.security_id,
                        p_timeframe_id
                    );
            END;
        END IF;

        FOR v_sig IN
            SELECT DISTINCT lis.indicator_id
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
        LOOP
            IF indicator_has_closed_bar(
                v_sec.security_id, p_timeframe_id, v_sig.indicator_id, p_closed_bar_dt
            ) THEN
                CONTINUE;
            END IF;
            BEGIN
                CALL ensure_security_indicator_series(v_sec.security_id, v_sig.indicator_id);
                CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sec.security_id);
                CALL sync_security_indicator_series_for_indicator(
                    v_sec.security_id,
                    v_sig.indicator_id,
                    p_timeframe_id,
                    p_closed_bar_dt,
                    v_point_count,
                    TRUE
                );
            EXCEPTION
                WHEN OTHERS THEN
                    v_err := SQLERRM;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.indicator.error',
                        format('Ошибка расчёта индикатора id=%s sec=%s: %s', v_sig.indicator_id, v_sec.security_id, v_err),
                        jsonb_build_object(
                            'security_id', v_sec.security_id,
                            'indicator_id', v_sig.indicator_id,
                            'error', v_err
                        ),
                        v_sec.security_id,
                        p_timeframe_id
                    );
            END;
        END LOOP;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_refresh_market_data(INTEGER, INTEGER, TIMESTAMP) IS
'Перед проверкой сигналов: load_prices (кроме активного бэктеста) + ensure/sync индикаторов логики на TF';

CREATE OR REPLACE FUNCTION process_logic_trades(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_tf_id INTEGER;
    v_tf_sec INTEGER;
    v_position_size_pct NUMERIC;
    v_max_positions INTEGER;
    v_max_order_amount NUMERIC;
    v_sizing_base NUMERIC;
    v_balance NUMERIC;
    v_open_positions INTEGER;
    v_created INTEGER := 0;
    v_side_open_id INTEGER;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_grp RECORD;
    v_sig RECORD;
    v_sec RECORD;
    v_eval RECORD;
    v_pp NUMERIC;
    v_held_long NUMERIC;
    v_held_short NUMERIC;
    v_is_open_event BOOLEAN;
    v_quantity INTEGER;
    v_side_id INTEGER;
    v_action_id INTEGER;
    v_direction TEXT;
    v_is_simulated BOOLEAN;
    v_is_shadow BOOLEAN;
    v_broker_order_id TEXT;
    v_status TEXT;
    v_note TEXT;
    v_trade_id BIGINT;
    v_figi TEXT;
    v_order JSONB;
    v_notional NUMERIC;
    v_is_open BOOLEAN;
    v_closed_bar_dt TIMESTAMP;
    v_last_bar_raw TEXT;
    v_last_bar_dt TIMESTAMP;
    v_all_ok BOOLEAN;
    v_formulas TEXT;
    v_signal_kind TEXT;
    v_ind_dt TIMESTAMP;
    v_lot_size INTEGER;
    v_is_futures BOOLEAN;
    v_inversion BOOLEAN;
    v_eff_inversion BOOLEAN;
    v_eff_side TEXT;
BEGIN
    SELECT l.id, l.account_id, a.account_type,
           COALESCE(l.portfolio_trading_paused, FALSE) AS portfolio_trading_paused
    INTO v_logic
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id
      AND l.is_enabled = TRUE
      AND a.is_active = TRUE;

    IF NOT FOUND THEN
        PERFORM logic_trade_log(p_logic_id, 'logic.skip', 'Логика выключена или счёт неактивен');
        RETURN 0;
    END IF;

    v_tf_id := logic_resolve_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        PERFORM logic_trade_log(p_logic_id, 'logic.skip', 'Не задан timeframe в logic_params');
        RETURN 0;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = v_tf_id;

    v_closed_bar_dt := logic_last_closed_bar_dt(v_tf_sec);
    IF v_closed_bar_dt IS NULL THEN
        PERFORM logic_trade_log(p_logic_id, 'logic.skip', 'Не удалось вычислить закрытую свечу TF', NULL, NULL, v_tf_id);
        RETURN 0;
    END IF;

    v_last_bar_raw := btrim(COALESCE(get_logic_param_text(p_logic_id, 'last_trade_bar_dt'), ''));
    IF v_last_bar_raw <> '' THEN
        BEGIN
            v_last_bar_dt := v_last_bar_raw::TIMESTAMP;
            IF v_closed_bar_dt <= v_last_bar_dt THEN
                PERFORM logic_trade_log(
                    p_logic_id,
                    'trade.bar_skip',
                    format('Свеча %s уже обработана (last=%s)', v_closed_bar_dt, v_last_bar_dt),
                    jsonb_build_object('closed_bar', v_closed_bar_dt, 'last_bar', v_last_bar_dt),
                    NULL,
                    v_tf_id
                );
                RETURN 0;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
    END IF;

    SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    IF v_side_open_id IS NULL OR v_side_close_id IS NULL
       OR v_action_long_id IS NULL OR v_action_short_id IS NULL THEN
        RETURN 0;
    END IF;

    v_position_size_pct := get_logic_param_numeric(p_logic_id, 'position_size_pct', 10);
    v_max_positions := GREATEST(1, get_logic_param_numeric(p_logic_id, 'max_open_positions', 5)::INTEGER);
    v_max_order_amount := get_logic_param_numeric(p_logic_id, 'max_order_amount', NULL);
    v_inversion := get_logic_param_boolean(p_logic_id, 'inversion', FALSE);
    v_balance := logic_ensure_balance(p_logic_id);
    v_sizing_base := logic_position_sizing_base(p_logic_id, v_tf_id);
    v_open_positions := logic_count_open_positions(p_logic_id);

    IF NOT EXISTS (
        SELECT 1 FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
    ) OR NOT EXISTS (
        SELECT 1 FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    ) THEN
        PERFORM logic_trade_log(p_logic_id, 'logic.skip', 'Нет активных сигналов или бумаг');
        RETURN 0;
    END IF;

    CALL logic_refresh_market_data(p_logic_id, v_tf_id, v_closed_bar_dt);

    -- Рейтинг сигнала на логике: проверить прошлые срабатывания на следующей свече
    PERFORM logic_signal_rating_resolve_pending(p_logic_id, v_tf_id, v_closed_bar_dt);

    PERFORM logic_ensure_non_trading_periods(p_logic_id);

    -- EOD: закрыть позиции (кроме фондов) на первой свече вечернего окна / последней свече дня
    IF logic_is_eod_close_bar(
        p_logic_id,
        v_closed_bar_dt,
        v_last_bar_dt,
        v_closed_bar_dt + make_interval(secs => v_tf_sec)
    ) THEN
        PERFORM logic_close_positions_eod_except_funds(p_logic_id);
        v_balance := logic_ensure_balance(p_logic_id);
        v_sizing_base := logic_position_sizing_base(p_logic_id, v_tf_id);
        v_open_positions := logic_count_open_positions(p_logic_id);
    END IF;

    IF logic_is_non_trading_dt(p_logic_id, v_closed_bar_dt) THEN
        PERFORM logic_trade_log(
            p_logic_id,
            'trade.non_trading_skip',
            format('Неторговый период: свеча %s — сигналы пропущены', v_closed_bar_dt),
            jsonb_build_object('closed_bar', v_closed_bar_dt),
            NULL,
            v_tf_id
        );
        PERFORM logic_upsert_param(
            p_logic_id,
            'last_trade_check_at',
            to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS'),
            'text'
        );
        PERFORM logic_upsert_param(
            p_logic_id,
            'last_trade_bar_dt',
            to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'),
            'text'
        );
        RETURN 0;
    END IF;

    PERFORM logic_trade_log(
        p_logic_id,
        'trade.bar_check',
        format('Проверка AND-сигналов на закрытой свече %s', v_closed_bar_dt),
        jsonb_build_object('closed_bar', v_closed_bar_dt, 'timeframe_id', v_tf_id),
        NULL,
        v_tf_id
    );

    FOR v_sec IN
        SELECT
            ls.security_id,
            COALESCE(ls.real_trading_paused, FALSE) AS real_trading_paused,
            COALESCE(ls.real_trading_inverted, FALSE) AS real_trading_inverted
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
          -- Денежный фонд только для парковки кэша, не для сигналов
          AND NOT logic_is_cash_fund_security(ls.security_id)
    LOOP
        v_is_shadow := v_sec.real_trading_paused OR COALESCE(v_logic.portfolio_trading_paused, FALSE);
        v_eff_inversion := (v_inversion <> COALESCE(v_sec.real_trading_inverted, FALSE));
        v_lot_size := logic_security_lot_size(v_sec.security_id);
        v_is_futures := logic_security_is_futures(v_sec.security_id);

        FOR v_grp IN
            SELECT lis.position_event, lis.position_side
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            GROUP BY lis.position_event, lis.position_side
            ORDER BY lis.position_event, lis.position_side
        LOOP
            v_all_ok := TRUE;
            v_formulas := NULL;
            v_signal_kind := NULL;
            v_pp := NULL;
            v_ind_dt := NULL;

            FOR v_sig IN
                SELECT lis.id, lis.position_event, lis.position_side, lis.signal_kind, lis.formula, lis.indicator_id
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id
                  AND lis.is_active = TRUE
                  AND lis.position_event = v_grp.position_event
                  AND lis.position_side = v_grp.position_side
                ORDER BY lis.display_order, lis.id
            LOOP
                SELECT * INTO v_eval
                FROM logic_signal_evaluate_at(
                    v_sig.id, v_sec.security_id, v_tf_id, v_closed_bar_dt, v_eff_inversion
                );

                IF v_eval.close_price IS NULL THEN
                    v_all_ok := FALSE;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.not_ready',
                        format(
                            'Нет данных на свече %s для security=%s signal=%s',
                            v_closed_bar_dt, v_sec.security_id, v_sig.formula
                        ),
                        jsonb_build_object(
                            'closed_bar', v_closed_bar_dt,
                            'security_id', v_sec.security_id,
                            'formula', v_sig.formula,
                            'position_event', v_grp.position_event,
                            'position_side', v_grp.position_side
                        ),
                        v_sec.security_id,
                        v_tf_id
                    );
                    CONTINUE;
                END IF;

                IF v_signal_kind IS NULL THEN
                    v_signal_kind := v_sig.signal_kind;
                    v_pp := v_eval.close_price;
                    v_ind_dt := v_eval.bar_dt;
                END IF;
                v_formulas := CASE
                    WHEN v_formulas IS NULL THEN v_sig.formula
                    ELSE v_formulas || ' AND ' || v_sig.formula
                END;

                IF COALESCE(v_eval.ok, FALSE) THEN
                    PERFORM logic_signal_record_fire(
                        v_sig.id, p_logic_id, v_sec.security_id, v_tf_id,
                        v_eval.bar_dt, v_eval.close_price,
                        v_sig.position_side, v_sig.signal_kind
                    );
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.signal_hit',
                        format(
                            'Сигнал %s/%s/%s: %s',
                            v_sig.position_event, v_sig.position_side, v_sig.signal_kind, v_sig.formula
                        ),
                        jsonb_build_object(
                            'formula', v_sig.formula,
                            'position_event', v_sig.position_event,
                            'pp', v_eval.close_price,
                            'ind_value', v_eval.ind_value,
                            'bar_dt', v_eval.bar_dt
                        ),
                        v_sec.security_id,
                        v_tf_id
                    );
                ELSE
                    v_all_ok := FALSE;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.signal_skip',
                        format(
                            'Условие не выполнено: %s (pp=%s, value=%s)',
                            v_sig.formula, v_eval.close_price, v_eval.ind_value
                        ),
                        jsonb_build_object(
                            'formula', v_sig.formula,
                            'position_event', v_sig.position_event,
                            'signal_kind', v_sig.signal_kind,
                            'position_side', v_sig.position_side,
                            'pp', v_eval.close_price,
                            'ind_value', v_eval.ind_value,
                            'bar_dt', v_eval.bar_dt
                        ),
                        v_sec.security_id,
                        v_tf_id
                    );
                END IF;
            END LOOP;

            IF NOT v_all_ok OR v_pp IS NULL OR v_formulas IS NULL THEN
                CONTINUE;
            END IF;

            v_eff_side := lower(COALESCE(v_grp.position_side, 'long'));
            IF v_eff_inversion THEN
                v_eff_side := CASE WHEN v_eff_side = 'long' THEN 'short' ELSE 'long' END;
            END IF;

            v_held_long := CASE
                WHEN v_eff_side = 'long'
                THEN logic_long_position_qty(p_logic_id, v_sec.security_id, v_is_shadow)
                ELSE 0
            END;
            v_held_short := CASE
                WHEN v_eff_side = 'short'
                THEN logic_short_position_qty(p_logic_id, v_sec.security_id, v_is_shadow)
                ELSE 0
            END;
            v_is_open_event := COALESCE(v_grp.position_event, 'open') = 'open';

            IF v_eff_side = 'long' THEN
                IF v_is_open_event THEN
                    IF v_held_long > 0 OR (NOT v_is_shadow AND v_open_positions >= v_max_positions) THEN
                        CONTINUE;
                    END IF;
                    v_sizing_base := logic_position_sizing_base(p_logic_id, v_tf_id);
                    v_quantity := logic_calc_open_quantity(
                        v_sizing_base, v_position_size_pct, v_pp, v_lot_size, v_max_order_amount
                    );
                    IF v_quantity < v_lot_size THEN
                        -- Фьючерсы: % депозита / цена контракта часто даёт 0 → 1 лот
                        -- (только при известной базе; акции — без force 1 лот)
                        IF v_is_futures AND v_sizing_base IS NOT NULL AND v_sizing_base > 0 THEN
                            v_quantity := v_lot_size;
                        ELSE
                            CONTINUE;
                        END IF;
                    END IF;
                    v_side_id := v_side_open_id;
                    v_action_id := v_action_long_id;
                    v_direction := 'BUY';
                ELSE
                    IF v_held_long <= 0 THEN
                        CONTINUE;
                    END IF;
                    v_quantity := v_held_long::INTEGER;
                    v_side_id := v_side_close_id;
                    v_action_id := v_action_long_id;
                    v_direction := 'SELL';
                END IF;
            ELSIF v_is_open_event THEN
                IF v_held_short > 0 OR (NOT v_is_shadow AND v_open_positions >= v_max_positions) THEN
                    CONTINUE;
                END IF;
                v_sizing_base := logic_position_sizing_base(p_logic_id, v_tf_id);
                v_quantity := logic_calc_open_quantity(
                    v_sizing_base, v_position_size_pct, v_pp, v_lot_size, v_max_order_amount
                );
                IF v_quantity < v_lot_size THEN
                    IF v_is_futures AND v_sizing_base IS NOT NULL AND v_sizing_base > 0 THEN
                        v_quantity := v_lot_size;
                    ELSE
                        CONTINUE;
                    END IF;
                END IF;
                v_side_id := v_side_open_id;
                v_action_id := v_action_short_id;
                v_direction := 'SELL';
            ELSE
                IF v_held_short <= 0 THEN
                    CONTINUE;
                END IF;
                v_quantity := v_held_short::INTEGER;
                v_side_id := v_side_close_id;
                v_action_id := v_action_short_id;
                v_direction := 'BUY';
            END IF;

            v_is_simulated := v_logic.account_type = 'fake';
            v_broker_order_id := NULL;
            v_status := 'filled';
            v_note := NULL;

            IF v_logic.account_type <> 'fake' THEN
                v_is_simulated := FALSE;
                BEGIN
                    SELECT sp.tbank_figi INTO v_figi
                    FROM security_prefixes sp
                    WHERE sp.security_id = v_sec.security_id
                      AND sp.tbank_figi IS NOT NULL
                    ORDER BY sp.exchange_id
                    LIMIT 1;

                    IF v_figi IS NULL THEN
                        v_status := 'rejected';
                        v_note := 'Нет tbank_figi для бумаги';
                    ELSE
                        v_order := tbank_post_order(
                            v_logic.account_id, v_figi, v_quantity, v_pp, v_direction
                        );
                        v_broker_order_id := COALESCE(
                            v_order->>'orderId',
                            v_order->>'order_id',
                            v_order->'orderState'->>'orderId'
                        );
                        IF v_broker_order_id IS NOT NULL THEN
                            v_status := 'submitted';
                        ELSE
                            v_status := 'rejected';
                            v_note := v_order::TEXT;
                        END IF;
                    END IF;
                EXCEPTION
                    WHEN undefined_function THEN
                        v_status := 'rejected';
                        v_note := 'tbank_post_order недоступен (нет HTTP-расширения)';
                    WHEN OTHERS THEN
                        v_status := 'rejected';
                        v_note := SQLERRM;
                END;
            END IF;

            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, position_event, signal_kind, signal_formula,
                quantity, price, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                broker_order_id, status, note
            )
            VALUES (
                p_logic_id, v_logic.account_id, v_sec.security_id, v_tf_id,
                v_side_id, v_action_id, v_grp.position_event, v_signal_kind, v_formulas,
                v_quantity, v_pp, v_ind_dt, v_is_simulated, FALSE, v_is_shadow, FALSE,
                v_broker_order_id, v_status, v_note
            )
            ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow) DO NOTHING
            RETURNING id INTO v_trade_id;

            IF v_trade_id IS NULL THEN
                CONTINUE;
            END IF;

            v_created := v_created + 1;

            IF NOT v_is_shadow AND v_logic.account_type = 'fake' AND v_balance IS NOT NULL AND v_status <> 'rejected' THEN
                v_balance := logic_trade_finalize(v_trade_id, v_balance);
                v_notional := v_quantity * v_pp;
                v_is_open := v_is_open_event;
                IF v_eff_side = 'long' THEN
                    v_balance := v_balance + CASE WHEN v_is_open THEN -v_notional ELSE v_notional END;
                ELSE
                    v_balance := v_balance + CASE WHEN v_is_open THEN v_notional ELSE -v_notional END;
                END IF;
                IF v_is_open AND NOT v_is_shadow THEN
                    v_open_positions := v_open_positions + 1;
                ELSIF NOT v_is_open AND NOT v_is_shadow THEN
                    v_open_positions := GREATEST(0, v_open_positions - 1);
                END IF;
                PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_balance::TEXT, 'money');
            ELSIF NOT v_is_shadow THEN
                PERFORM logic_trade_finalize(v_trade_id, v_balance);
                -- Real: перечитать остаток с брокера (не paper ± notional к миллиону)
                IF v_logic.account_type <> 'fake' THEN
                    v_balance := logic_ensure_balance(p_logic_id);
                END IF;
                IF v_is_open_event AND v_status <> 'rejected' THEN
                    v_open_positions := v_open_positions + 1;
                ELSIF NOT v_is_open_event AND v_status <> 'rejected' THEN
                    v_open_positions := GREATEST(0, v_open_positions - 1);
                END IF;
            ELSE
                PERFORM logic_trade_finalize(v_trade_id, NULL);
            END IF;

            PERFORM logic_trade_log(
                p_logic_id,
                'trade.created',
                format('Сделка #%s qty=%s price=%s status=%s', v_trade_id, v_quantity, v_pp, v_status),
                jsonb_build_object(
                    'trade_id', v_trade_id,
                    'quantity', v_quantity,
                    'price', v_pp,
                    'status', v_status,
                    'position_event', v_grp.position_event,
                    'position_side', v_grp.position_side,
                    'effective_side', v_eff_side,
                    'global_inversion', v_inversion,
                    'security_inversion', COALESCE(v_sec.real_trading_inverted, FALSE),
                    'signal_kind', v_signal_kind,
                    'formula', v_formulas,
                    'bar_dt', v_ind_dt
                ),
                v_sec.security_id,
                v_tf_id
            );
        END LOOP;
    END LOOP;

    PERFORM logic_upsert_param(
        p_logic_id,
        'last_trade_check_at',
        to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'text'
    );
    PERFORM logic_upsert_param(
        p_logic_id,
        'last_trade_bar_dt',
        to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'text'
    );

    IF v_created = 0 THEN
        PERFORM logic_trade_log(
            p_logic_id,
            'trade.bar_done',
            format('Свеча %s проверена, сделок не создано', v_closed_bar_dt),
            jsonb_build_object('closed_bar', v_closed_bar_dt),
            NULL,
            v_tf_id
        );
    END IF;

    RETURN v_created;
END;
$$;

COMMENT ON FUNCTION process_logic_trades(INTEGER) IS
'AND по группам (position_event × position_side): сделка только если все активные сигналы группы сработали; '
'рейтинг сигнала на логике обновляется через pending на следующей свече TF';

-- @include sql/logic_cash_fund_park.sql (stub; full after http)

CREATE OR REPLACE FUNCTION logic_ensure_cash_fund_security(
    p_logic_id INTEGER,
    p_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
    v_security_id INTEGER;
BEGIN
    v_code := upper(btrim(COALESCE(p_code, '')));

    DELETE FROM logic_securities ls
    USING security_prefixes sp
    WHERE ls.security_id = sp.security_id
      AND ls.logic_id = p_logic_id
      AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
      AND (v_code = '' OR upper(sp.prefix) <> v_code);

    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN;
    END IF;

    SELECT s.id
    INTO v_security_id
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id
    WHERE upper(sp.prefix) = v_code
    ORDER BY sp.exchange_id
    LIMIT 1;

    IF v_security_id IS NULL THEN
        RETURN;
    END IF;

    UPDATE logic_securities
    SET display_order = display_order + 1
    WHERE logic_id = p_logic_id
      AND security_id <> v_security_id
      AND display_order >= 0;

    INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
    VALUES (p_logic_id, v_security_id, 0, TRUE)
    ON CONFLICT (logic_id, security_id) DO UPDATE SET
        is_active = TRUE,
        display_order = 0;
END;
$$;

COMMENT ON FUNCTION logic_ensure_cash_fund_security(INTEGER, TEXT) IS
'Добавить выбранный денежный фонд в logic_securities с display_order=0 (верх списка)';

CREATE OR REPLACE FUNCTION logic_park_excess_cash(p_logic_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
BEGIN
    RETURN jsonb_build_object('skipped', TRUE, 'reason', 'http_unavailable');
END;
$$;

COMMENT ON FUNCTION logic_park_excess_cash(INTEGER) IS
'Stub без pgsql-http; полная реализация после CREATE EXTENSION http (sql/logic_cash_fund_park.sql)';

CREATE OR REPLACE FUNCTION run_trade_cycle()
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_total_created INTEGER := 0;
    v_total_stops INTEGER := 0;
    v_processed INTEGER := 0;
    v_skipped_bt INTEGER := 0;
    v_got_lock BOOLEAN;
BEGIN
    v_got_lock := pg_try_advisory_lock(hashtext('multilogictrade_run_trade_cycle'));
    IF NOT v_got_lock THEN
        PERFORM app_tech_log_event('trade-runner', 'cycle.skip', 'Пропуск: другой цикл уже выполняется', 'postgresql');
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'locked');
    END IF;

    IF NOT trade_runner_ui_is_active() THEN
        PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));
        PERFORM app_tech_log_event(
            'trade-runner',
            'cycle.skip',
            'Пропуск: UI не активен (закройте Angular — робот не торгует)',
            'postgresql'
        );
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'ui_inactive');
    END IF;

    PERFORM app_tech_log_event('trade-runner', 'cycle.start', 'run_trade_cycle начат', 'postgresql');

    FOR v_logic IN
        SELECT l.id
        FROM logics l
        JOIN accounts a ON a.id = l.account_id
        WHERE l.is_enabled = TRUE AND a.is_active = TRUE
        ORDER BY l.id
    LOOP
        -- Не мешать бэктесту той же логики (цены/индикаторы/сделки)
        IF EXISTS (
            SELECT 1
            FROM logic_backtest_runs r
            WHERE r.logic_id = v_logic.id
              AND r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
        ) THEN
            v_skipped_bt := v_skipped_bt + 1;
            CONTINUE;
        END IF;

        v_processed := v_processed + 1;
        v_total_stops := v_total_stops + process_logic_stops(v_logic.id);
        v_total_created := v_total_created + process_logic_trades(v_logic.id);
        PERFORM logic_park_excess_cash(v_logic.id);
    END LOOP;

    PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));

    PERFORM app_tech_log_event(
        'trade-runner',
        'cycle.end',
        format(
            'processed=%s stops=%s created=%s skip_bt=%s',
            v_processed, v_total_stops, v_total_created, v_skipped_bt
        ),
        'postgresql',
        'event',
        NULL,
        NULL,
        NULL,
        jsonb_build_object(
            'processed', v_processed,
            'stops', v_total_stops,
            'created', v_total_created,
            'skipped_backtest', v_skipped_bt
        )
    );

    RETURN jsonb_build_object(
        'processed', v_processed,
        'stops', v_total_stops,
        'created', v_total_created,
        'skipped_backtest', v_skipped_bt,
        'at', CURRENT_TIMESTAMP
    );
EXCEPTION
    WHEN OTHERS THEN
        PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));
        RAISE;
END;
$$;

COMMENT ON FUNCTION run_trade_cycle() IS
'Цикл торговли по включённым logics (пропуск логик с активным бэктестом). '
'Node fallback предпочтителен: по логике отдельно (короткие tx). pg_cron — эта функция.';

-- @include sql/logic_trading_sessions.sql
-- ============================================
-- Неторговые периоды логики + закрытие в конце дня
-- ============================================
-- day_of_week: 1=Пн … 7=Вс (ISO). Интервал [time_from, time_to] в MSK.
-- time_to включительно до секунды (сравнение <= time_to).

CREATE OR REPLACE FUNCTION logic_moex_equity_non_trading_template()
RETURNS TABLE (
    day_of_week SMALLINT,
    time_from TIME,
    time_to TIME,
    note TEXT
)
LANGUAGE sql IMMUTABLE AS $$
    -- TQBR основная сессия ≈ 10:00–18:40 МСК (пн–пт).
    -- Неторговые: ночь до открытия, вечер после сессии, выходные целиком.
    SELECT * FROM (VALUES
        (1::SMALLINT, TIME '00:00', TIME '09:59:59', 'Пн до открытия'),
        (1::SMALLINT, TIME '18:40', TIME '23:59:59', 'Пн после сессии'),
        (2::SMALLINT, TIME '00:00', TIME '09:59:59', 'Вт до открытия'),
        (2::SMALLINT, TIME '18:40', TIME '23:59:59', 'Вт после сессии'),
        (3::SMALLINT, TIME '00:00', TIME '09:59:59', 'Ср до открытия'),
        (3::SMALLINT, TIME '18:40', TIME '23:59:59', 'Ср после сессии'),
        (4::SMALLINT, TIME '00:00', TIME '09:59:59', 'Чт до открытия'),
        (4::SMALLINT, TIME '18:40', TIME '23:59:59', 'Чт после сессии'),
        (5::SMALLINT, TIME '00:00', TIME '09:59:59', 'Пт до открытия'),
        (5::SMALLINT, TIME '18:40', TIME '23:59:59', 'Пт после сессии'),
        (6::SMALLINT, TIME '00:00', TIME '23:59:59', 'Суббота'),
        (7::SMALLINT, TIME '00:00', TIME '23:59:59', 'Воскресенье')
    ) AS t(day_of_week, time_from, time_to, note);
$$;

COMMENT ON FUNCTION logic_moex_equity_non_trading_template() IS
'Шаблон неторговых окон TQBR (MOEX акции): вне 10:00–18:40 МСК пн–пт + выходные';

CREATE OR REPLACE FUNCTION logic_apply_moex_non_trading_periods(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_n INTEGER;
BEGIN
    IF p_logic_id IS NULL OR p_logic_id <= 0 THEN
        RAISE EXCEPTION 'logic_id required';
    END IF;

    DELETE FROM logic_non_trading_intervals WHERE logic_id = p_logic_id;

    INSERT INTO logic_non_trading_intervals (
        logic_id, day_of_week, time_from, time_to, note, display_order, is_active
    )
    SELECT
        p_logic_id,
        t.day_of_week,
        t.time_from,
        t.time_to,
        t.note,
        ROW_NUMBER() OVER (ORDER BY t.day_of_week, t.time_from)::INTEGER,
        TRUE
    FROM logic_moex_equity_non_trading_template() t;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION logic_apply_moex_non_trading_periods(INTEGER) IS
'Заменить неторговые интервалы логики шаблоном MOEX TQBR';

CREATE OR REPLACE FUNCTION logic_ensure_non_trading_periods(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_cnt INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_cnt
    FROM logic_non_trading_intervals
    WHERE logic_id = p_logic_id;

    IF v_cnt > 0 THEN
        RETURN v_cnt;
    END IF;

    RETURN logic_apply_moex_non_trading_periods(p_logic_id);
END;
$$;

COMMENT ON FUNCTION logic_ensure_non_trading_periods(INTEGER) IS
'Если у логики нет интервалов — поставить MOEX по умолчанию';

CREATE OR REPLACE FUNCTION logic_is_non_trading_dt(
    p_logic_id INTEGER,
    p_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_use BOOLEAN;
    v_dow SMALLINT;
    v_t TIME;
BEGIN
    v_use := get_logic_param_boolean(p_logic_id, 'use_non_trading_periods', TRUE);
    IF NOT v_use THEN
        RETURN FALSE;
    END IF;

    -- ISO: Monday=1 … Sunday=7 (PostgreSQL DOW: 0=Sun … 6=Sat)
    v_dow := EXTRACT(ISODOW FROM p_dt)::SMALLINT;
    v_t := p_dt::TIME;

    RETURN EXISTS (
        SELECT 1
        FROM logic_non_trading_intervals i
        WHERE i.logic_id = p_logic_id
          AND i.is_active
          AND i.day_of_week = v_dow
          AND v_t >= i.time_from
          AND v_t <= i.time_to
    );
END;
$$;

COMMENT ON FUNCTION logic_is_non_trading_dt(INTEGER, TIMESTAMP) IS
'True если момент в неторговом окне логики (при use_non_trading_periods)';

-- Старт вечернего неторгового окна дня (MSK), или NULL.
CREATE OR REPLACE FUNCTION logic_eod_session_end_dt(
    p_logic_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS TIMESTAMP
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_dow SMALLINT;
    v_day DATE := p_bar_dt::DATE;
    v_from TIME;
BEGIN
    v_dow := EXTRACT(ISODOW FROM p_bar_dt)::SMALLINT;
    SELECT i.time_from
    INTO v_from
    FROM logic_non_trading_intervals i
    WHERE i.logic_id = p_logic_id
      AND i.is_active
      AND i.day_of_week = v_dow
      AND i.time_from >= TIME '12:00'
    ORDER BY i.time_from ASC
    LIMIT 1;

    IF v_from IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN (v_day + v_from);
END;
$$;

COMMENT ON FUNCTION logic_eod_session_end_dt(INTEGER, TIMESTAMP) IS
'Начало вечернего неторгового окна (после основной сессии MOEX)';

-- p_prev_bar_dt / p_next_bar_dt — соседние бары прогона (могут быть NULL).
CREATE OR REPLACE FUNCTION logic_is_eod_close_bar(
    p_logic_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_prev_bar_dt TIMESTAMP,
    p_next_bar_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_trigger TIMESTAMP;
BEGIN
    IF NOT get_logic_param_boolean(p_logic_id, 'close_positions_eod', FALSE) THEN
        RETURN FALSE;
    END IF;

    IF get_logic_param_boolean(p_logic_id, 'use_non_trading_periods', TRUE) THEN
        v_trigger := logic_eod_session_end_dt(p_logic_id, p_bar_dt);
        IF v_trigger IS NULL THEN
            RETURN FALSE;
        END IF;
        -- Первая свеча дня с open >= старта вечернего неторгового окна
        RETURN p_bar_dt >= v_trigger
           AND (p_prev_bar_dt IS NULL OR p_prev_bar_dt < v_trigger);
    END IF;

    -- Без неторговых периодов — последняя свеча календарного дня
    -- (нужен следующий бар / теоретический следующий; NULL = неизвестно → не закрывать)
    IF p_next_bar_dt IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN p_next_bar_dt::DATE > p_bar_dt::DATE;
END;
$$;

COMMENT ON FUNCTION logic_is_eod_close_bar(INTEGER, TIMESTAMP, TIMESTAMP, TIMESTAMP) IS
'True: закрыть позиции (кроме фондов) на этом баре — конец сессии или последняя свеча дня';

-- Живой бой: закрыть все позиции кроме TMON/LQDT/SBMM.
CREATE OR REPLACE FUNCTION logic_close_positions_eod_except_funds(p_logic_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT get_logic_param_boolean(p_logic_id, 'close_positions_eod', FALSE) THEN
        RETURN jsonb_build_object('ok', TRUE, 'closed', 0, 'skipped', 0, 'reason', 'disabled');
    END IF;
    RETURN logic_close_all_positions_at_market(p_logic_id, TRUE);
END;
$$;

COMMENT ON FUNCTION logic_close_positions_eod_except_funds(INTEGER) IS
'Бой: закрыть позиции в конце дня, кроме денежных фондов TMON/LQDT/SBMM';

-- @include sql/logic_backtest_runner.sql (см. sql/logic_backtest_runner.sql — дублируется ниже)
-- ============================================
-- Historical backtest runner (is_test=TRUE book)
-- ============================================

CREATE OR REPLACE FUNCTION logic_backtest_price_at(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT p.close_price
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt = p_bar_dt
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_log(
    p_run_id BIGINT,
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
    INSERT INTO app_tech_log (
        trace_id, span_id, thread_key, source, operation, phase,
        message, logic_id, security_id, timeframe_id, payload
    ) VALUES (
        gen_random_uuid(),
        replace(gen_random_uuid()::TEXT, '-', ''),
        format('logic:%s:backtest:%s', COALESCE(p_logic_id, 0), COALESCE(p_run_id, 0)),
        'backtest',
        btrim(p_operation),
        'event',
        p_message,
        p_logic_id,
        p_security_id,
        p_timeframe_id,
        COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('run_id', p_run_id)
    );
END;
$$;

COMMENT ON FUNCTION logic_backtest_log(BIGINT, INTEGER, TEXT, TEXT, JSONB, INTEGER, INTEGER) IS
'Журнал backtest в app_tech_log (milestone: start/progress/done/error; не на каждую сделку)';

CREATE OR REPLACE FUNCTION logic_backtest_diagnose(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_prices INTEGER;
    v_indicators INTEGER;
    v_bars INTEGER;
    v_securities INTEGER;
    v_signals INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_securities
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE;

    SELECT COUNT(*)::INTEGER INTO v_signals
    FROM logic_indicator_signals lis
    WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE;

    SELECT COUNT(*)::INTEGER INTO v_prices
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = p_tf_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to;

    SELECT COUNT(*)::INTEGER INTO v_indicators
    FROM indicator_values iv
    JOIN logic_securities ls ON ls.security_id = iv.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND iv.timeframe_id = p_tf_id
      AND iv.dt::date BETWEEN p_date_from AND p_date_to;

    SELECT COUNT(DISTINCT p.dt)::INTEGER INTO v_bars
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = p_tf_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to;

    RETURN jsonb_build_object(
        'run_id', p_run_id,
        'securities', v_securities,
        'signals', v_signals,
        'prices_in_period', v_prices,
        'indicator_values_in_period', v_indicators,
        'distinct_bars', v_bars,
        'securities_detail', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'security_id', ls.security_id,
                'name', s.name,
                'prices_in_period', (
                    SELECT COUNT(*)::INTEGER FROM prices p
                    WHERE p.security_id = ls.security_id
                      AND p.timeframe_id = p_tf_id
                      AND p.dt::date BETWEEN p_date_from AND p_date_to
                ),
                'indicators_in_period', (
                    SELECT COUNT(*)::INTEGER FROM indicator_values iv
                    WHERE iv.security_id = ls.security_id
                      AND iv.timeframe_id = p_tf_id
                      AND iv.dt::date BETWEEN p_date_from AND p_date_to
                ),
                'test_trades', (
                    SELECT COUNT(*)::INTEGER FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE
                      AND lt.security_id = ls.security_id
                )
            ) ORDER BY ls.display_order, ls.id), '[]'::jsonb)
            FROM logic_securities ls
            JOIN securities s ON s.id = ls.security_id
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION backtest_prices_cached(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_warmup_from DATE,
    p_date_from DATE,
    p_date_to DATE,
    p_min_warmup INTEGER DEFAULT 20
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf_sec INTEGER;
    v_span_days INTEGER;
    v_in_period INTEGER;
    v_warmup_count INTEGER;
    v_min_date DATE;
    v_max_date DATE;
    v_edge_slack INTEGER;
    v_min_bars INTEGER;
    v_date_to DATE;
BEGIN
    IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
        RETURN FALSE;
    END IF;

    -- Будущие даты в date_to недостижимы для рынка — иначе вечный re-fetch T-Bank.
    v_date_to := LEAST(p_date_to, CURRENT_DATE);
    IF p_date_from > v_date_to THEN
        RETURN FALSE;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;
    v_tf_sec := COALESCE(v_tf_sec, 86400);
    v_span_days := GREATEST(1, (v_date_to - p_date_from) + 1);
    v_edge_slack := GREATEST(3, LEAST(14, v_span_days / 20));

    SELECT COUNT(*)::INTEGER, MIN(p.dt::date), MAX(p.dt::date)
    INTO v_in_period, v_min_date, v_max_date
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt::date BETWEEN p_date_from AND v_date_to;

    IF v_in_period = 0 OR v_min_date IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_min_date > p_date_from + v_edge_slack THEN
        RETURN FALSE;
    END IF;
    IF v_max_date < v_date_to - v_edge_slack THEN
        RETURN FALSE;
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_warmup_count
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt::date BETWEEN p_warmup_from AND v_date_to;

    IF v_warmup_count < GREATEST(p_min_warmup, 1) THEN
        RETURN FALSE;
    END IF;

    IF v_tf_sec >= 86400 THEN
        v_min_bars := GREATEST(5, (v_span_days * 2) / 5);
    ELSE
        v_min_bars := GREATEST(
            p_min_warmup,
            GREATEST(20, (v_span_days * 8 * 3600 / v_tf_sec / 4)::INTEGER)
        );
    END IF;

    RETURN v_in_period >= v_min_bars;
END;
$$;

COMMENT ON FUNCTION backtest_prices_cached(INTEGER, INTEGER, DATE, DATE, DATE, INTEGER) IS
'True если свечи покрывают период теста до LEAST(date_to, сегодня); иначе load_prices. Будущий date_to не форсит HTTP.';

CREATE OR REPLACE FUNCTION backtest_indicators_cached(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM indicator_values iv
        WHERE iv.security_id = p_security_id
          AND iv.timeframe_id = p_timeframe_id
          AND iv.indicator_id = p_indicator_id
          AND iv.dt::date BETWEEN p_date_from AND p_date_to
        LIMIT 1
    );
$$;

COMMENT ON FUNCTION backtest_indicators_cached(INTEGER, INTEGER, INTEGER, DATE, DATE) IS
'True если индикатор уже рассчитан на периоде теста';

CREATE OR REPLACE PROCEDURE logic_backtest_ensure_security_data(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_warmup_from DATE,
    p_date_from DATE,
    p_date_to DATE,
    p_end_dt TIMESTAMP,
    p_point_count INTEGER,
    p_prices_loaded OUT INTEGER,
    p_prices_cached OUT INTEGER,
    p_ind_synced OUT INTEGER,
    p_ind_cached OUT INTEGER,
    p_ind_errors OUT INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_ind RECORD;
    v_need_prices BOOLEAN;
BEGIN
    p_prices_loaded := 0;
    p_prices_cached := 0;
    p_ind_synced := 0;
    p_ind_cached := 0;
    p_ind_errors := 0;

    v_need_prices := NOT backtest_prices_cached(
        p_security_id, p_tf_id, p_warmup_from, p_date_from, p_date_to, 20
    );

    IF v_need_prices THEN
        BEGIN
            CALL load_prices(p_security_id, p_tf_id, p_warmup_from, p_date_to);
            p_prices_loaded := 1;
        EXCEPTION WHEN OTHERS THEN
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.prices.error', SQLERRM,
                jsonb_build_object('security_id', p_security_id),
                p_security_id, p_tf_id
            );
            RETURN;
        END;
    ELSE
        p_prices_cached := 1;
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.prices.cached',
            format('Кэш цен sec=%s (%s — %s)', p_security_id, p_warmup_from, p_date_to),
            jsonb_build_object('security_id', p_security_id),
            p_security_id, p_tf_id
        );
    END IF;

    FOR v_ind IN
        SELECT DISTINCT lis.indicator_id
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
    LOOP
        IF NOT v_need_prices AND backtest_indicators_cached(
            p_security_id, p_tf_id, v_ind.indicator_id, p_date_from, p_date_to
        ) THEN
            p_ind_cached := p_ind_cached + 1;
            CONTINUE;
        END IF;
        BEGIN
            CALL ensure_security_indicator_series(p_security_id, v_ind.indicator_id);
            CALL logic_apply_indicator_params_from_signals(p_logic_id, p_security_id);
            CALL sync_security_indicator_series_for_indicator(
                p_security_id, v_ind.indicator_id, p_tf_id, p_end_dt, p_point_count, FALSE
            );
            p_ind_synced := p_ind_synced + 1;
        EXCEPTION WHEN OTHERS THEN
            p_ind_errors := p_ind_errors + 1;
            PERFORM logic_backtest_log(
                p_run_id, p_logic_id, 'backtest.indicator.error', SQLERRM,
                jsonb_build_object('security_id', p_security_id, 'indicator_id', v_ind.indicator_id),
                p_security_id, p_tf_id
            );
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_backtest_ensure_security_data IS
'Backtest: load_prices только если нет кэша; sync индикаторов по активным сигналам логики';

CREATE OR REPLACE FUNCTION logic_backtest_update_run(
    p_run_id BIGINT,
    p_status TEXT DEFAULT NULL,
    p_progress_pct NUMERIC DEFAULT NULL,
    p_phase_message TEXT DEFAULT NULL,
    p_phase_detail TEXT DEFAULT NULL,
    p_current_bar_dt TIMESTAMP DEFAULT NULL,
    p_processed_bars INTEGER DEFAULT NULL,
    p_trades_created INTEGER DEFAULT NULL,
    p_test_balance NUMERIC DEFAULT NULL,
    p_financial_result NUMERIC DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE logic_backtest_runs r
    SET status = COALESCE(p_status, r.status),
        progress_pct = COALESCE(p_progress_pct, r.progress_pct),
        phase_message = COALESCE(p_phase_message, r.phase_message),
        phase_detail = COALESCE(p_phase_detail, r.phase_detail),
        current_bar_dt = COALESCE(p_current_bar_dt, r.current_bar_dt),
        processed_bars = COALESCE(p_processed_bars, r.processed_bars),
        trades_created = COALESCE(p_trades_created, r.trades_created),
        test_balance = COALESCE(p_test_balance, r.test_balance),
        financial_result = COALESCE(p_financial_result, r.financial_result),
        error_message = COALESCE(p_error_message, r.error_message),
        finished_at = CASE
            WHEN p_status IN ('completed', 'cancelled', 'failed') THEN CURRENT_TIMESTAMP
            ELSE r.finished_at
        END
    WHERE r.id = p_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_cancel_requested(p_run_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT cancel_requested FROM logic_backtest_runs WHERE id = p_run_id),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION logic_backtest_sec_shadow(
    p_run_id BIGINT,
    p_security_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT real_trading_paused FROM logic_backtest_security_state
         WHERE run_id = p_run_id AND security_id = p_security_id),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION logic_backtest_sec_inverted(
    p_run_id BIGINT,
    p_security_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT real_trading_inverted FROM logic_backtest_security_state
         WHERE run_id = p_run_id AND security_id = p_security_id),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION logic_backtest_count_open_positions(
    p_logic_id INTEGER,
    p_is_shadow BOOLEAN
)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT COUNT(*)::INTEGER FROM (
        SELECT lt.security_id
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND lt.status IN ('filled', 'submitted')
        GROUP BY lt.security_id
        HAVING COALESCE(SUM(
            CASE
                WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
                ELSE 0
            END
        ), 0) > 0
    ) q;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_insert_trade(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_side_id INTEGER,
    p_action_id INTEGER,
    p_signal_kind TEXT,
    p_formula TEXT,
    p_quantity INTEGER,
    p_price NUMERIC,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN,
    p_trade_reason TEXT,
    p_balance NUMERIC,
    p_position_event TEXT DEFAULT NULL,
    OUT o_trade_id BIGINT,
    OUT o_new_balance NUMERIC
)
LANGUAGE plpgsql AS $$
DECLARE
    v_side_name TEXT;
    v_action_name TEXT;
    v_notional NUMERIC;
    v_trade_id BIGINT;
    v_balance NUMERIC := p_balance;
    v_position_event TEXT;
BEGIN
    SELECT sd.name INTO v_side_name FROM sides sd WHERE sd.id = p_side_id;
    -- Денежный фонд после покупки не продаём: запрет Close (SL/TP/сигналы/EOD).
    IF v_side_name = 'Close' AND logic_is_cash_fund_security(p_security_id) THEN
        o_trade_id := NULL;
        o_new_balance := v_balance;
        RETURN;
    END IF;
    v_position_event := COALESCE(
        NULLIF(btrim(p_position_event), ''),
        CASE WHEN v_side_name = 'Close' THEN 'close' ELSE 'open' END
    );

    INSERT INTO logic_trades (
        logic_id, account_id, security_id, timeframe_id,
        side_id, action_id, position_event, signal_kind, signal_formula,
        quantity, price, bar_dt, executed_at, is_simulated, is_fictitious,
        is_shadow, is_test, run_id, trade_reason, status
    )
    VALUES (
        p_logic_id, p_account_id, p_security_id, p_timeframe_id,
        p_side_id, p_action_id, v_position_event, p_signal_kind, p_formula,
        p_quantity, p_price, p_bar_dt, p_bar_dt, TRUE, FALSE,
        p_is_shadow, TRUE, p_run_id, p_trade_reason, 'filled'
    )
    ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow) DO NOTHING
    RETURNING id INTO v_trade_id;

    IF v_trade_id IS NULL THEN
        o_trade_id := NULL;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    -- Shadow: считаем FR/комиссии, но не трогаем тестовый cash (как в бою).
    IF p_is_shadow THEN
        PERFORM logic_trade_finalize(v_trade_id, NULL);
        UPDATE logic_backtest_runs
        SET trades_created = trades_created + 1
        WHERE id = p_run_id;
        o_trade_id := v_trade_id;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    v_balance := logic_trade_finalize(v_trade_id, v_balance);

    SELECT sd.name, ac.name INTO v_side_name, v_action_name
    FROM sides sd, actions ac
    WHERE sd.id = p_side_id AND ac.id = p_action_id;

    v_notional := p_quantity * p_price;
    IF v_side_name = 'Open' AND v_action_name = 'Long' THEN
        v_balance := v_balance - v_notional;
    ELSIF v_side_name = 'Open' AND v_action_name = 'Short' THEN
        v_balance := v_balance + v_notional;
    ELSIF v_side_name = 'Close' AND v_action_name = 'Long' THEN
        v_balance := v_balance + v_notional;
    ELSIF v_side_name = 'Close' AND v_action_name = 'Short' THEN
        v_balance := v_balance - v_notional;
    END IF;

    UPDATE logic_backtest_runs
    SET trades_created = trades_created + 1
    WHERE id = p_run_id;

    o_trade_id := v_trade_id;
    o_new_balance := v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_close_security(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN,
    p_trade_reason TEXT,
    p_balance NUMERIC,
    OUT o_closed INTEGER,
    OUT o_new_balance NUMERIC
)
LANGUAGE plpgsql AS $$
DECLARE
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_price NUMERIC;
    v_quantity INTEGER;
    v_trade_id BIGINT;
    v_closed INTEGER := 0;
    v_balance NUMERIC := p_balance;
BEGIN
    -- Денежный фонд остаётся купленным: SL/TP/сигналы не закрывают TMON/LQDT/SBMM.
    IF logic_is_cash_fund_security(p_security_id) THEN
        o_closed := 0;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        o_closed := 0;
        o_new_balance := v_balance;
        RETURN;
    END IF;

    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);

    IF v_long_qty >= 1 THEN
        v_quantity := floor(v_long_qty)::INTEGER;
        SELECT *
        INTO v_trade_id, v_balance
        FROM logic_backtest_insert_trade(
            p_run_id, p_logic_id, p_account_id, p_security_id, p_timeframe_id,
            v_side_close_id, v_action_long_id, 'counter', 'backtest:close',
            v_quantity, v_price, p_bar_dt, p_is_shadow, p_trade_reason, v_balance
        );
        IF v_trade_id IS NOT NULL THEN
            v_closed := v_closed + 1;
        END IF;
    END IF;

    IF v_short_qty >= 1 THEN
        v_quantity := floor(v_short_qty)::INTEGER;
        SELECT *
        INTO v_trade_id, v_balance
        FROM logic_backtest_insert_trade(
            p_run_id, p_logic_id, p_account_id, p_security_id, p_timeframe_id,
            v_side_close_id, v_action_short_id, 'counter', 'backtest:close',
            v_quantity, v_price, p_bar_dt, p_is_shadow, p_trade_reason, v_balance
        );
        IF v_trade_id IS NOT NULL THEN
            v_closed := v_closed + 1;
        END IF;
    END IF;

    o_closed := v_closed;
    o_new_balance := v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_security_drawdown_pct(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_price NUMERIC;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
    v_loss NUMERIC := 0;
    v_base NUMERIC := 0;
BEGIN
    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;
    v_long_qty := logic_long_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);
    v_short_qty := logic_short_position_qty(p_logic_id, p_security_id, p_is_shadow, TRUE);
    IF v_long_qty <= 0 AND v_short_qty <= 0 THEN
        RETURN 0;
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price, a.name AS action_name
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND s.name = 'Open'
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        v_base := v_base + v_rem * v_open.price;
        IF v_open.action_name = 'Long' AND v_open.price > v_price THEN
            v_loss := v_loss + v_rem * (v_open.price - v_price);
        ELSIF v_open.action_name = 'Short' AND v_price > v_open.price THEN
            v_loss := v_loss + v_rem * (v_price - v_open.price);
        END IF;
    END LOOP;

    IF v_base <= 0 THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(v_loss / v_base * 100.0, 0);
END;
$$;

-- Track бумаги в тесте (realized + unrealized на баре), аналог logic_security_track_value.
CREATE OR REPLACE FUNCTION logic_backtest_security_track_value(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_realized NUMERIC := 0;
    v_unrealized NUMERIC := 0;
    v_price NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
BEGIN
    SELECT COALESCE(SUM(lt.financial_result), 0)
    INTO v_realized
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    WHERE lt.logic_id = p_logic_id
      AND lt.security_id = p_security_id
      AND lt.is_test = TRUE
      AND lt.is_shadow = p_is_shadow
      AND s.name = 'Close'
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL;

    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN COALESCE(v_realized, 0);
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price, a.name AS action_name
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND s.name = 'Open'
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        IF v_open.action_name = 'Long' THEN
            v_unrealized := v_unrealized + v_rem * (v_price - v_open.price);
        ELSE
            v_unrealized := v_unrealized + v_rem * (v_open.price - v_price);
        END IF;
    END LOOP;

    RETURN COALESCE(v_realized, 0) + COALESCE(v_unrealized, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_security_gain_pct(
    p_logic_id INTEGER,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_shadow BOOLEAN
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_price NUMERIC;
    v_open RECORD;
    v_rem NUMERIC;
    v_gain NUMERIC := 0;
    v_base NUMERIC := 0;
BEGIN
    v_price := logic_backtest_price_at(p_security_id, p_timeframe_id, p_bar_dt);
    IF v_price IS NULL OR v_price <= 0 THEN
        RETURN 0;
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.price, a.name AS action_name
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.security_id = p_security_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = p_is_shadow
          AND s.name = 'Open'
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_rem := logic_trade_open_remaining_qty(v_open.id);
        IF v_rem <= 0 THEN
            CONTINUE;
        END IF;
        v_base := v_base + v_rem * v_open.price;
        IF v_open.action_name = 'Long' AND v_price > v_open.price THEN
            v_gain := v_gain + v_rem * (v_price - v_open.price);
        ELSIF v_open.action_name = 'Short' AND v_open.price > v_price THEN
            v_gain := v_gain + v_rem * (v_open.price - v_price);
        END IF;
    END LOOP;

    IF v_base <= 0 THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(v_gain / v_base * 100.0, 0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_process_risk(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    INOUT p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_stop RECORD;
    v_sec RECORD;
    v_drawdown NUMERIC;
    v_gain NUMERIC;
    v_track_before NUMERIC;
    v_track_after NUMERIC;
    v_state RECORD;
    v_closed INTEGER;
    v_reason TEXT;
    v_initial NUMERIC;
    v_base_pct NUMERIC;
    v_arm_pct NUMERIC;
    v_track NUMERIC;
    v_track_pct NUMERIC;
    v_price NUMERIC;
    v_ltp_armed BOOLEAN;
    v_ltp_last_price NUMERIC;
    v_ltp_arm_bar TIMESTAMP;
    v_resume_equity NUMERIC;
    v_resume_baseline NUMERIC;
    v_long_qty NUMERIC;
    v_short_qty NUMERIC;
BEGIN
    FOR v_stop IN
        SELECT * FROM logic_stops ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        ORDER BY ls.rule_kind, ls.display_order, ls.id
    LOOP
        IF v_stop.value_unit <> 'percent' THEN
            CONTINUE;
        END IF;

        IF v_stop.rule_kind = 'stop_loss' AND v_stop.scope_type = 'portfolio' THEN
            SELECT COALESCE(SUM(lt.financial_result), 0) INTO v_track_before
            FROM logic_trades lt
            WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND lt.is_shadow = FALSE
              AND lt.status IN ('filled', 'submitted');

            v_drawdown := 0;
            IF p_balance < COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) THEN
                v_drawdown := (
                    COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) - p_balance
                ) / NULLIF(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) * 100.0;
            END IF;

            IF v_drawdown >= v_stop.value THEN
                v_reason := format('stop_loss:portfolio (%s%%)', round(v_drawdown, 2));
                FOR v_sec IN
                    SELECT DISTINCT lt.security_id
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                      AND lt.status IN ('filled', 'submitted')
                      AND NOT logic_is_cash_fund_security(lt.security_id)
                LOOP
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                    );
                END LOOP;
            END IF;
        ELSIF v_stop.rule_kind = 'stop_loss' AND v_stop.scope_type = 'portfolio_resume' THEN
            -- Resume check while paused (mirror live: baseline + shadow FR ≥ equity before close)
            SELECT COALESCE(r.portfolio_trading_paused, FALSE) AS portfolio_trading_paused,
                   r.portfolio_stop_resume_equity,
                   r.portfolio_stop_resume_baseline,
                   r.portfolio_equity_peak
            INTO v_state
            FROM logic_backtest_runs r
            WHERE r.id = p_run_id;

            IF COALESCE(v_state.portfolio_trading_paused, FALSE) THEN
                SELECT COALESCE(SUM(lt.financial_result), 0) INTO v_track_after
                FROM logic_trades lt
                WHERE lt.logic_id = p_logic_id
                  AND lt.run_id = p_run_id
                  AND lt.is_test = TRUE
                  AND lt.is_shadow = TRUE
                  AND lt.status IN ('filled', 'submitted')
                  AND lt.financial_result IS NOT NULL;

                IF COALESCE(v_state.portfolio_stop_resume_baseline, 0) + COALESCE(v_track_after, 0)
                   >= COALESCE(v_state.portfolio_stop_resume_equity, 0) THEN
                    UPDATE logic_backtest_runs
                    SET portfolio_trading_paused = FALSE,
                        portfolio_stop_resume_equity = NULL,
                        portfolio_stop_resume_baseline = NULL,
                        portfolio_equity_peak = GREATEST(
                            COALESCE(portfolio_equity_peak, 0),
                            COALESCE(v_state.portfolio_stop_resume_equity, 0),
                            p_balance
                        )
                    WHERE id = p_run_id;
                END IF;
            ELSE
                -- Peak for DD%; resume target = cash equity before close (как в бою)
                UPDATE logic_backtest_runs
                SET portfolio_equity_peak = GREATEST(
                    COALESCE(portfolio_equity_peak, 0),
                    COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0),
                    p_balance
                )
                WHERE id = p_run_id
                  AND COALESCE(portfolio_trading_paused, FALSE) = FALSE;

                SELECT COALESCE(portfolio_equity_peak, p_balance) INTO v_track_before
                FROM logic_backtest_runs WHERE id = p_run_id;

                v_drawdown := 0;
                IF v_track_before > 0 AND p_balance < v_track_before THEN
                    v_drawdown := (v_track_before - p_balance) / v_track_before * 100.0;
                END IF;

                IF v_drawdown >= v_stop.value THEN
                    v_reason := format('stop_loss:portfolio_resume (%s%%)', round(v_drawdown, 2));
                    -- Цель возобновления = equity до закрытия, не пик
                    v_track_before := p_balance;
                    FOR v_sec IN
                        SELECT DISTINCT lt.security_id
                        FROM logic_trades lt
                        WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                          AND lt.status IN ('filled', 'submitted')
                          AND NOT logic_is_cash_fund_security(lt.security_id)
                    LOOP
                        SELECT *
                        INTO v_closed, p_balance
                        FROM logic_backtest_close_security(
                            p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                            p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                        );
                    END LOOP;
                    UPDATE logic_backtest_runs
                    SET portfolio_trading_paused = TRUE,
                        portfolio_stop_resume_equity = v_track_before,
                        portfolio_stop_resume_baseline = p_balance
                    WHERE id = p_run_id;
                END IF;
            END IF;
        ELSIF v_stop.rule_kind = 'stop_loss' THEN
            FOR v_sec IN
                SELECT ls.security_id FROM logic_securities ls
                WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
                  AND NOT logic_is_cash_fund_security(ls.security_id)
            LOOP
                IF v_stop.scope_type = 'security_resume'
                   AND logic_backtest_sec_shadow(p_run_id, v_sec.security_id) THEN
                    -- Mid-run resume: baseline + shadow track ≥ цель (как logic_check_security_resume)
                    SELECT st.stop_resume_equity, st.stop_resume_baseline
                    INTO v_state
                    FROM logic_backtest_security_state st
                    WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id;

                    IF v_state.stop_resume_equity IS NOT NULL
                       AND v_state.stop_resume_baseline IS NOT NULL THEN
                        v_track_after := logic_backtest_security_track_value(
                            p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, TRUE
                        );
                        IF COALESCE(v_state.stop_resume_baseline, 0) + COALESCE(v_track_after, 0)
                           >= COALESCE(v_state.stop_resume_equity, 0) THEN
                            UPDATE logic_backtest_security_state
                            SET real_trading_paused = FALSE,
                                stop_resume_equity = NULL,
                                stop_resume_baseline = NULL
                            WHERE run_id = p_run_id AND security_id = v_sec.security_id;
                        END IF;
                    END IF;
                    CONTINUE;
                END IF;

                v_drawdown := logic_backtest_security_drawdown_pct(
                    p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE
                );
                IF v_drawdown < v_stop.value THEN
                    CONTINUE;
                END IF;

                v_reason := format('stop_loss:%s (%s%%)', v_stop.scope_type, round(v_drawdown, 2));

                IF v_stop.scope_type = 'security_resume' THEN
                    v_track_before := logic_backtest_security_track_value(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE
                    );
                END IF;

                SELECT *
                INTO v_closed, p_balance
                FROM logic_backtest_close_security(
                    p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                    p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                );

                IF v_stop.scope_type = 'security_resume' THEN
                    v_track_after := logic_backtest_security_track_value(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE
                    );
                    INSERT INTO logic_backtest_security_state (
                        run_id, security_id, real_trading_paused,
                        stop_resume_equity, stop_resume_baseline
                    )
                    VALUES (
                        p_run_id, v_sec.security_id, TRUE,
                        v_track_before, v_track_after
                    )
                    ON CONFLICT (run_id, security_id) DO UPDATE SET
                        real_trading_paused = TRUE,
                        stop_resume_equity = EXCLUDED.stop_resume_equity,
                        stop_resume_baseline = EXCLUDED.stop_resume_baseline;
                ELSIF v_stop.scope_type = 'security_inversion' THEN
                    INSERT INTO logic_backtest_security_state (
                        run_id, security_id, real_trading_inverted
                    )
                    VALUES (p_run_id, v_sec.security_id, TRUE)
                    ON CONFLICT (run_id, security_id) DO UPDATE SET
                        real_trading_inverted = NOT COALESCE(logic_backtest_security_state.real_trading_inverted, FALSE);
                END IF;
            END LOOP;
        ELSIF v_stop.rule_kind = 'take_profit' AND v_stop.scope_type = 'portfolio' THEN
            v_gain := 0;
            IF p_balance > COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) THEN
                v_gain := (
                    p_balance - COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0)
                ) / NULLIF(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 0) * 100.0;
            END IF;
            IF v_gain >= v_stop.value THEN
                v_reason := format('take_profit:portfolio (%s%%)', round(v_gain, 2));
                FOR v_sec IN
                    SELECT DISTINCT lt.security_id
                    FROM logic_trades lt
                    WHERE lt.logic_id = p_logic_id AND lt.is_test = TRUE AND NOT lt.is_shadow
                      AND lt.status IN ('filled', 'submitted')
                      AND NOT logic_is_cash_fund_security(lt.security_id)
                LOOP
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                    );
                END LOOP;
            END IF;
        ELSIF v_stop.rule_kind = 'take_profit' AND v_stop.scope_type = 'security' THEN
            FOR v_sec IN
                SELECT ls.security_id FROM logic_securities ls
                WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
                  AND NOT logic_is_cash_fund_security(ls.security_id)
            LOOP
                v_gain := logic_backtest_security_gain_pct(
                    p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE
                );
                IF v_gain >= v_stop.value THEN
                    v_reason := format('take_profit:security (%s%%)', round(v_gain, 2));
                    SELECT *
                    INTO v_closed, p_balance
                    FROM logic_backtest_close_security(
                        p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                        p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                    );
                END IF;
            END LOOP;
        ELSIF v_stop.rule_kind = 'take_profit' AND v_stop.scope_type = 'security_ltp_renew' THEN
            -- Линейный TP: track% vs base_annual×years + TP%; arm → sell on drop → shadow renew
            v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', NULL);
            IF v_initial IS NOT NULL AND v_initial > 0 THEN
                v_base_pct := logic_linear_base_pct(p_logic_id, p_bar_dt, TRUE, p_run_id);
                v_arm_pct := v_base_pct + v_stop.value;
                FOR v_sec IN
                    SELECT ls.security_id FROM logic_securities ls
                    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
                      AND NOT logic_is_cash_fund_security(ls.security_id)
                LOOP
                    IF logic_backtest_sec_shadow(p_run_id, v_sec.security_id) THEN
                        v_resume_equity := NULL;
                        v_resume_baseline := NULL;
                        SELECT st.stop_resume_equity, st.stop_resume_baseline
                        INTO v_resume_equity, v_resume_baseline
                        FROM logic_backtest_security_state st
                        WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id;
                        IF v_resume_equity IS NOT NULL AND v_resume_baseline IS NOT NULL THEN
                            v_track_after := logic_backtest_security_track_value(
                                p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, TRUE
                            );
                            IF COALESCE(v_resume_baseline, 0) + COALESCE(v_track_after, 0)
                               >= COALESCE(v_resume_equity, 0) THEN
                                UPDATE logic_backtest_security_state
                                SET real_trading_paused = FALSE,
                                    stop_resume_equity = NULL,
                                    stop_resume_baseline = NULL
                                WHERE run_id = p_run_id AND security_id = v_sec.security_id;
                            END IF;
                        END IF;
                        CONTINUE;
                    END IF;

                    -- Скаляры: RECORD без строки → «записи не присвоено значение»
                    v_ltp_armed := FALSE;
                    v_ltp_last_price := NULL;
                    v_ltp_arm_bar := NULL;
                    SELECT
                        COALESCE(st.linear_tp_armed, FALSE),
                        st.linear_tp_last_price,
                        st.linear_tp_arm_bar_dt
                    INTO v_ltp_armed, v_ltp_last_price, v_ltp_arm_bar
                    FROM logic_backtest_security_state st
                    WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id;

                    v_track := logic_backtest_security_track_value(
                        p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE
                    );
                    v_track_pct := COALESCE(v_track, 0) / v_initial * 100.0;
                    SELECT p.close_price INTO v_price
                    FROM prices p
                    WHERE p.security_id = v_sec.security_id
                      AND p.timeframe_id = p_tf_id
                      AND p.dt = p_bar_dt
                    LIMIT 1;
                    v_long_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE, TRUE);
                    v_short_qty := logic_short_position_qty(p_logic_id, v_sec.security_id, FALSE, TRUE);

                    IF v_track_pct < v_base_pct THEN
                        IF v_ltp_armed THEN
                            INSERT INTO logic_backtest_security_state (
                                run_id, security_id, linear_tp_armed,
                                linear_tp_last_price, linear_tp_arm_bar_dt
                            )
                            VALUES (p_run_id, v_sec.security_id, FALSE, NULL, NULL)
                            ON CONFLICT (run_id, security_id) DO UPDATE SET
                                linear_tp_armed = FALSE,
                                linear_tp_last_price = NULL,
                                linear_tp_arm_bar_dt = NULL;
                        END IF;
                        CONTINUE;
                    END IF;

                    IF NOT v_ltp_armed
                       AND v_track_pct >= v_arm_pct
                       AND (v_long_qty > 0 OR v_short_qty > 0)
                       AND v_price IS NOT NULL AND v_price > 0
                    THEN
                        INSERT INTO logic_backtest_security_state (
                            run_id, security_id, linear_tp_armed,
                            linear_tp_last_price, linear_tp_arm_bar_dt
                        )
                        VALUES (p_run_id, v_sec.security_id, TRUE, v_price, p_bar_dt)
                        ON CONFLICT (run_id, security_id) DO UPDATE SET
                            linear_tp_armed = TRUE,
                            linear_tp_last_price = EXCLUDED.linear_tp_last_price,
                            linear_tp_arm_bar_dt = EXCLUDED.linear_tp_arm_bar_dt;
                        CONTINUE;
                    END IF;

                    IF NOT v_ltp_armed THEN
                        CONTINUE;
                    END IF;

                    IF v_ltp_last_price IS NOT NULL
                       AND v_price IS NOT NULL
                       AND v_price < v_ltp_last_price
                       AND (v_long_qty > 0 OR v_short_qty > 0)
                       AND (v_ltp_arm_bar IS NULL OR p_bar_dt > v_ltp_arm_bar)
                    THEN
                        v_track_before := v_track;
                        v_reason := format(
                            'take_profit:security_ltp_renew (%s%%)',
                            round(v_track_pct, 2)
                        );
                        SELECT *
                        INTO v_closed, p_balance
                        FROM logic_backtest_close_security(
                            p_run_id, p_logic_id, p_account_id, v_sec.security_id,
                            p_tf_id, p_bar_dt, FALSE, v_reason, p_balance
                        );
                        v_track_after := logic_backtest_security_track_value(
                            p_logic_id, v_sec.security_id, p_tf_id, p_bar_dt, FALSE
                        );
                        INSERT INTO logic_backtest_security_state (
                            run_id, security_id, real_trading_paused,
                            stop_resume_equity, stop_resume_baseline,
                            linear_tp_armed, linear_tp_last_price, linear_tp_arm_bar_dt
                        )
                        VALUES (
                            p_run_id, v_sec.security_id, TRUE,
                            v_track_before, v_track_after,
                            FALSE, NULL, NULL
                        )
                        ON CONFLICT (run_id, security_id) DO UPDATE SET
                            real_trading_paused = TRUE,
                            stop_resume_equity = EXCLUDED.stop_resume_equity,
                            stop_resume_baseline = EXCLUDED.stop_resume_baseline,
                            linear_tp_armed = FALSE,
                            linear_tp_last_price = NULL,
                            linear_tp_arm_bar_dt = NULL;
                    ELSIF v_price IS NOT NULL
                          AND v_price > COALESCE(v_ltp_last_price, 0) THEN
                        UPDATE logic_backtest_security_state
                        SET linear_tp_last_price = v_price
                        WHERE run_id = p_run_id AND security_id = v_sec.security_id;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END LOOP;

    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION logic_backtest_process_signals(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    INOUT p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_position_size_pct NUMERIC;
    v_max_positions INTEGER;
    v_max_order_amount NUMERIC;
    v_sizing_base NUMERIC;
    v_size_mode TEXT;
    v_open_positions INTEGER;
    v_side_open_id INTEGER;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_sec RECORD;
    v_grp RECORD;
    v_sig RECORD;
    v_eval RECORD;
    v_is_shadow BOOLEAN;
    v_held_long NUMERIC;
    v_held_short NUMERIC;
    v_is_open_event BOOLEAN;
    v_quantity INTEGER;
    v_side_id INTEGER;
    v_action_id INTEGER;
    v_trade_id BIGINT;
    v_reason TEXT;
    v_bar_dt TIMESTAMP;
    v_all_ok BOOLEAN;
    v_formulas TEXT;
    v_signal_kind TEXT;
    v_pp NUMERIC;
    v_lot_size INTEGER;
    v_is_futures BOOLEAN;
    v_inversion BOOLEAN;
    v_eff_inversion BOOLEAN;
    v_eff_side TEXT;
BEGIN
    SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    v_position_size_pct := get_logic_param_numeric(p_logic_id, 'position_size_pct', 10);
    v_max_positions := GREATEST(1, get_logic_param_numeric(p_logic_id, 'max_open_positions', 5)::INTEGER);
    v_max_order_amount := get_logic_param_numeric(p_logic_id, 'max_order_amount', NULL);
    v_size_mode := lower(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'position_size_base'),
        'portfolio'
    )));
    IF v_size_mode NOT IN ('free_cash', 'portfolio') THEN
        v_size_mode := 'portfolio';
    END IF;
    v_inversion := get_logic_param_boolean(p_logic_id, 'inversion', FALSE);
    v_open_positions := logic_backtest_count_open_positions(p_logic_id, FALSE);

    FOR v_sec IN
        SELECT ls.security_id FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
          AND NOT logic_is_cash_fund_security(ls.security_id)
    LOOP
        v_is_shadow := logic_backtest_sec_shadow(p_run_id, v_sec.security_id)
            OR COALESCE(
                (SELECT r.portfolio_trading_paused FROM logic_backtest_runs r WHERE r.id = p_run_id),
                FALSE
            );
        v_eff_inversion := (
            v_inversion <> COALESCE(
                (SELECT st.real_trading_inverted
                 FROM logic_backtest_security_state st
                 WHERE st.run_id = p_run_id AND st.security_id = v_sec.security_id),
                FALSE
            )
        );
        v_lot_size := logic_security_lot_size(v_sec.security_id);
        v_is_futures := logic_security_is_futures(v_sec.security_id);

        FOR v_grp IN
            SELECT lis.position_event, lis.position_side
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            GROUP BY lis.position_event, lis.position_side
            ORDER BY lis.position_event, lis.position_side
        LOOP
            v_all_ok := TRUE;
            v_formulas := NULL;
            v_signal_kind := NULL;
            v_pp := NULL;
            v_bar_dt := NULL;

            FOR v_sig IN
                SELECT lis.id, lis.position_event, lis.position_side, lis.signal_kind, lis.formula, lis.indicator_id
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id
                  AND lis.is_active = TRUE
                  AND lis.position_event = v_grp.position_event
                  AND lis.position_side = v_grp.position_side
                ORDER BY lis.display_order, lis.id
            LOOP
                SELECT * INTO v_eval
                FROM logic_signal_evaluate_at(
                    v_sig.id, v_sec.security_id, p_tf_id, p_bar_dt, v_eff_inversion
                );

                IF v_eval.close_price IS NULL THEN
                    v_all_ok := FALSE;
                    CONTINUE;
                END IF;

                IF v_signal_kind IS NULL THEN
                    v_signal_kind := v_sig.signal_kind;
                    v_pp := v_eval.close_price;
                    v_bar_dt := v_eval.bar_dt;
                END IF;
                v_formulas := CASE
                    WHEN v_formulas IS NULL THEN v_sig.formula
                    ELSE v_formulas || ' AND ' || v_sig.formula
                END;

                IF NOT COALESCE(v_eval.ok, FALSE) THEN
                    v_all_ok := FALSE;
                END IF;
            END LOOP;

            IF NOT v_all_ok OR v_pp IS NULL OR v_formulas IS NULL THEN
                CONTINUE;
            END IF;

            v_eff_side := lower(COALESCE(v_grp.position_side, 'long'));
            IF v_eff_inversion THEN
                v_eff_side := CASE WHEN v_eff_side = 'long' THEN 'short' ELSE 'long' END;
            END IF;

            v_held_long := CASE WHEN v_eff_side = 'long'
                THEN logic_long_position_qty(p_logic_id, v_sec.security_id, v_is_shadow, TRUE) ELSE 0 END;
            v_held_short := CASE WHEN v_eff_side = 'short'
                THEN logic_short_position_qty(p_logic_id, v_sec.security_id, v_is_shadow, TRUE) ELSE 0 END;
            v_is_open_event := COALESCE(v_grp.position_event, 'open') = 'open';
            v_reason := format(
                'signal:AND%s:%s/%s→%s %s',
                CASE WHEN v_eff_inversion THEN ':inv' ELSE '' END,
                v_grp.position_event, v_grp.position_side, v_eff_side, v_formulas
            );

            IF v_eff_side = 'long' THEN
                IF v_is_open_event THEN
                    IF v_held_long > 0 OR (NOT v_is_shadow AND v_open_positions >= v_max_positions) THEN
                        CONTINUE;
                    END IF;
                    IF v_size_mode = 'portfolio' THEN
                        v_sizing_base := GREATEST(
                            0,
                            COALESCE(logic_backtest_portfolio_equity(
                                p_logic_id, p_tf_id, p_bar_dt, p_balance
                            ), 0)
                            - logic_backtest_selected_cash_fund_mtm(
                                p_logic_id, p_tf_id, p_bar_dt
                            )
                        );
                    ELSE
                        v_sizing_base := p_balance;
                    END IF;
                    v_quantity := logic_calc_open_quantity(
                        v_sizing_base, v_position_size_pct, v_pp, v_lot_size, v_max_order_amount
                    );
                    IF v_quantity < v_lot_size THEN
                        -- Фьючерсы: нотионал контракта >> % депозита → 1 лот при сигнале
                        IF v_is_futures OR COALESCE(v_sizing_base, 0) >= v_pp * v_lot_size THEN
                            v_quantity := v_lot_size;
                        ELSE
                            CONTINUE;
                        END IF;
                    END IF;
                    v_side_id := v_side_open_id;
                    v_action_id := v_action_long_id;
                ELSE
                    IF v_held_long <= 0 THEN CONTINUE; END IF;
                    v_quantity := GREATEST(v_lot_size, v_held_long::INTEGER);
                    v_side_id := v_side_close_id;
                    v_action_id := v_action_long_id;
                END IF;
            ELSE
                IF v_is_open_event THEN
                    IF v_held_short > 0 OR (NOT v_is_shadow AND v_open_positions >= v_max_positions) THEN
                        CONTINUE;
                    END IF;
                    IF v_size_mode = 'portfolio' THEN
                        v_sizing_base := GREATEST(
                            0,
                            COALESCE(logic_backtest_portfolio_equity(
                                p_logic_id, p_tf_id, p_bar_dt, p_balance
                            ), 0)
                            - logic_backtest_selected_cash_fund_mtm(
                                p_logic_id, p_tf_id, p_bar_dt
                            )
                        );
                    ELSE
                        v_sizing_base := p_balance;
                    END IF;
                    v_quantity := logic_calc_open_quantity(
                        v_sizing_base, v_position_size_pct, v_pp, v_lot_size, v_max_order_amount
                    );
                    IF v_quantity < v_lot_size THEN
                        IF v_is_futures OR COALESCE(v_sizing_base, 0) >= v_pp * v_lot_size THEN
                            v_quantity := v_lot_size;
                        ELSE
                            CONTINUE;
                        END IF;
                    END IF;
                    v_side_id := v_side_open_id;
                    v_action_id := v_action_short_id;
                ELSE
                    IF v_held_short <= 0 THEN CONTINUE; END IF;
                    v_quantity := GREATEST(v_lot_size, v_held_short::INTEGER);
                    v_side_id := v_side_close_id;
                    v_action_id := v_action_short_id;
                END IF;
            END IF;

            SELECT *
            INTO v_trade_id, p_balance
            FROM logic_backtest_insert_trade(
                p_run_id, p_logic_id, p_account_id, v_sec.security_id, p_tf_id,
                v_side_id, v_action_id, v_signal_kind, v_formulas,
                v_quantity, v_pp, v_bar_dt, v_is_shadow, v_reason,
                p_balance, v_grp.position_event
            );

            IF v_trade_id IS NOT NULL AND v_is_open_event AND NOT v_is_shadow
               AND v_side_id = v_side_open_id THEN
                v_open_positions := v_open_positions + 1;
            ELSIF v_trade_id IS NOT NULL AND NOT v_is_open_event AND NOT v_is_shadow THEN
                v_open_positions := GREATEST(0, v_open_positions - 1);
            END IF;
        END LOOP;
    END LOOP;

    RETURN;
END;
$$;

-- Цена фонда для парковки на баре: только prices (+ fallback 100).
-- Без HTTP: иначе при отсутствии свечей TMON каждый бар зовёт T-Bank (~2с) и тест «висит».
CREATE OR REPLACE FUNCTION logic_cash_fund_price_at(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_code TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_price NUMERIC;
BEGIN
    SELECT p.close_price
    INTO v_price
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt <= p_bar_dt
    ORDER BY p.dt DESC
    LIMIT 1;

    IF v_price IS NOT NULL AND v_price > 0 THEN
        RETURN v_price;
    END IF;

    SELECT p.close_price
    INTO v_price
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.dt <= p_bar_dt
    ORDER BY p.dt DESC
    LIMIT 1;

    IF v_price IS NOT NULL AND v_price > 0 THEN
        RETURN v_price;
    END IF;

    -- БПИФ денежного рынка ~100 ₽/пай. HTTP — только в live logic_park_excess_cash (resolve).
    RETURN 100;
END;
$$;

COMMENT ON FUNCTION logic_cash_fund_price_at(INTEGER, INTEGER, TIMESTAMP, TEXT) IS
'Цена TMON/LQDT/SBMM для парковки: prices → fallback 100 (без HTTP на каждый бар)';

-- Equity теста на баре: один set-based запрос (без цикла по бумагам на каждый бар).
CREATE OR REPLACE FUNCTION logic_backtest_portfolio_equity(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_cash_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    WITH pos AS (
        SELECT
            lt.security_id,
            GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) AS long_qty,
            GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) AS short_qty
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = FALSE
          AND lt.status IN ('filled', 'submitted')
        GROUP BY lt.security_id
        HAVING GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) > 0
            OR GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) > 0
    ),
    px AS (
        SELECT DISTINCT ON (pos.security_id)
            pos.long_qty,
            pos.short_qty,
            p.close_price
        FROM pos
        JOIN prices p
          ON p.security_id = pos.security_id
         AND p.timeframe_id = p_timeframe_id
         AND p.dt <= p_bar_dt
        ORDER BY pos.security_id, p.dt DESC
    )
    SELECT COALESCE(p_cash_balance, 0)
         + COALESCE(SUM(px.long_qty * px.close_price - px.short_qty * px.close_price), 0)
    FROM px
    WHERE px.close_price > 0;
$$;

COMMENT ON FUNCTION logic_backtest_portfolio_equity(INTEGER, INTEGER, TIMESTAMP, NUMERIC) IS
'Тест: equity = cash + long×price − short×price на bar_dt (set-based)';

-- MTM выбранного денежного фонда в тесте (исключается из базы лота «весь портфель»).
CREATE OR REPLACE FUNCTION logic_backtest_selected_cash_fund_mtm(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_code TEXT;
    v_mtm NUMERIC;
BEGIN
    v_code := upper(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'cash_fund_code'),
        ''
    )));
    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN 0;
    END IF;

    SELECT COALESCE(SUM(q.long_qty * px.close_price), 0)
    INTO v_mtm
    FROM (
        SELECT
            lt.security_id,
            GREATEST(COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                    ELSE 0
                END
            ), 0), 0) AS long_qty
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        JOIN security_prefixes sp ON sp.security_id = lt.security_id
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = TRUE
          AND lt.is_shadow = FALSE
          AND lt.status IN ('filled', 'submitted')
          AND upper(sp.prefix) = v_code
        GROUP BY lt.security_id
    ) q
    JOIN LATERAL (
        SELECT p.close_price
        FROM prices p
        WHERE p.security_id = q.security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt <= p_bar_dt
          AND p.close_price > 0
        ORDER BY p.dt DESC
        LIMIT 1
    ) px ON TRUE
    WHERE q.long_qty > 0;

    RETURN GREATEST(0, COALESCE(v_mtm, 0));
END;
$$;

COMMENT ON FUNCTION logic_backtest_selected_cash_fund_mtm(INTEGER, INTEGER, TIMESTAMP) IS
'Тест: MTM выбранного cash_fund_code на bar_dt';

-- Парковка: BUY фонда на min(свободный кэш, equity−порог−уже_в_фонде); без продажи фонда.
CREATE OR REPLACE FUNCTION logic_backtest_park_excess_cash(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
    v_threshold NUMERIC;
    v_park_amount NUMERIC;
    v_security_id INTEGER;
    v_price NUMERIC;
    v_lot INTEGER;
    v_qty INTEGER;
    v_side_open_id INTEGER;
    v_action_long_id INTEGER;
    v_trade_id BIGINT;
    v_balance NUMERIC := p_balance;
    v_equity NUMERIC;
    v_fund_qty NUMERIC;
    v_fund_mtm NUMERIC;
    v_excess NUMERIC;
BEGIN
    v_code := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'cash_fund_code'), '')));
    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN v_balance;
    END IF;

    v_threshold := COALESCE(get_logic_param_numeric(p_logic_id, 'cash_fund_threshold', 1000000), 1000000);
    IF v_threshold < 0 THEN
        v_threshold := 0;
    END IF;

    IF v_balance IS NULL OR v_balance <= 0 THEN
        RETURN COALESCE(v_balance, p_balance);
    END IF;

    PERFORM logic_ensure_cash_fund_security(p_logic_id, v_code);

    SELECT s.id
    INTO v_security_id
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id
    WHERE upper(sp.prefix) = v_code
    ORDER BY sp.exchange_id
    LIMIT 1;

    IF v_security_id IS NULL THEN
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.cash_fund.skip',
            format('Фонд %s не найден в securities', v_code),
            jsonb_build_object('fund', v_code, 'balance', v_balance, 'threshold', v_threshold),
            NULL, p_timeframe_id
        );
        RETURN v_balance;
    END IF;

    v_price := logic_cash_fund_price_at(v_security_id, p_timeframe_id, p_bar_dt, v_code);
    IF v_price IS NULL OR v_price <= 0 THEN
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.cash_fund.skip',
            format('Нет цены для %s на %s', v_code, p_bar_dt),
            jsonb_build_object('fund', v_code, 'bar_dt', p_bar_dt),
            v_security_id, p_timeframe_id
        );
        RETURN v_balance;
    END IF;

    -- Избыток портфеля над порогом; уже купленный фонд в equity учитываем, чтобы не докупать снова.
    v_equity := logic_backtest_portfolio_equity(p_logic_id, p_timeframe_id, p_bar_dt, v_balance);
    v_fund_qty := logic_long_position_qty(p_logic_id, v_security_id, FALSE, TRUE);
    v_fund_mtm := COALESCE(v_fund_qty, 0) * v_price;
    v_excess := COALESCE(v_equity, 0) - v_threshold;
    v_park_amount := LEAST(v_balance, GREATEST(0, v_excess - v_fund_mtm));

    IF v_park_amount <= 0 THEN
        RETURN v_balance;
    END IF;

    v_lot := GREATEST(1, logic_security_lot_size(v_security_id));
    v_qty := (FLOOR(v_park_amount / (v_price * v_lot)))::INTEGER * v_lot;
    -- Не логируем «мало для лота» на каждом баре — засоряет app_tech_log и тормозит прогон.
    IF v_qty < v_lot THEN
        RETURN v_balance;
    END IF;

    SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    IF v_side_open_id IS NULL OR v_action_long_id IS NULL THEN
        RETURN v_balance;
    END IF;

    SELECT o_trade_id, o_new_balance
    INTO v_trade_id, v_balance
    FROM logic_backtest_insert_trade(
        p_run_id, p_logic_id, p_account_id, v_security_id, p_timeframe_id,
        v_side_open_id, v_action_long_id,
        'cash_fund',
        format('cash_fund.park %s', v_code),
        v_qty, v_price, p_bar_dt, FALSE,
        format('cash_fund.park:%s', v_code),
        v_balance,
        'open'
    );

    IF v_trade_id IS NOT NULL THEN
        PERFORM logic_backtest_log(
            p_run_id, p_logic_id, 'backtest.cash_fund.park',
            format('Тест: куплено %s qty=%s price=%s bar=%s', v_code, v_qty, v_price, p_bar_dt),
            jsonb_build_object(
                'fund', v_code,
                'quantity', v_qty,
                'price', v_price,
                'park_amount', v_park_amount,
                'equity', v_equity,
                'fund_mtm', v_fund_mtm,
                'excess', v_excess,
                'trade_id', v_trade_id,
                'bar_dt', p_bar_dt
            ),
            v_security_id, p_timeframe_id
        );
    END IF;

    RETURN v_balance;
END;
$$;

COMMENT ON FUNCTION logic_backtest_park_excess_cash(BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC) IS
'Тест: на каждом баре BUY фонда на min(кэш, equity−порог−уже_в_фонде); фонд не продаём';

-- Закрыть все test-позиции кроме денежного фонда (TMON/LQDT/SBMM).
CREATE OR REPLACE FUNCTION logic_backtest_close_all_except_funds(
    p_run_id BIGINT,
    p_logic_id INTEGER,
    p_account_id INTEGER,
    p_timeframe_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_balance NUMERIC := p_balance;
    v_closed INTEGER;
    v_new NUMERIC;
BEGIN
    FOR v_sec IN
        SELECT DISTINCT lt.security_id
        FROM logic_trades lt
        WHERE lt.logic_id = p_logic_id
          AND lt.is_test = TRUE
          AND lt.status IN ('filled', 'submitted')
          AND NOT EXISTS (
              SELECT 1 FROM security_prefixes sp
              WHERE sp.security_id = lt.security_id
                AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
          )
    LOOP
        SELECT o_closed, o_new_balance
        INTO v_closed, v_new
        FROM logic_backtest_close_security(
            p_run_id, p_logic_id, p_account_id, v_sec.security_id, p_timeframe_id,
            p_bar_dt, FALSE, 'eod.close', v_balance
        );
        v_balance := v_new;
        SELECT o_closed, o_new_balance
        INTO v_closed, v_new
        FROM logic_backtest_close_security(
            p_run_id, p_logic_id, p_account_id, v_sec.security_id, p_timeframe_id,
            p_bar_dt, TRUE, 'eod.close', v_balance
        );
        v_balance := v_new;
    END LOOP;
    RETURN v_balance;
END;
$$;

COMMENT ON FUNCTION logic_backtest_close_all_except_funds(BIGINT, INTEGER, INTEGER, INTEGER, TIMESTAMP, NUMERIC) IS
'EOD: закрыть все test-позиции кроме TMON/LQDT/SBMM';

-- Прогон по свечам (единый мозг теста): rate → risk → EOD → signals → park.
-- PROCEDURE + COMMIT каждые N баров: иначе одна длинная tx держит локи и UI не видит прогресс.
DROP ROUTINE IF EXISTS logic_backtest_run_bars(BIGINT);

CREATE OR REPLACE PROCEDURE logic_backtest_run_bars(p_run_id BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
    v_run RECORD;
    v_logic RECORD;
    v_tf_id INTEGER;
    v_balance NUMERIC;
    v_bars TIMESTAMP[];
    v_total INTEGER;
    v_i INTEGER;
    v_bar_dt TIMESTAMP;
    v_prev_bar TIMESTAMP;
    v_next_bar TIMESTAMP;
    v_pnl NUMERIC;
    v_trades_created INTEGER;
    v_diag JSONB;
    v_commit_every INTEGER := 5;
BEGIN
    SELECT r.id, r.logic_id, r.date_from, r.date_to, r.status, r.cancel_requested, r.test_balance
    INTO v_run
    FROM logic_backtest_runs r
    WHERE r.id = p_run_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'backtest run % не найден', p_run_id;
    END IF;

    IF v_run.status IN ('completed', 'cancelled', 'failed') THEN
        RETURN;
    END IF;

    IF COALESCE(v_run.cancel_requested, FALSE) THEN
        PERFORM logic_backtest_update_run(p_run_id, 'cancelled', NULL, 'Отменено', NULL);
        COMMIT;
        RETURN;
    END IF;

    SELECT l.id, l.account_id INTO v_logic
    FROM logics l WHERE l.id = v_run.logic_id;
    IF NOT FOUND THEN
        PERFORM logic_backtest_update_run(
            p_run_id, 'failed', 100, 'Логика не найдена', NULL, NULL, NULL, NULL, NULL, 0,
            format('Логика %s не найдена', v_run.logic_id)
        );
        COMMIT;
        RETURN;
    END IF;

    PERFORM logic_ensure_non_trading_periods(v_run.logic_id);

    v_tf_id := logic_resolve_timeframe_id(v_run.logic_id);
    IF v_tf_id IS NULL THEN
        PERFORM logic_backtest_update_run(
            p_run_id, 'failed', 100, 'Не задан timeframe', NULL, NULL, NULL, NULL, NULL, 0,
            'Не задан timeframe'
        );
        COMMIT;
        RETURN;
    END IF;

    v_balance := COALESCE(
        v_run.test_balance,
        get_logic_param_numeric(v_run.logic_id, 'initial_balance', 0),
        1000000
    );

    SELECT array_agg(DISTINCT p.dt ORDER BY p.dt)
    INTO v_bars
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = v_run.logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = v_tf_id
      AND p.dt::date BETWEEN v_run.date_from AND v_run.date_to;

    v_total := COALESCE(array_length(v_bars, 1), 0);
    UPDATE logic_backtest_runs
    SET total_bars = v_total,
        trades_created = 0,
        processed_bars = 0
    WHERE id = p_run_id;

    IF v_total = 0 THEN
        PERFORM logic_backtest_update_run(
            p_run_id, 'failed', 100, 'Нет свечей', NULL, NULL, NULL, NULL, v_balance, 0,
            'Нет цен в выбранном периоде'
        );
        COMMIT;
        RETURN;
    END IF;

    PERFORM logic_backtest_update_run(
        p_run_id, 'running', 40, 'Прогон по свечам',
        format('0 / %s баров', v_total),
        NULL, 0, NULL, v_balance
    );
    COMMIT;

    FOR v_i IN 1..v_total LOOP
        IF logic_backtest_cancel_requested(p_run_id) THEN
            SELECT COALESCE(SUM(financial_result), 0) INTO v_pnl
            FROM logic_trades WHERE logic_id = v_run.logic_id AND is_test = TRUE;
            PERFORM logic_backtest_log(
                p_run_id, v_run.logic_id, 'backtest.cancelled',
                format('Отменено на %s/%s', v_i, v_total), NULL
            );
            PERFORM logic_backtest_update_run(
                p_run_id, 'cancelled',
                round(40 + v_i::NUMERIC / v_total * 60, 2),
                'Отменено пользователем', NULL, v_bars[v_i], v_i, NULL, v_balance, v_pnl
            );
            COMMIT;
            RETURN;
        END IF;

        v_bar_dt := v_bars[v_i];
        v_prev_bar := CASE WHEN v_i > 1 THEN v_bars[v_i - 1] ELSE NULL END;
        v_next_bar := CASE WHEN v_i < v_total THEN v_bars[v_i + 1] ELSE NULL END;

        PERFORM logic_backtest_rate_signals(p_run_id, v_run.logic_id, v_tf_id, v_bar_dt);
        v_balance := logic_backtest_process_risk(
            p_run_id, v_run.logic_id, v_logic.account_id, v_tf_id, v_bar_dt, v_balance
        );

        IF logic_is_eod_close_bar(v_run.logic_id, v_bar_dt, v_prev_bar, v_next_bar) THEN
            v_balance := logic_backtest_close_all_except_funds(
                p_run_id, v_run.logic_id, v_logic.account_id, v_tf_id, v_bar_dt, v_balance
            );
        END IF;

        IF NOT logic_is_non_trading_dt(v_run.logic_id, v_bar_dt) THEN
            v_balance := logic_backtest_process_signals(
                p_run_id, v_run.logic_id, v_logic.account_id, v_tf_id, v_bar_dt, v_balance
            );
        END IF;

        v_balance := logic_backtest_park_excess_cash(
            p_run_id, v_run.logic_id, v_logic.account_id, v_tf_id, v_bar_dt, v_balance
        );

        IF v_i % v_commit_every = 0 OR v_i = v_total THEN
            PERFORM logic_backtest_update_run(
                p_run_id, 'running',
                round(40 + v_i::NUMERIC / v_total * 60, 2),
                'Прогон по свечам',
                format('%s / %s баров', v_i, v_total),
                v_bar_dt, v_i, NULL, v_balance
            );
            COMMIT;
        END IF;
    END LOOP;

    IF v_total > 0 THEN
        v_balance := logic_backtest_park_excess_cash(
            p_run_id, v_run.logic_id, v_logic.account_id, v_tf_id, v_bars[v_total], v_balance
        );
    END IF;

    SELECT COALESCE(SUM(financial_result), 0) INTO v_pnl
    FROM logic_trades WHERE logic_id = v_run.logic_id AND is_test = TRUE;

    SELECT COUNT(*)::INTEGER INTO v_trades_created
    FROM logic_trades WHERE logic_id = v_run.logic_id AND is_test = TRUE;

    v_diag := logic_backtest_diagnose(
        p_run_id, v_run.logic_id, v_tf_id, v_run.date_from, v_run.date_to
    );

    PERFORM logic_backtest_log(
        p_run_id, v_run.logic_id, 'backtest.complete',
        CASE WHEN v_trades_created > 0
            THEN format('Завершено: %s сделок, PnL=%s', v_trades_created, round(v_pnl, 2))
            ELSE format('Завершено без сделок (%s баров)', v_total)
        END,
        v_diag || jsonb_build_object(
            'trades_created', v_trades_created,
            'financial_result', v_pnl,
            'total_bars', v_total,
            'engine', 'sql_procedure'
        ),
        NULL, v_tf_id
    );

    PERFORM logic_backtest_update_run(
        p_run_id, 'completed', 100,
        CASE WHEN v_trades_created > 0 THEN 'Тестирование завершено' ELSE 'Тест завершён — сделок нет' END,
        format('%s баров, сделок: %s', v_total, v_trades_created),
        v_bars[v_total], v_total, v_trades_created, v_balance, v_pnl
    );
    COMMIT;
END;
$$;

COMMENT ON PROCEDURE logic_backtest_run_bars(BIGINT) IS
'SQL-робот теста: прогон баров с COMMIT каждые 5 свечей (без длинного лока на весь тест)';

DROP ROUTINE IF EXISTS run_logic_backtest(INTEGER, DATE, DATE);
DROP ROUTINE IF EXISTS run_logic_backtest(INTEGER, DATE, DATE, BIGINT);

CREATE OR REPLACE PROCEDURE run_logic_backtest(
    p_logic_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    INOUT o_run_id BIGINT DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_run_id BIGINT;
    v_logic RECORD;
    v_tf_id INTEGER;
    v_tf_sec INTEGER;
    v_balance NUMERIC;
    v_secs INTEGER;
    v_sec_i INTEGER := 0;
    v_sec RECORD;
    v_date_from DATE;
    v_date_to DATE;
    v_load_from DATE;
    v_cash_fund_code TEXT;
    v_cash_fund_id INTEGER;
    v_end_dt TIMESTAMP;
    v_point_count INTEGER;
    v_prices_in_period INTEGER;
    v_ind_in_period INTEGER;
    v_days_span INTEGER;
    v_tbank JSONB;
    v_pl INTEGER;
    v_pc INTEGER;
    v_is INTEGER;
    v_ic INTEGER;
    v_ie INTEGER;
BEGIN
    v_date_from := LEAST(p_date_from, p_date_to);
    v_date_to := GREATEST(p_date_from, p_date_to);
    v_load_from := v_date_from - 30;
    v_end_dt := (v_date_to::TEXT || ' 23:59:59')::TIMESTAMP;

    SELECT l.id, l.account_id INTO v_logic
    FROM logics l WHERE l.id = p_logic_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Логика % не найдена', p_logic_id;
    END IF;

    PERFORM logic_ensure_non_trading_periods(p_logic_id);

    v_tf_id := logic_resolve_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        RAISE EXCEPTION 'Не задан timeframe';
    END IF;
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = v_tf_id;

    v_balance := COALESCE(get_logic_param_numeric(p_logic_id, 'initial_balance', 0), 1000000);
    v_days_span := GREATEST(1, (v_date_to - v_load_from) + 1);
    v_point_count := GREATEST(500, CEIL(v_days_span * (86400.0 / GREATEST(v_tf_sec, 60)))::INTEGER + 200);

    DELETE FROM logic_trades WHERE logic_id = p_logic_id AND is_test = TRUE;
    PERFORM logic_backtest_reset_signal_ratings(p_logic_id);

    v_cash_fund_code := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'cash_fund_code'), '')));
    IF v_cash_fund_code IN ('TMON', 'LQDT', 'SBMM') THEN
        PERFORM logic_ensure_cash_fund_security(p_logic_id, v_cash_fund_code);
        SELECT s.id
        INTO v_cash_fund_id
        FROM securities s
        JOIN security_prefixes sp ON sp.security_id = s.id
        WHERE upper(sp.prefix) = v_cash_fund_code
        ORDER BY sp.exchange_id
        LIMIT 1;
    ELSE
        v_cash_fund_id := NULL;
    END IF;

    INSERT INTO logic_backtest_runs (
        logic_id, date_from, date_to, status, progress_pct,
        phase_message, test_balance, started_at
    )
    VALUES (
        p_logic_id, v_date_from, v_date_to, 'loading_prices', 0,
        'Загрузка цен', v_balance, CURRENT_TIMESTAMP
    )
    RETURNING id INTO v_run_id;
    o_run_id := v_run_id;
    COMMIT;

    IF v_tf_sec < 86400 THEN
        v_tbank := tbank_verify_token();
        IF NOT COALESCE((v_tbank->>'valid')::BOOLEAN, FALSE) THEN
            PERFORM logic_backtest_log(
                v_run_id, p_logic_id, 'backtest.failed',
                COALESCE(v_tbank->>'error_message', 'Нужен токен T-Bank для intraday'),
                v_tbank
            );
            PERFORM logic_backtest_update_run(
                v_run_id, 'failed', 100, 'Нужен T-Bank', NULL, NULL, NULL, NULL, v_balance, 0,
                COALESCE(v_tbank->>'error_message', 'Для M15 нужен валидный токен T-Bank')
            );
            COMMIT;
            RETURN;
        END IF;
    END IF;

    PERFORM logic_backtest_log(
        v_run_id, p_logic_id, 'backtest.start',
        format('Старт %s — %s', v_date_from, v_date_to),
        jsonb_build_object('date_from', v_date_from, 'date_to', v_date_to, 'load_from', v_load_from)
    );

    SELECT COUNT(*)::INTEGER INTO v_secs
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE;

    FOR v_sec IN
        SELECT ls.security_id FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
          AND NOT EXISTS (
              SELECT 1 FROM security_prefixes sp
              WHERE sp.security_id = ls.security_id
                AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
          )
        ORDER BY ls.display_order, ls.id
    LOOP
        IF logic_backtest_cancel_requested(v_run_id) THEN
            PERFORM logic_backtest_log(v_run_id, p_logic_id, 'backtest.cancelled', 'Отменено на загрузке', NULL);
            PERFORM logic_backtest_update_run(v_run_id, 'cancelled', NULL, 'Отменено', NULL);
            COMMIT;
            RETURN;
        END IF;
        v_sec_i := v_sec_i + 1;
        BEGIN
            CALL logic_backtest_ensure_security_data(
                v_run_id, p_logic_id, v_sec.security_id, v_tf_id,
                v_load_from, v_date_from, v_date_to, v_end_dt, v_point_count,
                v_pl, v_pc, v_is, v_ic, v_ie
            );
        EXCEPTION WHEN OTHERS THEN
            PERFORM logic_backtest_log(
                v_run_id, p_logic_id, 'backtest.prices.error', SQLERRM,
                jsonb_build_object('security_id', v_sec.security_id), v_sec.security_id, v_tf_id
            );
        END;
        PERFORM logic_backtest_update_run(
            v_run_id, 'loading_prices',
            round(v_sec_i::NUMERIC / GREATEST(v_secs, 1) * 35, 2),
            'Подготовка данных',
            format('Бумага %s/%s', v_sec_i, v_secs)
        );
        COMMIT;
    END LOOP;

    -- Цены денежного фонда (сигналы по нему не гоняем, но парковка в тесте нужна).
    IF v_cash_fund_id IS NOT NULL THEN
        BEGIN
            CALL logic_backtest_ensure_security_data(
                v_run_id, p_logic_id, v_cash_fund_id, v_tf_id,
                v_load_from, v_date_from, v_date_to, v_end_dt, v_point_count,
                v_pl, v_pc, v_is, v_ic, v_ie
            );
        EXCEPTION WHEN OTHERS THEN
            PERFORM logic_backtest_log(
                v_run_id, p_logic_id, 'backtest.cash_fund.prices.error', SQLERRM,
                jsonb_build_object('security_id', v_cash_fund_id, 'fund', v_cash_fund_code),
                v_cash_fund_id, v_tf_id
            );
        END;
        COMMIT;
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_prices_in_period
    FROM prices p
    JOIN logic_securities ls ON ls.security_id = p.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND p.timeframe_id = v_tf_id
      AND p.dt::date BETWEEN v_date_from AND v_date_to;

    PERFORM logic_backtest_log(
        v_run_id, p_logic_id, 'backtest.prices.done',
        format('Цены в периоде=%s', v_prices_in_period),
        jsonb_build_object('prices_in_period', v_prices_in_period),
        NULL, v_tf_id
    );

    IF v_prices_in_period = 0 THEN
        PERFORM logic_backtest_update_run(
            v_run_id, 'failed', 100, 'Нет свечей', NULL, NULL, NULL, NULL, v_balance, 0,
            'Не загружены цены. Задайте токен T-Bank (M15) или см. price_load_log.'
        );
        COMMIT;
        RETURN;
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_ind_in_period
    FROM indicator_values iv
    JOIN logic_securities ls ON ls.security_id = iv.security_id
    WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
      AND iv.timeframe_id = v_tf_id
      AND iv.dt::date BETWEEN v_date_from AND v_date_to;

    PERFORM logic_backtest_log(
        v_run_id, p_logic_id, 'backtest.indicators.done',
        format('Индикаторы в периоде=%s', v_ind_in_period),
        jsonb_build_object('indicator_values_in_period', v_ind_in_period),
        NULL, v_tf_id
    );
    COMMIT;

    IF v_ind_in_period = 0 THEN
        PERFORM logic_backtest_update_run(
            v_run_id, 'failed', 100, 'Нет индикаторов', NULL, NULL, NULL, NULL, v_balance, 0,
            'Индикаторы не рассчитаны. См. backtest.indicator.error.'
        );
        COMMIT;
        RETURN;
    END IF;

    -- Единый SQL-прогон баров (тот же путь, что вызывает Node после parallel prep).
    CALL logic_backtest_run_bars(v_run_id);
    o_run_id := v_run_id;
END;
$$;

COMMENT ON PROCEDURE run_logic_backtest(INTEGER, DATE, DATE, BIGINT) IS
'Исторический backtest (SQL PROCEDURE): загрузка + logic_backtest_run_bars с частыми COMMIT';

CREATE OR REPLACE FUNCTION logic_backtest_request_cancel(p_run_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE logic_backtest_runs
    SET cancel_requested = TRUE
    WHERE id = p_run_id
      AND status IN ('pending', 'loading_prices', 'loading_indicators', 'running');
    RETURN FOUND;
END;
$$;

-- @optional-pgcron-block
-- pg_cron: run_trade_cycle() каждую минуту (Linux; на Windows — Node TRADE_RUNNER fallback)
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron: %', SQLERRM;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule(jobid)
        FROM cron.job
        WHERE jobname = 'multilogictrade_trade_cycle';
        PERFORM cron.schedule(
            'multilogictrade_trade_cycle',
            '* * * * *',
            'SELECT run_trade_cycle()'
        );
        RAISE NOTICE 'pg_cron: multilogictrade_trade_cycle scheduled';

        PERFORM cron.unschedule(jobid)
        FROM cron.job
        WHERE jobname = 'multilogictrade_disk_cleanup';
        PERFORM cron.schedule(
            'multilogictrade_disk_cleanup',
            '30 3 * * *',
            'SELECT run_cleanup_if_enabled()'
        );
        RAISE NOTICE 'pg_cron: multilogictrade_disk_cleanup scheduled (03:30)';
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule: %', SQLERRM;
END $$;




-- ===========================================================================
-- @include sql/routine_comments_missing.sql (дублируется ниже)
-- ===========================================================================

-- Комментарии к функциям/процедурам без COMMENT ON (для UI «Структура БД» / obj_description).
-- Файл генерируется: node scripts/generate-missing-routine-comments.mjs

COMMENT ON FUNCTION calc_ind_atr IS
  'Расчёт ATR (Average True Range) для бумаги/таймфрейма; пишет серии индикатора.';

COMMENT ON FUNCTION calc_ind_atr_array IS
  'ATR массивом по барам (TABLE dt,value) для sync серий.';

COMMENT ON FUNCTION calc_ind_bb IS
  'Расчёт Bollinger Bands (UPPER/MIDDLE/LOWER).';

COMMENT ON FUNCTION calc_ind_bb_array IS
  'Bollinger Bands массивом по барам.';

COMMENT ON FUNCTION calc_ind_ema IS
  'Расчёт EMA (Exponential Moving Average).';

COMMENT ON FUNCTION calc_ind_ema_array IS
  'EMA массивом по барам.';

COMMENT ON FUNCTION calc_ind_macd IS
  'Расчёт MACD / SIGNAL / HISTOGRAM.';

COMMENT ON FUNCTION calc_ind_macd_array IS
  'MACD массивом по барам.';

COMMENT ON FUNCTION calc_ind_rsi IS
  'Расчёт RSI.';

COMMENT ON FUNCTION calc_ind_rsi_array IS
  'RSI массивом по барам.';

COMMENT ON FUNCTION calc_ind_sma IS
  'Расчёт SMA.';

COMMENT ON FUNCTION calc_ind_sma_array IS
  'SMA массивом по барам.';

COMMENT ON FUNCTION calc_ind_stoch IS
  'Расчёт Stochastic (K/D).';

COMMENT ON FUNCTION calc_ind_stoch_array IS
  'Stochastic массивом по барам.';

COMMENT ON FUNCTION calc_indicator_series_array IS
  'Универсальный расчёт серии индикатора (calc_ind_* или poly-формула).';

COMMENT ON FUNCTION default_invoke_formula IS
  'Формула вызова индикатора по умолчанию из справочника.';

COMMENT ON PROCEDURE ensure_security_indicator_series IS
  'Создаёт строки security_indicator_series для индикатора на бумаге.';

COMMENT ON FUNCTION evaluate_signal_condition IS
  'Проверяет условие сигнала (@CODE …) на закрытом баре.';

COMMENT ON FUNCTION get_logic_param_numeric IS
  'Числовой параметр логики из logic_params (EAV).';

COMMENT ON FUNCTION get_logic_param_text IS
  'Текстовый параметр логики из logic_params (EAV).';

COMMENT ON FUNCTION ind_resolve_end_dt IS
  'Конечная дата/время окна расчёта индикатора.';

COMMENT ON FUNCTION ind_warmup_bars IS
  'Число баров прогрева для индикатора/формулы.';

COMMENT ON FUNCTION is_perpetual_future_group IS
  'Признак вечного фьючерса (CNYRUBF и т.п.) по группе префикса.';

COMMENT ON FUNCTION logic_backtest_cancel_requested IS
  'Проверка: пользователь запросил остановку бэктеста.';

COMMENT ON FUNCTION logic_backtest_close_security IS
  'Закрытие позиции по бумаге в бэктесте.';

COMMENT ON FUNCTION logic_backtest_count_open_positions IS
  'Число открытых позиций в прогоне бэктеста.';

COMMENT ON FUNCTION logic_backtest_diagnose IS
  'Диагностика состояния бэктеста (отладка).';

COMMENT ON FUNCTION logic_backtest_insert_trade IS
  'Вставка тестовой сделки (logic_trades, is_test=1, run_id).';

COMMENT ON FUNCTION logic_backtest_price_at IS
  'Цена бумаги на баре бэктеста.';

COMMENT ON FUNCTION logic_backtest_process_risk IS
  'Стопы/риск в бэктесте на баре.';

COMMENT ON FUNCTION logic_backtest_process_signals IS
  'Сигналы open/close в бэктесте на баре.';

COMMENT ON FUNCTION logic_backtest_request_cancel IS
  'Помечает прогон бэктеста к отмене (UI Стоп).';

COMMENT ON FUNCTION logic_backtest_sec_inverted IS
  'Локальная инверсия бумаги в бэктесте (security_inversion).';

COMMENT ON FUNCTION logic_backtest_sec_shadow IS
  'Теневой режим бумаги в бэктесте (пауза/resume).';

COMMENT ON FUNCTION logic_backtest_security_drawdown_pct IS
  'Просадка по бумаге в бэктесте, %.';

COMMENT ON FUNCTION logic_backtest_security_gain_pct IS
  'Прирост по бумаге в бэктесте, %.';

COMMENT ON FUNCTION logic_backtest_update_run IS
  'Обновление статуса/прогресса logic_backtest_runs.';

COMMENT ON FUNCTION logic_check_security_resume IS
  'Проверка условий security_resume для возобновления торговли.';

COMMENT ON FUNCTION logic_close_security_positions_market IS
  'Закрытие боевых позиций по бумаге по рынку.';

COMMENT ON FUNCTION logic_count_open_positions IS
  'Число открытых боевых позиций логики.';

COMMENT ON FUNCTION logic_ensure_balance IS
  'Инициализация/проверка current_balance фейк-счёта.';

COMMENT ON FUNCTION logic_long_position_qty IS
  'Объём открытого лонга по бумаге.';

COMMENT ON FUNCTION logic_portfolio_drawdown_pct IS
  'Просадка портфеля логики, %.';

COMMENT ON FUNCTION logic_portfolio_equity IS
  'Эквити портфеля логики (баланс ± позиции).';

COMMENT ON FUNCTION logic_security_drawdown_pct IS
  'Просадка по бумаге в боевом режиме, %.';

COMMENT ON FUNCTION logic_security_position_cost IS
  'Себестоимость позиции по бумаге.';

COMMENT ON FUNCTION logic_security_position_market IS
  'Рыночная оценка позиции по бумаге.';

COMMENT ON FUNCTION logic_security_track_value IS
  'Учётная стоимость позиции для стопов.';

COMMENT ON FUNCTION logic_short_position_qty IS
  'Объём открытого шорта по бумаге.';

COMMENT ON FUNCTION logic_signal_evaluate_at IS
  'Оценка сигнала логики на заданном баре.';

COMMENT ON FUNCTION logic_signal_record_fire IS
  'Фиксация срабатывания сигнала (pending рейтинга и т.п.).';

COMMENT ON FUNCTION logic_upsert_param IS
  'UPSERT параметра в logic_params.';

COMMENT ON FUNCTION parse_signal_formula IS
  'Разбор формулы сигнала @CODE(…) condition.';

COMMENT ON FUNCTION parse_signal_param_num IS
  'Числовой параметр из текста формулы сигнала.';

COMMENT ON FUNCTION parse_signal_series IS
  'Код серии (VALUE/UPPER/…) из формулы сигнала.';

COMMENT ON FUNCTION poly_add IS
  'Сложение рядов в poly-парсере.';

COMMENT ON FUNCTION poly_align2 IS
  'Выравнивание двух рядов по длине.';

COMMENT ON FUNCTION poly_build_ema_kernel IS
  'Ядро EMA для свёртки.';

COMMENT ON FUNCTION poly_build_sma_kernel IS
  'Ядро SMA для свёртки.';

COMMENT ON FUNCTION poly_comp_div IS
  'Покомпонентное деление рядов.';

COMMENT ON FUNCTION poly_comp_mul IS
  'Покомпонентное умножение рядов.';

COMMENT ON FUNCTION poly_ctx_period IS
  'Период из контекста poly-формулы.';

COMMENT ON FUNCTION poly_delta_kernel IS
  'Ядро дельты (производной) для свёртки.';

COMMENT ON FUNCTION poly_eval_node IS
  'Вычисление узла AST poly-формулы.';

COMMENT ON FUNCTION poly_extend IS
  'Дополнение ряда до нужной длины.';

COMMENT ON FUNCTION poly_fn_empty_args IS
  'Проверка пустых аргументов функции sma/ema/…';

COMMENT ON FUNCTION poly_fn_resolve_period IS
  'Период из аргументов sma(period=…).';

COMMENT ON FUNCTION poly_fn_resolve_series IS
  'Серия из аргументов sma(…, series=…).';

COMMENT ON FUNCTION poly_fn_validate_args IS
  'Валидация аргументов встроенных poly-функций.';

COMMENT ON FUNCTION poly_formula_conv_depth IS
  'Глубина свёрток формулы (для warmup).';

COMMENT ON FUNCTION poly_formula_warmup_bars IS
  'Бары прогрева для poly-формулы.';

COMMENT ON FUNCTION poly_is_formula IS
  'Признак, что invoke — многочленная формула.';

COMMENT ON FUNCTION poly_len IS
  'Длина числового ряда.';

COMMENT ON FUNCTION poly_load_indicator_array IS
  'Загрузка ряда индикатора @CODE в poly-контекст.';

COMMENT ON FUNCTION poly_load_market_array IS
  'Загрузка OHLC/V ряда (pp/oo/…) в poly-контекст.';

COMMENT ON FUNCTION poly_load_market_dts IS
  'Метки времени баров рынка для poly.';

COMMENT ON FUNCTION poly_neg IS
  'Унарный минус ряда.';

COMMENT ON FUNCTION poly_parse IS
  'Разбор текста poly-формулы в AST.';

COMMENT ON FUNCTION poly_parse_add IS
  'Разбор сложения/вычитания.';

COMMENT ON FUNCTION poly_parse_atom IS
  'Разбор атома (число, ряд, скобки).';

COMMENT ON FUNCTION poly_parse_comp IS
  'Разбор покомпонентных операций.';

COMMENT ON FUNCTION poly_parse_conv IS
  'Разбор свёртки (*).';

COMMENT ON FUNCTION poly_parse_fn_args IS
  'Разбор аргументов sma(…)/ema(…).';

COMMENT ON FUNCTION poly_parse_unary IS
  'Разбор унарных операций.';

COMMENT ON FUNCTION poly_peek_token IS
  'Просмотр текущего токена без потребления.';

COMMENT ON FUNCTION poly_pp_from_ctx IS
  'Ряд Close (pp) из контекста.';

COMMENT ON FUNCTION poly_sub IS
  'Вычитание рядов.';

COMMENT ON FUNCTION poly_tokenize IS
  'Лексер poly-формулы.';

COMMENT ON FUNCTION resolve_indicator_params IS
  'Параметры индикатора (period и др.) для расчёта.';

COMMENT ON PROCEDURE sync_security_indicator_series IS
  'Синхронизация (пересчёт) серий индикатора на бумаге.';

COMMENT ON PROCEDURE sync_security_indicator_series_all IS
  'Синхронизация всех серий индикаторов на бумаге.';


-- @optional-http-block
-- Ниже: CREATE EXTENSION + процедуры load_*_http (часть B скрипта 02).
-- ============================================
CREATE EXTENSION IF NOT EXISTS http;

-- Настройка CA для libcurl (pgsql-http). Без этого на Windows часто:
-- "SSL certificate problem: unable to get local issuer certificate"
CREATE OR REPLACE FUNCTION configure_http_ssl()
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_path TEXT;
    v_candidates TEXT[] := ARRAY[
        'C:/Program Files/PostgreSQL/15/ssl/certs/curl-ca-bundle.crt',
        'C:/Program Files/PostgreSQL/15/ssl/certs/cacert.pem',
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/pki/tls/certs/ca-bundle.crt'
    ];
BEGIN
    FOREACH v_path IN ARRAY v_candidates
    LOOP
        BEGIN
            PERFORM http_set_curlopt('CURLOPT_CAINFO', v_path);
            PERFORM http_set_curlopt('CURLOPT_SSL_VERIFYPEER', '1');
            RETURN;
        EXCEPTION
            WHEN OTHERS THEN
                CONTINUE;
        END;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION configure_http_ssl() IS
'Указывает libcurl путь к CA-bundle для HTTPS (pgsql-http). См. scripts/fix_pgsql_http_ssl.ps1';

-- @begin logic_cash_fund_park_http
-- ============================================
-- Парковка свободного кэша в денежный фонд (TMON/LQDT/SBMM)
-- Вызов из run_trade_cycle / Node trade-runner
-- ============================================

CREATE OR REPLACE FUNCTION logic_is_cash_fund_security(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
    );
$$;

COMMENT ON FUNCTION logic_is_cash_fund_security(INTEGER) IS
'TRUE если бумага — денежный фонд TMON/LQDT/SBMM (не закрывать стопами/сигналами)';

CREATE OR REPLACE FUNCTION logic_ensure_cash_fund_security(
    p_logic_id INTEGER,
    p_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
    v_security_id INTEGER;
BEGIN
    v_code := upper(btrim(COALESCE(p_code, '')));

    DELETE FROM logic_securities ls
    USING security_prefixes sp
    WHERE ls.security_id = sp.security_id
      AND ls.logic_id = p_logic_id
      AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
      AND (v_code = '' OR upper(sp.prefix) <> v_code);

    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN;
    END IF;

    SELECT s.id
    INTO v_security_id
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id
    WHERE upper(sp.prefix) = v_code
    ORDER BY sp.exchange_id
    LIMIT 1;

    IF v_security_id IS NULL THEN
        RETURN;
    END IF;

    UPDATE logic_securities
    SET display_order = display_order + 1
    WHERE logic_id = p_logic_id
      AND security_id <> v_security_id
      AND display_order >= 0;

    INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
    VALUES (p_logic_id, v_security_id, 0, TRUE)
    ON CONFLICT (logic_id, security_id) DO UPDATE SET
        is_active = TRUE,
        display_order = 0;
END;
$$;

COMMENT ON FUNCTION logic_ensure_cash_fund_security(INTEGER, TEXT) IS
'Добавить выбранный денежный фонд в logic_securities с display_order=0 (верх списка)';

CREATE OR REPLACE FUNCTION logic_resolve_cash_fund_instrument(p_ticker TEXT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_headers http_header[];
    v_response http_response;
    v_ticker TEXT;
    v_try TEXT;
    v_instrument JSONB;
    v_figi TEXT;
    v_lot INTEGER;
    v_price NUMERIC;
    v_price_resp JSONB;
    v_units NUMERIC;
    v_nano NUMERIC;
BEGIN
    v_ticker := upper(btrim(COALESCE(p_ticker, '')));
    IF v_ticker = '' THEN
        RETURN NULL;
    END IF;

    v_token := get_tbank_token();
    IF v_token IS NULL OR btrim(v_token) = '' THEN
        RETURN jsonb_build_object('error', 'no_tbank_token', 'ticker', v_ticker);
    END IF;

    SELECT rtrim(b.api_url, '/')
    INTO v_api_url
    FROM brokers b
    WHERE b.code = 'T-BANK'
    LIMIT 1;
    v_api_url := COALESCE(v_api_url, 'https://invest-public-api.tinkoff.ru/rest');

    PERFORM configure_http_ssl();
    v_headers := ARRAY[
        http_header('Authorization', 'Bearer ' || v_token),
        http_header('Accept', 'application/json')
    ];

    -- EtfBy: ticker + classCode TQTF (и вариант TMON@)
    FOREACH v_try IN ARRAY ARRAY[v_ticker, v_ticker || '@']
    LOOP
        SELECT * INTO v_response FROM http((
            'POST',
            v_api_url || '/tinkoff.public.invest.api.contract.v1.InstrumentsService/EtfBy',
            v_headers,
            'application/json',
            jsonb_build_object(
                'id_type', 'INSTRUMENT_ID_TYPE_TICKER',
                'classCode', 'TQTF',
                'id', v_try
            )::TEXT
        )::http_request);
        IF v_response.status = 200 THEN
            v_instrument := v_response.content::JSONB->'instrument';
            EXIT;
        END IF;
    END LOOP;

    -- Fallback: FindInstrument
    IF v_instrument IS NULL THEN
        SELECT * INTO v_response FROM http((
            'POST',
            v_api_url || '/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument',
            v_headers,
            'application/json',
            jsonb_build_object('query', v_ticker)::TEXT
        )::http_request);
        IF v_response.status = 200 THEN
            SELECT elem
            INTO v_instrument
            FROM jsonb_array_elements(
                COALESCE(v_response.content::JSONB->'instruments', '[]'::JSONB)
            ) AS elem
            WHERE upper(COALESCE(elem->>'ticker', '')) IN (v_ticker, v_ticker || '@')
               OR upper(COALESCE(elem->>'ticker', '')) LIKE v_ticker || '%'
            ORDER BY CASE WHEN upper(COALESCE(elem->>'ticker', '')) = v_ticker THEN 0 ELSE 1 END
            LIMIT 1;
        END IF;
    END IF;

    IF v_instrument IS NULL THEN
        RETURN jsonb_build_object('error', 'instrument_not_found', 'ticker', v_ticker);
    END IF;

    v_figi := COALESCE(v_instrument->>'figi', v_instrument->>'uid');
    v_lot := GREATEST(1, COALESCE(NULLIF(v_instrument->>'lot', '')::INTEGER, 1));

    IF v_figi IS NULL OR btrim(v_figi) = '' THEN
        RETURN jsonb_build_object('error', 'no_figi', 'ticker', v_ticker);
    END IF;

    SELECT * INTO v_response FROM http((
        'POST',
        v_api_url || '/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices',
        v_headers,
        'application/json',
        jsonb_build_object('figi', jsonb_build_array(v_figi))::TEXT
    )::http_request);

    IF v_response.status = 200 THEN
        v_price_resp := COALESCE(
            v_response.content::JSONB->'lastPrices'->0->'price',
            '{}'::JSONB
        );
        v_units := COALESCE((v_price_resp->>'units')::NUMERIC, 0);
        v_nano := COALESCE((v_price_resp->>'nano')::NUMERIC, 0);
        v_price := v_units + v_nano / 1000000000.0;
    END IF;

    IF v_price IS NULL OR v_price <= 0 THEN
        v_price := 100; -- типичный порядок цены БПИФ денежного рынка
    END IF;

    RETURN jsonb_build_object(
        'ticker', v_ticker,
        'figi', v_figi,
        'lot', v_lot,
        'price', v_price,
        'name', v_instrument->>'name'
    );
EXCEPTION
    WHEN undefined_function THEN
        RETURN jsonb_build_object('error', 'http_unavailable', 'ticker', v_ticker);
    WHEN OTHERS THEN
        RETURN jsonb_build_object('error', SQLERRM, 'ticker', v_ticker);
END;
$$;

COMMENT ON FUNCTION logic_resolve_cash_fund_instrument(TEXT) IS
'FIGI/лот/цена денежного фонда (EtfBy TQTF или FindInstrument + GetLastPrices)';

CREATE OR REPLACE FUNCTION logic_park_excess_cash(p_logic_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_code TEXT;
    v_threshold NUMERIC;
    v_balance NUMERIC;
    v_park_amount NUMERIC;
    v_tf_id INTEGER;
    v_tf_sec INTEGER;
    v_closed_bar_dt TIMESTAMP;
    v_last_raw TEXT;
    v_last_dt TIMESTAMP;
    v_inst JSONB;
    v_figi TEXT;
    v_lot INTEGER;
    v_price NUMERIC;
    v_qty INTEGER;
    v_order JSONB;
    v_broker_order_id TEXT;
    v_status TEXT;
    v_note TEXT;
    v_security_id INTEGER;
    v_side_open_id INTEGER;
    v_action_long_id INTEGER;
    v_trade_id BIGINT;
    v_equity NUMERIC;
    v_fund_qty NUMERIC;
    v_fund_mtm NUMERIC;
    v_excess NUMERIC;
BEGIN
    SELECT l.id, l.account_id, a.account_type, a.is_active
    INTO v_logic
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id
      AND l.is_enabled = TRUE;

    IF NOT FOUND OR NOT COALESCE(v_logic.is_active, FALSE) THEN
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'logic_inactive');
    END IF;

    v_code := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'cash_fund_code'), '')));
    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'no_fund');
    END IF;

    v_threshold := COALESCE(get_logic_param_numeric(p_logic_id, 'cash_fund_threshold', 1000000), 1000000);
    IF v_threshold < 0 THEN
        v_threshold := 0;
    END IF;

    v_balance := COALESCE(logic_ensure_balance(p_logic_id), 0);
    IF v_balance <= 0 THEN
        RETURN jsonb_build_object(
            'skipped', TRUE,
            'reason', 'no_cash',
            'balance', v_balance,
            'threshold', v_threshold
        );
    END IF;

    v_tf_id := logic_resolve_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'no_timeframe');
    END IF;
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = v_tf_id;
    v_closed_bar_dt := logic_last_closed_bar_dt(v_tf_sec);
    IF v_closed_bar_dt IS NULL THEN
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'no_closed_bar');
    END IF;

    v_last_raw := btrim(COALESCE(get_logic_param_text(p_logic_id, 'last_cash_fund_bar_dt'), ''));
    IF v_last_raw <> '' THEN
        BEGIN
            v_last_dt := v_last_raw::TIMESTAMP;
            IF v_closed_bar_dt <= v_last_dt THEN
                RETURN jsonb_build_object(
                    'skipped', TRUE,
                    'reason', 'bar_already_parked',
                    'closed_bar', v_closed_bar_dt
                );
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
    END IF;

    -- Идемпотентность: одна попытка на закрытую свечу TF
    PERFORM logic_upsert_param(
        p_logic_id,
        'last_cash_fund_bar_dt',
        to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'text'
    );

    -- Фонд в портфеле логики (сверху списка «Ценные бумаги»)
    PERFORM logic_ensure_cash_fund_security(p_logic_id, v_code);

    SELECT s.id
    INTO v_security_id
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id
    WHERE upper(sp.prefix) = v_code
    ORDER BY sp.exchange_id
    LIMIT 1;

    v_inst := NULL;
    BEGIN
        v_inst := logic_resolve_cash_fund_instrument(v_code);
    EXCEPTION
        WHEN OTHERS THEN
            v_inst := NULL;
    END;

    v_figi := v_inst->>'figi';
    v_lot := GREATEST(
        1,
        COALESCE((v_inst->>'lot')::INTEGER, NULLIF(logic_security_lot_size(v_security_id), 0), 1)
    );
    v_price := COALESCE(
        NULLIF((v_inst->>'price')::NUMERIC, 0),
        CASE WHEN v_security_id IS NOT NULL
            THEN logic_cash_fund_price_at(v_security_id, v_tf_id, v_closed_bar_dt, v_code)
            ELSE NULL
        END,
        100
    );

    IF v_price <= 0 THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'bad_price', 'detail', v_inst);
    END IF;

    -- Избыток = equity − порог; докупаем min(кэш, избыток − уже_в_фонде); фонд не продаём.
    v_equity := COALESCE(logic_portfolio_equity(p_logic_id, v_tf_id), v_balance);
    v_fund_qty := CASE
        WHEN v_security_id IS NOT NULL
            THEN logic_long_position_qty(p_logic_id, v_security_id, FALSE, FALSE)
        ELSE 0
    END;
    v_fund_mtm := COALESCE(v_fund_qty, 0) * v_price;
    v_excess := v_equity - v_threshold;
    v_park_amount := LEAST(v_balance, GREATEST(0, v_excess - v_fund_mtm));

    IF v_park_amount <= 0 THEN
        RETURN jsonb_build_object(
            'skipped', TRUE,
            'reason', 'below_threshold',
            'balance', v_balance,
            'equity', v_equity,
            'fund_mtm', v_fund_mtm,
            'excess', v_excess,
            'threshold', v_threshold
        );
    END IF;

    v_qty := (floor(v_park_amount / v_price)::INTEGER / v_lot) * v_lot;
    IF v_qty < v_lot THEN
        PERFORM logic_trade_log(
            p_logic_id,
            'cash_fund.skip_qty',
            format('Сумма %s ₽ меньше 1 лота %s по цене %s', v_park_amount, v_code, v_price),
            jsonb_build_object(
                'fund', v_code,
                'park_amount', v_park_amount,
                'equity', v_equity,
                'fund_mtm', v_fund_mtm,
                'excess', v_excess,
                'price', v_price,
                'lot', v_lot
            ),
            v_security_id,
            v_tf_id
        );
        RETURN jsonb_build_object(
            'skipped', TRUE,
            'reason', 'qty_below_lot',
            'park_amount', v_park_amount,
            'equity', v_equity,
            'price', v_price,
            'lot', v_lot
        );
    END IF;

    -- Fake / нет FIGI: симулируем BUY в боевой книге (как в тесте).
    IF v_logic.account_type = 'fake' OR v_figi IS NULL OR btrim(v_figi) = '' THEN
        SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
        SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
        IF v_security_id IS NULL OR v_side_open_id IS NULL OR v_action_long_id IS NULL THEN
            RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_security_or_sides');
        END IF;

        INSERT INTO logic_trades (
            logic_id, account_id, security_id, timeframe_id,
            side_id, action_id, position_event, signal_kind, signal_formula,
            quantity, price, bar_dt, executed_at, is_simulated, is_fictitious,
            is_shadow, is_test, trade_reason, status
        )
        VALUES (
            p_logic_id, v_logic.account_id, v_security_id, v_tf_id,
            v_side_open_id, v_action_long_id, 'open', 'cash_fund',
            format('cash_fund.park %s', v_code),
            v_qty, v_price, v_closed_bar_dt, v_closed_bar_dt, TRUE, FALSE,
            FALSE, FALSE, format('cash_fund.park:%s', v_code), 'filled'
        )
        ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow)
        DO NOTHING
        RETURNING id INTO v_trade_id;

        IF v_trade_id IS NOT NULL THEN
            PERFORM logic_trade_finalize(v_trade_id, v_balance);
            v_balance := v_balance - (v_qty * v_price);
            PERFORM logic_upsert_param(
                p_logic_id, 'current_balance', v_balance::TEXT, 'money'
            );
        END IF;

        PERFORM logic_trade_log(
            p_logic_id,
            CASE WHEN v_trade_id IS NOT NULL THEN 'cash_fund.sim_ok' ELSE 'cash_fund.sim_dup' END,
            format(
                'Бой (sim): парковка %s qty=%s price=%s bar=%s',
                v_code, v_qty, v_price, v_closed_bar_dt
            ),
            jsonb_build_object(
                'fund', v_code,
                'quantity', v_qty,
                'price', v_price,
                'park_amount', v_park_amount,
                'balance', v_balance,
                'threshold', v_threshold,
                'trade_id', v_trade_id,
                'closed_bar', v_closed_bar_dt,
                'simulated', TRUE
            ),
            v_security_id,
            v_tf_id
        );

        RETURN jsonb_build_object(
            'ok', v_trade_id IS NOT NULL,
            'simulated', TRUE,
            'fund', v_code,
            'quantity', v_qty,
            'price', v_price,
            'park_amount', v_park_amount,
            'trade_id', v_trade_id,
            'closed_bar', v_closed_bar_dt
        );
    END IF;

    v_status := 'rejected';
    v_note := NULL;
    v_broker_order_id := NULL;
    BEGIN
        v_order := tbank_post_order(v_logic.account_id, v_figi, v_qty, v_price, 'BUY');
        v_broker_order_id := COALESCE(
            v_order->>'orderId',
            v_order->>'order_id',
            v_order->'orderState'->>'orderId'
        );
        IF v_broker_order_id IS NOT NULL THEN
            v_status := 'submitted';
        ELSE
            v_note := left(COALESCE(v_order::TEXT, 'empty order response'), 500);
        END IF;
    EXCEPTION
        WHEN undefined_function THEN
            v_note := 'tbank_post_order недоступен (нет HTTP-расширения)';
        WHEN OTHERS THEN
            v_note := SQLERRM;
    END;

    PERFORM logic_trade_log(
        p_logic_id,
        CASE WHEN v_status = 'submitted' THEN 'cash_fund.order_ok' ELSE 'cash_fund.order_fail' END,
        format(
            'Парковка %s: qty=%s price=%s status=%s',
            v_code, v_qty, v_price, v_status
        ),
        jsonb_build_object(
            'fund', v_code,
            'figi', v_figi,
            'quantity', v_qty,
            'price', v_price,
            'park_amount', v_park_amount,
            'balance', v_balance,
            'threshold', v_threshold,
            'status', v_status,
            'broker_order_id', v_broker_order_id,
            'note', v_note,
            'closed_bar', v_closed_bar_dt
        ),
        v_security_id,
        v_tf_id
    );

    RETURN jsonb_build_object(
        'ok', v_status = 'submitted',
        'fund', v_code,
        'quantity', v_qty,
        'price', v_price,
        'park_amount', v_park_amount,
        'status', v_status,
        'broker_order_id', v_broker_order_id,
        'note', v_note,
        'closed_bar', v_closed_bar_dt
    );
END;
$$;

COMMENT ON FUNCTION logic_park_excess_cash(INTEGER) IS
'Каждая закрытая свеча TF: если equity > порога — BUY на min(кэш, избыток−уже_в_фонде); фонд не продаём; real→T-Bank, fake/без FIGI→sim';
-- @end logic_cash_fund_park_http


























-- instrumentId для GetCandles: ShareBy по тикеру (исправляет устаревший tbank_figi)
CREATE OR REPLACE FUNCTION resolve_tbank_instrument_id(
    p_security_id INTEGER,
    p_prefix VARCHAR,
    p_tbank_figi VARCHAR DEFAULT NULL,
    p_is_future BOOLEAN DEFAULT FALSE,
    p_class_code VARCHAR DEFAULT 'TQBR',
    p_moex_secid VARCHAR DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_headers http_header[];
    v_response http_response;
    v_instrument JSONB;
    v_id TEXT;
    v_try TEXT;
BEGIN
    v_token := get_tbank_token();

    IF p_is_future THEN
        IF v_token IS NULL OR btrim(v_token) = '' THEN
            RETURN COALESCE(p_tbank_figi, p_moex_secid, p_prefix);
        END IF;
        PERFORM configure_http_ssl();
        v_headers := ARRAY[
            http_header('Authorization', 'Bearer ' || v_token),
            http_header('Accept', 'application/json')
        ];
        FOREACH v_try IN ARRAY ARRAY[
            NULLIF(btrim(p_moex_secid), ''),
            NULLIF(btrim(p_prefix), '')
        ]
        LOOP
            CONTINUE WHEN v_try IS NULL;
            SELECT * INTO v_response FROM http((
                'POST',
                COALESCE(
                    (SELECT rtrim(b.api_url, '/') FROM brokers b WHERE b.code = 'T-BANK' LIMIT 1),
                    'https://invest-public-api.tinkoff.ru/rest'
                )
                    || '/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy',
                v_headers,
                'application/json',
                jsonb_build_object(
                    'id_type', 'INSTRUMENT_ID_TYPE_TICKER',
                    'classCode', 'SPBFUT',
                    'id', v_try
                )::TEXT
            )::http_request);
            IF v_response.status = 200 THEN
                v_instrument := v_response.content::JSONB->'instrument';
                v_id := COALESCE(v_instrument->>'uid', v_instrument->>'figi');
                IF p_security_id IS NOT NULL AND p_prefix IS NOT NULL AND v_instrument ? 'figi' THEN
                    UPDATE futures_expirations
                    SET tbank_figi = v_instrument->>'figi'
                    WHERE security_id = p_security_id
                      AND prefix = p_prefix
                      AND tbank_figi IS DISTINCT FROM v_instrument->>'figi';
                END IF;
                RETURN v_id;
            END IF;
        END LOOP;
        RETURN COALESCE(p_tbank_figi, p_moex_secid, p_prefix);
    END IF;

    IF v_token IS NULL OR btrim(v_token) = '' THEN
        RETURN COALESCE(p_tbank_figi, p_prefix);
    END IF;

    PERFORM configure_http_ssl();

    v_headers := ARRAY[
        http_header('Authorization', 'Bearer ' || v_token),
        http_header('Accept', 'application/json')
    ];

    SELECT * INTO v_response FROM http((
        'POST',
        COALESCE(
            (SELECT rtrim(b.api_url, '/') FROM brokers b WHERE b.code = 'T-BANK' LIMIT 1),
            'https://invest-public-api.tinkoff.ru/rest'
        )
            || '/tinkoff.public.invest.api.contract.v1.InstrumentsService/ShareBy',
        v_headers,
        'application/json',
        jsonb_build_object(
            'id_type', 'INSTRUMENT_ID_TYPE_TICKER',
            'classCode', p_class_code,
            'id', p_prefix
        )::TEXT
    )::http_request);

    IF v_response.status != 200 THEN
        RETURN COALESCE(p_tbank_figi, p_prefix);
    END IF;

    v_instrument := v_response.content::JSONB->'instrument';
    v_id := COALESCE(v_instrument->>'uid', v_instrument->>'figi', p_tbank_figi, p_prefix);

    IF p_security_id IS NOT NULL AND v_instrument ? 'figi' THEN
        UPDATE security_prefixes
        SET tbank_figi = v_instrument->>'figi'
        WHERE security_id = p_security_id
          AND exchange_id = 1
          AND tbank_figi IS DISTINCT FROM v_instrument->>'figi';
    END IF;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION resolve_tbank_instrument_id(INTEGER, VARCHAR, VARCHAR, BOOLEAN, VARCHAR, VARCHAR) IS
'FutureBy: сначала moex_secid (CRU6), затем prefix (CNY-9.26); ShareBy для акций';

-- Миграция колонок (существующие БД без пересоздания)
ALTER TABLE futures_expirations ADD COLUMN IF NOT EXISTS moex_secid VARCHAR(20);
ALTER TABLE prices ADD COLUMN IF NOT EXISTS contract_prefix VARCHAR(50);
ALTER TABLE price_load_log ADD COLUMN IF NOT EXISTS contract_prefix VARCHAR(50);

-- Старые 4-арг. перегрузки конфликтуют с новыми (DEFAULT → «не уникальна» при CALL)
DROP PROCEDURE IF EXISTS load_prices_from_tbank_http(INTEGER, INTEGER, DATE, DATE);
DROP PROCEDURE IF EXISTS load_prices_from_moex_http(INTEGER, INTEGER, DATE, DATE);
DROP PROCEDURE IF EXISTS load_prices_from_moex_http(INTEGER, INTEGER, DATE, DATE, VARCHAR);
DROP PROCEDURE IF EXISTS load_prices_from_moex_http(INTEGER, INTEGER, DATE, DATE, VARCHAR, INTEGER, INTEGER);

-- @include sql/load_prices_tbank_http.sql (см. sql/load_prices_tbank_http.sql — процедура ниже)
-- Процедура: load_prices_from_tbank_http
-- Загрузка цен через T-Bank API с использованием pgsql-http
-- ============================================
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

-- ============================================
-- Процедура: load_prices_from_moex_http
-- Загрузка цен через MOEX ISS API с использованием pgsql-http
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_from_moex_http(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL,
    p_moex_interval INTEGER DEFAULT NULL,
    p_start INTEGER DEFAULT 0
)
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix VARCHAR(50);
    v_tf_name VARCHAR(20);
    v_sec_type VARCHAR(50);
    v_engine VARCHAR(20);
    v_market VARCHAR(20);
    v_board VARCHAR(20);
    v_api_url TEXT;
    v_response http_response;
    v_status INTEGER;
    v_content JSONB;
    v_candles_data JSONB;
    v_columns JSONB;
    v_col_map JSONB;
    v_row JSONB;
    v_row_idx INTEGER;
    v_col_idx INTEGER;
    v_dt TIMESTAMP;
    v_open NUMERIC(18,6);
    v_high NUMERIC(18,6);
    v_low NUMERIC(18,6);
    v_close NUMERIC(18,6);
    v_volume NUMERIC(20,2);
    v_value NUMERIC(20,2);
    v_records_loaded INTEGER := 0;
    v_store_contract VARCHAR(50);
    v_moex_ticker VARCHAR(50);
    v_moex_interval INTEGER;
BEGIN
    PERFORM configure_http_ssl();

    SELECT tf INTO v_tf_name FROM timeframes WHERE id = p_timeframe_id;
    v_moex_interval := COALESCE(p_moex_interval, get_moex_candle_interval(v_tf_name));

    IF p_contract_prefix IS NOT NULL THEN
        v_prefix := p_contract_prefix;
        v_store_contract := p_contract_prefix;
        v_engine := 'futures';
        v_market := 'forts';
        v_board := 'RFUD';
        SELECT fe.moex_secid INTO v_moex_ticker
        FROM futures_expirations fe
        WHERE fe.security_id = p_security_id
          AND fe.prefix = p_contract_prefix
        LIMIT 1;
        v_moex_ticker := COALESCE(NULLIF(btrim(v_moex_ticker), ''), v_prefix);
    ELSE
        SELECT sp.prefix, st.name INTO v_prefix, v_sec_type
        FROM securities s
        JOIN security_types st ON s.security_type_id = st.id
        JOIN security_prefixes sp ON s.id = sp.security_id
        WHERE s.id = p_security_id AND sp.exchange_id = 1;

        IF v_prefix IS NULL THEN
            RAISE EXCEPTION 'Префикс не найден для security_id=%', p_security_id;
        END IF;

        v_store_contract := NULL;
        v_engine := CASE v_sec_type
            WHEN 'Stock' THEN 'stock'
            WHEN 'Futures' THEN 'futures'
            WHEN 'Bond' THEN 'bonds'
            WHEN 'Index' THEN 'stock'
            ELSE 'stock'
        END;
        v_market := CASE v_sec_type
            WHEN 'Stock' THEN 'shares'
            WHEN 'Futures' THEN 'forts'
            WHEN 'Bond' THEN 'bonds'
            WHEN 'Index' THEN 'index'
            ELSE 'shares'
        END;
        v_board := CASE v_sec_type
            WHEN 'Stock' THEN 'TQBR'
            WHEN 'Futures' THEN 'RFUD'
            WHEN 'Bond' THEN 'TQOB'
            ELSE 'TQBR'
        END;

        IF v_engine = 'futures' THEN
            v_prefix := get_active_future_prefix(p_security_id, p_date_to);
            IF v_prefix IS NULL THEN
                RAISE EXCEPTION 'Активный фьючерс не найден для security_id=% на дату %',
                    p_security_id, p_date_to;
            END IF;
            v_store_contract := v_prefix;
        END IF;
    END IF;

    -- FORTS ISS: нет M15/M5/M2/… — только 1, 10, 60, 24, 7, 31, 4 → M10/M1 + resample
    IF v_engine = 'futures'
       AND v_moex_interval NOT IN (1, 10, 60, 24, 7, 31, 4)
    THEN
        CALL load_prices_moex_via_m1_resample(
            p_security_id, p_timeframe_id, p_date_from, p_date_to, p_contract_prefix
        );
        RETURN;
    END IF;

    IF p_contract_prefix IS NOT NULL THEN
        v_prefix := v_moex_ticker;
    END IF;

    v_api_url := format(
        'https://iss.moex.com/iss/engines/%s/markets/%s/boards/%s/securities/%s/candles.json?from=%s&till=%s&interval=%s',
        v_engine, v_market, v_board, v_prefix,
        p_date_from::TEXT,
        p_date_to::TEXT,
        v_moex_interval::TEXT
    );
    IF COALESCE(p_start, 0) > 0 THEN
        v_api_url := v_api_url || format('&start=%s', p_start);
    END IF;

    RAISE NOTICE 'MOEX API URL: %', v_api_url;

    -- Выполняем GET-запрос через pgsql-http
    SELECT * INTO v_response FROM http_get(v_api_url);

    v_status := v_response.status;
    IF v_status != 200 THEN
        RAISE EXCEPTION 'MOEX API вернул статус %: %', v_status, v_response.content;
    END IF;

    -- ============================================================
    -- БЛОК 4: РАЗБОР JSON-ОТВЕТА MOEX
    -- ============================================================
    v_content := v_response.content::JSONB;

    -- MOEX возвращает данные в формате: {"candles": {"columns": [...], "data": [...]}}
    v_candles_data := v_content->'candles'->'data';
    v_columns := v_content->'candles'->'columns';

    IF v_candles_data IS NULL OR jsonb_array_length(v_candles_data) = 0 THEN
        INSERT INTO price_load_log (security_id, timeframe_id, date_from, date_to, source, records_loaded, error_message)
        VALUES (p_security_id, p_timeframe_id, p_date_from, p_date_to, 'MOEX', 0,
            format('MOEX ISS: нет свечей %s за период (interval=%s; URL: %s)',
                v_tf_name, v_moex_interval, left(v_api_url, 160)));
        RAISE NOTICE 'MOEX вернул пустой массив свечей';
        RETURN;
    END IF;

    -- Создаем маппинг колонок: название -> индекс
    v_col_map := '{}'::JSONB;
    FOR v_col_idx IN 0 .. jsonb_array_length(v_columns) - 1
    LOOP
        v_col_map := jsonb_set(v_col_map, ARRAY[v_columns->>v_col_idx], to_jsonb(v_col_idx));
    END LOOP;

    -- ============================================================
    -- БЛОК 5: ЗАПИСЬ СВЕЧЕЙ В БАЗУ
    -- ============================================================
    FOR v_row_idx IN 0 .. jsonb_array_length(v_candles_data) - 1
    LOOP
        v_row := v_candles_data->v_row_idx;

        -- Извлекаем данные по индексам колонок
        v_dt := (v_row->>(v_col_map->>'begin')::INTEGER)::TIMESTAMP;
        v_open := (v_row->>(v_col_map->>'open')::INTEGER)::NUMERIC;
        v_high := (v_row->>(v_col_map->>'high')::INTEGER)::NUMERIC;
        v_low := (v_row->>(v_col_map->>'low')::INTEGER)::NUMERIC;
        v_close := (v_row->>(v_col_map->>'close')::INTEGER)::NUMERIC;
        v_volume := (v_row->>(v_col_map->>'volume')::INTEGER)::NUMERIC;
        v_value := (v_row->>(v_col_map->>'value')::INTEGER)::NUMERIC;

        -- Вставляем свечу
        CALL insert_candle(
            p_security_id, p_timeframe_id, v_dt,
            v_open, v_high, v_low, v_close,
            v_volume, v_value, v_store_contract
        );

        v_records_loaded := v_records_loaded + 1;
    END LOOP;

    -- ============================================================
    -- БЛОК 6: ЛОГИРОВАНИЕ
    -- ============================================================
    INSERT INTO price_load_log (
        security_id, timeframe_id, date_from, date_to,
        source, records_loaded, contract_prefix
    )
    VALUES (
        p_security_id, p_timeframe_id, p_date_from, p_date_to,
        'MOEX', v_records_loaded, v_store_contract
    );

    RAISE NOTICE 'Загружено % свечей из MOEX (контракт %)', v_records_loaded, v_store_contract;

EXCEPTION
    WHEN OTHERS THEN
        INSERT INTO price_load_log (
            security_id, timeframe_id, date_from, date_to,
            source, records_loaded, contract_prefix, error_message
        )
        VALUES (
            p_security_id, p_timeframe_id, p_date_from, p_date_to,
            'MOEX', 0, v_store_contract, SQLERRM
        );
        RAISE;
END;
$$;

COMMENT ON PROCEDURE load_prices_from_moex_http(INTEGER, INTEGER, DATE, DATE, VARCHAR, INTEGER, INTEGER) IS 
'Загрузка MOEX ISS. p_contract_prefix — тикер контракта; p_moex_interval/p_start — M1 pagination.';

-- @include sql/load_prices_moex_resample.sql (см. sql/load_prices_moex_resample.sql — дублируется ниже)
-- MOEX fallback после неудачи T-Bank (ошибка или 0 свечей); base resample для intraday TF.
-- FORTS ISS: только interval 1,10,60,24,7,31,4 — для M15 берём M10 (быстрее M1).

CREATE OR REPLACE FUNCTION price_load_use_moex_fallback()
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT TRUE;
$$;

COMMENT ON FUNCTION price_load_use_moex_fallback() IS
'MOEX разрешён как fallback после неудачи T-Bank (ошибка или 0 свечей)';

CREATE OR REPLACE FUNCTION moex_forts_base_interval(p_requested INTEGER)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_requested IS NULL THEN 1
        WHEN p_requested IN (1, 10, 60, 24, 7, 31, 4) THEN p_requested
        WHEN p_requested < 10 THEN 1
        WHEN p_requested < 60 THEN 10
        ELSE 60
    END;
$$;

COMMENT ON FUNCTION moex_forts_base_interval(INTEGER) IS
'Ближайший поддерживаемый FORTS interval для resample (M15→10, M5→1, H2→60)';

-- ============================================

CREATE OR REPLACE PROCEDURE resample_prices_to_timeframe(
    p_security_id INTEGER,
    p_src_timeframe_id INTEGER,
    p_dst_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_dst_sec INTEGER;
    v_rows INTEGER := 0;
BEGIN
    SELECT t.sec INTO v_dst_sec FROM timeframes t WHERE t.id = p_dst_timeframe_id;
    IF v_dst_sec IS NULL OR v_dst_sec <= 0 THEN
        RAISE EXCEPTION 'resample: неизвестный dst timeframe_id=%', p_dst_timeframe_id;
    END IF;

    INSERT INTO prices (
        security_id, timeframe_id, dt,
        open_price, high_price, low_price, close_price,
        volume, value, contract_prefix
    )
    SELECT
        p.security_id,
        p_dst_timeframe_id,
        to_timestamp((extract(epoch FROM p.dt)::bigint / v_dst_sec) * v_dst_sec),
        (array_agg(p.open_price ORDER BY p.dt ASC))[1],
        max(p.high_price),
        min(p.low_price),
        (array_agg(p.close_price ORDER BY p.dt DESC))[1],
        sum(p.volume),
        sum(p.value),
        max(p.contract_prefix)
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_src_timeframe_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to
    GROUP BY p.security_id, 3
    ON CONFLICT (security_id, timeframe_id, dt)
    DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        volume = EXCLUDED.volume,
        value = EXCLUDED.value,
        contract_prefix = COALESCE(EXCLUDED.contract_prefix, prices.contract_prefix);

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    RAISE NOTICE 'resample → TF id=%: % свечей (% — %)', p_dst_timeframe_id, v_rows, p_date_from, p_date_to;
END;
$$;

COMMENT ON PROCEDURE resample_prices_to_timeframe(INTEGER, INTEGER, INTEGER, DATE, DATE) IS
'Агрегирует свечи более мелкого TF в целевой (epoch-бакеты по sec целевого TF)';

CREATE OR REPLACE PROCEDURE load_moex_interval_candles_paginated(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL,
    p_moex_interval INTEGER DEFAULT 1
)
LANGUAGE plpgsql AS $$
DECLARE
    v_src_tf_id INTEGER;
    v_src_tf VARCHAR(20);
    v_day DATE;
    v_start INTEGER;
    v_batch INTEGER;
    v_total INTEGER := 0;
    v_interval INTEGER;
BEGIN
    v_interval := COALESCE(NULLIF(p_moex_interval, 0), 1);
    v_src_tf := CASE v_interval
        WHEN 1 THEN 'M1'
        WHEN 10 THEN 'M10'
        WHEN 60 THEN 'H1'
        ELSE 'M1'
    END;

    SELECT t.id INTO v_src_tf_id FROM timeframes t WHERE t.tf = v_src_tf LIMIT 1;
    IF v_src_tf_id IS NULL THEN
        RAISE EXCEPTION 'timeframe % not found for MOEX interval %', v_src_tf, v_interval;
    END IF;

    v_day := p_date_from;
    WHILE v_day <= p_date_to LOOP
        v_start := 0;
        LOOP
            CALL load_prices_from_moex_http(
                p_security_id, v_src_tf_id, v_day, v_day, p_contract_prefix, v_interval, v_start
            );
            SELECT records_loaded INTO v_batch
            FROM price_load_log
            WHERE security_id = p_security_id
              AND timeframe_id = v_src_tf_id
              AND date_from = v_day
              AND date_to = v_day
              AND source = 'MOEX'
            ORDER BY id DESC
            LIMIT 1;
            v_batch := COALESCE(v_batch, 0);
            v_total := v_total + v_batch;
            EXIT WHEN v_batch = 0 OR v_batch < 500;
            v_start := v_start + 500;
        END LOOP;
        v_day := v_day + 1;
    END LOOP;

    RAISE NOTICE 'MOEX % paginated: % свечей (% — %)', v_src_tf, v_total, p_date_from, p_date_to;
END;
$$;

COMMENT ON PROCEDURE load_moex_interval_candles_paginated(INTEGER, DATE, DATE, VARCHAR, INTEGER) IS
'Загрузка MOEX FORTS/ISS по дням с пагинацией (interval 1/10/60)';

-- Совместимость: старое имя → M1
CREATE OR REPLACE PROCEDURE load_moex_m1_candles_paginated(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL
)
LANGUAGE plpgsql AS $$
BEGIN
    CALL load_moex_interval_candles_paginated(
        p_security_id, p_date_from, p_date_to, p_contract_prefix, 1
    );
END;
$$;

COMMENT ON PROCEDURE load_moex_m1_candles_paginated(INTEGER, DATE, DATE, VARCHAR) IS
'Загрузка M1 с MOEX по дням с пагинацией start=500';

CREATE OR REPLACE PROCEDURE load_prices_moex_via_base_resample(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL,
    p_base_interval INTEGER DEFAULT 10
)
LANGUAGE plpgsql AS $$
DECLARE
    v_src_tf_id INTEGER;
    v_src_tf VARCHAR(20);
    v_tf_name VARCHAR(20);
    v_resampled INTEGER := 0;
    v_base INTEGER;
BEGIN
    v_base := moex_forts_base_interval(COALESCE(p_base_interval, 10));
    v_src_tf := CASE v_base
        WHEN 1 THEN 'M1'
        WHEN 10 THEN 'M10'
        WHEN 60 THEN 'H1'
        ELSE 'M1'
    END;
    SELECT t.id INTO v_src_tf_id FROM timeframes t WHERE t.tf = v_src_tf LIMIT 1;
    SELECT tf INTO v_tf_name FROM timeframes WHERE id = p_timeframe_id;

    RAISE NOTICE 'MOEX resample: % → % → % (% — %)', v_tf_name, v_src_tf, v_tf_name, p_date_from, p_date_to;

    CALL load_moex_interval_candles_paginated(
        p_security_id, p_date_from, p_date_to, p_contract_prefix, v_base
    );
    CALL resample_prices_to_timeframe(
        p_security_id, v_src_tf_id, p_timeframe_id, p_date_from, p_date_to
    );

    SELECT COUNT(*)::INTEGER INTO v_resampled
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to;

    INSERT INTO price_load_log (
        security_id, timeframe_id, date_from, date_to,
        source, records_loaded, contract_prefix, error_message
    )
    VALUES (
        p_security_id, p_timeframe_id, p_date_from, p_date_to,
        format('MOEX-%s', v_src_tf), v_resampled, p_contract_prefix,
        format('MOEX ISS не отдаёт %s напрямую; resample из %s', v_tf_name, v_src_tf)
    );
END;
$$;

COMMENT ON PROCEDURE load_prices_moex_via_base_resample(INTEGER, INTEGER, DATE, DATE, VARCHAR, INTEGER) IS
'Fallback: загрузка базового FORTS interval (обычно M10) + resample в целевой TF';

CREATE OR REPLACE PROCEDURE load_prices_moex_via_m1_resample(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tf_name VARCHAR(20);
    v_req INTEGER;
    v_base INTEGER;
BEGIN
    SELECT tf INTO v_tf_name FROM timeframes WHERE id = p_timeframe_id;
    v_req := get_moex_candle_interval(v_tf_name);
    v_base := moex_forts_base_interval(v_req);
    -- Для M15/M20/M30 предпочитаем M10 (в ~10× меньше HTTP, чем M1)
    CALL load_prices_moex_via_base_resample(
        p_security_id, p_timeframe_id, p_date_from, p_date_to, p_contract_prefix, v_base
    );
END;
$$;

COMMENT ON PROCEDURE load_prices_moex_via_m1_resample(INTEGER, INTEGER, DATE, DATE, VARCHAR) IS
'Fallback: FORTS base interval (M10 для M15) + resample в целевой TF';

-- MOEX ASSETCODE для группового префикса (CR → CNY, GD → GOLD, …)
CREATE OR REPLACE FUNCTION moex_future_asset_code(p_group_prefix VARCHAR)
RETURNS VARCHAR
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE upper(btrim(p_group_prefix))
        WHEN 'CR' THEN 'CNY'
        WHEN 'BR' THEN 'BR'
        WHEN 'GD' THEN 'GOLD'
        WHEN 'SV' THEN 'SILV'
        WHEN 'MX' THEN 'MIX'
        WHEN 'RI' THEN 'RTS'
        WHEN 'EU' THEN 'Eu'
        WHEN 'NG' THEN 'NG'
        WHEN 'SBRF' THEN 'SBRF'
        WHEN 'GAZR' THEN 'GAZR'
        WHEN 'LKOH' THEN 'LKOH'
        WHEN 'VTBR' THEN 'VTBR'
        WHEN 'GL' THEN 'GL'
        WHEN 'SI' THEN 'Si'
        ELSE btrim(p_group_prefix)
    END;
$$;

COMMENT ON FUNCTION moex_future_asset_code(VARCHAR) IS
'Код базового актива MOEX FORTS для группового префикса (CR → CNY, GD → GOLD, MX → MIX …)';

-- Синхронизация контрактов фьючерса из MOEX ISS → futures_expirations
CREATE OR REPLACE PROCEDURE sync_futures_expirations_from_moex(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_group_prefix VARCHAR(50);
    v_note TEXT;
    v_asset_code VARCHAR(50);
    v_url TEXT;
    v_response http_response;
    v_content JSONB;
    v_data JSONB;
    v_columns JSONB;
    v_col_map JSONB;
    v_row JSONB;
    v_row_idx INTEGER;
    v_col_idx INTEGER;
    v_secid TEXT;
    v_shortname TEXT;
    v_asset TEXT;
    v_lastdel DATE;
    v_cutoff DATE;
    v_synced INTEGER := 0;
BEGIN
    PERFORM configure_http_ssl();

    SELECT sp.prefix, sp.note INTO v_group_prefix, v_note
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    IF v_group_prefix IS NULL THEN
        RAISE EXCEPTION 'Префикс группы не найден для security_id=%', p_security_id;
    END IF;

    IF is_perpetual_future_group(v_group_prefix, v_note) THEN
        INSERT INTO futures_expirations (security_id, prefix, expiration_date, is_active)
        VALUES (p_security_id, v_group_prefix, DATE '2100-01-01', TRUE)
        ON CONFLICT (security_id, prefix) DO UPDATE SET
            expiration_date = EXCLUDED.expiration_date,
            is_active = TRUE;
        RETURN;
    END IF;

    v_asset_code := moex_future_asset_code(v_group_prefix);
    v_cutoff := LEAST(p_date_from, COALESCE(p_date_to, p_date_from)) - INTERVAL '400 days';

    v_url := 'https://iss.moex.com/iss/engines/futures/markets/forts/securities.json'
        || '?iss.meta=off&iss.only=securities'
        || '&securities.columns=SECID,SHORTNAME,ASSETCODE,LASTTRADEDATE,LASTDELDATE';

    SELECT * INTO v_response FROM http_get(v_url);
    IF v_response.status != 200 THEN
        RAISE EXCEPTION 'MOEX securities list: status %', v_response.status;
    END IF;

    v_content := v_response.content::JSONB;
    v_data := v_content->'securities'->'data';
    v_columns := v_content->'securities'->'columns';

    IF v_data IS NULL OR jsonb_array_length(v_data) = 0 THEN
        RAISE EXCEPTION 'MOEX securities list: пустой ответ';
    END IF;

    v_col_map := '{}'::JSONB;
    FOR v_col_idx IN 0 .. jsonb_array_length(v_columns) - 1
    LOOP
        v_col_map := jsonb_set(v_col_map, ARRAY[v_columns->>v_col_idx], to_jsonb(v_col_idx));
    END LOOP;

    FOR v_row_idx IN 0 .. jsonb_array_length(v_data) - 1
    LOOP
        v_row := v_data->v_row_idx;
        v_secid := v_row->>(v_col_map->>'SECID')::INTEGER;
        v_shortname := v_row->>(v_col_map->>'SHORTNAME')::INTEGER;
        v_asset := v_row->>(v_col_map->>'ASSETCODE')::INTEGER;
        v_lastdel := NULLIF(v_row->>(v_col_map->>'LASTDELDATE')::INTEGER, '')::DATE;

        IF v_shortname IS NULL OR v_lastdel IS NULL THEN
            CONTINUE;
        END IF;

        IF upper(v_asset) = upper(v_asset_code)
           OR upper(v_secid) LIKE upper(v_group_prefix) || '%'
        THEN
            IF v_lastdel >= v_cutoff THEN
                INSERT INTO futures_expirations (security_id, prefix, moex_secid, expiration_date, is_active)
                VALUES (p_security_id, v_shortname, v_secid, v_lastdel, TRUE)
                ON CONFLICT (security_id, prefix) DO UPDATE SET
                    moex_secid = EXCLUDED.moex_secid,
                    expiration_date = EXCLUDED.expiration_date,
                    is_active = TRUE;
                v_synced := v_synced + 1;
            END IF;
        END IF;
    END LOOP;

    RAISE NOTICE 'sync_futures_expirations_from_moex: security_id=% synced % (group=%, asset=%)',
        p_security_id, v_synced, v_group_prefix, v_asset_code;
END;
$$;

COMMENT ON PROCEDURE sync_futures_expirations_from_moex(INTEGER, DATE, DATE) IS
'Подтягивает контракты MOEX FORTS в futures_expirations по групповому префиксу (Si, CR→CNY …)';

-- Загрузка фьючерса: обход контрактов от date_to назад (rollover)
CREATE OR REPLACE PROCEDURE load_prices_futures_http(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_seg_to DATE := p_date_to;
    v_seg_from DATE;
    v_contract RECORD;
    v_tbank_total INTEGER := 0;
    v_seg_records INTEGER;
    v_moex_total INTEGER := 0;
    v_logged_no_contract BOOLEAN := FALSE;
    v_have INTEGER := 0;
BEGIN
    PERFORM configure_http_ssl();

    CALL sync_futures_expirations_from_moex(p_security_id, p_date_from, p_date_to);

    LOOP
        SELECT * INTO v_contract
        FROM get_future_contract_for_date(p_security_id, v_seg_to);

        IF NOT FOUND THEN
            CALL sync_futures_expirations_from_moex(p_security_id, p_date_from, v_seg_to);
            SELECT * INTO v_contract
            FROM get_future_contract_for_date(p_security_id, v_seg_to);
            IF NOT FOUND THEN
                IF NOT v_logged_no_contract AND v_tbank_total = 0 THEN
                    INSERT INTO price_load_log (
                        security_id, timeframe_id, date_from, date_to,
                        source, records_loaded, error_message
                    )
                    VALUES (
                        p_security_id, p_timeframe_id, p_date_from, p_date_to,
                        'T-BANK', 0,
                        format('Контракт не найден на дату %s после sync MOEX', v_seg_to)
                    );
                    v_logged_no_contract := TRUE;
                END IF;
                EXIT;
            END IF;
        END IF;

        v_seg_from := GREATEST(p_date_from, v_contract.start_date);

        BEGIN
            CALL load_prices_from_tbank_http(
                p_security_id, p_timeframe_id, v_seg_from, v_seg_to,
                v_contract.prefix, v_contract.tbank_figi
            );
            SELECT records_loaded INTO v_seg_records
            FROM price_load_log
            WHERE security_id = p_security_id
              AND timeframe_id = p_timeframe_id
              AND date_from = v_seg_from
              AND date_to = v_seg_to
              AND source = 'T-BANK'
            ORDER BY id DESC
            LIMIT 1;
            v_tbank_total := v_tbank_total + COALESCE(v_seg_records, 0);
        EXCEPTION
            WHEN OTHERS THEN
                INSERT INTO price_load_log (
                    security_id, timeframe_id, date_from, date_to,
                    source, records_loaded, contract_prefix, error_message
                )
                VALUES (
                    p_security_id, p_timeframe_id, v_seg_from, v_seg_to,
                    'T-BANK', 0, v_contract.prefix, SQLERRM
                );
        END;

        IF v_seg_from <= p_date_from THEN
            EXIT;
        END IF;
        v_seg_to := v_seg_from - 1;
    END LOOP;

    -- Не выходим сразу после частичного T-Bank: SSL часто обрывает неделю → добиваем MOEX
    SELECT COUNT(*)::INTEGER INTO v_have
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to;
    IF v_tbank_total > 0 AND v_have >= 40 THEN
        RETURN;
    END IF;

    v_seg_to := p_date_to;
    LOOP
        SELECT * INTO v_contract
        FROM get_future_contract_for_date(p_security_id, v_seg_to);
        IF NOT FOUND THEN
            EXIT;
        END IF;
        v_seg_from := GREATEST(p_date_from, v_contract.start_date);

        BEGIN
            CALL load_prices_from_moex_http(
                p_security_id, p_timeframe_id, v_seg_from, v_seg_to,
                v_contract.prefix
            );
            SELECT records_loaded INTO v_seg_records
            FROM price_load_log
            WHERE security_id = p_security_id
              AND timeframe_id = p_timeframe_id
              AND date_from = v_seg_from
              AND date_to = v_seg_to
              AND source = 'MOEX'
            ORDER BY id DESC
            LIMIT 1;
            v_moex_total := v_moex_total + COALESCE(v_seg_records, 0);
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;

        IF v_seg_from <= p_date_from THEN
            EXIT;
        END IF;
        v_seg_to := v_seg_from - 1;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_prices_futures_http(INTEGER, INTEGER, DATE, DATE) IS
'Фьючерс-группа: загрузка по контрактам от date_to назад (Si-6.26 → Si-3.26 …), T-Bank → MOEX';

-- ============================================
-- ГЛАВНАЯ ПРОЦЕДУРА: load_prices_http
-- Сначала T-Bank, если не сработало -- MOEX
-- ============================================
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
    PERFORM set_config('statement_timeout', '180000', true);
    PERFORM configure_http_ssl();

    SELECT (st.name = 'Futures') INTO v_is_future
    FROM securities s
    JOIN security_types st ON s.security_type_id = st.id
    WHERE s.id = p_security_id;

    SELECT sp.prefix, sp.note INTO v_group_prefix, v_note
    FROM security_prefixes sp
    WHERE sp.security_id = p_security_id AND sp.exchange_id = 1;

    -- Фьючерсы: M10→M15 по дням дольше 3 мин при SSL-ретраях
    IF v_is_future THEN
        PERFORM set_config('statement_timeout', '900000', true);
    END IF;

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

    IF v_is_future THEN
        CALL load_prices_futures_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
        SELECT COALESCE(SUM(records_loaded), 0) INTO v_tbank_records
        FROM price_load_log
        WHERE security_id = p_security_id
          AND timeframe_id = p_timeframe_id
          AND date_from >= p_date_from
          AND date_to <= p_date_to
          AND source = 'T-BANK'
          AND loaded_at >= (CURRENT_TIMESTAMP - INTERVAL '5 minutes');
        IF COALESCE(v_tbank_records, 0) = 0 THEN
            SELECT COALESCE(SUM(records_loaded), 0) INTO v_moex_records
            FROM price_load_log
            WHERE security_id = p_security_id
              AND timeframe_id = p_timeframe_id
              AND date_from >= p_date_from
              AND date_to <= p_date_to
              AND source = 'MOEX'
              AND loaded_at >= (CURRENT_TIMESTAMP - INTERVAL '5 minutes');
        END IF;
        RETURN;
    END IF;

    -- Акции и прочее: T-Bank → MOEX
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

        IF COALESCE(v_moex_records, 0) = 0 THEN
            SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;
            IF COALESCE(v_tf_sec, 0) > 60 AND COALESCE(v_tf_sec, 0) < 86400 THEN
                BEGIN
                    CALL load_prices_moex_via_m1_resample(
                        p_security_id, p_timeframe_id, p_date_from, p_date_to
                    );
                    RAISE NOTICE 'MOEX M1 resample выполнен для security_id=% tf_id=%',
                        p_security_id, p_timeframe_id;
                EXCEPTION
                    WHEN OTHERS THEN
                        RAISE NOTICE 'MOEX M1 resample не удался: %', SQLERRM;
                END;
            END IF;
        END IF;
    END IF;
END;
$$;

COMMENT ON PROCEDURE load_prices_http(INTEGER, INTEGER, DATE, DATE) IS 
'Загрузка цен: сначала T-Bank; при ошибке или 0 свечей — MOEX (+ M1 resample).';

-- ============================================
-- Процедура: load_prices_batch_http
-- Загрузка цен для нескольких бумаг сразу
-- ============================================
CREATE OR REPLACE PROCEDURE load_prices_batch_http(
    p_security_ids INTEGER[],
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_security_id INTEGER;
BEGIN
    FOREACH v_security_id IN ARRAY p_security_ids
    LOOP
        BEGIN
            CALL load_prices_http(v_security_id, p_timeframe_id, p_date_from, p_date_to);
            RAISE NOTICE 'Загружены цены для security_id=%', v_security_id;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Ошибка загрузки для security_id=%: %', v_security_id, SQLERRM;
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_prices_batch_http(INTEGER[], INTEGER, DATE, DATE) IS 
'Загружает цены для массива бумаг по одному таймфрейму и периоду через pgsql-http.
Требует установки расширения: CREATE EXTENSION http;';

-- ============================================
-- Процедура: load_all_timeframes_http
-- Загрузка всех таймфреймов для одной бумаги
-- ============================================
CREATE OR REPLACE PROCEDURE load_all_timeframes_http(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tf RECORD;
BEGIN
    FOR v_tf IN SELECT id FROM timeframes WHERE COALESCE(is_active, TRUE) = TRUE ORDER BY sec
    LOOP
        BEGIN
            CALL load_prices_http(p_security_id, v_tf.id, p_date_from, p_date_to);
            RAISE NOTICE 'Загружен таймфрейм id=% для security_id=%', v_tf.id, p_security_id;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Ошибка загрузки таймфрейма id=%: %', v_tf.id, SQLERRM;
        END;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE load_all_timeframes_http(INTEGER, DATE, DATE) IS 
'Загружает все таймфреймы для одной бумаги через pgsql-http.
Требует установки расширения: CREATE EXTENSION http;';

-- ============================================
-- T-BANK API через pgsql-http (счета, портфель, сделки)
-- Все HTTP-вызовы к брокеру/бирже — только из PostgreSQL.
-- ============================================

CREATE OR REPLACE FUNCTION get_tbank_api_url(p_broker_id INTEGER DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_url TEXT;
BEGIN
    IF p_broker_id IS NOT NULL THEN
        SELECT api_url INTO v_url FROM brokers WHERE id = p_broker_id;
        IF v_url IS NOT NULL THEN
            RETURN rtrim(v_url, '/');
        END IF;
    END IF;
    SELECT api_url INTO v_url FROM brokers WHERE code = 'T-BANK' LIMIT 1;
    RETURN rtrim(COALESCE(v_url, 'https://invest-public-api.tinkoff.ru/rest'), '/');
END;
$$;

COMMENT ON FUNCTION get_tbank_api_url(INTEGER) IS
'Базовый REST URL T-Bank из brokers.api_url';

CREATE OR REPLACE FUNCTION tbank_http_post(
    p_api_url TEXT,
    p_rpc_path TEXT,
    p_token TEXT,
    p_body JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_url TEXT;
    v_headers http_header[];
    v_response http_response;
    v_content JSONB;
BEGIN
    PERFORM configure_http_ssl();

    v_url := rtrim(COALESCE(p_api_url, get_tbank_api_url()), '/')
        || '/' || ltrim(p_rpc_path, '/');

    v_headers := ARRAY[
        http_header('Authorization', 'Bearer ' || p_token),
        http_header('Accept', 'application/json')
    ];

    SELECT * INTO v_response FROM http((
        'POST',
        v_url,
        v_headers,
        'application/json',
        COALESCE(p_body, '{}'::jsonb)::TEXT
    )::http_request);

    IF v_response.status != 200 THEN
        RAISE EXCEPTION 'T-Bank API HTTP %: %', v_response.status, v_response.content;
    END IF;

    v_content := v_response.content::JSONB;
    IF v_content ? 'code' AND (v_content->>'code') NOT IN ('', '0') THEN
        RAISE EXCEPTION 'T-Bank API: %', COALESCE(v_content->>'message', v_response.content);
    END IF;

    RETURN v_content;
END;
$$;

COMMENT ON FUNCTION tbank_http_post(TEXT, TEXT, TEXT, JSONB) IS
'Универсальный POST к T-Bank Invest API через pgsql-http';

CREATE OR REPLACE FUNCTION tbank_verify_token()
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_headers http_header[];
    v_response http_response;
    v_content JSONB;
BEGIN
    v_token := get_tbank_token();
    IF v_token IS NULL OR btrim(v_token) = '' THEN
        RETURN jsonb_build_object(
            'has_token', false,
            'valid', false,
            'error_message', 'Токен T-Bank не задан'
        );
    END IF;

    PERFORM configure_http_ssl();
    v_api_url := get_tbank_api_url();

    v_headers := ARRAY[
        http_header('Authorization', 'Bearer ' || v_token),
        http_header('Accept', 'application/json')
    ];

    SELECT * INTO v_response FROM http((
        'POST',
        rtrim(v_api_url, '/')
            || '/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts',
        v_headers,
        'application/json',
        '{}'
    )::http_request);

    IF v_response.status = 200 THEN
        v_content := v_response.content::JSONB;
        IF v_content ? 'code' AND btrim(COALESCE(v_content->>'code', '')) NOT IN ('', '0') THEN
            RETURN jsonb_build_object(
                'has_token', true,
                'valid', false,
                'error_message', COALESCE(
                    v_content->>'message',
                    'T-Bank API отклонил токен'
                )
            );
        END IF;
        RETURN jsonb_build_object(
            'has_token', true,
            'valid', true,
            'error_message', NULL
        );
    END IF;

    IF v_response.status = 401 THEN
        RETURN jsonb_build_object(
            'has_token', true,
            'valid', false,
            'error_message', 'Токен T-Bank неактивен или просрочен. Введите новый API-токен.'
        );
    END IF;

    RETURN jsonb_build_object(
        'has_token', true,
        'valid', false,
        'error_message', format('T-Bank API HTTP %s', v_response.status)
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'has_token', true,
            'valid', false,
            'error_message', SQLERRM
        );
END;
$$;

COMMENT ON FUNCTION tbank_verify_token() IS
'Проверка API-токена T-Bank (UsersService/GetAccounts); JSON: has_token, valid, error_message';

CREATE OR REPLACE FUNCTION format_money_ru(
    p_amount NUMERIC,
    p_currency VARCHAR DEFAULT 'RUB'
)
RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
    IF p_amount IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN to_char(p_amount, 'FM999G999G999G990D00') || ' '
        || CASE upper(COALESCE(p_currency, 'RUB'))
            WHEN 'RUB' THEN '₽'
            WHEN 'USD' THEN '$'
            WHEN 'EUR' THEN '€'
            ELSE upper(p_currency)
        END;
END;
$$;

COMMENT ON FUNCTION format_money_ru(NUMERIC, VARCHAR) IS
'Форматирование суммы для UI (остаток на счёте)';

CREATE OR REPLACE FUNCTION fetch_tbank_accounts(
    p_api_url TEXT,
    p_token TEXT
)
RETURNS JSONB
LANGUAGE sql AS $$
    SELECT COALESCE(
        tbank_http_post(
            p_api_url,
            'tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts',
            p_token,
            '{}'::jsonb
        )->'accounts',
        '[]'::jsonb
    );
$$;

COMMENT ON FUNCTION fetch_tbank_accounts(TEXT, TEXT) IS
'Список счетов T-Bank (GetAccounts)';

CREATE OR REPLACE FUNCTION resolve_tbank_account(
    p_api_url TEXT,
    p_token TEXT,
    p_preferred_account_id VARCHAR DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_accounts JSONB;
    v_acc JSONB;
    v_picked JSONB;
    v_i INTEGER;
    v_mapped JSONB := '[]'::jsonb;
BEGIN
    v_accounts := fetch_tbank_accounts(p_api_url, p_token);
    IF jsonb_array_length(v_accounts) = 0 THEN
        RAISE EXCEPTION 'По токену не найдено ни одного счёта в T-Bank';
    END IF;

    IF p_preferred_account_id IS NOT NULL AND btrim(p_preferred_account_id) <> '' THEN
        FOR v_i IN 0 .. jsonb_array_length(v_accounts) - 1
        LOOP
            v_acc := v_accounts->v_i;
            IF v_acc->>'id' = p_preferred_account_id THEN
                v_picked := v_acc;
                EXIT;
            END IF;
        END LOOP;
    END IF;

    IF v_picked IS NULL THEN
        FOR v_i IN 0 .. jsonb_array_length(v_accounts) - 1
        LOOP
            v_acc := v_accounts->v_i;
            IF v_acc->>'status' = 'ACCOUNT_STATUS_OPEN' THEN
                v_picked := v_acc;
                EXIT;
            END IF;
        END LOOP;
    END IF;

    IF v_picked IS NULL THEN
        v_picked := v_accounts->0;
    END IF;

    FOR v_i IN 0 .. jsonb_array_length(v_accounts) - 1
    LOOP
        v_acc := v_accounts->v_i;
        v_mapped := v_mapped || jsonb_build_array(jsonb_build_object(
            'id', v_acc->>'id',
            'name', COALESCE(v_acc->>'name', ''),
            'type', COALESCE(v_acc->>'type', ''),
            'status', COALESCE(v_acc->>'status', '')
        ));
    END LOOP;

    RETURN jsonb_build_object(
        'accounts', v_mapped,
        'account_id', v_picked->>'id',
        'account_name', COALESCE(v_picked->>'name', '')
    );
END;
$$;

COMMENT ON FUNCTION resolve_tbank_account(TEXT, TEXT, VARCHAR) IS
'Выбор счёта T-Bank по токену (GetAccounts + preferred id)';

CREATE OR REPLACE FUNCTION fetch_tbank_portfolio_balance(
    p_api_url TEXT,
    p_token TEXT,
    p_account_id VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_data JSONB;
    v_total JSONB;
    v_cash JSONB;
    v_amount NUMERIC;
    v_cash_amount NUMERIC;
    v_currency VARCHAR;
BEGIN
    v_data := tbank_http_post(
        p_api_url,
        'tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio',
        p_token,
        jsonb_build_object('accountId', p_account_id)
    );

    v_total := COALESCE(v_data->'totalAmountPortfolio', v_data->'totalAmountShares');
    v_amount := parse_tbank_quotation(v_total);
    v_cash := v_data->'totalAmountCurrencies';
    v_cash_amount := parse_tbank_quotation(v_cash);
    v_currency := COALESCE(v_total->>'currency', v_cash->>'currency', 'RUB');

    RETURN jsonb_build_object(
        'amount', v_amount,
        'cash_amount', v_cash_amount,
        'currency', v_currency,
        'display', format_money_ru(
            COALESCE(NULLIF(v_cash_amount, 0), v_amount),
            v_currency
        )
    );
END;
$$;

COMMENT ON FUNCTION fetch_tbank_portfolio_balance(TEXT, TEXT, VARCHAR) IS
'Остаток портфеля T-Bank (GetPortfolio): amount=всего, cash_amount=валюта/кэш';

CREATE OR REPLACE FUNCTION fetch_tbank_account_balance(p_account_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_account_code VARCHAR;
    v_account_type VARCHAR;
    v_broker_code VARCHAR;
    v_resolved JSONB;
BEGIN
    SELECT btrim(a.token_encrypted), b.api_url, a.account_code, a.account_type, b.code
    INTO v_token, v_api_url, v_account_code, v_account_type, v_broker_code
    FROM accounts a
    JOIN brokers b ON b.id = a.broker_id
    WHERE a.id = p_account_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Счёт id=% не найден', p_account_id;
    END IF;

    IF v_account_type = 'fake' THEN
        RETURN jsonb_build_object('display', 'демо');
    END IF;

    IF v_broker_code <> 'T-BANK' THEN
        RETURN jsonb_build_object('display', 'н/д');
    END IF;

    IF v_token IS NULL OR v_token = '' THEN
        RETURN jsonb_build_object('display', '—');
    END IF;

    v_resolved := resolve_tbank_account(v_api_url, v_token, v_account_code);
    RETURN fetch_tbank_portfolio_balance(
        v_api_url,
        v_token,
        v_resolved->>'account_id'
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'error', SQLERRM,
            'display', 'ошибка'
        );
END;
$$;

COMMENT ON FUNCTION fetch_tbank_account_balance(INTEGER) IS
'Остаток по записи accounts.id (для API/UI)';

-- Install-over / 02 apply: real-логики — начальный и текущий остаток с брокера (или 0).
DO $$
DECLARE
    v_n INTEGER;
BEGIN
    v_n := logic_sync_all_real_account_balances();
    RAISE NOTICE 'logic_sync_all_real_account_balances: % logic(s)', COALESCE(v_n, 0);
EXCEPTION
    WHEN undefined_function THEN
        RAISE NOTICE 'logic_sync_all_real_account_balances skipped (function missing)';
    WHEN OTHERS THEN
        RAISE NOTICE 'logic_sync_all_real_account_balances skipped: %', SQLERRM;
END;
$$;

-- --- Сделки (заготовки для торговли через PostgreSQL) ---

CREATE OR REPLACE FUNCTION tbank_post_order(
    p_account_id INTEGER,
    p_figi VARCHAR,
    p_quantity NUMERIC,
    p_price NUMERIC,
    p_direction VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_account_code VARCHAR;
    v_resolved JSONB;
    v_dir VARCHAR;
BEGIN
    SELECT btrim(a.token_encrypted), b.api_url, a.account_code
    INTO v_token, v_api_url, v_account_code
    FROM accounts a
    JOIN brokers b ON b.id = a.broker_id
    WHERE a.id = p_account_id AND b.code = 'T-BANK';

    IF v_token IS NULL OR v_token = '' THEN
        RAISE EXCEPTION 'T-Bank токен не найден для account_id=%', p_account_id;
    END IF;

    v_resolved := resolve_tbank_account(v_api_url, v_token, v_account_code);
    v_dir := upper(btrim(p_direction));
    IF v_dir NOT IN ('BUY', 'SELL', 'ORDER_DIRECTION_BUY', 'ORDER_DIRECTION_SELL') THEN
        RAISE EXCEPTION 'direction: BUY или SELL';
    END IF;
    IF v_dir = 'BUY' THEN
        v_dir := 'ORDER_DIRECTION_BUY';
    ELSIF v_dir = 'SELL' THEN
        v_dir := 'ORDER_DIRECTION_SELL';
    END IF;

    RETURN tbank_http_post(
        v_api_url,
        'tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder',
        v_token,
        jsonb_build_object(
            'accountId', v_resolved->>'account_id',
            'figi', p_figi,
            'quantity', p_quantity,
            'price', jsonb_build_object(
                'units', trunc(p_price)::bigint,
                'nano', round((p_price - trunc(p_price)) * 1000000000)::integer
            ),
            'direction', v_dir,
            'orderType', 'ORDER_TYPE_LIMIT',
            'orderId', gen_random_uuid()::text
        )
    );
END;
$$;

COMMENT ON FUNCTION tbank_post_order(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR) IS
'Лимитная заявка T-Bank (PostOrder). Для будущей торговли из PostgreSQL.';

CREATE OR REPLACE FUNCTION tbank_cancel_order(
    p_account_id INTEGER,
    p_order_id VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_account_code VARCHAR;
    v_resolved JSONB;
BEGIN
    SELECT btrim(a.token_encrypted), b.api_url, a.account_code
    INTO v_token, v_api_url, v_account_code
    FROM accounts a
    JOIN brokers b ON b.id = a.broker_id
    WHERE a.id = p_account_id AND b.code = 'T-BANK';

    IF v_token IS NULL OR v_token = '' THEN
        RAISE EXCEPTION 'T-Bank токен не найден для account_id=%', p_account_id;
    END IF;

    v_resolved := resolve_tbank_account(v_api_url, v_token, v_account_code);

    RETURN tbank_http_post(
        v_api_url,
        'tinkoff.public.invest.api.contract.v1.OrdersService/CancelOrder',
        v_token,
        jsonb_build_object(
            'accountId', v_resolved->>'account_id',
            'orderId', p_order_id
        )
    );
END;
$$;

COMMENT ON FUNCTION tbank_cancel_order(INTEGER, VARCHAR) IS
'Отмена заявки T-Bank (CancelOrder)';

CREATE OR REPLACE FUNCTION tbank_get_orders(
    p_account_id INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_account_code VARCHAR;
    v_resolved JSONB;
BEGIN
    SELECT btrim(a.token_encrypted), b.api_url, a.account_code
    INTO v_token, v_api_url, v_account_code
    FROM accounts a
    JOIN brokers b ON b.id = a.broker_id
    WHERE a.id = p_account_id AND b.code = 'T-BANK';

    IF v_token IS NULL OR v_token = '' THEN
        RAISE EXCEPTION 'T-Bank токен не найден для account_id=%', p_account_id;
    END IF;

    v_resolved := resolve_tbank_account(v_api_url, v_token, v_account_code);

    RETURN tbank_http_post(
        v_api_url,
        'tinkoff.public.invest.api.contract.v1.OrdersService/GetOrders',
        v_token,
        jsonb_build_object('accountId', v_resolved->>'account_id')
    );
END;
$$;

COMMENT ON FUNCTION tbank_get_orders(INTEGER) IS
'Список заявок T-Bank (GetOrders)';

-- Главная load_prices → HTTP (переопределение заглушек части A)
CREATE OR REPLACE PROCEDURE load_prices(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
BEGIN
    CALL load_prices_http(p_security_id, p_timeframe_id, p_date_from, p_date_to);
END;
$$;

COMMENT ON PROCEDURE load_prices(INTEGER, INTEGER, DATE, DATE) IS
'Загрузка цен: T-Bank; при ошибке или 0 свечей — MOEX (+ M1 resample).';


-- ============================================
-- ================================================================
-- ================================================================
-- ================================================================
--                    НЕОБЯЗАТЕЛЬНАЯ ЧАСТЬ
-- ================================================================
-- ================================================================
-- ================================================================
--
-- ВСЕ ЧТО НИЖЕ -- НЕ НУЖНО ДЛЯ СОЗДАНИЯ СТРУКТУРЫ БАЗЫ ДАННЫХ
-- ЭТО ПРИМЕРЫ ЗАПРОСОВ, ДОКУМЕНТАЦИЯ И СПРАВОЧНАЯ ИНФОРМАЦИЯ
-- МОЖНО НЕ ВЫПОЛНЯТЬ ЭТУ ЧАСТЬ ПРИ РАЗВЕРТЫВАНИИ БД
--
-- ================================================================
-- ================================================================
-- ================================================================


-- ============================================

-- ===== КОНЕЦ ОПЦИОНАЛЬНОГО БЛОКА HTTP (часть B скрипта 02) =====
-- Дальше — необязательная справочная часть; при развёртывании можно не выполнять.
