/**
 * Shared SELECT fragments for logic_trades list / export / mid-run panel.
 * Kept out of route modules so trades.js and logics.js can both use them.
 */

const LOGIC_TRADE_SELECT = `
  SELECT
    lt.id,
    lt.logic_id,
    lt.account_id,
    lt.security_id,
    lt.timeframe_id,
    lt.side_id,
    lt.action_id,
    lt.signal_kind,
    lt.signal_formula,
    lt.quantity,
    lt.price,
    to_char(lt.bar_dt, 'YYYY-MM-DD HH24:MI:SS') AS bar_dt,
    to_char(lt.executed_at, 'YYYY-MM-DD HH24:MI:SS') AS executed_at,
    lt.is_simulated,
    lt.is_fictitious,
    lt.is_shadow,
    lt.is_test,
    lt.run_id,
    lt.trade_reason,
    lt.broker_order_id,
    lt.status,
    lt.commission,
    lt.financial_result,
    lt.note,
    COALESCE(lt.opt_lane, '') AS opt_lane,
    lt.created_at,
    CASE
      WHEN sd.name = 'Open' AND lt.status IN ('filled', 'submitted')
        THEN logic_trade_open_remaining_qty(lt.id)
      ELSE NULL
    END AS remaining_qty,
    s.name AS security_name,
    sp.prefix AS security_prefix,
    sd.name AS side_name,
    ac.name AS action_name,
    tf.tf AS timeframe_tf
  FROM logic_trades lt
  JOIN securities s ON s.id = lt.security_id
  LEFT JOIN LATERAL (
    SELECT prefix FROM security_prefixes WHERE security_id = s.id ORDER BY exchange_id LIMIT 1
  ) sp ON TRUE
  JOIN sides sd ON sd.id = lt.side_id
  JOIN actions ac ON ac.id = lt.action_id
  JOIN timeframes tf ON tf.id = lt.timeframe_id
`;

/**
 * Mid-run Testing panel: same columns as LOGIC_TRADE_SELECT, but remaining_qty is
 * one set-based join on logic_trade_lots (not per-row logic_trade_open_remaining_qty).
 */
const LOGIC_TRADE_SELECT_TEST_PANEL = `
  SELECT
    lt.id,
    lt.logic_id,
    lt.account_id,
    lt.security_id,
    lt.timeframe_id,
    lt.side_id,
    lt.action_id,
    lt.signal_kind,
    lt.signal_formula,
    lt.quantity,
    lt.price,
    to_char(lt.bar_dt, 'YYYY-MM-DD HH24:MI:SS') AS bar_dt,
    to_char(lt.executed_at, 'YYYY-MM-DD HH24:MI:SS') AS executed_at,
    lt.is_simulated,
    lt.is_fictitious,
    lt.is_shadow,
    lt.is_test,
    lt.run_id,
    lt.trade_reason,
    lt.broker_order_id,
    lt.status,
    lt.commission,
    lt.financial_result,
    lt.note,
    COALESCE(lt.opt_lane, '') AS opt_lane,
    lt.created_at,
    CASE
      WHEN sd.name = 'Open' AND lt.status IN ('filled', 'submitted')
        THEN (lt.quantity - COALESCE(lot.closed_qty, 0))
      ELSE NULL
    END AS remaining_qty,
    s.name AS security_name,
    sp.prefix AS security_prefix,
    sd.name AS side_name,
    ac.name AS action_name,
    tf.tf AS timeframe_tf
  FROM logic_trades lt
  JOIN securities s ON s.id = lt.security_id
  LEFT JOIN LATERAL (
    SELECT prefix FROM security_prefixes WHERE security_id = s.id ORDER BY exchange_id LIMIT 1
  ) sp ON TRUE
  JOIN sides sd ON sd.id = lt.side_id
  JOIN actions ac ON ac.id = lt.action_id
  JOIN timeframes tf ON tf.id = lt.timeframe_id
  LEFT JOIN (
    SELECT open_trade_id, SUM(quantity) AS closed_qty
    FROM logic_trade_lots
    WHERE logic_id = $1
    GROUP BY open_trade_id
  ) lot ON lot.open_trade_id = lt.id
`;

module.exports = {
  LOGIC_TRADE_SELECT,
  LOGIC_TRADE_SELECT_TEST_PANEL,
};
