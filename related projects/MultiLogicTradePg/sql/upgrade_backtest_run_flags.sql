-- Идемпотентный апгрейд: колонки logic_backtest_runs, добавленные в #1061/#1072.
-- Нужен для install-on-top/upgrade на удалённом сервере, где 01 мог быть старым
-- или апгрейд применялся не полностью. Безопасно запускать повторно.

DO $upgrade_backtest_run_flags$
BEGIN
    IF to_regclass('public.logic_backtest_runs') IS NOT NULL THEN
        ALTER TABLE logic_backtest_runs
            ADD COLUMN IF NOT EXISTS close_all_at_end BOOLEAN NOT NULL DEFAULT TRUE;
        COMMENT ON COLUMN logic_backtest_runs.close_all_at_end IS
            '#1061: последним актом теста закрыть все открытые позиции (галочка в диалоге запуска, default TRUE)';

        ALTER TABLE logic_backtest_runs
            ADD COLUMN IF NOT EXISTS portfolio_close_pending BOOLEAN NOT NULL DEFAULT FALSE;
        COMMENT ON COLUMN logic_backtest_runs.portfolio_close_pending IS
            '#1072: отложенное закрытие портфельных позиций в бэктесте (ожидание бара/условия)';
    END IF;
END
$upgrade_backtest_run_flags$;
