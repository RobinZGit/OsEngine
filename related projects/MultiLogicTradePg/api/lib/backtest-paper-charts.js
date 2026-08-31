'use strict';

/**
 * Loads per-security candles / indicator values / closes rows and builds
 * the `paperCharts` model for the archive backtest report (#848/#856).
 * SQL mirrors the web/persist stack but avoids indicator_value_types.display_order
 * so it works both on the current deployed DB and after schema upgrades.
 */

const overlays = require('./backtest-chart-overlays');
const papers = require('./backtest-report-papers');

const REPORT_MAX_PAPERS = 12;
const REPORT_MAX_CANDLES = 2000;
const REPORT_PRICE_PAGES = 40;
const REPORT_CANDLE_BATCH = 500;
const REPORT_INDICATOR_LIMIT = 4000;

function dayStart(raw) {
  const s = String(raw || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? `${m[1]} 00:00:00` : null;
}

function dayEnd(raw) {
  const s = String(raw || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? `${m[1]} 23:59:59` : null;
}

/** Свечи бумаги в окне сделок (пагинация DESC от конца окна, финал ASC, кап 2000). */
async function loadReportCandles(pool, securityId, timeframeId, win) {
  const firstKey = win && win.from ? String(win.from).replace('T', ' ').slice(0, 19) : null;
  const batches = [];
  // Якорь «before» — конец окна сделок (win.to), а не самые свежие цены:
  // иначе на старых периодах (окно далеко в прошлом) пагинация с самых новых
  // строк не доходит до окна за лимит страниц и свечи приходят не той эпохи,
  // из-за чего график индикаторов не совпадает по времени со свечами.
  let before = win && win.to ? String(win.to).replace('T', ' ').slice(0, 19) : null;
  for (let i = 0; i < REPORT_PRICE_PAGES; i++) {
    const params = [securityId, timeframeId, REPORT_CANDLE_BATCH];
    let beforeClause = '';
    if (before) {
      beforeClause = 'AND p.dt < $4::timestamp';
      params.push(before);
    }
    const { rows } = await pool.query(
      `SELECT
         to_char(p.dt, 'YYYY-MM-DD HH24:MI:SS') AS dt,
         p.open_price, p.high_price, p.low_price, p.close_price, p.volume
       FROM prices p
       WHERE p.security_id = $1 AND p.timeframe_id = $2 ${beforeClause}
       ORDER BY p.dt DESC LIMIT $3`,
      params
    );
    if (!rows || rows.length === 0) break;
    rows.reverse();
    batches.push(rows);
    const head = rows[0].dt || '';
    if (firstKey && head <= firstKey) break;
    if (rows.length < REPORT_CANDLE_BATCH) break;
    before = rows[0].dt;
  }
  const out = batches.reverse().flat();
  return out.length > REPORT_MAX_CANDLES ? out.slice(-REPORT_MAX_CANDLES) : out;
}

/**
 * Значения сигнальных индикаторов за окно сделок, кап 4000.
 * Без display_order — корректно для текущей развёрнутой БД.
 * Возвращает null, если индикаторы недоступны (ошибка/нет значений).
 */
async function loadReportIndicatorValues(pool, securityId, timeframeId, indicatorIds, win) {
  if (!indicatorIds || indicatorIds.length === 0) return [];
  const params = [securityId, timeframeId, indicatorIds];
  let rangeClause = '';
  const after = win?.from ? dayStart(win.from) : null;
  const before = win?.to ? dayEnd(win.to) : null;
  if (before) {
    params.push(before);
    rangeClause += ` AND iv.dt <= $${params.length}::timestamp`;
  }
  if (after) {
    params.push(after);
    rangeClause += ` AND iv.dt >= $${params.length}::timestamp`;
  }
  params.push(REPORT_INDICATOR_LIMIT);
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT iv.indicator_id, i.code AS indicator_code, ivt.code AS line_code,
              ivt.name AS line_name, to_char(iv.dt, 'YYYY-MM-DD HH24:MI:SS') AS dt,
              iv.value, ivt.is_threshold
       FROM indicator_values iv
       JOIN indicators i ON i.id = iv.indicator_id
       JOIN indicator_value_types ivt ON ivt.id = iv.indicator_value_type_id
       WHERE iv.security_id = $1 AND iv.timeframe_id = $2 AND iv.indicator_id = ANY($3::int[])
       ${rangeClause}
       ORDER BY iv.dt DESC, iv.indicator_id, ivt.code, ivt.id
       LIMIT $${params.length}
     ) t
     ORDER BY t.dt, t.indicator_id, t.line_code`,
    params
  );
  return rows;
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ run: object, trades: object[], tradeLots: Map<number, object[]>, signalIndicatorIds: number[] }} ctx
 */
async function buildPaperChartsForRun(pool, ctx) {
  const { run, trades, tradeLots, signalIndicatorIds = [] } = ctx;
  if (!Array.isArray(trades) || trades.length === 0) return [];

  const from = run?.date_from;
  const to = run?.date_to;
  const tf = trades[0].timeframe_id != null ? Number(trades[0].timeframe_id) : null;

  const papersList = overlays.papersWithTrades(trades, from, to, null).slice(
    0,
    REPORT_MAX_PAPERS
  );
  const charts = [];

  for (const p of papersList) {
    const secId = Number(p.security_id);
    if (!Number.isFinite(secId) || secId <= 0) continue;
    let secTrades;
    let win;
    try {
      secTrades = overlays.tradesForSecurity(trades, secId, from, to);
      win = overlays.tradeDtWindow(secTrades);
    } catch (err) {
      console.warn('paper window failed', secId, err?.message || err);
      continue;
    }

    let candles = [];
    let loadError = null;
    if (win && tf != null) {
      try {
        candles = await loadReportCandles(pool, secId, tf, win);
      } catch (err) {
        loadError = 'Не удалось загрузить котировки (API цен).';
        console.warn('paper candles failed', secId, err?.message || err);
      }
    }

    let indicators = [];
    if (loadError === null && win && signalIndicatorIds.length > 0 && tf != null) {
      try {
        const values = await loadReportIndicatorValues(
          pool,
          secId,
          tf,
          signalIndicatorIds,
          win
        );
        indicators = papers.buildPaperIndicatorSeries(values);
      } catch (err) {
        console.warn('paper indicators failed', secId, err?.message || err);
      }
    }

    try {
      const closes = papers.buildPaperReportCloseRows(
        trades.filter((t) => Number(t.security_id) === secId),
        tradeLots
      );
      const equity = overlays.buildEquityPoints(secTrades, from);
      const equityShadow = overlays.buildShadowEquityPoints(secTrades, from);
      const shaded = [
        ...overlays.buildShadedDisabledRanges(secTrades, from, to),
        ...overlays.buildSideOpenShadedRanges(secTrades),
      ].sort((a, b) => overlays.dtKey(a.startDt).localeCompare(overlays.dtKey(b.startDt)));
      const markers = overlays.buildTradeMarkers(secTrades);
      const stops = overlays.buildStopMarkers(secTrades);

      charts.push({
        securityId: secId,
        securityName: p.security_name,
        securityPrefix: p.security_prefix,
        timeframeLabel: (secTrades[0]?.timeframe_tf) || String(tf ?? ''),
        candles,
        indicators,
        trades: secTrades,
        markers,
        stops,
        shaded,
        equity,
        equityShadow,
        closes,
        pnl: p.pnl,
        dealCount: p.trade_count,
        openQty: p.open_qty,
        lastPrice: p.last_price,
        loadError,
      });
    } catch (err) {
      console.warn('paper chart build failed', secId, err?.message || err);
    }
  }

  return charts;
}

module.exports = { buildPaperChartsForRun };