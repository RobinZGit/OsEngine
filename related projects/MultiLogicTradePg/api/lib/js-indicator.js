'use strict';

const vm = require('vm');

const DEFAULT_TIMEOUT_MS = 250;
const MAX_CODE_LENGTH = 200000;
const MAX_BARS_COUNT = 5000;

function parseSignalParamsObject(paramsText) {
  const out = {};
  const src = String(paramsText ?? '').trim();
  if (!src) return out;

  // split by commas not inside quotes/parens/brackets (simple but practical)
  const parts = [];
  let buf = '';
  let depthParen = 0;
  let depthBracket = 0;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < src.length) {
        buf += src[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    if (ch === ',' && depthParen === 0 && depthBracket === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      // positional/bare token: expose as flag true under normalized key if identifier-like
      const k = part.replace(/[^A-Za-z0-9_]/g, '_');
      if (k) out[k] = true;
      continue;
    }
    const key = part.slice(0, eq).trim();
    const rawVal = part.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = coerceParamValue(rawVal);
    const lower = key.toLowerCase();
    if (!(lower in out)) out[lower] = out[key];
  }
  return out;
}

function coerceParamValue(rawVal) {
  if (rawVal == null) return null;
  let v = String(rawVal).trim();
  if (v === '') return '';
  // quoted string
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
    const q = v[0];
    v = v.slice(1, -1);
    if (q === '"') {
      try { return JSON.parse('"' + v.replace(/"/g, '\\"') + '"'); } catch { return v; }
    }
    return v.replace(/\\'/g, '\'').replace(/\\\\/g, '\\');
  }
  const lower = v.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;
  if (/^[+-]?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

function normalizeSeriesValue(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compileJsIndicator(jsCode, options = {}) {
  const code = String(jsCode ?? '');
  if (!code.trim()) throw new Error('Пустой JS-код индикатора');
  if (code.length > MAX_CODE_LENGTH) throw new Error('JS-код индикатора слишком большой');

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const userScript = new vm.Script(
    `"use strict";\n${code}\n;\nif (typeof calc !== 'function') { throw new Error('Ожидается function calc(ctx, params)'); }\ncalc;`,
    { filename: options.filename || 'user-indicator.js' }
  );

  return {
    timeoutMs,
    run(ctx, params) {
      const sandbox = {
        calc: undefined,
        ctx,
        params: params || {},
        Math, Number, String, Boolean, Array, Object, Date, JSON, RegExp,
        isFinite, isNaN, parseInt, parseFloat,
        console: undefined,
        globalThis: undefined,
        global: undefined,
        process: undefined,
        require: undefined,
        module: undefined,
        exports: undefined,
        Buffer: undefined,
        setTimeout: undefined,
        setInterval: undefined,
        setImmediate: undefined,
      };
      sandbox.globalThis = sandbox;
      const context = vm.createContext(sandbox);
      const calcFn = userScript.runInContext(context, { timeout: timeoutMs });
      const result = calcFn(ctx, params || {});
      if (result == null) return null;
      // Multi-series: plain object like {UPPER: 1, LOWER: 0, ...}
      if (typeof result === 'object' && !Array.isArray(result) && !(result instanceof Date)) {
        const out = Object.create(null);
        for (const [k, v] of Object.entries(result)) {
          if (!k) continue;
          out[String(k).toUpperCase()] = normalizeSeriesValue(v);
        }
        return out;
      }
      return normalizeSeriesValue(result);
    },
  };
}

function buildBarsView(series, endIndex, count, extra = {}) {
  const total = Array.isArray(series?.dt) ? series.dt.length : 0;
  const want = Math.max(0, Math.min(Number(count) || 0, MAX_BARS_COUNT, total));
  const end = Math.max(0, Math.min(Number(endIndex) || 0, total - 1));
  const start = Math.max(0, end - want + 1);
  const n = want === 0 ? 0 : (end - start + 1);

  const sliceNum = (arr) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = arr ? Number(arr[start + i]) : NaN;
    return out;
  };
  const sliceAny = (arr) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = arr ? arr[start + i] : null;
    return out;
  };

  const dt = sliceAny(series?.dt);
  const open = sliceNum(series?.open);
  const high = sliceNum(series?.high);
  const low = sliceNum(series?.low);
  const close = sliceNum(series?.close);
  const volume = sliceNum(series?.volume);

  const mkBar = (idx) => idx < 0 ? null : ({
    dt: dt[idx],
    open: open[idx], high: high[idx], low: low[idx], close: close[idx], volume: volume[idx],
    o: open[idx], h: high[idx], l: low[idx], c: close[idx], v: volume[idx], t: dt[idx],
  });

  return Object.freeze({
    n,
    start,
    end,
    dt, open, high, low, close, volume,
    o: open, h: high, l: low, c: close, v: volume, t: dt,
    last: mkBar(n - 1),
    prev: mkBar(n - 2),
    timeframe: extra.timeframe ?? null,
  });
}

async function loadPriceSeries(client, { securityId, timeframeId, dateFrom, dateTo, lookbackBars = 500 }) {
  // load range [dateFrom-lookback, dateTo] ordered asc; lookbackBars approximated by extra days if needed
  const params = [securityId, timeframeId, dateFrom, dateTo, lookbackBars];
  const { rows } = await client.query(
    `WITH tail AS (
       SELECT dt, open_price, high_price, low_price, close_price, volume
       FROM prices
       WHERE security_id = $1 AND timeframe_id = $2 AND dt < $3::timestamp
       ORDER BY dt DESC
       LIMIT $5
     ),
     range AS (
       SELECT dt, open_price, high_price, low_price, close_price, volume
       FROM prices
       WHERE security_id = $1 AND timeframe_id = $2
         AND dt >= $3::timestamp AND dt <= $4::timestamp
     )
     SELECT * FROM (
       SELECT * FROM tail
       UNION ALL
       SELECT * FROM range
     ) s
     ORDER BY dt ASC`,
    params
  );
  const series = {
    dt: [],
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
  };
  for (const r of rows) {
    series.dt.push(r.dt);
    series.open.push(Number(r.open_price));
    series.high.push(Number(r.high_price));
    series.low.push(Number(r.low_price));
    series.close.push(Number(r.close_price));
    series.volume.push(r.volume == null ? NaN : Number(r.volume));
  }
  return series;
}

async function getTimeframeById(client, timeframeId) {
  const { rows } = await client.query(
    'SELECT id, tf, full_name, sec FROM timeframes WHERE id = $1',
    [timeframeId]
  );
  return rows[0] || null;
}

async function getTimeframeByCode(client, code) {
  if (code == null) return null;
  const raw = String(code).trim();
  if (!raw) return null;
  const { rows } = await client.query(
    'SELECT id, tf, full_name, sec FROM timeframes WHERE lower(tf) = lower($1) OR lower(full_name) = lower($1) LIMIT 1',
    [raw]
  );
  return rows[0] || null;
}

async function computeJsIndicatorSeries(client, opts) {
  const {
    indicator, // {id, code, js_code, calc_kind}
    securityId,
    timeframeId,
    dateFrom,
    dateTo,
    params = {},
    valueTypeCode = 'VALUE',
    lookbackBars = 500,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  if (!indicator || (indicator.calc_kind !== 'js' && !indicator.js_code)) {
    throw new Error('Индикатор не является JS-индикатором');
  }
  const compiled = compileJsIndicator(indicator.js_code, {
    timeoutMs,
    filename: `indicator-${indicator.code || indicator.id}.js`,
  });

  const baseSeries = await loadPriceSeries(client, {
    securityId,
    timeframeId,
    dateFrom,
    dateTo,
    lookbackBars,
  });
  const tf = await getTimeframeById(client, timeframeId);
  const seriesCache = new Map([[Number(timeframeId), { series: baseSeries, tf }]]);

  const fromTs = dateFrom instanceof Date ? dateFrom.getTime() : new Date(dateFrom).getTime();
  const toTs = dateTo instanceof Date ? dateTo.getTime() : new Date(dateTo).getTime();

  async function getSeriesFor(timeframeRef) {
    if (timeframeRef == null || timeframeRef === '') {
      return seriesCache.get(Number(timeframeId));
    }
    let tfRow = null;
    if (Number.isInteger(Number(timeframeRef)) && String(timeframeRef).trim() !== '') {
      tfRow = await getTimeframeById(client, Number(timeframeRef));
    }
    if (!tfRow) tfRow = await getTimeframeByCode(client, timeframeRef);
    if (!tfRow) return seriesCache.get(Number(timeframeId));
    const key = Number(tfRow.id);
    if (!seriesCache.has(key)) {
      const s = await loadPriceSeries(client, {
        securityId,
        timeframeId: tfRow.id,
        dateFrom,
        dateTo,
        lookbackBars,
      });
      seriesCache.set(key, { series: s, tf: tfRow });
    }
    return seriesCache.get(key);
  }

  // pre-resolve default timeframe for ctx.bars in common case
  const defaultCtxSeries = seriesCache.get(Number(timeframeId));

  const results = [];
  for (let i = 0; i < baseSeries.dt.length; i++) {
    const dt = baseSeries.dt[i];
    const ts = dt instanceof Date ? dt.getTime() : new Date(dt).getTime();
    if (!Number.isFinite(ts)) continue;
    if (Number.isFinite(fromTs) && ts < fromTs) continue;
    if (Number.isFinite(toTs) && ts > toTs) continue;

    const ctx = {
      securityId,
      timeframeId,
      timeframe: tf ? tf.tf : null,
      dt,
      index: i,
      bars: (req = {}) => {
        // synchronous contract: only base timeframe guaranteed without async; support cached extra TFs by prefetch hint
        let pack = defaultCtxSeries;
        const tfRef = req.timeframe ?? req.tf ?? req.timeframe_id;
        if (tfRef != null && tfRef !== '') {
          // try cache by id/code lookup already loaded
          const cached = [...seriesCache.values()].find(
            (v) => v.tf && (String(v.tf.id) === String(tfRef) || String(v.tf.tf).toLowerCase() === String(tfRef).toLowerCase())
          );
          if (cached) pack = cached;
          // if not cached we cannot async-load here; fall back to base and expose requested tf marker
        }
        const count = req.count ?? req.bars ?? req.period ?? params.period ?? params.bars ?? 0;
        // align end index by dt for alternate timeframe
        let endIdx = i;
        if (pack !== defaultCtxSeries) {
          // find index with dt <= current dt
          const arr = pack.series.dt;
          let lo = 0, hi = arr.length - 1, found = -1;
          const curTs = ts;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const mts = arr[mid] instanceof Date ? arr[mid].getTime() : new Date(arr[mid]).getTime();
            if (mts <= curTs) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
          }
          endIdx = found;
        }
        if (endIdx < 0) return buildBarsView({ dt: [], open: [], high: [], low: [], close: [], volume: [] }, 0, 0, { timeframe: pack.tf ? pack.tf.tf : null });
        return buildBarsView(pack.series, endIdx, count, { timeframe: pack.tf ? pack.tf.tf : null });
      },
    };

    // prefetch requested alternate timeframe if params.tf present (best-effort)
    if (params && (params.tf || params.timeframe) && seriesCache.size === 1) {
      try { await getSeriesFor(params.tf || params.timeframe); } catch (_) { /* ignore */ }
    }

    let outValue = null;
    try {
      outValue = compiled.run(ctx, params);
    } catch (err) {
      throw new Error(`Ошибка вычисления JS-индикатора ${indicator.code || indicator.id} на ${new Date(ts).toISOString()}: ${err.message || err}`);
    }

    let value = null;
    let values = null;
    if (outValue && typeof outValue === 'object') {
      values = outValue;
      const key = String(valueTypeCode || 'VALUE').toUpperCase();
      value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    } else {
      value = outValue == null ? null : Number(outValue);
      if (!Number.isFinite(value)) value = null;
    }

    results.push({ dt, value, values, series: valueTypeCode || 'VALUE' });
  }

  return results;
}

async function upsertIndicatorValues(client, { indicatorId, valueTypeId, securityId, timeframeId, rows }) {
  if (!rows || rows.length === 0) return 0;
  let affected = 0;
  const chunkSize = 500;
  for (let off = 0; off < rows.length; off += chunkSize) {
    const chunk = rows.slice(off, off + chunkSize);
    const params = [indicatorId, valueTypeId, securityId, timeframeId];
    let p = 5;
    const tuples = [];
    for (const r of chunk) {
      if (r.value == null || !Number.isFinite(Number(r.value))) continue;
      params.push(r.dt, Number(r.value));
      tuples.push(`($1,$2,$3,$4,$${p}::timestamp,$${p + 1}::numeric)`);
      p += 2;
    }
    if (tuples.length === 0) continue;
    const sql = `INSERT INTO indicator_values (indicator_id, indicator_value_type_id, security_id, timeframe_id, dt, value)
                 VALUES ${tuples.join(',')}
                 ON CONFLICT (indicator_id, indicator_value_type_id, security_id, timeframe_id, dt)
                 DO UPDATE SET value = EXCLUDED.value`;
    const res = await client.query(sql, params);
    affected += res.rowCount || 0;
  }
  return affected;
}

function rowsForValueType(computed, code) {
  const key = String(code || 'VALUE').toUpperCase();
  return computed.map((r) => {
    let v = null;
    if (r.values && typeof r.values === 'object') {
      if (Object.prototype.hasOwnProperty.call(r.values, key)) v = r.values[key];
      else if (Object.prototype.hasOwnProperty.call(r.values, code)) v = r.values[code];
      else v = null;
    } else {
      v = r.value;
    }
    const n = v == null ? null : Number(v);
    return { dt: r.dt, value: Number.isFinite(n) ? n : null };
  });
}

async function calculateJsIndicator(client, {
  indicatorId,
  securityId,
  timeframeId,
  dateFrom,
  dateTo,
  params = {},
  seriesCode = 'VALUE',
  overwrite = true,
}) {
  const { rows: indRows } = await client.query(
    'SELECT id, code, name, js_code, calc_kind, is_custom FROM indicators WHERE id = $1',
    [indicatorId]
  );
  const indicator = indRows[0];
  if (!indicator) throw new Error('Индикатор не найден');
  if (indicator.calc_kind !== 'js' || !indicator.js_code) {
    throw new Error('Индикатор не является JS-индикатором или не содержит js_code');
  }

  const { rows: vtRows } = await client.query(
    'SELECT id, code FROM indicator_value_types WHERE indicator_id = $1 ORDER BY display_order, id',
    [indicatorId]
  );
  let vt = vtRows.find((t) => String(t.code).toUpperCase() === String(seriesCode || 'VALUE').toUpperCase()) || null;
  if (!vt) {
    vt = vtRows.find((t) => String(t.code).toUpperCase() === 'VALUE') || vtRows[0] || null;
  }
  if (!vt) throw new Error('Не найден тип значения (indicator_value_types) для индикатора');

  if (overwrite) {
    await client.query(
      `DELETE FROM indicator_values
       WHERE indicator_id = $1 AND indicator_value_type_id = $2 AND security_id = $3 AND timeframe_id = $4
         AND dt >= $5::timestamp AND dt <= $6::timestamp`,
      [indicatorId, vt.id, securityId, timeframeId, dateFrom, dateTo]
    );
  }

  const computed = await computeJsIndicatorSeries(client, {
    indicator,
    securityId,
    timeframeId,
    dateFrom,
    dateTo,
    params,
    valueTypeCode: vt.code || seriesCode || 'VALUE',
  });
  const rows = rowsForValueType(computed, vt.code || seriesCode || 'VALUE');
  const written = await upsertIndicatorValues(client, {
    indicatorId,
    valueTypeId: vt.id,
    securityId,
    timeframeId,
    rows,
  });
  return { written, computed: computed.length, value_type_id: vt.id, series: vt.code };
}

async function resolveJsSyncRange(client, {
  securityId,
  timeframeId,
  indicatorId = null,
  endDt = null,
  pointCount = null,
  incremental = true,
  lookbackBars = 300,
}) {
  const toRes = await client.query(
    `SELECT COALESCE($3::timestamp, MAX(dt)) AS to_dt
     FROM prices
     WHERE security_id = $1 AND timeframe_id = $2
       AND ($3::timestamp IS NULL OR dt <= $3::timestamp)`,
    [securityId, timeframeId, endDt]
  );
  const toDt = toRes.rows[0]?.to_dt || null;
  if (!toDt) return null;

  const effectivePointCount = Number.isInteger(pointCount) && pointCount > 0
    ? pointCount
    : (incremental ? 500 : null);

  if (effectivePointCount) {
    const fromRes = await client.query(
      `SELECT dt FROM (
         SELECT dt FROM prices
         WHERE security_id = $1 AND timeframe_id = $2 AND dt <= $3::timestamp
         ORDER BY dt DESC
         LIMIT $4
       ) s
       ORDER BY dt ASC
       LIMIT 1`,
      [securityId, timeframeId, toDt, effectivePointCount]
    );
    const fromDt = fromRes.rows[0]?.dt || toDt;
    return { from: fromDt, to: toDt, pointCount: effectivePointCount };
  }

  if (!incremental) {
    const fromRes = await client.query(
      `SELECT MIN(dt) AS from_dt FROM prices WHERE security_id = $1 AND timeframe_id = $2 AND dt <= $3::timestamp`,
      [securityId, timeframeId, toDt]
    );
    return { from: fromRes.rows[0]?.from_dt || toDt, to: toDt, pointCount: null };
  }

  if (indicatorId) {
    const lastRes = await client.query(
      `SELECT MAX(dt) AS last_dt
       FROM indicator_values
       WHERE indicator_id = $1 AND security_id = $2 AND timeframe_id = $3 AND dt <= $4::timestamp`,
      [indicatorId, securityId, timeframeId, toDt]
    );
    const lastDt = lastRes.rows[0]?.last_dt;
    if (lastDt) {
      const fromRes = await client.query(
        `SELECT COALESCE((
           SELECT dt FROM prices
           WHERE security_id = $1 AND timeframe_id = $2 AND dt < $3::timestamp
           ORDER BY dt DESC
           OFFSET $4 LIMIT 1
         ), (SELECT MIN(dt) FROM prices WHERE security_id = $1 AND timeframe_id = $2)) AS from_dt`,
        [securityId, timeframeId, lastDt, Math.max(0, Number(lookbackBars) || 0)]
      );
      return { from: fromRes.rows[0]?.from_dt || lastDt, to: toDt, pointCount: null };
    }
  }

  const fromRes = await client.query(
    `SELECT dt FROM (
       SELECT dt FROM prices
       WHERE security_id = $1 AND timeframe_id = $2 AND dt <= $3::timestamp
       ORDER BY dt DESC
       LIMIT 500
     ) s
     ORDER BY dt ASC
     LIMIT 1`,
    [securityId, timeframeId, toDt]
  );
  return { from: fromRes.rows[0]?.dt || toDt, to: toDt, pointCount: 500 };
}

async function syncJsIndicator(client, {
  indicatorId,
  securityId,
  timeframeId,
  endDt = null,
  pointCount = null,
  incremental = true,
  params = {},
  seriesCode = null,
}) {
  const { rows: indRows } = await client.query(
    `SELECT i.id, i.code, i.name, i.js_code, i.calc_kind, i.is_custom, i.is_active
     FROM indicators i WHERE i.id = $1`,
    [indicatorId]
  );
  const indicator = indRows[0];
  if (!indicator) throw new Error('Индикатор не найден');
  if (!(indicator.calc_kind === 'js' || (indicator.js_code && String(indicator.js_code).trim()))) {
    return { skipped: true, reason: 'not_js' };
  }

  const range = await resolveJsSyncRange(client, {
    securityId,
    timeframeId,
    indicatorId,
    endDt,
    pointCount,
    incremental,
  });
  if (!range) {
    return { skipped: true, reason: 'no_prices', indicator_id: indicatorId };
  }

  const { rows: vtRows } = await client.query(
    `SELECT id, code FROM indicator_value_types
     WHERE indicator_id = $1
     ORDER BY display_order, id`,
    [indicatorId]
  );
  let types = vtRows;
  if (seriesCode) {
    types = vtRows.filter((t) => String(t.code).toUpperCase() === String(seriesCode).toUpperCase());
  }
  if (types.length === 0) {
    types = [{ id: null, code: seriesCode || 'VALUE' }];
  }

  // Compute once, then distribute values to all requested series/types.
  const computed = await computeJsIndicatorSeries(client, {
    indicator,
    securityId,
    timeframeId,
    dateFrom: range.from,
    dateTo: range.to,
    params,
    valueTypeCode: types[0]?.code || seriesCode || 'VALUE',
  });

  let totalWritten = 0;
  const perSeries = [];
  for (const vt of types) {
    if (!vt.id) {
      perSeries.push({ series: vt.code || seriesCode || 'VALUE', written: 0, computed: computed.length, error: 'value_type_missing' });
      continue;
    }
    const code = vt.code || seriesCode || 'VALUE';
    if (!incremental) {
      await client.query(
        `DELETE FROM indicator_values
         WHERE indicator_id = $1 AND indicator_value_type_id = $2 AND security_id = $3 AND timeframe_id = $4
           AND dt >= $5::timestamp AND dt <= $6::timestamp`,
        [indicatorId, vt.id, securityId, timeframeId, range.from, range.to]
      );
    }
    const rows = rowsForValueType(computed, code);
    const written = await upsertIndicatorValues(client, {
      indicatorId,
      valueTypeId: vt.id,
      securityId,
      timeframeId,
      rows,
    });
    totalWritten += Number(written || 0);
    perSeries.push({ series: code, written, computed: computed.length, value_type_id: vt.id });
  }

  return {
    ok: true,
    mode: 'js',
    indicator_id: indicatorId,
    code: indicator.code,
    from: range.from,
    to: range.to,
    pointCount: range.pointCount,
    incremental,
    written: totalWritten,
    computed: computed.length,
    series: perSeries,
  };
}

module.exports = {
  parseSignalParamsObject,
  compileJsIndicator,
  buildBarsView,
  loadPriceSeries,
  computeJsIndicatorSeries,
  upsertIndicatorValues,
  calculateJsIndicator,
  resolveJsSyncRange,
  syncJsIndicator,
};
