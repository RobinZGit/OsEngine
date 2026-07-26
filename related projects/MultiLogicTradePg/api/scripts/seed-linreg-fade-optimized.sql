INSERT INTO logics (name, account_id, is_enabled, note)
SELECT
    'LinReg Fade Optimized',
    a.id,
    FALSE,
    'Like LinReg Fade with OPT(std_dev,10) on-the-fly optimization.'
FROM accounts a
JOIN brokers b ON b.id = a.broker_id
WHERE b.code = 'T-BANK' AND a.account_code = 'FAKE-EFF-001'
ON CONFLICT (name) DO NOTHING;

INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
SELECT l.id, d.param_key, d.default_value, d.value_type
FROM logics l
CROSS JOIN logic_param_defs d
WHERE l.name = 'LinReg Fade Optimized'
ON CONFLICT (logic_id, param_key) DO NOTHING;

UPDATE logic_params lp
SET param_value = '20', value_type = 'integer'
FROM logics l
WHERE l.id = lp.logic_id
  AND l.name = 'LinReg Fade Optimized'
  AND lp.param_key = 'opt_eval_candles';

-- Empty initial_balance → backtest cash=0 → zero opens
UPDATE logic_params lp
SET param_value = '1000000', value_type = 'money', updated_at = CURRENT_TIMESTAMP
FROM logics l
WHERE l.id = lp.logic_id
  AND l.name IN ('LinReg Fade Optimized', 'LinReg Fade Optimized copy')
  AND lp.param_key IN ('initial_balance', 'current_balance')
  AND btrim(COALESCE(lp.param_value, '')) = '';

INSERT INTO logic_indicator_signals (
    logic_id, indicator_id, position_event, position_side, signal_kind, formula, display_order
)
SELECT l.id, i.id, v.position_event, v.position_side, v.signal_kind, v.formula, v.display_order
FROM logics l
CROSS JOIN (VALUES
    ('LINREG', 'open',  'long',  'counter', '@LINREG(period=20,std_dev=2,series=LOWER,OPT(std_dev,10)) pp <= VALUE', 0),
    ('LINREG', 'close', 'long',  'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10)) pp >= VALUE', 1),
    ('LINREG', 'open',  'short', 'counter', '@LINREG(period=20,std_dev=2,series=UPPER,OPT(std_dev,10)) pp >= VALUE', 2),
    ('LINREG', 'close', 'short', 'trend',   '@LINREG(period=20,std_dev=2,series=MIDDLE,OPT(std_dev,10)) pp <= VALUE', 3)
) AS v(ind_code, position_event, position_side, signal_kind, formula, display_order)
JOIN indicators i ON i.code = v.ind_code
WHERE l.name = 'LinReg Fade Optimized'
  AND NOT EXISTS (SELECT 1 FROM logic_indicator_signals z WHERE z.logic_id = l.id);

-- Copy securities from LinReg Fade (if any) so the logic is ready to enable
INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
SELECT dst.id, ls.security_id, ls.display_order, ls.is_active
FROM logics src
JOIN logic_securities ls ON ls.logic_id = src.id
JOIN logics dst ON dst.name = 'LinReg Fade Optimized'
WHERE src.name = 'LinReg Fade'
ON CONFLICT (logic_id, security_id) DO UPDATE SET
    is_active = EXCLUDED.is_active,
    display_order = EXCLUDED.display_order;

-- Promote window: default 20 (editable in UI «Свечей окна OPT»)
UPDATE logic_params lp
SET param_value = '20', value_type = 'integer'
FROM logics l
WHERE l.id = lp.logic_id
  AND l.name IN ('LinReg Fade Optimized', 'LinReg Fade Optimized copy')
  AND lp.param_key = 'opt_eval_candles';

-- Same SL/TP as LinReg Fade (seed had signals/papers but forgot stops)
INSERT INTO logic_stops (logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active)
SELECT l.id, v.rule_kind, v.scope_type, v.value, v.value_unit, v.display_order, TRUE
FROM logics l
CROSS JOIN (VALUES
    ('stop_loss',   'security_resume', 1.0, 'percent', 0),
    ('take_profit', 'portfolio_ltp_renew', 5.0, 'percent', 1)
) AS v(rule_kind, scope_type, value, value_unit, display_order)
WHERE l.name IN ('LinReg Fade Optimized', 'LinReg Fade Optimized copy')
  AND NOT EXISTS (SELECT 1 FROM logic_stops z WHERE z.logic_id = l.id);
