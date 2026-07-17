#!/usr/bin/env node
/**
 * Регрессия drag-and-drop: assign не блокирует UI, sync всегда async (202 + фон).
 * Входит в npm run verify:sql и prebuild.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const apiUrl = (process.env.API_URL || 'http://localhost:3000/api').replace(/\/$/, '');

if (process.env.SKIP_ASYNC_SYNC_VERIFY === '1') {
  console.log('verify-async-sync: SKIP_ASYNC_SYNC_VERIFY=1 — пропуск');
  process.exit(0);
}

function fail(msg) {
  console.error(`verify-async-sync: FAIL ${msg}`);
  process.exit(1);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assertSourceGuards() {
  const server = read('api/server.js');
  const panel = read('web/src/app/securities-panel/securities-panel.component.ts');
  const service = read('web/src/app/services/securities.service.ts');

  if (!server.includes("req.body?.async === true")) {
    fail('server.js must support async sync flag');
  }
  if (!server.includes('runIndicatorSyncBackground')) {
    fail('server.js missing runIndicatorSyncBackground');
  }
  if (!/app\.post\('\/api\/security-indicator-series',[\s\S]{0,3000}ensure_security_indicator_series/.test(server)) {
    fail('POST assign must call ensure_security_indicator_series');
  }
  if (/app\.post\('\/api\/security-indicator-series',[\s\S]{0,3000}sync_security_indicator_series/.test(server)) {
    fail('POST assign must NOT call sync procedures');
  }

  if (!panel.includes('runAsyncIndicatorSync')) {
    fail('panel missing runAsyncIndicatorSync');
  }
  if (!panel.includes('buildPendingSeriesRows')) {
    fail('panel must optimistically add pending rows on drop (buildPendingSeriesRows)');
  }
  if (panel.includes('indicatorAssigning.add')) {
    fail('panel must not block UI with indicatorAssigning.add on drop');
  }
  if (panel.includes('switchMap') && panel.includes('syncIndicatorSeries')) {
    fail('panel must not use switchMap(sync) — blocks HTTP until calc finishes');
  }

  const syncCalls = panel.match(/\.syncIndicatorSeries\(/g) ?? [];
  if (syncCalls.length === 0) {
    fail('panel must call syncIndicatorSeries via runAsyncIndicatorSync');
  }
  if (!panel.includes('async: true')) {
    fail('runAsyncIndicatorSync must pass async: true');
  }

  if (!service.includes('async: true')) {
    fail('SecuritiesService.syncIndicatorSeries must force async: true');
  }
  if (service.includes('120_000')) {
    fail('SecuritiesService must not use 120s sync timeout (blocking path removed)');
  }

  console.log('verify-async-sync: OK source guards (optimistic assign + async-only sync)');
}

async function probeLiveApi() {
  try {
    const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) return false;
  } catch {
    console.log('verify-async-sync: API offline — только проверка исходников');
    return false;
  }

  const secRes = await fetch(`${apiUrl}/securities?exchange_id=1&kind=stock`);
  if (!secRes.ok) throw new Error(`securities ${secRes.status}`);
  const securities = await secRes.json();
  const sber = securities.find((s) => s.prefix === 'SBER' || s.name === 'SBER');
  if (!sber) {
    console.log('verify-async-sync: SBER not found — skip live probe');
    return true;
  }

  const tfRes = await fetch(`${apiUrl}/timeframes`);
  const tfs = await tfRes.json();
  const m15 = tfs.find((t) => t.tf === 'M15');
  if (!m15) throw new Error('M15 timeframe missing');

  const indRes = await fetch(`${apiUrl}/indicators`);
  const indicators = await indRes.json();
  const pacc = indicators.find((i) => i.code === 'PACC');
  if (!pacc) {
    console.log('verify-async-sync: PACC not found — skip assign probe');
  } else {
    const t0assign = Date.now();
    const assignRes = await fetch(`${apiUrl}/security-indicator-series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        security_id: sber.id,
        indicator_id: pacc.id,
        timeframe_id: m15.id,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const assignMs = Date.now() - t0assign;
    if (assignRes.status !== 201 && assignRes.status !== 200) {
      const body = await assignRes.text();
      fail(`assign expected 201, got ${assignRes.status}: ${body.slice(0, 200)}`);
    }
    if (assignMs > 12_000) {
      fail(`assign took ${assignMs}ms — likely includes indicator calc (must be ensure only)`);
    }
    console.log(`verify-async-sync: OK live POST assign (ensure only) in ${assignMs}ms`);
  }

  const t0 = Date.now();
  const syncRes = await fetch(`${apiUrl}/security-indicator-series/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      security_id: sber.id,
      timeframe_id: m15.id,
      point_count: 15,
      incremental: true,
      async: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const elapsed = Date.now() - t0;
  const body = await syncRes.json().catch(() => ({}));

  if (syncRes.status !== 202) {
    fail(`expected sync 202, got ${syncRes.status} ${JSON.stringify(body)}`);
  }
  if (elapsed > 8000) {
    fail(`async sync took ${elapsed}ms (blocking)`);
  }
  console.log(`verify-async-sync: OK live POST async sync in ${elapsed}ms`);
  return true;
}

assertSourceGuards();
await probeLiveApi();
console.log('verify-async-sync: OK');
