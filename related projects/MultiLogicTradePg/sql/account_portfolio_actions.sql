-- Account-level portfolio actions (real T-Bank only): sell-all + bond resolve.
-- Included in 02 after tbank_get_orders (optional-http-block).

CREATE OR REPLACE FUNCTION account_require_real_tbank(p_account_id INTEGER)
RETURNS TABLE (
    account_id INTEGER,
    account_code VARCHAR,
    api_url TEXT,
    token TEXT,
    broker_account_id TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_type VARCHAR;
    v_broker VARCHAR;
    v_token TEXT;
    v_api TEXT;
    v_code VARCHAR;
    v_resolved JSONB;
BEGIN
    SELECT a.id, a.account_code, a.account_type, b.code, btrim(a.token_encrypted), b.api_url
    INTO account_id, v_code, v_type, v_broker, v_token, v_api
    FROM accounts a
    JOIN brokers b ON b.id = a.broker_id
    WHERE a.id = p_account_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Счёт id=% не найден', p_account_id;
    END IF;
    IF lower(COALESCE(v_type, '')) <> 'real' THEN
        RAISE EXCEPTION 'Действие доступно только для реального счёта';
    END IF;
    IF v_broker <> 'T-BANK' THEN
        RAISE EXCEPTION 'Действие доступно только для брокера T-BANK';
    END IF;
    IF v_token IS NULL OR v_token = '' THEN
        RAISE EXCEPTION 'На счёте нет API-токена T-Bank';
    END IF;

    v_resolved := resolve_tbank_account(v_api, v_token, v_code);
    account_code := v_code;
    api_url := v_api;
    token := v_token;
    broker_account_id := v_resolved->>'account_id';
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION account_require_real_tbank(INTEGER) IS
'Проверка: реальный счёт T-Bank с токеном; возвращает реквизиты для HTTP';

CREATE OR REPLACE FUNCTION fetch_tbank_portfolio_positions(p_account_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_acc RECORD;
    v_data JSONB;
BEGIN
    SELECT * INTO v_acc FROM account_require_real_tbank(p_account_id) LIMIT 1;

    v_data := tbank_http_post(
        v_acc.api_url,
        'tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio',
        v_acc.token,
        jsonb_build_object('accountId', v_acc.broker_account_id)
    );

    RETURN jsonb_build_object(
        'account_id', p_account_id,
        'broker_account_id', v_acc.broker_account_id,
        'cash_amount', parse_tbank_quotation(v_data->'totalAmountCurrencies'),
        'portfolio_amount', parse_tbank_quotation(
            COALESCE(v_data->'totalAmountPortfolio', v_data->'totalAmountShares')
        ),
        'positions', COALESCE(v_data->'positions', '[]'::JSONB)
    );
END;
$$;

COMMENT ON FUNCTION fetch_tbank_portfolio_positions(INTEGER) IS
'Позиции реального счёта T-Bank (GetPortfolio.positions) + cash_amount';

CREATE OR REPLACE FUNCTION account_sell_all_at_market(p_account_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_pack JSONB;
    v_pos JSONB;
    v_type TEXT;
    v_figi TEXT;
    v_ticker TEXT;
    v_lots NUMERIC;
    v_qty NUMERIC;
    v_price NUMERIC;
    v_dir TEXT;
    v_order JSONB;
    v_sold JSONB := '[]'::JSONB;
    v_errors JSONB := '[]'::JSONB;
    v_skipped JSONB := '[]'::JSONB;
BEGIN
    v_pack := fetch_tbank_portfolio_positions(p_account_id);

    FOR v_pos IN SELECT value FROM jsonb_array_elements(COALESCE(v_pack->'positions', '[]'::JSONB))
    LOOP
        v_type := upper(COALESCE(v_pos->>'instrumentType', v_pos->>'instrument_type', ''));
        IF v_type LIKE '%CURRENCY%' THEN
            v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
                'figi', v_pos->>'figi',
                'reason', 'currency'
            ));
            CONTINUE;
        END IF;

        v_figi := NULLIF(btrim(COALESCE(v_pos->>'figi', '')), '');
        v_ticker := COALESCE(v_pos->>'ticker', v_figi, '?');
        IF v_figi IS NULL THEN
            v_errors := v_errors || jsonb_build_array(jsonb_build_object(
                'ticker', v_ticker,
                'error', 'no_figi'
            ));
            CONTINUE;
        END IF;

        v_lots := COALESCE(parse_tbank_quotation(v_pos->'quantityLots'), 0);
        IF v_lots = 0 THEN
            v_qty := COALESCE(parse_tbank_quotation(v_pos->'quantity'), 0);
            -- без lot size считаем quantity уже в лотах, если целое
            IF v_qty = trunc(v_qty) THEN
                v_lots := v_qty;
            END IF;
        END IF;

        IF v_lots = 0 THEN
            v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
                'figi', v_figi,
                'ticker', v_ticker,
                'reason', 'zero_lots'
            ));
            CONTINUE;
        END IF;

        IF v_lots > 0 THEN
            v_dir := 'SELL';
        ELSE
            v_dir := 'BUY';
            v_lots := abs(v_lots);
        END IF;

        v_price := COALESCE(
            NULLIF(parse_tbank_quotation(v_pos->'currentPrice'), 0),
            NULLIF(parse_tbank_quotation(v_pos->'averagePositionPriceFifo'), 0),
            NULLIF(parse_tbank_quotation(v_pos->'averagePositionPrice'), 0),
            1
        );

        BEGIN
            v_order := tbank_post_order(p_account_id, v_figi, v_lots, v_price, v_dir);
            v_sold := v_sold || jsonb_build_array(jsonb_build_object(
                'figi', v_figi,
                'ticker', v_ticker,
                'lots', v_lots,
                'price', v_price,
                'direction', v_dir,
                'instrument_type', v_type,
                'order', v_order
            ));
        EXCEPTION
            WHEN OTHERS THEN
                v_errors := v_errors || jsonb_build_array(jsonb_build_object(
                    'figi', v_figi,
                    'ticker', v_ticker,
                    'lots', v_lots,
                    'direction', v_dir,
                    'error', SQLERRM
                ));
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', jsonb_array_length(v_errors) = 0,
        'account_id', p_account_id,
        'sold_count', jsonb_array_length(v_sold),
        'error_count', jsonb_array_length(v_errors),
        'skipped_count', jsonb_array_length(v_skipped),
        'sold', v_sold,
        'errors', v_errors,
        'skipped', v_skipped,
        'cash_amount_before', v_pack->'cash_amount'
    );
END;
$$;

COMMENT ON FUNCTION account_sell_all_at_market(INTEGER) IS
'Реальный T-Bank: лимитная продажа (закрытие) всех невалютных позиций портфеля по текущей цене';

CREATE OR REPLACE FUNCTION tbank_resolve_bond_by_isin(
    p_account_id INTEGER,
    p_isin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_acc RECORD;
    v_isin TEXT;
    v_headers http_header[];
    v_response http_response;
    v_instrument JSONB;
    v_figi TEXT;
    v_lot INTEGER;
    v_price NUMERIC;
    v_price_resp JSONB;
    v_units NUMERIC;
    v_nano NUMERIC;
BEGIN
    SELECT * INTO v_acc FROM account_require_real_tbank(p_account_id) LIMIT 1;
    v_isin := upper(btrim(COALESCE(p_isin, '')));
    IF v_isin = '' THEN
        RETURN jsonb_build_object('error', 'empty_isin');
    END IF;

    PERFORM configure_http_ssl();
    v_headers := ARRAY[
        http_header('Authorization', 'Bearer ' || v_acc.token),
        http_header('Accept', 'application/json')
    ];

    -- BondBy by ISIN
    SELECT * INTO v_response FROM http((
        'POST',
        rtrim(v_acc.api_url, '/') || '/tinkoff.public.invest.api.contract.v1.InstrumentsService/BondBy',
        v_headers,
        'application/json',
        jsonb_build_object(
            'idType', 'INSTRUMENT_ID_TYPE_ISIN',
            'id', v_isin
        )::TEXT
    )::http_request);

    IF v_response.status = 200 THEN
        v_instrument := v_response.content::JSONB->'instrument';
    END IF;

    IF v_instrument IS NULL THEN
        SELECT * INTO v_response FROM http((
            'POST',
            rtrim(v_acc.api_url, '/') || '/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument',
            v_headers,
            'application/json',
            jsonb_build_object('query', v_isin)::TEXT
        )::http_request);
        IF v_response.status = 200 THEN
            SELECT elem
            INTO v_instrument
            FROM jsonb_array_elements(
                COALESCE(v_response.content::JSONB->'instruments', '[]'::JSONB)
            ) AS elem
            WHERE upper(COALESCE(elem->>'isin', '')) = v_isin
               OR upper(COALESCE(elem->>'ticker', '')) = v_isin
            ORDER BY CASE
                WHEN upper(COALESCE(elem->>'instrumentType', '')) LIKE '%BOND%' THEN 0
                ELSE 1
            END
            LIMIT 1;
        END IF;
    END IF;

    IF v_instrument IS NULL THEN
        RETURN jsonb_build_object('error', 'instrument_not_found', 'isin', v_isin);
    END IF;

    v_figi := COALESCE(v_instrument->>'figi', v_instrument->>'uid');
    v_lot := GREATEST(1, COALESCE(NULLIF(v_instrument->>'lot', '')::INTEGER, 1));
    IF v_figi IS NULL OR btrim(v_figi) = '' THEN
        RETURN jsonb_build_object('error', 'no_figi', 'isin', v_isin);
    END IF;

    SELECT * INTO v_response FROM http((
        'POST',
        rtrim(v_acc.api_url, '/') || '/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices',
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

    -- Облигации T-Bank: last price обычно в % номинала (≈90–110) → ₽ при номинале 1000.
    IF v_price IS NOT NULL AND v_price > 0 AND v_price < 200 THEN
        v_price := v_price / 100.0 * 1000.0;
    ELSIF v_price IS NULL OR v_price <= 0 THEN
        v_price := 980;
    END IF;

    RETURN jsonb_build_object(
        'isin', v_isin,
        'figi', v_figi,
        'lot', v_lot,
        'price', v_price,
        'ticker', COALESCE(v_instrument->>'ticker', v_isin),
        'name', v_instrument->>'name'
    );
EXCEPTION
    WHEN undefined_function THEN
        RETURN jsonb_build_object('error', 'http_unavailable', 'isin', p_isin);
    WHEN OTHERS THEN
        RETURN jsonb_build_object('error', SQLERRM, 'isin', p_isin);
END;
$$;

COMMENT ON FUNCTION tbank_resolve_bond_by_isin(INTEGER, TEXT) IS
'FIGI/лот/цена облигации по ISIN (BondBy / FindInstrument + GetLastPrices); только real T-Bank';
