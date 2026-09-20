/**
 * Состояние закладки «Терминал»: выбранные бумаги (полосы) и прочие настройки.
 * Одна строка на счёт; сами настройки — свободный JSON в колонке payload.
 * Плюс план облигаций из фондов (TBRU/SBGB/OBLG) и регистрация выпуска.
 */
const { resolveBondFund } = require('../lib/bond-fund-fetch');
const { tbankHttpPost, DEFAULT_API } = require('../lib/tbank-invest-client');
const { getBondNames } = require('../lib/bond-names');

/** Приоритет торговых площадочных classCode для облигаций (после «10000»/мусора). */
const BOND_CLASS_PREFERENCE = ['TQCB', 'TQOB', 'TQBR'];

/**
 * Загрузка цен выпуска в фоне. Регистрация не ждёт долгого HTTP: если T-Bank
 * не отдаёт свечи, load_prices_http уходит в MOEX-фолбэк по дням (десятки секунд).
 * Ответ /register возвращаем сразу, а график догонит живой цикл терминала.
 * Ошибки фоновой загрузки фиксируются в price_load_log.
 */
function backgroundPriceLoad(pool, securityId, tfId, days) {
  const rangeDays = Math.min(Math.max(Number(days) || 45, 1), 120);
  pool
    .query(
      `CALL load_prices_http($1, $2, (CURRENT_DATE - $3::int)::date, CURRENT_DATE)`,
      [securityId, tfId, rangeDays]
    )
    .catch(() => undefined);
}

/**
 * Выпуск облигации по ISIN.
 * GetInstrumentBy/BondBy с id_type=ISIN шлюз T-Bank отдаёт ошибкой
 * «Missing parameter: id_type», поэтому сначала ищем через FindInstrument
 * по ISIN и выбираем торговый выпуск (apiTradeAvailableFlag + classCode).
 * Запасной путь — GetInstrumentBy (на случай, если сервер примет ISIN).
 */
async function resolveBondByIsin(apiUrl, token, isin) {
  const normalized = String(isin || '').trim().toUpperCase();
  if (!normalized) {
    throw new Error('Не задан ISIN');
  }

  let matches = [];
  try {
    const data = await tbankHttpPost(
      apiUrl,
      'tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument',
      token,
      { query: normalized }
    );
    const list = Array.isArray(data?.instruments) ? data.instruments : [];
    matches = list.filter(
      (x) =>
        String(x?.isin || '').toUpperCase() === normalized &&
        String(x?.instrumentType || '').toLowerCase() === 'bond'
    );
  } catch (err) {
    if (err.status && err.status < 500) {
      throw err;
    }
  }

  if (matches.length) {
    const score = (x) => {
      const trade = String(x?.apiTradeAvailableFlag).toLowerCase() === 'true' ? 0 : 1;
      const cls = String(x?.classCode || '').toUpperCase();
      const prefIdx = BOND_CLASS_PREFERENCE.indexOf(cls);
      const clsScore = prefIdx >= 0 ? prefIdx : (cls && cls !== '000' ? BOND_CLASS_PREFERENCE.length : BOND_CLASS_PREFERENCE.length + 1);
      return trade * 100 + clsScore;
    };
    const picked = [...matches].sort((a, b) => score(a) - score(b))[0];
    return {
      figi: String(picked.figi || '').trim() || null,
      ticker: String(picked.ticker || normalized).trim().toUpperCase() || normalized,
      name: String(picked.name || normalized).trim(),
      lot: Number(picked.lot ?? 0) > 0 ? Number(picked.lot) : null,
      uid: String(picked.uid || '').trim() || null,
      api_trade_available: String(picked.apiTradeAvailableFlag).toLowerCase() === 'true',
    };
  }

  try {
    const data = await tbankHttpPost(
      apiUrl,
      'tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy',
      token,
      { id_type: 'INSTRUMENT_ID_TYPE_ISIN', id: normalized }
    );
    const picked = (data && (data.instrument || data)) || {};
    if (!picked?.figi && !picked?.ticker) {
      throw new Error('T-Bank не вернул данные выпуска');
    }
    return {
      figi: String(picked.figi || '').trim() || null,
      ticker: String(picked.ticker || normalized).trim().toUpperCase() || normalized,
      name: String(picked.name || normalized).trim(),
      lot: Number(picked.lot ?? 0) > 0 ? Number(picked.lot) : null,
      uid: String(picked.uid || '').trim() || null,
      api_trade_available: true,
    };
  } catch (err) {
    if (matches.length === 0) {
      throw new Error(`не найден выпуск по ISIN ${normalized}: ${err.message}`);
    }
    throw err;
  }
}

module.exports = function registerTerminalRoutes(app, ctx) {
  const { pool, parseId, handleDbError } = ctx;

  const DEFAULT_PAYLOAD = { panels: [], settings: {} };

  app.get('/api/terminal/state', async (req, res) => {
    try {
      const accountId = parseId(req.query.account_id);
      if (accountId == null) {
        res.json({ payload: DEFAULT_PAYLOAD });
        return;
      }
      const { rows } = await pool.query(
        `SELECT payload FROM terminal_state WHERE account_id = $1`,
        [accountId]
      );
      const payload = rows[0]?.payload ?? DEFAULT_PAYLOAD;
      res.json({ payload });
    } catch (err) {
      handleDbError(res, err, 'terminal state get');
    }
  });

  app.put('/api/terminal/state', async (req, res) => {
    try {
      const accountId = parseId(req.body?.account_id);
      if (accountId == null) {
        res.status(400).json({ error: 'Укажите корректный account_id' });
        return;
      }
      const raw = req.body?.payload;
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        res
          .status(400)
          .json({ error: 'payload должен быть объектом { panels, settings }' });
        return;
      }
      const panels = Array.isArray(raw.panels) ? raw.panels : [];
      const settings =
        raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
          ? raw.settings
          : {};
      const clean = {
        panels: panels
          .filter((p) => p && typeof p === 'object')
          .map((p) => ({
            security_id: parseId(p.security_id),
            timeframe_id: p.timeframe_id != null ? parseId(p.timeframe_id) : null,
            chart_height: parseId(p.chart_height),
          }))
          .filter((p) => p && p.security_id != null),
        settings,
      };
      await pool.query(
        `INSERT INTO terminal_state (account_id, payload, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (account_id) DO UPDATE
           SET payload = EXCLUDED.payload, updated_at = now()`,
        [accountId, JSON.stringify(clean)]
      );
      res.json({ ok: true, payload: clean });
    } catch (err) {
      handleDbError(res, err, 'terminal state put');
    }
  });

  /** Состав фонда облигаций (TBRU / SBGB / OBLG): живой (MOEX ISS) или статический снимок.
      Корпоративные выпуски идут первыми, внутри группы — по весу. */
  app.get('/api/terminal/bonds/plan', async (req, res) => {
    const fundCode = String(req.query.fund_code || 'TBRU').trim().toUpperCase();
    try {
      const fund = await resolveBondFund(fundCode);
      if (!fund) {
        res.status(404).json({ error: `Фонд облигаций ${fundCode} не найден` });
        return;
      }
      const bonds = [...fund.holdings].sort((a, b) => {
        if (a.kind === b.kind) return b.weight - a.weight;
        return a.kind === 'corp' ? -1 : 1;
      });
      // Русские наименования выпусков (MOEX ISS + фолбэк на БД) — для селекта.
      let names = new Map();
      try {
        names = await getBondNames(
          bonds.map((b) => b.sec),
          pool
        );
      } catch (_e) {
        /* наименования опциональны */
      }
      const bondsWithNames = bonds.map((b) => {
        const isin = String(b.sec || '').trim().toUpperCase();
        const name = names.get(isin) || null;
        return name ? { ...b, name } : b;
      });
      res.json({
        fund: {
          code: fund.code,
          name: fund.name,
          as_of: fund.asOf || null,
          source_used: fund.source_used || null,
          holdings_live: !!fund.holdings_live,
          holdings_count: bonds.length,
        },
        bonds: bondsWithNames,
      });
    } catch (err) {
      handleDbError(res, err, 'terminal bonds plan');
    }
  });

  /** Регистрация облигации (ISIN) как security_type Bond + загрузка цен через T-Bank.
      Идемпотентно: при повторном выборе обновляет figi и догружает свечи. */
  app.post('/api/terminal/bonds/register', async (req, res) => {
    const sec = String(req.body?.sec || '').trim().toUpperCase();
    const days = Number(req.body?.days) || 45;
    if (!/^(RU|SU)[A-Z0-9]{10,12}$/.test(sec)) {
      res.status(400).json({ error: 'Ожидается ISIN облигации (RU…/SU…)' });
      return;
    }
    try {
      const { rows: tfRows } = await pool.query(
        `SELECT id FROM timeframes WHERE tf = 'M15' LIMIT 1`
      );
      const tfId = tfRows[0]?.id;
      if (!tfId) {
        res.status(500).json({ error: 'Таймфрейм M15 не найден в БД' });
        return;
      }
      const token = (await pool.query('SELECT get_tbank_token() AS t')).rows[0]?.t;
      if (!token) {
        res.status(400).json({
          error:
            'Не задан T-Bank API-токен: введите его в «Настройки → API-токен T-Bank» или подключите счёт T-Bank.',
        });
        return;
      }
      const { rows: brokerRows } = await pool.query(
        `SELECT NULLIF(btrim(COALESCE(api_url, '')), '') AS u
         FROM brokers WHERE code = 'T-BANK' LIMIT 1`
      );
      const apiUrl = brokerRows[0]?.u || DEFAULT_API;

      let inst;
      try {
        inst = await resolveBondByIsin(apiUrl, token, sec);
      } catch (err) {
        res.status(502).json({
          error: `T-Bank: не удалось получить выпуск ${sec}: ${err.message}`,
        });
        return;
      }
      const ticker =
        String(inst?.ticker || sec).trim().toUpperCase().slice(0, 50) || sec;
      const figi = String(inst?.figi || '').trim() || null;
      const name = String(inst?.name || sec).trim().slice(0, 250);
      const lot = Number(String(inst?.lot ?? '').replace(/[^\d]/g, '')) || null;

      const client = await pool.connect();
      let securityId;
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO security_types (name)
           VALUES ('Bond')
           ON CONFLICT (name) DO NOTHING`
        );
        const { rows: secRows } = await client.query(
          `INSERT INTO securities (name, security_type_id)
           SELECT $1, t.id FROM security_types t WHERE t.name = 'Bond'
           ON CONFLICT (name) DO UPDATE SET security_type_id = EXCLUDED.security_type_id
           RETURNING id`,
          [name]
        );
        securityId = secRows[0]?.id;
        if (securityId == null) {
          throw new Error('Облигация не зарегистрирована (security_types.Bond отсутствует)');
        }
        if (lot && lot >= 1) {
          await client.query(
            `UPDATE securities SET lot_size = $1
             WHERE id = $2 AND lot_size IS DISTINCT FROM $1`,
            [lot, securityId]
          );
        }
        await client.query(
          `INSERT INTO security_prefixes
             (security_id, exchange_id, prefix, instrument_market, tbank_figi, note)
           VALUES ($1, 1, $2, 'bonds', $3, $4)
           ON CONFLICT (security_id, exchange_id) DO UPDATE SET
             prefix = EXCLUDED.prefix,
             instrument_market = EXCLUDED.instrument_market,
             tbank_figi = COALESCE(EXCLUDED.tbank_figi, security_prefixes.tbank_figi),
             note = EXCLUDED.note`,
          [securityId, ticker, figi, `Облигация ${sec} (из терминала)`]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      const { rows } = await pool.query(
        `
        SELECT s.id, s.name, s.lot_size, st.name AS security_type,
               sp.prefix, sp.instrument_market, sp.exchange_id,
               sp.underlying_security_id, e.name AS exchange_name
        FROM securities s
        JOIN security_types st ON st.id = s.security_type_id
        JOIN security_prefixes sp ON sp.security_id = s.id
        JOIN exchanges e ON e.id = sp.exchange_id
        WHERE s.id = $1 AND sp.exchange_id = 1
        `,
        [securityId]
      );
      const security = rows[0] || null;

      let candlesLoaded = null;
      let pricesLoading = false;
      if (securityId) {
        const cnt = await pool.query(
          `SELECT COUNT(*)::int AS c FROM prices
           WHERE security_id = $1 AND timeframe_id = $2`,
          [securityId, tfId]
        );
        candlesLoaded = cnt.rows[0]?.c ?? 0;
        if (candlesLoaded === 0) {
          pricesLoading = true;
          backgroundPriceLoad(pool, securityId, tfId, days);
        }
      }

      res.status(201).json({
        security,
        candles_loaded: candlesLoaded,
        prices_loading: pricesLoading,
        price_error: null,
      });
    } catch (err) {
      handleDbError(res, err, 'terminal bonds register');
    }
  });

  /** Ручная сделка терминала. quantity — в штуках (для фьючерса — контракты),
      price — последняя цена графика (для лимита — лимитная цена).
      Фейковый счёт — демо-исполнение; реальный — ордер в T-Bank. */
  app.post('/api/terminal/trade', async (req, res) => {
    const accountId = parseId(req.body?.account_id);
    const securityId = parseId(req.body?.security_id);
    const direction = String(req.body?.direction || '').trim().toUpperCase();
    const execution = String(req.body?.execution || 'market').trim().toLowerCase();
    const price = Number(req.body?.price);
    const quantity = Number(req.body?.quantity);
    if (!accountId || !securityId) {
      res.status(400).json({ error: 'Укажите account_id и security_id' });
      return;
    }
    if (!['BUY', 'SELL'].includes(direction)) {
      res.status(400).json({ error: 'direction: BUY или SELL' });
      return;
    }
    if (!['market', 'limit'].includes(execution)) {
      res.status(400).json({ error: 'execution: market или limit' });
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      res.status(400).json({ error: 'Количество должно быть целым числом больше нуля' });
      return;
    }
    if (execution === 'limit' && (!Number.isFinite(price) || price <= 0)) {
      res.status(400).json({ error: 'Лимитная заявка требует цену больше нуля' });
      return;
    }
    try {
      const accRows = await pool.query(
        `SELECT id, account_type FROM accounts WHERE id = $1`,
        [accountId]
      );
      const acc = accRows.rows[0];
      if (!acc) {
        res.status(404).json({ error: 'Счёт не найден' });
        return;
      }
      const isFake = String(acc.account_type).toLowerCase() !== 'real';

      const secRows = await pool.query(
        `
        SELECT s.name, st.name AS security_type,
               sp.prefix, sp.tbank_figi,
               (st.name = 'Futures') AS is_future
        FROM securities s
        JOIN security_types st ON st.id = s.security_type_id
        JOIN security_prefixes sp ON sp.security_id = s.id AND sp.exchange_id = 1
        WHERE s.id = $1
        LIMIT 1
        `,
        [securityId]
      );
      const sec = secRows.rows[0];
      if (!sec) {
        res.status(404).json({ error: 'Бумага не найдена в БД' });
        return;
      }
      const amount = Number((quantity * price).toFixed(2));
      const sideLabel = direction === 'BUY' ? 'Куплено' : 'Продано';

      // Реальный ордер T-Bank (фейк не выходит наружу). Сбои не падают с 500 —
      // фиксируются в terminal_trades статусом rejected.
      let order = null;
      let brokerOrderId = null;
      let status = 'filled';
      let note = null;
      if (!isFake) {
        let figi = String(sec.tbank_figi || '').trim() || null;
        if (!figi && sec.is_future) {
          const ctRows = await pool.query(
            `
            SELECT prefix, moex_secid, tbank_figi
            FROM get_future_contract_for_date($1, CURRENT_DATE)
            `,
            [securityId]
          );
          const ct = ctRows.rows[0] || null;
          if (ct?.tbank_figi) {
            figi = ct.tbank_figi;
          } else if (ct?.moex_secid || ct?.prefix) {
            const resolved = await pool.query(
              `SELECT resolve_tbank_instrument_id($1, $2, $3, TRUE, 'SPBFUT', $4) AS figi`,
              [securityId, ct.prefix || sec.prefix, ct.tbank_figi || null, ct.moex_secid || null]
            );
            figi = String(resolved.rows[0]?.figi || '').trim() || null;
          }
        } else if (!figi) {
          const resolved = await pool.query(
            `SELECT resolve_tbank_instrument_id($1, $2, $3, FALSE, 'TQBR', NULL) AS figi`,
            [securityId, sec.prefix, sec.tbank_figi || null]
          );
          figi = String(resolved.rows[0]?.figi || '').trim() || null;
        }
        if (!figi) {
          res.status(400).json({
            error: `Не удалось определить FIGI T-Bank для бумаги ${sec.prefix}`,
          });
          return;
        }
        try {
          const orderRows = await pool.query(
            `SELECT tbank_post_order($1, $2, $3, $4, $5, $6, FALSE) AS r`,
            [
              accountId,
              figi,
              quantity,
              execution === 'limit' ? price : null,
              direction,
              execution,
            ]
          );
          order = orderRows.rows[0]?.r ?? null;
          if (order == null) {
            throw new Error('T-Bank не вернул результат заявки');
          }
          if (order.ok === false) {
            status = 'rejected';
            note = String(order.error || 'Заявка не исполнена').slice(0, 2000);
          } else {
            brokerOrderId =
              String(order.order_id || order.orderId || '').trim() || null;
          }
        } catch (err) {
          status = 'rejected';
          note = String(err.message || 'Ордер не размещён').slice(0, 2000);
        }
      }

      // Запись сделки + обновление демо-кэша фейкового счёта (остаток может уйти в минус).
      const client = await pool.connect();
      let tradeId;
      let cash = null;
      try {
        await client.query('BEGIN');
        if (isFake) {
          const delta = direction === 'BUY' ? -amount : amount;
          const cashRows = await client.query(
            `UPDATE accounts
             SET terminal_cash = COALESCE(terminal_cash, 0) + $1, updated_at = now()
             WHERE id = $2
             RETURNING terminal_cash`,
            [delta, accountId]
          );
          cash = Number(cashRows.rows[0]?.terminal_cash ?? 0);
        }
        const trRows = await client.query(
          `INSERT INTO terminal_trades
             (account_id, security_id, direction, execution, quantity, price, amount,
              status, broker_order_id, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, executed_at`,
          [
            accountId,
            securityId,
            direction,
            execution,
            quantity,
            price,
            amount,
            status,
            brokerOrderId,
            note,
          ]
        );
        tradeId = trRows.rows[0]?.id;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const trade = {
        id: tradeId,
        account_id: accountId,
        security_id: securityId,
        security_prefix: sec.prefix,
        security_name: sec.name,
        direction,
        execution,
        quantity,
        price,
        amount,
        status,
        broker_order_id: brokerOrderId,
        note,
        executed_at: '',
      };

      if (status === 'rejected') {
        res.json({
          ok: false,
          mode: isFake ? 'fake' : 'real',
          direction,
          execution,
          quantity,
          price,
          amount,
          trade,
          cash,
          error: note,
          message: `Заявка не исполнена: ${note}`,
        });
        return;
      }

      res.json({
        ok: true,
        mode: isFake ? 'fake' : 'real',
        direction,
        execution,
        quantity,
        price,
        amount,
        trade,
        cash,
        order,
        message: isFake
          ? `Демо: ${sideLabel} ${quantity} шт ${sec.prefix} по ~${price} — сумма ≈ ${amount} ₽. Остаток: ${Math.round(cash ?? 0).toLocaleString('ru-RU')} ₽`
          : `Сделка размещена: ${sideLabel} ${quantity} шт ${sec.prefix}`,
      });
    } catch (err) {
      const status = Number(err.status) || 502;
      if (status >= 500) console.error('POST /api/terminal/trade', err);
      res.status(status).json({ error: err.message || 'Ордер не размещён' });
    }
  });

  /** Сделки терминала по счёту (новые сверху), с именем и префиксом бумаги. */
  app.get('/api/terminal/trades', async (req, res) => {
    const accountId = parseId(req.query.account_id);
    if (accountId == null) {
      res.status(400).json({ error: 'Укажите account_id' });
      return;
    }
    const limitRaw = Number(req.query.limit);
    const limit = Math.min(
      Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 1),
      500
    );
    try {
      const { rows } = await pool.query(
        `
        SELECT tt.id, tt.account_id, tt.security_id, tt.direction, tt.execution,
               tt.quantity, tt.price, tt.amount, tt.status, tt.broker_order_id,
               tt.note, tt.executed_at,
               s.name AS security_name,
               sp.prefix AS security_prefix
        FROM terminal_trades tt
        JOIN securities s ON s.id = tt.security_id
        LEFT JOIN security_prefixes sp
               ON sp.security_id = s.id AND sp.exchange_id = 1
        WHERE tt.account_id = $1
        ORDER BY tt.executed_at DESC, tt.id DESC
        LIMIT $2
        `,
        [accountId, limit]
      );
      res.json({ trades: rows });
    } catch (err) {
      handleDbError(res, err, 'terminal trades list');
    }
  });

  /** Удаление всех сделок терминала по счёту.
      У фейкового счёта демо-кэш пересчитывается: откатывается сумма всех
      сделок (BUY -= amount, SELL += amount) → остаток возвращается к базовому. */
  app.delete('/api/terminal/trades', async (req, res) => {
    const accountId = parseId(req.query.account_id);
    if (accountId == null) {
      res.status(400).json({ error: 'Укажите account_id' });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sumRows = await client.query(
        `SELECT COALESCE(
           SUM(CASE WHEN direction = 'SELL' THEN amount ELSE -amount END), 0) AS delta
         FROM terminal_trades WHERE account_id = $1`,
        [accountId]
      );
      const delta = Number(sumRows.rows[0]?.delta ?? 0);
      const delRows = await client.query(
        `DELETE FROM terminal_trades WHERE account_id = $1`,
        [accountId]
      );
      const deleted = delRows.rowCount || 0;
      let cash = null;
      const accRows = await client.query(
        `SELECT account_type FROM accounts WHERE id = $1`,
        [accountId]
      );
      const acc = accRows.rows[0];
      if (acc && String(acc.account_type).toLowerCase() !== 'real') {
        const cashRows = await client.query(
          `UPDATE accounts
           SET terminal_cash = terminal_cash - $1, updated_at = now()
           WHERE id = $2
           RETURNING terminal_cash`,
          [delta, accountId]
        );
        cash = Number(cashRows.rows[0]?.terminal_cash ?? 0);
      }
      await client.query('COMMIT');
      res.json({ ok: true, deleted, cash });
    } catch (err) {
      await client.query('ROLLBACK');
      handleDbError(res, err, 'terminal trades delete');
    } finally {
      client.release();
    }
  });

  /** Запомненный выбор счёта терминала. */
  app.get('/api/terminal/ui-state', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT selected_account_id FROM terminal_ui_state WHERE id = 1`
      );
      res.json({ selected_account_id: rows[0]?.selected_account_id ?? null });
    } catch (err) {
      handleDbError(res, err, 'terminal ui-state get');
    }
  });

  app.put('/api/terminal/ui-state', async (req, res) => {
    const accountId = parseId(req.body?.selected_account_id);
    if (accountId == null) {
      res.status(400).json({ error: 'Укажите selected_account_id' });
      return;
    }
    try {
      await pool.query(
        `INSERT INTO terminal_ui_state (id, selected_account_id, updated_at)
         VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET
           selected_account_id = EXCLUDED.selected_account_id,
           updated_at = now()`,
        [accountId]
      );
      res.json({ ok: true, selected_account_id: accountId });
    } catch (err) {
      handleDbError(res, err, 'terminal ui-state put');
    }
  });
};