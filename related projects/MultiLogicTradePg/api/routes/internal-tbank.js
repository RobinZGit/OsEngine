'use strict';

const { postOrder, tbankHttpPost } = require('../lib/tbank-invest-client');
const { isUiSessionActive } = require('../lib/trade-runner-session');

function isLocalRequest(req) {
  const ip = String(req.socket?.remoteAddress || req.ip || '');
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('127.0.0.1')
  );
}

async function uiHeartbeatActive(pool) {
  if (isUiSessionActive()) return true;
  try {
    const { rows } = await pool.query(`SELECT trade_runner_ui_is_active() AS ok`);
    return Boolean(rows[0]?.ok);
  } catch (_e) {
    return false;
  }
}

/**
 * Internal localhost-only routes: Postgres pgsql-http → Node → T-Invest (Russian CA TLS).
 */
module.exports = function registerInternalTbankRoutes(app, ctx) {
  const { pool } = ctx;

  /** Generic RPC proxy (GetAccounts, GetPortfolio, PostOrder body already built, …). */
  app.post('/api/internal/tbank/http-post', async (req, res) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ ok: false, error: 'Only localhost may call internal T-Bank proxy' });
      return;
    }
    try {
      const apiUrl = req.body?.api_url;
      const rpcPath = req.body?.rpc_path;
      const token = req.body?.token;
      const body = req.body?.body ?? {};
      if (!rpcPath || !token) {
        res.status(400).json({ ok: false, error: 'rpc_path and token required' });
        return;
      }
      const data = await tbankHttpPost(apiUrl, rpcPath, token, body);
      res.json({ ok: true, data, channel: 'node' });
    } catch (err) {
      console.error('POST /api/internal/tbank/http-post', err.message);
      const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
      res.status(status >= 500 ? 500 : 400).json({
        ok: false,
        error: err.message || String(err),
      });
    }
  });

  app.post('/api/internal/tbank/post-order', async (req, res) => {
    if (!isLocalRequest(req)) {
      res.status(403).json({ ok: false, error: 'Only localhost may call internal T-Bank proxy' });
      return;
    }
    try {
      if (!(await uiHeartbeatActive(pool))) {
        res.status(503).json({
          ok: false,
          error:
            'UI heartbeat inactive: откройте MultiLogic Trade в браузере или переключите канал заявок на Postgres',
        });
        return;
      }

      const order = await postOrder(pool, {
        api_url: req.body?.api_url,
        token: req.body?.token,
        account_code: req.body?.account_code,
        figi: req.body?.figi,
        quantity: req.body?.quantity,
        price: req.body?.price,
        direction: req.body?.direction,
        order_execution: req.body?.order_execution,
        quantity_is_lots: Boolean(req.body?.quantity_is_lots),
      });
      res.json({ ok: true, order, channel: 'node' });
    } catch (err) {
      console.error('POST /api/internal/tbank/post-order', err.message);
      const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
      res.status(status >= 500 ? 500 : 400).json({
        ok: false,
        error: err.message || String(err),
      });
    }
  });
};
