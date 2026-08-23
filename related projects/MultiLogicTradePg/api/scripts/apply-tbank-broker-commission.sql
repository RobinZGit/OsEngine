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
    v_refinalized INTEGER := 0;
    v_rebuild_error TEXT := NULL;
    v_errors JSONB := '[]'::JSONB;
BEGIN
    FOR v_tr IN
        SELECT lt.id, lt.account_id, lt.broker_order_id, lt.price, lt.commission,
               lt.logic_id, lt.side_id, lt.is_simulated
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

                -- Финальная цена/комиссия изменили входы PnL: пересобрать пакеты
                -- и financial_result этой сделки СРАЗУ (не ждать полного rebuild).
                IF v_price IS NOT NULL AND v_price > 0
                   AND COALESCE(v_price, 0) IS DISTINCT FROM v_tr.price THEN
                    PERFORM logic_trade_finalize(v_tr.id, NULL);
                    v_refinalized := v_refinalized + 1;
                END IF;
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

    -- Полный ребилд истории: гарантирует согласованность пакетов/PnL.
    -- Ошибка rebuild не должна теряться молча — попадает в результат и warning.
    BEGIN
        IF p_logic_id IS NOT NULL THEN
            PERFORM logic_trade_rebuild_pnl(p_logic_id);
        ELSE
            PERFORM logic_trade_rebuild_pnl(l.id)
            FROM logics l
            JOIN accounts a ON a.id = l.account_id
            WHERE a.account_type = 'real';
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            v_rebuild_error := SQLERRM;
            RAISE WARNING 'logic_sync_real_trade_broker_fees: rebuild_pnl failed: %', SQLERRM;
    END;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'updated', v_updated,
        'refinalized', v_refinalized,
        'rebuild_error', v_rebuild_error,
        'errors', v_errors,
        'logic_id', p_logic_id
    );
END;
$$;

COMMENT ON FUNCTION logic_sync_real_trade_broker_fees(INTEGER) IS
'Подтянуть комиссию/цену исполнения с T-Bank GetOrderState; при изменении цены закрытия — сразу пересобрать её пакеты/PnL; в конце полный rebuild_pnl';

-- Детектор испорченного боевого FinRes:
--  1) finres <> 0 при полном отсутствии пакетов закрытия (значение писалось мимо build_lots
--     или пакеты потеряны) — как баг MTLRP +20737 (2026-08-18);
--  2) |finres| математически невозможен для записанных цен:
--     |finres| > qty × GREATEST(price_close, max(price_open из пакетов)) + комиссии.
CREATE OR REPLACE FUNCTION logic_trades_finres_anomalies(
    p_logic_id INTEGER DEFAULT NULL
)
RETURNS TABLE(
    logic_id INTEGER,
    close_trade_id BIGINT,
    security_id INTEGER,
    executed_at TIMESTAMP,
    quantity NUMERIC,
    price NUMERIC,
    financial_result NUMERIC,
    commission NUMERIC,
    lots_count BIGINT,
    reason TEXT
)
LANGUAGE sql STABLE AS $$
    WITH close_side AS (
        SELECT id FROM sides WHERE name = 'Close' LIMIT 1
    ),
    closes AS (
        SELECT
            lt.id AS close_trade_id,
            lt.logic_id,
            lt.security_id,
            lt.executed_at,
            lt.quantity,
            lt.price,
            COALESCE(lt.financial_result, 0) AS finres,
            COALESCE(lt.commission, 0) AS comm,
            (SELECT COUNT(*) FROM logic_trade_lots l WHERE l.close_trade_id = lt.id) AS lots_count,
            COALESCE((
                SELECT MAX(ot.price)
                FROM logic_trade_lots l
                JOIN logic_trades ot ON ot.id = l.open_trade_id
                WHERE l.close_trade_id = lt.id
            ), lt.price) AS max_open_px
        FROM logic_trades lt
        WHERE COALESCE(lt.is_test, FALSE) = FALSE
          AND COALESCE(lt.is_shadow, FALSE) = FALSE
          AND lt.status = 'filled'
          AND lt.side_id = (SELECT id FROM close_side)
          AND (p_logic_id IS NULL OR lt.logic_id = p_logic_id)
    )
    SELECT
        c.logic_id,
        c.close_trade_id,
        c.security_id,
        c.executed_at,
        c.quantity,
        c.price,
        c.finres AS financial_result,
        c.comm AS commission,
        c.lots_count,
        CASE
            WHEN c.finres <> 0 AND c.lots_count = 0
                THEN 'finres_without_lots'
            WHEN abs(c.finres) > c.quantity * GREATEST(c.price, c.max_open_px) + c.comm + 0.01
                THEN 'finres_out_of_bounds'
        END AS reason
    FROM closes c
    WHERE c.finres <> 0
      AND (
        c.lots_count = 0
        OR abs(c.finres) > c.quantity * GREATEST(c.price, c.max_open_px) + c.comm + 0.01
      )
$$;

COMMENT ON FUNCTION logic_trades_finres_anomalies(INTEGER) IS
'Боевые Close-сделки с подозрительным FinRes: без пакетов или вне физически возможного диапазона цен (NULL = все логики)';
