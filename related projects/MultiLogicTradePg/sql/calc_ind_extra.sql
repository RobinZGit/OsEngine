-- Доп. индикаторы для логик L1–L4 (из MultiLogicTradeA / FINRESP):
-- ADX, CCI, LINREG (+ ATR series GROWTH5).
-- Подключается в 02 через маркеры begin/end calc_ind_extra (см. sync-sql-modules-to-02.mjs)

-- ========== ATR: GROWTH5 = % роста ATR за 5 баров (бывший GrOk: Gr=3%, Lb=5) ==========
CREATE OR REPLACE FUNCTION calc_ind_atr_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_atr NUMERIC;
    v_tr NUMERIC;
    v_tr_high NUMERIC;
    v_tr_low NUMERIC;
    v_tr_close NUMERIC;
    v_atr_hist NUMERIC[] := ARRAY[]::NUMERIC[];
    i INTEGER;
    v_start INTEGER;
    v_lb INTEGER := 5;
    v_prev NUMERIC;
BEGIN
    IF upper(btrim(p_series)) NOT IN ('ATR', 'ATR_PCT', 'GROWTH5') THEN
        RETURN;
    END IF;

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(p_period + v_lb + 5, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.high_price ORDER BY x.dt),
           array_agg(x.low_price ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_highs, v_lows, v_closes, v_n
    FROM (
        SELECT p.dt, p.high_price, p.low_price, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < p_period + 1 THEN RETURN; END IF;

    v_atr := 0;
    v_start := GREATEST(p_period, v_n - p_point_count + 1);
    FOR i IN 2 .. v_n LOOP
        v_tr_high := v_highs[i] - v_lows[i];
        v_tr_low := ABS(v_highs[i] - v_closes[i - 1]);
        v_tr_close := ABS(v_lows[i] - v_closes[i - 1]);
        v_tr := GREATEST(v_tr_high, v_tr_low, v_tr_close);
        IF i <= p_period THEN
            v_atr := v_atr + v_tr;
            IF i = p_period THEN v_atr := v_atr / p_period; END IF;
        ELSE
            v_atr := (v_atr * (p_period - 1) + v_tr) / p_period;
        END IF;
        IF i >= p_period THEN
            v_atr_hist := array_append(v_atr_hist, v_atr);
        END IF;
        IF i >= v_start AND i >= p_period THEN
            dt := v_dts[i];
            IF upper(btrim(p_series)) = 'ATR' THEN
                value := v_atr;
            ELSIF upper(btrim(p_series)) = 'ATR_PCT' THEN
                value := CASE WHEN v_closes[i] = 0 THEN NULL ELSE v_atr / v_closes[i] * 100 END;
            ELSE
                -- GROWTH5
                IF array_length(v_atr_hist, 1) > v_lb THEN
                    v_prev := v_atr_hist[array_length(v_atr_hist, 1) - v_lb];
                    value := CASE
                        WHEN v_prev IS NULL OR v_prev = 0 THEN NULL
                        ELSE (v_atr / v_prev - 1.0) * 100.0
                    END;
                ELSE
                    value := NULL;
                END IF;
            END IF;
            IF value IS NOT NULL THEN
                RETURN NEXT;
            END IF;
        END IF;
    END LOOP;
END;
$$;

-- ========== CCI ==========
CREATE OR REPLACE FUNCTION calc_ind_cci_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_tp NUMERIC[];
    v_n INTEGER;
    i INTEGER;
    j INTEGER;
    v_start INTEGER;
    v_sma NUMERIC;
    v_md NUMERIC;
    v_period INTEGER;
BEGIN
    IF upper(btrim(COALESCE(p_series, 'VALUE'))) NOT IN ('VALUE', 'CCI') THEN
        RETURN;
    END IF;
    v_period := GREATEST(COALESCE(p_period, 20), 2);
    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(v_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.high_price ORDER BY x.dt),
           array_agg(x.low_price ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_highs, v_lows, v_closes, v_n
    FROM (
        SELECT p.dt, p.high_price, p.low_price, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < v_period THEN RETURN; END IF;

    v_tp := ARRAY[]::NUMERIC[];
    FOR i IN 1 .. v_n LOOP
        v_tp := array_append(v_tp, (v_highs[i] + v_lows[i] + v_closes[i]) / 3.0);
    END LOOP;

    v_start := GREATEST(v_period, v_n - p_point_count + 1);
    FOR i IN v_period .. v_n LOOP
        IF i < v_start THEN CONTINUE; END IF;
        v_sma := 0;
        FOR j IN (i - v_period + 1) .. i LOOP
            v_sma := v_sma + v_tp[j];
        END LOOP;
        v_sma := v_sma / v_period;
        v_md := 0;
        FOR j IN (i - v_period + 1) .. i LOOP
            v_md := v_md + ABS(v_tp[j] - v_sma);
        END LOOP;
        v_md := v_md / v_period;
        dt := v_dts[i];
        value := CASE
            WHEN v_md = 0 THEN 0
            ELSE (v_tp[i] - v_sma) / (0.015 * v_md)
        END;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- ========== ADX (Wilder) ==========
CREATE OR REPLACE FUNCTION calc_ind_adx_array(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_highs NUMERIC[];
    v_lows NUMERIC[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_period INTEGER;
    v_ser TEXT;
    i INTEGER;
    v_start INTEGER;
    v_tr NUMERIC;
    v_plus_dm NUMERIC;
    v_minus_dm NUMERIC;
    v_atr NUMERIC := 0;
    v_plus_dm_s NUMERIC := 0;
    v_minus_dm_s NUMERIC := 0;
    v_plus_di NUMERIC;
    v_minus_di NUMERIC;
    v_dx NUMERIC;
    v_adx NUMERIC := NULL;
    v_dx_sum NUMERIC := 0;
    v_dx_n INTEGER := 0;
BEGIN
    v_ser := upper(btrim(COALESCE(p_series, 'ADX')));
    IF v_ser NOT IN ('ADX', 'PDI', 'MDI', 'VALUE') THEN
        RETURN;
    END IF;
    IF v_ser = 'VALUE' THEN v_ser := 'ADX'; END IF;
    v_period := GREATEST(COALESCE(p_period, 14), 2);

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(v_period * 3, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.high_price ORDER BY x.dt),
           array_agg(x.low_price ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_highs, v_lows, v_closes, v_n
    FROM (
        SELECT p.dt, p.high_price, p.low_price, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < v_period + 2 THEN RETURN; END IF;

    v_start := GREATEST(v_period * 2, v_n - p_point_count + 1);

    FOR i IN 2 .. v_n LOOP
        v_tr := GREATEST(
            v_highs[i] - v_lows[i],
            ABS(v_highs[i] - v_closes[i - 1]),
            ABS(v_lows[i] - v_closes[i - 1])
        );
        v_plus_dm := CASE
            WHEN (v_highs[i] - v_highs[i - 1]) > (v_lows[i - 1] - v_lows[i])
                 AND (v_highs[i] - v_highs[i - 1]) > 0
            THEN v_highs[i] - v_highs[i - 1]
            ELSE 0
        END;
        v_minus_dm := CASE
            WHEN (v_lows[i - 1] - v_lows[i]) > (v_highs[i] - v_highs[i - 1])
                 AND (v_lows[i - 1] - v_lows[i]) > 0
            THEN v_lows[i - 1] - v_lows[i]
            ELSE 0
        END;

        IF i <= v_period THEN
            v_atr := v_atr + v_tr;
            v_plus_dm_s := v_plus_dm_s + v_plus_dm;
            v_minus_dm_s := v_minus_dm_s + v_minus_dm;
            IF i = v_period THEN
                v_atr := v_atr / v_period;
                v_plus_dm_s := v_plus_dm_s / v_period;
                v_minus_dm_s := v_minus_dm_s / v_period;
            END IF;
        ELSE
            v_atr := (v_atr * (v_period - 1) + v_tr) / v_period;
            v_plus_dm_s := (v_plus_dm_s * (v_period - 1) + v_plus_dm) / v_period;
            v_minus_dm_s := (v_minus_dm_s * (v_period - 1) + v_minus_dm) / v_period;
        END IF;

        IF i < v_period THEN
            CONTINUE;
        END IF;

        IF v_atr = 0 THEN
            v_plus_di := 0;
            v_minus_di := 0;
        ELSE
            v_plus_di := 100.0 * v_plus_dm_s / v_atr;
            v_minus_di := 100.0 * v_minus_dm_s / v_atr;
        END IF;

        IF (v_plus_di + v_minus_di) = 0 THEN
            v_dx := 0;
        ELSE
            v_dx := 100.0 * ABS(v_plus_di - v_minus_di) / (v_plus_di + v_minus_di);
        END IF;

        IF i < v_period * 2 THEN
            v_dx_sum := v_dx_sum + v_dx;
            v_dx_n := v_dx_n + 1;
            IF i = v_period * 2 - 1 THEN
                v_adx := v_dx_sum / GREATEST(v_dx_n, 1);
            END IF;
        ELSIF v_adx IS NOT NULL THEN
            v_adx := (v_adx * (v_period - 1) + v_dx) / v_period;
        END IF;

        IF i >= v_start AND v_adx IS NOT NULL THEN
            dt := v_dts[i];
            value := CASE v_ser
                WHEN 'ADX' THEN v_adx
                WHEN 'PDI' THEN v_plus_di
                WHEN 'MDI' THEN v_minus_di
            END;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

-- ========== LINREG канал (mid ± Dev·σ остатков) ==========
CREATE OR REPLACE FUNCTION calc_ind_linreg_array(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_period INTEGER;
    v_dev NUMERIC;
    v_ser TEXT;
    i INTEGER;
    j INTEGER;
    v_start INTEGER;
    v_sum_x NUMERIC;
    v_sum_y NUMERIC;
    v_sum_xy NUMERIC;
    v_sum_xx NUMERIC;
    v_slope NUMERIC;
    v_intercept NUMERIC;
    v_mid NUMERIC;
    v_var NUMERIC;
    v_std NUMERIC;
    v_pred NUMERIC;
    n NUMERIC;
BEGIN
    v_ser := upper(btrim(COALESCE(p_series, 'VALUE')));
    IF v_ser NOT IN ('VALUE', 'MIDDLE', 'UPPER', 'LOWER', 'SLOPE') THEN
        RETURN;
    END IF;
    IF v_ser = 'VALUE' THEN v_ser := 'MIDDLE'; END IF;
    v_period := GREATEST(COALESCE(p_period, 20), 3);
    v_dev := GREATEST(COALESCE(p_std_dev, 2.0), 0.1);

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(v_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < v_period THEN RETURN; END IF;

    v_start := GREATEST(v_period, v_n - p_point_count + 1);
    n := v_period;

    FOR i IN v_period .. v_n LOOP
        IF i < v_start THEN CONTINUE; END IF;
        v_sum_x := 0;
        v_sum_y := 0;
        v_sum_xy := 0;
        v_sum_xx := 0;
        FOR j IN 0 .. (v_period - 1) LOOP
            -- x = 0..period-1 на окне, y = close
            v_sum_x := v_sum_x + j;
            v_sum_y := v_sum_y + v_closes[i - v_period + 1 + j];
            v_sum_xy := v_sum_xy + j * v_closes[i - v_period + 1 + j];
            v_sum_xx := v_sum_xx + j * j;
        END LOOP;
        v_slope := (n * v_sum_xy - v_sum_x * v_sum_y) / NULLIF(n * v_sum_xx - v_sum_x * v_sum_x, 0);
        v_intercept := (v_sum_y - v_slope * v_sum_x) / n;
        v_mid := v_intercept + v_slope * (v_period - 1);

        v_var := 0;
        FOR j IN 0 .. (v_period - 1) LOOP
            v_pred := v_intercept + v_slope * j;
            v_var := v_var + power(v_closes[i - v_period + 1 + j] - v_pred, 2);
        END LOOP;
        v_std := sqrt(v_var / n);

        dt := v_dts[i];
        value := CASE v_ser
            WHEN 'MIDDLE' THEN v_mid
            WHEN 'UPPER' THEN v_mid + v_dev * v_std
            WHEN 'LOWER' THEN v_mid - v_dev * v_std
            WHEN 'SLOPE' THEN v_slope
        END;
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION calc_ind_cci_array(INTEGER, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'CCI (Commodity Channel Index), серия VALUE';
COMMENT ON FUNCTION calc_ind_adx_array(INTEGER, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'ADX / +DI / −DI (Wilder), серии ADX|PDI|MDI';
COMMENT ON FUNCTION calc_ind_linreg_array(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'Линейная регрессия по close: MIDDLE/UPPER/LOWER/SLOPE (канал Dev·σ остатков)';

-- ========== LINREGV: LinReg с подбором периода (max→3, min max|residual|) ==========
-- period в параметре = максимум окна; на каждом баре перебираем len=period..3,
-- выбираем окно с минимальным max|y−ŷ| (при равенстве — более короткое).
CREATE OR REPLACE FUNCTION calc_ind_linregv_array(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_point_count INTEGER DEFAULT 100,
    p_end_dt TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (dt TIMESTAMP, value NUMERIC)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_end TIMESTAMP;
    v_bars INTEGER;
    v_dts TIMESTAMP[];
    v_closes NUMERIC[];
    v_n INTEGER;
    v_max_period INTEGER;
    v_dev NUMERIC;
    v_ser TEXT;
    i INTEGER;
    j INTEGER;
    len INTEGER;
    v_start INTEGER;
    v_sum_x NUMERIC;
    v_sum_y NUMERIC;
    v_sum_xy NUMERIC;
    v_sum_xx NUMERIC;
    v_slope NUMERIC;
    v_intercept NUMERIC;
    v_mid NUMERIC;
    v_var NUMERIC;
    v_std NUMERIC;
    v_pred NUMERIC;
    v_nlen NUMERIC;
    v_max_abs NUMERIC;
    v_abs NUMERIC;
    v_best_dev NUMERIC;
    v_best_len INTEGER;
    v_best_slope NUMERIC;
    v_best_intercept NUMERIC;
    v_best_mid NUMERIC;
    v_best_std NUMERIC;
BEGIN
    v_ser := upper(btrim(COALESCE(p_series, 'VALUE')));
    IF v_ser NOT IN ('VALUE', 'MIDDLE', 'UPPER', 'LOWER', 'SLOPE', 'PERIOD') THEN
        RETURN;
    END IF;
    IF v_ser = 'VALUE' THEN v_ser := 'MIDDLE'; END IF;
    v_max_period := GREATEST(COALESCE(p_period, 20), 3);
    v_dev := GREATEST(COALESCE(p_std_dev, 2.0), 0.1);

    v_end := ind_resolve_end_dt(p_security_id, p_timeframe_id, p_end_dt);
    IF v_end IS NULL THEN RETURN; END IF;
    v_bars := ind_warmup_bars(v_max_period, p_point_count);

    SELECT array_agg(x.dt ORDER BY x.dt),
           array_agg(x.close_price ORDER BY x.dt),
           COUNT(*)::INTEGER
    INTO v_dts, v_closes, v_n
    FROM (
        SELECT p.dt, p.close_price FROM prices p
        WHERE p.security_id = p_security_id AND p.timeframe_id = p_timeframe_id AND p.dt <= v_end
        ORDER BY p.dt DESC LIMIT v_bars
    ) x;

    IF v_n IS NULL OR v_n < 3 THEN RETURN; END IF;

    v_start := GREATEST(3, v_n - p_point_count + 1);

    FOR i IN 3 .. v_n LOOP
        IF i < v_start THEN CONTINUE; END IF;

        v_best_dev := NULL;
        v_best_len := NULL;
        v_best_slope := NULL;
        v_best_intercept := NULL;
        v_best_mid := NULL;
        v_best_std := NULL;

        FOR len IN REVERSE v_max_period .. 3 LOOP
            IF i < len THEN CONTINUE; END IF;
            v_nlen := len;
            v_sum_x := 0;
            v_sum_y := 0;
            v_sum_xy := 0;
            v_sum_xx := 0;
            FOR j IN 0 .. (len - 1) LOOP
                v_sum_x := v_sum_x + j;
                v_sum_y := v_sum_y + v_closes[i - len + 1 + j];
                v_sum_xy := v_sum_xy + j * v_closes[i - len + 1 + j];
                v_sum_xx := v_sum_xx + j * j;
            END LOOP;
            v_slope := (v_nlen * v_sum_xy - v_sum_x * v_sum_y)
                / NULLIF(v_nlen * v_sum_xx - v_sum_x * v_sum_x, 0);
            IF v_slope IS NULL THEN CONTINUE; END IF;
            v_intercept := (v_sum_y - v_slope * v_sum_x) / v_nlen;
            v_mid := v_intercept + v_slope * (len - 1);

            v_max_abs := 0;
            v_var := 0;
            FOR j IN 0 .. (len - 1) LOOP
                v_pred := v_intercept + v_slope * j;
                v_abs := abs(v_closes[i - len + 1 + j] - v_pred);
                IF v_abs > v_max_abs THEN
                    v_max_abs := v_abs;
                END IF;
                v_var := v_var + power(v_closes[i - len + 1 + j] - v_pred, 2);
            END LOOP;
            v_std := sqrt(v_var / v_nlen);

            -- Минимальный max|residual|; при равенстве — более короткое окно (лучше ловит слом).
            IF v_best_dev IS NULL
                OR v_max_abs < v_best_dev
                OR (v_max_abs = v_best_dev AND len < v_best_len)
            THEN
                v_best_dev := v_max_abs;
                v_best_len := len;
                v_best_slope := v_slope;
                v_best_intercept := v_intercept;
                v_best_mid := v_mid;
                v_best_std := v_std;
            END IF;
        END LOOP;

        IF v_best_len IS NULL THEN CONTINUE; END IF;

        dt := v_dts[i];
        value := CASE v_ser
            WHEN 'MIDDLE' THEN v_best_mid
            WHEN 'UPPER' THEN v_best_mid + v_dev * v_best_std
            WHEN 'LOWER' THEN v_best_mid - v_dev * v_best_std
            WHEN 'SLOPE' THEN v_best_slope
            WHEN 'PERIOD' THEN v_best_len
        END;
        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION calc_ind_linregv_array(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, INTEGER, TIMESTAMP) IS
'LinReg Variable Period: period=max; на баре выбираем len∈[3..max] с min max|y−ŷ|; серии как LINREG + PERIOD';

CREATE OR REPLACE FUNCTION calc_ind_linregv(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT a.value
        FROM calc_ind_linregv_array(
            p_period, COALESCE(p_std_dev, 2.0), p_series,
            p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

COMMENT ON FUNCTION calc_ind_linregv(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Скаляр LINREGV на баре — через calc_ind_linregv_array';

-- =====================================================================
-- Скалярные calc_ind_* (тот же контракт, что у SMA/STOCH: script → calc_ind_*)
-- =====================================================================
CREATE OR REPLACE FUNCTION calc_ind_cci(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT a.value
        FROM calc_ind_cci_array(
            p_period, p_series, p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

CREATE OR REPLACE FUNCTION calc_ind_adx(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT a.value
        FROM calc_ind_adx_array(
            p_period, p_series, p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

CREATE OR REPLACE FUNCTION calc_ind_linreg(
    p_period INTEGER,
    p_std_dev NUMERIC,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT a.value
        FROM calc_ind_linreg_array(
            p_period, COALESCE(p_std_dev, 2.0), p_series,
            p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

-- ATR: серия GROWTH5 через array (старый scalar умел только ATR / ATR_PCT)
CREATE OR REPLACE FUNCTION calc_ind_atr(
    p_period INTEGER,
    p_series VARCHAR,
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_dt TIMESTAMP,
    p_indicator_id INTEGER DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_ser TEXT := upper(btrim(COALESCE(p_series, 'ATR')));
    v_thr NUMERIC;
BEGIN
    IF v_ser = 'GROWTH5' THEN
        RETURN (
            SELECT a.value
            FROM calc_ind_atr_array(
                p_period, 'GROWTH5', p_security_id, p_timeframe_id, 1, p_dt
            ) a
            ORDER BY a.dt DESC
            LIMIT 1
        );
    END IF;

    IF v_ser = 'ATR_PCT' THEN
        RETURN (
            SELECT a.value
            FROM calc_ind_atr_array(
                p_period, 'ATR_PCT', p_security_id, p_timeframe_id, 1, p_dt
            ) a
            ORDER BY a.dt DESC
            LIMIT 1
        );
    END IF;

    IF v_ser <> 'ATR' AND p_indicator_id IS NOT NULL THEN
        v_thr := get_ind_series_threshold(p_indicator_id, p_series);
        IF v_thr IS NOT NULL THEN RETURN v_thr; END IF;
        RETURN NULL;
    END IF;

    RETURN (
        SELECT a.value
        FROM calc_ind_atr_array(
            p_period, 'ATR', p_security_id, p_timeframe_id, 1, p_dt
        ) a
        ORDER BY a.dt DESC
        LIMIT 1
    );
END;
$$;

COMMENT ON FUNCTION calc_ind_cci(INTEGER, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Скаляр CCI на баре (как calc_ind_sma) — через calc_ind_cci_array';
COMMENT ON FUNCTION calc_ind_adx(INTEGER, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Скаляр ADX/+DI/−DI на баре — через calc_ind_adx_array';
COMMENT ON FUNCTION calc_ind_linreg(INTEGER, NUMERIC, VARCHAR, INTEGER, INTEGER, TIMESTAMP, INTEGER) IS
'Скаляр LinReg-канала на баре — через calc_ind_linreg_array';

-- =====================================================================
-- Параметры серии из @IND(...period=N...) в formula сигнала (до sync)
-- тот же парсер сигналов, что у SMA (@SMA(period=20,series=VALUE) …)
-- =====================================================================
CREATE OR REPLACE FUNCTION parse_signal_param_num(p_params TEXT, p_key TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_part TEXT;
    v_key TEXT;
    v_val TEXT;
BEGIN
    IF p_params IS NULL OR btrim(p_params) = '' OR p_key IS NULL THEN
        RETURN NULL;
    END IF;
    FOREACH v_part IN ARRAY string_to_array(p_params, ',')
    LOOP
        v_part := btrim(v_part);
        IF position('=' IN v_part) > 0 THEN
            v_key := lower(btrim(split_part(v_part, '=', 1)));
            v_val := btrim(split_part(v_part, '=', 2));
            IF v_key = lower(btrim(p_key)) AND v_val <> '' THEN
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

CREATE OR REPLACE PROCEDURE logic_apply_indicator_params_from_signals(
    p_logic_id INTEGER,
    p_security_id INTEGER
)
LANGUAGE plpgsql
AS $$
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
        v_std := parse_signal_param_num(v_parsed.params, 'std_dev');
        v_fast := parse_signal_param_num(v_parsed.params, 'fast_period');
        v_slow := parse_signal_param_num(v_parsed.params, 'slow_period');
        v_signal := parse_signal_param_num(v_parsed.params, 'signal_period');
        v_k := parse_signal_param_num(v_parsed.params, 'k_period');
        v_d := parse_signal_param_num(v_parsed.params, 'd_period');
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

COMMENT ON PROCEDURE logic_apply_indicator_params_from_signals(INTEGER, INTEGER) IS
'Проставляет param_* серий бумаги из formula сигналов логики перед sync.';
