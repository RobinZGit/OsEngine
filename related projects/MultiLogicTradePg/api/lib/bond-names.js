'use strict';

/**
 * Русские наименования облигаций по ISIN.
 *
 * Основной источник — справочник MOEX ISS (engines/stock/markets/bonds/securities):
 * один-два GET-запроса отдают SECNAME для всех выпусков (в BLOCK, не board —
 * SECID облигации там совпадает с ISIN). Результат кэшируется в памяти процесса.
 * Фолбэк на локальную БД: уже зарегистрированные в терминале облигации
 * хранят ISIN в security_prefixes.note («Облигация <ISIN> (из терминала)»).
 */

const https = require('https');

const MOEX_BASE =
  'https://iss.moex.com/iss/engines/stock/markets/bonds/securities.json' +
  '?iss.meta=off' +
  '&iss.only=securities' +
  '&securities.columns=SECID,SECNAME,SECSHORTNAME';

const PAGE = 5000;
/** Обновлять справочник не чаще одного раза в 6 часов. */
const TTL_MS = 6 * 60 * 60 * 1000;

const cache = { map: null, at: 0, busy: null, lastError: null };

function httpGetJson(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.get(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'MultiLogicTradePg/1.0' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`MOEX ISS HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (_e) {
            reject(new Error('MOEX ISS: не удалось разобрать ответ'));
          }
        });
      }
    );
    req.on('error', (err) => reject(new Error(`MOEX ISS: ${err.message}`)));
  });
}

function rowsFromBlock(json) {
  const block = json && json.securities;
  const cols = (block && block.columns) || [];
  const rows = (block && block.data) || [];
  const idxSec = cols.indexOf('SECID');
  const idxName = cols.indexOf('SECNAME');
  const out = [];
  for (const r of rows) {
    if (idxSec < 0) continue;
    const sec = String(r[idxSec] || '').trim().toUpperCase();
    if (!sec) continue;
    const name = String(idxName >= 0 && r[idxName] ? r[idxName] : '').trim();
    out.push([sec, name]);
  }
  return out;
}

async function fetchMoexAll() {
  const map = new Map();
  let start = 0;
  for (let guard = 0; guard < 100; guard++) {
    const url = `${MOEX_BASE}&iss.reverse=false&sort_order=asc&limit=${PAGE}&start=${start}`;
    // eslint-disable-next-line no-await-in-loop
    const rows = rowsFromBlock(await httpGetJson(url));
    for (const [sec, name] of rows) {
      if (name && !map.has(sec)) map.set(sec, name);
    }
    if (rows.length < PAGE) break;
    start += rows.length;
  }
  return map;
}

async function currentMap() {
  if (cache.map && Date.now() - cache.at < TTL_MS) return cache.map;
  if (!cache.busy) {
    cache.busy = fetchMoexAll()
      .then((m) => {
        cache.map = m;
        cache.at = Date.now();
        cache.lastError = null;
        return m;
      })
      .catch((err) => {
        cache.lastError = err.message || String(err);
        const stale = cache.map;
        if (stale) return stale;
        throw err;
      })
      .finally(() => {
        cache.busy = null;
      });
  }
  return cache.busy;
}

/** ISINs в заглавном виде из `note` терм-регистрации («Облигация <ISIN> (из терминала)»). */
function isinFromNote(note) {
  const m = String(note || '').match(/\b(RU|SU)[A-Z0-9]{10,12}\b/);
  return m ? m[0] : null;
}

async function dbNameMap(pool, isins) {
  const out = new Map();
  if (!pool || !Array.isArray(isins) || isins.length === 0) return out;
  const need = [...new Set(isins.map((x) => String(x).toUpperCase()))];
  try {
    const rows = await pool.query(
      `SELECT s.name, sp.note
       FROM security_prefixes sp
       JOIN securities s ON s.id = sp.security_id
       WHERE sp.note LIKE 'Облигация % (из терминала)'`
    );
    for (const r of rows.rows || []) {
      const isin = isinFromNote(r.note);
      if (isin && need.includes(isin) && r.name) out.set(isin, String(r.name).trim());
    }
  } catch (_e) {
    /* фолбэк недоступен — вернём пустую карту */
  }
  return out;
}

/**
 * Карта ISIN → русское имя выпуска.
 * Сначала кэш MOEX, затем БД; недоступность источника не бросает ошибку —
 * вернётся пустая карта.
 */
async function getBondNames(isins, pool) {
  const need = [...new Set((Array.isArray(isins) ? isins : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  const out = new Map();
  if (need.length === 0) return out;
  try {
    const moex = await currentMap();
    for (const isin of need) {
      const name = moex.get(isin);
      if (name) out.set(isin, name);
    }
  } catch (_e) {
    /* MOEX недоступен — только DB-фолбэк */
  }
  const rest = need.filter((x) => !out.has(x));
  const db = await dbNameMap(pool, rest);
  for (const isin of rest) {
    const name = db.get(isin);
    if (name) out.set(isin, name);
  }
  return out;
}

module.exports = { getBondNames, fetchMoexAll, MOEX_BASE };