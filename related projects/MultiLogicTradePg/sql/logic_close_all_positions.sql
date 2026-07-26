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

-- Lookup fill from account_sell_all sold[] by figi (price / order / commission).
CREATE OR REPLACE FUNCTION logic_sold_fill_for_figi(p_sold JSONB, p_figi TEXT)
RETURNS JSONB
LANGUAGE sql STABLE AS $$
    SELECT elem
    FROM jsonb_array_elements(COALESCE(p_sold, '[]'::JSONB)) AS elem
    WHERE NULLIF(btrim(COALESCE(elem->>'figi', '')), '') = NULLIF(btrim(COALESCE(p_figi, '')), '')
    ORDER BY 1
    LIMIT 1;
$$;

-- Снять старые сигнатуры (иначе в PG останутся overload без books-only).
DROP FUNCTION IF EXISTS logic_close_all_positions_at_market(INTEGER);
DROP FUNCTION IF EXISTS logic_close_all_positions_at_market(INTEGER, BOOLEAN);

CREATE OR REPLACE FUNCTION logic_close_all_positions_at_market(
    p_logic_id INTEGER,
    p_except_cash_funds BOOLEAN DEFAULT FALSE,
    p_post_broker BOOLEAN DEFAULT TRUE,
    p_trade_reason TEXT DEFAULT NULL,
    p_sold JSONB DEFAULT NULL
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
    v_reason TEXT;
    v_quantity INTEGER;
    v_notional NUMERIC;
    v_is_simulated BOOLEAN;
    v_broker_order_id TEXT;
    v_status TEXT;
    v_note TEXT;
    v_figi TEXT;
    v_order JSONB;
    v_commission NUMERIC;
    v_direction TEXT;
    v_action_id INTEGER;
    v_close_idx INTEGER := 0;
    v_fill_price NUMERIC;
    v_sold_row JSONB;
BEGIN
    v_reason := COALESCE(
        NULLIF(btrim(p_trade_reason), ''),
        CASE WHEN p_except_cash_funds THEN 'eod.close' ELSE 'market:close_all' END
    );

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

        SELECT sp.tbank_figi INTO v_figi
        FROM security_prefixes sp
        WHERE sp.security_id = v_sec.security_id
          AND sp.tbank_figi IS NOT NULL
        ORDER BY sp.exchange_id
        LIMIT 1;

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
            v_commission := 0;
            v_order := NULL;

            IF NOT v_is_simulated AND p_post_broker THEN
                BEGIN
                    IF v_figi IS NULL THEN
                        v_status := 'rejected';
                        v_note := 'Нет tbank_figi для бумаги';
                    ELSE
                        v_order := tbank_post_order(
                            v_logic.account_id, v_figi, v_quantity, v_price, v_direction,
                            logic_order_execution(p_logic_id)
                        );
                        v_broker_order_id := COALESCE(
                            v_order->>'orderId',
                            v_order->>'order_id',
                            v_order->'orderState'->>'orderId'
                        );
                        v_status := tbank_trade_status_from_post_order(v_order);
                        v_commission := tbank_order_commission(v_order);
                        IF v_commission <= 0 AND v_broker_order_id IS NOT NULL THEN
                            BEGIN
                                v_order := tbank_get_order_state(
                                    v_logic.account_id, v_broker_order_id
                                );
                                v_commission := tbank_order_commission(v_order);
                            EXCEPTION
                                WHEN OTHERS THEN
                                    NULL;
                            END;
                        END IF;
                        v_fill_price := tbank_order_unit_price(v_order);
                        IF v_fill_price IS NOT NULL AND v_fill_price > 0 THEN
                            v_price := v_fill_price;
                        END IF;
                        IF v_status = 'rejected' THEN
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
            ELSIF NOT v_is_simulated AND NOT p_post_broker THEN
                -- Счёт уже flat (account sell-all): только книга логики, без второй заявки.
                v_sold_row := logic_sold_fill_for_figi(p_sold, v_figi);
                IF v_sold_row IS NOT NULL THEN
                    v_order := v_sold_row->'order';
                    IF NULLIF(v_sold_row->>'price', '')::NUMERIC > 0 THEN
                        v_price := (v_sold_row->>'price')::NUMERIC;
                    END IF;
                    v_fill_price := tbank_order_unit_price(v_order);
                    IF v_fill_price IS NOT NULL AND v_fill_price > 0 THEN
                        v_price := v_fill_price;
                    END IF;
                    v_commission := COALESCE(tbank_order_commission(v_order), 0);
                    v_broker_order_id := COALESCE(
                        v_order->>'orderId',
                        v_order->>'order_id',
                        v_order->'orderState'->>'orderId'
                    );
                END IF;
                v_status := 'filled';
                v_note := 'books_only: broker already flat';
            END IF;

            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, position_event, signal_kind, signal_formula,
                quantity, price, commission, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                trade_reason, broker_order_id, status, note
            )
            VALUES (
                p_logic_id, v_logic.account_id, v_sec.security_id, v_tf_id,
                v_side_close_id, v_action_id, 'close', 'counter', v_reason,
                v_quantity, v_price, COALESCE(v_commission, 0), v_bar_dt, v_is_simulated, FALSE, FALSE, FALSE,
                v_reason, v_broker_order_id, v_status, v_note
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
                        'status', v_status,
                        'post_broker', p_post_broker,
                        'trade_reason', v_reason
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
            v_commission := 0;
            v_order := NULL;

            IF NOT v_is_simulated AND p_post_broker THEN
                BEGIN
                    IF v_figi IS NULL THEN
                        v_status := 'rejected';
                        v_note := 'Нет tbank_figi для бумаги';
                    ELSE
                        v_order := tbank_post_order(
                            v_logic.account_id, v_figi, v_quantity, v_price, v_direction,
                            logic_order_execution(p_logic_id)
                        );
                        v_broker_order_id := COALESCE(
                            v_order->>'orderId',
                            v_order->>'order_id',
                            v_order->'orderState'->>'orderId'
                        );
                        v_status := tbank_trade_status_from_post_order(v_order);
                        v_commission := tbank_order_commission(v_order);
                        IF v_commission <= 0 AND v_broker_order_id IS NOT NULL THEN
                            BEGIN
                                v_order := tbank_get_order_state(
                                    v_logic.account_id, v_broker_order_id
                                );
                                v_commission := tbank_order_commission(v_order);
                            EXCEPTION
                                WHEN OTHERS THEN
                                    NULL;
                            END;
                        END IF;
                        v_fill_price := tbank_order_unit_price(v_order);
                        IF v_fill_price IS NOT NULL AND v_fill_price > 0 THEN
                            v_price := v_fill_price;
                        END IF;
                        IF v_status = 'rejected' THEN
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
            ELSIF NOT v_is_simulated AND NOT p_post_broker THEN
                v_sold_row := logic_sold_fill_for_figi(p_sold, v_figi);
                IF v_sold_row IS NOT NULL THEN
                    v_order := v_sold_row->'order';
                    IF NULLIF(v_sold_row->>'price', '')::NUMERIC > 0 THEN
                        v_price := (v_sold_row->>'price')::NUMERIC;
                    END IF;
                    v_fill_price := tbank_order_unit_price(v_order);
                    IF v_fill_price IS NOT NULL AND v_fill_price > 0 THEN
                        v_price := v_fill_price;
                    END IF;
                    v_commission := COALESCE(tbank_order_commission(v_order), 0);
                    v_broker_order_id := COALESCE(
                        v_order->>'orderId',
                        v_order->>'order_id',
                        v_order->'orderState'->>'orderId'
                    );
                END IF;
                v_status := 'filled';
                v_note := 'books_only: broker already flat';
            END IF;

            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, position_event, signal_kind, signal_formula,
                quantity, price, commission, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                trade_reason, broker_order_id, status, note
            )
            VALUES (
                p_logic_id, v_logic.account_id, v_sec.security_id, v_tf_id,
                v_side_close_id, v_action_id, 'close', 'counter', v_reason,
                v_quantity, v_price, COALESCE(v_commission, 0), v_bar_dt, v_is_simulated, FALSE, FALSE, FALSE,
                v_reason, v_broker_order_id, v_status, v_note
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
                        'status', v_status,
                        'post_broker', p_post_broker,
                        'trade_reason', v_reason
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
        'errors', v_errors,
        'post_broker', p_post_broker,
        'trade_reason', v_reason
    );
END;
$$;

COMMENT ON FUNCTION logic_close_all_positions_at_market(INTEGER, BOOLEAN, BOOLEAN, TEXT, JSONB) IS
'Закрытие long/short: p_post_broker=FALSE — только книга (после account sell-all), без второй заявки брокеру';
