/**
 * Export / import logics as a portable JSON bundle.
 * Includes: card, params, signals, stops, securities, last offline OPT grid.
 * Excludes: trades, candles, backtest runs, ratings history, runtime pause/invert/shadow.
 */

const { syncRealAccountBalancesIfNeeded } = require('./logic-params');

const FORMAT = 'multilogictrade.logic-bundle';
const VERSION = 2;

function uniqueLogicName(client, desiredName, suffixBase = 'import') {
  return (async () => {
    const { rows: hit } = await client.query(
      'SELECT 1 FROM logics WHERE name = $1 LIMIT 1',
      [desiredName]
    );
    if (hit.length === 0) return desiredName;
    const base = `${desiredName} ${suffixBase}`;
    let name = base;
    for (let i = 2; i <= 100; i += 1) {
      const { rows } = await client.query(
        'SELECT 1 FROM logics WHERE name = $1 LIMIT 1',
        [name]
      );
      if (rows.length === 0) return name;
      name = `${base} ${i}`;
    }
    return `${base} ${Date.now()}`;
  })();
}

function packLastOptGrid(row) {
  if (
    row.last_opt_grid_results == null ||
    !Array.isArray(row.last_opt_grid_results) ||
    row.last_opt_grid_results.length === 0
  ) {
    return null;
  }
  return {
    results: row.last_opt_grid_results,
    run_id: row.last_opt_grid_run_id != null ? Number(row.last_opt_grid_run_id) : null,
    at: row.last_opt_grid_at ? new Date(row.last_opt_grid_at).toISOString() : null,
  };
}

/**
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number[]} ids
 */
async function buildLogicBundle(db, ids) {
  const uniqueIds = [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) {
    const err = new Error('Укажите хотя бы одну логику для экспорта');
    err.status = 400;
    throw err;
  }

  const { rows: logicRows } = await db.query(
    `
    SELECT
      l.id,
      l.name,
      l.note,
      l.is_enabled,
      l.last_opt_grid_results,
      l.last_opt_grid_run_id,
      l.last_opt_grid_at,
      a.account_code,
      b.code AS broker_code
    FROM logics l
    JOIN accounts a ON a.id = l.account_id
    JOIN brokers b ON b.id = a.broker_id
    WHERE l.id = ANY($1::int[])
    ORDER BY l.id
    `,
    [uniqueIds]
  );

  if (logicRows.length === 0) {
    const err = new Error('Логики не найдены');
    err.status = 404;
    throw err;
  }

  const foundIds = logicRows.map((r) => r.id);
  const { rows: paramRows } = await db.query(
    `
    SELECT logic_id, param_key, param_value, value_type
    FROM logic_params
    WHERE logic_id = ANY($1::int[])
    ORDER BY logic_id, param_key
    `,
    [foundIds]
  );
  const { rows: signalRows } = await db.query(
    `
    SELECT
      lis.logic_id,
      i.code AS indicator_code,
      lis.position_event,
      lis.position_side,
      lis.signal_kind,
      COALESCE(lis.signal_acts_on, 'security') AS signal_acts_on,
      lis.formula,
      lis.display_order,
      lis.is_active
    FROM logic_indicator_signals lis
    JOIN indicators i ON i.id = lis.indicator_id
    WHERE lis.logic_id = ANY($1::int[])
    ORDER BY lis.logic_id, lis.display_order, lis.id
    `,
    [foundIds]
  );
  const { rows: stopRows } = await db.query(
    `
    SELECT
      logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active
    FROM logic_stops
    WHERE logic_id = ANY($1::int[])
    ORDER BY logic_id, display_order, id
    `,
    [foundIds]
  );
  const { rows: securityRows } = await db.query(
    `
    SELECT
      ls.logic_id,
      s.name AS security_name,
      sp.prefix,
      sp.instrument_market,
      ls.display_order,
      ls.is_active
    FROM logic_securities ls
    JOIN securities s ON s.id = ls.security_id
    JOIN security_prefixes sp ON sp.security_id = s.id
    WHERE ls.logic_id = ANY($1::int[])
    ORDER BY ls.logic_id, ls.display_order, ls.id, sp.exchange_id
    `,
    [foundIds]
  );

  const paramsByLogic = new Map();
  for (const p of paramRows) {
    if (!paramsByLogic.has(p.logic_id)) paramsByLogic.set(p.logic_id, []);
    paramsByLogic.get(p.logic_id).push({
      param_key: p.param_key,
      param_value: p.param_value,
      value_type: p.value_type,
    });
  }
  const signalsByLogic = new Map();
  for (const s of signalRows) {
    if (!signalsByLogic.has(s.logic_id)) signalsByLogic.set(s.logic_id, []);
    signalsByLogic.get(s.logic_id).push({
      indicator_code: s.indicator_code,
      position_event: s.position_event,
      position_side: s.position_side,
      signal_kind: s.signal_kind,
      signal_acts_on:
        s.signal_acts_on === 'base_asset'
          ? 'base_asset'
          : s.signal_acts_on === 'contango'
            ? 'contango'
            : 'security',
      formula: s.formula,
      display_order: s.display_order,
      is_active: s.is_active,
    });
  }
  const stopsByLogic = new Map();
  for (const s of stopRows) {
    if (!stopsByLogic.has(s.logic_id)) stopsByLogic.set(s.logic_id, []);
    stopsByLogic.get(s.logic_id).push({
      rule_kind: s.rule_kind,
      scope_type: s.scope_type,
      value: Number(s.value),
      value_unit: s.value_unit,
      display_order: s.display_order,
      is_active: s.is_active,
    });
  }
  const securitiesByLogic = new Map();
  for (const s of securityRows) {
    if (!securitiesByLogic.has(s.logic_id)) securitiesByLogic.set(s.logic_id, []);
    const list = securitiesByLogic.get(s.logic_id);
    const key = `${String(s.prefix).toUpperCase()}|${s.instrument_market}`;
    if (list.some((x) => `${String(x.prefix).toUpperCase()}|${x.instrument_market}` === key)) {
      continue;
    }
    list.push({
      prefix: s.prefix,
      instrument_market: s.instrument_market,
      security_name: s.security_name,
      display_order: s.display_order,
      is_active: s.is_active,
    });
  }

  return {
    format: FORMAT,
    version: VERSION,
    exported_at: new Date().toISOString(),
    logics: logicRows.map((l) => ({
      name: l.name,
      note: l.note,
      is_enabled: false,
      account: {
        account_code: l.account_code,
        broker_code: l.broker_code,
      },
      params: paramsByLogic.get(l.id) || [],
      signals: signalsByLogic.get(l.id) || [],
      stops: stopsByLogic.get(l.id) || [],
      securities: securitiesByLogic.get(l.id) || [],
      last_opt_grid: packLastOptGrid(l),
    })),
  };
}

async function resolveAccountId(client, account) {
  const accountCode = String(account?.account_code || '').trim();
  const brokerCode = String(account?.broker_code || '').trim();
  if (accountCode && brokerCode) {
    const { rows } = await client.query(
      `
      SELECT a.id
      FROM accounts a
      JOIN brokers b ON b.id = a.broker_id
      WHERE a.account_code = $1 AND b.code = $2
      LIMIT 1
      `,
      [accountCode, brokerCode]
    );
    if (rows[0]) return rows[0].id;
  }
  if (accountCode) {
    const { rows } = await client.query(
      `SELECT id FROM accounts WHERE account_code = $1 ORDER BY id LIMIT 1`,
      [accountCode]
    );
    if (rows[0]) return rows[0].id;
  }
  const { rows: fake } = await client.query(
    `
    SELECT id FROM accounts
    WHERE account_type = 'fake'
    ORDER BY id
    LIMIT 1
    `
  );
  if (fake[0]) return fake[0].id;
  const { rows: anyAcc } = await client.query(
    `SELECT id FROM accounts ORDER BY id LIMIT 1`
  );
  if (anyAcc[0]) return anyAcc[0].id;
  const err = new Error('Нет счёта для импорта логики');
  err.status = 400;
  throw err;
}

async function resolveIndicatorId(client, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const { rows } = await client.query(
    `SELECT id FROM indicators WHERE upper(code) = $1 LIMIT 1`,
    [c]
  );
  return rows[0]?.id ?? null;
}

async function resolveSecurityId(client, paper) {
  const prefix = String(paper?.prefix || '').trim();
  const market = String(paper?.instrument_market || 'stock').trim();
  if (prefix) {
    const { rows } = await client.query(
      `
      SELECT s.id
      FROM securities s
      JOIN security_prefixes sp ON sp.security_id = s.id
      WHERE upper(sp.prefix) = upper($1)
        AND sp.instrument_market = $2
      ORDER BY sp.exchange_id
      LIMIT 1
      `,
      [prefix, market]
    );
    if (rows[0]) return rows[0].id;
  }
  const name = String(paper?.security_name || '').trim();
  if (name) {
    const { rows } = await client.query(
      `SELECT id FROM securities WHERE name = $1 ORDER BY id LIMIT 1`,
      [name]
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

async function writeLastOptGrid(client, logicId, lastOptGrid) {
  try {
    if (
      lastOptGrid &&
      Array.isArray(lastOptGrid.results) &&
      lastOptGrid.results.length > 0
    ) {
      await client.query(
        `
        UPDATE logics
        SET
          last_opt_grid_results = $2::jsonb,
          last_opt_grid_run_id = $3,
          last_opt_grid_at = COALESCE($4::timestamptz, CURRENT_TIMESTAMP)
        WHERE id = $1
        `,
        [
          logicId,
          JSON.stringify(lastOptGrid.results),
          lastOptGrid.run_id != null && Number.isFinite(Number(lastOptGrid.run_id))
            ? Number(lastOptGrid.run_id)
            : null,
          lastOptGrid.at || null,
        ]
      );
    } else {
      await client.query(
        `
        UPDATE logics
        SET
          last_opt_grid_results = NULL,
          last_opt_grid_run_id = NULL,
          last_opt_grid_at = NULL
        WHERE id = $1
        `,
        [logicId]
      );
    }
  } catch (err) {
    if (err?.code !== '42703') throw err;
  }
}

/**
 * Replace params/signals/stops/securities (+ last OPT) for an existing or new logic id.
 */
async function replaceLogicContents(client, logicId, item, warnings, nameForWarn) {
  await client.query(
    `
    INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
    SELECT $1, d.param_key, d.default_value, d.value_type
    FROM logic_param_defs d
    ON CONFLICT (logic_id, param_key) DO NOTHING
    `,
    [logicId]
  );

  for (const p of item.params || []) {
    if (!p?.param_key) continue;
    await client.query(
      `
      INSERT INTO logic_params (logic_id, param_key, param_value, value_type)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (logic_id, param_key) DO UPDATE SET
        param_value = EXCLUDED.param_value,
        value_type = EXCLUDED.value_type,
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        logicId,
        String(p.param_key),
        p.param_value != null ? String(p.param_value) : '',
        p.value_type != null ? String(p.value_type) : 'text',
      ]
    );
  }

  await client.query(`DELETE FROM logic_indicator_signals WHERE logic_id = $1`, [
    logicId,
  ]);
  await client.query(`DELETE FROM logic_stops WHERE logic_id = $1`, [logicId]);
  await client.query(`DELETE FROM logic_securities WHERE logic_id = $1`, [logicId]);

  for (const sig of item.signals || []) {
    const indicatorId = await resolveIndicatorId(client, sig.indicator_code);
    if (!indicatorId) {
      warnings.push(
        `${nameForWarn}: индикатор ${sig.indicator_code || '?'} не найден — сигнал пропущен`
      );
      continue;
    }
    await client.query(
      `
      INSERT INTO logic_indicator_signals (
        logic_id, indicator_id, position_event, position_side, signal_kind, signal_acts_on,
        formula, rating, rating_test, display_order, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9)
      `,
      [
        logicId,
        indicatorId,
        sig.position_event === 'close' ? 'close' : 'open',
        sig.position_side === 'short' ? 'short' : 'long',
        sig.signal_kind === 'counter' ? 'counter' : 'trend',
        sig.signal_acts_on === 'base_asset'
          ? 'base_asset'
          : sig.signal_acts_on === 'contango'
            ? 'contango'
            : 'security',
        String(sig.formula || ''),
        Number.isFinite(Number(sig.display_order)) ? Number(sig.display_order) : 0,
        sig.is_active === false ? false : true,
      ]
    );
  }

  for (const st of item.stops || []) {
    await client.query(
      `
      INSERT INTO logic_stops (
        logic_id, rule_kind, scope_type, value, value_unit, display_order, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        logicId,
        st.rule_kind === 'take_profit' ? 'take_profit' : 'stop_loss',
        st.scope_type === 'security_ltp_renew'
          ? 'portfolio_ltp_renew'
          : [
                'security',
                'security_resume',
                'security_inversion',
                'portfolio',
                'portfolio_resume',
                'portfolio_ltp_renew',
              ].includes(st.scope_type)
            ? st.scope_type
            : 'security',
        Number(st.value) || 0,
        st.value_unit === 'atr' ? 'atr' : 'percent',
        Number.isFinite(Number(st.display_order)) ? Number(st.display_order) : 0,
        st.is_active === false ? false : true,
      ]
    );
  }

  let papersAdded = 0;
  for (const paper of item.securities || []) {
    const securityId = await resolveSecurityId(client, paper);
    if (!securityId) {
      warnings.push(
        `${nameForWarn}: бумага ${paper.prefix || paper.security_name || '?'} (${paper.instrument_market || 'stock'}) не найдена — пропущена`
      );
      continue;
    }
    await client.query(
      `
      INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (logic_id, security_id) DO UPDATE SET
        display_order = EXCLUDED.display_order,
        is_active = EXCLUDED.is_active
      `,
      [
        logicId,
        securityId,
        Number.isFinite(Number(paper.display_order)) ? Number(paper.display_order) : 0,
        paper.is_active === false ? false : true,
      ]
    );
    papersAdded += 1;
  }

  await writeLastOptGrid(client, logicId, item.last_opt_grid || null);
  await syncRealAccountBalancesIfNeeded(client, logicId, { force: true });
  return papersAdded;
}

/**
 * @param {import('pg').Pool} pool
 * @param {object} bundle
 * @param {{ overwriteByName?: boolean }} [opts]
 *   overwriteByName (default true): same name → replace contents; else create with unique name.
 */
async function importLogicBundle(pool, bundle, opts = {}) {
  if (!bundle || bundle.format !== FORMAT) {
    const err = new Error(`Неверный формат файла (ожидается ${FORMAT})`);
    err.status = 400;
    throw err;
  }
  const list = Array.isArray(bundle.logics) ? bundle.logics : [];
  if (list.length === 0) {
    const err = new Error('В файле нет логик для импорта');
    err.status = 400;
    throw err;
  }
  const overwriteByName = opts.overwriteByName !== false;

  const imported = [];
  const warnings = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const item of list) {
      const desiredName = String(item?.name || '').trim() || 'Imported logic';
      const accountId = await resolveAccountId(client, item?.account);
      const note = item?.note != null ? String(item.note) : null;

      let logicId = null;
      let name = desiredName;
      let action = 'created';

      if (overwriteByName) {
        const { rows: existing } = await client.query(
          `SELECT id, name FROM logics WHERE name = $1 LIMIT 1`,
          [desiredName]
        );
        if (existing.length > 0) {
          logicId = existing[0].id;
          name = existing[0].name;
          action = 'updated';
          await client.query(
            `
            UPDATE logics
            SET account_id = $2, note = $3, is_enabled = FALSE
            WHERE id = $1
            `,
            [logicId, accountId, note]
          );
        }
      }

      if (logicId == null) {
        if (!overwriteByName) {
          name = await uniqueLogicName(client, desiredName, 'import');
        } else {
          // Name free — create with exact name
          name = desiredName;
        }
        const { rows: inserted } = await client.query(
          `
          INSERT INTO logics (name, account_id, is_enabled, note)
          VALUES ($1, $2, FALSE, $3)
          RETURNING id, name
          `,
          [name, accountId, note]
        );
        logicId = inserted[0].id;
        name = inserted[0].name;
        action = 'created';
      }

      const papersAdded = await replaceLogicContents(
        client,
        logicId,
        item,
        warnings,
        name
      );

      imported.push({
        id: logicId,
        name,
        source_name: desiredName,
        action,
        securities_count: papersAdded,
        has_opt_grid: !!(
          item.last_opt_grid &&
          Array.isArray(item.last_opt_grid.results) &&
          item.last_opt_grid.results.length > 0
        ),
      });
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { imported, warnings };
}

module.exports = {
  FORMAT,
  VERSION,
  buildLogicBundle,
  importLogicBundle,
};
