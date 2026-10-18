-- ============================================================================
-- Тест ВЫЧИСЛИМЫХ индикаторов справочника → рейтинг (% годовых).
-- Фоновый, по остаточному принципу, на УЖЕ загруженных ценах (без load_prices).
-- Пристраивается к работающей логике: после её цикла/загрузки цен пересчитываем
-- рейтинг по юниверсу пар (бумага × ТФ) именно этой логики (p_logic_id), в фоне.
--
-- Для каждого вычислимого индикатора (есть formula/script и non-threshold типы):
--   1) по каждой паре (бумага × ТФ) — из юниверса логики (или всех логик, если
--      p_logic_id IS NULL) — один раз считаем значения индикатора из существующих
--      цен (инкрементально);
--      для оценки берём последние p_bars_window загруженных свечей пары (защита
--      от роста на длинных историях M1);
--   2) по каждой закрытой свече проверяем условия тренд/контртренд из
--      indicators.sig_trend_def / sig_ct_def (нормализованы к одному ряду VALUE);
--   3) «прибыль» = лучший ход: максимальный high (лонг) / минимальный low (шорт)
--      среди ВСЕХ уже загруженных последующих свечей, в % годовых по времени
--      удержания до этой лучшей точки;
--   4) усредняем по бумагам в разрезе (лонг/шорт × тренд/контр × тип времени),
--      где тип времени: рабочий день/выходной × торговая/неторговая сессия
--      (рыночный шаблон MOEX logic_moex_equity_non_trading_template);
--   5) разрезы с числом сигналов меньше порога не учитываются; годовые обрезаются
--      (уинсоризация) для гашения выбросов.
--   Рейтинг индикатора = максимум среднего % годовых по всем разрезам.
--
-- НЕ путать с рейтингом сигнала на логике (sql/logic_signal_and_rating.sql).
-- Результаты: indicator_rating_sample (сырьё, сутки) и indicator_rating (агрегат).
-- ============================================================================

-- Параметры по умолчанию для авто-формулы индикатора (серия вынесена в series=).
CREATE OR REPLACE FUNCTION indicator_signal_default_params(
    p_code TEXT,
    p_series TEXT
)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE upper(btrim(COALESCE(p_code, '')))
        WHEN 'SMA' THEN 'period=20,series=' || p_series
        WHEN 'EMA' THEN 'period=20,series=' || p_series
        WHEN 'WMA' THEN 'period=20,series=' || p_series
        WHEN 'HMA' THEN 'period=20,series=' || p_series
        WHEN 'ZLEMA' THEN 'period=20,series=' || p_series
        WHEN 'MACD' THEN 'fast=12,slow=26,signal=9,series=' || p_series
        WHEN 'STOCH' THEN 'k=14,d=3,smooth=3,series=' || p_series
        WHEN 'ROC' THEN 'period=10,series=' || p_series
        WHEN 'BB' THEN 'period=20,std_dev=2,series=' || p_series
        WHEN 'KELTNER' THEN 'period=20,multiplier=2,atr_period=10,series=' || p_series
        WHEN 'DONCHIAN' THEN 'period=20,series=' || p_series
        ELSE 'period=20,series=' || p_series
    END;
$$;

COMMENT ON FUNCTION indicator_signal_default_params(TEXT, TEXT) IS
'Параметры по умолчанию для авто-формулы индикатора в тесте рейтинга (серия вынесена в series=)';

-- Из официального условия (indicators.sig_trend_def / sig_ct_def) выделяем ОДИН
-- ряд индикатора и приводим условие к виду, который понимает evaluate_signal_condition
-- (он подставляет только pp и VALUE). Двухрядные/неизвестные условия → VALUE vs 50.
CREATE OR REPLACE FUNCTION indicator_signal_series_and_condition(
    p_indicator_id INTEGER,
    p_kind TEXT
)
RETURNS TABLE(series TEXT, condition TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_kind TEXT := CASE WHEN lower(COALESCE(p_kind, 'trend')) = 'counter' THEN 'counter' ELSE 'trend' END;
    v_def TEXT;
    v_tokens TEXT[];
    v_hits TEXT[];
    v_check TEXT;
BEGIN
    SELECT CASE v_kind
               WHEN 'counter' THEN COALESCE(NULLIF(btrim(i.sig_ct_def), ''), 'VALUE < 50')
               ELSE COALESCE(NULLIF(btrim(i.sig_trend_def), ''), 'VALUE > 50')
           END
    INTO v_def
    FROM indicators i
    WHERE i.id = p_indicator_id;

    v_def := COALESCE(NULLIF(btrim(v_def), ''),
                      CASE v_kind WHEN 'counter' THEN 'VALUE < 50' ELSE 'VALUE > 50' END);

    SELECT array_agg(upper(ivt.code) ORDER BY ivt.display_order, ivt.id)
    INTO v_tokens
    FROM indicator_value_types ivt
    WHERE ivt.indicator_id = p_indicator_id
      AND ivt.is_threshold = FALSE;

    SELECT array_agg(DISTINCT t)
    INTO v_hits
    FROM unnest(COALESCE(v_tokens, ARRAY[]::TEXT[])) AS t
    WHERE v_def ~ ('\y' || t || '\y');

    IF v_hits IS NOT NULL AND array_length(v_hits, 1) = 1 THEN
        series := v_hits[1];
        condition := regexp_replace(v_def, '\y' || v_hits[1] || '\y', 'VALUE', 'gi');
    ELSIF v_hits IS NOT NULL AND array_length(v_hits, 1) > 1 THEN
        series := v_hits[1];
        condition := CASE v_kind WHEN 'counter' THEN 'VALUE < 50' ELSE 'VALUE > 50' END;
    ELSE
        series := COALESCE(v_tokens[1], 'VALUE');
        condition := v_def;
    END IF;

    v_check := upper(condition);
    v_check := regexp_replace(v_check, '\yPP\y', '', 'g');
    v_check := regexp_replace(v_check, '\yVALUE\y', '', 'g');
    v_check := regexp_replace(v_check, '\y(AND|OR)\y', '', 'g');
    IF v_check ~ '[A-Z]' THEN
        condition := CASE v_kind WHEN 'counter' THEN 'VALUE < 50' ELSE 'VALUE > 50' END;
    END IF;

    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION indicator_signal_series_and_condition(INTEGER, TEXT) IS
'Ряд (series) и условие (VALUE/pp) для авто-сигнала теста; двухрядные условия → VALUE vs 50';

-- Готовая строка формулы вида @CODE(params,series=X) VALUE > 50 (диагностика/отладка).
CREATE OR REPLACE FUNCTION indicator_signal_formula(
    p_indicator_id INTEGER,
    p_kind TEXT
)
RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_code TEXT;
    v_series TEXT;
    v_condition TEXT;
BEGIN
    SELECT i.code INTO v_code FROM indicators i WHERE i.id = p_indicator_id;
    IF v_code IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT f.series, f.condition INTO v_series, v_condition
    FROM indicator_signal_series_and_condition(p_indicator_id, p_kind) f;

    RETURN '@' || v_code || '(' || indicator_signal_default_params(v_code, v_series) || ') ' || v_condition;
END;
$$;

COMMENT ON FUNCTION indicator_signal_formula(INTEGER, TEXT) IS
'Готовая строка авто-формулы теста рейтинга индикатора (диагностика/отладка)';

-- Разбор простого условия вида «pp <op> VALUE» (или «VALUE <op> pp») один раз,
-- чтобы в тяжёлом цикле не вызывать evaluate_signal_condition на каждую свечу.
CREATE OR REPLACE FUNCTION indicator_simple_condition(p_condition TEXT)
RETURNS TABLE(is_simple BOOLEAN, op TEXT, pp_left BOOLEAN)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    m TEXT[];
BEGIN
    m := regexp_match(
        upper(btrim(COALESCE(p_condition, ''))),
        '^(PP|VALUE)\s*(>=|<=|<>|!=|>|<|=)\s*(PP|VALUE)$'
    );

    IF m IS NULL OR m[1] = m[3] THEN
        is_simple := FALSE; op := NULL; pp_left := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    is_simple := TRUE;
    op := CASE m[2] WHEN '!=' THEN '<>' ELSE m[2] END;
    pp_left := (m[1] = 'PP');
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION indicator_simple_condition(TEXT) IS
'Разбор простого условия «pp <op> VALUE» для инлайна в тесте рейтинга (is_simple, op, pp_left)';

-- Основной расчёт. Возвращает число обработанных индикаторов.
-- p_logic_id IS NULL — юниверс пар из всех логик (полный прогон); если логик нет —
--   откат к бумагам с недавними свечами (любой активный ТФ), чтобы считать всегда.
-- p_logic_id задан — только пары этой логики (событийный пересчёт после неё).
DROP FUNCTION IF EXISTS run_indicator_rating_test(INTEGER, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS run_indicator_rating_test(INTEGER, INTEGER, INTEGER, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS run_indicator_rating_test(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, NUMERIC);
CREATE OR REPLACE FUNCTION run_indicator_rating_test(
    p_max_indicators INTEGER DEFAULT 200,
    p_max_securities INTEGER DEFAULT 200,
    p_max_bars INTEGER DEFAULT 500,
    p_bars_window INTEGER DEFAULT 5000,
    p_min_signals INTEGER DEFAULT 5,
    p_max_annual_pct NUMERIC DEFAULT 1000,
    p_logic_id INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_now TIMESTAMP := LOCALTIMESTAMP;
    v_ind RECORD;
    v_pair RECORD;
    v_series_t TEXT;
    v_cond_t TEXT;
    v_series_c TEXT;
    v_cond_c TEXT;
    v_simple_t BOOLEAN;
    v_op_t TEXT;
    v_ppleft_t BOOLEAN;
    v_simple_c BOOLEAN;
    v_op_c TEXT;
    v_ppleft_c BOOLEAN;
    v_vt_t INTEGER;
    v_vt_c INTEGER;
    v_expr_t TEXT;
    v_expr_c TEXT;
    v_cap_sql TEXT;
    v_sql TEXT;
    v_processed INTEGER := 0;
    v_bars INTEGER := GREATEST(50, COALESCE(p_max_bars, 500));
    v_window INTEGER := GREATEST(50, COALESCE(p_bars_window, 5000));
    v_min_signals INTEGER := GREATEST(1, COALESCE(p_min_signals, 5));
    v_cap NUMERIC := p_max_annual_pct;
    v_year NUMERIC := 365.25 * 24 * 3600;
    v_slices INTEGER;
    v_samples INTEGER;
    v_rating NUMERIC;
    v_avg_all NUMERIC;
    v_best_side TEXT;
    v_best_kind TEXT;
    v_best_time TEXT;
    v_pb INTEGER;
    v_pf TIMESTAMP;
    v_pt TIMESTAMP;
    v_tf INTEGER;
    v_tf_slices INTEGER;
    v_tf_samples INTEGER;
    v_tf_rating NUMERIC;
    v_tf_avg NUMERIC;
    v_tf_side TEXT;
    v_tf_kind TEXT;
    v_tf_time TEXT;
BEGIN
    -- сэмплы живут сутки (как прочие диагностические записи)
    DELETE FROM indicator_rating_sample
    WHERE computed_at < CURRENT_TIMESTAMP - INTERVAL '24 hours';

    v_cap_sql := CASE WHEN v_cap IS NULL THEN 'NULL' ELSE v_cap::TEXT END;

    -- Юниверс пар (бумага × ТФ) считаем ОДИН раз. Источник — активные логики;
    -- если таких пар нет (нет включённых/сигнальных логик), откатываемся на
    -- бумаги, по которым недавно были свечи (любой активный ТФ) — рейтинг
    -- считается всегда, без простоя машинного времени.
    DROP TABLE IF EXISTS irt_pairs;
    DROP TABLE IF EXISTS irt_window;
    CREATE TEMP TABLE irt_pairs (
        security_id INTEGER,
        tf INTEGER,
        logic_id INTEGER
    ) ON COMMIT DROP;
    CREATE TEMP TABLE irt_window (
        tf INTEGER PRIMARY KEY,
        bars INTEGER NOT NULL DEFAULT 0,
        from_dt TIMESTAMP,
        to_dt TIMESTAMP
    ) ON COMMIT DROP;

    INSERT INTO irt_pairs (security_id, tf, logic_id)
    SELECT ls.security_id, logic_resolve_timeframe_id(l.id), min(l.id)
    FROM logics l
    JOIN logic_securities ls ON ls.logic_id = l.id AND ls.is_active = TRUE
    WHERE p_logic_id IS NULL OR l.id = p_logic_id
    GROUP BY ls.security_id, logic_resolve_timeframe_id(l.id)
    HAVING logic_resolve_timeframe_id(l.id) IS NOT NULL
    ORDER BY ls.security_id, 2
    LIMIT GREATEST(1, COALESCE(p_max_securities, 200));

    IF p_logic_id IS NULL AND NOT EXISTS (SELECT 1 FROM irt_pairs) THEN
        INSERT INTO irt_pairs (security_id, tf, logic_id)
        SELECT p.security_id, p.timeframe_id, NULL
        FROM prices p
        JOIN timeframes tf ON tf.id = p.timeframe_id AND COALESCE(tf.is_active, TRUE)
        WHERE p.close_price > 0
          AND p.dt >= CURRENT_TIMESTAMP - INTERVAL '3 days'
        GROUP BY p.security_id, p.timeframe_id
        ORDER BY count(*) DESC
        LIMIT GREATEST(1, COALESCE(p_max_securities, 200));
    END IF;

    -- Рейтингуем ВСЕ вычислимые индикаторы (в т.ч. задействованные сигналами
    -- логик): сигнальная/исследовательская логика не «расходует» индикатор.
    FOR v_ind IN
        SELECT i.id
        FROM indicators i
        WHERE COALESCE(i.is_active, TRUE)
          AND (COALESCE(btrim(i.formula), '') <> '' OR COALESCE(btrim(i.script), '') <> '')
          AND EXISTS (
              SELECT 1 FROM indicator_value_types ivt
              WHERE ivt.indicator_id = i.id AND ivt.is_threshold = FALSE
          )
        ORDER BY i.id
        LIMIT GREATEST(1, COALESCE(p_max_indicators, 200))
    LOOP
        v_processed := v_processed + 1;

        SELECT f.series, f.condition INTO v_series_t, v_cond_t
        FROM indicator_signal_series_and_condition(v_ind.id, 'trend') f;
        SELECT f.series, f.condition INTO v_series_c, v_cond_c
        FROM indicator_signal_series_and_condition(v_ind.id, 'counter') f;

        SELECT s.is_simple, s.op, s.pp_left INTO v_simple_t, v_op_t, v_ppleft_t
        FROM indicator_simple_condition(v_cond_t) s;
        SELECT s.is_simple, s.op, s.pp_left INTO v_simple_c, v_op_c, v_ppleft_c
        FROM indicator_simple_condition(v_cond_c) s;

        v_vt_t := (SELECT ivt.id FROM indicator_value_types ivt
                   WHERE ivt.indicator_id = v_ind.id AND upper(ivt.code) = upper(v_series_t) LIMIT 1);
        v_vt_c := (SELECT ivt.id FROM indicator_value_types ivt
                   WHERE ivt.indicator_id = v_ind.id AND upper(ivt.code) = upper(v_series_c) LIMIT 1);

        -- условия проверки сигнала (простое сравнение — заинлайнено, иначе функция)
        v_expr_t := CASE WHEN v_simple_t
            THEN (CASE WHEN v_ppleft_t THEN '(b.close_price ' || v_op_t || ' b.tv)'
                       ELSE '(b.tv ' || v_op_t || ' b.close_price)' END)
            ELSE 'evaluate_signal_condition(' || quote_literal(v_cond_t) || ', b.close_price, b.tv)' END;
        v_expr_c := CASE WHEN v_simple_c
            THEN (CASE WHEN v_ppleft_c THEN '(b.close_price ' || v_op_c || ' b.cv)'
                       ELSE '(b.cv ' || v_op_c || ' b.close_price)' END)
            ELSE 'evaluate_signal_condition(' || quote_literal(v_cond_c) || ', b.close_price, b.cv)' END;

        FOR v_pair IN
            SELECT security_id, tf, logic_id FROM irt_pairs ORDER BY security_id, tf
        LOOP
            BEGIN
                -- Значения индикатора: один расчёт на пару (бумага × ТФ).
                CALL ensure_security_indicator_series(v_pair.security_id, v_ind.id);
                UPDATE security_indicator_series
                SET param_period = COALESCE(param_period, 20)
                WHERE security_id = v_pair.security_id
                  AND indicator_id = v_ind.id
                  AND param_period IS NULL;
                CALL sync_security_indicator_series_for_indicator(
                    v_pair.security_id, v_ind.id, v_pair.tf, NULL, v_bars, TRUE
                );

                -- Тяжёлый запрос собираем как динамический SQL с литералами: статический
                -- SQL в plpgsql планируется с параметрами и получает негодный план
                -- (в ~150 раз медленнее). Здесь значения инлайнятся в текст запроса.
                v_sql := format($sql$
INSERT INTO indicator_rating_sample (
    indicator_id, logic_id, security_id, timeframe_id,
    position_side, signal_kind, time_kind,
    signals_count, avg_annual_pct, best_annual_pct, computed_at
)
WITH tpl AS MATERIALIZED (
    SELECT day_of_week, time_from, time_to
    FROM logic_moex_equity_non_trading_template()
),
px_prices AS (
    SELECT p.dt, p.close_price, p.high_price, p.low_price, tf.sec AS tf_sec
    FROM prices p
    JOIN timeframes tf ON tf.id = p.timeframe_id
    WHERE p.security_id = %s AND p.timeframe_id = %s AND p.close_price > 0
    ORDER BY p.dt DESC
    LIMIT %s
),
px AS (
    SELECT pp.dt, pp.close_price, pp.high_price, pp.low_price, pp.tf_sec,
           iv1.value AS tv, iv2.value AS cv
    FROM px_prices pp
    LEFT JOIN indicator_values iv1
      ON iv1.security_id = %s AND iv1.timeframe_id = %s AND iv1.dt = pp.dt
     AND iv1.indicator_id = %s AND iv1.indicator_value_type_id = %s
    LEFT JOIN indicator_values iv2
      ON iv2.security_id = %s AND iv2.timeframe_id = %s AND iv2.dt = pp.dt
     AND iv2.indicator_id = %s AND iv2.indicator_value_type_id = %s
),
bars AS (
    SELECT dt, close_price, tf_sec, tv, cv, fut_hi, fut_lo,
        CASE WHEN high_price >= fut_hi THEN dt END AS hi_rec,
        CASE WHEN low_price  <= fut_lo THEN dt END AS lo_rec
    FROM (
        -- ВАЖНО: кадр «1 FOLLOWING .. UNBOUNDED FOLLOWING» в PG считается O(n^2)
        -- и вешает запрос. Берём эквивалент в обратном порядке: строго будущие
        -- свечи = строки с dt больше текущей = предшествующие в порядке dt DESC.
        SELECT dt, close_price, high_price, low_price, tf_sec, tv, cv,
            max(high_price) OVER wf AS fut_hi,
            min(low_price)  OVER wf AS fut_lo
        FROM px
        WINDOW wf AS (ORDER BY dt DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
    ) w
),
bars2 AS (
    SELECT dt, close_price, tf_sec, tv, cv, fut_hi, fut_lo,
        min(hi_rec) OVER (ORDER BY dt DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS hi_dt,
        min(lo_rec) OVER (ORDER BY dt DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS lo_dt
    FROM bars
),
base0 AS (
    SELECT
        CASE WHEN extract(isodow FROM b.dt) >= 6 AND b.nontrade THEN 'weekend_nontrade'
             WHEN extract(isodow FROM b.dt) >= 6 THEN 'weekend_trade'
             WHEN b.nontrade THEN 'workday_nontrade'
             ELSE 'workday_trade' END AS time_kind,
        CASE WHEN b.tv IS NULL THEN FALSE ELSE %s END AS is_trend,
        CASE WHEN b.cv IS NULL THEN FALSE ELSE %s END AS is_counter,
        CASE WHEN b.hi_dt IS NULL THEN NULL
             ELSE (b.fut_hi - b.close_price) / b.close_price * 100
                  * (%s / GREATEST(EXTRACT(EPOCH FROM (b.hi_dt - b.dt)), b.tf_sec)) END AS up_raw,
        CASE WHEN b.lo_dt IS NULL THEN NULL
             ELSE (b.close_price - b.fut_lo) / b.close_price * 100
                  * (%s / GREATEST(EXTRACT(EPOCH FROM (b.lo_dt - b.dt)), b.tf_sec)) END AS down_raw
    FROM (
        SELECT b.*,
               EXISTS (SELECT 1 FROM tpl t
                       WHERE t.day_of_week = extract(isodow FROM b.dt)
                         AND b.dt::time BETWEEN t.time_from AND t.time_to) AS nontrade
        FROM bars2 b
    ) b
    WHERE b.hi_dt IS NOT NULL OR b.lo_dt IS NOT NULL
),
base AS (
    SELECT
        time_kind, is_trend, is_counter,
        CASE WHEN %s IS NULL THEN up_raw
             ELSE least(greatest(up_raw, -abs(%s)), abs(%s)) END AS gain_long,
        CASE WHEN %s IS NULL THEN down_raw
             ELSE least(greatest(down_raw, -abs(%s)), abs(%s)) END AS gain_short
    FROM base0
),
agg AS (
    SELECT
        time_kind,
        count(*) FILTER (WHERE is_trend AND gain_long IS NOT NULL)::INTEGER AS tl_n,
        avg(gain_long) FILTER (WHERE is_trend) AS tl_avg,
        max(gain_long) FILTER (WHERE is_trend) AS tl_max,
        count(*) FILTER (WHERE is_trend AND gain_short IS NOT NULL)::INTEGER AS ts_n,
        avg(gain_short) FILTER (WHERE is_trend) AS ts_avg,
        max(gain_short) FILTER (WHERE is_trend) AS ts_max,
        count(*) FILTER (WHERE is_counter AND gain_long IS NOT NULL)::INTEGER AS cl_n,
        avg(gain_long) FILTER (WHERE is_counter) AS cl_avg,
        max(gain_long) FILTER (WHERE is_counter) AS cl_max,
        count(*) FILTER (WHERE is_counter AND gain_short IS NOT NULL)::INTEGER AS cs_n,
        avg(gain_short) FILTER (WHERE is_counter) AS cs_avg,
        max(gain_short) FILTER (WHERE is_counter) AS cs_max
    FROM base
    GROUP BY time_kind
)
SELECT %s, %s, %s, %s, s.position_side, s.signal_kind, s.time_kind,
       s.signals_count, s.avg_annual_pct, s.best_annual_pct, %s
FROM (
    SELECT time_kind, 'long'  AS position_side, 'trend'   AS signal_kind,
           tl_n AS signals_count, tl_avg AS avg_annual_pct, tl_max AS best_annual_pct
    FROM agg WHERE tl_n >= %s
    UNION ALL
    SELECT time_kind, 'short', 'trend', ts_n, ts_avg, ts_max FROM agg WHERE ts_n >= %s
    UNION ALL
    SELECT time_kind, 'long',  'counter', cl_n, cl_avg, cl_max FROM agg WHERE cl_n >= %s
    UNION ALL
    SELECT time_kind, 'short', 'counter', cs_n, cs_avg, cs_max FROM agg WHERE cs_n >= %s
) s
ON CONFLICT (indicator_id, security_id, timeframe_id, position_side, signal_kind, time_kind)
DO UPDATE SET
    logic_id = EXCLUDED.logic_id,
    signals_count = EXCLUDED.signals_count,
    avg_annual_pct = EXCLUDED.avg_annual_pct,
    best_annual_pct = EXCLUDED.best_annual_pct,
    computed_at = EXCLUDED.computed_at
$sql$,
                    v_pair.security_id::TEXT, v_pair.tf::TEXT, v_window::TEXT,
                    v_pair.security_id::TEXT, v_pair.tf::TEXT, v_ind.id::TEXT, COALESCE(v_vt_t::TEXT, 'NULL'),
                    v_pair.security_id::TEXT, v_pair.tf::TEXT, v_ind.id::TEXT, COALESCE(v_vt_c::TEXT, 'NULL'),
                    v_expr_t, v_expr_c, v_year::TEXT, v_year::TEXT,
                    v_cap_sql, v_cap_sql, v_cap_sql,
                    v_cap_sql, v_cap_sql, v_cap_sql,
                    v_ind.id::TEXT, COALESCE(v_pair.logic_id::TEXT, 'NULL'),
                    v_pair.security_id::TEXT, v_pair.tf::TEXT, quote_literal(v_now::TEXT),
                    v_min_signals::TEXT, v_min_signals::TEXT, v_min_signals::TEXT, v_min_signals::TEXT
                );
                EXECUTE v_sql;

                -- Окно свечей пары (для статистики разворота строки): сколько
                -- последних свечей ТФ реально взято в расчёт и по каким датам.
                SELECT count(*)::INTEGER, min(dt), max(dt)
                INTO v_pb, v_pf, v_pt
                FROM (
                    SELECT p.dt
                    FROM prices p
                    WHERE p.security_id = v_pair.security_id
                      AND p.timeframe_id = v_pair.tf
                      AND p.close_price > 0
                    ORDER BY p.dt DESC
                    LIMIT v_window
                ) z;

                INSERT INTO irt_window (tf, bars, from_dt, to_dt)
                VALUES (v_pair.tf, COALESCE(v_pb, 0), v_pf, v_pt)
                ON CONFLICT (tf) DO UPDATE SET
                    bars = GREATEST(irt_window.bars, EXCLUDED.bars),
                    from_dt = LEAST(irt_window.from_dt, EXCLUDED.from_dt),
                    to_dt = GREATEST(irt_window.to_dt, EXCLUDED.to_dt);
            EXCEPTION WHEN OTHERS THEN
                CONTINUE;
            END;
        END LOOP;

        -- Агрегат по индикатору: разрез = сторона × тип сигнала × тип времени,
        -- усреднение по бумагам; рейтинг = максимум среднего % годовых.
        SELECT
            count(*)::INTEGER,
            COALESCE(sum(signals_count), 0)::INTEGER,
            max(slice_avg),
            sum(slice_avg * signals_count) / NULLIF(sum(signals_count), 0)
        INTO v_slices, v_samples, v_rating, v_avg_all
        FROM (
            SELECT position_side, signal_kind, time_kind,
                   avg(avg_annual_pct) AS slice_avg,
                   sum(signals_count) AS signals_count
            FROM indicator_rating_sample
            WHERE indicator_id = v_ind.id AND computed_at = v_now
            GROUP BY position_side, signal_kind, time_kind
        ) g;

        IF v_rating IS NOT NULL THEN
            SELECT position_side, signal_kind, time_kind
            INTO v_best_side, v_best_kind, v_best_time
            FROM (
                SELECT position_side, signal_kind, time_kind,
                       avg(avg_annual_pct) AS slice_avg
                FROM indicator_rating_sample
                WHERE indicator_id = v_ind.id AND computed_at = v_now
                GROUP BY position_side, signal_kind, time_kind
            ) g
            ORDER BY slice_avg DESC NULLS LAST
            LIMIT 1;

            INSERT INTO indicator_rating (
                indicator_id, rating, best_position_side, best_signal_kind, best_time_kind,
                slices_count, samples_count, avg_annual_pct, computed_at
            )
            VALUES (
                v_ind.id, v_rating, v_best_side, v_best_kind, v_best_time,
                v_slices, v_samples, v_avg_all, v_now
            )
            ON CONFLICT (indicator_id) DO UPDATE SET
                rating = EXCLUDED.rating,
                best_position_side = EXCLUDED.best_position_side,
                best_signal_kind = EXCLUDED.best_signal_kind,
                best_time_kind = EXCLUDED.best_time_kind,
                slices_count = EXCLUDED.slices_count,
                samples_count = EXCLUDED.samples_count,
                avg_annual_pct = EXCLUDED.avg_annual_pct,
                computed_at = EXCLUDED.computed_at;
        END IF;

        -- Рейтинг по каждому ТФ отдельно + окно свечей — для разворота строки
        -- индикатора в списке (какой ТФ, на скольких свечах, с какого по какое число).
        FOR v_tf IN
            SELECT DISTINCT s.timeframe_id
            FROM indicator_rating_sample s
            WHERE s.indicator_id = v_ind.id AND s.computed_at = v_now
        LOOP
            SELECT
                count(*)::INTEGER,
                COALESCE(sum(signals_count), 0)::INTEGER,
                max(slice_avg),
                sum(slice_avg * signals_count) / NULLIF(sum(signals_count), 0)
            INTO v_tf_slices, v_tf_samples, v_tf_rating, v_tf_avg
            FROM (
                SELECT position_side, signal_kind, time_kind,
                       avg(avg_annual_pct) AS slice_avg,
                       sum(signals_count) AS signals_count
                FROM indicator_rating_sample
                WHERE indicator_id = v_ind.id AND timeframe_id = v_tf AND computed_at = v_now
                GROUP BY position_side, signal_kind, time_kind
            ) g;

            IF v_tf_rating IS NOT NULL THEN
                SELECT position_side, signal_kind, time_kind
                INTO v_tf_side, v_tf_kind, v_tf_time
                FROM (
                    SELECT position_side, signal_kind, time_kind,
                           avg(avg_annual_pct) AS slice_avg
                    FROM indicator_rating_sample
                    WHERE indicator_id = v_ind.id AND timeframe_id = v_tf AND computed_at = v_now
                    GROUP BY position_side, signal_kind, time_kind
                ) g
                ORDER BY slice_avg DESC NULLS LAST
                LIMIT 1;

                INSERT INTO indicator_rating_timeframe (
                    indicator_id, timeframe_id, rating, best_position_side, best_signal_kind,
                    best_time_kind, slices_count, samples_count, avg_annual_pct,
                    bars_count, bars_from, bars_to, computed_at
                )
                SELECT v_ind.id, v_tf, v_tf_rating, v_tf_side, v_tf_kind, v_tf_time,
                       v_tf_slices, v_tf_samples, v_tf_avg,
                       COALESCE(w.bars, 0), w.from_dt, w.to_dt, v_now
                FROM (SELECT 1) one
                LEFT JOIN irt_window w ON w.tf = v_tf
                ON CONFLICT (indicator_id, timeframe_id) DO UPDATE SET
                    rating = EXCLUDED.rating,
                    best_position_side = EXCLUDED.best_position_side,
                    best_signal_kind = EXCLUDED.best_signal_kind,
                    best_time_kind = EXCLUDED.best_time_kind,
                    slices_count = EXCLUDED.slices_count,
                    samples_count = EXCLUDED.samples_count,
                    avg_annual_pct = EXCLUDED.avg_annual_pct,
                    bars_count = EXCLUDED.bars_count,
                    bars_from = EXCLUDED.bars_from,
                    bars_to = EXCLUDED.bars_to,
                    computed_at = EXCLUDED.computed_at;
            END IF;
        END LOOP;

        -- #1006: универсум бумаг, по которым реально посчитан рейтинг (переживает
        -- очистку indicator_rating_sample). Питает создание логики из лучших рейтингов.
        INSERT INTO indicator_rating_universe (
            indicator_id, timeframe_id, security_id, logic_id, signals_count, computed_at
        )
        SELECT s.indicator_id, s.timeframe_id, s.security_id,
               min(s.logic_id), sum(s.signals_count), v_now
        FROM indicator_rating_sample s
        WHERE s.indicator_id = v_ind.id AND s.computed_at = v_now
        GROUP BY s.indicator_id, s.timeframe_id, s.security_id
        ON CONFLICT (indicator_id, timeframe_id, security_id) DO UPDATE SET
            logic_id = EXCLUDED.logic_id,
            signals_count = EXCLUDED.signals_count,
            computed_at = EXCLUDED.computed_at;
    END LOOP;

    RETURN v_processed;
END;
$$;

COMMENT ON FUNCTION run_indicator_rating_test(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, NUMERIC, INTEGER) IS
'Тест вычислимых индикаторов: лучший ход до крайней точки среди загруженных будущих свечей, % годовых по времени удержания, порог сигналов и обрезка выбросов; p_logic_id — юниверс пар одной логики (NULL — все логики; если логик нет — откат к бумагам с недавними свечами, любой активный ТФ, чтобы считать без простоя); наполняет indicator_rating_sample / indicator_rating / indicator_rating_timeframe (рейтинг в разрезе ТФ + окно свечей) / indicator_rating_universe (бумаги расчёта)';

-- Безопасная обёртка для фонового вызова: троттл + advisory lock + глушение ошибок.
-- Возврат: 1 — считалось, 0 — пропущено (троттл/занято), -1 — ошибка (записана в indicator_rating_run).
CREATE OR REPLACE FUNCTION run_indicator_rating_test_safe(
    p_min_interval_minutes INTEGER DEFAULT 180
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_lock BIGINT := hashtext('indicator_rating_test');
BEGIN
    IF EXISTS (
        SELECT 1 FROM indicator_rating_run
        WHERE id = TRUE
          AND last_run_at > CURRENT_TIMESTAMP - make_interval(mins => GREATEST(1, COALESCE(p_min_interval_minutes, 180)))
    ) THEN
        RETURN 0;
    END IF;

    IF NOT pg_try_advisory_lock(v_lock) THEN
        RETURN 0;
    END IF;

    BEGIN
        PERFORM run_indicator_rating_test();
        INSERT INTO indicator_rating_run (id, last_run_at, last_status, last_message, updated_at)
        VALUES (TRUE, CURRENT_TIMESTAMP, 1, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
            last_run_at = EXCLUDED.last_run_at,
            last_status = EXCLUDED.last_status,
            last_message = NULL,
            updated_at = EXCLUDED.updated_at;
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO indicator_rating_run (id, last_run_at, last_status, last_message, updated_at)
        VALUES (TRUE, CURRENT_TIMESTAMP, -1, SQLERRM, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
            last_run_at = EXCLUDED.last_run_at,
            last_status = EXCLUDED.last_status,
            last_message = EXCLUDED.last_message,
            updated_at = EXCLUDED.updated_at;
        PERFORM pg_advisory_unlock(v_lock);
        RETURN -1;
    END;

    PERFORM pg_advisory_unlock(v_lock);
    RETURN 1;
END;
$$;

COMMENT ON FUNCTION run_indicator_rating_test_safe(INTEGER) IS
'Фоновый вызов теста рейтинга индикаторов: троттл, advisory lock, глушение ошибок; 1/0/-1';

-- Событийный пересчёт после работы конкретной логики: юниверс = её пары
-- (бумага × ТФ). Троттл — по логике (indicator_rating_logic_run); advisory lock
-- общий с полным прогоном, чтобы тяжёлые расчёты не шли одновременно.
-- Возврат: 1 — считалось, 0 — пропущено (троттл/занято/нет логики), -1 — ошибка.
CREATE OR REPLACE FUNCTION run_indicator_rating_for_logic_safe(
    p_logic_id INTEGER,
    p_min_interval_minutes INTEGER DEFAULT 60
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_lock BIGINT := hashtext('indicator_rating_test');
BEGIN
    IF p_logic_id IS NULL THEN
        RETURN 0;
    END IF;

    IF EXISTS (
        SELECT 1 FROM indicator_rating_logic_run
        WHERE logic_id = p_logic_id
          AND last_run_at > CURRENT_TIMESTAMP - make_interval(mins => GREATEST(1, COALESCE(p_min_interval_minutes, 60)))
    ) THEN
        RETURN 0;
    END IF;

    IF NOT pg_try_advisory_lock(v_lock) THEN
        RETURN 0;
    END IF;

    BEGIN
        PERFORM run_indicator_rating_test(p_logic_id => p_logic_id);
        INSERT INTO indicator_rating_logic_run (logic_id, last_run_at, last_status, last_message, updated_at)
        VALUES (p_logic_id, CURRENT_TIMESTAMP, 1, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT (logic_id) DO UPDATE SET
            last_run_at = EXCLUDED.last_run_at,
            last_status = EXCLUDED.last_status,
            last_message = NULL,
            updated_at = EXCLUDED.updated_at;
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO indicator_rating_logic_run (logic_id, last_run_at, last_status, last_message, updated_at)
        VALUES (p_logic_id, CURRENT_TIMESTAMP, -1, SQLERRM, CURRENT_TIMESTAMP)
        ON CONFLICT (logic_id) DO UPDATE SET
            last_run_at = EXCLUDED.last_run_at,
            last_status = EXCLUDED.last_status,
            last_message = EXCLUDED.last_message,
            updated_at = EXCLUDED.updated_at;
        PERFORM pg_advisory_unlock(v_lock);
        RETURN -1;
    END;

    PERFORM pg_advisory_unlock(v_lock);
    RETURN 1;
END;
$$;

COMMENT ON FUNCTION run_indicator_rating_for_logic_safe(INTEGER, INTEGER) IS
'Событийный пересчёт рейтинга индикаторов по юниверсу одной логики после её работы: '
'троттл по логике + общий advisory lock с полным прогоном; 1/0/-1';
