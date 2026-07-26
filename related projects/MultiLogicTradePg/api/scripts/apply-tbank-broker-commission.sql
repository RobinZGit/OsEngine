-- Real trades: commission from T-Bank order (executedCommission / initialCommission),
-- not from logic_params.commission_pct.

CREATE OR REPLACE FUNCTION tbank_order_commission(p_order JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v NUMERIC;
BEGIN
    IF p_order IS NULL THEN
        RETURN 0;
    END IF;

    v := abs(COALESCE(
        parse_tbank_quotation(
            COALESCE(p_order->'executedCommission', p_order->'executed_commission')
        ),
        0
    ));
    IF v > 0 THEN
        RETURN round(v, 6);
    END IF;

    v := abs(COALESCE(
        parse_tbank_quotation(
            COALESCE(p_order->'initialCommission', p_order->'initial_commission')
        ),
        0
    ));
    IF v > 0 THEN
        RETURN round(v, 6);
    END IF;

    v := abs(COALESCE(
        parse_tbank_quotation(
            COALESCE(p_order->'serviceCommission', p_order->'service_commission')
        ),
        0
    ));
    RETURN round(COALESCE(v, 0), 6);
END;
$$;

COMMENT ON FUNCTION tbank_order_commission(JSONB) IS
'Комиссия T-Bank из ответа PostOrder/GetOrderState: executed → initial → service (₽)';

CREATE OR REPLACE FUNCTION tbank_order_unit_price(p_order JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v NUMERIC;
    v_lots NUMERIC;
    v_total NUMERIC;
BEGIN
    IF p_order IS NULL THEN
        RETURN NULL;
    END IF;

    -- GetOrderState: цена за штуку
    v := parse_tbank_quotation(
        COALESCE(p_order->'averagePositionPrice', p_order->'average_position_price')
    );
    IF v IS NOT NULL AND v > 0 THEN
        RETURN round(v, 6);
    END IF;

    v := parse_tbank_quotation(
        COALESCE(p_order->'initialSecurityPrice', p_order->'initial_security_price')
    );
    IF v IS NOT NULL AND v > 0 THEN
        RETURN round(v, 6);
    END IF;

    v := parse_tbank_quotation(p_order->'stages'->0->'price');
    IF v IS NOT NULL AND v > 0 THEN
        RETURN round(v, 6);
    END IF;

    v_lots := COALESCE(
        NULLIF(regexp_replace(
            COALESCE(p_order->>'lotsExecuted', p_order->>'lots_executed', '0'),
            '[^0-9.\-]', '', 'g'
        ), ''),
        '0'
    )::numeric;

    v_total := parse_tbank_quotation(
        COALESCE(p_order->'executedOrderPrice', p_order->'executed_order_price')
    );
    -- OrderState: executedOrderPrice = сумма; PostOrder: часто цена за штуку
    IF v_total IS NOT NULL AND v_total > 0 THEN
        IF v_lots > 1 THEN
            RETURN round(v_total / v_lots, 6);
        END IF;
        RETURN round(v_total, 6);
    END IF;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION tbank_order_unit_price(JSONB) IS
'Цена за единицу из T-Bank: averagePositionPrice → initialSecurityPrice → stages → executed/lots';

CREATE OR REPLACE FUNCTION tbank_get_order_state(
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
    IF p_order_id IS NULL OR btrim(p_order_id) = '' THEN
        RETURN NULL;
    END IF;

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
        'tinkoff.public.invest.api.contract.v1.OrdersService/GetOrderState',
        v_token,
        jsonb_build_object(
            'accountId', v_resolved->>'account_id',
            'orderId', btrim(p_order_id)
        )
    );
END;
$$;

COMMENT ON FUNCTION tbank_get_order_state(INTEGER, VARCHAR) IS
'T-Bank GetOrderState — статус/комиссия/цена исполнения заявки';

CREATE OR REPLACE FUNCTION logic_sync_real_trade_broker_fees(p_logic_id INTEGER DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_tr RECORD;
    v_order JSONB;
    v_comm NUMERIC;
    v_price NUMERIC;
    v_updated INTEGER := 0;
    v_errors JSONB := '[]'::JSONB;
BEGIN
    FOR v_tr IN
        SELECT lt.id, lt.account_id, lt.broker_order_id, lt.price, lt.commission, lt.logic_id
        FROM logic_trades lt
        JOIN logics l ON l.id = lt.logic_id
        JOIN accounts a ON a.id = l.account_id
        WHERE COALESCE(lt.is_simulated, FALSE) = FALSE
          AND COALESCE(lt.is_test, FALSE) = FALSE
          AND COALESCE(lt.is_shadow, FALSE) = FALSE
          AND lt.broker_order_id IS NOT NULL
          AND btrim(lt.broker_order_id) <> ''
          AND lt.status IN ('filled', 'submitted')
          AND (p_logic_id IS NULL OR lt.logic_id = p_logic_id)
          AND a.account_type = 'real'
          AND a.broker_id IN (SELECT id FROM brokers WHERE code = 'T-BANK')
        ORDER BY lt.id
    LOOP
        BEGIN
            v_order := tbank_get_order_state(v_tr.account_id, v_tr.broker_order_id);
            v_comm := tbank_order_commission(v_order);
            v_price := tbank_order_unit_price(v_order);

            IF v_comm > 0 OR (v_price IS NOT NULL AND v_price > 0) THEN
                UPDATE logic_trades
                SET
                    commission = CASE WHEN v_comm > 0 THEN v_comm ELSE commission END,
                    price = CASE
                        WHEN v_price IS NOT NULL AND v_price > 0 THEN v_price
                        ELSE price
                    END,
                    status = CASE
                        WHEN tbank_trade_status_from_post_order(v_order) = 'filled'
                        THEN 'filled'
                        ELSE status
                    END
                WHERE id = v_tr.id;
                v_updated := v_updated + 1;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                v_errors := v_errors || jsonb_build_array(jsonb_build_object(
                    'trade_id', v_tr.id,
                    'order_id', v_tr.broker_order_id,
                    'error', SQLERRM
                ));
        END;
    END LOOP;

    IF p_logic_id IS NOT NULL THEN
        PERFORM logic_trade_rebuild_pnl(p_logic_id);
    ELSE
        PERFORM logic_trade_rebuild_pnl(l.id)
        FROM logics l
        JOIN accounts a ON a.id = l.account_id
        WHERE a.account_type = 'real';
    END IF;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'updated', v_updated,
        'errors', v_errors,
        'logic_id', p_logic_id
    );
END;
$$;

COMMENT ON FUNCTION logic_sync_real_trade_broker_fees(INTEGER) IS
'Подтянуть комиссию/цену исполнения с T-Bank GetOrderState и пересчитать PnL боевых сделок';
