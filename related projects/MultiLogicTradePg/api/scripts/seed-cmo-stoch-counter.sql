-- Контр-трендовая логика CMO (моментум Чанде) + Стохастик
-- Лонг на перепроданности: CMO<0 И %K<50; шорт на перекупленности: CMO>0 И %K>50.
-- Выход — на возврате к нулю/50. Те же 39 бумаг (акции+фонды), что у LinReg Fade Trend.
-- ВЕРСИЯ ПО УМОЛЧАНИЮ (включена): бэктест #368 ≈ +93 441₽ (12 045 сделок).
-- Торговые периоды: MOEX (12 неторговых окон + use_non_trading_periods=true).

INSERT INTO logics (name, account_id, is_enabled, note)
SELECT
    'CMO Stoch Counter',
    a.id,
    TRUE,
    'Контр-тренд: CMO(14) + Стохастик %K(14,3,3). Лонг CMO<0 и K<50, шорт CMO>0 и K>50. Только акции и фонды. Версия по умолчанию (включена), торговые периоды MOEX.'
FROM accounts a
JOIN brokers b ON b.id = a.broker_id
WHERE b.code = 'T-BANK' AND a.account_code = 'FAKE-EFF-001'
ON CONFLICT (name) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
WHERE l.name = 'CMO Stoch Counter'
ON CONFLICT (logic_id, param_key) DO NOTHING;

-- Параметры как у LinReg Fade Trend (M15, 10%, до 15 позиций)
UPDATE logic_params lp
SET param_value = v.param_value, value_type = v.value_type
FROM logics l
CROSS JOIN (VALUES
    ('timeframe', 'M15', 'text'),
    ('stop_loss_timeframe', 'M5', 'text'),
    ('position_size_pct', '10', 'number'),
    ('max_open_positions', '15', 'integer'),
    ('base_annual_rate_pct', '20', 'number'),
    ('test_initial_balance', '1000000', 'money'),
    ('opt_eval_candles', '200', 'integer')
) AS v(param_key, param_value, value_type)
WHERE l.id = lp.logic_id
  AND l.name = 'CMO Stoch Counter'
  AND lp.param_key = v.param_key;

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('CMO',   'open',  'long',  'counter', '@CMO(period=14,series=VALUE) VALUE < 0',        0),
    ('STOCH', 'open',  'long',  'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE < 50', 1),
    ('CMO',   'close', 'long',  'counter', '@CMO(period=14,series=VALUE) VALUE > 0',        2),
    ('STOCH', 'close', 'long',  'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE > 50', 3),
    ('CMO',   'open',  'short', 'counter', '@CMO(period=14,series=VALUE) VALUE > 0',        4),
    ('STOCH', 'open',  'short', 'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE > 50', 5),
    ('CMO',   'close', 'short', 'counter', '@CMO(period=14,series=VALUE) VALUE < 0',        6),
    ('STOCH', 'close', 'short', 'counter', '@STOCH(k_period=14,d_period=3,smooth=3,series=K) VALUE < 50', 7)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'CMO Stoch Counter'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Те же бумаги, что у LinReg Fade Trend (все 40 без фьючерсов, кэш-фонд TMON не входит)
INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
SELECT dst.id, ls.security_id, ls.display_order, ls.is_active
FROM logics src
JOIN logic_securities ls ON ls.logic_id = src.id
JOIN logics dst ON dst.name = 'CMO Stoch Counter'
WHERE src.name = 'LinReg Fade Trend'
ON CONFLICT (logic_id, security_id) DO UPDATE SET
    is_active = EXCLUDED.is_active,
    display_order = EXCLUDED.display_order;

-- Стопы как у LinReg Fade Trend: SL 1% по бумаге, TP 5% портфеля (продление по возобновлению)
INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name = 'CMO Stoch Counter'
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);

-- Торговые периоды: MOEX по умолчанию (12 окон) + признак «учитывать неторговые периоды».
UPDATE logic_params lp
SET param_value = 'true', value_type = 'boolean', updated_at = CURRENT_TIMESTAMP
FROM logics l
WHERE l.id = lp.logic_id
  AND l.name = 'CMO Stoch Counter'
  AND lp.param_key = 'use_non_trading_periods';

SELECT logic_apply_moex_non_trading_periods(l.id) AS moex_intervals_applied
FROM logics l WHERE l.name = 'CMO Stoch Counter';

-- Активна (версия по умолчанию).
UPDATE logics SET is_enabled = TRUE WHERE name = 'CMO Stoch Counter';