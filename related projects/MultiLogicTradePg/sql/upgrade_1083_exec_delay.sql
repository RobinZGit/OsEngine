-- #1083/#1084: идемпотентная миграция для уже установленных БД.
-- Добавляет поля задержки исполнения и безопасную цену T-Bank ДО применения 01/02.
-- Вызывается установщиками только в upgrade-ветке (после drop_public_routines, до 01).
-- Безопасна на любом состоянии БД: все объекты создаются IF NOT EXISTS / CREATE OR REPLACE.

-- ----------------------------------------------------------------------------
-- 1) Колонки задержки в сделках и прогонах теста
-- ----------------------------------------------------------------------------
DO $upgrade_1083$
BEGIN
    IF to_regclass('public.logic_trades') IS NOT NULL THEN
        ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS exec_delay_sec NUMERIC(12, 3);
        COMMENT ON COLUMN logic_trades.exec_delay_sec IS
            '#1083: задержка исполнения в секундах от закрытия сигнального бара (bar_dt + timeframe.sec) до executed_at; NULL — не измерима (EOD/forced close)';
    END IF;
    IF to_regclass('public.logic_backtest_runs') IS NOT NULL THEN
        ALTER TABLE logic_backtest_runs ADD COLUMN IF NOT EXISTS exec_delay_sec INTEGER NOT NULL DEFAULT 0;
        COMMENT ON COLUMN logic_backtest_runs.exec_delay_sec IS
            '#1083: исполнение сделок теста через N секунд после закрытия сигнального бара (вместо случайного ±% проскальзывания); UI default 30';
    END IF;
END
$upgrade_1083$;

-- ----------------------------------------------------------------------------
-- 2) Формула задержки и триггер (сигнал = закрытие бара bar_dt + tf.sec)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION logic_trades_calc_exec_delay_sec(
    p_bar_dt TIMESTAMP,
    p_executed_at TIMESTAMP,
    p_timeframe_id INTEGER,
    p_is_test BOOLEAN,
    p_signal_formula TEXT,
    p_trade_reason TEXT
)
RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf_sec INTEGER;
BEGIN
    IF p_bar_dt IS NULL OR p_executed_at IS NULL THEN
        RETURN NULL;
    END IF;
    IF COALESCE(p_signal_formula, '') LIKE '%eod.close%'
       OR COALESCE(p_trade_reason, '') ~* '(eod|close_all|force|stop_loss|take_profit)' THEN
        RETURN NULL;
    END IF;
    SELECT sec INTO v_tf_sec FROM timeframes WHERE id = p_timeframe_id;
    IF v_tf_sec IS NULL OR v_tf_sec <= 0 THEN
        RETURN NULL;
    END IF;
    IF EXTRACT(SECOND FROM p_bar_dt) <> 0
       OR MOD(EXTRACT(MINUTE FROM p_bar_dt)::INTEGER, GREATEST(1, v_tf_sec / 60)) <> 0 THEN
        RETURN NULL;
    END IF;
    RETURN GREATEST(0, ROUND(EXTRACT(EPOCH FROM
        (p_executed_at - (p_bar_dt + v_tf_sec * INTERVAL '1 second')))::NUMERIC, 3));
END;
$$;

CREATE OR REPLACE FUNCTION logic_trades_exec_delay_trg() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.exec_delay_sec IS NULL THEN
        NEW.exec_delay_sec := logic_trades_calc_exec_delay_sec(
            NEW.bar_dt, NEW.executed_at, NEW.timeframe_id, NEW.is_test,
            NEW.signal_formula, NEW.trade_reason);
    END IF;
    RETURN NEW;
END;
$$;

DO $upgrade_1083_trg$
BEGIN
    IF to_regclass('public.logic_trades') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS logic_trades_exec_delay_trg ON logic_trades;
        CREATE TRIGGER logic_trades_exec_delay_trg
            BEFORE INSERT OR UPDATE OF bar_dt, executed_at, timeframe_id, signal_formula, trade_reason
            ON logic_trades FOR EACH ROW EXECUTE FUNCTION logic_trades_exec_delay_trg();
    END IF;
END
$upgrade_1083_trg$;

-- ----------------------------------------------------------------------------
-- 3) Бэклит старых сделок (только NULL, идемпотентно)
-- ----------------------------------------------------------------------------
DO $upgrade_1083_backfill$
BEGIN
    IF to_regclass('public.logic_trades') IS NOT NULL THEN
        UPDATE logic_trades lt
        SET exec_delay_sec = logic_trades_calc_exec_delay_sec(
            lt.bar_dt, lt.executed_at, lt.timeframe_id, lt.is_test,
            lt.signal_formula, lt.trade_reason)
        WHERE lt.exec_delay_sec IS NULL;
    END IF;
END
$upgrade_1083_backfill$;

-- ----------------------------------------------------------------------------
-- 4) Безопасная цена T-Bank «за штуку».
--    Намеренно НЕ вызывает parse_tbank_quotation/tbank_order_unit_price:
--    в upgrade-ветке эти функции уже удалены drop_public_routines.sql, а 02
--    применяется позже. Локальный парсер делает функцию работоспособной сразу.
-- ----------------------------------------------------------------------------
-- Локальный аналог parse_tbank_quotation (units+nano / число / строка).
-- Отдельное имя, чтобы не конфликтовать с 02, гдеparse_tbank_quotation
-- создаётся позже. После применения 02 не используется, но безвреден.
CREATE OR REPLACE FUNCTION upgrade_1083_parse_tbank_quotation(p_value JSONB)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_units BIGINT;
    v_nano INTEGER;
BEGIN
    IF p_value IS NULL OR p_value = 'null'::JSONB THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_value) = 'number' THEN
        RETURN p_value::TEXT::NUMERIC(18, 6);
    END IF;
    IF jsonb_typeof(p_value) = 'string' THEN
        RETURN (p_value #>> '{}')::NUMERIC(18, 6);
    END IF;
    v_units := COALESCE((p_value->>'units')::BIGINT, 0);
    v_nano := COALESCE((p_value->>'nano')::INTEGER, 0);
    RETURN v_units + (v_nano / 1000000000.0);
END;
$$;

CREATE OR REPLACE FUNCTION logic_order_fill_unit_price(p_order JSONB)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v NUMERIC;
    v_lots NUMERIC;
    v_total NUMERIC;
BEGIN
    IF p_order IS NULL THEN
        RETURN NULL;
    END IF;
    v := upgrade_1083_parse_tbank_quotation(
        COALESCE(p_order->'averagePositionPrice', p_order->'average_position_price'));
    IF v IS NOT NULL AND v > 0 THEN
        RETURN round(v, 6);
    END IF;
    v := upgrade_1083_parse_tbank_quotation(COALESCE(p_order->'initialSecurityPrice', p_order->'initial_security_price'));
    IF v IS NOT NULL AND v > 0 THEN
        RETURN round(v, 6);
    END IF;
    v := upgrade_1083_parse_tbank_quotation(p_order->'stages'->0->'price');
    IF v IS NOT NULL AND v > 0 THEN
        RETURN round(v, 6);
    END IF;
    v_lots := COALESCE(
        NULLIF(regexp_replace(
            COALESCE(p_order->>'lotsExecuted', p_order->>'lots_executed', '0'),
            '[^0-9.\-]', '', 'g'
        ), ''), '0')::numeric;
    v_total := upgrade_1083_parse_tbank_quotation(COALESCE(p_order->'executedOrderPrice', p_order->'executed_order_price'));
    IF v_total IS NOT NULL AND v_total > 0 THEN
        IF v_lots > 1 THEN
            RETURN round(v_total / v_lots, 6);
        END IF;
        RETURN round(v_total, 6);
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION logic_order_fill_unit_price(JSONB) IS
    '#1084: безопасная цена T-Bank за штуку; не зависит от tbank_order_unit_price (которой может не быть в БД)';
