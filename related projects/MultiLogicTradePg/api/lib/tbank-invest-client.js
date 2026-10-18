'use strict';

/**
 * T-Invest REST client for Node (system TLS + Russian Trusted CA).
 * Used for UI token/account checks and for PostOrder when channel=node.
 */

const { httpsJsonPost, formatError } = require('./tbank-tls');
const crypto = require('crypto');

/** Prod T-Invest REST (support: invest-public-api.tbank.ru:443). */
const DEFAULT_API = 'https://invest-public-api.tbank.ru/rest';

const RPC_GET_ACCOUNTS = 'tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts';
const RPC_GET_PORTFOLIO = 'tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio';
const RPC_POST_ORDER = 'tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder';

/**
 * TTL-кэш read-only RPC (GetAccounts/GetPortfolio). Трейд-цикл за один прогон
 * вызывает баланс по 3 раза на каждую реальную логику (sizing_base + equity +
 * cycle_budget) — это и порождало HTTP 429 у T-Bank. Кэш на короткий TTL
 * схлопывает параллельные чтения в один запрос. GetAccounts меняется редко —
 * длинный TTL; GetPortfolio — короткий, и сбрасывается после любой заявки.
 */
const RPC_CACHE_TTL_MS = {
  [RPC_GET_ACCOUNTS]: 300_000,
  [RPC_GET_PORTFOLIO]: 20_000,
};
const RPC_CACHE_MAX = 500;
const rpcCache = new Map();

/** Повтор при 429 (Retry-After или экспоненциальная пауза). */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BASE_DELAY_MS = 1000;
/** Повтор read-only RPC при сетевом сбое/таймауте (никогда — для PostOrder). */
const NETWORK_RETRIES = 2;
const NETWORK_BASE_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpcCacheKey(apiUrl, rpcPath, token, body) {
  const tokenHash = crypto
    .createHash('sha1')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 12);
  let bodyKey;
  try {
    bodyKey = JSON.stringify(body ?? {}) || '';
  } catch (_e) {
    bodyKey = String(body);
  }
  return `${baseUrl(apiUrl)}\n${rpcPath}\n${tokenHash}\n${bodyKey}`;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function rpcCacheGet(key, ttlMs) {
  const hit = rpcCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    rpcCache.delete(key);
    return undefined;
  }
  return hit.data;
}

function rpcCacheSet(key, data) {
  if (rpcCache.size >= RPC_CACHE_MAX) {
    const oldest = rpcCache.keys().next().value;
    if (oldest !== undefined) rpcCache.delete(oldest);
  }
  rpcCache.set(key, { at: Date.now(), data: cloneJson(data) });
}

/** Сброс кэша после заявки: баланс портфеля должен стать свежим сразу. */
function invalidateRpcCache(rpcPath) {
  const marker = `\n${rpcPath}\n`;
  for (const key of [...rpcCache.keys()]) {
    if (key.includes(marker)) rpcCache.delete(key);
  }
}

function baseUrl(apiUrl) {
  const u = String(apiUrl || DEFAULT_API).trim().replace(/\/+$/, '');
  return u || DEFAULT_API;
}

function quotationToNumber(q) {
  if (q == null) return null;
  if (typeof q === 'number') return q;
  if (typeof q === 'string') {
    const n = Number(q);
    return Number.isFinite(n) ? n : null;
  }
  const units = Number(q.units ?? 0);
  const nano = Number(q.nano ?? 0);
  if (!Number.isFinite(units) && !Number.isFinite(nano)) return null;
  return units + nano / 1e9;
}

function formatMoneyRu(amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  const cur = String(currency || 'RUB').toUpperCase();
  const sym = cur === 'RUB' ? '₽' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur;
  return (
    Number(amount).toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) +
    ' ' +
    sym
  );
}

async function tbankHttpPost(apiUrl, rpcPath, token, body = {}) {
  const path = String(rpcPath || '');
  const ttlMs = RPC_CACHE_TTL_MS[path];
  const cacheKey = ttlMs ? rpcCacheKey(apiUrl, path, token, body) : null;
  if (cacheKey) {
    const cached = rpcCacheGet(cacheKey, ttlMs);
    if (cached !== undefined) return cloneJson(cached);
  }

  const url = `${baseUrl(apiUrl)}/${path.replace(/^\/+/, '')}`;
  let status;
  let json;
  let text;
  let headers;
  for (let attempt = 0; ; attempt += 1) {
    try {
      ({ status, json, text, headers } = await httpsJsonPost(url, {
        headers: { Authorization: `Bearer ${token}` },
        body: body ?? {},
      }));
    } catch (err) {
      // Сетевой сбой/таймаут: read-only RPC повторяем (T-Bank иногда отвечает
      // дольше таймаута). Заявку PostOrder не повторяем — иначе дубль сделки.
      if (path !== RPC_POST_ORDER && attempt < NETWORK_RETRIES) {
        await sleep(NETWORK_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      const wrapped = new Error(formatError(err));
      wrapped.cause = err.cause || err;
      wrapped.code = err.code;
      throw wrapped;
    }
    // 429 — превышен лимит запросов T-Bank. Ждём Retry-After (или паузу с
    // ростом) и повторяем, а не сразу валим цикл/UI ошибкой.
    if (status === 429 && attempt < RATE_LIMIT_RETRIES) {
      const retryAfter = Number(headers?.['retry-after']);
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : RATE_LIMIT_BASE_DELAY_MS * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    break;
  }
  if (status < 200 || status >= 300) {
    const msg =
      (json && (json.message || json.error || json.description)) ||
      text ||
      `HTTP ${status}`;
    const err = new Error(`T-Bank API HTTP ${status}: ${msg}`);
    err.status = status;
    err.body = json || text;
    throw err;
  }
  if (json && json.code != null && String(json.code) !== '' && String(json.code) !== '0') {
    const err = new Error(`T-Bank API: ${json.message || json.description || json.code}`);
    err.status = 400;
    err.body = json;
    throw err;
  }
  if (cacheKey) rpcCacheSet(cacheKey, json);
  // Заявка меняет состав портфеля — сбрасываем кэш портфеля, чтобы UI сразу
  // показал новый остаток, а не закэшированный до сделки.
  if (path === RPC_POST_ORDER) invalidateRpcCache(RPC_GET_PORTFOLIO);
  return json;
}

async function resolveTbankAccount(apiUrl, token, preferredAccountId) {
  const data = await tbankHttpPost(
    apiUrl,
    'tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts',
    token,
    {}
  );
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  if (accounts.length === 0) {
    throw new Error('По токену не найдено ни одного счёта в T-Bank');
  }
  const pref = preferredAccountId != null ? String(preferredAccountId).trim() : '';
  let picked = pref ? accounts.find((a) => a.id === pref) : null;
  if (!picked) {
    picked = accounts.find((a) => a.status === 'ACCOUNT_STATUS_OPEN') || accounts[0];
  }
  return {
    account_id: picked.id,
    account_name: picked.name || '',
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      type: a.type,
    })),
  };
}

async function verifyTbankToken(apiUrl, token) {
  const t = String(token || '').trim();
  if (!t) {
    return { has_token: false, valid: false, error_message: 'Токен T-Bank не задан' };
  }
  try {
    await tbankHttpPost(
      apiUrl,
      'tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts',
      t,
      {}
    );
    return { has_token: true, valid: true, error_message: null };
  } catch (err) {
    const status = Number(err.status);
    if (status === 401) {
      return {
        has_token: true,
        valid: false,
        error_message: 'Токен T-Bank неактивен или просрочен. Введите новый API-токен.',
      };
    }
    return {
      has_token: true,
      valid: false,
      error_message: err.message || String(err),
    };
  }
}

async function fetchPortfolioBalance(apiUrl, token, accountId) {
  const data = await tbankHttpPost(
    apiUrl,
    'tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio',
    token,
    { accountId: String(accountId) }
  );
  const total = data?.totalAmountPortfolio || data?.totalAmountShares;
  const amount = quotationToNumber(total);
  const cash = data?.totalAmountCurrencies;
  const cashAmount = quotationToNumber(cash);
  const currency = total?.currency || cash?.currency || 'RUB';
  const forDisplay =
    cashAmount != null && cashAmount !== 0 ? cashAmount : amount;
  return {
    amount,
    cash_amount: cashAmount,
    currency,
    display: formatMoneyRu(forDisplay, currency),
  };
}

async function figiLotSize(apiUrl, token, figi, pool) {
  const f = String(figi || '').trim();
  if (!f) return 1;
  try {
    const data = await tbankHttpPost(
      apiUrl,
      'tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy',
      token,
      { id_type: 'INSTRUMENT_ID_TYPE_FIGI', id: f }
    );
    const instrument = data?.instrument || data;
    const lot = Number(String(instrument?.lot ?? '').replace(/[^\d]/g, ''));
    if (Number.isFinite(lot) && lot >= 1) {
      if (pool) {
        try {
          await pool.query(
            `
            UPDATE securities s
            SET lot_size = $1
            FROM security_prefixes sp
            WHERE sp.security_id = s.id
              AND sp.tbank_figi = $2
              AND s.lot_size IS DISTINCT FROM $1
            `,
            [lot, f]
          );
        } catch (_e) {
          /* ignore cache update */
        }
      }
      return lot;
    }
  } catch (_e) {
    /* fall through to DB */
  }
  if (pool) {
    try {
      const { rows } = await pool.query(
        `
        SELECT GREATEST(1, COALESCE(s.lot_size, 1))::int AS lot
        FROM security_prefixes sp
        JOIN securities s ON s.id = sp.security_id
        WHERE sp.tbank_figi = $1
        ORDER BY sp.exchange_id
        LIMIT 1
        `,
        [f]
      );
      const lot = Number(rows[0]?.lot);
      if (Number.isFinite(lot) && lot >= 1) return lot;
    } catch (_e) {
      /* ignore */
    }
  }
  return 1;
}

/**
 * Full PostOrder (lots resolution + resolve account), same semantics as SQL tbank_post_order.
 */
async function postOrder(pool, params) {
  const apiUrl = params.api_url || DEFAULT_API;
  const token = String(params.token || '').trim();
  if (!token) throw new Error('T-Bank токен не задан');

  const figi = String(params.figi || '').trim();
  if (!figi) throw new Error('FIGI не задан');

  const resolved = await resolveTbankAccount(apiUrl, token, params.account_code);
  let dir = String(params.direction || '').trim().toUpperCase();
  if (dir === 'BUY') dir = 'ORDER_DIRECTION_BUY';
  if (dir === 'SELL') dir = 'ORDER_DIRECTION_SELL';
  if (!['ORDER_DIRECTION_BUY', 'ORDER_DIRECTION_SELL'].includes(dir)) {
    throw new Error('direction: BUY или SELL');
  }

  const exec = String(params.order_execution || 'market').trim().toLowerCase();
  let orderType = 'ORDER_TYPE_MARKET';
  const price = params.price != null && params.price !== '' ? Number(params.price) : null;
  if (['limit', 'l', 'order_type_limit'].includes(exec)) {
    orderType = 'ORDER_TYPE_LIMIT';
    if (!(price > 0)) throw new Error('LIMIT-заявка требует цену > 0');
  }

  let lots;
  if (params.quantity_is_lots) {
    lots = Math.floor(Number(params.quantity) || 0);
  } else {
    const lot = await figiLotSize(apiUrl, token, figi, pool);
    lots = Math.floor(Number(params.quantity || 0) / lot);
  }
  if (!(lots >= 1)) {
    throw new Error(
      `tbank_post_order: need ≥1 lot (qty=${params.quantity}, is_lots=${!!params.quantity_is_lots}, figi=${figi})`
    );
  }

  const { randomUUID } = require('crypto');
  const body = {
    accountId: resolved.account_id,
    figi,
    quantity: lots,
    direction: dir,
    orderType,
    confirmMarginTrade: true,
    orderId: randomUUID(),
  };
  if (price != null && price > 0) {
    const units = Math.trunc(price);
    const nano = Math.round((price - units) * 1_000_000_000);
    body.price = { units, nano };
  }

  return tbankHttpPost(
    apiUrl,
    'tinkoff.public.invest.api.contract.v1.OrdersService/PostOrder',
    token,
    body
  );
}

module.exports = {
  DEFAULT_API,
  tbankHttpPost,
  resolveTbankAccount,
  verifyTbankToken,
  fetchPortfolioBalance,
  figiLotSize,
  postOrder,
};
