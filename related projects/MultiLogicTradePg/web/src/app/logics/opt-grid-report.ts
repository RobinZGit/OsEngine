import { OptGridResultRow } from './opt-grid';

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(n: number): string {
  return Number(n || 0).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function renderOptGridReportHtml(model: {
  logicName: string;
  dateFrom: string;
  dateTo: string;
  runId: number | null;
  rows: OptGridResultRow[];
}): string {
  const sorted = [...(model.rows || [])].sort(
    (a, b) => (a.rank ?? 999) - (b.rank ?? 999) || Number(b.finres) - Number(a.finres)
  );
  const best = sorted[0];
  const rowsHtml = sorted
    .map((r, i) => {
      const vals = Object.entries(r.values || {})
        .map(([k, v]) => `${esc(k)}=${esc(String(v))}`)
        .join(', ');
      const tone =
        i === 0 ? 'best' : r.is_champion ? 'champ' : Number(r.finres) < 0 ? 'neg' : '';
      return `<tr class="${tone}">
        <td>${r.rank ?? i + 1}</td>
        <td>${r.is_champion ? 'Чемпион (по умолчанию)' : esc(r.lane || '—')}</td>
        <td>${vals || '—'}</td>
        <td class="num">${fmtMoney(Number(r.finres))}</td>
      </tr>`;
    })
    .join('\n');

  const fileName = `MLT-opt_${esc(model.logicName).replace(/\s+/g, '_')}_${model.dateFrom}_${model.dateTo}.html`;

  return `<!DOCTYPE html>
<html lang="ru" data-download-name="${fileName}">
<head>
  <meta charset="utf-8"/>
  <title>Отчёт оптимизации — ${esc(model.logicName)}</title>
  <style>
    body { font-family: Segoe UI, system-ui, sans-serif; margin: 24px; color: #1a1a1a; }
    h1 { font-size: 1.35rem; margin: 0 0 8px; }
    .meta { color: #555; margin-bottom: 16px; font-size: 0.9rem; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
    th { background: #f3f3f3; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr.best { background: #e8f6e8; font-weight: 600; }
    tr.champ { background: #f0f4ff; }
    tr.neg td.num { color: #a30; }
    .actions { margin: 12px 0 20px; }
    button { padding: 6px 12px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Отчёт оптимизации (тот же прогон теста)</h1>
  <div class="meta">
    Логика: <strong>${esc(model.logicName)}</strong>
    · период ${esc(model.dateFrom)} — ${esc(model.dateTo)}
    ${model.runId != null ? `· run #${model.runId}` : ''}
    ${best ? `· лучший FinRes: ${fmtMoney(Number(best.finres))} ₽` : ''}
  </div>
  <div class="actions">
    <button type="button" onclick="(function(){
      var name = document.documentElement.getAttribute('data-download-name') || 'MLT-opt.html';
      var blob = new Blob([document.documentElement.outerHTML], {type:'text/html;charset=utf-8'});
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      a.click(); URL.revokeObjectURL(a.href);
    })()">Скачать HTML</button>
  </div>
  <p>Чемпион — параметры по умолчанию (эквити теста). Остальные строки — бумажные ветки <code>opt_lane</code> того же прогона.</p>
  <table>
    <thead>
      <tr><th>#</th><th>Ветка</th><th>Параметры</th><th>FinRes, ₽</th></tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</body>
</html>`;
}
