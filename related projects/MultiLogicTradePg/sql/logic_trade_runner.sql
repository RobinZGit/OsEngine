-- ============================================
-- Trade runner: оценка сигналов и logic_trades (PostgreSQL)
-- Вставляется в 02 перед @optional-pgcron-block
-- ============================================

CREATE OR REPLACE FUNCTION get_logic_param_text(p_logic_id INTEGER, p_param_key TEXT)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT lp.param_value
    FROM logic_params lp
    WHERE lp.logic_id = p_logic_id AND lp.param_key = p_param_key
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_logic_param_numeric(p_logic_id INTEGER, p_param_key TEXT, p_default NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_raw TEXT;
    v_num NUMERIC;
BEGIN
    v_raw := btrim(COALESCE(get_logic_param_text(p_logic_id, p_param_key), ''));
    IF v_raw = '' THEN
        RETURN p_default;
    END IF;
    v_num := replace(v_raw, ',', '.')::NUMERIC;
    IF v_num IS NULL THEN
        RETURN p_default;
    END IF;
    RETURN v_num;
END;
$$;

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

CREATE OR REPLACE FUNCTION logic_resolve_timeframe_id(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf TEXT;
    v_id INTEGER;
BEGIN
    v_tf := upper(btrim(COALESCE(get_logic_param_text(p_logic_id, 'timeframe'), 'M15')));
    SELECT t.id INTO v_id
    FROM timeframes t
    WHERE upper(t.tf) = v_tf AND COALESCE(t.is_active, TRUE)
    ORDER BY t.sec
    LIMIT 1;
    IF v_id IS NULL THEN
        SELECT t.id INTO v_id FROM timeframes t WHERE upper(t.tf) = 'M15' LIMIT 1;
    END IF;
    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION logic_resolve_timeframe_id(INTEGER) IS
'timeframe_id из logic_params.timeframe (код TF, по умолчанию M15)';

CREATE OR REPLACE FUNCTION logic_last_closed_bar_dt(
    p_tf_sec INTEGER,
    p_at TIMESTAMP DEFAULT LOCALTIMESTAMP
)
RETURNS TIMESTAMP
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tz TEXT := current_setting('TimeZone');
    v_epoch NUMERIC;
    v_current_bar_start NUMERIC;
BEGIN
    IF p_tf_sec IS NULL OR p_tf_sec <= 0 THEN
        RETURN NULL;
    END IF;
    v_epoch := EXTRACT(EPOCH FROM (COALESCE(p_at, LOCALTIMESTAMP) AT TIME ZONE v_tz));
    v_current_bar_start := floor(v_epoch / p_tf_sec) * p_tf_sec;
    RETURN (to_timestamp(v_current_bar_start - p_tf_sec) AT TIME ZONE v_tz)::timestamp;
END;
$$;

COMMENT ON FUNCTION logic_last_closed_bar_dt(INTEGER, TIMESTAMP) IS
'Начало последней закрытой свечи (open time) для TF с периодом p_tf_sec секунд';

CREATE OR REPLACE FUNCTION logic_bar_data_at(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_series TEXT,
    p_bar_dt TIMESTAMP
)
RETURNS TABLE (bar_dt TIMESTAMP, ind_value NUMERIC, close_price NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tf_sec INTEGER;
    v_ind_dt TIMESTAMP;
    v_ind_val NUMERIC;
    v_pp NUMERIC;
BEGIN
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;

    SELECT iv.dt, iv.value
    INTO v_ind_dt, v_ind_val
    FROM indicator_values iv
    JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
    WHERE iv.security_id = p_security_id
      AND iv.timeframe_id = p_timeframe_id
      AND iv.indicator_id = p_indicator_id
      AND upper(ivt.code) = upper(COALESCE(p_series, 'VALUE'))
      AND iv.dt = p_bar_dt
    LIMIT 1;

    IF v_ind_dt IS NULL AND v_tf_sec IS NOT NULL THEN
        SELECT iv.dt, iv.value
        INTO v_ind_dt, v_ind_val
        FROM indicator_values iv
        JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
        WHERE iv.security_id = p_security_id
          AND iv.timeframe_id = p_timeframe_id
          AND iv.indicator_id = p_indicator_id
          AND upper(ivt.code) = upper(COALESCE(p_series, 'VALUE'))
          AND iv.dt > p_bar_dt - make_interval(secs => v_tf_sec)
          AND iv.dt <= p_bar_dt
        ORDER BY iv.dt DESC
        LIMIT 1;
    END IF;

    IF v_ind_dt IS NULL THEN
        RETURN;
    END IF;

    SELECT p.close_price
    INTO v_pp
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt = v_ind_dt
    LIMIT 1;

    IF v_pp IS NULL THEN
        SELECT p.close_price
        INTO v_pp
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt <= v_ind_dt
        ORDER BY p.dt DESC
        LIMIT 1;
    END IF;

    -- close может быть ≤0 у синтетики contango (спред); торги идут по trade security.
    IF v_pp IS NULL THEN
        RETURN;
    END IF;

    bar_dt := v_ind_dt;
    ind_value := v_ind_val;
    close_price := v_pp;
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION logic_bar_data_at(INTEGER, INTEGER, INTEGER, TEXT, TIMESTAMP) IS
'Индикатор и close на закрытой свече; close допускается ≤0 (контанго/спред)';

CREATE OR REPLACE FUNCTION signal_split_params_top_level(p_params TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_out TEXT[] := ARRAY[]::TEXT[];
    v_cur TEXT := '';
    v_depth INTEGER := 0;
    v_ch TEXT;
    v_i INTEGER;
    v_s TEXT;
BEGIN
    v_s := COALESCE(p_params, '');
    FOR v_i IN 1..length(v_s) LOOP
        v_ch := substr(v_s, v_i, 1);
        IF v_ch = '(' THEN
            v_depth := v_depth + 1;
        ELSIF v_ch = ')' THEN
            v_depth := GREATEST(0, v_depth - 1);
        END IF;
        IF v_ch = ',' AND v_depth = 0 THEN
            IF btrim(v_cur) <> '' THEN
                v_out := v_out || btrim(v_cur);
            END IF;
            v_cur := '';
        ELSE
            v_cur := v_cur || v_ch;
        END IF;
    END LOOP;
    IF btrim(v_cur) <> '' THEN
        v_out := v_out || btrim(v_cur);
    END IF;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION parse_signal_series(p_params TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_part TEXT;
    v_key TEXT;
    v_val TEXT;
BEGIN
    IF p_params IS NULL OR btrim(p_params) = '' THEN
        RETURN 'VALUE';
    END IF;
    FOREACH v_part IN ARRAY signal_split_params_top_level(p_params)
    LOOP
        IF v_part ~* '^OPT\s*\(' THEN
            CONTINUE;
        END IF;
        IF position('=' IN v_part) > 0 THEN
            v_key := lower(btrim(split_part(v_part, '=', 1)));
            v_val := btrim(substr(v_part, position('=' IN v_part) + 1));
            IF v_key = 'series' AND v_val <> '' THEN
                RETURN upper(v_val);
            END IF;
        END IF;
    END LOOP;
    RETURN 'VALUE';
END;
$$;

CREATE OR REPLACE FUNCTION parse_signal_param_num(p_params TEXT, p_key TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_part TEXT;
    v_key TEXT;
    v_val TEXT;
    v_canon_key TEXT;
    v_canon_want TEXT;
BEGIN
    IF p_params IS NULL OR btrim(p_params) = '' OR p_key IS NULL THEN
        RETURN NULL;
    END IF;
    v_canon_want := CASE lower(btrim(p_key))
        WHEN 'std' THEN 'std_dev'
        WHEN 'fast' THEN 'fast_period'
        WHEN 'slow' THEN 'slow_period'
        WHEN 'signal' THEN 'signal_period'
        WHEN 'k' THEN 'k_period'
        WHEN 'd' THEN 'd_period'
        ELSE lower(btrim(p_key))
    END;
    FOREACH v_part IN ARRAY signal_split_params_top_level(p_params)
    LOOP
        IF v_part ~* '^OPT\s*\(' THEN
            CONTINUE;
        END IF;
        IF position('=' IN v_part) > 0 THEN
            v_key := lower(btrim(split_part(v_part, '=', 1)));
            v_canon_key := CASE v_key
                WHEN 'std' THEN 'std_dev'
                WHEN 'fast' THEN 'fast_period'
                WHEN 'slow' THEN 'slow_period'
                WHEN 'signal' THEN 'signal_period'
                WHEN 'k' THEN 'k_period'
                WHEN 'd' THEN 'd_period'
                ELSE v_key
            END;
            v_val := btrim(substr(v_part, position('=' IN v_part) + 1));
            IF v_canon_key = v_canon_want AND v_val <> '' AND v_val !~* '^OPT\s*\(' THEN
                BEGIN
                    RETURN replace(v_val, ',', '.')::NUMERIC;
                EXCEPTION WHEN OTHERS THEN
                    RETURN NULL;
                END;
            END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

-- Проставить period/std_dev/… из формул сигналов логики на серии бумаги (до sync).
CREATE OR REPLACE PROCEDURE logic_apply_indicator_params_from_signals(
    p_logic_id INTEGER,
    p_security_id INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_sig RECORD;
    v_parsed RECORD;
    v_period NUMERIC;
    v_std NUMERIC;
    v_fast NUMERIC;
    v_slow NUMERIC;
    v_signal NUMERIC;
    v_k NUMERIC;
    v_d NUMERIC;
    v_smooth NUMERIC;
BEGIN
    FOR v_sig IN
        SELECT lis.indicator_id, lis.formula
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
    LOOP
        SELECT * INTO v_parsed FROM parse_signal_formula(v_sig.formula);
        IF NOT COALESCE(v_parsed.valid, FALSE) THEN
            CONTINUE;
        END IF;
        v_period := parse_signal_param_num(v_parsed.params, 'period');
        v_std := COALESCE(
            parse_signal_param_num(v_parsed.params, 'std_dev'),
            parse_signal_param_num(v_parsed.params, 'std')
        );
        v_fast := COALESCE(
            parse_signal_param_num(v_parsed.params, 'fast_period'),
            parse_signal_param_num(v_parsed.params, 'fast')
        );
        v_slow := COALESCE(
            parse_signal_param_num(v_parsed.params, 'slow_period'),
            parse_signal_param_num(v_parsed.params, 'slow')
        );
        v_signal := COALESCE(
            parse_signal_param_num(v_parsed.params, 'signal_period'),
            parse_signal_param_num(v_parsed.params, 'signal')
        );
        v_k := COALESCE(
            parse_signal_param_num(v_parsed.params, 'k_period'),
            parse_signal_param_num(v_parsed.params, 'k')
        );
        v_d := COALESCE(
            parse_signal_param_num(v_parsed.params, 'd_period'),
            parse_signal_param_num(v_parsed.params, 'd')
        );
        v_smooth := parse_signal_param_num(v_parsed.params, 'smooth');

        UPDATE security_indicator_series sis
        SET
            param_period = COALESCE(v_period::INTEGER, sis.param_period),
            param_std_dev = COALESCE(v_std, sis.param_std_dev),
            param_fast_period = COALESCE(v_fast::INTEGER, sis.param_fast_period),
            param_slow_period = COALESCE(v_slow::INTEGER, sis.param_slow_period),
            param_signal_period = COALESCE(v_signal::INTEGER, sis.param_signal_period),
            param_k_period = COALESCE(v_k::INTEGER, sis.param_k_period),
            param_d_period = COALESCE(v_d::INTEGER, sis.param_d_period),
            param_smooth = COALESCE(v_smooth::INTEGER, sis.param_smooth)
        WHERE sis.security_id = p_security_id
          AND sis.indicator_id = v_sig.indicator_id
          AND sis.is_active = TRUE;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION evaluate_signal_condition(
    p_condition TEXT,
    p_pp NUMERIC,
    p_value NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_expr TEXT;
    v_left TEXT;
    v_right TEXT;
    v_op TEXT;
    v_lv NUMERIC;
    v_rv NUMERIC;
    v_i INTEGER;
    v_ch TEXT;
    v_next TEXT;
    v_num_pp TEXT;
    v_num_value TEXT;
    v_depth INTEGER := 0;
BEGIN
    v_expr := btrim(COALESCE(p_condition, ''));
    IF v_expr = '' OR p_pp IS NULL OR p_value IS NULL THEN
        RETURN FALSE;
    END IF;
    IF p_pp <= 0 THEN
        RETURN FALSE;
    END IF;

    -- Подстановка значений как NUMERIC-литералов (с точкой),
    -- иначе арифметика становится целочисленной: -10/90 = 0 вместо -0.111…
    v_num_pp := btrim(p_pp::TEXT);
    IF position('.' IN v_num_pp) = 0 THEN
        v_num_pp := v_num_pp || '.0';
    END IF;
    v_num_value := btrim(p_value::TEXT);
    IF position('.' IN v_num_value) = 0 THEN
        v_num_value := v_num_value || '.0';
    END IF;

    v_expr := regexp_replace(v_expr, '\mpp\y', v_num_pp, 'gi');
    v_expr := regexp_replace(v_expr, '\yVALUE\y', v_num_value, 'gi');
    IF v_expr ~ '[A-Za-z_]' THEN
        RETURN FALSE;
    END IF;

    -- Оператор сравнения на верхнем уровне (вне скобок): >= <= <> != > < =
    v_op := NULL;
    FOR v_i IN 1..length(v_expr) LOOP
        v_ch := substr(v_expr, v_i, 1);
        IF v_ch = '(' THEN
            v_depth := v_depth + 1;
        ELSIF v_ch = ')' THEN
            v_depth := v_depth - 1;
        ELSIF v_depth = 0 AND (v_ch = '>' OR v_ch = '<' OR v_ch = '=' OR v_ch = '!') THEN
            v_next := CASE WHEN v_i < length(v_expr) THEN substr(v_expr, v_i + 1, 1) ELSE '' END;
            IF (v_ch = '>' AND v_next = '=') OR (v_ch = '<' AND (v_next = '=' OR v_next = '>'))
               OR (v_ch = '!' AND v_next = '=') THEN
                v_op := substr(v_expr, v_i, 2);
                v_left := btrim(substr(v_expr, 1, v_i - 1));
                v_right := btrim(substr(v_expr, v_i + 2));
            ELSIF v_ch <> '!' THEN
                v_op := v_ch;
                v_left := btrim(substr(v_expr, 1, v_i - 1));
                v_right := btrim(substr(v_expr, v_i + 1));
            END IF;
            EXIT WHEN v_op IS NOT NULL;
        END IF;
    END LOOP;

    IF v_op IS NULL OR v_left IS NULL OR v_right IS NULL OR v_left = '' OR v_right = '' THEN
        RETURN FALSE;
    END IF;

    -- Арифметика над рядами: # — покомпонентное произведение (на баре = *),
    -- * / + - и скобки — числовое выражение; для рядов: свёртка/покомпонентно.
    v_left := replace(v_left, '#', '*');
    v_right := replace(v_right, '#', '*');
    IF v_left ~ '[^0-9+*/().[:space:]-]' OR v_right ~ '[^0-9+*/().[:space:]-]' THEN
        RETURN FALSE;
    END IF;

    BEGIN
        EXECUTE 'SELECT (' || v_left || ')::numeric' INTO v_lv;
        EXECUTE 'SELECT (' || v_right || ')::numeric' INTO v_rv;
    EXCEPTION WHEN OTHERS THEN
        RETURN FALSE;
    END;

    IF v_lv IS NULL OR v_rv IS NULL THEN
        RETURN FALSE;
    END IF;

    CASE v_op
        WHEN '>' THEN RETURN v_lv > v_rv;
        WHEN '<' THEN RETURN v_lv < v_rv;
        WHEN '>=' THEN RETURN v_lv >= v_rv;
        WHEN '<=' THEN RETURN v_lv <= v_rv;
        WHEN '=' THEN RETURN v_lv = v_rv;
        WHEN '!=' THEN RETURN v_lv <> v_rv;
        WHEN '<>' THEN RETURN v_lv <> v_rv;
        ELSE RETURN FALSE;
    END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION parse_signal_formula(p_formula TEXT)
RETURNS TABLE (
    valid BOOLEAN,
    indicator_code TEXT,
    params TEXT,
    condition TEXT
)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_text TEXT;
    v_at INTEGER;
    v_open INTEGER;
    v_depth INTEGER := 0;
    v_i INTEGER;
    v_code TEXT;
    v_close INTEGER;
BEGIN
    valid := FALSE;
    indicator_code := NULL;
    params := NULL;
    condition := NULL;

    v_text := btrim(COALESCE(p_formula, ''));
    v_at := position('@' IN v_text);
    IF v_at <= 0 THEN
        RETURN NEXT;
        RETURN;
    END IF;
    v_open := position('(' IN substr(v_text, v_at));
    IF v_open <= 0 THEN
        RETURN NEXT;
        RETURN;
    END IF;
    v_open := v_at + v_open - 1;
    v_code := upper(btrim(substr(v_text, v_at + 1, v_open - v_at - 1)));
    IF v_code = '' OR v_code !~ '^[A-Z0-9_]+$' THEN
        RETURN NEXT;
        RETURN;
    END IF;

    v_close := NULL;
    FOR v_i IN v_open..length(v_text) LOOP
        IF substr(v_text, v_i, 1) = '(' THEN
            v_depth := v_depth + 1;
        ELSIF substr(v_text, v_i, 1) = ')' THEN
            v_depth := v_depth - 1;
            IF v_depth = 0 THEN
                v_close := v_i;
                EXIT;
            END IF;
        END IF;
    END LOOP;
    IF v_close IS NULL THEN
        RETURN NEXT;
        RETURN;
    END IF;

    valid := TRUE;
    indicator_code := v_code;
    params := btrim(substr(v_text, v_open + 1, v_close - v_open - 1));
    condition := btrim(substr(v_text, v_close + 1));
    RETURN NEXT;
END;
$$;

-- logic_long_position_qty / logic_short_position_qty / logic_count_open_positions
-- определены в sql/logic_stop_runner.sql (поддержка is_shadow)

CREATE OR REPLACE FUNCTION logic_security_lot_size(p_security_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(1, COALESCE(
        (SELECT lot_size FROM securities WHERE id = p_security_id),
        1
    ));
$$;

COMMENT ON FUNCTION logic_security_lot_size(INTEGER) IS
'Лотность бумаги (штук в лоте); минимум 1';

CREATE OR REPLACE FUNCTION logic_security_is_futures(p_security_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM security_prefixes sp
        WHERE sp.security_id = p_security_id
          AND sp.instrument_market = 'futures'
    );
$$;

COMMENT ON FUNCTION logic_security_is_futures(INTEGER) IS
'True если у бумаги есть prefix с instrument_market = futures';

DROP FUNCTION IF EXISTS logic_calc_open_quantity(NUMERIC, NUMERIC, NUMERIC, INTEGER);

CREATE OR REPLACE FUNCTION logic_calc_open_quantity(
    p_balance NUMERIC,
    p_position_size_pct NUMERIC,
    p_price NUMERIC,
    p_lot_size INTEGER DEFAULT 1,
    p_max_order_amount NUMERIC DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_amount NUMERIC;
    v_raw INTEGER;
    v_lot INTEGER;
    v_qty INTEGER;
BEGIN
    IF p_balance IS NULL OR p_balance <= 0 THEN
        RETURN 0;
    END IF;
    IF p_price IS NULL OR p_price <= 0 THEN
        RETURN 0;
    END IF;
    IF p_position_size_pct IS NULL OR p_position_size_pct <= 0 THEN
        RETURN 0;
    END IF;
    v_lot := GREATEST(1, COALESCE(p_lot_size, 1));
    v_amount := p_balance * (p_position_size_pct / 100.0);
    IF p_max_order_amount IS NOT NULL AND p_max_order_amount > 0 THEN
        v_amount := LEAST(v_amount, p_max_order_amount);
    END IF;
    v_raw := floor(v_amount / p_price)::INTEGER;
    -- Округление вниз до целого числа лотов
    v_qty := (v_raw / v_lot) * v_lot;
    IF v_qty >= v_lot THEN
        RETURN v_qty;
    END IF;
    RETURN 0;
END;
$$;

COMMENT ON FUNCTION logic_calc_open_quantity(NUMERIC, NUMERIC, NUMERIC, INTEGER, NUMERIC) IS
'Лот: % базы / цена (опц. потолок суммы), вниз до lot_size';

-- MTM выбранного денежного фонда логики (для исключения из базы «весь портфель»).
CREATE OR REPLACE FUNCTION logic_selected_cash_fund_mtm(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
    v_sec RECORD;
    v_price NUMERIC;
    v_qty NUMERIC;
    v_mtm NUMERIC := 0;
BEGIN
    v_code := upper(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'cash_fund_code'),
        ''
    )));
    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN 0;
    END IF;

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        JOIN security_prefixes sp ON sp.security_id = ls.security_id
        WHERE ls.logic_id = p_logic_id
          AND ls.is_active = TRUE
          AND upper(sp.prefix) = v_code
    LOOP
        v_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE);
        IF v_qty <= 0 THEN
            CONTINUE;
        END IF;
        v_price := logic_ensure_security_market_price(
            p_logic_id, v_sec.security_id, p_timeframe_id
        );
        IF v_price IS NOT NULL AND v_price > 0 THEN
            v_mtm := v_mtm + v_qty * v_price;
        END IF;
    END LOOP;

    RETURN GREATEST(0, v_mtm);
END;
$$;

COMMENT ON FUNCTION logic_selected_cash_fund_mtm(INTEGER, INTEGER) IS
'Рыночная оценка выбранного cash_fund_code в логике; 0 если фонд не выбран';

-- База для % лота:
--   free_cash            — свободный кэш
--   portfolio (default)  — весь портфель без выбранного денежного фонда
--   portfolio_incl_fund  — весь портфель включая денежный фонд
CREATE OR REPLACE FUNCTION logic_position_sizing_base(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_account_id INTEGER;
    v_account_type VARCHAR;
    v_mode TEXT;
    v_fund_code TEXT;
    v_excl_fund BOOLEAN;
    v_bal JSONB;
    v_cash NUMERIC;
    v_portfolio NUMERIC;
    v_sec RECORD;
    v_price NUMERIC;
    v_long_qty NUMERIC;
BEGIN
    SELECT l.account_id, lower(COALESCE(a.account_type, 'fake'))
    INTO v_account_id, v_account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    v_mode := lower(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'position_size_base'),
        'free_cash'
    )));
    IF v_mode NOT IN ('free_cash', 'portfolio', 'portfolio_incl_fund') THEN
        v_mode := 'free_cash';
    END IF;

    v_fund_code := upper(btrim(COALESCE(
        get_logic_param_text(p_logic_id, 'cash_fund_code'),
        ''
    )));
    IF v_fund_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        v_fund_code := '';
    END IF;
    v_excl_fund := (v_mode = 'portfolio' AND v_fund_code <> '');

    IF v_account_type <> 'fake' THEN
        BEGIN
            v_bal := fetch_tbank_account_balance(v_account_id);
            IF v_bal IS NULL OR (v_bal->>'error') IS NOT NULL THEN
                RETURN 0;
            END IF;
            IF v_mode IN ('portfolio', 'portfolio_incl_fund') THEN
                v_portfolio := GREATEST(0, COALESCE((v_bal->>'amount')::NUMERIC, 0));
                IF v_excl_fund THEN
                    v_portfolio := GREATEST(
                        0,
                        v_portfolio - logic_selected_cash_fund_mtm(p_logic_id, p_timeframe_id)
                    );
                END IF;
                RETURN v_portfolio;
            END IF;
            IF v_bal ? 'cash_amount' AND (v_bal->>'cash_amount') IS NOT NULL THEN
                RETURN GREATEST(0, COALESCE((v_bal->>'cash_amount')::NUMERIC, 0));
            END IF;
            RETURN GREATEST(0, COALESCE((v_bal->>'amount')::NUMERIC, 0));
        EXCEPTION
            WHEN OTHERS THEN
                RETURN 0;
        END;
    END IF;

    -- Test (fake): свободные = current; портфель = current + MTM бумаг
    v_cash := COALESCE(logic_ensure_balance(p_logic_id), 0);
    IF v_mode = 'free_cash' THEN
        RETURN GREATEST(0, v_cash);
    END IF;

    v_portfolio := v_cash;
    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
          AND (
              NOT v_excl_fund
              OR NOT EXISTS (
                  SELECT 1
                  FROM security_prefixes sp
                  WHERE sp.security_id = ls.security_id
                    AND upper(sp.prefix) = v_fund_code
              )
          )
    LOOP
        v_long_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE);
        IF v_long_qty <= 0 THEN
            CONTINUE;
        END IF;
        v_price := logic_ensure_security_market_price(
            p_logic_id, v_sec.security_id, p_timeframe_id
        );
        IF v_price IS NOT NULL AND v_price > 0 THEN
            v_portfolio := v_portfolio + v_long_qty * v_price;
        END IF;
    END LOOP;

    RETURN GREATEST(0, v_portfolio);
END;
$$;

COMMENT ON FUNCTION logic_position_sizing_base(INTEGER, INTEGER) IS
'База % лота: free_cash (default)|portfolio (без фонда)|portfolio_incl_fund (с фондом)';

-- Чистая стоимость счёта для потолка риска (плечо 1):
-- real → portfolio amount брокера; fake → cash − short_notional + long_mtm.
-- Нужно потому, что free_cash / cash_amount растёт от short-выручки и иначе
-- потолок %×макс.позиций раздувается выше equity.
CREATE OR REPLACE FUNCTION logic_account_net_equity(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_account_id INTEGER;
    v_account_type VARCHAR;
    v_bal JSONB;
    v_cash NUMERIC;
    v_equity NUMERIC;
    v_short_notional NUMERIC;
    v_long_mtm NUMERIC := 0;
    v_sec RECORD;
    v_price NUMERIC;
    v_long_qty NUMERIC;
BEGIN
    SELECT l.account_id, lower(COALESCE(a.account_type, 'fake'))
    INTO v_account_id, v_account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    IF v_account_type <> 'fake' THEN
        BEGIN
            v_bal := fetch_tbank_account_balance(v_account_id);
            IF v_bal IS NULL OR (v_bal->>'error') IS NOT NULL THEN
                RETURN 0;
            END IF;
            -- amount = собственный капитал (без «раздутого» cash от шорта/займа).
            RETURN GREATEST(0, COALESCE((v_bal->>'amount')::NUMERIC, 0));
        EXCEPTION
            WHEN OTHERS THEN
                RETURN 0;
        END;
    END IF;

    -- Fake: current_balance includes short proceeds — subtract short entry notional.
    v_cash := COALESCE(logic_ensure_balance(p_logic_id), 0);
    SELECT GREATEST(0, COALESCE(SUM(rem.qty * lt.price), 0))
    INTO v_short_notional
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    JOIN actions a ON a.id = lt.action_id
    CROSS JOIN LATERAL (
        SELECT GREATEST(
            lt.quantity - COALESCE((
                SELECT SUM(l.quantity)
                FROM logic_trade_lots l
                WHERE l.open_trade_id = lt.id
            ), 0),
            0
        ) AS qty
    ) rem
    WHERE lt.logic_id = p_logic_id
      AND NOT lt.is_shadow
      AND lt.is_test = FALSE
      AND COALESCE(lt.opt_lane, '') = ''
      AND lt.status IN ('filled', 'submitted')
      AND s.name = 'Open'
      AND a.name = 'Short'
      AND rem.qty > 0;

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        v_long_qty := logic_long_position_qty(p_logic_id, v_sec.security_id, FALSE);
        IF v_long_qty <= 0 THEN
            CONTINUE;
        END IF;
        v_price := logic_ensure_security_market_price(
            p_logic_id, v_sec.security_id, p_timeframe_id
        );
        IF v_price IS NOT NULL AND v_price > 0 THEN
            v_long_mtm := v_long_mtm + v_long_qty * v_price;
        END IF;
    END LOOP;

    v_equity := v_cash - COALESCE(v_short_notional, 0) + COALESCE(v_long_mtm, 0);
    RETURN GREATEST(0, v_equity);
END;
$$;

COMMENT ON FUNCTION logic_account_net_equity(INTEGER, INTEGER) IS
'Equity для потолка Open (плечо 1): real=amount брокера; fake=cash−short+long_mtm. Режет раздутый free_cash после шортов.';

-- База цикла / потолка: min(база лота, equity), чтобы short-выручка / заём не поднимали плечо.
CREATE OR REPLACE FUNCTION logic_exposure_cycle_budget(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_sizing NUMERIC;
    v_equity NUMERIC;
BEGIN
    v_sizing := GREATEST(0, COALESCE(logic_position_sizing_base(p_logic_id, p_timeframe_id), 0));
    v_equity := GREATEST(0, COALESCE(logic_account_net_equity(p_logic_id, p_timeframe_id), 0));
    IF v_equity > 0 AND v_sizing > 0 THEN
        RETURN LEAST(v_sizing, v_equity);
    END IF;
    RETURN v_sizing;
END;
$$;

COMMENT ON FUNCTION logic_exposure_cycle_budget(INTEGER, INTEGER) IS
'База цикла для % лота и потолка %×макс.позиций: LEAST(sizing_base, equity) — плечо ≤ 1 от equity.';

-- Номинал уже открытых long+short (чемпион / бой или test; opt_lane отделяет paper OPT).
-- Drop 3-arg overload so callers use the 4-arg form (p_run_id DEFAULT NULL).
DROP FUNCTION IF EXISTS logic_open_notional_exposure(INTEGER, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION logic_open_notional_exposure(
    p_logic_id INTEGER,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_opt_lane TEXT DEFAULT '',
    p_run_id BIGINT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT GREATEST(0, COALESCE(SUM(rem.qty * lt.price), 0))
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    JOIN actions a ON a.id = lt.action_id
    CROSS JOIN LATERAL (
        SELECT GREATEST(
            lt.quantity - COALESCE((
                SELECT SUM(l.quantity)
                FROM logic_trade_lots l
                WHERE l.open_trade_id = lt.id
            ), 0),
            0
        ) AS qty
    ) rem
    WHERE lt.logic_id = p_logic_id
      AND NOT lt.is_shadow
      AND lt.is_test = p_is_test
      AND COALESCE(lt.opt_lane, '') = COALESCE(p_opt_lane, '')
      AND (p_run_id IS NULL OR lt.run_id = p_run_id)
      AND lt.status IN ('filled', 'submitted')
      AND s.name = 'Open'
      AND a.name IN ('Long', 'Short')
      AND rem.qty > 0;
$$;

COMMENT ON FUNCTION logic_open_notional_exposure(INTEGER, BOOLEAN, TEXT, BIGINT) IS
'Суммарный номинал открытых long+short (цена входа). Потолок: база × (%/100) × max_open_positions — одинаково для long и short. p_run_id — только для is_test.';

CREATE OR REPLACE FUNCTION logic_upsert_param(
    p_logic_id INTEGER,
    p_param_key TEXT,
    p_value TEXT,
    p_value_type TEXT DEFAULT 'text'
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
    VALUES (p_logic_id, p_param_key, COALESCE(p_value, ''), p_value_type)
    ON CONFLICT (logic_id, param_key) DO UPDATE SET
        param_value = EXCLUDED.param_value,
        value_type = EXCLUDED.value_type,
        updated_at = CURRENT_TIMESTAMP;
END;
$$;

-- Paper-дефолт 1_000_000 / пусто — для real никогда не оставлять как «остаток».
CREATE OR REPLACE FUNCTION logic_is_paper_balance_text(p_raw TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_raw IS NULL OR btrim(p_raw) = '' THEN TRUE
        WHEN replace(replace(btrim(p_raw), ' ', ''), ',', '.')
            IN ('1000000', '1000000.0', '1000000.00', '1000000.000', '1000000.000000')
        THEN TRUE
        ELSE FALSE
    END;
$$;

CREATE OR REPLACE FUNCTION logic_apply_real_account_balances(
    p_logic_id INTEGER,
    p_force_initial BOOLEAN DEFAULT TRUE
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_account_id INTEGER;
    v_account_type VARCHAR;
    v_bal JSONB;
    v_amount NUMERIC := 0;
    v_ok BOOLEAN := FALSE;
BEGIN
    SELECT l.account_id, lower(COALESCE(a.account_type, 'fake'))
    INTO v_account_id, v_account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    IF NOT FOUND OR v_account_type = 'fake' THEN
        RETURN NULL;
    END IF;

    BEGIN
        v_bal := fetch_tbank_account_balance(v_account_id);
        IF v_bal IS NOT NULL AND (v_bal->>'error') IS NULL THEN
            IF v_bal ? 'cash_amount' AND (v_bal->>'cash_amount') IS NOT NULL THEN
                v_amount := COALESCE((v_bal->>'cash_amount')::NUMERIC, 0);
            ELSE
                v_amount := COALESCE((v_bal->>'amount')::NUMERIC, 0);
            END IF;
            IF v_amount < 0 THEN
                v_amount := 0;
            END IF;
            v_ok := TRUE;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            v_ok := FALSE;
            v_amount := 0;
    END;

    IF NOT v_ok THEN
        v_amount := 0;
    END IF;

    -- Real: и начальный, и текущий — только с брокера (или 0). Не из параметров теста.
    -- p_force_initial: совместимость сигнатуры; для real оба поля всегда с брокера.
    PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_amount::TEXT, 'money');
    PERFORM logic_upsert_param(p_logic_id, 'initial_balance', v_amount::TEXT, 'money');

    RETURN v_amount;
END;
$$;

COMMENT ON FUNCTION logic_apply_real_account_balances(INTEGER, BOOLEAN) IS
'Real: initial+current = T-Bank cash или 0. Fake: no-op (остатки из параметров).';

CREATE OR REPLACE FUNCTION logic_sync_all_real_account_balances()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    r RECORD;
    v_n INTEGER := 0;
BEGIN
    FOR r IN
        SELECT l.id
        FROM logics l
        JOIN accounts a ON a.id = l.account_id
        WHERE lower(COALESCE(a.account_type, 'fake')) <> 'fake'
    LOOP
        PERFORM logic_apply_real_account_balances(r.id, TRUE);
        v_n := v_n + 1;
    END LOOP;
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION logic_sync_all_real_account_balances() IS
'Upgrade/install: для всех real-логик выставить остатки с брокера (или 0).';

CREATE OR REPLACE FUNCTION logic_ensure_balance(p_logic_id INTEGER)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_account_type VARCHAR;
    v_current NUMERIC;
    v_initial NUMERIC;
BEGIN
    SELECT lower(COALESCE(a.account_type, 'fake'))
    INTO v_account_type
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id;

    -- Реальный счёт: начальный и текущий — с брокера (или 0), не из параметров теста.
    IF FOUND AND v_account_type <> 'fake' THEN
        RETURN COALESCE(logic_apply_real_account_balances(p_logic_id, TRUE), 0);
    END IF;

    v_current := get_logic_param_numeric(p_logic_id, 'current_balance', NULL);
    IF v_current IS NOT NULL THEN
        RETURN v_current;
    END IF;
    v_initial := get_logic_param_numeric(p_logic_id, 'initial_balance', NULL);
    IF v_initial IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_initial::TEXT, 'money');
    RETURN v_initial;
END;
$$;

COMMENT ON FUNCTION logic_ensure_balance(INTEGER) IS
'Fake: параметры initial/current. Real: оба с T-Bank (или 0).';

CREATE OR REPLACE FUNCTION logic_trade_load_date_from(
    p_tf_sec INTEGER,
    p_point_count INTEGER,
    p_closed_bar_dt TIMESTAMP
)
RETURNS DATE
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_date_to DATE;
    v_need_days INTEGER;
    v_max_days INTEGER;
    v_span INTEGER;
BEGIN
    v_date_to := GREATEST(p_closed_bar_dt::date, CURRENT_DATE);
    v_need_days := GREATEST(1, CEIL(GREATEST(COALESCE(p_point_count, 100), 30) * COALESCE(NULLIF(p_tf_sec, 0), 900) / 86400.0)::INTEGER);

    v_max_days := CASE
        WHEN COALESCE(p_tf_sec, 0) <= 120 THEN 0
        WHEN p_tf_sec <= 600 THEN 3
        WHEN p_tf_sec <= 1800 THEN 7
        WHEN p_tf_sec <= 3600 THEN 14
        ELSE 30
    END;

    IF v_max_days = 0 THEN
        RETURN v_date_to;
    END IF;

    v_span := LEAST(GREATEST(v_need_days, 1), v_max_days);
    RETURN v_date_to - v_span;
END;
$$;

COMMENT ON FUNCTION logic_trade_load_date_from(INTEGER, INTEGER, TIMESTAMP) IS
'date_from для load_prices с учётом лимитов T-Bank по TF (M1/M2 — только текущий день)';

CREATE OR REPLACE FUNCTION logic_trade_sync_point_count(p_tf_sec INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE AS $$
    SELECT CASE
        WHEN COALESCE(p_tf_sec, 0) <= 60 THEN 400
        WHEN p_tf_sec <= 120 THEN 300
        WHEN p_tf_sec <= 300 THEN 200
        ELSE 150
    END;
$$;

COMMENT ON FUNCTION logic_trade_sync_point_count(INTEGER) IS
'Число свечей для sync индикаторов в runner: больше на M1/M2/M5';

-- Есть ли уже закрытая свеча в prices (без повторного HTTP).
CREATE OR REPLACE FUNCTION prices_have_closed_bar(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_closed_bar_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt = p_closed_bar_dt
    );
$$;

COMMENT ON FUNCTION prices_have_closed_bar(INTEGER, INTEGER, TIMESTAMP) IS
'True если в prices уже есть свеча ровно на closed bar — load_prices можно пропустить';

-- Если история уже есть — догружаем только день закрытого бара (1 HTTP), не весь lookback.
CREATE OR REPLACE FUNCTION prices_topup_date_from(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_closed_bar_dt TIMESTAMP,
    p_fallback_from DATE
)
RETURNS DATE
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM prices p
        WHERE p.security_id = p_security_id
          AND p.timeframe_id = p_timeframe_id
          AND p.dt >= (p_closed_bar_dt - INTERVAL '5 days')
        LIMIT 1
    ) THEN
        RETURN p_closed_bar_dt::date;
    END IF;
    RETURN p_fallback_from;
END;
$$;

COMMENT ON FUNCTION prices_topup_date_from(INTEGER, INTEGER, TIMESTAMP, DATE) IS
'date_from для load_prices: день closed bar, если в БД уже есть недавние свечи';

CREATE OR REPLACE FUNCTION indicator_has_closed_bar(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_indicator_id INTEGER,
    p_closed_bar_dt TIMESTAMP
)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM indicator_values iv
        WHERE iv.security_id = p_security_id
          AND iv.timeframe_id = p_timeframe_id
          AND iv.indicator_id = p_indicator_id
          AND iv.dt = p_closed_bar_dt
        LIMIT 1
    );
$$;

COMMENT ON FUNCTION indicator_has_closed_bar(INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'True если индикатор уже посчитан на closed bar';

-- Early exit: все бумаги уже имеют closed-свечу — не трогаем HTTP/sync.
CREATE OR REPLACE PROCEDURE logic_refresh_market_data(
    p_logic_id INTEGER,
    p_timeframe_id INTEGER,
    p_closed_bar_dt TIMESTAMP
)
LANGUAGE plpgsql AS $$
DECLARE
    v_sec RECORD;
    v_sig RECORD;
    v_date_from DATE;
    v_date_to DATE;
    v_point_count INTEGER;
    v_tf_sec INTEGER;
    v_err TEXT;
    v_skip_http BOOLEAN := FALSE;
    v_missing_prices INTEGER;
BEGIN
    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_timeframe_id;

    v_point_count := logic_trade_sync_point_count(v_tf_sec);
    v_date_to := GREATEST(p_closed_bar_dt::date, CURRENT_DATE);
    v_date_from := logic_trade_load_date_from(v_tf_sec, v_point_count, p_closed_bar_dt);

    SELECT EXISTS (
        SELECT 1
        FROM logic_backtest_runs r
        WHERE r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
    ) INTO v_skip_http;

    SELECT COUNT(*)::INTEGER INTO v_missing_prices
    FROM logic_securities ls
    WHERE ls.logic_id = p_logic_id
      AND ls.is_active = TRUE
      AND NOT prices_have_closed_bar(ls.security_id, p_timeframe_id, p_closed_bar_dt);

    -- Быстрый путь: цены на closed bar есть у всех — только недостающие индикаторы, без HTTP.
    IF v_missing_prices = 0 THEN
        FOR v_sec IN
            SELECT ls.security_id
            FROM logic_securities ls
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
        LOOP
            -- Параметры из формул — один раз на бумагу (не на каждый indicator_id)
            BEGIN
                CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sec.security_id);
            EXCEPTION
                WHEN OTHERS THEN
                    NULL;
            END;
            -- Contango: материализовать спред, если есть такие сигналы
            IF EXISTS (
                SELECT 1 FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id AND lis.is_active
                  AND COALESCE(lis.signal_acts_on, 'security') = 'contango'
            ) THEN
                PERFORM sync_contango_prices(
                    v_sec.security_id,
                    p_timeframe_id,
                    prices_topup_date_from(
                        v_sec.security_id, p_timeframe_id, p_closed_bar_dt, v_date_from
                    ),
                    v_date_to
                );
            END IF;
            FOR v_sig IN
                SELECT DISTINCT
                    lis.indicator_id,
                    logic_signal_resolve_eval_security(
                        lis.signal_acts_on, v_sec.security_id
                    ) AS eval_sec_id
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            LOOP
                IF v_sig.eval_sec_id IS NULL THEN
                    CONTINUE;
                END IF;
                IF indicator_has_closed_bar(
                    v_sig.eval_sec_id, p_timeframe_id, v_sig.indicator_id, p_closed_bar_dt
                ) THEN
                    CONTINUE;
                END IF;
                BEGIN
                    CALL ensure_security_indicator_series(v_sig.eval_sec_id, v_sig.indicator_id);
                    CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sig.eval_sec_id);
                    CALL sync_security_indicator_series_for_indicator(
                        v_sig.eval_sec_id,
                        v_sig.indicator_id,
                        p_timeframe_id,
                        p_closed_bar_dt,
                        v_point_count,
                        TRUE
                    );
                EXCEPTION
                    WHEN OTHERS THEN
                        v_err := SQLERRM;
                        PERFORM logic_trade_log(
                            p_logic_id,
                            'trade.indicator.error',
                            format('Ошибка расчёта индикатора id=%s sec=%s: %s', v_sig.indicator_id, v_sig.eval_sec_id, v_err),
                            jsonb_build_object(
                                'security_id', v_sig.eval_sec_id,
                                'trade_security_id', v_sec.security_id,
                                'indicator_id', v_sig.indicator_id,
                                'error', v_err
                            ),
                            v_sec.security_id,
                            p_timeframe_id
                        );
                END;
            END LOOP;
        END LOOP;
        RETURN;
    END IF;

    IF v_skip_http THEN
        PERFORM logic_trade_log(
            p_logic_id,
            'trade.prices.skip_http',
            'Пропуск load_prices: активен бэктест (используем уже загруженные цены)',
            jsonb_build_object('closed_bar', p_closed_bar_dt),
            NULL,
            p_timeframe_id
        );
    END IF;

    FOR v_sec IN
        SELECT ls.security_id
        FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    LOOP
        -- Повторный HTTP на уже имеющуюся closed-свечу блокирует API / раскрытие бумаги
        IF NOT v_skip_http
           AND NOT prices_have_closed_bar(v_sec.security_id, p_timeframe_id, p_closed_bar_dt) THEN
            BEGIN
                CALL load_prices(
                    v_sec.security_id,
                    p_timeframe_id,
                    prices_topup_date_from(
                        v_sec.security_id, p_timeframe_id, p_closed_bar_dt, v_date_from
                    ),
                    v_date_to
                );
            EXCEPTION
                WHEN undefined_function THEN
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.prices.error',
                        'load_prices недоступен (нет HTTP-расширения)',
                        jsonb_build_object('security_id', v_sec.security_id),
                        v_sec.security_id,
                        p_timeframe_id
                    );
                WHEN OTHERS THEN
                    v_err := SQLERRM;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.prices.error',
                        format('Ошибка загрузки цен sec=%s: %s', v_sec.security_id, v_err),
                        jsonb_build_object('security_id', v_sec.security_id, 'error', v_err),
                        v_sec.security_id,
                        p_timeframe_id
                    );
            END;
        END IF;

        -- Цены базовых активов для base_asset / contango
        IF NOT v_skip_http THEN
            FOR v_sig IN
                SELECT DISTINCT logic_future_underlying_security_id(v_sec.security_id) AS und_id
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id
                  AND lis.is_active = TRUE
                  AND COALESCE(lis.signal_acts_on, 'security') IN ('base_asset', 'contango')
            LOOP
                IF v_sig.und_id IS NULL OR v_sig.und_id = v_sec.security_id THEN
                    CONTINUE;
                END IF;
                IF prices_have_closed_bar(v_sig.und_id, p_timeframe_id, p_closed_bar_dt) THEN
                    CONTINUE;
                END IF;
                BEGIN
                    CALL load_prices(
                        v_sig.und_id,
                        p_timeframe_id,
                        prices_topup_date_from(
                            v_sig.und_id, p_timeframe_id, p_closed_bar_dt, v_date_from
                        ),
                        v_date_to
                    );
                EXCEPTION
                    WHEN OTHERS THEN
                        NULL;
                END;
            END LOOP;
        END IF;

        IF EXISTS (
            SELECT 1 FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active
              AND COALESCE(lis.signal_acts_on, 'security') = 'contango'
        ) THEN
            PERFORM sync_contango_prices(
                v_sec.security_id, p_timeframe_id, v_date_from, v_date_to
            );
        END IF;

        BEGIN
            CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sec.security_id);
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;

        FOR v_sig IN
            SELECT DISTINCT
                lis.indicator_id,
                logic_signal_resolve_eval_security(
                    lis.signal_acts_on, v_sec.security_id
                ) AS eval_sec_id
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
        LOOP
            IF v_sig.eval_sec_id IS NULL THEN
                CONTINUE;
            END IF;
            IF indicator_has_closed_bar(
                v_sig.eval_sec_id, p_timeframe_id, v_sig.indicator_id, p_closed_bar_dt
            ) THEN
                CONTINUE;
            END IF;
            BEGIN
                CALL ensure_security_indicator_series(v_sig.eval_sec_id, v_sig.indicator_id);
                CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sig.eval_sec_id);
                CALL sync_security_indicator_series_for_indicator(
                    v_sig.eval_sec_id,
                    v_sig.indicator_id,
                    p_timeframe_id,
                    p_closed_bar_dt,
                    v_point_count,
                    TRUE
                );
            EXCEPTION
                WHEN OTHERS THEN
                    v_err := SQLERRM;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.indicator.error',
                        format('Ошибка расчёта индикатора id=%s sec=%s: %s', v_sig.indicator_id, v_sig.eval_sec_id, v_err),
                        jsonb_build_object(
                            'security_id', v_sig.eval_sec_id,
                            'trade_security_id', v_sec.security_id,
                            'indicator_id', v_sig.indicator_id,
                            'error', v_err
                        ),
                        v_sec.security_id,
                        p_timeframe_id
                    );
            END;
        END LOOP;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE logic_refresh_market_data(INTEGER, INTEGER, TIMESTAMP) IS
'Перед проверкой сигналов: load_prices (кроме активного бэктеста) + ensure/sync индикаторов логики на TF';

CREATE OR REPLACE FUNCTION process_logic_trades(p_logic_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_tf_id INTEGER;
    v_tf_sec INTEGER;
    v_position_size_pct NUMERIC;
    v_max_positions INTEGER;
    v_max_order_amount NUMERIC;
    v_sizing_base NUMERIC;
    v_balance NUMERIC;
    v_open_positions INTEGER;
    v_created INTEGER := 0;
    v_side_open_id INTEGER;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_grp RECORD;
    v_sig RECORD;
    v_sec RECORD;
    v_eval RECORD;
    v_pp NUMERIC;
    v_held_long NUMERIC;
    v_held_short NUMERIC;
    v_is_open_event BOOLEAN;
    v_quantity INTEGER;
    v_side_id INTEGER;
    v_action_id INTEGER;
    v_direction TEXT;
    v_is_simulated BOOLEAN;
    v_is_shadow BOOLEAN;
    v_broker_order_id TEXT;
    v_status TEXT;
    v_note TEXT;
    v_trade_id BIGINT;
    v_figi TEXT;
    v_order JSONB;
    v_commission NUMERIC;
    v_notional NUMERIC;
    v_is_open BOOLEAN;
    v_closed_bar_dt TIMESTAMP;
    v_last_bar_raw TEXT;
    v_last_bar_dt TIMESTAMP;
    v_all_ok BOOLEAN;
    v_formulas TEXT;
    v_signal_kind TEXT;
    v_ind_dt TIMESTAMP;
    v_lot_size INTEGER;
    v_is_futures BOOLEAN;
    v_inversion BOOLEAN;
    v_eff_inversion BOOLEAN;
    v_eff_side TEXT;
    v_cycle_budget NUMERIC;       -- база % на весь цикл (не растёт от short-кэша)
    v_max_exposure NUMERIC;       -- база × (%/100) × max_open_positions
    v_spent_notional NUMERIC := 0; -- уже занятый номинал Open (старые + этот прогон)
    v_room NUMERIC;
    v_order_notional NUMERIC;
BEGIN
    SELECT l.id, l.account_id, a.account_type,
           COALESCE(l.portfolio_trading_paused, FALSE) AS portfolio_trading_paused
    INTO v_logic
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.id = p_logic_id
      AND l.is_enabled = TRUE
      AND a.is_active = TRUE;

    IF NOT FOUND THEN
        PERFORM logic_trade_log(p_logic_id, 'logic.skip', 'Логика выключена или счёт неактивен');
        RETURN 0;
    END IF;

    v_tf_id := logic_resolve_timeframe_id(p_logic_id);
    IF v_tf_id IS NULL THEN
        PERFORM logic_trade_log(p_logic_id, 'logic.skip', 'Не задан timeframe в logic_params');
        RETURN 0;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = v_tf_id;

    v_closed_bar_dt := logic_last_closed_bar_dt(v_tf_sec);
    IF v_closed_bar_dt IS NULL THEN
        PERFORM logic_trade_log(p_logic_id, 'logic.skip', 'Не удалось вычислить закрытую свечу TF', NULL, NULL, v_tf_id);
        RETURN 0;
    END IF;

    v_last_bar_raw := btrim(COALESCE(get_logic_param_text(p_logic_id, 'last_trade_bar_dt'), ''));
    IF v_last_bar_raw <> '' THEN
        BEGIN
            v_last_bar_dt := v_last_bar_raw::TIMESTAMP;
            IF v_closed_bar_dt <= v_last_bar_dt THEN
                PERFORM logic_trade_log(
                    p_logic_id,
                    'trade.bar_skip',
                    format('Свеча %s уже обработана (last=%s)', v_closed_bar_dt, v_last_bar_dt),
                    jsonb_build_object('closed_bar', v_closed_bar_dt, 'last_bar', v_last_bar_dt),
                    NULL,
                    v_tf_id
                );
                -- Pulse every cycle while waiting for next TF bar (M15 etc.),
                -- so per-logic health is not tied to bar frequency.
                PERFORM logic_upsert_param(
                    p_logic_id,
                    'last_trade_check_at',
                    to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS'),
                    'text'
                );
                RETURN 0;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
    END IF;

    SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;

    IF v_side_open_id IS NULL OR v_side_close_id IS NULL
       OR v_action_long_id IS NULL OR v_action_short_id IS NULL THEN
        RETURN 0;
    END IF;

    v_position_size_pct := get_logic_param_numeric(p_logic_id, 'position_size_pct', 10);
    v_max_positions := GREATEST(1, get_logic_param_numeric(p_logic_id, 'max_open_positions', 5)::INTEGER);
    v_max_order_amount := get_logic_param_numeric(p_logic_id, 'max_order_amount', NULL);
    v_inversion := get_logic_param_boolean(p_logic_id, 'inversion', FALSE);
    v_balance := logic_ensure_balance(p_logic_id);
    v_sizing_base := logic_position_sizing_base(p_logic_id, v_tf_id);
    -- База цикла ≤ equity: free_cash/cash_amount растёт от short-выручки / займа;
    -- mid-cycle freeze alone does not stop that. LEAST(sizing, equity) = плечо ≤ 1.
    -- После Close базу обновляем (свитч: кэш +/- для следующего Open).
    v_cycle_budget := logic_exposure_cycle_budget(p_logic_id, v_tf_id);
    -- Потолок риска из тех же 2 параметров: 10 поз × 10% = 100% базы; 20×10% = 200%.
    -- Long и short считаются в одном номинале (шорт не может «набрать» сверх этого).
    v_max_exposure := v_cycle_budget
        * (GREATEST(0, COALESCE(v_position_size_pct, 0)) / 100.0)
        * v_max_positions;
    v_spent_notional := logic_open_notional_exposure(p_logic_id, FALSE, '');
    v_open_positions := logic_count_open_positions(p_logic_id);

    IF NOT EXISTS (
        SELECT 1 FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
    ) OR NOT EXISTS (
        SELECT 1 FROM logic_securities ls
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
    ) THEN
        PERFORM logic_trade_log(p_logic_id, 'logic.skip', 'Нет активных сигналов или бумаг');
        RETURN 0;
    END IF;

    CALL logic_refresh_market_data(p_logic_id, v_tf_id, v_closed_bar_dt);

    -- Рейтинг сигнала на логике: проверить прошлые срабатывания на следующей свече
    PERFORM logic_signal_rating_resolve_pending(p_logic_id, v_tf_id, v_closed_bar_dt);

    PERFORM logic_ensure_non_trading_periods(p_logic_id);

    -- EOD-сессия: close_positions_eod и/или продажа фьючерсов до экспирации
    IF logic_is_eod_session_bar(
        p_logic_id,
        v_closed_bar_dt,
        v_last_bar_dt,
        v_closed_bar_dt + make_interval(secs => v_tf_sec)
    ) THEN
        IF get_logic_param_boolean(p_logic_id, 'close_positions_eod', FALSE) THEN
            PERFORM logic_close_positions_eod_except_funds(p_logic_id);
        END IF;
        PERFORM logic_close_futures_near_expiry(p_logic_id, v_closed_bar_dt::DATE);
        v_balance := logic_ensure_balance(p_logic_id);
        v_sizing_base := logic_position_sizing_base(p_logic_id, v_tf_id);
        v_cycle_budget := logic_exposure_cycle_budget(p_logic_id, v_tf_id);
        v_max_exposure := v_cycle_budget
            * (GREATEST(0, COALESCE(v_position_size_pct, 0)) / 100.0)
            * v_max_positions;
        v_spent_notional := logic_open_notional_exposure(p_logic_id, FALSE, '');
        v_open_positions := logic_count_open_positions(p_logic_id);
    END IF;

    IF logic_is_non_trading_dt(p_logic_id, v_closed_bar_dt) THEN
        PERFORM logic_trade_log(
            p_logic_id,
            'trade.non_trading_skip',
            format('Неторговый период: свеча %s — сигналы пропущены', v_closed_bar_dt),
            jsonb_build_object('closed_bar', v_closed_bar_dt),
            NULL,
            v_tf_id
        );
        PERFORM logic_upsert_param(
            p_logic_id,
            'last_trade_check_at',
            to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS'),
            'text'
        );
        PERFORM logic_upsert_param(
            p_logic_id,
            'last_trade_bar_dt',
            to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'),
            'text'
        );
        RETURN 0;
    END IF;

    PERFORM logic_trade_log(
        p_logic_id,
        'trade.bar_check',
        format('Проверка AND-сигналов на закрытой свече %s', v_closed_bar_dt),
        jsonb_build_object('closed_bar', v_closed_bar_dt, 'timeframe_id', v_tf_id),
        NULL,
        v_tf_id
    );

    -- При нехватке слотов — лучший PnL; один GROUP BY, без коррелированного SUM на бумагу.
    FOR v_sec IN
        SELECT
            ls.security_id,
            COALESCE(ls.real_trading_paused, FALSE) AS real_trading_paused,
            COALESCE(ls.real_trading_paused_long, FALSE) AS real_trading_paused_long,
            COALESCE(ls.real_trading_paused_short, FALSE) AS real_trading_paused_short,
            COALESCE(ls.real_trading_inverted, FALSE) AS real_trading_inverted
        FROM logic_securities ls
        LEFT JOIN (
            SELECT lt.security_id,
                   COALESCE(SUM(lt.financial_result), 0) AS pnl
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            WHERE lt.logic_id = p_logic_id
              AND lt.is_test = FALSE
              AND NOT lt.is_shadow
              AND COALESCE(lt.opt_lane, '') = ''
              AND s.name = 'Close'
              AND lt.status IN ('filled', 'submitted')
            GROUP BY lt.security_id
        ) pnl ON pnl.security_id = ls.security_id
        WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
          -- Денежный фонд только для парковки кэша, не для сигналов
          AND NOT logic_is_cash_fund_security(ls.security_id)
        ORDER BY COALESCE(pnl.pnl, 0) DESC,
                 ls.display_order NULLS LAST,
                 ls.id
    LOOP
        v_lot_size := logic_security_lot_size(v_sec.security_id);
        v_is_futures := logic_security_is_futures(v_sec.security_id);

        FOR v_grp IN
            SELECT lis.position_event, lis.position_side
            FROM logic_indicator_signals lis
            WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
            GROUP BY lis.position_event, lis.position_side
            ORDER BY lis.position_event, lis.position_side
        LOOP
            -- Shadow только для просевшей стороны; другая сторона бумаги остаётся боевой.
            v_is_shadow := COALESCE(v_logic.portfolio_trading_paused, FALSE)
                OR CASE lower(btrim(COALESCE(v_grp.position_side, '')))
                    WHEN 'long' THEN v_sec.real_trading_paused_long
                        OR (v_sec.real_trading_paused
                            AND NOT v_sec.real_trading_paused_long
                            AND NOT v_sec.real_trading_paused_short)
                    WHEN 'short' THEN v_sec.real_trading_paused_short
                        OR (v_sec.real_trading_paused
                            AND NOT v_sec.real_trading_paused_long
                            AND NOT v_sec.real_trading_paused_short)
                    ELSE v_sec.real_trading_paused
                END;
            -- Shadow → zero uses base logic only; paper inverted applies to real book.
            v_eff_inversion := (
                v_inversion <> CASE
                    WHEN v_is_shadow THEN FALSE
                    ELSE COALESCE(v_sec.real_trading_inverted, FALSE)
                END
            );
            v_all_ok := TRUE;
            v_formulas := NULL;
            v_signal_kind := NULL;
            v_pp := NULL;
            v_ind_dt := NULL;

            FOR v_sig IN
                SELECT lis.id, lis.position_event, lis.position_side, lis.signal_kind, lis.formula, lis.indicator_id
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id
                  AND lis.is_active = TRUE
                  AND lis.position_event = v_grp.position_event
                  AND lis.position_side = v_grp.position_side
                ORDER BY lis.display_order, lis.id
            LOOP
                SELECT * INTO v_eval
                FROM logic_signal_evaluate_at(
                    -- Inversion flips sides only (see backtest runner); keep conditions.
                    v_sig.id, v_sec.security_id, v_tf_id, v_closed_bar_dt, FALSE
                );

                IF v_eval.close_price IS NULL THEN
                    v_all_ok := FALSE;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.not_ready',
                        format(
                            'Нет данных на свече %s для security=%s signal=%s',
                            v_closed_bar_dt, v_sec.security_id, v_sig.formula
                        ),
                        jsonb_build_object(
                            'closed_bar', v_closed_bar_dt,
                            'security_id', v_sec.security_id,
                            'formula', v_sig.formula,
                            'position_event', v_grp.position_event,
                            'position_side', v_grp.position_side
                        ),
                        v_sec.security_id,
                        v_tf_id
                    );
                    CONTINUE;
                END IF;

                IF v_signal_kind IS NULL THEN
                    v_signal_kind := v_sig.signal_kind;
                    v_pp := v_eval.close_price;
                    v_ind_dt := v_eval.bar_dt;
                END IF;
                v_formulas := CASE
                    WHEN v_formulas IS NULL THEN v_sig.formula
                    ELSE v_formulas || ' AND ' || v_sig.formula
                END;

                IF COALESCE(v_eval.ok, FALSE) THEN
                    PERFORM logic_signal_record_fire(
                        v_sig.id, p_logic_id, v_sec.security_id, v_tf_id,
                        v_eval.bar_dt, v_eval.close_price,
                        v_sig.position_side, v_sig.signal_kind
                    );
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.signal_hit',
                        format(
                            'Сигнал %s/%s/%s: %s',
                            v_sig.position_event, v_sig.position_side, v_sig.signal_kind, v_sig.formula
                        ),
                        jsonb_build_object(
                            'formula', v_sig.formula,
                            'position_event', v_sig.position_event,
                            'pp', v_eval.close_price,
                            'ind_value', v_eval.ind_value,
                            'bar_dt', v_eval.bar_dt
                        ),
                        v_sec.security_id,
                        v_tf_id
                    );
                ELSE
                    v_all_ok := FALSE;
                    PERFORM logic_trade_log(
                        p_logic_id,
                        'trade.signal_skip',
                        format(
                            'Условие не выполнено: %s (pp=%s, value=%s)',
                            v_sig.formula, v_eval.close_price, v_eval.ind_value
                        ),
                        jsonb_build_object(
                            'formula', v_sig.formula,
                            'position_event', v_sig.position_event,
                            'signal_kind', v_sig.signal_kind,
                            'position_side', v_sig.position_side,
                            'pp', v_eval.close_price,
                            'ind_value', v_eval.ind_value,
                            'bar_dt', v_eval.bar_dt
                        ),
                        v_sec.security_id,
                        v_tf_id
                    );
                END IF;
            END LOOP;

            IF NOT v_all_ok OR v_pp IS NULL OR v_formulas IS NULL THEN
                CONTINUE;
            END IF;

            v_eff_side := lower(COALESCE(v_grp.position_side, 'long'));
            IF v_eff_inversion THEN
                v_eff_side := CASE WHEN v_eff_side = 'long' THEN 'short' ELSE 'long' END;
            END IF;

            v_held_long := CASE
                WHEN v_eff_side = 'long'
                THEN logic_long_position_qty(p_logic_id, v_sec.security_id, v_is_shadow)
                ELSE 0
            END;
            v_held_short := CASE
                WHEN v_eff_side = 'short'
                THEN logic_short_position_qty(p_logic_id, v_sec.security_id, v_is_shadow)
                ELSE 0
            END;
            v_is_open_event := COALESCE(v_grp.position_event, 'open') = 'open';

            IF v_eff_side = 'long' THEN
                IF v_is_open_event THEN
                    IF v_held_long > 0 OR (NOT v_is_shadow AND v_open_positions >= v_max_positions) THEN
                        CONTINUE;
                    END IF;
                    -- Остаток под потолком %×макс.позиций (не весь баланс целиком).
                    v_room := GREATEST(0, v_max_exposure - v_spent_notional);
                    IF v_max_order_amount IS NOT NULL AND v_max_order_amount > 0 THEN
                        v_room := LEAST(v_room, v_max_order_amount);
                    END IF;
                    v_quantity := logic_calc_open_quantity(
                        v_cycle_budget, v_position_size_pct, v_pp, v_lot_size, v_room
                    );
                    IF v_quantity < v_lot_size THEN
                        -- Фьючерсы: % депозита / цена контракта часто даёт 0 → 1 лот
                        -- (только при известной базе; акции — без force 1 лот)
                        IF v_is_futures AND v_cycle_budget IS NOT NULL AND v_cycle_budget > 0
                           AND v_lot_size * v_pp <= v_room THEN
                            v_quantity := v_lot_size;
                        ELSE
                            CONTINUE;
                        END IF;
                    END IF;
                    v_order_notional := v_quantity * v_pp;
                    IF v_order_notional > v_room + 0.000001 THEN
                        CONTINUE;
                    END IF;
                    v_side_id := v_side_open_id;
                    v_action_id := v_action_long_id;
                    v_direction := 'BUY';
                ELSE
                    IF v_held_long <= 0 THEN
                        CONTINUE;
                    END IF;
                    v_quantity := v_held_long::INTEGER;
                    v_side_id := v_side_close_id;
                    v_action_id := v_action_long_id;
                    v_direction := 'SELL';
                END IF;
            ELSIF v_is_open_event THEN
                IF v_held_short > 0 OR (NOT v_is_shadow AND v_open_positions >= v_max_positions) THEN
                    CONTINUE;
                END IF;
                -- Short: тот же потолок, что и long (10×10% = 100% базы и т.д.).
                v_room := GREATEST(0, v_max_exposure - v_spent_notional);
                IF v_max_order_amount IS NOT NULL AND v_max_order_amount > 0 THEN
                    v_room := LEAST(v_room, v_max_order_amount);
                END IF;
                v_quantity := logic_calc_open_quantity(
                    v_cycle_budget, v_position_size_pct, v_pp, v_lot_size, v_room
                );
                IF v_quantity < v_lot_size THEN
                    IF v_is_futures AND v_cycle_budget IS NOT NULL AND v_cycle_budget > 0
                       AND v_lot_size * v_pp <= v_room THEN
                        v_quantity := v_lot_size;
                    ELSE
                        CONTINUE;
                    END IF;
                END IF;
                v_order_notional := v_quantity * v_pp;
                IF v_order_notional > v_room + 0.000001 THEN
                    CONTINUE;
                END IF;
                v_side_id := v_side_open_id;
                v_action_id := v_action_short_id;
                v_direction := 'SELL';
            ELSE
                IF v_held_short <= 0 THEN
                    CONTINUE;
                END IF;
                v_quantity := v_held_short::INTEGER;
                v_side_id := v_side_close_id;
                v_action_id := v_action_short_id;
                v_direction := 'BUY';
            END IF;

            v_is_simulated := v_logic.account_type = 'fake';
            v_broker_order_id := NULL;
            v_status := 'filled';
            v_note := NULL;
            v_commission := 0;

            -- Shadow (pause/resume track): paper only — never PostOrder to broker.
            IF v_logic.account_type <> 'fake' AND NOT v_is_shadow THEN
                v_is_simulated := FALSE;
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
                            v_logic.account_id, v_figi, v_quantity, v_pp, v_direction,
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
                                v_status := COALESCE(
                                    NULLIF(tbank_trade_status_from_post_order(v_order), 'rejected'),
                                    v_status
                                );
                            EXCEPTION
                                WHEN OTHERS THEN
                                    NULL;
                            END;
                        END IF;
                        IF tbank_order_unit_price(v_order) IS NOT NULL
                           AND tbank_order_unit_price(v_order) > 0 THEN
                            v_pp := tbank_order_unit_price(v_order);
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
            END IF;

            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, position_event, signal_kind, signal_formula,
                quantity, price, commission, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                opt_lane, broker_order_id, status, note
            )
            VALUES (
                p_logic_id, v_logic.account_id, v_sec.security_id, v_tf_id,
                v_side_id, v_action_id, v_grp.position_event, v_signal_kind, v_formulas,
                v_quantity, v_pp, COALESCE(v_commission, 0), v_ind_dt, v_is_simulated, FALSE, v_is_shadow, FALSE,
                '', v_broker_order_id, v_status, v_note
            )
            ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow, opt_lane) DO NOTHING
            RETURNING id INTO v_trade_id;

            IF v_trade_id IS NULL THEN
                CONTINUE;
            END IF;

            v_created := v_created + 1;

            -- Бюджет цикла: учитываем номинал боевого Open (в т.ч. short — иначе маржа нарастает)
            IF NOT v_is_shadow
               AND v_is_open_event
               AND v_status <> 'rejected'
               AND v_quantity IS NOT NULL
               AND v_pp IS NOT NULL THEN
                v_spent_notional := v_spent_notional + (v_quantity * v_pp);
            END IF;

            IF NOT v_is_shadow AND v_logic.account_type = 'fake' AND v_balance IS NOT NULL AND v_status <> 'rejected' THEN
                v_balance := logic_trade_finalize(v_trade_id, v_balance);
                v_notional := v_quantity * v_pp;
                v_is_open := v_is_open_event;
                IF v_eff_side = 'long' THEN
                    v_balance := v_balance + CASE WHEN v_is_open THEN -v_notional ELSE v_notional END;
                ELSE
                    v_balance := v_balance + CASE WHEN v_is_open THEN v_notional ELSE -v_notional END;
                END IF;
                IF v_is_open AND NOT v_is_shadow THEN
                    v_open_positions := v_open_positions + 1;
                ELSIF NOT v_is_open AND NOT v_is_shadow THEN
                    v_open_positions := GREATEST(0, v_open_positions - 1);
                END IF;
                PERFORM logic_upsert_param(p_logic_id, 'current_balance', v_balance::TEXT, 'money');
            ELSIF NOT v_is_shadow THEN
                PERFORM logic_trade_finalize(v_trade_id, v_balance);
                -- Real: перечитать остаток с брокера (не paper ± notional к миллиону)
                IF v_logic.account_type <> 'fake' THEN
                    v_balance := logic_ensure_balance(p_logic_id);
                END IF;
                IF v_is_open_event AND v_status <> 'rejected' THEN
                    v_open_positions := v_open_positions + 1;
                ELSIF NOT v_is_open_event AND v_status <> 'rejected' THEN
                    v_open_positions := GREATEST(0, v_open_positions - 1);
                END IF;
            ELSE
                PERFORM logic_trade_finalize(v_trade_id, NULL);
            END IF;

            -- Switch same bar: after Close free exposure + refresh % base (cash in/out).
            -- Never refresh after Open — short proceeds must not inflate the cycle base.
            IF NOT v_is_shadow
               AND NOT v_is_open_event
               AND v_status <> 'rejected' THEN
                v_spent_notional := logic_open_notional_exposure(p_logic_id, FALSE, '');
                v_sizing_base := logic_position_sizing_base(p_logic_id, v_tf_id);
                v_cycle_budget := logic_exposure_cycle_budget(p_logic_id, v_tf_id);
                v_max_exposure := v_cycle_budget
                    * (GREATEST(0, COALESCE(v_position_size_pct, 0)) / 100.0)
                    * v_max_positions;
            END IF;

            PERFORM logic_trade_log(
                p_logic_id,
                'trade.created',
                format('Сделка #%s qty=%s price=%s status=%s', v_trade_id, v_quantity, v_pp, v_status),
                jsonb_build_object(
                    'trade_id', v_trade_id,
                    'quantity', v_quantity,
                    'price', v_pp,
                    'status', v_status,
                    'position_event', v_grp.position_event,
                    'position_side', v_grp.position_side,
                    'effective_side', v_eff_side,
                    'global_inversion', v_inversion,
                    'security_inversion', COALESCE(v_sec.real_trading_inverted, FALSE),
                    'signal_kind', v_signal_kind,
                    'formula', v_formulas,
                    'bar_dt', v_ind_dt
                ),
                v_sec.security_id,
                v_tf_id
            );
        END LOOP;
    END LOOP;

    -- OPT challenger books (paper) + promote window
    BEGIN
        v_created := v_created + process_logic_opt_trades(p_logic_id, v_tf_id, v_closed_bar_dt);
        PERFORM logic_opt_maybe_promote(p_logic_id, v_tf_id, v_closed_bar_dt);
    EXCEPTION
        WHEN undefined_function THEN
            NULL;
        WHEN OTHERS THEN
            PERFORM logic_trade_log(
                p_logic_id,
                'opt.error',
                format('OPT runner: %s', SQLERRM),
                jsonb_build_object('sqlstate', SQLSTATE),
                NULL,
                v_tf_id
            );
    END;

    PERFORM logic_upsert_param(
        p_logic_id,
        'last_trade_check_at',
        to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'text'
    );
    PERFORM logic_upsert_param(
        p_logic_id,
        'last_trade_bar_dt',
        to_char(v_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'text'
    );

    IF v_created = 0 THEN
        PERFORM logic_trade_log(
            p_logic_id,
            'trade.bar_done',
            format('Свеча %s проверена, сделок не создано', v_closed_bar_dt),
            jsonb_build_object('closed_bar', v_closed_bar_dt),
            NULL,
            v_tf_id
        );
    END IF;

    RETURN v_created;
END;
$$;

COMMENT ON FUNCTION process_logic_trades(INTEGER) IS
'AND по группам (position_event × position_side): сделка только если все активные сигналы группы сработали; '
'рейтинг сигнала на логике обновляется через pending на следующей свече TF; '
'при OPT() — бумажные ветки opt_lane и promote каждые opt_eval_candles';

CREATE OR REPLACE FUNCTION run_trade_cycle()
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_total_created INTEGER := 0;
    v_total_stops INTEGER := 0;
    v_processed INTEGER := 0;
    v_skipped_bt INTEGER := 0;
    v_got_lock BOOLEAN;
BEGIN
    v_got_lock := pg_try_advisory_lock(hashtext('multilogictrade_run_trade_cycle'));
    IF NOT v_got_lock THEN
        PERFORM app_tech_log_event('trade-runner', 'cycle.skip', 'Пропуск: другой цикл уже выполняется', 'postgresql');
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'locked');
    END IF;

    IF trade_runner_require_ui() AND NOT trade_runner_ui_is_active() THEN
        PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));
        PERFORM app_tech_log_event(
            'trade-runner',
            'cycle.skip',
            'Пропуск: UI не активен (APP_TRADE_RUNNER_REQUIRE_UI=1)',
            'postgresql'
        );
        RETURN jsonb_build_object('skipped', TRUE, 'reason', 'ui_inactive');
    END IF;

    PERFORM app_tech_log_event('trade-runner', 'cycle.start', 'run_trade_cycle начат', 'postgresql');

    FOR v_logic IN
        SELECT l.id
        FROM logics l
        JOIN accounts a ON a.id = l.account_id
        WHERE l.is_enabled = TRUE AND a.is_active = TRUE
        ORDER BY l.id
    LOOP
        -- Не мешать бэктесту той же логики (цены/индикаторы/сделки)
        IF EXISTS (
            SELECT 1
            FROM logic_backtest_runs r
            WHERE r.logic_id = v_logic.id
              AND r.status IN ('pending', 'loading_prices', 'loading_indicators', 'running')
        ) THEN
            v_skipped_bt := v_skipped_bt + 1;
            CONTINUE;
        END IF;

        v_processed := v_processed + 1;
        v_total_stops := v_total_stops + process_logic_stops(v_logic.id);
        v_total_created := v_total_created + process_logic_trades(v_logic.id);
        PERFORM logic_park_excess_cash(v_logic.id);
    END LOOP;

    PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));

    CALL touch_trade_runner_last_ok('postgresql');

    PERFORM app_tech_log_event(
        'trade-runner',
        'cycle.end',
        format(
            'processed=%s stops=%s created=%s skip_bt=%s',
            v_processed, v_total_stops, v_total_created, v_skipped_bt
        ),
        'postgresql',
        'event',
        NULL,
        NULL,
        NULL,
        jsonb_build_object(
            'processed', v_processed,
            'stops', v_total_stops,
            'created', v_total_created,
            'skipped_backtest', v_skipped_bt
        )
    );

    RETURN jsonb_build_object(
        'processed', v_processed,
        'stops', v_total_stops,
        'created', v_total_created,
        'skipped_backtest', v_skipped_bt,
        'at', CURRENT_TIMESTAMP
    );
EXCEPTION
    WHEN OTHERS THEN
        PERFORM pg_advisory_unlock(hashtext('multilogictrade_run_trade_cycle'));
        RAISE;
END;
$$;

COMMENT ON FUNCTION run_trade_cycle() IS
'Цикл торговли по включённым logics (пропуск логик с активным бэктестом). '
'Node fallback предпочтителен: по логике отдельно (короткие tx). pg_cron — эта функция.';
