/**
 * Статистический отчёт тренажёра по всем сохранённым сессиям (данные из БД).
 * Разрезы: по бумаге, по таймфрейму, бумага+ТФ, по действиям (Long/Short).
 * Открывается кнопкой «Статистика тренировок» рядом с «Отчёт сессии».
 * HTML рендерится локально и открывается через openBacktestReportWindow.
 */
import {
  TrainerStatsGroupRow,
  TrainerStatsResponse,
} from '../services/trainer.service';

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return String(Math.round(Number(v)));
}

function fmtPnl(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const sign = n > 0 ? '+' : '';
  return `${sign}${fmtNum(n)}`;
}

function pnlCls(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'pos' : 'neg';
}

function winRatePct(wins: number, losses: number): number | null {
  const total = wins + losses;
  return total > 0 ? (wins / total) * 100 : null;
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return '—';
  let rest = Math.round(Number(ms) / 1000);
  const days = Math.floor(rest / 86400); rest -= days * 86400;
  const hours = Math.floor(rest / 3600); rest -= hours * 3600;
  const mins = Math.floor(rest / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} мин`);
  return parts.join(' ');
}

/** Вердикт по разрезу: какие бумаги/ТФ получались, какие нет. */
function verdict(row: TrainerStatsGroupRow): { label: string; cls: string } {
  const wr = winRatePct(row.wins, row.losses);
  if (row.trades < 3) return { label: 'мало данных', cls: 'neutral' };
  if (row.net_pnl > 0 && wr != null && wr >= 55) return { label: 'получается', cls: 'good' };
  if (row.net_pnl > 0) return { label: 'в плюсе', cls: 'ok' };
  if (row.net_pnl < 0 && wr != null && wr < 45) return { label: 'не получается', cls: 'bad' };
  if (row.net_pnl < 0) return { label: 'в минусе', cls: 'warn' };
  return { label: 'около нуля', cls: 'neutral' };
}

function groupTable(
  title: string,
  subtitle: string,
  rows: TrainerStatsGroupRow[],
  nameFn: (r: TrainerStatsGroupRow) => string
): string {
  if (rows.length === 0) {
    return `<section class="block"><h2>${esc(title)}</h2><p class="empty">Нет данных.</p></section>`;
  }
  const body = rows
    .map((r) => {
      const wr = winRatePct(r.wins, r.losses);
      const v = verdict(r);
      return `<tr>
        <td class="name">${esc(nameFn(r))}</td>
        <td>${fmtInt(r.sessions)}</td>
        <td>${fmtInt(r.trades)}</td>
        <td class="pos">${fmtInt(r.wins)}</td>
        <td class="neg">${fmtInt(r.losses)}</td>
        <td class="${wr != null && wr >= 50 ? 'pos' : 'neg'}">${wr == null ? '—' : fmtNum(wr, 1) + '%'}</td>
        <td class="${pnlCls(r.net_pnl)}">${fmtPnl(r.net_pnl)}</td>
        <td class="${pnlCls(r.long_pnl)}">${fmtPnl(r.long_pnl)}</td>
        <td class="${pnlCls(r.short_pnl)}">${fmtPnl(r.short_pnl)}</td>
        <td>${fmtDuration(r.avg_holding_ms)}</td>
        <td><span class="badge ${v.cls}">${esc(v.label)}</span></td>
      </tr>`;
    })
    .join('');
  return `<section class="block">
    <h2>${esc(title)}</h2>
    <p class="sub">${esc(subtitle)}</p>
    <table>
      <thead><tr>
        <th class="name">Разрез</th><th>Сессий</th><th>Сделок</th>
        <th>Успешных</th><th>Неуспешных</th><th>Win rate</th>
        <th>Финрез</th><th>Long П/У</th><th>Short П/У</th>
        <th>Ср. удержание</th><th>Вердикт</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

export function renderTrainerStatsHtml(stats: TrainerStatsResponse): string {
  const t = stats.totals;
  const wr = winRatePct(t.wins ?? 0, t.losses ?? 0);
  const cards = [
    { lbl: 'Сессий', val: fmtInt(t.sessions), cls: '' },
    { lbl: 'Завершено', val: fmtInt(t.finished_sessions), cls: '' },
    { lbl: 'Сделок', val: fmtInt(t.trades), cls: '' },
    { lbl: 'Win rate', val: wr == null ? '—' : fmtNum(wr, 1) + '%', cls: wr != null && wr >= 50 ? 'pos' : 'neg' },
    { lbl: 'Финрез (с нереализ.)', val: fmtPnl(t.net_pnl), cls: pnlCls(t.net_pnl) },
    { lbl: 'Время торговли', val: fmtDuration(t.trading_ms), cls: '' },
    { lbl: 'Ср. удержание', val: fmtDuration(t.avg_holding_ms), cls: '' },
  ]
    .map((c) => `<div class="card"><div class="lbl">${esc(c.lbl)}</div><div class="val ${c.cls}">${esc(c.val)}</div></div>`)
    .join('');

  const sideRows = (stats.bySide ?? [])
    .map((s) => {
      const swr = winRatePct(s.wins, s.losses);
      const label = s.side === 'long' ? 'Покупка (Long)' : 'Продажа (Short)';
      return `<tr>
        <td class="name">${esc(label)}</td>
        <td>${fmtInt(s.trades)}</td>
        <td class="pos">${fmtInt(s.wins)}</td>
        <td class="neg">${fmtInt(s.losses)}</td>
        <td class="${swr != null && swr >= 50 ? 'pos' : 'neg'}">${swr == null ? '—' : fmtNum(swr, 1) + '%'}</td>
        <td class="${pnlCls(s.net_pnl)}">${fmtPnl(s.net_pnl)}</td>
        <td>${fmtDuration(s.avg_holding_ms)}</td>
      </tr>`;
    })
    .join('');
  const sideBlock = `<section class="block">
    <h2>По действиям: какие решения получались</h2>
    <p class="sub">Успешные/неуспешные сделки в разрезе направления (по всем бумагам и таймфреймам).</p>
    ${
      sideRows
        ? `<table>
      <thead><tr><th class="name">Действие</th><th>Сделок</th><th>Успешных</th><th>Неуспешных</th><th>Win rate</th><th>Финрез</th><th>Ср. удержание</th></tr></thead>
      <tbody>${sideRows}</tbody>
    </table>`
        : '<p class="empty">Нет данных.</p>'
    }
  </section>`;

  const generated = new Date().toLocaleString('ru-RU');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Статистика тренировок — Тренажёр</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #f1f5f9; color: #0f172a;
         font: 14px/1.45 -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 16px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
          padding: 10px 14px; min-width: 130px; }
  .card .lbl { color: #64748b; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
  .card .val { font-size: 18px; font-weight: 700; margin-top: 2px; }
  .block { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
           padding: 16px; margin-bottom: 16px; overflow-x: auto; }
  .block h2 { margin: 0 0 2px; font-size: 16px; }
  .block .sub { margin: 0 0 10px; color: #64748b; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 6px 10px; text-align: right; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
  th { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .03em;
       border-bottom: 2px solid #cbd5e1; }
  th.name, td.name { text-align: left; font-weight: 600; }
  tbody tr:hover { background: #f8fafc; }
  .pos { color: #16a34a; }
  .neg { color: #dc2626; }
  .flat { color: #64748b; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .badge.good { background: #dcfce7; color: #15803d; }
  .badge.ok { background: #ecfdf5; color: #047857; }
  .badge.warn { background: #fef3c7; color: #b45309; }
  .badge.bad { background: #fee2e2; color: #b91c1c; }
  .badge.neutral { background: #f1f5f9; color: #64748b; }
  .empty { color: #64748b; }
  .note { color: #64748b; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<h1>Статистика тренировок</h1>
<div class="meta">Тренажёр · по всем сохранённым сессиям · сформировано ${esc(generated)}</div>
<div class="cards">${cards}</div>
${groupTable('По бумагам', 'Какие инструменты получались лучше всего: финрез, доля успешных сделок, вердикт. Сортировка по финрезу.', stats.bySecurity ?? [], (r) => r.security_name || '—')}
${groupTable('По таймфреймам', 'На каких таймфреймах торговля получалась успешнее.', stats.byTimeframe ?? [], (r) => r.timeframe_tf || '—')}
${groupTable('Бумага + таймфрейм', 'Точные связки инструмент/таймфрейм — где именно получалось.', stats.bySecurityTimeframe ?? [], (r) => `${r.security_name || '—'} · ${r.timeframe_tf || '—'}`)}
${sideBlock}
<p class="note">Финрез в пунктах (1 юнит), включая mark-to-market открытых позиций на момент сохранения сессии.
«Успешные» — закрытые сделки с финрезом &gt; 0. Вердикт: «получается» — финрез &gt; 0 и win rate ≥ 55% (от 3 сделок);
«не получается» — финрез &lt; 0 и win rate &lt; 45%.</p>
</body>
</html>`;
}
