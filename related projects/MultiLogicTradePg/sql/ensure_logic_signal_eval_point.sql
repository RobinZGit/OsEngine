-- Идемпотентный патч для удалённой БД: функция оценки точки сигнала по tf= параметру.
-- Нужна API-роутам portfolio-сигналов (api/routes/logics.js) и SQL-раннерам.
-- Требует хелперов из 02_multilogictrade_functions_and_procedures.sql:
--   parse_signal_formula, signal_param_value, signal_tf_parse_sec,
--   signal_tf_name_for_sec, signal_tf_id_for_sec.
-- Если их тоже нет — применяйте полный 02_multilogictrade_functions_and_procedures.sql.

CREATE OR REPLACE FUNCTION logic_signal_eval_point(
    p_formula TEXT,
    p_logic_tf_id INTEGER,
    p_logic_bar_dt TIMESTAMP
)
RETURNS TABLE (tf_id INTEGER, bar_dt TIMESTAMP)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_parsed RECORD;
    v_expr TEXT;
    v_logic_sec INTEGER;
    v_sig_sec INTEGER;
    v_limit_epoch DOUBLE PRECISION;
    v_n DOUBLE PRECISION;
BEGIN
    SELECT t.sec INTO v_logic_sec FROM timeframes t WHERE t.id = p_logic_tf_id;
    IF v_logic_sec IS NULL OR v_logic_sec < 60 THEN
        tf_id := p_logic_tf_id;
        bar_dt := p_logic_bar_dt;
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT * INTO v_parsed FROM parse_signal_formula(p_formula);
    v_expr := CASE WHEN COALESCE(v_parsed.valid, FALSE)
        THEN signal_param_value(v_parsed.params, 'tf')
        ELSE NULL END;

    v_sig_sec := signal_tf_parse_sec(v_expr);
    IF v_sig_sec IS NULL THEN
        tf_id := p_logic_tf_id;
        bar_dt := p_logic_bar_dt;
        RETURN NEXT;
        RETURN;
    END IF;

    tf_id := signal_tf_id_for_sec(v_sig_sec, p_logic_tf_id);

    v_limit_epoch := EXTRACT(EPOCH FROM (p_logic_bar_dt + make_interval(secs => v_logic_sec)));
    v_n := floor(v_limit_epoch / v_sig_sec);
    IF v_n < 1 THEN
        tf_id := NULL;
        bar_dt := NULL;
        RETURN NEXT;
        RETURN;
    END IF;
    bar_dt := TIMESTAMP '1970-01-01 00:00:00'
        + make_interval(secs => ((v_n - 1) * v_sig_sec)::INTEGER);
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION logic_signal_eval_point(TEXT, INTEGER, TIMESTAMP) IS
'Точка оценки сигнала по его tf= параметру: (id ТФ, последний закрытый бар этого ТФ до close бара логики); NULL = данных ещё нет';
