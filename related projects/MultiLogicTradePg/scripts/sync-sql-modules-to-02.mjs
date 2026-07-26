#!/usr/bin/env node
/**
 * Подставляет модули sql/*.sql в 02_multilogictrade_functions_and_procedures.sql
 * (секции с @include-комментариями).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function replaceBetween(content, startMarker, endMarker, replacement, label) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`sync-02: markers not found for ${label}`);
  }
  const next =
    typeof replacement === 'function' ? replacement() : replacement;
  return content.slice(0, start) + next + content.slice(end);
}

let sql02 = read('02_multilogictrade_functions_and_procedures.sql');
const tradeTail = read('sql/logic_trade_runner.sql');

// stop_runner: только @begin/@end. Нельзя якориться на logic_long_position_qty —
// эта функция внутри модуля; старый sync вкладывал include сам в себя (×N).
{
  const stopRunner = read('sql/logic_stop_runner.sql').trimEnd() + '\n';
  const beginMark = '-- @begin logic_stop_runner';
  const endMark = '-- @end logic_stop_runner';
  const includeMark = '-- @include sql/logic_stop_runner.sql';
  const block = `${beginMark}\n${stopRunner}${endMark}\n`;

  let start = sql02.indexOf(beginMark);
  if (start === -1) start = sql02.indexOf(includeMark);
  // Хвост после stop_runner — lot helpers из trade_runner (не calc_open: его вырезает следующий sync).
  const lotAnchor = 'CREATE OR REPLACE FUNCTION logic_security_lot_size(';
  let endExclusive = sql02.indexOf(lotAnchor);
  if (endExclusive === -1) {
    endExclusive = sql02.indexOf('CREATE OR REPLACE FUNCTION logic_calc_open_quantity(');
  }
  if (start === -1 || endExclusive === -1 || endExclusive <= start) {
    throw new Error(
      'sync-02: cannot place logic_stop_runner (need @begin/@include and logic_security_lot_size or logic_calc_open_quantity)'
    );
  }
  sql02 = sql02.slice(0, start) + block + sql02.slice(endExclusive);
}

const lotStart = tradeTail.indexOf('CREATE OR REPLACE FUNCTION logic_security_lot_size');
const lotEnd = tradeTail.indexOf('CREATE OR REPLACE FUNCTION logic_upsert_param(');
if (lotStart === -1 || lotEnd === -1) {
  throw new Error('sync-02: logic_security_lot_size / logic_upsert_param not found in logic_trade_runner.sql');
}
const lotBlock = tradeTail.slice(lotStart, lotEnd).trimEnd() + '\n\n';
sql02 = replaceBetween(
  sql02,
  'CREATE OR REPLACE FUNCTION logic_calc_open_quantity(',
  'CREATE OR REPLACE FUNCTION logic_upsert_param(',
  lotBlock,
  'logic_security_lot_size + logic_calc_open_quantity'
);

// real-balance helpers + logic_ensure_balance из trade_runner → 02
{
  // lot-block (выше) уже тянет logic_selected_cash_fund_mtm + logic_position_sizing_base
  const ensStartMark = 'CREATE OR REPLACE FUNCTION logic_is_paper_balance_text(';
  let ensStart = tradeTail.indexOf(ensStartMark);
  if (ensStart === -1) {
    ensStart = tradeTail.indexOf('CREATE OR REPLACE FUNCTION logic_ensure_balance(');
  }
  const ensEnd = tradeTail.indexOf('CREATE OR REPLACE FUNCTION logic_trade_load_date_from(');
  if (ensStart === -1 || ensEnd === -1 || ensEnd <= ensStart) {
    throw new Error('sync-02: real-balance helpers / logic_trade_load_date_from not found');
  }
  const ensBlock = tradeTail.slice(ensStart, ensEnd).trimEnd() + '\n\n';
  // Якорь в 02 может быть старым (только ensure_balance) — ищем любой из маркеров.
  let sqlStart = sql02.indexOf(ensStartMark);
  if (sqlStart === -1) {
    sqlStart = sql02.indexOf('CREATE OR REPLACE FUNCTION logic_ensure_balance(');
  }
  const sqlEnd = sql02.indexOf('CREATE OR REPLACE FUNCTION logic_trade_load_date_from(');
  if (sqlStart === -1 || sqlEnd === -1 || sqlEnd <= sqlStart) {
    throw new Error('sync-02: cannot place real-balance helpers in 02');
  }
  sql02 = sql02.slice(0, sqlStart) + ensBlock + sql02.slice(sqlEnd);
}

const closeAll = read('sql/logic_close_all_positions.sql').trimEnd() + '\n\n';
sql02 = replaceBetween(
  sql02,
  '-- @include sql/logic_close_all_positions.sql (см. sql/logic_close_all_positions.sql — дублируется ниже)',
  'CREATE OR REPLACE FUNCTION process_logic_trades(p_logic_id INTEGER)',
  `-- @include sql/logic_close_all_positions.sql (см. sql/logic_close_all_positions.sql — дублируется ниже)\n${closeAll}`,
  'logic_close_all_positions'
);

// helpers (prices_have_closed_bar) + refresh + process + run_trade_cycle
const haveBarStart = tradeTail.indexOf('CREATE OR REPLACE FUNCTION prices_have_closed_bar');
const refreshStart = tradeTail.indexOf('CREATE OR REPLACE PROCEDURE logic_refresh_market_data(');
const processStart = tradeTail.indexOf('CREATE OR REPLACE FUNCTION process_logic_trades');
const tradeStart =
  haveBarStart !== -1 ? haveBarStart : refreshStart !== -1 ? refreshStart : processStart;
const tradeEnd = tradeTail.indexOf('COMMENT ON FUNCTION run_trade_cycle()');
if (tradeStart === -1 || tradeEnd === -1) {
  throw new Error('sync-02: prices_have_closed_bar/logic_refresh/process_logic_trades / run_trade_cycle not found');
}
const ratingBlock = read('sql/logic_signal_and_rating.sql').trimEnd() + '\n\n';
// ensure — в core; full park (HTTP/EtfBy) — после CREATE EXTENSION http
const cashParkStub = `
CREATE OR REPLACE FUNCTION logic_ensure_cash_fund_security(
    p_logic_id INTEGER,
    p_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
    v_security_id INTEGER;
BEGIN
    v_code := upper(btrim(COALESCE(p_code, '')));

    DELETE FROM logic_securities ls
    USING security_prefixes sp
    WHERE ls.security_id = sp.security_id
      AND ls.logic_id = p_logic_id
      AND upper(sp.prefix) IN ('TMON', 'LQDT', 'SBMM')
      AND (v_code = '' OR upper(sp.prefix) <> v_code);

    IF v_code = '' OR v_code NOT IN ('TMON', 'LQDT', 'SBMM') THEN
        RETURN;
    END IF;

    SELECT s.id
    INTO v_security_id
    FROM securities s
    JOIN security_prefixes sp ON sp.security_id = s.id
    WHERE upper(sp.prefix) = v_code
    ORDER BY sp.exchange_id
    LIMIT 1;

    IF v_security_id IS NULL THEN
        RETURN;
    END IF;

    UPDATE logic_securities
    SET display_order = display_order + 1
    WHERE logic_id = p_logic_id
      AND security_id <> v_security_id
      AND display_order >= 0;

    INSERT INTO logic_securities (logic_id, security_id, display_order, is_active)
    VALUES (p_logic_id, v_security_id, 0, TRUE)
    ON CONFLICT (logic_id, security_id) DO UPDATE SET
        is_active = TRUE,
        display_order = 0;
END;
$$;

COMMENT ON FUNCTION logic_ensure_cash_fund_security(INTEGER, TEXT) IS
'Добавить выбранный денежный фонд в logic_securities с display_order=0 (верх списка)';

CREATE OR REPLACE FUNCTION logic_park_excess_cash(p_logic_id INTEGER)
RETURNS JSONB
LANGUAGE plpgsql AS $$
BEGIN
    RETURN jsonb_build_object('skipped', TRUE, 'reason', 'http_unavailable');
END;
$$;

COMMENT ON FUNCTION logic_park_excess_cash(INTEGER) IS
'Stub без pgsql-http; полная реализация после CREATE EXTENSION http (sql/logic_cash_fund_park.sql)';
`;
let tradeSlice = tradeTail.slice(tradeStart, tradeEnd).trimEnd();
const runCycleMark = 'CREATE OR REPLACE FUNCTION run_trade_cycle()';
const runCycleIdx = tradeSlice.indexOf(runCycleMark);
if (runCycleIdx === -1) {
  throw new Error('sync-02: run_trade_cycle not found in trade slice');
}
tradeSlice =
  tradeSlice.slice(0, runCycleIdx) +
  `-- @include sql/logic_cash_fund_park.sql (stub; full after http)\n${cashParkStub}\n` +
  tradeSlice.slice(runCycleIdx);
const tradeBlock =
  ratingBlock +
  tradeSlice +
  '\n\n' +
  tradeTail.slice(tradeEnd).trimEnd() +
  '\n';


// Рейтинг + refresh + process; при повторном sync не дублировать
const ratingMarker = '-- AND-группы сигналов + рейтинг сигнала на логике';
const refreshMarker = 'CREATE OR REPLACE PROCEDURE logic_refresh_market_data(';
const tradeMarker = 'CREATE OR REPLACE FUNCTION process_logic_trades(p_logic_id INTEGER)';
const ratingIdx = sql02.indexOf(ratingMarker);
const refreshIdx = sql02.indexOf(refreshMarker);
const tradeIdx = sql02.indexOf(tradeMarker);
// Брать самый ранний маркер среди rating / refresh / process, но только если он ПОСЛЕ close_all
const closeAllMarker =
  '-- @include sql/logic_close_all_positions.sql (см. sql/logic_close_all_positions.sql — дублируется ниже)';
const closeAllIdx = sql02.indexOf(closeAllMarker);
function afterCloseAll(idx) {
  return idx !== -1 && (closeAllIdx === -1 || idx > closeAllIdx);
}
let tradeSyncStart = tradeMarker;
const candidates = [
  { idx: ratingIdx, mark: ratingMarker },
  { idx: refreshIdx, mark: refreshMarker },
  { idx: tradeIdx, mark: tradeMarker },
].filter((c) => afterCloseAll(c.idx));
if (candidates.length) {
  candidates.sort((a, b) => a.idx - b.idx);
  tradeSyncStart = candidates[0].mark;
} else if (ratingIdx !== -1 && (tradeIdx === -1 || ratingIdx < tradeIdx)) {
  tradeSyncStart = ratingMarker;
}


sql02 = replaceBetween(
  sql02,
  tradeSyncStart,
  '-- @optional-pgcron-block',
  tradeBlock + '\n',
  'signal rating + process_logic_trades + run_trade_cycle'
);

const sessionsBlock = read('sql/logic_trading_sessions.sql').trimEnd() + '\n\n';
const backtestBlock = read('sql/logic_backtest_runner.sql').trimEnd() + '\n\n';
const sessionsAndBacktest =
  `-- @include sql/logic_trading_sessions.sql\n${sessionsBlock}` +
  `-- @include sql/logic_backtest_runner.sql (см. sql/logic_backtest_runner.sql — дублируется ниже)\n${backtestBlock}`;

if (sql02.includes('-- @include sql/logic_trading_sessions.sql')) {
  sql02 = replaceBetween(
    sql02,
    '-- @include sql/logic_trading_sessions.sql',
    '-- @optional-pgcron-block',
    () => sessionsAndBacktest,
    'logic_trading_sessions + logic_backtest_runner'
  );
} else if (sql02.includes('-- @include sql/logic_backtest_runner.sql')) {
  sql02 = replaceBetween(
    sql02,
    '-- @include sql/logic_backtest_runner.sql',
    '-- @optional-pgcron-block',
    () => sessionsAndBacktest,
    'logic_trading_sessions + logic_backtest_runner'
  );
} else {
  sql02 = sql02.replace(
    '-- @optional-pgcron-block',
    () => `${sessionsAndBacktest}-- @optional-pgcron-block`
  );
}

const calcExtra = read('sql/calc_ind_extra.sql').trimEnd() + '\n';
{
  const beginMark = '-- @begin calc_ind_extra';
  const endMark = '-- @end calc_ind_extra';
  const start = sql02.indexOf(beginMark);
  if (start === -1) {
    throw new Error('sync-02: markers not found for calc_ind_extra (begin)');
  }
  // Конец блока — последний @end до диспетчера (не путать с текстом внутри модуля)
  const dispatcher = '\n-- Диспетчер массивного расчёта';
  const regionEnd = sql02.indexOf(dispatcher, start);
  const searchTo = regionEnd === -1 ? sql02.length : regionEnd;
  let end = sql02.lastIndexOf(endMark, searchTo - 1);
  if (end === -1 || end < start) {
    throw new Error('sync-02: markers not found for calc_ind_extra (end)');
  }
  let after = end + endMark.length;
  while (sql02.slice(after).startsWith(endMark) || sql02.slice(after).startsWith('\n' + endMark)) {
    if (sql02[after] === '\n') after += 1;
    after += endMark.length;
  }
  sql02 =
    sql02.slice(0, start) +
    `${beginMark}\n${calcExtra}${endMark}\n` +
    sql02.slice(after);
}

// Полная парковка кэша требует pgsql-http — после CREATE EXTENSION http
{
  const cashParkFull = read('sql/logic_cash_fund_park.sql').trimEnd() + '\n';
  const beginMark = '-- @begin logic_cash_fund_park_http';
  const endMark = '-- @end logic_cash_fund_park_http';
  const start = sql02.indexOf(beginMark);
  if (start !== -1) {
    const end = sql02.indexOf(endMark, start);
    if (end === -1) {
      throw new Error('sync-02: markers not found for logic_cash_fund_park_http (end)');
    }
    sql02 =
      sql02.slice(0, start) +
      `${beginMark}\n${cashParkFull}${endMark}\n` +
      sql02.slice(end + endMark.length);
  } else {
    const anchor = 'COMMENT ON FUNCTION configure_http_ssl() IS';
    const a = sql02.indexOf(anchor);
    if (a === -1) {
      throw new Error('sync-02: configure_http_ssl COMMENT not found for cash fund park inject');
    }
    const semi = sql02.indexOf(';', a);
    if (semi === -1) {
      throw new Error('sync-02: configure_http_ssl COMMENT semicolon not found');
    }
    const insertAt = semi + 1;
    sql02 =
      sql02.slice(0, insertAt) +
      `\n\n${beginMark}\n${cashParkFull}${endMark}\n` +
      sql02.slice(insertAt);
  }
}

{
  const accMark = '-- @include sql/account_portfolio_actions.sql';
  const accEnd = '\n-- Главная load_prices → HTTP (переопределение заглушек части A)';
  const accIdx = sql02.indexOf(accMark);
  const accEndIdx = sql02.indexOf(accEnd, accIdx === -1 ? 0 : accIdx);
  if (accIdx !== -1 && accEndIdx !== -1) {
    const accBlock =
      accMark +
      '\n' +
      read('sql/account_portfolio_actions.sql').trimEnd() +
      '\n';
    sql02 = sql02.slice(0, accIdx) + accBlock + sql02.slice(accEndIdx);
  } else {
    console.warn('sync-02: account_portfolio_actions markers not found — skipped');
  }
}

fs.writeFileSync(path.join(root, '02_multilogictrade_functions_and_procedures.sql'), sql02, 'utf8');
console.log('sync-02: OK — 02_multilogictrade_functions_and_procedures.sql updated');
