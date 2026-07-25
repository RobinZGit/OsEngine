'use strict';

/**
 * One-shot: resume orphan backtests and check processed_bars advances.
 * Usage: node scripts/verify-backtest-resume.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const { resumeOrphanBacktests } = require('../logic-backtest');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'multilogictrade',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '111',
});

async function main() {
  const before = await pool.query(`
    SELECT id, logic_id, processed_bars, trades_created, status
    FROM logic_backtest_runs
    WHERE status IN ('pending','loading_prices','loading_indicators','running')
      AND cancel_requested = FALSE
    ORDER BY id`);
  console.log('BEFORE', JSON.stringify(before.rows));
  if (before.rows.length === 0) {
    console.log('VERIFY_SKIP no orphan runs');
    process.exit(0);
  }
  const ids = before.rows.map((x) => Number(x.id));
  const r = await resumeOrphanBacktests(pool);
  console.log('SCHEDULED', JSON.stringify(r));

  for (let i = 0; i < 18; i += 1) {
    await new Promise((x) => setTimeout(x, 5000));
    const cur = await pool.query(
      `
      SELECT id, logic_id, status, processed_bars, trades_created, phase_message
      FROM logic_backtest_runs
      WHERE id = ANY($1::bigint[])
      ORDER BY id`,
      [ids]
    );
    console.log(`T${(i + 1) * 5}s`, JSON.stringify(cur.rows));
    const moved = cur.rows.some((row) => {
      const b = before.rows.find((x) => Number(x.id) === Number(row.id));
      return b && Number(row.processed_bars) > Number(b.processed_bars);
    });
    if (moved) {
      const tech = await pool.query(`
        SELECT logic_id, operation, left(message, 100) AS msg
        FROM app_tech_log
        WHERE operation = 'backtest.resume'
          AND started_at > now() - interval '3 minutes'
        ORDER BY id DESC LIMIT 5`);
      console.log('RESUME_LOGS', JSON.stringify(tech.rows));
      console.log('VERIFY_PASS bars advanced');
      process.exit(0);
    }
  }
  console.log('VERIFY_FAIL no bar advance in 90s');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
