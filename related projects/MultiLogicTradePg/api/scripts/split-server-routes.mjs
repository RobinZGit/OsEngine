/**
 * One-shot: split api/server.js into lib/server-shared.js + routes/*.js + thin server.js.
 * Run from api/: node scripts/split-server-routes.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '..');
const serverPath = path.join(apiRoot, 'server.js');
const backupPath = path.join(apiRoot, 'server.js.pre-routes-bak');

if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(serverPath, backupPath);
  console.log('backup:', backupPath);
} else {
  console.log('using existing backup:', backupPath);
}

const lines = fs.readFileSync(backupPath, 'utf8').split(/\r?\n/);
const slice = (a, b) => lines.slice(a - 1, b).join('\n');

const headerRequires = `/**
 * Shared helpers + stop-scope validators for API route modules.
 * Extracted from server.js (Phase A routers).
 */
const {
  hashToken,
} = require('../tbank');
const {
  startBacktest,
  getBacktestStatus,
  cancelBacktest,
} = require('../logic-backtest');
const { resolveLastOptGridResults } = require('./opt-grid-store');
const {
  listBacktestReports,
  getBacktestReport,
  getBacktestReportNeighbors,
  persistBacktestReport,
} = require('../backtest-report-persist');
const {
  startRatingPrecalc,
  getRatingPrecalcStatus,
} = require('../logic-rating-precalc');
const { runTradeCycle } = require('../trade-runner');
const {
  touchUiHeartbeatDb,
  clearUiHeartbeatDb,
  isUiSessionActive,
} = require('./trade-runner-session');
const { validateOptFormulaSave } = require('./signal-opt');
const {
  getTradingParams,
  getTradingParamsForLogics,
  saveTradingParams,
  ensureDefaultParams,
  getLogicParamsDetailed,
  syncRealAccountBalancesIfNeeded,
  resetLogicTradingStateOnAccountChange,
  resetLogicShadowTradingState,
} = require('./logic-params');
const { buildLogicBundle, importLogicBundle } = require('./logic-bundle');
const { writeTechLogEvent } = require('./tech-log');
const {
  assertRealTbankAccount,
  sellAllPositions,
  planBuyBonds,
  executeBuyBonds,
  listBondFunds,
  getAccountCash,
} = require('./account-portfolio-actions');
`;

// Top helpers: lines 67-257 (constants + warmup)
const topHelpers = slice(67, 257);

function findFunctionEnd(startLine1) {
  let i = startLine1 - 1;
  let depthParen = 0;
  let seenParen = false;
  let depthBrace = 0;
  let inBody = false;
  let inStr = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const prev = j > 0 ? line[j - 1] : '';
      if (inStr) {
        if (ch === inStr && prev !== '\\') inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inStr = ch;
        continue;
      }
      if (!inBody) {
        if (ch === '(') {
          depthParen++;
          seenParen = true;
        } else if (ch === ')') {
          depthParen = Math.max(0, depthParen - 1);
        } else if (ch === '{' && seenParen && depthParen === 0) {
          inBody = true;
          depthBrace = 1;
        }
        continue;
      }
      if (ch === '{') depthBrace++;
      else if (ch === '}') {
        depthBrace--;
        if (depthBrace === 0) return i + 1;
      }
    }
  }
  throw new Error('no end for fn at ' + startLine1);
}

const fnEnds = {
  rewriteFormulaBasesNode: findFunctionEnd(2271),
  parseTimeHm: findFunctionEnd(3194),
  fetchNonTradingIntervals: findFunctionEnd(3206),
  btrimStr: findFunctionEnd(4635),
  formatColumn: findFunctionEnd(4793),
  formatConstraint: findFunctionEnd(4811),
  formatRoutine: findFunctionEnd(4820),
  parseLogicTradingParams: findFunctionEnd(4831),
  parseLogicBody: findFunctionEnd(5022),
  parseId: findFunctionEnd(5045),
  parseDateString: findFunctionEnd(5050),
  parseBrokerBody: findFunctionEnd(5059),
  parseExchangeBody: findFunctionEnd(5076),
  parseIndicatorBody: findFunctionEnd(5083),
  parseIndicatorCreateBody: findFunctionEnd(5114),
  runIndicatorSyncBackground: findFunctionEnd(5143),
  fetchIndicatorById: findFunctionEnd(5177),
  parseSecurityBody: findFunctionEnd(5215),
  parseAccountBody: findFunctionEnd(5233),
  fillRealTbankAccountFromToken: findFunctionEnd(5270),
  tokenFieldsFromParsed: findFunctionEnd(5316),
  buildTokenUpdateClause: findFunctionEnd(5324),
  stripAccountSecrets: findFunctionEnd(5340),
  enrichAccountBalance: findFunctionEnd(5345),
  pgResolveTbankAccount: findFunctionEnd(5385),
  pgFetchTbankPortfolioBalance: findFunctionEnd(5399),
  resolveAccountConnection: findFunctionEnd(5412),
  handleDbError: findFunctionEnd(5460),
};

console.log('fn ends', fnEnds);

const bottomHelpers = [
  slice(2271, fnEnds.rewriteFormulaBasesNode),
  slice(3194, fnEnds.fetchNonTradingIntervals),
  slice(4635, fnEnds.btrimStr),
  slice(4793, fnEnds.handleDbError),
].join('\n\n');

const sharedBody = `${headerRequires}

${topHelpers}

${bottomHelpers}

/** Bundle for route modules: pool + shared fns + service imports already required above. */
function createRouteContext(pool) {
  return {
    pool,
    hashToken,
    startBacktest,
    getBacktestStatus,
    cancelBacktest,
    resolveLastOptGridResults,
    listBacktestReports,
    getBacktestReport,
    getBacktestReportNeighbors,
    persistBacktestReport,
    startRatingPrecalc,
    getRatingPrecalcStatus,
    runTradeCycle,
    touchUiHeartbeatDb,
    clearUiHeartbeatDb,
    isUiSessionActive,
    validateOptFormulaSave,
    getTradingParams,
    getTradingParamsForLogics,
    saveTradingParams,
    ensureDefaultParams,
    getLogicParamsDetailed,
    syncRealAccountBalancesIfNeeded,
    resetLogicTradingStateOnAccountChange,
    resetLogicShadowTradingState,
    buildLogicBundle,
    importLogicBundle,
    writeTechLogEvent,
    assertRealTbankAccount,
    sellAllPositions,
    planBuyBonds,
    executeBuyBonds,
    listBondFunds,
    getAccountCash,
    VALID_STOP_SCOPES,
    TAKE_PROFIT_SCOPES,
    isScopeValidForRuleKind,
    isScopeChoosableForRuleKind,
    warmupWatchers,
    localIsoDate,
    shiftLocalDate,
    logicNeedsWarmup,
    transferWarmupSecurityState,
    watchWarmupBacktest,
    rewriteFormulaBasesNode,
    parseTimeHm,
    fetchNonTradingIntervals,
    btrimStr,
    formatColumn,
    formatConstraint,
    formatRoutine,
    parseLogicTradingParams,
    parseLogicBody,
    parseId,
    parseDateString,
    parseBrokerBody,
    parseExchangeBody,
    parseIndicatorBody,
    parseIndicatorCreateBody,
    runIndicatorSyncBackground,
    fetchIndicatorById,
    parseSecurityBody,
    parseAccountBody,
    fillRealTbankAccountFromToken,
    tokenFieldsFromParsed,
    buildTokenUpdateClause,
    stripAccountSecrets,
    enrichAccountBalance,
    pgResolveTbankAccount,
    pgFetchTbankPortfolioBalance,
    resolveAccountConnection,
    handleDbError,
  };
}

module.exports = {
  createRouteContext,
};
`;

fs.writeFileSync(path.join(apiRoot, 'lib', 'server-shared.js'), sharedBody);
console.log('wrote lib/server-shared.js');

/** Build a registerX(app, ctx) file from route line ranges, skipping helper defs. */
function buildRouteModule(name, comment, ranges) {
  const skipRanges = [
    [2271, fnEnds.rewriteFormulaBasesNode],
    [3194, fnEnds.fetchNonTradingIntervals],
    [4635, fnEnds.btrimStr],
  ];
  const out = [];
  for (const [a, b] of ranges) {
    for (let ln = a; ln <= b; ln++) {
      const skip = skipRanges.some(([s, e]) => ln >= s && ln <= e);
      if (skip) continue;
      out.push(lines[ln - 1]);
    }
  }
  let code = out.join('\n');
  // Replace app. with nothing — we'll wrap; keep app.xxx as app.xxx
  // Destructure ctx at top of register
  const destKeys = [
    'pool',
    'hashToken',
    'startBacktest',
    'getBacktestStatus',
    'cancelBacktest',
    'resolveLastOptGridResults',
    'listBacktestReports',
    'getBacktestReport',
    'getBacktestReportNeighbors',
    'persistBacktestReport',
    'startRatingPrecalc',
    'getRatingPrecalcStatus',
    'runTradeCycle',
    'touchUiHeartbeatDb',
    'clearUiHeartbeatDb',
    'isUiSessionActive',
    'validateOptFormulaSave',
    'getTradingParams',
    'getTradingParamsForLogics',
    'saveTradingParams',
    'ensureDefaultParams',
    'getLogicParamsDetailed',
    'syncRealAccountBalancesIfNeeded',
    'resetLogicTradingStateOnAccountChange',
    'resetLogicShadowTradingState',
    'buildLogicBundle',
    'importLogicBundle',
    'writeTechLogEvent',
    'assertRealTbankAccount',
    'sellAllPositions',
    'planBuyBonds',
    'executeBuyBonds',
    'listBondFunds',
    'getAccountCash',
    'isScopeValidForRuleKind',
    'isScopeChoosableForRuleKind',
    'localIsoDate',
    'shiftLocalDate',
    'logicNeedsWarmup',
    'watchWarmupBacktest',
    'rewriteFormulaBasesNode',
    'parseTimeHm',
    'fetchNonTradingIntervals',
    'btrimStr',
    'formatColumn',
    'formatConstraint',
    'formatRoutine',
    'parseLogicTradingParams',
    'parseLogicBody',
    'parseId',
    'parseDateString',
    'parseBrokerBody',
    'parseExchangeBody',
    'parseIndicatorBody',
    'parseIndicatorCreateBody',
    'runIndicatorSyncBackground',
    'fetchIndicatorById',
    'parseSecurityBody',
    'parseAccountBody',
    'fillRealTbankAccountFromToken',
    'tokenFieldsFromParsed',
    'buildTokenUpdateClause',
    'stripAccountSecrets',
    'enrichAccountBalance',
    'resolveAccountConnection',
    'handleDbError',
  ];

  return `/**
 * ${comment}
 */
module.exports = function register${name}(app, ctx) {
  const {
${destKeys.map((k) => `    ${k},`).join('\n')}
  } = ctx;

${code}
};
`;
}

const routesDir = path.join(apiRoot, 'routes');
fs.mkdirSync(routesDir, { recursive: true });

const routeSpecs = [
  {
    file: 'settings.js',
    name: 'SettingsRoutes',
    comment: 'Health, settings, maintenance cleanup.',
    ranges: [[278, 442]],
  },
  {
    file: 'indicators.js',
    name: 'IndicatorsRoutes',
    comment: 'Indicators, series, values, calculate.',
    ranges: [[444, 898]],
  },
  {
    file: 'market.js',
    name: 'MarketRoutes',
    comment: 'Timeframes, securities, prices.',
    ranges: [[900, 1180]],
  },
  {
    file: 'references.js',
    name: 'ReferencesRoutes',
    comment: 'Brokers, exchanges, accounts (sell-all / bonds).',
    ranges: [[1273, 1681]],
  },
  {
    file: 'logics.js',
    name: 'LogicsRoutes',
    comment: 'Logics CRUD, params, export/import, OPT, shadow, signals, stops, securities, NTP.',
    ranges: [
      [1182, 1271],
      [1683, 3506],
    ],
  },
  {
    file: 'trades.js',
    name: 'TradesRoutes',
    comment: 'Logic trades, lots, heartbeat, close-all.',
    ranges: [[3508, 4225]],
  },
  {
    file: 'backtest.js',
    name: 'BacktestRoutes',
    comment: 'Logic backtest start/status/cancel/reports.',
    ranges: [[4227, 4400]],
  },
  {
    file: 'ops.js',
    name: 'OpsRoutes',
    comment: 'Tech log, processes strip, schema tree.',
    ranges: [
      [4402, 4633],
      [4641, 4791],
    ],
  },
];

for (const spec of routeSpecs) {
  const body = buildRouteModule(spec.name, spec.comment, spec.ranges);
  fs.writeFileSync(path.join(routesDir, spec.file), body);
  console.log('wrote routes/' + spec.file, 'lines', body.split('\n').length);
}

const newServer = `/**
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
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { resumeOrphanBacktests } = require('./logic-backtest');
const { startTradeRunner } = require('./trade-runner');
const { startMaintenanceScheduler } = require('./maintenance-scheduler');
const { createRouteContext } = require('./lib/server-shared');

const registerSettingsRoutes = require('./routes/settings');
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
registerIndicatorsRoutes(app, ctx);
registerMarketRoutes(app, ctx);
registerReferencesRoutes(app, ctx);
registerLogicsRoutes(app, ctx);
registerTradesRoutes(app, ctx);
registerBacktestRoutes(app, ctx);
registerOpsRoutes(app, ctx);

app.use((_req, res) => {
  res.status(404).json({
    error: \`Маршрут API не найден. Перезапустите web\\\\MultiLogic_Trade_Progress_Start.bat.\`,
  });
});

app.listen(port, () => {
  console.log(\`MultiLogicTrade API: http://localhost:\${port}\`);
  console.log(\`CORS origin: \${corsOrigin}\`);
  startTradeRunner(pool);
  startMaintenanceScheduler(pool);
  resumeOrphanBacktests(pool)
    .then((r) => {
      if (r.scheduled > 0) {
        console.log(
          \`Backtest resume: scheduled \${r.scheduled} orphan run(s) of \${r.found} found\`
        );
      }
    })
    .catch((err) => console.error('resumeOrphanBacktests', err));
});
`;

fs.writeFileSync(serverPath, newServer);
console.log('wrote thin server.js');
console.log('done');
