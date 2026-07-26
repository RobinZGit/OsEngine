-- Apply PostOrder market|limit + status helper (from 02).
CREATE OR REPLACE FUNCTION tbank_trade_status_from_post_order(p_order JSONB)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_order IS NULL THEN 'rejected'
        WHEN COALESCE(
            p_order->>'orderId',
            p_order->>'order_id',
            p_order->'orderState'->>'orderId'
        ) IS NULL THEN 'rejected'
        WHEN COALESCE(p_order->>'executionReportStatus', '') IN (
            'EXECUTION_REPORT_STATUS_FILL',
            'EXECUTION_REPORT_STATUS_PARTIALLYFILL'
        ) THEN 'filled'
        WHEN COALESCE(
            NULLIF(regexp_replace(COALESCE(p_order->>'lotsExecuted', '0'), '[^0-9.\-]', '', 'g'), ''),
            '0'
        )::numeric > 0 THEN 'filled'
        ELSE 'submitted'
    END;
$$;

COMMENT ON FUNCTION tbank_trade_status_from_post_order(JSONB) IS
'Статус сделки по ответу T-Bank PostOrder: filled / submitted / rejected.';

DROP FUNCTION IF EXISTS tbank_post_order(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR);
DROP FUNCTION IF EXISTS tbank_post_order(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR, VARCHAR);

CREATE OR REPLACE FUNCTION tbank_post_order(
    p_account_id INTEGER,
    p_figi VARCHAR,
    p_quantity NUMERIC,
    p_price NUMERIC,
    p_direction VARCHAR,
    p_order_execution VARCHAR DEFAULT 'market'
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
    v_api_url TEXT;
    v_account_code VARCHAR;
    v_resolved JSONB;
    v_dir VARCHAR;
    v_exec TEXT;
    v_body JSONB;
    v_order_type TEXT;
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

    v_exec := lower(btrim(COALESCE(p_order_execution, 'market')));
    IF v_exec IN ('limit', 'l', 'order_type_limit') THEN
        v_order_type := 'ORDER_TYPE_LIMIT';
        IF p_price IS NULL OR p_price <= 0 THEN
            RAISE EXCEPTION 'LIMIT-заявка требует цену > 0';
        END IF;
    ELSE
        v_order_type := 'ORDER_TYPE_MARKET';
    END IF;

    v_body := jsonb_build_object(
        'accountId', v_resolved->>'account_id',
        'figi', p_figi,
        'quantity', p_quantity,
        'direction', v_dir,
        'orderType', v_order_type,
        'confirmMarginTrade', TRUE,
        'orderId', gen_random_uuid()::text
    );
    IF p_price IS NOT NULL AND p_price > 0 THEN
        v_body := v_body || jsonb_build_object(
            'price', jsonb_build_object(
                'units', trunc(p_price)::bigint,
                'nano', round((p_price - trunc(p_price)) * 1000000000)::integer
            )
        );
    END IF;

    RETURN tbank_http_post(
        v_api_url,
        'tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder',
        v_token,
        v_body
    );
END;
$$;

COMMENT ON FUNCTION tbank_post_order(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR, VARCHAR) IS
'T-Bank PostOrder: order_execution=market|limit (default market); confirmMarginTrade для шорта.';

-- Param def + seed for existing logics
INSERT INTO logic_param_defs (param_key, name_ru, value_type, default_value, description, display_order) VALUES
    ('order_execution', 'Тип исполнения заявок', 'text', 'market',
     'market — рыночная заявка (сразу в сессию); limit — лимитная по цене сигнала (может висеть в стакане). По умолчанию market', 18)
ON CONFLICT (param_key) DO UPDATE SET
    name_ru = EXCLUDED.name_ru,
    value_type = EXCLUDED.value_type,
    default_value = EXCLUDED.default_value,
    description = EXCLUDED.description,
    display_order = EXCLUDED.display_order;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, 'order_execution', 'market', 'text'
FROM logics l
ON CONFLICT (logic_id, param_key) DO NOTHING;

CREATE OR REPLACE FUNCTION logic_order_execution(p_logic_id INTEGER)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN lower(btrim(COALESCE(get_logic_param_text(p_logic_id, 'order_execution'), 'market')))
             IN ('limit', 'l', 'order_type_limit')
        THEN 'limit'
        ELSE 'market'
    END;
$$;

COMMENT ON FUNCTION logic_order_execution(INTEGER) IS
'Тип исполнения заявок логики: market (по умолчанию) или limit — из logic_params.order_execution';
