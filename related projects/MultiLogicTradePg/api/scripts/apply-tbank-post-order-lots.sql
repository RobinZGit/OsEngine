-- Hotfix: PostOrder quantity must be LOTS (T-Invest API).
-- Runner historically passed SHARES → order size × instrument.lot (e.g. FLOT 13 → 130).
-- Apply on remote: psql -d multilogictrade -f api/scripts/apply-tbank-post-order-lots.sql
-- Also refresh MOEX TQBR lot sizes in securities (below).

DROP FUNCTION IF EXISTS tbank_post_order(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR);
DROP FUNCTION IF EXISTS tbank_post_order(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR, VARCHAR);
DROP FUNCTION IF EXISTS tbank_post_order(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR, VARCHAR, BOOLEAN);

CREATE OR REPLACE FUNCTION tbank_figi_lot_size(
    p_api_url TEXT,
    p_token TEXT,
    p_figi VARCHAR
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_response http_response;
    v_headers http_header[];
    v_instrument JSONB;
    v_lot INTEGER;
    v_sec_id INTEGER;
BEGIN
    IF p_figi IS NULL OR btrim(p_figi) = '' THEN
        RETURN 1;
    END IF;

    BEGIN
        PERFORM configure_http_ssl();
        v_headers := ARRAY[
            http_header('Authorization', 'Bearer ' || p_token),
            http_header('Accept', 'application/json')
        ];
        SELECT * INTO v_response FROM http((
            'POST',
            rtrim(COALESCE(p_api_url, 'https://invest-public-api.tinkoff.ru/rest'), '/')
                || '/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy',
            v_headers,
            'application/json',
            jsonb_build_object(
                'id_type', 'INSTRUMENT_ID_TYPE_FIGI',
                'id', btrim(p_figi)
            )::TEXT
        )::http_request);
        IF v_response.status = 200 THEN
            v_instrument := COALESCE(v_response.content::JSONB->'instrument', v_response.content::JSONB);
            v_lot := NULLIF(regexp_replace(COALESCE(v_instrument->>'lot', ''), '[^0-9]', '', 'g'), '')::INTEGER;
            IF v_lot IS NOT NULL AND v_lot >= 1 THEN
                SELECT sp.security_id INTO v_sec_id
                FROM security_prefixes sp
                WHERE sp.tbank_figi = btrim(p_figi)
                ORDER BY sp.exchange_id
                LIMIT 1;
                IF v_sec_id IS NOT NULL THEN
                    UPDATE securities
                    SET lot_size = v_lot
                    WHERE id = v_sec_id
                      AND lot_size IS DISTINCT FROM v_lot;
                END IF;
                RETURN v_lot;
            END IF;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            NULL;
    END;

    SELECT GREATEST(1, COALESCE(s.lot_size, 1))
    INTO v_lot
    FROM security_prefixes sp
    JOIN securities s ON s.id = sp.security_id
    WHERE sp.tbank_figi = btrim(p_figi)
    ORDER BY sp.exchange_id
    LIMIT 1;

    RETURN GREATEST(1, COALESCE(v_lot, 1));
END;
$$;

CREATE OR REPLACE FUNCTION tbank_post_order(
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
    v_resolved JSONB;
    v_dir VARCHAR;
    v_exec TEXT;
    v_body JSONB;
    v_order_type TEXT;
    v_lot INTEGER;
    v_lots BIGINT;
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

    IF COALESCE(p_quantity_is_lots, FALSE) THEN
        v_lots := floor(COALESCE(p_quantity, 0))::BIGINT;
    ELSE
        v_lot := tbank_figi_lot_size(v_api_url, v_token, p_figi);
        v_lots := floor(COALESCE(p_quantity, 0) / v_lot)::BIGINT;
    END IF;
    IF v_lots IS NULL OR v_lots < 1 THEN
        RAISE EXCEPTION
            'tbank_post_order: need ≥1 lot (qty=%, is_lots=%, figi=%)',
            p_quantity, COALESCE(p_quantity_is_lots, FALSE), p_figi;
    END IF;

    v_body := jsonb_build_object(
        'accountId', v_resolved->>'account_id',
        'figi', p_figi,
        'quantity', v_lots,
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

COMMENT ON FUNCTION tbank_post_order(INTEGER, VARCHAR, NUMERIC, NUMERIC, VARCHAR, VARCHAR, BOOLEAN) IS
'T-Bank PostOrder: quantity в лотах. По умолчанию p_quantity=штуки → деление на instrument.lot; p_quantity_is_lots=TRUE если уже лоты.';

-- Refresh TQBR lot sizes (2026-07-28 MOEX)
UPDATE securities s
SET lot_size = v.lot
FROM security_prefixes sp
JOIN exchanges e ON e.id = sp.exchange_id
JOIN (VALUES
    ('SBER', 1), ('SBERP', 1), ('GAZP', 10), ('LKOH', 1),
    ('ROSN', 1), ('NVTK', 1), ('GMKN', 10), ('TATN', 1), ('TATNP', 1),
    ('PLZL', 1), ('ALRS', 10), ('CHMF', 1), ('NLMK', 10), ('MAGN', 10),
    ('MTLR', 1), ('MTLRP', 10), ('MGNT', 1), ('MTSS', 10), ('RUAL', 10),
    ('HYDR', 1000), ('PHOR', 1), ('MOEX', 10), ('TRNFP', 1), ('UPRO', 1000),
    ('SNGS', 100), ('SNGSP', 10), ('VTBR', 1), ('IRAO', 100), ('FEES', 10000),
    ('RTKM', 10), ('YDEX', 1), ('AFLT', 10), ('FLOT', 10), ('AFKS', 100),
    ('TMON', 1), ('LQDT', 1), ('SBMM', 1)
) AS v(prefix, lot) ON sp.prefix = v.prefix
WHERE s.id = sp.security_id
  AND e.name = 'MOEX'
  AND sp.instrument_market IN ('stock', 'other');
