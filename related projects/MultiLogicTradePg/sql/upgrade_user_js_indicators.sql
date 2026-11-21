-- Пользовательские (JS) индикаторы: хранение кода и типа вычисления.
-- Идемпотентно: безопасно для повторного применения.
-- Добавляет indicators.js_code, indicators.calc_kind и нормализует значения.

DO $upgrade_user_js_indicators$
BEGIN
    IF to_regclass('public.indicators') IS NOT NULL THEN
        ALTER TABLE indicators ADD COLUMN IF NOT EXISTS js_code TEXT;
        ALTER TABLE indicators ADD COLUMN IF NOT EXISTS calc_kind VARCHAR(20);

        UPDATE indicators
        SET calc_kind = CASE
            WHEN COALESCE(NULLIF(btrim(js_code), ''), NULL) IS NOT NULL THEN 'js'
            WHEN COALESCE(is_custom, FALSE) = TRUE AND COALESCE(NULLIF(btrim(formula), ''), NULL) IS NOT NULL THEN 'poly_formula'
            WHEN COALESCE(NULLIF(btrim(script), ''), NULL) IS NOT NULL AND COALESCE(NULLIF(btrim(formula), ''), NULL) IS NULL THEN 'sql_script'
            ELSE 'poly_formula'
        END
        WHERE calc_kind IS NULL OR btrim(calc_kind) = '';

        ALTER TABLE indicators ALTER COLUMN calc_kind SET DEFAULT 'poly_formula';

        BEGIN
            ALTER TABLE indicators ALTER COLUMN calc_kind SET NOT NULL;
        EXCEPTION WHEN others THEN
            NULL;
        END;
    END IF;
END
$upgrade_user_js_indicators$;

COMMENT ON COLUMN indicators.js_code IS
'Пользовательский JS-код (calc_kind=js): function calc(ctx, params) { ... } -> number|null (серия VALUE).';

COMMENT ON COLUMN indicators.calc_kind IS
'Способ вычисления: poly_formula | sql_script | js.';
