\set ON_ERROR_STOP on
SELECT configure_http_ssl();
SELECT length(get_tbank_token()) AS token_len;

DO $$
DECLARE
    v_token TEXT;
    v_resp http_response;
    v_h http_header[];
    v_tickers TEXT[] := ARRAY['CNY-9.26', 'CRU6', 'Si-9.26', 'SiU6'];
    v_t TEXT;
BEGIN
    v_token := get_tbank_token();
    v_h := ARRAY[
        http_header('Authorization', 'Bearer ' || v_token),
        http_header('Accept', 'application/json')
    ];
    FOREACH v_t IN ARRAY v_tickers
    LOOP
        SELECT * INTO v_resp FROM http((
            'POST',
            'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy',
            v_h,
            'application/json',
            jsonb_build_object(
                'id_type', 'INSTRUMENT_ID_TYPE_TICKER',
                'classCode', 'SPBFUT',
                'id', v_t
            )::TEXT
        )::http_request);
        RAISE NOTICE '% ticker=% status=% uid=% figi=%',
            v_t, v_t, v_resp.status,
            v_resp.content::jsonb->'instrument'->>'uid',
            v_resp.content::jsonb->'instrument'->>'figi';
    END LOOP;
END $$;
