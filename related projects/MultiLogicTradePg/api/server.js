/**
 * MultiLogicTradePg Express API — мост Angular ↔ PostgreSQL.
 *
 * Маршруты разнесены по api/routes/* (Phase A). Общие хелперы — api/lib/server-shared.js.
 *
 * Группы:
 * - settings — health, settings, maintenance
 * - indicators / market — рынок и индикаторы
 * - references — brokers, exchanges, accounts
 * - logics / trades / backtest — торговые логики
 * - ops — tech-log, processes, schema
 */
require('dotenv').config();

// Set before other TLS use when possible (https.Agent in tbank-tls is the real fix).
const path = require('path');
const fs = require('fs');
const _ruPem = path.join(__dirname, 'certs', 'russiantrustedca.pem');
if (fs.existsSync(_ruPem)) {
  process.env.NODE_EXTRA_CA_CERTS = _ruPem;
}

// T-Bank Invest needs Russian Trusted CA (gosuslugi.ru/crt); Node ignores Windows store.
const { ensureTbankTls } = require('./lib/tbank-tls');

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { resumeOrphanBacktests } = require('./logic-backtest');
const { startTradeRunner } = require('./trade-runner');
const { startMaintenanceScheduler } = require('./maintenance-scheduler');
const { createRouteContext, resumeOrphanWarmups } = require('./lib/server-shared');

const registerSettingsRoutes = require('./routes/settings');
const registerInternalTbankRoutes = require('./routes/internal-tbank');
const registerIndicatorsRoutes = require('./routes/indicators');
const registerMarketRoutes = require('./routes/market');
const registerReferencesRoutes = require('./routes/references');
const registerLogicsRoutes = require('./routes/logics');
const registerTradesRoutes = require('./routes/trades');
const registerBacktestRoutes = require('./routes/backtest');
const registerOpsRoutes = require('./routes/ops');

const app = express();
const port = Number(process.env.PORT) || 3000;
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:4200';

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'multilogictrade',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  max: Math.max(10, Math.min(40, Number(process.env.PGPOOL_MAX) || 24)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

const ctx = createRouteContext(pool);

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

registerSettingsRoutes(app, ctx);
registerInternalTbankRoutes(app, ctx);
registerIndicatorsRoutes(app, ctx);
registerMarketRoutes(app, ctx);
registerReferencesRoutes(app, ctx);
registerLogicsRoutes(app, ctx);
registerTradesRoutes(app, ctx);
registerBacktestRoutes(app, ctx);
registerOpsRoutes(app, ctx);

app.use((_req, res) => {
  res.status(404).json({
    error: `Маршрут API не найден. Перезапустите web\\MultiLogic_Trade_Progress_Start.bat.`,
  });
});

(async () => {
  try {
    const tlsInfo = await ensureTbankTls();
    if (tlsInfo.ok) {
      console.log(`T-Bank TLS: Russian Trusted CA ready (${tlsInfo.path})`);
    } else {
      console.warn(
        `T-Bank TLS: ${tlsInfo.error || 'CA not loaded'} — install https://www.gosuslugi.ru/crt`
      );
    }
  } catch (err) {
    console.warn('T-Bank TLS init:', err.message);
  }

  app.listen(port, () => {
    console.log(`MultiLogicTrade API: http://localhost:${port}`);
    console.log(`CORS origin: ${corsOrigin}`);
    // Keep SQL→Node PostOrder proxy URL in sync with this process PORT.
    pool
      .query(
        `
      INSERT INTO parameter_values (parameter_set_id, parameter_type_id, value)
      SELECT ps.id, pt.id, $1
      FROM parameter_sets ps
      CROSS JOIN parameter_types pt
      WHERE ps.name = 'Default'
        AND pt.short_name = 'APP_TBANK_ORDER_NODE_URL'
      ON CONFLICT (parameter_set_id, parameter_type_id)
      DO UPDATE SET value = EXCLUDED.value
      `,
        [`http://127.0.0.1:${port}`]
      )
      .then(() => console.log(`T-Bank order Node URL: http://127.0.0.1:${port}`))
      .catch((err) => console.warn('APP_TBANK_ORDER_NODE_URL sync skipped:', err.message));
    startTradeRunner(pool);
    startMaintenanceScheduler(pool);
    pool
      .query(
        `
      SELECT COUNT(*)::int AS n
      FROM logics l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.is_enabled = TRUE AND a.is_active = TRUE
      `
      )
      .then((r) => {
        const n = r.rows[0]?.n ?? 0;
        console.log(`Enabled logics for live trading: ${n}`);
        if (n === 0) {
          console.log(
            'No enabled logics — open Angular UI and turn on the logic checkbox, or keep this API running after enable.'
          );
        }
      })
      .catch((err) => console.error('enabled logics count', err.message));
    pool
      .query(`SELECT logic_sync_all_real_account_balances() AS n`)
      .then((r) => {
        const n = r.rows[0]?.n;
        if (n != null) {
          console.log(`Real account balances synced for ${n} logic(s)`);
        }
      })
      .catch((err) => console.error('logic_sync_all_real_account_balances', err.message));
    resumeOrphanWarmups(pool)
      .then((r) => {
        console.log(
          `Warm-up resume: watching=${r.watching} finished_enabled=${r.finished}`
        );
      })
      .catch((err) => console.error('resumeOrphanWarmups', err));
    resumeOrphanBacktests(pool)
      .then((r) => {
        console.log(
          `Backtest resume: scheduled=${r.scheduled ?? 0} found=${r.found ?? 0}`
        );
      })
      .catch((err) => console.error('resumeOrphanBacktests', err));
    console.log('API ready — keep this window open. Trade cycles every 15s (see lines below).');
  });
})();
