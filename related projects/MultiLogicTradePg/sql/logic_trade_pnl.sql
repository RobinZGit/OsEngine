-- ============================================
-- Trade PnL: комиссия, FIFO / средняя, пакеты по сделкам
-- Вставляется в 02 перед process_logic_trades
-- ============================================

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

CREATE OR REPLACE FUNCTION logic_close_all_positions_at_market(p_logic_id INTEGER)
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
    v_formula TEXT := 'market:close_all';
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
          AND lt.status IN ('filled', 'submitted')
    LOOP
        v_long_qty := logic_long_position_qty(p_logic_id, v_sec.security_id);
        v_short_qty := logic_short_position_qty(p_logic_id, v_sec.security_id);

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
                quantity, price, bar_dt, is_simulated, is_fictitious,
                broker_order_id, status, note
            )
            VALUES (
                p_logic_id, v_logic.account_id, v_sec.security_id, v_tf_id,
                v_side_close_id, v_action_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE,
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
                quantity, price, bar_dt, is_simulated, is_fictitious,
                broker_order_id, status, note
            )
            VALUES (
                p_logic_id, v_logic.account_id, v_sec.security_id, v_tf_id,
                v_side_close_id, v_action_id, 'counter', v_formula,
                v_quantity, v_price, v_bar_dt, v_is_simulated, FALSE,
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

COMMENT ON FUNCTION logic_close_all_positions_at_market(INTEGER) IS
'Ручное закрытие всех открытых long/short; цена из БД или load_prices; PnL через logic_trade_finalize';
