#!/usr/bin/env node
/**
 * Регрессия: зависание индикаторов при развороте бумаги, перемотке, fullscreen.
 * Статические проверки исходников + наличие unit-тестов.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

if (process.env.SKIP_CHART_SYNC_VERIFY === '1') {
  console.log('verify-chart-sync: SKIP_CHART_SYNC_VERIFY=1 — пропуск');
  process.exit(0);
}

function fail(msg) {
  console.error(`verify-chart-sync: FAIL ${msg}`);
  process.exit(1);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    fail(`${label}: missing «${needle}»`);
  }
}

const panel = read('web/src/app/securities-panel/securities-panel.component.ts');
const chart = read('web/src/app/price-chart/price-chart.component.ts');
const chartHtml = read('web/src/app/price-chart/price-chart.component.html');
const panelSpec = read('web/src/app/securities-panel/securities-panel.component.spec.ts');
const chartSpec = read('web/src/app/price-chart/price-chart.component.spec.ts');
const marketModel = read('web/src/app/models/market.model.ts');
const backtestPapers = read('web/src/app/logics/logic-backtest-papers.component.ts');
const backtestPapersSpec = read('web/src/app/logics/logic-backtest-papers.component.spec.ts');
const overlaysSpec = read('web/src/app/logics/backtest-chart-overlays.spec.ts');

assertIncludes(marketModel, 'userInitiated', 'ChartVisibleRange.userInitiated');
assertIncludes(panel, 'suppressIndicatorDraw', 'panel suppressIndicatorDraw');
assertIncludes(panel, 'indicatorSyncGen', 'panel sync generation');
assertIncludes(panel, 'expandIndicatorGate', 'panel expand gate');
assertIncludes(panel, 'scheduleAutoIndicatorRangeSync', 'panel auto range sync');
assertIncludes(panel, 'indicatorCoverageMaxAttempts', 'panel coverage limit');
assertIncludes(panel, 'chartIndicatorsForDisplay', 'panel display guard');
assertIncludes(panel, 'EMPTY_CHART_SERIES', 'panel stable empty series');
assertIncludes(panel, 'indicator.rangeSync.retryStorm', 'panel retry storm log');
assertIncludes(panel, 'if (!range.userInitiated)', 'panel skip suppress on auto range');

assertIncludes(chart, 'scheduleEmitVisibleRange(userInitiated', 'chart emit with userInitiated');
assertIncludes(chart, 'requestAnimationFrame(() => this.scheduleEmitVisibleRange(false))', 'fullscreen auto emit');
assertIncludes(chart, 'loadingOlder', 'chart loadingOlder input');
assertIncludes(chart, 'scheduleRedraw', 'chart rAF redraw coalesce');
assertIncludes(chart, 'chart.redraw.slow', 'chart slow redraw log');
assertIncludes(chart, 'onPointerLeave', 'chart pointer leave handler');
assertIncludes(chart, 'const moved = this.dragging && this.viewStart !== this.dragStartView', 'drag-only user range');
assertIncludes(chartHtml, 'onPointerLeave', 'chart template pointerleave');

assertIncludes(panelSpec, 'onChartVisibleRange hides indicators', 'unit test scroll suppress');
assertIncludes(panelSpec, 'toggleSecurity syncs indicators', 'unit test expand sync');
assertIncludes(panelSpec, 'onChartVisibleRange auto emit does not suppress', 'unit test auto range');
assertIncludes(chartSpec, 'pointerleave without drag', 'unit test pointerleave');
assertIncludes(chartSpec, 'allows pan while loadingOlder', 'unit test loadingOlder pan');
assertIncludes(chartSpec, 'backtest overlays do not block pan', 'unit test backtest overlays pan');

assertIncludes(chart, 'tradeMarkers', 'chart tradeMarkers input');
assertIncludes(chart, 'shadedRanges', 'chart shadedRanges input');
assertIncludes(chart, 'equityPoints', 'chart equityPoints input');
assertIncludes(chart, 'drawTradeMarkers', 'chart drawTradeMarkers');
assertIncludes(chart, 'drawShadedRanges', 'chart drawShadedRanges');
assertIncludes(chart, 'drawEquityPanel', 'chart drawEquityPanel');

assertIncludes(backtestPapers, 'suppressIndicators', 'backtest papers suppressIndicators');
assertIncludes(backtestPapers, 'syncGen', 'backtest papers syncGen');
assertIncludes(backtestPapers, 'chartIndicatorsForDisplay', 'backtest papers display guard');
assertIncludes(backtestPapers, 'EMPTY_SERIES', 'backtest papers EMPTY_SERIES');
assertIncludes(backtestPapers, 'loadingOlder', 'backtest papers loadingOlder');
assertIncludes(backtestPapers, 'userInitiated', 'backtest papers userInitiated range');
assertIncludes(backtestPapers, 'MAX_CANDLES', 'backtest papers candle cap');
assertIncludes(backtestPapers, 'ChangeDetectionStrategy.OnPush', 'backtest papers OnPush');
assertIncludes(backtestPapers, 'rebuildPaperCache', 'backtest papers overlay cache');
assertIncludes(backtestPapers, 'loadIndicatorValues', 'backtest papers values-only path');
assertIncludes(backtestPapers, 'без sync POST', 'backtest papers skip sync POST comment');

assertIncludes(backtestPapersSpec, 'loads prices only after paper expand', 'unit test lazy expand');
assertIncludes(backtestPapersSpec, 'chartIndicatorsForDisplay returns EMPTY while suppressIndicators', 'unit test suppress');
assertIncludes(backtestPapersSpec, 'onVisibleRange auto emit does not suppress', 'unit test auto range papers');
assertIncludes(backtestPapersSpec, 'caches overlays so expand does not rebuild', 'unit test overlay cache');
assertIncludes(overlaysSpec, 'buildEquityPoints accumulates close PnL', 'unit test equity overlays');
assertIncludes(overlaysSpec, 'buildEquityPoints anchors zero at period start', 'unit test equity from test start');

console.log('verify-chart-sync: OK source guards + unit test names');
