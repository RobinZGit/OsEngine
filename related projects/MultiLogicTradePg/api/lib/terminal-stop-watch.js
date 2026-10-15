/** #999: стоп-лосс / тейк-профит терминала.
 *
 * СЛ/ТП задаются в верхнем блоке терминала (полоса с «Запросить сигналы»,
 * после инпута лимита автоисполнения): стоп-лосс — в ПРОЦЕНТАХ от средней цены
 * входа либо галочкой «Мгновенный СЛ»; тейк-профит — в процентах. Хранятся в
 * настройках счёта: terminal_state.payload.settings.stop_order =
 * { sl_pct, tp_pct, sl_instant }. «Мгновенный СЛ» (`sl_instant`) закрывает
 * позиции сразу, без движения цены. Обычный порог тоже проверяется на КАЖДОМ
 * опросе живой цены (без ожидания закрытия свечи), при уходе цены за порог
 * позиция закрывается маркет-заявкой.
 *
 * Сторож работает на стороне API (вкладка браузера не нужна). Исполнение
 * переиспользует боевой путь терминала (POST /api/terminal/trade), поэтому
 * реальная заявка T-Bank, комиссия, запись в terminal_trades и advisory-лок —
 * те же, что у ручной сделки. Живые котировки берутся из GET /api/prices/last
 * (source === 'tbank'; цена последней свечи не годится — по ней стоп не считаем).
 *
 * Настройка стопа единая для счёта (settings.stop_order = { sl_pct, tp_pct,
 * sl_instant }) и применяется ко ВСЕМ открытым позициям счёта (всем бумагам сразу).
 */
'use strict';

const http = require('http');

const DEFAULT_INTERVAL_MS = 10_000;
/** Котировка старше этого времени не считается «живой» — по ней не стопаем. */
const DEFAULT_MAX_QUOTE_AGE_MS = 15 * 60 * 1000;
/** Пауза на (счёт, бумага) после попытки закрытия (защита от волны ретраев). */
const DEFAULT_RETRY_COOLDOWN_MS = 20_000;

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

/** Настройки стопа счёта: { sl_pct, tp_pct, sl_instant } | null. Пустые/отрицательные
    проценты → null; процент 0 допустим (срабатывает на самой цене входа). `sl_instant`
    — «мгновенный стоп-лосс»: закрыть позиции сразу, без движения цены. Настройка
    единая для счёта и применяется ко всем его открытым позициям (всем бумагам). */
function parseStopOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sl = toNum(raw.sl_pct);
  const tp = toNum(raw.tp_pct);
  const slOk = sl != null && sl >= 0;
  const tpOk = tp != null && tp >= 0;
  const instant = raw.sl_instant === true;
  if (!slOk && !tpOk && !instant) return null;
  return { sl_pct: slOk ? sl : null, tp_pct: tpOk ? tp : null, sl_instant: instant };
}

/** Что сработало: 'stop_loss' | 'take_profit' | null.
    `instant` — мгновенный стоп-лосс: закрыть сразу, независимо от цены.
    Лонг (qty>0): СЛ ниже входа, ТП выше. Шорт (qty<0): СЛ выше, ТП ниже. */
function evalStop(qty, avg, price, slPct, tpPct, instant) {
  if (qty === 0 || !(avg > 0) || !(price > 0)) return null;
  if (instant) return 'stop_loss';
  const hasSl = slPct != null && slPct >= 0;
  const hasTp = tpPct != null && tpPct >= 0;
  if (qty > 0) {
    if (hasSl && price <= avg * (1 - slPct / 100)) return 'stop_loss';
    if (hasTp && price >= avg * (1 + tpPct / 100)) return 'take_profit';
  } else {
    if (hasSl && price >= avg * (1 + slPct / 100)) return 'stop_loss';
    if (hasTp && price <= avg * (1 - tpPct / 100)) return 'take_profit';
  }
  return null;
}

/** Открытые позиции всех счетов: Map<`acc:sec`, { account_id, security_id, qty, avg }>.
    Средняя цена входа — та же, что в блоке «Сделки» (positionCost/positionQty). */
async function loadOpenPositions(pool) {
  const { rows } = await pool.query(
    `SELECT tt.account_id,
            tt.security_id,
            SUM(CASE WHEN tt.direction = 'BUY' THEN tt.quantity ELSE -tt.quantity END) AS qty,
            SUM(CASE WHEN tt.direction = 'BUY' THEN tt.price * tt.quantity
                     ELSE -tt.price * tt.quantity END) + SUM(tt.commission) AS cost
       FROM terminal_trades tt
      WHERE tt.status = 'filled'
      GROUP BY tt.account_id, tt.security_id
     HAVING SUM(CASE WHEN tt.direction = 'BUY' THEN tt.quantity ELSE -tt.quantity END) <> 0`
  );
  const out = new Map();
  for (const r of rows) {
    const qty = Number(r.qty);
    const cost = Number(r.cost);
    if (!Number.isFinite(qty) || qty === 0 || !Number.isFinite(cost)) continue;
    const avg = cost / qty;
    if (!(avg > 0)) continue;
    out.set(`${r.account_id}:${r.security_id}`, {
      account_id: Number(r.account_id),
      security_id: Number(r.security_id),
      qty,
      avg,
    });
  }
  return out;
}

/** Настройки стопа по счетам: Map<accountId, { is_fake, commission_pct, stop }>.
    stop — единый { sl_pct, tp_pct } счёта (settings.stop_order), применяется ко всем
    открытым позициям счёта. */
async function loadStopSettings(pool) {
  const { rows } = await pool.query(
    `SELECT ts.account_id,
            (a.account_type <> 'real') AS is_fake,
            ts.payload -> 'settings' AS settings
       FROM terminal_state ts
       JOIN accounts a ON a.id = ts.account_id`
  );
  const out = new Map();
  for (const r of rows) {
    const settings = r.settings && typeof r.settings === 'object' ? r.settings : {};
    const stop = parseStopOrder(settings.stop_order);
    if (!stop) continue;
    const cp = Number(settings.commission_pct);
    out.set(Number(r.account_id), {
      is_fake: r.is_fake === true,
      commission_pct: Number.isFinite(cp) && cp >= 0 ? Math.min(cp, 100) : 0.03,
      stop,
    });
  }
  return out;
}

/** Живые котировки T-Bank для набора бумаг: Map<securityId, { price, time }>.
    Цена последней свечи (source !== 'tbank') и устаревшие котировки отбрасываются. */
async function fetchLivePrices(baseUrl, securityIds, maxAgeMs) {
  const out = new Map();
  if (securityIds.length === 0) return out;
  const path = `/api/prices/last?force=1&security_ids=${securityIds.join(',')}`;
  const r = await httpGetJson(baseUrl, path);
  const list = Array.isArray(r?.json?.prices) ? r.json.prices : [];
  const now = Date.now();
  for (const q of list) {
    if (String(q?.source) !== 'tbank') continue;
    const price = Number(q?.price);
    if (!(price > 0)) continue;
    const t = Date.parse(String(q?.time ?? ''));
    if (Number.isFinite(t) && now - t > maxAgeMs) continue;
    out.set(Number(q.security_id), { price, time: q?.time ?? null });
  }
  return out;
}

async function pollOnce(pool, baseUrl, state) {
  const settingsByAccount = await loadStopSettings(pool);
  if (settingsByAccount.size === 0) return;
  const positions = await loadOpenPositions(pool);
  if (positions.size === 0) return;

  // Цели: есть открытая позиция И на счёте задан стоп (единый для всех бумаг).
  const targets = [];
  const secIds = new Set();
  for (const pos of positions.values()) {
    const cfg = settingsByAccount.get(pos.account_id);
    if (!cfg) continue;
    targets.push({ pos, cfg });
    secIds.add(pos.security_id);
  }
  if (targets.length === 0) return;

  const quotes = await fetchLivePrices(baseUrl, [...secIds], state.maxQuoteAgeMs);
  if (quotes.size === 0) return;

  for (const { pos, cfg } of targets) {
    const stop = cfg.stop;
    const key = `${pos.account_id}:${pos.security_id}`;
    if (state.busy.has(key)) continue;
    if (Date.now() - (state.lastTry.get(key) ?? 0) < state.retryCooldownMs) continue;
    const quote = quotes.get(pos.security_id);
    if (!quote) continue;
    const hit = evalStop(pos.qty, pos.avg, quote.price, stop.sl_pct, stop.tp_pct, stop.sl_instant);
    if (!hit) continue;

    const direction = pos.qty > 0 ? 'sell' : 'buy';
    const instant = hit === 'stop_loss' && stop.sl_instant === true;
    const pct = hit === 'stop_loss' ? stop.sl_pct : stop.tp_pct;
    const label = instant
      ? 'Мгновенный стоп-лосс'
      : hit === 'stop_loss'
        ? 'Стоп-лосс'
        : 'Тейк-профит';
    const note = instant
      ? `${label}: цена ${quote.price} против входа ${round2(pos.avg)}`
      : `${label} ${pct}%: цена ${quote.price} против входа ${round2(pos.avg)}`;
    state.busy.add(key);
    state.lastTry.set(key, Date.now());
    try {
      const r = await httpPostJson(baseUrl, '/api/terminal/trade', {
        account_id: pos.account_id,
        security_id: pos.security_id,
        direction,
        execution: 'market',
        price: quote.price,
        quantity: Math.abs(pos.qty),
        ...(cfg.is_fake ? { commission_pct: cfg.commission_pct } : {}),
        note,
      });
      const ok = r?.json?.ok === true;
      console.log(
        `Terminal stop watch: ${hit} ${key} → close ${direction} ${Math.abs(pos.qty)} ` +
          `@ ${quote.price} ${ok ? 'OK' : 'FAILED'}${
            ok ? '' : ` (${r?.json?.error || r?.status})`
          }`
      );
    } catch (err) {
      console.error('Terminal stop watch close failed:', key, err.message || err);
    } finally {
      state.busy.delete(key);
    }
  }
}

function httpGetJson(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + path, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body || '{}') });
        } catch (_e) {
          resolve({ status: res.statusCode, json: null });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
  });
}

function httpPostJson(baseUrl, path, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload ?? {}));
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body || '{}') });
          } catch (_e) {
            resolve({ status: res.statusCode, json: null });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

let watchTimer = null;

/** #999: событийный сторож стопов терминала (на стороне API, вкладка не нужна). */
function startTerminalStopWatch(pool, baseUrl) {
  if (watchTimer) return;
  const intervalMs = Number(process.env.TERMINAL_STOP_WATCH_MS) || DEFAULT_INTERVAL_MS;
  const state = {
    busy: new Set(),
    lastTry: new Map(),
    maxQuoteAgeMs:
      Number(process.env.TERMINAL_STOP_MAX_QUOTE_AGE_MS) || DEFAULT_MAX_QUOTE_AGE_MS,
    retryCooldownMs:
      Number(process.env.TERMINAL_STOP_RETRY_COOLDOWN_MS) || DEFAULT_RETRY_COOLDOWN_MS,
  };
  const url = String(baseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  watchTimer = setInterval(() => {
    pollOnce(pool, url, state).catch((err) =>
      console.error('Terminal stop watch poll failed:', err.message || err)
    );
  }, intervalMs);
  console.log(`Terminal stop watch: every ${intervalMs}ms (SL/TP → market close)`);
}

module.exports = {
  startTerminalStopWatch,
  pollOnce,
  evalStop,
  parseStopOrder,
  loadOpenPositions,
};
