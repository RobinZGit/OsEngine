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
