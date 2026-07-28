/**
 * Persist / recover offline OPT grid results for «Применить лучшие OPT».
 * Source of truth while available: logics.last_opt_grid_*; cleared only by OPT reset.
 */

function isResultsArray(value) {
  return Array.isArray(value) && value.length > 0;
}

/**
 * @returns {Promise<{ run_id: number|null, results: any[]|null, source: string }>}
 */
async function resolveLastOptGridResults(pool, logicId) {
  const id = Number(logicId);
  if (!Number.isInteger(id) || id <= 0) {
    return { run_id: null, results: null, source: 'none' };
  }

  // 1) Logic-level cache (survives until Сброс OPT / Параметры по умолчанию).
  try {
    const { rows } = await pool.query(
      `
      SELECT last_opt_grid_results, last_opt_grid_run_id
      FROM logics
      WHERE id = $1
      `,
      [id]
    );
    const row = rows[0];
    if (row && isResultsArray(row.last_opt_grid_results)) {
      return {
        run_id: row.last_opt_grid_run_id != null ? Number(row.last_opt_grid_run_id) : null,
        results: row.last_opt_grid_results,
        source: 'logic',
      };
    }
  } catch (err) {
    // Column may be missing before 01 upgrade — fall through to runs.
    if (err?.code !== '42703') throw err;
  }

  // 2) Any finished run that already has ranked results.
  {
    const { rows } = await pool.query(
      `
      SELECT id, opt_grid_results
      FROM logic_backtest_runs
      WHERE logic_id = $1
        AND opt_grid_results IS NOT NULL
        AND jsonb_typeof(opt_grid_results) = 'array'
        AND jsonb_array_length(opt_grid_results) > 0
      ORDER BY id DESC
      LIMIT 1
      `,
      [id]
    );
    if (rows.length > 0) {
      await rememberOptGridOnLogic(pool, id, rows[0].id, rows[0].opt_grid_results);
      return {
        run_id: Number(rows[0].id),
        results: rows[0].opt_grid_results,
        source: 'run',
      };
    }
  }

  // 3) Arms exist but finalize never wrote results — rebuild now.
  {
    const { rows } = await pool.query(
      `
      SELECT id
      FROM logic_backtest_runs
      WHERE logic_id = $1
        AND opt_grid_arms IS NOT NULL
        AND jsonb_typeof(opt_grid_arms) = 'array'
        AND jsonb_array_length(opt_grid_arms) > 0
      ORDER BY id DESC
      LIMIT 1
      `,
      [id]
    );
    if (rows.length > 0) {
      const runId = Number(rows[0].id);
      try {
        const { rows: fin } = await pool.query(
          `SELECT logic_opt_grid_finalize($1) AS r`,
          [runId]
        );
        const results = fin[0]?.r;
        if (isResultsArray(results)) {
          return { run_id: runId, results, source: 'finalize' };
        }
      } catch (err) {
        console.warn('logic_opt_grid_finalize recover', err?.message || err);
      }
    }
  }

  return { run_id: null, results: null, source: 'none' };
}

async function rememberOptGridOnLogic(pool, logicId, runId, results) {
  if (!isResultsArray(results)) return;
  try {
    await pool.query(
      `
      UPDATE logics
      SET
        last_opt_grid_results = $2::jsonb,
        last_opt_grid_run_id = $3,
        last_opt_grid_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND (
          last_opt_grid_results IS NULL
          OR last_opt_grid_run_id IS DISTINCT FROM $3
        )
      `,
      [logicId, JSON.stringify(results), runId]
    );
  } catch (err) {
    if (err?.code !== '42703') {
      console.warn('rememberOptGridOnLogic', err?.message || err);
    }
  }
}

module.exports = {
  resolveLastOptGridResults,
  rememberOptGridOnLogic,
  isResultsArray,
};
