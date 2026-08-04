-- ============================================
-- Канал боевых заявок T-Bank: postgres (pgsql-http) | node (локальный API)
-- Default: node. Node — обход SSL libcurl при открытом UI / Express.
-- ============================================

CREATE OR REPLACE FUNCTION tbank_order_channel()
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT CASE lower(btrim(COALESCE(
        (
            SELECT pv.value
            FROM parameter_values pv
            JOIN parameter_types pt ON pt.id = pv.parameter_type_id
            JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
            WHERE ps.name = 'Default'
              AND pt.short_name = 'APP_TBANK_ORDER_CHANNEL'
            LIMIT 1
        ),
        'node'
    )))
        WHEN 'postgres' THEN 'postgres'
        WHEN 'pg' THEN 'postgres'
        WHEN 'sql' THEN 'postgres'
        ELSE 'node'
    END;
$$;

COMMENT ON FUNCTION tbank_order_channel() IS
'Канал T-Bank HTTPS: postgres (pgsql-http) или node (прокси Express + CA НУЦ). Default node.';

CREATE OR REPLACE PROCEDURE set_tbank_order_channel(p_channel TEXT)
LANGUAGE plpgsql AS $$
DECLARE
    v_set_id INTEGER;
    v_type_id INTEGER;
    v_ch TEXT;
BEGIN
    v_ch := lower(btrim(COALESCE(p_channel, 'node')));
    IF v_ch IN ('service', 'api', 'web', 'browser') THEN
        v_ch := 'node';
    END IF;
    IF v_ch IN ('pg', 'sql') THEN
        v_ch := 'postgres';
    END IF;
    IF v_ch NOT IN ('postgres', 'node') THEN
        RAISE EXCEPTION 'APP_TBANK_ORDER_CHANNEL: ожидается postgres или node, получено %', p_channel;
    END IF;

    SELECT id INTO v_set_id FROM parameter_sets WHERE name = 'Default' LIMIT 1;
    SELECT id INTO v_type_id FROM parameter_types WHERE short_name = 'APP_TBANK_ORDER_CHANNEL' LIMIT 1;
    IF v_set_id IS NULL OR v_type_id IS NULL THEN
        RAISE EXCEPTION 'APP_TBANK_ORDER_CHANNEL not found in parameter_types';
    END IF;
    INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
    VALUES (v_set_id, v_type_id, v_ch)
    ON CONFLICT (parameter_set_id, parameter_type_id)
    DO UPDATE SET value = EXCLUDED.value;
END;
$$;

COMMENT ON PROCEDURE set_tbank_order_channel(TEXT) IS
'Установить канал боевых заявок T-Bank: postgres | node';

CREATE OR REPLACE FUNCTION tbank_order_node_base_url()
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT rtrim(COALESCE(NULLIF(btrim(
        (
            SELECT pv.value
            FROM parameter_values pv
            JOIN parameter_types pt ON pt.id = pv.parameter_type_id
            JOIN parameter_sets ps ON ps.id = pv.parameter_set_id
            WHERE ps.name = 'Default'
              AND pt.short_name = 'APP_TBANK_ORDER_NODE_URL'
            LIMIT 1
        )
    ), ''), 'http://127.0.0.1:3000'), '/');
$$;

COMMENT ON FUNCTION tbank_order_node_base_url() IS
'Базовый URL локального Node API для прокси PostOrder (по умолчанию http://127.0.0.1:3000).';

-- Прокси PostOrder через Node (системный TLS). Вызывается из tbank_post_order при channel=node.
CREATE OR REPLACE FUNCTION tbank_post_order_via_node(
    p_account_id INTEGER,
    p_figi VARCHAR,
    p_quantity NUMERIC,
    p_price NUMERIC,
    p_direction VARCHAR,
    p_order_execution VARCHAR DEFAULT 'market',
    p_quantity_is_lots BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_account_code VARCHAR;
    v_url TEXT;
    v_headers http_header[];
    v_response http_response;
    v_body JSONB;
    v_content JSONB;
BEGIN
    -- Localhost-only Node proxy; UI heartbeat not required (sell-all / close-all
    -- already post in-process). Keep API process running.
    SELECT btrim(a.token_encrypted), b.api_url, a.account_code
    INTO v_token, v_api_url, v_account_code
    FROM accounts a
    JOIN brokers b ON b.id = a.broker_id
    WHERE a.id = p_account_id AND b.code = 'T-BANK';

    IF v_token IS NULL OR v_token = '' THEN
        RAISE EXCEPTION 'T-Bank токен не найден для account_id=%', p_account_id;
    END IF;

    v_url := tbank_order_node_base_url() || '/api/internal/tbank/post-order';
    v_body := jsonb_build_object(
        'account_id', p_account_id,
        'api_url', COALESCE(v_api_url, 'https://invest-public-api.tbank.ru/rest'),
        'token', v_token,
        'account_code', v_account_code,
        'figi', p_figi,
        'quantity', p_quantity,
        'price', p_price,
        'direction', p_direction,
        'order_execution', COALESCE(p_order_execution, 'market'),
        'quantity_is_lots', COALESCE(p_quantity_is_lots, FALSE)
    );

    v_headers := ARRAY[
        http_header('Accept', 'application/json'),
        http_header('Content-Type', 'application/json')
    ];

    SELECT * INTO v_response FROM http((
        'POST',
        v_url,
        v_headers,
        'application/json',
        v_body::TEXT
    )::http_request);

    IF v_response.status IS NULL THEN
        RAISE EXCEPTION 'Node API недоступен (%). Запустите MultiLogic Trade (API) или канал Postgres.', v_url;
    END IF;

    BEGIN
        v_content := v_response.content::JSONB;
    EXCEPTION
        WHEN OTHERS THEN
            RAISE EXCEPTION 'Node API HTTP %: %', v_response.status, left(COALESCE(v_response.content, ''), 500);
    END;

    IF v_response.status != 200 THEN
        RAISE EXCEPTION 'Node API HTTP %: %',
            v_response.status,
            COALESCE(v_content->>'error', left(COALESCE(v_response.content, ''), 500));
    END IF;

    IF COALESCE(v_content->>'ok', 'true') = 'false' THEN
        RAISE EXCEPTION '%', COALESCE(v_content->>'error', 'Node PostOrder failed');
    END IF;

    RETURN COALESCE(v_content->'order', v_content);
END;
$$;

COMMENT ON FUNCTION tbank_post_order_via_node(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR, VARCHAR, BOOLEAN) IS
'PostOrder через локальный Node API (обход SSL pgsql-http). Требует открытый UI.';
