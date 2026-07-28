-- Apply PostOrder market|limit + status helper (from 02).
-- For shares→lots fix use: api/scripts/apply-tbank-post-order-lots.sql
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
