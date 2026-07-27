ALTER TABLE logic_trades ADD COLUMN IF NOT EXISTS opt_lane TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_logic_trades_signal_bar_book;
CREATE UNIQUE INDEX IF NOT EXISTS idx_logic_trades_signal_bar_book
    ON logic_trades (logic_id, security_id, position_event, action_id, bar_dt, is_test, is_shadow, opt_lane);
CREATE INDEX IF NOT EXISTS idx_logic_trades_opt_lane ON logic_trades(logic_id, opt_lane)
    WHERE opt_lane <> '';

INSERT INTO logic_param_defs (param_key, name_ru, value_type, default_value, description, display_order) VALUES
    ('opt_eval_candles', 'Свечей окна OPT', 'integer', '200',
     'Через сколько закрытых свечей TF сравнить FinRes чемпиона и OPT-веток и подставить лучшие значения в формулы', 19),
    ('last_opt_eval_bar_dt', 'Последняя оценка OPT', 'text', '',
     'Служебный: open time свечи TF последней смены OPT-параметров', 95)
ON CONFLICT (param_key) DO UPDATE SET
    name_ru = EXCLUDED.name_ru,
    value_type = EXCLUDED.value_type,
    default_value = EXCLUDED.default_value,
    description = EXCLUDED.description,
    display_order = EXCLUDED.display_order;
