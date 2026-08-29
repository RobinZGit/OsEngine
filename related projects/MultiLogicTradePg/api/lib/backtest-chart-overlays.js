'use strict';

/**
 * Server-side mirror of web/src/app/logics/backtest-chart-overlays.ts
 * for archive persistence of the paper blocks in backtest reports.
 */

/** YYYY-MM-DD for date-only period from API. */
function asDateOnly(raw) {
  if (!raw) return '';
  const s = String(raw);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function dtKey(dt) {
  return String(dt || '')
    .replace('T', ' ')
    .replace(/Z$/i, '')
    .replace(/\.\d+/, '')
    .slice(0, 19);
}

/** YYYY-MM-DD for period filters (ISO date_from from API must not break papers list). */
function periodDay(raw) {
  return asDateOnly(raw);
}

/** Единый числовой id бумаги — иначе pin «327» vs сделки 327 → ост. 0 и дубль строки. */
function paperSecurityId(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Минимальная / максимальная дата сделок бумаги (для окна графика). */
function tradeDtWindow(trades) {
  const keys = trades
    .map((t) => dtKey(t.bar_dt || t.executed_at))
    .filter((k) => k.length >= 10)
    .sort();
  if (keys.length === 0) return null;
  return { from: keys[0], to: keys[keys.length - 1] };
}

function tradesForSecurity(trades, securityId, dateFrom, dateTo) {
  const fromDay = periodDay(dateFrom);
  const toDay = periodDay(dateTo);
  const fromKey = fromDay ? `${fromDay} 00:00:00` : null;
  const toKey = toDay ? `${toDay} 23:59:59` : null;
  const secId = paperSecurityId(securityId);
  return trades
    .filter((t) => {
      if (paperSecurityId(t.security_id) !== secId) return false;
      const key = dtKey(t.bar_dt || t.executed_at);
      if (fromKey && key < fromKey) return false;
      if (toKey && key > toKey) return false;
      return t.status === 'filled' || t.status === 'submitted';
    })
    .sort((a, b) => dtKey(a.bar_dt).localeCompare(dtKey(b.bar_dt)));
}

function emptyPaperRow(securityId, securityName, securityPrefix) {
  return {
    security_id: securityId,
    security_name: securityName,
    security_prefix: securityPrefix,
    pnl: 0,
    commission: 0,
    trade_count: 0,
    open_qty: 0,
    last_price: null,
    position_value: 0,
  };
}

/** Бумаги, по которым были сделки; optional pin (денежный фонд) — всегда сверху. */
function papersWithTrades(trades, dateFrom, dateTo, pinned) {
  const fromDay = periodDay(dateFrom);
  const toDay = periodDay(dateTo);
  const fromKey = fromDay ? `${fromDay} 00:00:00` : null;
  const toKey = toDay ? `${toDay} 23:59:59` : null;
  const map = new Map();
  const lastOpenPx = new Map();
  for (const t of trades) {
    if (t.status !== 'filled' && t.status !== 'submitted') continue;
    const key = dtKey(t.bar_dt || t.executed_at);
    if (fromKey && key < fromKey) continue;
    if (toKey && key > toKey) continue;
    const secId = paperSecurityId(t.security_id);
    if (secId <= 0) continue;
    const row = map.get(secId) ?? emptyPaperRow(secId, t.security_name, t.security_prefix);
    row.trade_count += 1;
    if (
      !t.is_shadow &&
      t.financial_result != null &&
      Number.isFinite(Number(t.financial_result))
    ) {
      row.pnl += Number(t.financial_result);
    }
    if (!t.is_shadow && t.commission != null && Number.isFinite(Number(t.commission))) {
      row.commission += Number(t.commission);
    }
    if (!t.is_shadow && t.side_name === 'Open') {
      const remRaw = t.remaining_qty;
      const rem =
        remRaw == null || !Number.isFinite(Number(remRaw))
          ? Number(t.quantity)
          : Number(remRaw);
      if (rem > 0) {
        row.open_qty += t.action_name === 'Short' ? -rem : rem;
        const px = Number(t.price);
        if (Number.isFinite(px) && px > 0) {
          const prev = lastOpenPx.get(secId);
          if (!prev || key >= prev.dt) {
            lastOpenPx.set(secId, { dt: key, px });
          }
        }
      }
    }
    map.set(secId, row);
  }
  for (const [secId, row] of map) {
    applyPaperMarkValue(row, lastOpenPx.get(secId)?.px ?? null);
  }
  const sorted = [...map.values()].sort((a, b) =>
    (a.security_prefix || a.security_name).localeCompare(
      b.security_prefix || b.security_name,
      'ru'
    )
  );
  const pinId = paperSecurityId(pinned?.security_id);
  if (!pinned || pinId <= 0) {
    return sorted;
  }
  const pinPrefix = String(pinned.security_prefix ?? '')
    .trim()
    .toUpperCase();
  let fromTrades = map.get(pinId);
  if (!fromTrades && pinPrefix) {
    fromTrades = sorted.find(
      (r) =>
        String(r.security_prefix ?? '')
          .trim()
          .toUpperCase() === pinPrefix
    );
  }
  const headId = fromTrades?.security_id ?? pinId;
  const head = {
    security_id: headId,
    security_name: pinned.security_name || fromTrades?.security_name || '',
    security_prefix: pinned.security_prefix ?? fromTrades?.security_prefix ?? null,
    pnl: fromTrades?.pnl ?? 0,
    commission: fromTrades?.commission ?? 0,
    trade_count: fromTrades?.trade_count ?? 0,
    open_qty: fromTrades?.open_qty ?? 0,
    last_price: fromTrades?.last_price ?? null,
    position_value: fromTrades?.position_value ?? 0,
  };
  return [
    head,
    ...sorted.filter((r) => paperSecurityId(r.security_id) !== paperSecurityId(headId)),
  ];
}

/** Оценка открытого остатка в деньгах. */
function applyPaperMarkValue(row, markPrice) {
  const px = Number(markPrice);
  if (!Number.isFinite(px) || px <= 0 || row.open_qty === 0) {
    if (row.open_qty === 0) {
      row.last_price = null;
      row.position_value = 0;
    }
    return;
  }
  row.last_price = px;
  row.position_value = Math.abs(row.open_qty) * px;
}

function buildTradeMarkers(trades) {
  return trades.map((t) => ({
    dt: t.bar_dt || t.executed_at,
    price: Number(t.price),
    kind: t.side_name === 'Close' ? 'close' : 'open',
    side: t.action_name === 'Short' ? 'short' : 'long',
    isShadow: Boolean(t.is_shadow),
    label: t.trade_reason || undefined,
  }));
}

function shortenStopLabel(reason) {
  const s = reason.trim();
  if (s.length <= 42) return s;
  return `${s.slice(0, 40)}…`;
}

function buildStopMarkers(trades) {
  const out = [];
  for (const t of trades) {
    if (t.side_name !== 'Close' || !t.trade_reason) continue;
    const reason = t.trade_reason.toLowerCase();
    let ruleKind = 'other';
    if (reason.includes('stop_loss') || reason.startsWith('stop')) {
      ruleKind = 'stop_loss';
    } else if (reason.includes('take_profit') || reason.includes('take')) {
      ruleKind = 'take_profit';
    } else {
      continue;
    }
    out.push({
      dt: t.bar_dt || t.executed_at,
      price: Number(t.price),
      ruleKind,
      label: shortenStopLabel(t.trade_reason),
    });
  }
  return out;
}

function paperModeLabel(kind) {
  if (kind === 'shadow') return 'shadow';
  if (kind === 'inverted') return 'инверсия';
  return 'обычная';
}

/** Зоны режима бумаги на весь период теста (normal/shadow/inverted). */
function buildShadedDisabledRanges(trades, periodStartDt, periodEndDt) {
  const sorted = [...trades].sort((a, b) => {
    const ka = dtKey(a.bar_dt || a.executed_at);
    const kb = dtKey(b.bar_dt || b.executed_at);
    if (ka !== kb) return ka.localeCompare(kb);
    const rank = (t) => (t.side_name === 'Close' ? 0 : t.side_name === 'Open' ? 1 : 2);
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return Number(a.id ?? 0) - Number(b.id ?? 0);
  });

  const firstTradeDt = sorted.length ? sorted[0].bar_dt || sorted[0].executed_at : null;
  const lastTradeDt = sorted.length
    ? sorted[sorted.length - 1].bar_dt || sorted[sorted.length - 1].executed_at
    : null;
  const startDt = (periodStartDt && String(periodStartDt).trim()) || firstTradeDt;
  let endDt = (periodEndDt && String(periodEndDt).trim()) || lastTradeDt;
  if (lastTradeDt && endDt && dtKey(lastTradeDt) > dtKey(endDt)) {
    endDt = lastTradeDt;
  }
  if (!startDt || !endDt) {
    return [];
  }

  const ranges = [];
  const state = {
    mode: 'normal',
    rangeStart: startDt,
    inverted: false,
    pendingInversionToggle: false,
  };

  const flush = (untilDt) => {
    if (!state.rangeStart) return;
    if (dtKey(untilDt) < dtKey(state.rangeStart)) return;
    ranges.push({
      startDt: state.rangeStart,
      endDt: untilDt,
      label: paperModeLabel(state.mode),
      kind: state.mode,
    });
  };

  const switchMode = (next, atDt) => {
    if (next === state.mode) return;
    flush(atDt);
    state.mode = next;
    state.rangeStart = atDt;
  };

  for (const t of sorted) {
    const dt = t.bar_dt || t.executed_at;
    if (!dt) continue;
    const reason = (t.trade_reason || '').toLowerCase();
    const isInversionStop =
      t.side_name === 'Close' && reason.includes('security_inversion');
    const isPortfolioPause =
      t.side_name === 'Close' &&
      (reason.includes('portfolio_resume') ||
        reason.includes('portfolio_ltp_renew') ||
        ((reason.includes('portfolio') || reason.includes('портфел')) &&
          (reason.includes('stop_loss') || reason.includes('take_profit'))));
    const isStopPause =
      t.side_name === 'Close' &&
      (reason.includes('stop_loss') || reason.includes('security_resume'));

    if (isStopPause || isInversionStop || isPortfolioPause) {
      if (isInversionStop) {
        state.pendingInversionToggle = true;
      }
      switchMode('shadow', dt);
      continue;
    }

    if (t.is_shadow) {
      switchMode('shadow', dt);
      continue;
    }

    if (state.mode === 'shadow' && t.side_name === 'Open') {
      if (state.pendingInversionToggle) {
        state.inverted = !state.inverted;
        state.pendingInversionToggle = false;
      }
      switchMode(state.inverted ? 'inverted' : 'normal', dt);
      continue;
    }
  }

  flush(endDt);
  return ranges;
}

/** Кумулятивный PnL по закрытиям (обычная серия; shadow — в buildShadowEquityPoints). */
function buildEquityPoints(trades, periodStartDt, sideFilter, opts) {
  const shadowOnly = Boolean(opts?.shadowOnly);
  const includeShadow = Boolean(opts?.includeShadow);
  const sorted = [...trades].sort((a, b) =>
    dtKey(a.bar_dt || a.executed_at).localeCompare(dtKey(b.bar_dt || b.executed_at))
  );
  const closes = sorted.filter((t) => {
    if (t.side_name !== 'Close') return false;
    if (shadowOnly) {
      if (!t.is_shadow) return false;
    } else if (!includeShadow && t.is_shadow) {
      return false;
    }
    if ((t.opt_lane ?? '') !== '') return false;
    if (t.status != null && t.status !== 'filled' && t.status !== 'submitted') return false;
    if (t.financial_result == null || !Number.isFinite(Number(t.financial_result))) return false;
    if (sideFilter === 'long' && t.action_name !== 'Long') return false;
    if (sideFilter === 'short' && t.action_name !== 'Short') return false;
    return true;
  });

  const periodKey = periodStartDt ? dtKey(periodStartDt) : '';
  const firstAnyDt = sorted[0]?.bar_dt || sorted[0]?.executed_at || null;
  const firstCloseDt = closes[0]?.bar_dt || closes[0]?.executed_at || null;
  const anchorDt = firstAnyDt || firstCloseDt;
  const zeroDt = shadowOnly
    ? firstCloseDt
    : periodKey && (!anchorDt || periodKey <= dtKey(anchorDt))
      ? periodStartDt
      : anchorDt;

  if (closes.length === 0) {
    if (shadowOnly || !zeroDt) return [];
    return [{ dt: zeroDt, value: 0 }];
  }

  let cum = 0;
  const points = [{ dt: zeroDt, value: 0 }];
  for (const t of closes) {
    cum += Number(t.financial_result);
    const dt = t.bar_dt || t.executed_at;
    if (points.length === 1 && dtKey(points[0].dt) === dtKey(dt) && points[0].value === 0) {
      points[0] = { dt, value: cum };
    } else {
      points.push({ dt, value: cum });
    }
  }
  return points;
}

/** Теневая эквити (только shadow Close) — для пунктира на графике. */
function buildShadowEquityPoints(trades, periodStartDt, sideFilter, sinceDt) {
  const sinceKey = sinceDt ? dtKey(sinceDt) : '';
  const scoped = sinceKey
    ? trades.filter((t) => dtKey(t.bar_dt || t.executed_at) >= sinceKey)
    : trades;
  return buildEquityPoints(scoped, sinceDt || periodStartDt, sideFilter, { shadowOnly: true });
}

/** Зоны открытых позиций по сторонам (long = бледно-зелёная, short = бледно-красная). */
function buildSideOpenShadedRanges(trades) {
  const relevant = trades
    .filter(
      (t) =>
        t.side_name != null &&
        (t.action_name === 'Long' || t.action_name === 'Short') &&
        !t.is_shadow &&
        (t.opt_lane ?? '') === '' &&
        (t.status == null || t.status === 'filled' || t.status === 'submitted')
    )
    .sort((a, b) => {
      const ka = dtKey(a.bar_dt || a.executed_at);
      const kb = dtKey(b.bar_dt || b.executed_at);
      if (ka !== kb) return ka.localeCompare(kb);
      const ra = (t) => (t.side_name === 'Open' ? 0 : 1);
      const r = ra(a) - ra(b);
      if (r !== 0) return r;
      return Number(a.id ?? 0) - Number(b.id ?? 0);
    });

  let lastDt = '';
  for (const t of trades) {
    const k = dtKey(t.bar_dt || t.executed_at);
    if (k > lastDt) lastDt = k;
  }

  const ranges = [];
  const state = {
    long: { open: 0, start: null },
    short: { open: 0, start: null },
  };

  const closeSide = (side, endDt) => {
    const st = state[side];
    if (st.open <= 0 || !st.start) return;
    st.open = Math.max(0, st.open - 1);
    if (st.open === 0 && st.start <= endDt) {
      ranges.push({ startDt: st.start, endDt, kind: side });
    }
    if (st.open === 0) st.start = null;
  };

  for (const t of relevant) {
    const side = t.action_name === 'Long' ? 'long' : 'short';
    const k = dtKey(t.bar_dt || t.executed_at);
    if (t.side_name === 'Open') {
      if (state[side].open === 0) state[side].start = k;
      state[side].open += 1;
    } else {
      closeSide(side, k);
    }
  }

  for (const side of ['long', 'short']) {
    const st = state[side];
    if (st.open > 0 && st.start && lastDt >= st.start) {
      ranges.push({ startDt: st.start, endDt: lastDt, kind: side });
    }
  }

  return ranges.sort((a, b) => a.startDt.localeCompare(b.startDt));
}

module.exports = {
  dtKey,
  tradeDtWindow,
  tradesForSecurity,
  papersWithTrades,
  buildTradeMarkers,
  buildStopMarkers,
  buildShadedDisabledRanges,
  buildSideOpenShadedRanges,
  buildEquityPoints,
  buildShadowEquityPoints,
};