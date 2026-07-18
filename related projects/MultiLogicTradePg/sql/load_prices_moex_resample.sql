-- MOEX fallback после неудачи T-Bank (ошибка или 0 свечей); base resample для intraday TF.
-- FORTS ISS: только interval 1,10,60,24,7,31,4 — для M15 берём M10 (быстрее M1).

CREATE OR REPLACE FUNCTION price_load_use_moex_fallback()
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT TRUE;
$$;

COMMENT ON FUNCTION price_load_use_moex_fallback() IS
'MOEX разрешён как fallback после неудачи T-Bank (ошибка или 0 свечей)';

CREATE OR REPLACE FUNCTION moex_forts_base_interval(p_requested INTEGER)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_requested IS NULL THEN 1
        WHEN p_requested IN (1, 10, 60, 24, 7, 31, 4) THEN p_requested
        WHEN p_requested < 10 THEN 1
        WHEN p_requested < 60 THEN 10
        ELSE 60
    END;
$$;

COMMENT ON FUNCTION moex_forts_base_interval(INTEGER) IS
'Ближайший поддерживаемый FORTS interval для resample (M15→10, M5→1, H2→60)';

-- ============================================

CREATE OR REPLACE PROCEDURE resample_prices_to_timeframe(
    p_security_id INTEGER,
    p_src_timeframe_id INTEGER,
    p_dst_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE
)
LANGUAGE plpgsql AS $$
DECLARE
    v_dst_sec INTEGER;
    v_rows INTEGER := 0;
BEGIN
    SELECT t.sec INTO v_dst_sec FROM timeframes t WHERE t.id = p_dst_timeframe_id;
    IF v_dst_sec IS NULL OR v_dst_sec <= 0 THEN
        RAISE EXCEPTION 'resample: неизвестный dst timeframe_id=%', p_dst_timeframe_id;
    END IF;

    INSERT INTO prices (
        security_id, timeframe_id, dt,
        open_price, high_price, low_price, close_price,
        volume, value, contract_prefix
    )
    SELECT
        p.security_id,
        p_dst_timeframe_id,
        to_timestamp((extract(epoch FROM p.dt)::bigint / v_dst_sec) * v_dst_sec),
        (array_agg(p.open_price ORDER BY p.dt ASC))[1],
        max(p.high_price),
        min(p.low_price),
        (array_agg(p.close_price ORDER BY p.dt DESC))[1],
        sum(p.volume),
        sum(p.value),
        max(p.contract_prefix)
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_src_timeframe_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to
    GROUP BY p.security_id, 3
    ON CONFLICT (security_id, timeframe_id, dt)
    DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        volume = EXCLUDED.volume,
        value = EXCLUDED.value,
        contract_prefix = COALESCE(EXCLUDED.contract_prefix, prices.contract_prefix);

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    RAISE NOTICE 'resample → TF id=%: % свечей (% — %)', p_dst_timeframe_id, v_rows, p_date_from, p_date_to;
END;
$$;

COMMENT ON PROCEDURE resample_prices_to_timeframe(INTEGER, INTEGER, INTEGER, DATE, DATE) IS
'Агрегирует свечи более мелкого TF в целевой (epoch-бакеты по sec целевого TF)';

CREATE OR REPLACE PROCEDURE load_moex_interval_candles_paginated(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL,
    p_moex_interval INTEGER DEFAULT 1
)
LANGUAGE plpgsql AS $$
DECLARE
    v_src_tf_id INTEGER;
    v_src_tf VARCHAR(20);
    v_day DATE;
    v_start INTEGER;
    v_batch INTEGER;
    v_total INTEGER := 0;
    v_interval INTEGER;
BEGIN
    v_interval := COALESCE(NULLIF(p_moex_interval, 0), 1);
    v_src_tf := CASE v_interval
        WHEN 1 THEN 'M1'
        WHEN 10 THEN 'M10'
        WHEN 60 THEN 'H1'
        ELSE 'M1'
    END;

    SELECT t.id INTO v_src_tf_id FROM timeframes t WHERE t.tf = v_src_tf LIMIT 1;
    IF v_src_tf_id IS NULL THEN
        RAISE EXCEPTION 'timeframe % not found for MOEX interval %', v_src_tf, v_interval;
    END IF;

    v_day := p_date_from;
    WHILE v_day <= p_date_to LOOP
        v_start := 0;
        LOOP
            CALL load_prices_from_moex_http(
                p_security_id, v_src_tf_id, v_day, v_day, p_contract_prefix, v_interval, v_start
            );
            SELECT records_loaded INTO v_batch
            FROM price_load_log
            WHERE security_id = p_security_id
              AND timeframe_id = v_src_tf_id
              AND date_from = v_day
              AND date_to = v_day
              AND source = 'MOEX'
            ORDER BY id DESC
            LIMIT 1;
            v_batch := COALESCE(v_batch, 0);
            v_total := v_total + v_batch;
            EXIT WHEN v_batch = 0 OR v_batch < 500;
            v_start := v_start + 500;
        END LOOP;
        v_day := v_day + 1;
    END LOOP;

    RAISE NOTICE 'MOEX % paginated: % свечей (% — %)', v_src_tf, v_total, p_date_from, p_date_to;
END;
$$;

COMMENT ON PROCEDURE load_moex_interval_candles_paginated(INTEGER, DATE, DATE, VARCHAR, INTEGER) IS
'Загрузка MOEX FORTS/ISS по дням с пагинацией (interval 1/10/60)';

-- Совместимость: старое имя → M1
CREATE OR REPLACE PROCEDURE load_moex_m1_candles_paginated(
    p_security_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL
)
LANGUAGE plpgsql AS $$
BEGIN
    CALL load_moex_interval_candles_paginated(
        p_security_id, p_date_from, p_date_to, p_contract_prefix, 1
    );
END;
$$;

COMMENT ON PROCEDURE load_moex_m1_candles_paginated(INTEGER, DATE, DATE, VARCHAR) IS
'Загрузка M1 с MOEX по дням с пагинацией start=500';

CREATE OR REPLACE PROCEDURE load_prices_moex_via_base_resample(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL,
    p_base_interval INTEGER DEFAULT 10
)
LANGUAGE plpgsql AS $$
DECLARE
    v_src_tf_id INTEGER;
    v_src_tf VARCHAR(20);
    v_tf_name VARCHAR(20);
    v_resampled INTEGER := 0;
    v_base INTEGER;
BEGIN
    v_base := moex_forts_base_interval(COALESCE(p_base_interval, 10));
    v_src_tf := CASE v_base
        WHEN 1 THEN 'M1'
        WHEN 10 THEN 'M10'
        WHEN 60 THEN 'H1'
        ELSE 'M1'
    END;
    SELECT t.id INTO v_src_tf_id FROM timeframes t WHERE t.tf = v_src_tf LIMIT 1;
    SELECT tf INTO v_tf_name FROM timeframes WHERE id = p_timeframe_id;

    RAISE NOTICE 'MOEX resample: % → % → % (% — %)', v_tf_name, v_src_tf, v_tf_name, p_date_from, p_date_to;

    CALL load_moex_interval_candles_paginated(
        p_security_id, p_date_from, p_date_to, p_contract_prefix, v_base
    );
    CALL resample_prices_to_timeframe(
        p_security_id, v_src_tf_id, p_timeframe_id, p_date_from, p_date_to
    );

    SELECT COUNT(*)::INTEGER INTO v_resampled
    FROM prices p
    WHERE p.security_id = p_security_id
      AND p.timeframe_id = p_timeframe_id
      AND p.dt::date BETWEEN p_date_from AND p_date_to;

    INSERT INTO price_load_log (
        security_id, timeframe_id, date_from, date_to,
        source, records_loaded, contract_prefix, error_message
    )
    VALUES (
        p_security_id, p_timeframe_id, p_date_from, p_date_to,
        format('MOEX-%s', v_src_tf), v_resampled, p_contract_prefix,
        format('MOEX ISS не отдаёт %s напрямую; resample из %s', v_tf_name, v_src_tf)
    );
END;
$$;

COMMENT ON PROCEDURE load_prices_moex_via_base_resample(INTEGER, INTEGER, DATE, DATE, VARCHAR, INTEGER) IS
'Fallback: загрузка базового FORTS interval (обычно M10) + resample в целевой TF';

CREATE OR REPLACE PROCEDURE load_prices_moex_via_m1_resample(
    p_security_id INTEGER,
    p_timeframe_id INTEGER,
    p_date_from DATE,
    p_date_to DATE,
    p_contract_prefix VARCHAR DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_tf_name VARCHAR(20);
    v_req INTEGER;
    v_base INTEGER;
BEGIN
    SELECT tf INTO v_tf_name FROM timeframes WHERE id = p_timeframe_id;
    v_req := get_moex_candle_interval(v_tf_name);
    v_base := moex_forts_base_interval(v_req);
    -- Для M15/M20/M30 предпочитаем M10 (в ~10× меньше HTTP, чем M1)
    CALL load_prices_moex_via_base_resample(
        p_security_id, p_timeframe_id, p_date_from, p_date_to, p_contract_prefix, v_base
    );
END;
$$;

COMMENT ON PROCEDURE load_prices_moex_via_m1_resample(INTEGER, INTEGER, DATE, DATE, VARCHAR) IS
'Fallback: FORTS base interval (M10 для M15) + resample в целевой TF';
