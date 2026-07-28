-- ============================================
-- OPT() on-the-fly formula optimization (live + backtest)
-- Challenger books: opt_lane <> '', paper only, no broker
-- Backtest: is_test=TRUE, run_id set; promote cursor on logic_backtest_runs
-- ============================================

-- Nested @CODE(...OPT(...)) parsers (also in logic_trade_runner.sql; kept here so 02 sync applies them)
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

CREATE OR REPLACE FUNCTION logic_opt_canonical_key(p_key TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE lower(btrim(COALESCE(p_key, '')))
        WHEN 'std' THEN 'std_dev'
        WHEN 'fast' THEN 'fast_period'
        WHEN 'slow' THEN 'slow_period'
        WHEN 'signal' THEN 'signal_period'
        WHEN 'k' THEN 'k_period'
        WHEN 'd' THEN 'd_period'
        ELSE lower(btrim(COALESCE(p_key, '')))
    END;
$$;

CREATE OR REPLACE FUNCTION logic_opt_arm_value(p_base NUMERIC, p_pct NUMERIC, p_dir TEXT)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT round(
        p_base * CASE WHEN lower(p_dir) = 'up' THEN (1 + p_pct / 100.0) ELSE (1 - p_pct / 100.0) END,
        6
    );
$$;

CREATE OR REPLACE FUNCTION logic_opt_extract_specs(p_params TEXT)
RETURNS TABLE (key TEXT, base NUMERIC, pct NUMERIC)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_bases JSONB := '{}'::JSONB;
    v_part TEXT;
    v_key TEXT;
    v_val TEXT;
    v_n NUMERIC;
    v_re TEXT := '\yOPT\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*\)';
    v_m TEXT[];
    v_rest TEXT;
    v_seen TEXT[] := ARRAY[]::TEXT[];
BEGIN
    FOREACH v_part IN ARRAY signal_split_params_top_level(p_params)
    LOOP
        IF v_part ~* '^OPT\s*\(' THEN
            CONTINUE;
        END IF;
        IF position('=' IN v_part) <= 0 THEN
            CONTINUE;
        END IF;
        v_key := logic_opt_canonical_key(split_part(v_part, '=', 1));
        v_val := btrim(substr(v_part, position('=' IN v_part) + 1));
        IF v_val ~* '^OPT\s*\(' THEN
            CONTINUE;
        END IF;
        BEGIN
            v_n := replace(v_val, ',', '.')::NUMERIC;
            v_bases := jsonb_set(v_bases, ARRAY[v_key], to_jsonb(v_n), TRUE);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;

    v_rest := COALESCE(p_params, '');
    LOOP
        v_m := regexp_match(v_rest, v_re, 'i');
        EXIT WHEN v_m IS NULL;
        v_key := logic_opt_canonical_key(v_m[1]);
        v_n := replace(v_m[2], ',', '.')::NUMERIC;
        IF v_n > 0
           AND v_bases ? v_key
           AND NOT (v_key = ANY (v_seen))
        THEN
            key := v_key;
            base := (v_bases ->> v_key)::NUMERIC;
            pct := v_n;
            RETURN NEXT;
            v_seen := v_seen || v_key;
        END IF;
        v_rest := regexp_replace(v_rest, v_re, '', 'i');
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION logic_opt_logic_has_opt(p_logic_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM logic_indicator_signals lis
        WHERE lis.logic_id = p_logic_id
          AND lis.is_active = TRUE
          AND lis.formula ~* '\yOPT\s*\('
    );
$$;

CREATE OR REPLACE FUNCTION logic_opt_collect_specs(p_logic_id INTEGER)
RETURNS TABLE (key TEXT, base NUMERIC, pct NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_sig RECORD;
    v_parsed RECORD;
    v_spec RECORD;
    v_by_key JSONB := '{}'::JSONB;
BEGIN
    FOR v_sig IN
        SELECT formula FROM logic_indicator_signals
        WHERE logic_id = p_logic_id AND is_active = TRUE
    LOOP
        SELECT * INTO v_parsed FROM parse_signal_formula(v_sig.formula);
        IF NOT COALESCE(v_parsed.valid, FALSE) THEN
            CONTINUE;
        END IF;
        FOR v_spec IN SELECT * FROM logic_opt_extract_specs(v_parsed.params)
        LOOP
            IF NOT (v_by_key ? v_spec.key) THEN
                v_by_key := jsonb_set(
                    v_by_key,
                    ARRAY[v_spec.key],
                    jsonb_build_object('base', v_spec.base, 'pct', v_spec.pct),
                    TRUE
                );
            END IF;
        END LOOP;
    END LOOP;

    RETURN QUERY
    SELECT k.key, (v_by_key -> k.key ->> 'base')::NUMERIC, (v_by_key -> k.key ->> 'pct')::NUMERIC
    FROM (
        SELECT jsonb_object_keys(v_by_key) AS key
    ) k
    ORDER BY k.key;
END;
$$;

CREATE OR REPLACE FUNCTION logic_opt_build_arms(p_logic_id INTEGER)
RETURNS TABLE (lane TEXT, values_json JSONB)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_specs RECORD;
    v_keys TEXT[] := ARRAY[]::TEXT[];
    v_bases NUMERIC[] := ARRAY[]::NUMERIC[];
    v_pcts NUMERIC[] := ARRAY[]::NUMERIC[];
    v_n INTEGER;
    v_mask INTEGER;
    v_i INTEGER;
    v_dir TEXT;
    v_parts TEXT[];
    v_vals JSONB;
BEGIN
    FOR v_specs IN SELECT * FROM logic_opt_collect_specs(p_logic_id)
    LOOP
        v_keys := v_keys || v_specs.key;
        v_bases := v_bases || v_specs.base;
        v_pcts := v_pcts || v_specs.pct;
    END LOOP;

    v_n := COALESCE(array_length(v_keys, 1), 0);
    IF v_n = 0 THEN
        RETURN;
    END IF;

    FOR v_mask IN 0..(power(2, v_n)::INTEGER - 1) LOOP
        v_parts := ARRAY[]::TEXT[];
        v_vals := '{}'::JSONB;
        FOR v_i IN 1..v_n LOOP
            v_dir := CASE WHEN (v_mask & (1 << (v_i - 1))) <> 0 THEN 'up' ELSE 'down' END;
            v_parts := v_parts || (v_keys[v_i] || ':' || v_dir);
            v_vals := jsonb_set(
                v_vals,
                ARRAY[v_keys[v_i]],
                to_jsonb(logic_opt_arm_value(v_bases[v_i], v_pcts[v_i], v_dir)),
                TRUE
            );
        END LOOP;
        SELECT array_agg(p ORDER BY p) INTO v_parts FROM unnest(v_parts) AS p;
        lane := array_to_string(v_parts, '|');
        values_json := v_vals;
        RETURN NEXT;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION logic_opt_expand_params(p_params TEXT, p_values JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_part TEXT;
    v_out TEXT[] := ARRAY[]::TEXT[];
    v_key TEXT;
    v_raw_key TEXT;
    v_eq INTEGER;
BEGIN
    FOREACH v_part IN ARRAY signal_split_params_top_level(p_params)
    LOOP
        IF v_part ~* '^OPT\s*\(' THEN
            CONTINUE;
        END IF;
        v_eq := position('=' IN v_part);
        IF v_eq <= 0 THEN
            v_out := v_out || v_part;
            CONTINUE;
        END IF;
        v_raw_key := btrim(substr(v_part, 1, v_eq - 1));
        v_key := logic_opt_canonical_key(v_raw_key);
        IF p_values IS NOT NULL AND p_values ? v_key THEN
            v_out := v_out || (v_raw_key || '=' || (p_values ->> v_key));
        ELSE
            v_out := v_out || v_part;
        END IF;
    END LOOP;
    RETURN array_to_string(v_out, ',');
END;
$$;

CREATE OR REPLACE FUNCTION logic_opt_rewrite_formula_bases(p_formula TEXT, p_values JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_parsed RECORD;
    v_new_params TEXT;
    v_opts TEXT[] := ARRAY[]::TEXT[];
    v_spec RECORD;
BEGIN
    SELECT * INTO v_parsed FROM parse_signal_formula(p_formula);
    IF NOT COALESCE(v_parsed.valid, FALSE) THEN
        RETURN p_formula;
    END IF;
    FOR v_spec IN SELECT * FROM logic_opt_extract_specs(v_parsed.params)
    LOOP
        v_opts := v_opts || ('OPT(' || v_spec.key || ',' || trim(to_char(v_spec.pct, 'FM999999990.######')) || ')');
    END LOOP;
    v_new_params := logic_opt_expand_params(v_parsed.params, p_values);
    IF COALESCE(array_length(v_opts, 1), 0) > 0 THEN
        v_new_params := v_new_params || ',' || array_to_string(v_opts, ',');
    END IF;
    RETURN '@' || v_parsed.indicator_code || '(' || v_new_params || ') ' || v_parsed.condition;
END;
$$;

-- Кэш LINREG-канала на время одного process_logic_opt_trades (temp).
CREATE OR REPLACE FUNCTION logic_opt_ensure_linreg_cache()
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    CREATE TEMP TABLE IF NOT EXISTS opt_linreg_cache (
        security_id INTEGER NOT NULL,
        timeframe_id INTEGER NOT NULL,
        bar_dt TIMESTAMP NOT NULL,
        period INTEGER NOT NULL,
        std_dev_key TEXT NOT NULL,
        middle NUMERIC,
        upper NUMERIC,
        lower NUMERIC,
        PRIMARY KEY (security_id, timeframe_id, bar_dt, period, std_dev_key)
    ) ON COMMIT DROP;
END;
$$;

CREATE OR REPLACE FUNCTION logic_opt_linreg_series_at(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series TEXT,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_key TEXT;
    v_ser TEXT;
    v_mid NUMERIC;
    v_up NUMERIC;
    v_lo NUMERIC;
    v_lv RECORD;
BEGIN
    PERFORM logic_opt_ensure_linreg_cache();
    v_key := trim(to_char(round(COALESCE(p_std_dev, 2.0), 6), 'FM999999990.999999'));
    v_ser := upper(btrim(COALESCE(p_series, 'MIDDLE')));
    IF v_ser = 'VALUE' THEN
        v_ser := 'MIDDLE';
    END IF;

    SELECT c.middle, c.upper, c.lower
    INTO v_mid, v_up, v_lo
    FROM opt_linreg_cache c
    WHERE c.security_id = p_security_id
      AND c.timeframe_id = p_tf_id
      AND c.bar_dt = p_bar_dt
      AND c.period = GREATEST(COALESCE(p_period, 20), 3)
      AND c.std_dev_key = v_key;

    IF NOT FOUND THEN
        SELECT * INTO v_lv
        FROM calc_ind_linreg_levels_at(
            p_period, p_std_dev, p_security_id, p_tf_id, p_bar_dt
        );
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
        v_mid := v_lv.middle;
        v_up := v_lv.upper;
        v_lo := v_lv.lower;
        INSERT INTO opt_linreg_cache (
            security_id, timeframe_id, bar_dt, period, std_dev_key,
            middle, upper, lower
        ) VALUES (
            p_security_id, p_tf_id, p_bar_dt,
            GREATEST(COALESCE(p_period, 20), 3), v_key,
            v_mid, v_up, v_lo
        )
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN CASE v_ser
        WHEN 'UPPER' THEN v_up
        WHEN 'LOWER' THEN v_lo
        ELSE v_mid
    END;
END;
$$;

CREATE OR REPLACE FUNCTION logic_opt_calc_ind_at(
    p_indicator_id INTEGER,
    p_params TEXT,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP
)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
    v_script TEXT;
    v_series TEXT;
    v_period INTEGER;
    v_std NUMERIC;
BEGIN
    SELECT upper(i.code), i.script INTO v_code, v_script
    FROM indicators i WHERE i.id = p_indicator_id;
    IF v_code IS NULL THEN
        RETURN NULL;
    END IF;

    v_series := parse_signal_series(p_params);
    v_period := parse_signal_param_num(p_params, 'period')::INTEGER;
    v_std := COALESCE(
        parse_signal_param_num(p_params, 'std_dev'),
        parse_signal_param_num(p_params, 'std')
    );

    -- LINREG OPT: один регресс на (sec, period, std_dev) → LOWER/MIDDLE/UPPER из кэша
    IF v_code = 'LINREG' THEN
        RETURN logic_opt_linreg_series_at(
            v_period, v_std, v_series, p_security_id, p_tf_id, p_bar_dt
        );
    END IF;

    IF v_script IS NULL OR btrim(v_script) = '' THEN
        RETURN NULL;
    END IF;
    RETURN exec_indicator_script(
        v_script,
        v_period,
        COALESCE(
            parse_signal_param_num(p_params, 'fast_period'),
            parse_signal_param_num(p_params, 'fast')
        )::INTEGER,
        COALESCE(
            parse_signal_param_num(p_params, 'slow_period'),
            parse_signal_param_num(p_params, 'slow')
        )::INTEGER,
        COALESCE(
            parse_signal_param_num(p_params, 'signal_period'),
            parse_signal_param_num(p_params, 'signal')
        )::INTEGER,
        v_std,
        COALESCE(
            parse_signal_param_num(p_params, 'k_period'),
            parse_signal_param_num(p_params, 'k')
        )::INTEGER,
        COALESCE(
            parse_signal_param_num(p_params, 'd_period'),
            parse_signal_param_num(p_params, 'd')
        )::INTEGER,
        parse_signal_param_num(p_params, 'smooth')::INTEGER,
        v_series,
        p_security_id,
        p_tf_id,
        p_bar_dt,
        p_indicator_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION logic_signal_evaluate_at_opt(
    p_signal_id INTEGER,
    p_security_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_invert BOOLEAN DEFAULT FALSE,
    p_opt_values JSONB DEFAULT NULL
)
RETURNS TABLE (
    ok BOOLEAN,
    close_price NUMERIC,
    ind_value NUMERIC,
    bar_dt TIMESTAMP,
    formula TEXT,
    position_event TEXT,
    position_side TEXT,
    signal_kind TEXT,
    indicator_id INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_sig RECORD;
    v_parsed RECORD;
    v_params TEXT;
    v_condition TEXT;
    v_pp NUMERIC;
    v_ind NUMERIC;
BEGIN
    ok := FALSE;
    SELECT lis.id, lis.formula, lis.position_event, lis.position_side, lis.signal_kind, lis.indicator_id
    INTO v_sig
    FROM logic_indicator_signals lis
    WHERE lis.id = p_signal_id AND lis.is_active = TRUE;
    IF NOT FOUND THEN
        RETURN NEXT;
        RETURN;
    END IF;

    formula := v_sig.formula;
    position_event := v_sig.position_event;
    position_side := v_sig.position_side;
    signal_kind := v_sig.signal_kind;
    indicator_id := v_sig.indicator_id;

    SELECT * INTO v_parsed FROM parse_signal_formula(v_sig.formula);
    IF NOT COALESCE(v_parsed.valid, FALSE) THEN
        RETURN NEXT;
        RETURN;
    END IF;

    v_params := logic_opt_expand_params(v_parsed.params, p_opt_values);
    v_condition := v_parsed.condition;
    IF COALESCE(p_invert, FALSE) THEN
        v_condition := logic_invert_comparison_condition(v_condition);
    END IF;

    SELECT p.close_price INTO v_pp
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_tf_id
      AND p.dt = p_bar_dt
    LIMIT 1;
    IF v_pp IS NULL OR v_pp <= 0 THEN
        RETURN NEXT;
        RETURN;
    END IF;

    v_ind := logic_opt_calc_ind_at(
        v_sig.indicator_id, v_params, p_security_id, p_tf_id, p_bar_dt
    );
    IF v_ind IS NULL THEN
        RETURN NEXT;
        RETURN;
    END IF;

    close_price := v_pp;
    ind_value := v_ind;
    bar_dt := p_bar_dt;
    ok := evaluate_signal_condition(v_condition, v_pp, v_ind);
    RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS logic_trade_open_remaining_qty_at(BIGINT, TIMESTAMP);
CREATE OR REPLACE FUNCTION logic_trade_open_remaining_qty_at(
    p_open_trade_id BIGINT,
    p_at_bar TIMESTAMP
)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $fn$
    SELECT CASE
        WHEN lt.id IS NULL OR lt.bar_dt > p_at_bar THEN 0
        ELSE GREATEST(
            lt.quantity - COALESCE((
                SELECT SUM(l.quantity)
                FROM logic_trade_lots l
                JOIN logic_trades c ON c.id = l.close_trade_id
                WHERE l.open_trade_id = lt.id
                  AND c.bar_dt <= p_at_bar
            ), 0),
            0
        )
    END
    FROM logic_trades lt
    WHERE lt.id = p_open_trade_id;
$fn$;

COMMENT ON FUNCTION logic_trade_open_remaining_qty_at(BIGINT, TIMESTAMP) IS
'Open lot remaining qty as of p_at_bar (closes with bar_dt > p_at_bar ignored).';

DROP FUNCTION IF EXISTS logic_opt_lane_mtm(INTEGER, TEXT, TIMESTAMP, BOOLEAN, BIGINT, INTEGER);
CREATE OR REPLACE FUNCTION logic_opt_lane_mtm(
    p_logic_id INTEGER,
    p_opt_lane TEXT,
    p_at_bar TIMESTAMP,
    p_is_test BOOLEAN,
    p_run_id BIGINT,
    p_tf_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
    v_is_test BOOLEAN := COALESCE(p_is_test, FALSE);
    v_lane TEXT := COALESCE(p_opt_lane, '');
    v_mtm NUMERIC := 0;
    v_open RECORD;
    v_rem NUMERIC;
    v_price NUMERIC;
BEGIN
    IF p_at_bar IS NULL OR p_tf_id IS NULL THEN
        RETURN 0;
    END IF;

    FOR v_open IN
        SELECT lt.id, lt.security_id, lt.price, a.name AS action_name
        FROM logic_trades lt
        JOIN sides s ON s.id = lt.side_id
        JOIN actions a ON a.id = lt.action_id
        WHERE lt.logic_id = p_logic_id
          AND COALESCE(lt.opt_lane, '') = v_lane
          AND lt.is_test = v_is_test
          AND NOT lt.is_shadow
          AND s.name = 'Open'
          AND lt.status IN ('filled', 'submitted')
          AND lt.bar_dt <= p_at_bar
          AND (
              NOT v_is_test
              OR p_run_id IS NULL
              OR lt.run_id = p_run_id
          )
    LOOP
        v_rem := logic_trade_open_remaining_qty_at(v_open.id, p_at_bar);
        IF v_rem IS NULL OR v_rem <= 0 THEN
            CONTINUE;
        END IF;

        SELECT p.close_price INTO v_price
        FROM prices p
        WHERE p.security_id = v_open.security_id
          AND p.timeframe_id = p_tf_id
          AND p.dt = p_at_bar
        LIMIT 1;
        IF v_price IS NULL OR v_price <= 0 THEN
            CONTINUE;
        END IF;

        IF v_open.action_name = 'Long' THEN
            v_mtm := v_mtm + v_rem * (v_price - v_open.price);
        ELSE
            v_mtm := v_mtm + v_rem * (v_open.price - v_price);
        END IF;
    END LOOP;

    RETURN COALESCE(v_mtm, 0);
END;
$fn$;

COMMENT ON FUNCTION logic_opt_lane_mtm(INTEGER, TEXT, TIMESTAMP, BOOLEAN, BIGINT, INTEGER) IS
'Unrealized PnL of lane opens still open at p_at_bar (mark at TF close).';

DROP FUNCTION IF EXISTS logic_opt_lane_finres(INTEGER, TEXT, TIMESTAMP, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_opt_lane_finres(INTEGER, TEXT, TIMESTAMP, TIMESTAMP, BOOLEAN);
DROP FUNCTION IF EXISTS logic_opt_lane_finres(INTEGER, TEXT, TIMESTAMP, TIMESTAMP, BOOLEAN, BIGINT);
DROP FUNCTION IF EXISTS logic_opt_lane_finres(INTEGER, TEXT, TIMESTAMP, TIMESTAMP, BOOLEAN, BIGINT, INTEGER);

-- Window score: closed FinRes in (from, to] + MTM(to) - MTM(from).
CREATE OR REPLACE FUNCTION logic_opt_lane_finres(
    p_logic_id INTEGER,
    p_opt_lane TEXT,
    p_from_bar TIMESTAMP,
    p_to_bar TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL,
    p_tf_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
    v_is_test BOOLEAN := COALESCE(p_is_test, FALSE);
    v_lane TEXT := COALESCE(p_opt_lane, '');
    v_closed NUMERIC := 0;
    v_mtm_to NUMERIC := 0;
    v_mtm_from NUMERIC := 0;
BEGIN
    SELECT COALESCE(SUM(lt.financial_result), 0)
    INTO v_closed
    FROM logic_trades lt
    JOIN sides s ON s.id = lt.side_id
    WHERE lt.logic_id = p_logic_id
      AND COALESCE(lt.opt_lane, '') = v_lane
      AND lt.is_test = v_is_test
      AND NOT lt.is_shadow
      AND s.name = 'Close'
      AND lt.status IN ('filled', 'submitted')
      AND lt.financial_result IS NOT NULL
      AND COALESCE(lt.trade_reason, '') <> 'opt:promote'
      AND (p_from_bar IS NULL OR lt.bar_dt > p_from_bar)
      AND (p_to_bar IS NULL OR lt.bar_dt <= p_to_bar)
      AND (
          NOT v_is_test
          OR p_run_id IS NULL
          OR lt.run_id = p_run_id
      );

    IF p_tf_id IS NULL OR p_to_bar IS NULL THEN
        RETURN COALESCE(v_closed, 0);
    END IF;

    v_mtm_to := logic_opt_lane_mtm(
        p_logic_id, v_lane, p_to_bar, v_is_test, p_run_id, p_tf_id
    );
    IF p_from_bar IS NOT NULL THEN
        v_mtm_from := logic_opt_lane_mtm(
            p_logic_id, v_lane, p_from_bar, v_is_test, p_run_id, p_tf_id
        );
    END IF;

    RETURN COALESCE(v_closed, 0) + COALESCE(v_mtm_to, 0) - COALESCE(v_mtm_from, 0);
END;
$fn$;

COMMENT ON FUNCTION logic_opt_lane_finres(INTEGER, TEXT, TIMESTAMP, TIMESTAMP, BOOLEAN, BIGINT, INTEGER) IS
'OPT window score: closed FinRes in window + (MTM at to - MTM at from).';

DROP FUNCTION IF EXISTS logic_opt_close_open_lanes(INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_opt_close_open_lanes(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT);

CREATE OR REPLACE FUNCTION logic_opt_close_open_lanes(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_bar_dt TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_account_id INTEGER;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_rec RECORD;
    v_pp NUMERIC;
    v_qty NUMERIC;
    v_trade_id BIGINT;
    v_closed INTEGER := 0;
    v_comm NUMERIC;
    v_is_test BOOLEAN := COALESCE(p_is_test, FALSE);
BEGIN
    SELECT l.account_id INTO v_account_id FROM logics l WHERE l.id = p_logic_id;
    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;
    IF v_side_close_id IS NULL THEN
        RETURN 0;
    END IF;

    FOR v_rec IN
        SELECT DISTINCT lt.security_id, lt.opt_lane
        FROM logic_trades lt
        WHERE lt.logic_id = p_logic_id
          AND COALESCE(lt.opt_lane, '') <> ''
          AND lt.is_test = v_is_test
          AND NOT lt.is_shadow
          AND (NOT v_is_test OR p_run_id IS NULL OR lt.run_id = p_run_id)
    LOOP
        SELECT p.close_price INTO v_pp
        FROM prices p
        WHERE p.security_id = v_rec.security_id
          AND p.timeframe_id = p_tf_id
          AND p.dt = p_bar_dt
        LIMIT 1;
        IF v_pp IS NULL OR v_pp <= 0 THEN
            CONTINUE;
        END IF;

        v_qty := logic_long_position_qty(
            p_logic_id, v_rec.security_id, FALSE, v_is_test, v_rec.opt_lane
        );
        IF v_qty > 0 THEN
            v_comm := logic_trade_calc_commission(p_logic_id, v_qty * v_pp);
            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, position_event, signal_kind, signal_formula,
                quantity, price, commission, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                opt_lane, run_id, status, note, trade_reason
            )
            VALUES (
                p_logic_id, v_account_id, v_rec.security_id, p_tf_id,
                v_side_close_id, v_action_long_id, 'close', 'opt', 'OPT promote reset',
                v_qty::INTEGER, v_pp, COALESCE(v_comm, 0), p_bar_dt, TRUE, FALSE, FALSE, v_is_test,
                v_rec.opt_lane, CASE WHEN v_is_test THEN p_run_id ELSE NULL END,
                'filled', 'opt.promote.close', 'opt:promote'
            )
            ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow, opt_lane)
                DO NOTHING
            RETURNING id INTO v_trade_id;
            IF v_trade_id IS NOT NULL THEN
                PERFORM logic_trade_finalize(v_trade_id, NULL);
                v_closed := v_closed + 1;
            END IF;
        END IF;

        v_qty := logic_short_position_qty(
            p_logic_id, v_rec.security_id, FALSE, v_is_test, v_rec.opt_lane
        );
        IF v_qty > 0 THEN
            v_comm := logic_trade_calc_commission(p_logic_id, v_qty * v_pp);
            v_trade_id := NULL;
            INSERT INTO logic_trades (
                logic_id, account_id, security_id, timeframe_id,
                side_id, action_id, position_event, signal_kind, signal_formula,
                quantity, price, commission, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                opt_lane, run_id, status, note, trade_reason
            )
            VALUES (
                p_logic_id, v_account_id, v_rec.security_id, p_tf_id,
                v_side_close_id, v_action_short_id, 'close', 'opt', 'OPT promote reset',
                v_qty::INTEGER, v_pp, COALESCE(v_comm, 0), p_bar_dt, TRUE, FALSE, FALSE, v_is_test,
                v_rec.opt_lane, CASE WHEN v_is_test THEN p_run_id ELSE NULL END,
                'filled', 'opt.promote.close', 'opt:promote'
            )
            ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow, opt_lane)
                DO NOTHING
            RETURNING id INTO v_trade_id;
            IF v_trade_id IS NOT NULL THEN
                PERFORM logic_trade_finalize(v_trade_id, NULL);
                v_closed := v_closed + 1;
            END IF;
        END IF;
    END LOOP;
    RETURN v_closed;
END;
$$;

DROP FUNCTION IF EXISTS logic_opt_maybe_promote(INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS logic_opt_maybe_promote(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT);

CREATE OR REPLACE FUNCTION logic_opt_maybe_promote(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_closed_bar_dt TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
    v_n INTEGER;
    v_bars INTEGER := 0;
    v_last_raw TEXT;
    v_last_dt TIMESTAMP;
    v_tf_sec INTEGER;
    v_champ NUMERIC;
    v_best_lane TEXT := '';
    v_best_score NUMERIC;
    v_arm RECORD;
    v_score NUMERIC;
    v_sig RECORD;
    v_new_formula TEXT;
    v_winner JSONB;
    v_sec RECORD;
    v_prev_bases JSONB;
    v_is_test BOOLEAN := COALESCE(p_is_test, FALSE);
BEGIN
    -- Offline grid on the same test run: no mid-run promote (full-period ranking at finish).
    IF v_is_test AND p_run_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1
            FROM logic_backtest_runs r
            WHERE r.id = p_run_id
              AND r.opt_grid_arms IS NOT NULL
              AND jsonb_typeof(r.opt_grid_arms) = 'array'
              AND jsonb_array_length(r.opt_grid_arms) > 0
        ) THEN
            RETURN FALSE;
        END IF;
    END IF;

    IF NOT logic_opt_logic_has_opt(p_logic_id) THEN
        RETURN FALSE;
    END IF;

    v_n := GREATEST(1, COALESCE(get_logic_param_numeric(p_logic_id, 'opt_eval_candles', 200), 200)::INTEGER);

    IF v_is_test THEN
        IF p_run_id IS NULL THEN
            RETURN FALSE;
        END IF;
        SELECT r.last_opt_eval_bar_dt INTO v_last_dt
        FROM logic_backtest_runs r WHERE r.id = p_run_id;
    ELSE
        v_last_raw := btrim(COALESCE(get_logic_param_text(p_logic_id, 'last_opt_eval_bar_dt'), ''));
        IF v_last_raw <> '' THEN
            BEGIN
                v_last_dt := v_last_raw::TIMESTAMP;
            EXCEPTION WHEN OTHERS THEN
                v_last_dt := NULL;
            END;
        END IF;
    END IF;

    SELECT t.sec INTO v_tf_sec FROM timeframes t WHERE t.id = p_tf_id;
    IF v_tf_sec IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_last_dt IS NULL THEN
        IF v_is_test THEN
            UPDATE logic_backtest_runs
            SET last_opt_eval_bar_dt = p_closed_bar_dt
            WHERE id = p_run_id;
        ELSE
            -- Первый live-курсор: снимок начальных баз для будущего «Сброс OPT».
            PERFORM logic_opt_snapshot_params(p_logic_id, NULL, p_closed_bar_dt);
            PERFORM logic_upsert_param(
                p_logic_id,
                'last_opt_eval_bar_dt',
                to_char(p_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'),
                'text'
            );
        END IF;
        RETURN FALSE;
    END IF;

    IF p_closed_bar_dt <= v_last_dt THEN
        RETURN FALSE;
    END IF;

    v_bars := GREATEST(
        1,
        floor(EXTRACT(EPOCH FROM (p_closed_bar_dt - v_last_dt)) / v_tf_sec)::INTEGER
    );
    IF v_bars < v_n THEN
        RETURN FALSE;
    END IF;

    v_champ := logic_opt_lane_finres(
        p_logic_id, '', v_last_dt, p_closed_bar_dt, v_is_test,
        CASE WHEN v_is_test THEN p_run_id ELSE NULL END,
        p_tf_id
    );
    v_best_score := v_champ;
    v_best_lane := '';
    v_winner := NULL;

    FOR v_arm IN SELECT * FROM logic_opt_build_arms(p_logic_id)
    LOOP
        v_score := logic_opt_lane_finres(
            p_logic_id, v_arm.lane, v_last_dt, p_closed_bar_dt, v_is_test,
            CASE WHEN v_is_test THEN p_run_id ELSE NULL END,
            p_tf_id
        );
        IF v_score > v_best_score THEN
            v_best_score := v_score;
            v_best_lane := v_arm.lane;
            v_winner := v_arm.values_json;
        END IF;
    END LOOP;

    IF v_winner IS NULL OR v_best_lane = '' THEN
        IF v_is_test THEN
            UPDATE logic_backtest_runs
            SET last_opt_eval_bar_dt = p_closed_bar_dt
            WHERE id = p_run_id;
        ELSE
            PERFORM logic_upsert_param(
                p_logic_id,
                'last_opt_eval_bar_dt',
                to_char(p_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'),
                'text'
            );
            PERFORM logic_trade_log(
                p_logic_id,
                'opt.window',
                format('Окно OPT %s свечей: чемпион лучше или равен (FinRes=%s)', v_n, v_champ),
                jsonb_build_object(
                    'champion_finres', v_champ,
                    'bars', v_bars,
                    'from_bar', v_last_dt,
                    'to_bar', p_closed_bar_dt
                ),
                NULL,
                p_tf_id
            );
        END IF;
        PERFORM logic_opt_close_open_lanes(
            p_logic_id, p_tf_id, p_closed_bar_dt, v_is_test, p_run_id
        );
        RETURN FALSE;
    END IF;

    SELECT COALESCE(jsonb_object_agg(s.key, s.base), '{}'::jsonb)
    INTO v_prev_bases
    FROM logic_opt_collect_specs(p_logic_id) s;

    FOR v_sig IN
        SELECT id, formula FROM logic_indicator_signals
        WHERE logic_id = p_logic_id AND is_active = TRUE
    LOOP
        v_new_formula := logic_opt_rewrite_formula_bases(v_sig.formula, v_winner);
        IF v_new_formula IS DISTINCT FROM v_sig.formula THEN
            UPDATE logic_indicator_signals
            SET formula = v_new_formula
            WHERE id = v_sig.id;
        END IF;
    END LOOP;

    PERFORM logic_opt_record_param_event(
        p_logic_id,
        CASE WHEN v_is_test THEN p_run_id ELSE NULL END,
        p_closed_bar_dt,
        'promote',
        v_best_lane,
        v_winner,
        v_prev_bases,
        v_champ,
        v_best_score
    );

    PERFORM logic_opt_close_open_lanes(
        p_logic_id, p_tf_id, p_closed_bar_dt, v_is_test, p_run_id
    );

    -- Live: apply series params. Test: champion eval via evaluate_at_opt (no full sync).
    IF NOT v_is_test THEN
        FOR v_sec IN
            SELECT security_id FROM logic_securities
            WHERE logic_id = p_logic_id AND is_active = TRUE
        LOOP
            CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sec.security_id);
        END LOOP;
    END IF;

    IF v_is_test THEN
        UPDATE logic_backtest_runs
        SET last_opt_eval_bar_dt = p_closed_bar_dt
        WHERE id = p_run_id;
    ELSE
        PERFORM logic_upsert_param(
            p_logic_id,
            'last_opt_eval_bar_dt',
            to_char(p_closed_bar_dt, 'YYYY-MM-DD"T"HH24:MI:SS'),
            'text'
        );
        PERFORM logic_trade_log(
            p_logic_id,
            'opt.promote',
            format(
                'OPT promote: lane=%s FinRes=%s > champion=%s → %s',
                v_best_lane, v_best_score, v_champ, v_winner::TEXT
            ),
            jsonb_build_object(
                'lane', v_best_lane,
                'winner', v_winner,
                'winner_finres', v_best_score,
                'champion_finres', v_champ,
                'bars', v_bars
            ),
            NULL,
            p_tf_id
        );
    END IF;
    RETURN TRUE;
END;
$$;

DROP FUNCTION IF EXISTS process_logic_opt_trades(INTEGER, INTEGER, TIMESTAMP);
DROP FUNCTION IF EXISTS process_logic_opt_trades(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT, NUMERIC);

CREATE OR REPLACE FUNCTION process_logic_opt_trades(
    p_logic_id INTEGER,
    p_tf_id INTEGER,
    p_closed_bar_dt TIMESTAMP,
    p_is_test BOOLEAN DEFAULT FALSE,
    p_run_id BIGINT DEFAULT NULL,
    p_sizing_base NUMERIC DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_logic RECORD;
    v_arm RECORD;
    v_sec RECORD;
    v_grp RECORD;
    v_sig RECORD;
    v_eval RECORD;
    v_created INTEGER := 0;
    v_all_ok BOOLEAN;
    v_formulas TEXT;
    v_signal_kind TEXT;
    v_pp NUMERIC;
    v_ind_dt TIMESTAMP;
    v_held_long NUMERIC;
    v_held_short NUMERIC;
    v_is_open_event BOOLEAN;
    v_quantity INTEGER;
    v_side_id INTEGER;
    v_action_id INTEGER;
    v_side_open_id INTEGER;
    v_side_close_id INTEGER;
    v_action_long_id INTEGER;
    v_action_short_id INTEGER;
    v_eff_side TEXT;
    v_eff_inversion BOOLEAN;
    v_inversion BOOLEAN;
    v_lot_size INTEGER;
    v_is_futures BOOLEAN;
    v_position_size_pct NUMERIC;
    v_max_order_amount NUMERIC;
    v_sizing_base NUMERIC;
    v_cycle_budget NUMERIC;
    v_max_exposure NUMERIC;
    v_spent_notional NUMERIC;
    v_room NUMERIC;
    v_order_notional NUMERIC;
    v_equity_cap NUMERIC;
    v_trade_id BIGINT;
    v_comm NUMERIC;
    v_max_positions INTEGER;
    v_open_lane INTEGER;
    v_is_test BOOLEAN := COALESCE(p_is_test, FALSE);
    v_grid_arms JSONB := NULL;
    v_use_grid BOOLEAN := FALSE;
BEGIN
    -- Same backtest run: formula OPT() arms OR offline grid arms stored on the run.
    IF v_is_test AND p_run_id IS NOT NULL THEN
        SELECT r.opt_grid_arms
        INTO v_grid_arms
        FROM logic_backtest_runs r
        WHERE r.id = p_run_id;
        IF v_grid_arms IS NOT NULL
           AND jsonb_typeof(v_grid_arms) = 'array'
           AND jsonb_array_length(v_grid_arms) > 0 THEN
            v_use_grid := TRUE;
        END IF;
    END IF;

    IF NOT v_use_grid AND NOT logic_opt_logic_has_opt(p_logic_id) THEN
        RETURN 0;
    END IF;

    IF v_is_test THEN
        -- Тест: логика может быть выключена; счёт всё равно нужен.
        SELECT l.id, l.account_id
        INTO v_logic
        FROM logics l
        WHERE l.id = p_logic_id;
        IF NOT FOUND THEN
            RETURN 0;
        END IF;
    ELSE
        SELECT l.id, l.account_id
        INTO v_logic
        FROM logics l
        JOIN accounts a ON a.id = l.account_id
        WHERE l.id = p_logic_id AND l.is_enabled = TRUE AND a.is_active = TRUE;
        IF NOT FOUND THEN
            RETURN 0;
        END IF;
    END IF;

    SELECT id INTO v_side_open_id FROM sides WHERE name = 'Open' LIMIT 1;
    SELECT id INTO v_side_close_id FROM sides WHERE name = 'Close' LIMIT 1;
    SELECT id INTO v_action_long_id FROM actions WHERE name = 'Long' LIMIT 1;
    SELECT id INTO v_action_short_id FROM actions WHERE name = 'Short' LIMIT 1;
    IF v_side_open_id IS NULL OR v_side_close_id IS NULL THEN
        RETURN 0;
    END IF;

    v_position_size_pct := get_logic_param_numeric(p_logic_id, 'position_size_pct', 10);
    v_max_positions := GREATEST(1, get_logic_param_numeric(p_logic_id, 'max_open_positions', 5)::INTEGER);
    v_max_order_amount := get_logic_param_numeric(p_logic_id, 'max_order_amount', NULL);
    v_inversion := get_logic_param_boolean(p_logic_id, 'inversion', FALSE);

    -- Как у чемпиона: база цикла ≤ equity. Раньше OPT брал сырой free_cash / 1e6
    -- → paper-лоты ~100k при cash_amount после шортов (путать с маржой брокера).
    IF v_is_test THEN
        v_cycle_budget := COALESCE(NULLIF(p_sizing_base, 0), NULL);
        IF v_cycle_budget IS NULL OR v_cycle_budget <= 0 THEN
            IF p_run_id IS NOT NULL THEN
                SELECT COALESCE(NULLIF(r.test_balance, 0), 1000000)
                INTO v_cycle_budget
                FROM logic_backtest_runs r WHERE r.id = p_run_id;
            END IF;
            v_cycle_budget := COALESCE(NULLIF(v_cycle_budget, 0), 1000000);
        END IF;
        BEGIN
            v_equity_cap := logic_backtest_portfolio_equity(
                p_logic_id, p_tf_id, p_closed_bar_dt, v_cycle_budget
            );
            IF v_equity_cap IS NOT NULL AND v_equity_cap > 0 THEN
                v_cycle_budget := LEAST(v_cycle_budget, v_equity_cap);
            END IF;
        EXCEPTION
            WHEN undefined_function THEN
                NULL;
            WHEN OTHERS THEN
                NULL;
        END;
    ELSE
        v_cycle_budget := COALESCE(
            NULLIF(p_sizing_base, 0),
            logic_exposure_cycle_budget(p_logic_id, p_tf_id)
        );
        IF v_cycle_budget IS NULL OR v_cycle_budget <= 0 THEN
            v_cycle_budget := COALESCE(
                NULLIF(logic_position_sizing_base(p_logic_id, p_tf_id), 0),
                1000000
            );
        END IF;
    END IF;
    v_sizing_base := v_cycle_budget;
    v_max_exposure := v_cycle_budget
        * (GREATEST(0, COALESCE(v_position_size_pct, 0)) / 100.0)
        * v_max_positions;

    -- Кэш канала на бар: 34 бумаги × 2 std_dev × 4 сигнала → было 272 calc, станет ~68
    PERFORM logic_opt_ensure_linreg_cache();
    TRUNCATE opt_linreg_cache;

    FOR v_arm IN
        SELECT a->>'lane' AS lane, a->'values' AS values_json
        FROM jsonb_array_elements(v_grid_arms) AS a
        WHERE v_use_grid
        UNION ALL
        SELECT b.lane, b.values_json
        FROM logic_opt_build_arms(p_logic_id) AS b
        WHERE NOT v_use_grid
    LOOP
        -- Один раз на ветку: число бумаг с открытой позицией (раньше — на каждую бумагу).
        SELECT COUNT(*)::INTEGER INTO v_open_lane
        FROM (
            SELECT lt.security_id
            FROM logic_trades lt
            JOIN sides s ON s.id = lt.side_id
            JOIN actions a ON a.id = lt.action_id
            WHERE lt.logic_id = p_logic_id
              AND COALESCE(lt.opt_lane, '') = v_arm.lane
              AND NOT lt.is_shadow
              AND lt.is_test = v_is_test
              AND (NOT v_is_test OR p_run_id IS NULL OR lt.run_id = p_run_id)
              AND lt.status IN ('filled', 'submitted')
            GROUP BY lt.security_id
            HAVING COALESCE(SUM(
                CASE
                    WHEN s.name = 'Open' AND a.name = 'Long' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Long' THEN -lt.quantity
                    WHEN s.name = 'Open' AND a.name = 'Short' THEN lt.quantity
                    WHEN s.name = 'Close' AND a.name = 'Short' THEN -lt.quantity
                    ELSE 0
                END
            ), 0) > 0
        ) q;

        v_spent_notional := logic_open_notional_exposure(
            p_logic_id, v_is_test, v_arm.lane, CASE WHEN v_is_test THEN p_run_id ELSE NULL END
        );

        -- Как у чемпиона: лучший PnL ветки; один GROUP BY на бар (не N коррелированных SUM).
        FOR v_sec IN
            SELECT
                ls.security_id,
                COALESCE(ls.real_trading_inverted, FALSE) AS real_trading_inverted
            FROM logic_securities ls
            LEFT JOIN (
                SELECT lt.security_id,
                       COALESCE(SUM(lt.financial_result), 0) AS pnl
                FROM logic_trades lt
                JOIN sides s ON s.id = lt.side_id
                WHERE lt.logic_id = p_logic_id
                  AND lt.is_test = v_is_test
                  AND NOT lt.is_shadow
                  AND COALESCE(lt.opt_lane, '') = v_arm.lane
                  AND (NOT v_is_test OR lt.run_id = p_run_id)
                  AND s.name = 'Close'
                  AND lt.status IN ('filled', 'submitted')
                GROUP BY lt.security_id
            ) pnl ON pnl.security_id = ls.security_id
            WHERE ls.logic_id = p_logic_id AND ls.is_active = TRUE
              AND NOT logic_is_cash_fund_security(ls.security_id)
            ORDER BY COALESCE(pnl.pnl, 0) DESC,
                     ls.display_order NULLS LAST,
                     ls.id
        LOOP
            v_eff_inversion := (v_inversion <> COALESCE(v_sec.real_trading_inverted, FALSE));
            v_lot_size := logic_security_lot_size(v_sec.security_id);
            v_is_futures := logic_security_is_futures(v_sec.security_id);

            FOR v_grp IN
                SELECT lis.position_event, lis.position_side
                FROM logic_indicator_signals lis
                WHERE lis.logic_id = p_logic_id AND lis.is_active = TRUE
                GROUP BY lis.position_event, lis.position_side
                ORDER BY lis.position_event, lis.position_side
            LOOP
                v_all_ok := TRUE;
                v_formulas := NULL;
                v_signal_kind := NULL;
                v_pp := NULL;
                v_ind_dt := NULL;

                FOR v_sig IN
                    SELECT lis.id, lis.position_event, lis.position_side, lis.signal_kind, lis.formula
                    FROM logic_indicator_signals lis
                    WHERE lis.logic_id = p_logic_id
                      AND lis.is_active = TRUE
                      AND lis.position_event = v_grp.position_event
                      AND lis.position_side = v_grp.position_side
                    ORDER BY lis.display_order, lis.id
                LOOP
                    SELECT * INTO v_eval
                    FROM logic_signal_evaluate_at_opt(
                        v_sig.id, v_sec.security_id, p_tf_id, p_closed_bar_dt,
                        v_eff_inversion, v_arm.values_json
                    );
                    IF v_eval.close_price IS NULL THEN
                        v_all_ok := FALSE;
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
                    IF NOT COALESCE(v_eval.ok, FALSE) THEN
                        v_all_ok := FALSE;
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
                    THEN logic_long_position_qty(
                        p_logic_id, v_sec.security_id, FALSE, v_is_test, v_arm.lane
                    )
                    ELSE 0
                END;
                v_held_short := CASE
                    WHEN v_eff_side = 'short'
                    THEN logic_short_position_qty(
                        p_logic_id, v_sec.security_id, FALSE, v_is_test, v_arm.lane
                    )
                    ELSE 0
                END;
                v_is_open_event := COALESCE(v_grp.position_event, 'open') = 'open';

                IF v_eff_side = 'long' THEN
                    IF v_is_open_event THEN
                        IF v_held_long > 0 OR v_open_lane >= v_max_positions THEN
                            CONTINUE;
                        END IF;
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
                        v_action_id := v_action_long_id;
                    ELSE
                        IF v_held_long <= 0 THEN
                            CONTINUE;
                        END IF;
                        v_quantity := v_held_long::INTEGER;
                        v_side_id := v_side_close_id;
                        v_action_id := v_action_long_id;
                    END IF;
                ELSIF v_is_open_event THEN
                    IF v_held_short > 0 OR v_open_lane >= v_max_positions THEN
                        CONTINUE;
                    END IF;
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
                ELSE
                    IF v_held_short <= 0 THEN
                        CONTINUE;
                    END IF;
                    v_quantity := v_held_short::INTEGER;
                    v_side_id := v_side_close_id;
                    v_action_id := v_action_short_id;
                END IF;

                v_comm := logic_trade_calc_commission(p_logic_id, v_quantity * v_pp);
                INSERT INTO logic_trades (
                    logic_id, account_id, security_id, timeframe_id,
                    side_id, action_id, position_event, signal_kind, signal_formula,
                    quantity, price, commission, bar_dt, is_simulated, is_fictitious, is_shadow, is_test,
                    opt_lane, run_id, status, note, trade_reason
                )
                VALUES (
                    p_logic_id, v_logic.account_id, v_sec.security_id, p_tf_id,
                    v_side_id, v_action_id, v_grp.position_event, v_signal_kind, v_formulas,
                    v_quantity, v_pp, COALESCE(v_comm, 0), v_ind_dt, TRUE, FALSE, FALSE, v_is_test,
                    v_arm.lane,
                    CASE WHEN v_is_test THEN p_run_id ELSE NULL END,
                    'filled', 'opt paper', 'opt:' || v_arm.lane
                )
                ON CONFLICT (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow, opt_lane)
                    DO NOTHING
                RETURNING id INTO v_trade_id;

                IF v_trade_id IS NOT NULL THEN
                    PERFORM logic_trade_finalize(v_trade_id, NULL);
                    v_created := v_created + 1;
                    IF v_is_open_event THEN
                        v_open_lane := v_open_lane + 1;
                        v_spent_notional := v_spent_notional + (v_quantity * v_pp);
                    ELSE
                        v_open_lane := GREATEST(0, v_open_lane - 1);
                        v_spent_notional := GREATEST(
                            0, v_spent_notional - (v_quantity * v_pp)
                        );
                    END IF;
                    -- Tech log только в бою — в тесте тысячи строк сильно тормозят.
                    IF NOT v_is_test THEN
                        PERFORM logic_trade_log(
                            p_logic_id,
                            'opt.trade',
                            format('OPT %s сделка #%s qty=%s', v_arm.lane, v_trade_id, v_quantity),
                            jsonb_build_object(
                                'opt_lane', v_arm.lane,
                                'trade_id', v_trade_id,
                                'values', v_arm.values_json,
                                'bar_dt', v_ind_dt
                            ),
                            v_sec.security_id,
                            p_tf_id
                        );
                    END IF;
                END IF;
            END LOOP;
        END LOOP;
    END LOOP;

    RETURN v_created;
END;
$$;

COMMENT ON FUNCTION process_logic_opt_trades(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT, NUMERIC) IS
'Бумажные сделки OPT-веток (opt_lane): база = exposure_cycle_budget (≤ equity), потолок %×макс.поз как у чемпиона.';

COMMENT ON FUNCTION logic_opt_maybe_promote(INTEGER, INTEGER, TIMESTAMP, BOOLEAN, BIGINT) IS
'Каждые opt_eval_candles: FinRes чемпиона vs ветки; promote + history (run_id в тесте).';

CREATE OR REPLACE FUNCTION logic_opt_restore_formulas_from_run(p_run_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_formulas JSONB;
    v_item JSONB;
    v_n INTEGER := 0;
    v_sid INTEGER;
    v_formula TEXT;
BEGIN
    IF p_run_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT h.formulas
    INTO v_formulas
    FROM logic_opt_param_history h
    WHERE h.run_id = p_run_id
      AND h.event_kind = 'snapshot'
    ORDER BY h.id
    LIMIT 1;

    IF v_formulas IS NULL OR jsonb_typeof(v_formulas) <> 'array' THEN
        RETURN 0;
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_formulas)
    LOOP
        v_sid := NULLIF(v_item->>'signal_id', '')::INTEGER;
        v_formula := v_item->>'formula';
        IF v_sid IS NULL OR v_formula IS NULL OR btrim(v_formula) = '' THEN
            CONTINUE;
        END IF;
        UPDATE logic_indicator_signals
        SET formula = v_formula
        WHERE id = v_sid
          AND formula IS DISTINCT FROM v_formula;
        IF FOUND THEN
            v_n := v_n + 1;
        END IF;
    END LOOP;

    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION logic_opt_restore_formulas_from_run(BIGINT) IS
'После теста: вернуть формулы сигналов из стартового снимка OPT (promote не должен остаться в бою).';

-- Сброс OPT к начальным базам: очистить бумажную книгу opt_lane + вернуть формулы.
-- Источник начальных: earliest live snapshot → любой snapshot → params_prev первого promote.
CREATE OR REPLACE FUNCTION logic_opt_reset_to_initial(p_logic_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_formulas JSONB;
    v_bases JSONB;
    v_item JSONB;
    v_sid INTEGER;
    v_formula TEXT;
    v_sig RECORD;
    v_new_formula TEXT;
    v_restored INTEGER := 0;
    v_deleted INTEGER := 0;
    v_source TEXT := 'none';
    v_sec RECORD;
    v_after JSONB;
BEGIN
    IF p_logic_id IS NULL OR p_logic_id <= 0 THEN
        RETURN jsonb_build_object('ok', FALSE, 'error', 'invalid logic_id');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM logics WHERE id = p_logic_id) THEN
        RETURN jsonb_build_object('ok', FALSE, 'error', 'logic not found');
    END IF;

    IF NOT logic_opt_logic_has_opt(p_logic_id) THEN
        RETURN jsonb_build_object(
            'ok', TRUE,
            'formulas_restored', 0,
            'opt_trades_deleted', 0,
            'source', 'none',
            'message', 'В формулах нет OPT — сброс не нужен'
        );
    END IF;

    -- Сначала найти начальные (до любых новых snapshot).
    SELECT h.formulas
    INTO v_formulas
    FROM logic_opt_param_history h
    WHERE h.logic_id = p_logic_id
      AND h.event_kind = 'snapshot'
      AND h.run_id IS NULL
      AND COALESCE(h.lane, '') <> 'reset'
      AND jsonb_typeof(h.formulas) = 'array'
      AND jsonb_array_length(h.formulas) > 0
    ORDER BY h.id
    LIMIT 1;

    IF v_formulas IS NOT NULL THEN
        v_source := 'snapshot_live';
    ELSE
        SELECT h.formulas
        INTO v_formulas
        FROM logic_opt_param_history h
        WHERE h.logic_id = p_logic_id
          AND h.event_kind = 'snapshot'
          AND COALESCE(h.lane, '') <> 'reset'
          AND jsonb_typeof(h.formulas) = 'array'
          AND jsonb_array_length(h.formulas) > 0
        ORDER BY h.id
        LIMIT 1;
        IF v_formulas IS NOT NULL THEN
            v_source := 'snapshot';
        END IF;
    END IF;

    IF v_formulas IS NULL THEN
        SELECT h.params_prev
        INTO v_bases
        FROM logic_opt_param_history h
        WHERE h.logic_id = p_logic_id
          AND h.event_kind = 'promote'
          AND h.params_prev IS NOT NULL
          AND jsonb_typeof(h.params_prev) = 'object'
          AND h.params_prev <> '{}'::jsonb
        ORDER BY h.id
        LIMIT 1;
        IF v_bases IS NOT NULL THEN
            v_source := 'params_prev';
        END IF;
    END IF;

    -- Восстановить формулы
    IF v_formulas IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_formulas)
        LOOP
            v_sid := NULLIF(v_item->>'signal_id', '')::INTEGER;
            v_formula := v_item->>'formula';
            IF v_sid IS NULL OR v_formula IS NULL OR btrim(v_formula) = '' THEN
                CONTINUE;
            END IF;
            UPDATE logic_indicator_signals
            SET formula = v_formula
            WHERE id = v_sid
              AND logic_id = p_logic_id
              AND formula IS DISTINCT FROM v_formula;
            IF FOUND THEN
                v_restored := v_restored + 1;
            END IF;
        END LOOP;
    ELSIF v_bases IS NOT NULL THEN
        FOR v_sig IN
            SELECT id, formula
            FROM logic_indicator_signals
            WHERE logic_id = p_logic_id AND is_active = TRUE
        LOOP
            v_new_formula := logic_opt_rewrite_formula_bases(v_sig.formula, v_bases);
            IF v_new_formula IS DISTINCT FROM v_sig.formula THEN
                UPDATE logic_indicator_signals
                SET formula = v_new_formula
                WHERE id = v_sig.id;
                v_restored := v_restored + 1;
            END IF;
        END LOOP;
    END IF;

    -- Очистить бумажную книгу OPT (live, не test).
    DELETE FROM logic_trades lt
    WHERE lt.logic_id = p_logic_id
      AND COALESCE(lt.opt_lane, '') <> ''
      AND lt.is_test = FALSE;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    -- Сбросить курсор окна OPT — следующий цикл начнёт заново.
    DELETE FROM logic_params
    WHERE logic_id = p_logic_id
      AND param_key = 'last_opt_eval_bar_dt';

    FOR v_sec IN
        SELECT security_id
        FROM logic_securities
        WHERE logic_id = p_logic_id AND is_active = TRUE
    LOOP
        CALL logic_apply_indicator_params_from_signals(p_logic_id, v_sec.security_id);
    END LOOP;

    v_after := logic_opt_collect_formula_state(p_logic_id);
    PERFORM logic_opt_record_param_event(
        p_logic_id, NULL, CURRENT_TIMESTAMP::TIMESTAMP, 'snapshot',
        'reset',
        v_after->'bases',
        NULL, NULL, NULL
    );

    PERFORM logic_trade_log(
        p_logic_id,
        'opt.reset',
        format(
            'Сброс OPT: source=%s, formulas=%s, deleted_opt_trades=%s',
            v_source, v_restored, v_deleted
        ),
        jsonb_build_object(
            'source', v_source,
            'formulas_restored', v_restored,
            'opt_trades_deleted', v_deleted
        ),
        NULL,
        NULL
    );

    RETURN jsonb_build_object(
        'ok', TRUE,
        'formulas_restored', v_restored,
        'opt_trades_deleted', v_deleted,
        'source', v_source,
        'message', CASE
            WHEN v_source = 'none' THEN
                'Книга OPT очищена; начальные базы в истории не найдены — формулы не менялись'
            ELSE
                format('OPT сброшен к начальным (%s)', v_source)
        END
    );
END;
$$;

COMMENT ON FUNCTION logic_opt_reset_to_initial(INTEGER) IS
'Сброс OPT: вернуть начальные базы формул (snapshot / params_prev), удалить live opt_lane сделки, сбросить last_opt_eval_bar_dt.';

-- ---------------------------------------------------------------------------
-- История параметров OPT / формул (отчёт теста)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION logic_opt_collect_formula_state(p_logic_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_bases JSONB := '{}'::jsonb;
    v_opt JSONB := '{}'::jsonb;
    v_formulas JSONB := '[]'::jsonb;
    v_sig RECORD;
    v_parsed RECORD;
    v_spec RECORD;
    v_part TEXT;
    v_key TEXT;
    v_val TEXT;
    v_n NUMERIC;
BEGIN
    FOR v_sig IN
        SELECT id, formula, position_event, position_side
        FROM logic_indicator_signals
        WHERE logic_id = p_logic_id AND is_active = TRUE
        ORDER BY display_order, id
    LOOP
        v_formulas := v_formulas || jsonb_build_array(jsonb_build_object(
            'signal_id', v_sig.id,
            'position_event', v_sig.position_event,
            'position_side', v_sig.position_side,
            'formula', v_sig.formula
        ));
        SELECT * INTO v_parsed FROM parse_signal_formula(v_sig.formula);
        IF NOT COALESCE(v_parsed.valid, FALSE) THEN
            CONTINUE;
        END IF;
        FOREACH v_part IN ARRAY signal_split_params_top_level(v_parsed.params)
        LOOP
            IF v_part ~* '^OPT\s*\(' OR position('=' IN v_part) <= 0 THEN
                CONTINUE;
            END IF;
            v_key := logic_opt_canonical_key(split_part(v_part, '=', 1));
            v_val := btrim(substr(v_part, position('=' IN v_part) + 1));
            IF v_val ~* '^OPT\s*\(' THEN
                CONTINUE;
            END IF;
            BEGIN
                v_n := replace(v_val, ',', '.')::NUMERIC;
                IF NOT (v_bases ? v_key) THEN
                    v_bases := jsonb_set(v_bases, ARRAY[v_key], to_jsonb(v_n), TRUE);
                END IF;
            EXCEPTION WHEN OTHERS THEN
                NULL;
            END;
        END LOOP;
        FOR v_spec IN SELECT * FROM logic_opt_extract_specs(v_parsed.params)
        LOOP
            IF NOT (v_opt ? v_spec.key) THEN
                v_opt := jsonb_set(
                    v_opt,
                    ARRAY[v_spec.key],
                    jsonb_build_object('base', v_spec.base, 'pct', v_spec.pct),
                    TRUE
                );
            END IF;
        END LOOP;
    END LOOP;

    RETURN jsonb_build_object(
        'bases', v_bases,
        'opt', v_opt,
        'formulas', v_formulas,
        'has_opt', (v_opt <> '{}'::jsonb)
    );
END;
$$;

COMMENT ON FUNCTION logic_opt_collect_formula_state(INTEGER) IS
'Текущие базы формул + OPT(key,pct) и список формул для снимка/отчёта.';

CREATE OR REPLACE FUNCTION logic_opt_record_param_event(
    p_logic_id INTEGER,
    p_run_id BIGINT,
    p_bar_dt TIMESTAMP,
    p_event_kind TEXT,
    p_lane TEXT DEFAULT '',
    p_params JSONB DEFAULT NULL,
    p_params_prev JSONB DEFAULT NULL,
    p_champion_finres NUMERIC DEFAULT NULL,
    p_winner_finres NUMERIC DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    v_state JSONB;
    v_params JSONB;
    v_id BIGINT;
BEGIN
    IF p_event_kind NOT IN ('snapshot', 'promote') THEN
        RAISE EXCEPTION 'logic_opt_record_param_event: bad event_kind %', p_event_kind;
    END IF;

    v_state := logic_opt_collect_formula_state(p_logic_id);
    v_params := COALESCE(p_params, v_state->'bases', '{}'::jsonb);

    INSERT INTO logic_opt_param_history (
        logic_id, run_id, bar_dt, event_kind, lane,
        params, params_prev, opt_specs, formulas,
        champion_finres, winner_finres
    )
    VALUES (
        p_logic_id, p_run_id, p_bar_dt, p_event_kind, COALESCE(p_lane, ''),
        v_params, p_params_prev,
        COALESCE(v_state->'opt', '{}'::jsonb),
        COALESCE(v_state->'formulas', '[]'::jsonb),
        p_champion_finres, p_winner_finres
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION logic_opt_record_param_event IS
'Пишет снимок или promote в logic_opt_param_history (не зависит от tech log).';

CREATE OR REPLACE FUNCTION logic_opt_snapshot_params(
    p_logic_id INTEGER,
    p_run_id BIGINT DEFAULT NULL,
    p_bar_dt TIMESTAMP DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE sql AS $$
    SELECT logic_opt_record_param_event(
        p_logic_id, p_run_id, p_bar_dt, 'snapshot', '', NULL, NULL, NULL, NULL
    );
$$;

COMMENT ON FUNCTION logic_opt_snapshot_params(INTEGER, BIGINT, TIMESTAMP) IS
'Снимок текущих параметров формул/OPT (старт теста или fallback в отчёте).';

CREATE OR REPLACE FUNCTION logic_opt_param_history_for_report(
    p_logic_id INTEGER,
    p_run_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_rows JSONB;
    v_state JSONB;
BEGIN
    -- 1) События этого прогона (снимок старта + promote с run_id, если будут)
    IF p_run_id IS NOT NULL THEN
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', h.id,
                    'logic_id', h.logic_id,
                    'run_id', h.run_id,
                    'bar_dt', to_char(h.bar_dt, 'YYYY-MM-DD HH24:MI:SS'),
                    'event_kind', h.event_kind,
                    'lane', h.lane,
                    'params', h.params,
                    'params_prev', h.params_prev,
                    'opt_specs', h.opt_specs,
                    'formulas', h.formulas,
                    'champion_finres', h.champion_finres,
                    'winner_finres', h.winner_finres,
                    'created_at', to_char(h.created_at, 'YYYY-MM-DD HH24:MI:SS')
                )
                ORDER BY h.created_at, h.id
            ),
            '[]'::jsonb
        )
        INTO v_rows
        FROM logic_opt_param_history h
        WHERE h.logic_id = p_logic_id
          AND h.run_id = p_run_id;
        IF v_rows IS NOT NULL AND v_rows <> '[]'::jsonb THEN
            RETURN v_rows;
        END IF;
    END IF;

    -- 2) Live promote (run_id IS NULL) + любые снимки логики — для Отчёта без run / старых прогонов
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', h.id,
                'logic_id', h.logic_id,
                'run_id', h.run_id,
                'bar_dt', to_char(h.bar_dt, 'YYYY-MM-DD HH24:MI:SS'),
                'event_kind', h.event_kind,
                'lane', h.lane,
                'params', h.params,
                'params_prev', h.params_prev,
                'opt_specs', h.opt_specs,
                'formulas', h.formulas,
                'champion_finres', h.champion_finres,
                'winner_finres', h.winner_finres,
                'created_at', to_char(h.created_at, 'YYYY-MM-DD HH24:MI:SS')
            )
            ORDER BY h.created_at, h.id
        ),
        '[]'::jsonb
    )
    INTO v_rows
    FROM logic_opt_param_history h
    WHERE h.logic_id = p_logic_id
      AND (p_run_id IS NULL OR h.run_id IS NULL);

    IF v_rows IS NOT NULL AND v_rows <> '[]'::jsonb THEN
        RETURN v_rows;
    END IF;

    -- 3) Fallback: один снимок «на лету» без INSERT
    v_state := logic_opt_collect_formula_state(p_logic_id);
    RETURN jsonb_build_array(
        jsonb_build_object(
            'id', NULL,
            'logic_id', p_logic_id,
            'run_id', p_run_id,
            'bar_dt', NULL,
            'event_kind', 'snapshot',
            'lane', '',
            'params', COALESCE(v_state->'bases', '{}'::jsonb),
            'params_prev', NULL,
            'opt_specs', COALESCE(v_state->'opt', '{}'::jsonb),
            'formulas', COALESCE(v_state->'formulas', '[]'::jsonb),
            'champion_finres', NULL,
            'winner_finres', NULL,
            'created_at', to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
        )
    );
END;
$$;

COMMENT ON FUNCTION logic_opt_param_history_for_report(INTEGER, BIGINT) IS
'JSON-массив истории OPT/параметров для отчёта; при пустой истории — виртуальный снимок.';

-- Rank offline grid lanes on the same backtest run (champion = empty opt_lane).
CREATE OR REPLACE FUNCTION logic_opt_grid_finalize(p_run_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
    v_logic_id INTEGER;
    v_arms JSONB;
    v_champ NUMERIC := 0;
    v_rows JSONB := '[]'::jsonb;
    v_arm JSONB;
    v_lane TEXT;
    v_fin NUMERIC;
    v_arr JSONB := '[]'::jsonb;
    v_i INTEGER := 0;
    v_item JSONB;
BEGIN
    SELECT r.logic_id, r.opt_grid_arms
    INTO v_logic_id, v_arms
    FROM logic_backtest_runs r
    WHERE r.id = p_run_id;

    IF v_logic_id IS NULL
       OR v_arms IS NULL
       OR jsonb_typeof(v_arms) <> 'array'
       OR jsonb_array_length(v_arms) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(SUM(lt.financial_result), 0)
    INTO v_champ
    FROM logic_trades lt
    WHERE lt.logic_id = v_logic_id
      AND lt.run_id = p_run_id
      AND lt.is_test = TRUE
      AND COALESCE(lt.is_shadow, FALSE) = FALSE
      AND COALESCE(lt.opt_lane, '') = ''
      AND lt.status IN ('filled', 'submitted');

    v_arr := v_arr || jsonb_build_array(
        jsonb_build_object(
            'lane', '',
            'values', '{}'::jsonb,
            'finres', v_champ,
            'is_champion', TRUE
        )
    );

    FOR v_arm IN SELECT * FROM jsonb_array_elements(v_arms)
    LOOP
        v_lane := COALESCE(v_arm->>'lane', '');
        SELECT COALESCE(SUM(lt.financial_result), 0)
        INTO v_fin
        FROM logic_trades lt
        WHERE lt.logic_id = v_logic_id
          AND lt.run_id = p_run_id
          AND lt.is_test = TRUE
          AND COALESCE(lt.is_shadow, FALSE) = FALSE
          AND COALESCE(lt.opt_lane, '') = v_lane
          AND lt.status IN ('filled', 'submitted');

        v_arr := v_arr || jsonb_build_array(
            jsonb_build_object(
                'lane', v_lane,
                'values', COALESCE(v_arm->'values', '{}'::jsonb),
                'finres', v_fin,
                'is_champion', FALSE
            )
        );
    END LOOP;

    -- Rank by finres DESC
    SELECT COALESCE(
        jsonb_agg(
            jsonb_set(
                e.elem,
                '{rank}',
                to_jsonb(e.ord::INTEGER),
                TRUE
            )
            ORDER BY e.ord
        ),
        '[]'::jsonb
    )
    INTO v_rows
    FROM (
        SELECT elem,
               ROW_NUMBER() OVER (ORDER BY (elem->>'finres')::NUMERIC DESC, elem->>'lane') AS ord
        FROM jsonb_array_elements(v_arr) AS elem
    ) e;

    UPDATE logic_backtest_runs
    SET opt_grid_results = v_rows
    WHERE id = p_run_id;

    RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION logic_opt_grid_finalize(BIGINT) IS
'После теста с opt_grid_arms: FinRes чемпиона и каждой grid-ветки, rank; пишет opt_grid_results.';
