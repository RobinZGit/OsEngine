import { PriceCandle } from '../models/market.model';

export interface ExportIndicatorInstance {
  uid: string;
  type: string;
  period: number;
  color: string;
}

export interface ExportTfData {
  tfId: number;
  tf: string;
  sec: number;
  candles: Array<[string, number, number, number, number, number]>; // [dt,o,h,l,c,vol]
}

export interface ExportSecurityData {
  id: number;
  name: string;
  exchangeName: string;
  timeframes: Array<{ id: number; tf: string; sec: number }>;
  byTf: Record<string, ExportTfData>;
  defaultTfId: number | null;
}

export interface TrainerExportData {
  version: 3;
  exportedAt: string;
  securities: ExportSecurityData[];
  defaultSecurityId: number | null;
  defaultIndicators: ExportIndicatorInstance[];
  defaults: { commissionPct: number; executionDelaySec: number; speedMs: number; signalTpPct?: number; signalSlPct?: number; signalTpAuto?: boolean; signalSlAuto?: boolean; depositFraction?: number };
}

export function buildExportTfData(tfId: number, tf: string, sec: number, candles: PriceCandle[]): ExportTfData {
  const compact: Array<[string, number, number, number, number, number]> = candles.map(c => [
    c.dt, +c.open_price, +c.high_price, +c.low_price, +c.close_price, Math.max(0, +(c.volume ?? 0) || 0)
  ]);
  return { tfId, tf, sec, candles: compact };
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildTrainerExportHtml(data: TrainerExportData): string {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  const first = data.securities[0];
  const title = esc(first ? first.name : 'Тренажёр');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Тренажёр — ${title}${data.securities.length>1 ? ' (+'+(data.securities.length-1)+')' : ''}</title>
<style>
:root{--bg:#f1f5f9;--card:#fff;--border:#e2e8f0;--text:#0f172a;--muted:#64748b;--blue:#2563eb;--green:#16a34a;--red:#dc2626;--purple:#7c3aed}
*{box-sizing:border-box} body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text)}
.page{padding:10px;max-width:1400px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px}
.top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}
.title{margin:0;font-size:26px;font-weight:800;line-height:1}.sub{font-size:12px;color:var(--muted);margin-top:2px}
.head-pnl{display:inline-flex;align-items:baseline;gap:4px;padding:4px 10px;border-radius:8px;background:#f8fafc;border:1px solid var(--border);font-variant-numeric:tabular-nums}
.head-pnl .val{font-size:22px;font-weight:900;line-height:1}.head-pnl .pct{font-size:14px;font-weight:800}
.head-pnl .val.pos,.head-pnl .pct.pos{color:#00c853}.head-pnl .val.neg,.head-pnl .pct.neg{color:#ff1744}
.head-pnl.signal-tp,.head-pnl.signal-sl{font-size:28px;padding:5px 12px;border-width:2px;animation:signal-blink .45s steps(2,start) infinite}
.head-pnl.signal-tp{background:rgba(0,200,83,.12);border-color:#00c853;box-shadow:0 0 0 2px rgba(0,200,83,.25),0 0 12px rgba(0,200,83,.35)}
.head-pnl.signal-tp .val,.head-pnl.signal-sl .val{font-size:28px}
.head-pnl.signal-tp .pct,.head-pnl.signal-sl .pct{font-size:16px}
.head-pnl.signal-tp .val,.head-pnl.signal-tp .pct{color:#00e676}
.head-pnl.signal-sl{background:rgba(255,23,68,.10);border-color:#ff1744;box-shadow:0 0 0 2px rgba(255,23,68,.22),0 0 12px rgba(255,23,68,.30)}
.head-pnl.signal-sl .val,.head-pnl.signal-sl .pct{color:#ff1744}
@keyframes signal-blink{to{visibility:hidden}}
.head-price{font-size:11px;color:var(--muted);margin-left:8px;font-weight:600}
.btn{height:34px;padding:0 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;font-weight:700;cursor:pointer}.btn:hover:not(:disabled){background:#f8fafc}.btn:disabled{opacity:.45;cursor:default}
.btn-dark{background:#111827;color:#fff;border-color:#111827}
.total{padding:8px 14px;min-width:210px;min-height:0;display:flex;flex-direction:column;justify-content:center}.total .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:700}.total .val{font-size:34px;font-weight:900;line-height:1.05}.total .meta{font-size:13px;font-weight:800;padding:0;border:none;display:block;margin-top:2px}
.pos{color:var(--green)}.neg{color:var(--red)}.flat{color:var(--text)}
.bar{display:flex;gap:6px;align-items:end;flex-wrap:wrap;padding:0;margin:6px 0 0;max-width:720px}
.field{display:flex;flex-direction:column;gap:1px;font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase}
.field select{height:28px;border:1px solid #cbd5e1;border-radius:6px;padding:0 4px;font-size:12px;color:var(--text);background:#fff;max-width:220px}
.speed{display:flex;gap:4px;align-items:center}.speed select{width:96px;height:28px;border:1px solid var(--purple);color:#4c1d95;font-weight:700}
.sbtns{display:flex;flex-direction:column;gap:2px}.sbtn{width:28px;height:13px;border:1px solid var(--purple);background:var(--purple);color:#fff;font-weight:900;font-size:11px;line-height:1;border-radius:4px;padding:0;cursor:pointer}
.actions{display:flex;gap:6px;align-items:stretch;flex-wrap:wrap;padding:10px;border-bottom:1px solid #f1f5f9}
.tca{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:114px;min-height:64px;padding:6px 12px;border:none;border-radius:10px;cursor:pointer;font-weight:800;line-height:1.1;font-family:inherit}
.tca:disabled{opacity:.45;cursor:default}.tca .main{font-size:20px;font-weight:900}.tca .sub{font-size:11px;opacity:.85;margin-top:2px}
.buy{background:#16a34a;color:#fff}.sell{background:#dc2626;color:#fff}.start{background:#2563eb;color:#fff}.reset{background:#475569;color:#fff}.close-btn{background:#0f172a;color:#fff}
.info{display:flex;flex-direction:column;justify-content:center;padding:6px 12px;border-radius:10px;background:#fff;border:1px solid var(--border);min-width:160px;min-height:64px}
.info .lbl{font-size:11px;color:var(--muted);text-transform:uppercase}.info .val{font-size:24px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1.1}.info .pct{font-size:15px;margin-left:4px;font-weight:900}.info .hold{font-size:12px;color:var(--muted);margin-top:2px}.info .annual{font-size:14px;font-weight:900;margin-top:2px}
.signal-toggles{display:flex;flex-direction:row;gap:3px;align-items:stretch;min-height:64px;flex:0 0 auto}
.signal-toggle-item{display:flex;flex-direction:column;align-items:stretch;gap:0;flex:0 0 56px;width:56px;min-width:56px}
.signal-toggle-btn{display:inline-flex;align-items:center;justify-content:center;gap:2px;flex:1 1 auto;min-height:38px;padding:2px 4px;border:1px solid #cbd5e1;border-radius:8px 8px 0 0;background:#f8fafc;color:#475569;font-family:inherit;font-size:11px;font-weight:800;line-height:1;cursor:pointer;white-space:nowrap}
.signal-toggle-btn:hover{filter:brightness(.98)}
.signal-toggle-btn .signal-toggle-check{font-size:13px;line-height:1}
.signal-toggle-btn.signal-toggle-tp.active{background:rgba(22,163,74,.22);border-color:#16a34a;color:#15803d;box-shadow:inset 0 0 0 1px rgba(22,163,74,.18)}
.signal-toggle-btn.signal-toggle-sl.active{background:rgba(220,38,38,.18);border-color:#dc2626;color:#b91c1c;box-shadow:inset 0 0 0 1px rgba(220,38,38,.14)}
.signal-toggle-pct{width:100%;min-width:0;height:24px;padding:0 2px;border:1px solid #cbd5e1;border-top:none;border-radius:0 0 8px 8px;font-size:12px;font-weight:800;color:#1e293b;text-align:center;background:#fff;font-family:inherit;line-height:1}
.signal-toggle-pct:focus{outline:none;border-color:#94a3b8}
.head-pnl.signal-blink-finres{animation:signal-blink .22s steps(2,start) 3}
.head-pnl.signal-close-text{font-size:14px;padding:4px 10px}
.head-pnl.signal-close-text.signal-close-tp{color:#166534;background:rgba(22,163,74,.14);border-color:rgba(22,163,74,.35)}
.head-pnl.signal-close-text.signal-close-sl{color:#991b1b;background:rgba(220,38,38,.12);border-color:rgba(220,38,38,.32)}
.head-pnl.signal-close-text .val{font-size:14px;font-weight:900}
.chart-wrap{height:52vh;min-height:260px;padding:8px 10px}.chart-wrap canvas{width:100%;height:100%;display:block;background:#fff;border:1px solid #e2e8f0;border-radius:8px}
.meta{padding:6px 12px;font-size:12px;color:var(--muted);border-top:1px solid #f1f5f9;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.chart-meta-bar{position:relative;transition:background-color .25s ease,color .25s ease,border-color .25s ease}
.chart-meta-bar span,.chart-meta-bar b{color:inherit}
.chart-meta-bar .chart-time-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;justify-content:center;align-items:center;pointer-events:none;z-index:1}
.candle-time-badge{font-size:12px;font-weight:700;line-height:1.2;letter-spacing:.02em;white-space:nowrap;text-shadow:0 1px 1px rgba(0,0,0,.08)}
.candle-time-badge:empty{display:none}
.ind-topbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-top:1px solid #f1f5f9;background:#f8fafc}
.ind-topbar-label{font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;white-space:nowrap}
.ind-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-top:1px solid #f1f5f9}
.ind-bar select,.ind-bar input{height:30px;border:1px solid #cbd5e1;border-radius:6px;padding:0 6px;font-size:12px}
.ind-bar input[type=number]{width:72px}
.ind-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ind-chip{position:relative;display:inline-flex;gap:4px;align-items:center;padding:2px 8px;border:1px solid #cbd5e1;border-radius:999px;font-size:12px;background:#fff;cursor:default}
.ind-chip .dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:0 0 auto}
.ind-chip .abbr{font-weight:700;color:#1e293b;white-space:nowrap}
.ind-chip button{border:none;background:none;color:#64748b;cursor:pointer;font-size:14px;line-height:1;padding:0 0 0 2px}
.ind-chip button:hover{color:#dc2626}
.ind-chip[data-hint]:hover::after{content:attr(data-hint);position:absolute;left:0;top:calc(100% + 6px);z-index:30;background:#1f2937;color:#fff;font-size:12px;font-weight:500;line-height:1.35;padding:8px 10px;border-radius:8px;white-space:pre-line;min-width:180px;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:none}
.ind-chip[data-hint]:hover::before{content:'';position:absolute;left:14px;top:calc(100% + 2px);border:4px solid transparent;border-bottom-color:#1f2937;z-index:31;pointer-events:none}
.ind-empty-hint{font-size:12px;color:#94a3b8}

@media(max-width:900px){.chart-wrap{height:46vh;min-height:240px}.tca{min-width:92px}.info{min-width:130px}.bar{max-width:100%}}
@keyframes btnFlash3{0%,100%{filter:brightness(1);box-shadow:none}16.6%{filter:brightness(1.8);box-shadow:0 0 0 3px rgba(250,204,21,.7)}33.3%{filter:brightness(1);box-shadow:none}50%{filter:brightness(1.8);box-shadow:0 0 0 3px rgba(250,204,21,.7)}66.6%{filter:brightness(1);box-shadow:none}83.3%{filter:brightness(1.8);box-shadow:0 0 0 3px rgba(250,204,21,.7)}} .btn-flash-3{animation:btnFlash3 1.2s ease-in-out 1;}
</style>
</head>
<body>
<div class="page" id="page">
  <div class="top">
    <div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h1 class="title">Тренажёр</h1><div class="head-pnl" id="headPnlWrap"><span class="val flat" id="lastPnl">—</span><span class="pct" id="lastPnlPct"></span><span class="head-price">Цена: <span id="curPrice">—</span></span></div></div>
      <div class="sub" id="subTitle"></div>
      <div class="bar">
    <label class="field" id="secField"><span>Бумага</span><select id="secSel" onchange="changeSec(+this.value)"></select></label>
    <div class="field" id="secNameField" style="display:none"><span>Бумага</span><div id="secNameText" style="height:30px;display:flex;align-items:center;padding:0 2px;font-size:13px;font-weight:700;color:var(--text)"></div></div>
    <label class="field"><span>Таймфрейм</span><select id="tfSel" onchange="changeTf(+this.value)"></select></label>
    <div style="margin-left:auto;display:flex;gap:6px;align-items:flex-end">
      <label class="field"><span>Скорость</span><div class="speed"><select id="speedSel" onchange="setSpeed(+this.value)"></select><div class="sbtns"><button class="sbtn" onclick="speedUp()">+</button><button class="sbtn" onclick="speedDown()">−</button></div></div></label>

      <label class="field"><span>&nbsp;</span><button class="btn" id="dirBtn" onclick="toggleDirection()" title="Переключить направление графика" style="min-width:36px;font-size:16px;line-height:1;padding:0 10px">⇄</button></label>
    </div>
  </div>
    </div>
    <div class="card total"><div class="lbl">Итоговый финрез</div><div class="val flat" id="gTotal">0.00</div><div class="meta" id="gTotalPct"></div></div>
  </div>
  <div class="card">
    <div class="actions">
      <button class="tca buy" id="buyBtn" onclick="buy()"><span class="main">КУПИТЬ</span><span class="sub" id="buySub">ЛОНГ</span></button>
      <button class="tca sell" id="sellBtn" onclick="sell()"><span class="main">ПРОДАТЬ</span><span class="sub" id="sellSub">ШОРТ</span></button>
      <div class="signal-toggles">
        <div class="signal-toggle-item">
          <button class="signal-toggle-btn signal-toggle-tp" id="signalTpBtn" onclick="toggleSignalAuto('tp')" title="Авто тейк-профит"><span class="signal-toggle-check" id="signalTpCheck">☐</span><span class="signal-toggle-label">TP</span></button>
          <input class="signal-toggle-pct" id="signalTpPctInp" type="number" step="0.1" min="0" value="${esc(String(data.defaults.signalTpPct ?? 0.4))}" onchange="state.signalTpPct=Math.max(0,+this.value||0);render()" title="Сигнальный тейк-профит, %" />
        </div>
        <div class="signal-toggle-item">
          <button class="signal-toggle-btn signal-toggle-sl" id="signalSlBtn" onclick="toggleSignalAuto('sl')" title="Авто стоп-лосс"><span class="signal-toggle-check" id="signalSlCheck">☐</span><span class="signal-toggle-label">SL</span></button>
          <input class="signal-toggle-pct" id="signalSlPctInp" type="number" step="0.1" min="0" value="${esc(String(data.defaults.signalSlPct ?? 0.2))}" onchange="state.signalSlPct=Math.max(0,+this.value||0);render()" title="Сигнальный стоп-лосс, %" />
        </div>
      </div>
      <button class="tca start" id="startBtn" onclick="startPause()"><span class="main" id="startMain">Начать</span><span class="sub" id="startSub">пауза</span></button>
      <button class="tca reset" id="resetBtn" onclick="resetBlock()" disabled><span class="main">СНАЧАЛА</span><span class="sub">сброс</span></button>
      <div class="info"><div class="lbl">Итоговый финрез</div><div><span class="val flat" id="totalPnl">—</span><span class="pct" id="totalPnlPct"></span></div><div class="annual flat" id="annualRow">Годовых: —</div></div>
      <div class="info"><div class="lbl">Время удержания</div><div class="val flat" id="holdVal">—</div><div class="hold" id="avgHold">Ср.: —</div></div>
    </div>
    <div id="pending" class="meta" style="display:none;color:#92400e;background:#fffbeb"></div>
    <div class="chart-wrap"><canvas id="chart"></canvas></div>
        <div class="meta chart-meta-bar" id="chartMetaBar"><span>?????: <b id="cCount">0/0</b></span><span class="chart-time-center"><span id="candleTimeBadge" class="candle-time-badge"></span></span><span>????????: ${data.defaults.commissionPct}%</span><span>????????: ${data.defaults.executionDelaySec}?</span><span>Доля деп.: ${data.defaults.depositFraction ?? 0.1}</span><span id="markLegend">??????: ? ???????, ? ???????, ? ????????, ??????? ? ?????? ??????</span></div>
    <div class="ind-bar">
      <span style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;white-space:nowrap">Индикаторы</span>
      <div class="ind-chips" id="indChips"></div>
      <span style="flex:1"></span>
      <select id="indType"></select>
      <input id="indPeriod" type="number" min="2" max="500" value="20" />
      <button class="btn" onclick="addIndicator()">Добавить</button>
    </div>
  </div>
</div>
<script>
const DATA = ${json};

const SPEEDS=[[20,'Макс'],[50,'0.05с'],[100,'0.1с'],[250,'0.25с'],[500,'0.5с'],[1000,'1с'],[2000,'2с'],[3000,'3с'],[5000,'5с'],[10000,'10с']];
const state={
  secId: DATA.defaultSecurityId || (DATA.securities[0]&&DATA.securities[0].id),
  tfId: null,
  speedMs: DATA.defaults.speedMs||1000,
  commissionPct: +DATA.defaults.commissionPct||0.03,
  delaySec: Math.max(0,+DATA.defaults.executionDelaySec||0),
  depositFraction: (+DATA.defaults.depositFraction > 0 ? +DATA.defaults.depositFraction : 0.1),
  nominalDeposit: 1000000,
  signalTpPct: Math.max(0, +DATA.defaults.signalTpPct || 0.4),
  signalSlPct: Math.max(0, +DATA.defaults.signalSlPct || 0.2),
  signalTpAuto: !!DATA.defaults.signalTpAuto,
  signalSlAuto: !!DATA.defaults.signalSlAuto,
  playing:false, started:false, finished:false, timer:null,
  playIndex:0, visibleCount:0,
  playbackStartDt: null,
  position:'flat', entryPrice:null, entryIdx:null, entryWallMs:null, entryDt:null, qty:1, entryCommission:0,
  trades:[], totalPnlMoney:0, lastPnlMoney:null, lastPnlPct:null, pending:null,
  markers:[],
  indicators: (DATA.defaultIndicators||[]).map(x=>({uid:x.uid,type:x.type,period:+x.period||20,color:x.color||'#2563eb'})),
  indicatorSeries: [],
  reversed: false,
  signalCloseFlash: null,
};
function secData(){ return DATA.securities.find(s=>String(s.id)===String(state.secId)) || DATA.securities[0] || null; }
function tfData(){ const sec=secData(); return sec ? (sec.byTf[String(state.tfId)] || null) : null; }
function candles(){ const t=tfData(); return t?t.candles:[]; }
function curC(){ const c=candles(); return c[state.visibleCount-1]||null; }
function curPrice(){ const c=curC(); return c?+c[4]:null; }
function curDt(){ const c=curC(); return c?c[0]:null; }
function fmtMoney(v){ if(v==null||!Number.isFinite(v)) return '—'; const n=+v; return (n>0?'+':'')+n.toFixed(2); }
function fmtPct(v){ if(v==null||!Number.isFinite(v)) return '—'; const n=+v; return (n>0?'+':'')+n.toFixed(2)+'%'; }
function fmtPrice(v){ const n=+v; if(!Number.isFinite(n)) return '-'; return n.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:6}); }
function candleTimeOfDayStyle(hour){
  const keys=[[0,15,35,71],[4,22,51,95],[5.5,70,110,170],[7,255,214,102],[12,255,247,178],[17,255,214,102],[19,70,110,170],[21,22,51,95],[24,15,35,71]];
  const h=((hour%24)+24)%24; let a=keys[0],b=keys[keys.length-1];
  for(let i=0;i<keys.length-1;i++){ if(h>=keys[i][0]&&h<=keys[i+1][0]){ a=keys[i]; b=keys[i+1]; break; } }
  const span=b[0]-a[0]||1; const t=Math.max(0,Math.min(1,(h-a[0])/span)); const sm=t*t*(3-2*t);
  const r=Math.round(a[1]+(b[1]-a[1])*sm), g=Math.round(a[2]+(b[2]-a[2])*sm), bl=Math.round(a[3]+(b[3]-a[3])*sm);
  const lum=(0.2126*r+0.7152*g+0.0722*bl)/255;
  return {bg:'rgb('+r+','+g+','+bl+')', color: lum>0.62?'#1e293b':'#f8fafc', border: lum>0.62?'rgba(15,23,42,.18)':'rgba(255,255,255,.22)'};
}
function updateCandleTimeBadge(){
  const el=document.getElementById('candleTimeBadge');
  const bar=document.getElementById('chartMetaBar');
  if(!el) return;
  const c=candles(); const i=state.visibleCount-1;
  if(!c.length||i<0||i>=c.length){
    el.textContent='';
    if(bar){ bar.style.backgroundColor=''; bar.style.color=''; bar.style.borderColor=''; }
    return;
  }
  const dt=c[i][0]; const d=new Date(dt);
  if(Number.isNaN(d.getTime())){
    el.textContent=String(dt);
    if(bar){ bar.style.backgroundColor=''; bar.style.color=''; bar.style.borderColor=''; }
    return;
  }
  const hh=String(d.getHours()).padStart(2,'0'), mm=String(d.getMinutes()).padStart(2,'0');
  const dd=String(d.getDate()).padStart(2,'0'), mo=String(d.getMonth()+1).padStart(2,'0');
  el.textContent=dd+'.'+mo+' '+hh+':'+mm;
  const st=candleTimeOfDayStyle(d.getHours()+d.getMinutes()/60+d.getSeconds()/3600);
  if(bar){ bar.style.backgroundColor=st.bg; bar.style.color=st.color; bar.style.borderColor=st.border; }
}
function fmtHold(ms,bars){ const hasBars=Number.isFinite(bars)&&bars>=0; const hasMs=ms!=null&&Number.isFinite(ms)&&ms>=0; if(!hasBars && !hasMs) return '—'; let t=''; if(hasMs){ const s=Math.floor(ms/1000); if(s<60) t=s+' сек'; else { const m=Math.floor(s/60); if(m<60) t=m+' мин '+(s%60)+' сек'; else { const h=Math.floor(m/60); if(h<24) t=h+' ч '+(m%60)+' мин'; else { const d=Math.floor(h/24); t=d+' д '+(h%24)+' ч'; } } } }
  if(hasBars && t) return bars+' св. · '+t;
  if(hasBars) return bars+' св.';
  return t; }

function simElapsedStr(){
  const cur=curDt(); const start=state.playbackStartDt;
  if(!start||!cur) return '-';
  const ms=dtMs(cur)-dtMs(start);
  if(!Number.isFinite(ms)||ms<0) return '-';
  return fmtHold(ms, NaN);
}
function pnlClass(v){ return v>0?'pos':v<0?'neg':'flat'; }
function dtMs(dt){ const t=Date.parse(String(dt).replace(' ','T')); return Number.isFinite(t)?t:NaN; }
function basePrice(){ if(state.trades.length>0) return state.trades.reduce((s,t)=>s+t.openPrice,0)/state.trades.length; if(state.entryPrice!=null) return state.entryPrice; const c=candles(); return c.length?+c[0][4]:null; }
function commission(price,qty){ return price*qty*(Math.max(0,state.commissionPct)/100); }
function unrealizedMoney(){ if(state.position==='flat'||state.entryPrice==null) return 0; const p=curPrice(); if(p==null) return 0; const dir=state.position==='long'?1:-1; const gross=(p-state.entryPrice)*dir*state.qty; return gross - (state.entryCommission||0) - commission(p,state.qty); }
function unrealizedPct(){ if(state.position==='flat'||state.entryPrice==null) return 0; const base=state.entryPrice*state.qty; if(!base) return 0; return (unrealizedMoney()/base)*100; }
function totalPnlMoney(){ return state.trades.reduce((s,t)=>s+t.pnlMoney,0) + (state.position!=='flat'?unrealizedMoney():0); }
function totalPnlPct(){ const base=basePrice(); if(base==null||!Number.isFinite(base)||base<=0) return null; return (totalPnlMoney()/base)*100; }
function holdMsBetween(openDt,closeDt){ const a=dtMs(openDt), b=dtMs(closeDt); if(!Number.isFinite(a)||!Number.isFinite(b)) return null; return Math.max(0,b-a); }
function holdBarsBetween(openIdx,closeIdx){ if(!Number.isFinite(openIdx)||!Number.isFinite(closeIdx)) return null; return Math.max(0, Math.round(closeIdx-openIdx)); }
function currentHoldMs(){ if(state.position==='flat'||state.entryDt==null) return null; return holdMsBetween(state.entryDt, curDt()); }
function currentHoldBars(){ if(state.position==='flat'||state.entryIdx==null) return null; return holdBarsBetween(state.entryIdx, Math.max(0,state.visibleCount-1)); }
function avgHoldMs(){ const holds=state.trades.map(t=>t.holdMs).filter(x=>Number.isFinite(x)&&x>=0); if(!holds.length) return null; return holds.reduce((a,b)=>a+b,0)/holds.length; }
function avgHoldBars(){ const bars=state.trades.map(t=>t.holdBars).filter(x=>Number.isFinite(x)&&x>=0); if(!bars.length) return null; return Math.round(bars.reduce((a,b)=>a+b,0)/bars.length); }
function lastTradeHold(){ for(let i=state.trades.length-1;i>=0;i--){ const t=state.trades[i]; if(Number.isFinite(t.holdMs)&&t.holdMs>=0) return t; } return null; }
function annualPct(){
  const pct=totalPnlPct(); if(pct==null) return null;
  const c=candles(); if(!c.length) return null;
  const start = state.playIndex>0 && c[state.playIndex] ? dtMs(c[state.playIndex][0]) : (state.trades[0]?dtMs(state.trades[0].openDt):NaN);
  const end = dtMs(curDt());
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) return null;
  const days=(end-start)/86400000; if(days<=0) return null;
  return (pct/days)*365;
}


const IND_DEFS=[
  {code:'SMA',name:'SMA - Простое скользящее среднее',period:20,onPrice:true,hasPeriod:true,desc:'Сглаживает цену, показывает средний уровень за период. Сам по себе не даёт сигналов перекупленности/перепроданности.'},
  {code:'EMA',name:'EMA - Экспоненциальное среднее',period:20,onPrice:true,hasPeriod:true,desc:'Сглаживает цену с большим весом последних свечей. Быстрее SMA реагирует на изменения, но зон перекупленности/перепроданности не даёт.'},
  {code:'WMA',name:'WMA - Взвешенное среднее',period:20,onPrice:true,hasPeriod:true,desc:'Скользящая средняя с линейным весом к новым ценам. Реагирует быстрее SMA, но сам по себе не показывает перекупленность/перепроданность.'},
  {code:'HMA',name:'HMA - Среднее Халла',period:20,onPrice:true,hasPeriod:true,desc:'Быстрая и сглаженная средняя Халла. Хорошо показывает направление тренда с меньшим запаздыванием, но не даёт зон перекупленности.'},
  {code:'BB',name:'BB - Полосы Боллинджера',period:20,onPrice:true,hasPeriod:true,desc:'Полосы волатильности вокруг SMA. У верхней полосы — возможна перекупленность, у нижней — перепроданность; сужение полос означает низкую волатильность.'},
  {code:'DONCHIAN',name:'Donchian - Канал Дончиана',period:20,onPrice:true,hasPeriod:true,desc:'Канал максимумов и минимумов за период. Пробой верхней границы указывает на силу роста, нижней — на силу падения; внутри канала — диапазон.'},
  {code:'KELTNER',name:'Keltner - каналы Келтнера',period:20,onPrice:true,hasPeriod:true,desc:'Каналы волатильности: EMA + 2*ATR. Средняя линия - EMA, границы расширяются от ATR. Серия SLOPE показывает наклон средней линии в градусах (-90..90) и выводится отдельным подграфиком.'},
  {code:'VWAP',name:'VWAP - Средняя по объёму',period:1,onPrice:true,hasPeriod:false,desc:'Средняя цена с учётом объёма. Выше VWAP — перевес покупателей, ниже — продавцов; часто используется как ориентир справедливой цены.'},
  {code:'RSI',name:'RSI - Индекс относительной силы',period:14,onPrice:false,hasPeriod:true,desc:'Импульс в диапазоне 0–100. Обычно выше 70 — перекупленность, ниже 30 — перепроданность; середина диапазона — нейтральная зона.'},
  {code:'MACD',name:'MACD - Схождение/расхождение',period:12,onPrice:false,hasPeriod:true,desc:'Разница быстрых и медленных EMA. Пересечение линии MACD с сигнальной или нулём показывает смену импульса; гистограмма отражает его силу.'},
  {code:'STOCH',name:'Stoch - Стохастик',period:14,onPrice:false,hasPeriod:true,desc:'Положение цены в диапазоне 0–100. Обычно выше 80 — перекупленность, ниже 20 — перепроданность; пересечение %K и %D даёт дополнительный сигнал.'},
  {code:'ATR',name:'ATR - Средний истинный диапазон',period:14,onPrice:false,hasPeriod:true,desc:'Показывает среднюю волатильность, но не направление цены. Рост ATR — рынок стал активнее; полезен для оценки стопов и размера позиции.'},
  {code:'CCI',name:'CCI - Индекс товарного канала',period:20,onPrice:false,hasPeriod:true,desc:'Отклонение цены от средней. Обычно выше +100 — сильный рост/возможная перекупленность, ниже −100 — сильное падение/возможная перепроданность.'},
  {code:'ADX',name:'ADX - Индекс направленного движения',period:14,onPrice:false,hasPeriod:true,desc:'Показывает силу тренда (0–100), но не его направление. Обычно выше 25 — тренд сильный, ниже 20 — флет/слабый тренд.'},
  {code:'ROC',name:'ROC - Скорость изменения',period:12,onPrice:false,hasPeriod:true,desc:'Показывает скорость изменения цены в %. Выше 0 — цена выросла относительно N свечей назад, ниже 0 — снизилась; резкие значения = сильный импульс.'},
  {code:'OBV',name:'OBV - Балансовый объём',period:1,onPrice:false,hasPeriod:false,desc:'Накопленный объём по направлению цены. Рост OBV подтверждает рост цены; расхождение OBV и цены может предупреждать о возможном развороте.'},
  {code:'MFI',name:'MFI - Индекс денежного потока',period:14,onPrice:false,hasPeriod:true,desc:'Денежный поток в диапазоне 0–100 с учётом объёма. Обычно выше 80 — перекупленность, ниже 20 — перепроданность.'},
];
const IND_PALETTE=['#2563eb','#f59e0b','#8b5cf6','#06b6d4','#22c55e','#ef4444','#3b82f6','#ec4899','#14b8a6','#84cc16'];
let indColorIdx=(DATA.defaultIndicators||[]).length;
function shiftColor(hex,amount){ const m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex||''); if(!m) return hex||'#2563eb'; const clamp=n=>Math.max(0,Math.min(255,n)); const r=clamp(parseInt(m[1],16)+amount); const g=clamp(parseInt(m[2],16)+amount); const b=clamp(parseInt(m[3],16)+amount); return '#'+r.toString(16).padStart(2,'0')+g.toString(16).padStart(2,'0')+b.toString(16).padStart(2,'0'); }
function candleCloses(){ return candles().map(c=>+c[4]); }
function smaArr(closes,period){ const out=new Array(closes.length).fill(null); let sum=0; for(let i=0;i<closes.length;i++){ sum+=closes[i]; if(i>=period) sum-=closes[i-period]; if(i>=period-1) out[i]=sum/period; } return out; }
function emaArr(closes,period){ const out=new Array(closes.length).fill(null); if(closes.length<period) return out; const k=2/(period+1); let ema=0; for(let i=0;i<period;i++) ema+=closes[i]; ema/=period; out[period-1]=ema; for(let i=period;i<closes.length;i++){ ema=closes[i]*k+ema*(1-k); out[i]=ema; } return out; }
function wmaArr(closes,period){ const out=new Array(closes.length).fill(null); const denom=period*(period+1)/2; for(let i=period-1;i<closes.length;i++){ let sum=0; for(let j=0;j<period;j++) sum+=closes[i-period+1+j]*(j+1); out[i]=sum/denom; } return out; }
function hmaArr(closes,period){ const n2=Math.max(2,Math.floor(period/2)); const sqN=Math.max(2,Math.round(Math.sqrt(period))); const wmaN=wmaArr(closes,period); const wmaN2=wmaArr(closes,n2); const diff=new Array(closes.length).fill(null); for(let i=0;i<closes.length;i++){ if(wmaN[i]!=null && wmaN2[i]!=null) diff[i]=2*wmaN2[i]-wmaN[i]; } const out=new Array(closes.length).fill(null); const denom=sqN*(sqN+1)/2; for(let i=sqN-1;i<diff.length;i++){ let ok=true,sum=0; for(let j=0;j<sqN;j++){ const v=diff[i-sqN+1+j]; if(v==null){ok=false;break;} sum+=v*(j+1); } if(ok) out[i]=sum/denom; } return out; }
function vwapArr(){ const c=candles(); const out=new Array(c.length).fill(null); let cumPV=0,cumV=0; for(let i=0;i<c.length;i++){ const tp=(+c[i][2]+ +c[i][3]+ +c[i][4])/3; const vol=Math.max(0,+c[i][5]||0); cumPV+=tp*vol; cumV+=vol; if(cumV>0) out[i]=cumPV/cumV; } return out; }
function bbArr(closes,period,mult){ const mid=smaArr(closes,period); const upper=new Array(closes.length).fill(null); const lower=new Array(closes.length).fill(null); for(let i=period-1;i<closes.length;i++){ let sumSq=0; const mean=mid[i]; if(mean==null) continue; for(let j=i-period+1;j<=i;j++){ const d=closes[j]-mean; sumSq+=d*d; } const std=Math.sqrt(sumSq/period); upper[i]=mean+mult*std; lower[i]=mean-mult*std; } return {middle:mid,upper,lower}; }
function donchArr(period){ const c=candles(); const upper=new Array(c.length).fill(null), lower=new Array(c.length).fill(null), middle=new Array(c.length).fill(null); for(let i=period-1;i<c.length;i++){ let hi=-Infinity,lo=Infinity; for(let j=i-period+1;j<=i;j++){ hi=Math.max(hi,+c[j][2]); lo=Math.min(lo,+c[j][3]); } upper[i]=hi; lower[i]=lo; middle[i]=(hi+lo)/2; } return {middle,upper,lower}; }
function keltnerArr(period,mult,atrPeriod){ const closes=candleCloses(); const mid=emaArr(closes,period); const atr=atrArr(atrPeriod||period); const m=mult==null?2:mult; const upper=new Array(closes.length).fill(null), lower=new Array(closes.length).fill(null), slope=new Array(closes.length).fill(null); for(let i=0;i<closes.length;i++){ if(mid[i]==null||atr[i]==null) continue; upper[i]=mid[i]+m*atr[i]; lower[i]=mid[i]-m*atr[i]; const j=i-period; if(j>=0 && mid[j]!=null && atr[i]!==0){ slope[i]=Math.atan2(mid[i]-mid[j], period*atr[i])*180/Math.PI; } } return {middle:mid,upper,lower,slope}; }
function rsiArr(closes,period){ const out=new Array(closes.length).fill(null); if(closes.length<period+1) return out; let gain=0,loss=0; for(let i=1;i<=period;i++){ const diff=closes[i]-closes[i-1]; if(diff>=0) gain+=diff; else loss-=diff; } gain/=period; loss/=period; const rsi=(g,l)=>l===0?100:100-100/(1+g/l); out[period]=rsi(gain,loss); for(let i=period+1;i<closes.length;i++){ const diff=closes[i]-closes[i-1]; const g=diff>0?diff:0; const l=diff<0?-diff:0; gain=(gain*(period-1)+g)/period; loss=(loss*(period-1)+l)/period; out[i]=rsi(gain,loss); } return out; }
function emaFromArr(values,period){ const out=new Array(values.length).fill(null); const idx=[]; for(let i=0;i<values.length;i++) if(values[i]!=null) idx.push(i); if(idx.length<period) return out; const k=2/(period+1); let ema=0; for(let i=0;i<period;i++) ema+=values[idx[i]]; ema/=period; out[idx[period-1]]=ema; for(let i=period;i<idx.length;i++){ ema=values[idx[i]]*k+ema*(1-k); out[idx[i]]=ema; } return out; }
function smaFromArr(values,period){ const out=new Array(values.length).fill(null); const idx=[]; for(let i=0;i<values.length;i++) if(values[i]!=null) idx.push(i); let sum=0; for(let i=0;i<idx.length;i++){ sum+=values[idx[i]]; if(i>=period) sum-=values[idx[i-period]]; if(i>=period-1) out[idx[i]]=sum/period; } return out; }
function macdArr(closes,fast,slow,signal){ const ef=emaArr(closes,fast), es=emaArr(closes,slow); const macd=new Array(closes.length).fill(null); for(let i=0;i<closes.length;i++){ if(ef[i]!=null && es[i]!=null) macd[i]=ef[i]-es[i]; } const sig=emaFromArr(macd,signal); const hist=new Array(closes.length).fill(null); for(let i=0;i<closes.length;i++){ if(macd[i]!=null && sig[i]!=null) hist[i]=macd[i]-sig[i]; } return {macd,signal:sig,hist}; }
function stochArr(period,dPeriod,smooth){ const c=candles(); const rawK=new Array(c.length).fill(null); for(let i=period-1;i<c.length;i++){ let hi=-Infinity,lo=Infinity; for(let j=i-period+1;j<=i;j++){ hi=Math.max(hi,+c[j][2]); lo=Math.min(lo,+c[j][3]); } const denom=hi-lo; rawK[i]=denom===0?50:((+c[i][4]-lo)/denom)*100; } const k=smooth>1?smaFromArr(rawK,smooth):rawK; const d=smaFromArr(k,Math.max(2,dPeriod)); return {k,d}; }
function atrArr(period){ const c=candles(); const tr=new Array(c.length).fill(null); for(let i=1;i<c.length;i++){ const prev=+c[i-1][4]; tr[i]=Math.max(+c[i][2]-+c[i][3], Math.abs(+c[i][2]-prev), Math.abs(+c[i][3]-prev)); } const out=new Array(c.length).fill(null); const idx=[]; for(let i=0;i<tr.length;i++) if(tr[i]!=null) idx.push(i); if(idx.length<period) return out; let atr=0; for(let i=0;i<period;i++) atr+=tr[idx[i]]; atr/=period; out[idx[period-1]]=atr; for(let i=period;i<idx.length;i++){ atr=(atr*(period-1)+tr[idx[i]])/period; out[idx[i]]=atr; } return out; }
function cciArr(period){ const c=candles(); const out=new Array(c.length).fill(null); for(let i=period-1;i<c.length;i++){ let sum=0; const tps=[]; for(let j=i-period+1;j<=i;j++){ const tp=(+c[j][2]+ +c[j][3]+ +c[j][4])/3; tps.push(tp); sum+=tp; } const mean=sum/period; let md=0; for(const tp of tps) md+=Math.abs(tp-mean); md/=period; const tp=tps[tps.length-1]; out[i]=md===0?0:(tp-mean)/(0.015*md); } return out; }
function adxArr(period){ const c=candles(); const n=c.length; const out={adx:new Array(n).fill(null),pdi:new Array(n).fill(null),mdi:new Array(n).fill(null)}; if(n<period+2) return out; const trs=[],plusDm=[],minusDm=[],dts=[]; for(let i=1;i<n;i++){ const up=+c[i][2]-+c[i-1][2]; const dn=+c[i-1][3]-+c[i][3]; plusDm.push(up>dn&&up>0?up:0); minusDm.push(dn>up&&dn>0?dn:0); trs.push(Math.max(+c[i][2]-+c[i][3], Math.abs(+c[i][2]-+c[i-1][4]), Math.abs(+c[i][3]-+c[i-1][4]))); dts.push(i); } const rma=(arr,per)=>{ const res=[]; let sum=0; for(let i=0;i<arr.length;i++){ if(i<per){ sum+=arr[i]; if(i===per-1){ sum/=per; res.push(sum); } continue; } sum=(sum*(per-1)+arr[i])/per; res.push(sum); } return res; }; const atr=rma(trs,period), pDm=rma(plusDm,period), mDm=rma(minusDm,period); const offset=period-1; const dx=[],pdi=[],mdi=[],pdiIdx=[]; for(let i=0;i<atr.length;i++){ const a=atr[i]; const pv=a===0?0:(100*pDm[i])/a; const mv=a===0?0:(100*mDm[i])/a; const sum=pv+mv; dx.push(sum===0?0:(100*Math.abs(pv-mv))/sum); const idx=dts[i+offset]; pdi.push(pv); mdi.push(mv); pdiIdx.push(idx); } const adxVals=rma(dx,period); const adxOff=period-1; for(let i=0;i<pdi.length;i++){ out.pdi[pdiIdx[i]]=pdi[i]; out.mdi[pdiIdx[i]]=mdi[i]; } for(let i=0;i<adxVals.length;i++){ out.adx[pdiIdx[i+adxOff]]=adxVals[i]; } return out; }
function rocArr(closes,period){ const out=new Array(closes.length).fill(null); for(let i=period;i<closes.length;i++){ const prev=closes[i-period]; if(prev!==0) out[i]=((closes[i]-prev)/prev)*100; } return out; }
function obvArr(){ const c=candles(); const out=new Array(c.length).fill(null); if(!c.length) return out; let obv=0; out[0]=0; for(let i=1;i<c.length;i++){ const vol=Math.max(0,+c[i][5]||0); if(+c[i][4]>+c[i-1][4]) obv+=vol; else if(+c[i][4]<+c[i-1][4]) obv-=vol; out[i]=obv; } return out; }
function mfiArr(period){ const c=candles(); const out=new Array(c.length).fill(null); if(c.length<period+1) return out; const tp=i=>(+c[i][2]+ +c[i][3]+ +c[i][4])/3; for(let i=period;i<c.length;i++){ let pos=0,neg=0; for(let j=i-period+1;j<=i;j++){ const t=tp(j), pt=tp(j-1); const flow=t*Math.max(0,+c[j][5]||0); if(t>pt) pos+=flow; else if(t<pt) neg+=flow; } out[i]=neg===0?100:100-100/(1+pos/neg); } return out; }

function rebuildIndicators(){
  const closes=candleCloses();
  const out=[];
  for(const ind of state.indicators){
    const def=IND_DEFS.find(d=>d.code===ind.type)||IND_DEFS[0];
    const onPrice=!!def.onPrice;
    const period=Math.max(2, Math.floor(+ind.period||def.period||20));
    const label=def.hasPeriod? (ind.type+'('+period+')') : ind.type;
    const mk=(lineCode,lineName,color,values,on_price_scale)=>({uid:ind.uid,lineCode,lineName,color,values,onPrice:on_price_scale!==undefined?on_price_scale:onPrice,description:def.desc||'',indLabel:label});
    switch(ind.type){
      case 'SMA': out.push(mk('VALUE',label,ind.color,smaArr(closes,period))); break;
      case 'EMA': out.push(mk('VALUE',label,ind.color,emaArr(closes,period))); break;
      case 'WMA': out.push(mk('VALUE',label,ind.color,wmaArr(closes,period))); break;
      case 'HMA': out.push(mk('VALUE',label,ind.color,hmaArr(closes,period))); break;
      case 'VWAP': out.push(mk('VALUE',label,ind.color,vwapArr())); break;
      case 'BB': { const b=bbArr(closes,period,2); out.push(mk('MIDDLE',label+' Mid',ind.color,b.middle)); out.push(mk('UPPER',label+' Upper',shiftColor(ind.color,40),b.upper)); out.push(mk('LOWER',label+' Lower',shiftColor(ind.color,-40),b.lower)); break; }
      case 'DONCHIAN': { const d=donchArr(period); out.push(mk('MIDDLE',label+' Mid',ind.color,d.middle)); out.push(mk('UPPER',label+' Upper',shiftColor(ind.color,40),d.upper)); out.push(mk('LOWER',label+' Lower',shiftColor(ind.color,-40),d.lower)); break; }
      case 'KELTNER': { const k=keltnerArr(period,2,period); out.push(mk('MIDDLE',label+' Mid',ind.color,k.middle)); out.push(mk('UPPER',label+' Upper',shiftColor(ind.color,40),k.upper)); out.push(mk('LOWER',label+' Lower',shiftColor(ind.color,-40),k.lower)); out.push(mk('SLOPE',label+' Slope','#7c3aed',k.slope,false)); break; }
      case 'RSI': out.push(mk('VALUE',label,ind.color,rsiArr(closes,period),false)); break;
      case 'MACD': { const m=macdArr(closes,period,26,9); out.push(mk('MACD',label+' MACD',ind.color,m.macd,false)); out.push(mk('SIGNAL',label+' Signal',shiftColor(ind.color,60),m.signal,false)); out.push(mk('HIST',label+' Hist',shiftColor(ind.color,-60),m.hist,false)); break; }
      case 'STOCH': { const st=stochArr(period,3,3); out.push(mk('K',label+' %K',ind.color,st.k,false)); out.push(mk('D',label+' %D',shiftColor(ind.color,60),st.d,false)); break; }
      case 'ATR': out.push(mk('VALUE',label,ind.color,atrArr(period),false)); break;
      case 'CCI': out.push(mk('VALUE',label,ind.color,cciArr(period),false)); break;
      case 'ADX': { const a=adxArr(period); out.push(mk('ADX',label+' ADX',ind.color,a.adx,false)); out.push(mk('PDI',label+' +DI',shiftColor(ind.color,60),a.pdi,false)); out.push(mk('MDI',label+' -DI',shiftColor(ind.color,-60),a.mdi,false)); break; }
      case 'ROC': out.push(mk('VALUE',label,ind.color,rocArr(closes,period),false)); break;
      case 'OBV': out.push(mk('VALUE',label,ind.color,obvArr(),false)); break;
      case 'MFI': out.push(mk('VALUE',label,ind.color,mfiArr(period),false)); break;
    }
  }
  state.indicatorSeries=out;
  renderIndicatorChips();
}

function renderIndicatorChips(){
  const el=document.getElementById('indChips'); if(!el) return;
  el.innerHTML='';
  if(!state.indicators.length){
    const empty=document.createElement('span'); empty.className='ind-empty-hint'; empty.textContent='Нет индикаторов'; el.appendChild(empty); return;
  }
  for(const ind of state.indicators){
    const def=IND_DEFS.find(d=>d.code===ind.type);
    const label=def&&def.hasPeriod? (ind.type+'('+ind.period+')') : ind.type;
    const hint=def ? (def.name+'\\n'+(def.desc||'')) : ind.type;
    const chip=document.createElement('span'); chip.className='ind-chip'; chip.dataset.hint=hint; chip.style.borderColor=ind.color;
    chip.innerHTML='<span class="dot" style="background:'+ind.color+'"></span><span class="abbr">'+label+'</span>';
    const btn=document.createElement('button'); btn.type='button'; btn.textContent='×'; btn.title='Убрать индикатор'; btn.onclick=(e)=>{ e.stopPropagation(); removeIndicator(ind.uid); };
    chip.appendChild(btn); el.appendChild(chip);
  }
}

function addIndicator(){
  const type=document.getElementById('indType').value;
  const def=IND_DEFS.find(d=>d.code===type)||IND_DEFS[0];
  const period=def.hasPeriod ? Math.max(2, Math.min(500, Math.floor(+document.getElementById('indPeriod').value||def.period))) : def.period;
  const color=IND_PALETTE[indColorIdx % IND_PALETTE.length]; indColorIdx++;
  state.indicators.push({uid:'ind-'+type+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,7), type, period, color});
  rebuildIndicators(); render();
}

function removeIndicator(uid){
  state.indicators=state.indicators.filter(i=>i.uid!==uid);
  rebuildIndicators(); render();
}

function init(){
  const secSel=document.getElementById('secSel');
  const tfSel=document.getElementById('tfSel');
  const speedSel=document.getElementById('speedSel');
    DATA.securities.forEach(sec=>{ const o=document.createElement('option'); o.value=String(sec.id); o.textContent=sec.name; secSel.appendChild(o); });
  if(DATA.securities.length<=1){ document.getElementById('secField').style.display='none'; document.getElementById('secNameField').style.display=''; }
  SPEEDS.forEach(([v,l])=>{ [speedSel].forEach(sel=>{ const o=document.createElement('option'); o.value=String(v); o.textContent=l; sel.appendChild(o); }); });
  const indType=document.getElementById('indType');
  IND_DEFS.forEach(d=>{ const o=document.createElement('option'); o.value=d.code; o.textContent=d.name; indType.appendChild(o); });
  indType.addEventListener('change', ()=>{ const d=IND_DEFS.find(x=>x.code===indType.value)||IND_DEFS[0]; document.getElementById('indPeriod').value=String(d.period); document.getElementById('indPeriod').style.display=d.hasPeriod?'':'none'; });
  indType.dispatchEvent(new Event('change'));
  secSel.value=String(state.secId);
  speedSel.value=String(state.speedMs);
  applySecurity(true);
  window.addEventListener('resize', drawChart);
}

function applySecurity(resetTf){
  const sec=secData(); if(!sec) return;
  state.secId=sec.id;
  const tfSel=document.getElementById('tfSel');
  tfSel.innerHTML='';
  sec.timeframes.slice().sort((a,b)=>a.sec-b.sec).forEach(tf=>{ const o=document.createElement('option'); o.value=String(tf.id); o.textContent=tf.tf; tfSel.appendChild(o); });
  if(resetTf || !sec.byTf[String(state.tfId)]) state.tfId = sec.defaultTfId || (sec.timeframes[0]&&sec.timeframes[0].id);
  tfSel.value=String(state.tfId);
  document.getElementById('subTitle').textContent = sec.name + ' · ' + (sec.exchangeName||'') + ' · экспорт ' + DATA.exportedAt.slice(0,19).replace('T',' ');
  const snt=document.getElementById('secNameText'); if(snt) snt.textContent=sec.name;
  resetForTf();
}

function resetForTf(){
  stopTimer();
  const c=candles();
  const warmup=Math.min(200, Math.max(20, Math.floor(c.length*0.15)));
  state.playIndex=warmup;
  state.visibleCount=state.playIndex;
  state.playing=false; state.started=false; state.finished=false;
  state.playbackStartDt=null;
  state.position='flat'; state.entryPrice=null; state.entryIdx=null; state.entryWallMs=null; state.entryDt=null; state.qty=1; state.entryCommission=0;
  state.trades=[]; state.totalPnlMoney=0; state.lastPnlMoney=null; state.lastPnlPct=null; state.pending=null; state.markers=[];
  state.signalCloseFlash=null;
  rebuildIndicators();
  render();
}

function changeSec(secId){ if(+secId===+state.secId) return; state.secId=+secId; document.getElementById('secSel').value=String(state.secId); applySecurity(true); }
function changeTf(tfId){ if(+tfId===+state.tfId) return; state.tfId=+tfId; resetForTf(); }

function setSpeed(ms){ state.speedMs=+ms; document.getElementById('speedSel').value=String(state.speedMs); if(state.playing){ stopTimer(); startTimer(); } }
function speedUp(){ const i=SPEEDS.findIndex(s=>s[0]===state.speedMs); setSpeed(SPEEDS[Math.max(0,i-1)][0]); }
function speedDown(){ const i=SPEEDS.findIndex(s=>s[0]===state.speedMs); setSpeed(SPEEDS[Math.min(SPEEDS.length-1,i+1)][0]); }
function toggleDirection(){ state.reversed=!state.reversed; render(); }

function startTimer(){ stopTimer(); state.timer=setInterval(tick, state.speedMs); }
function stopTimer(){ if(state.timer){ clearInterval(state.timer); state.timer=null; } }

function startPause(){
  if(!state.started){
    state.started=true; state.playing=true;
    if(!state.playbackStartDt) state.playbackStartDt = curDt() || (candles()[0] && candles()[0][0]) || null;
    startTimer(); render(); return;
  }
  if(state.finished){
    resetForTf(); state.started=true; state.playing=true;
    state.playbackStartDt = curDt() || (candles()[0] && candles()[0][0]) || null;
    startTimer(); render(); return;
  }
  state.playing=!state.playing;
  if(state.playing) startTimer(); else stopTimer();
  render();
}

function resetBlock(){ resetForTf(); }

function tick(){
  if(!state.playing) return;
  const c=candles();
  if(state.visibleCount>=c.length){ state.playing=false; state.finished=true; stopTimer(); render(); return; }
  state.visibleCount++;
  maybeExecutePending();
  maybeAutoCloseBySignal();
  if(state.visibleCount>=c.length){ state.playing=false; state.finished=true; stopTimer(); }
  render();
}

function nearestForwardPrice(fromDt){
  const c=candles(); const from=dtMs(fromDt);
  for(let i=0;i<c.length;i++){ const ms=dtMs(c[i][0]); if(Number.isFinite(ms)&&ms>=from) return +c[i][4]; }
  return curPrice();
}

function scheduleOrder(side, action){
  const dt=curDt(), price=curPrice(); if(dt==null||price==null) return;
  const delayMs=Math.max(0,state.delaySec*1000);
  if(delayMs<=0){ executeOrder(side,action,dt,price); render(); return; }
  state.pending={side,action,executeAtMs:dtMs(dt)+delayMs,requestedDt:dt};
  render();
}

function maybeExecutePending(){
  const p=state.pending; if(!p) return;
  const curMs=dtMs(curDt()); if(!Number.isFinite(curMs) || curMs < p.executeAtMs) return;
  state.pending=null;
  const execDt = new Date(p.executeAtMs).toISOString();
  const price = nearestForwardPrice(execDt);
  const dt = curDt() || p.requestedDt;
  if(price==null) return;
  executeOrder(p.side,p.action,dt,price);
}

function executeOrder(side,action,dt,price){
  if(action==='close'){
    if(state.position==='flat'||state.entryPrice==null) return;
    const dir=state.position==='long'?1:-1;
    const gross=(price-state.entryPrice)*dir*state.qty;
    const net=gross - (state.entryCommission||0) - commission(price,state.qty);
    const base=state.entryPrice*state.qty;
    const pnlPct = base!==0 ? (net/base)*100 : 0;
    const holdMs = holdMsBetween(state.entryDt||dt, dt) ?? 0;
    const holdBars = holdBarsBetween(state.entryIdx, Math.max(0,state.visibleCount-1)) ?? 0;
    state.trades.push({pnlMoney:net,pnlPct,holdMs,holdBars,openPrice:state.entryPrice,openDt:state.entryDt||dt,closeDt:dt,closePrice:price,side:state.position});
    state.markers.push({idx:Math.max(0,state.visibleCount-1), dt, price, side: state.position==='long'?'sell':'buy', kind:'close', pnlPct});
    state.position='flat'; state.entryPrice=null; state.entryIdx=null; state.entryWallMs=null; state.entryDt=null; state.qty=1; state.entryCommission=0;
    state.lastPnlMoney=net; state.lastPnlPct=pnlPct;
  } else {
    if(state.position!=='flat') return;
    const frac = (+state.depositFraction > 0 ? +state.depositFraction : 0.1);
    const qty=Math.max(1, Math.floor((state.nominalDeposit * frac) / price)); const comm=commission(price,qty);
    state.position=side; state.entryPrice=price; state.entryIdx=state.visibleCount-1; state.entryWallMs=Date.now(); state.qty=qty; state.entryCommission=comm; state.entryDt=dt;
    state.markers.push({idx:Math.max(0,state.visibleCount-1), dt, price, side: side==='long'?'buy':'sell', kind:'open'});
    state.lastPnlMoney=null; state.lastPnlPct=null;
  }
}

function buy(){ if(state.pending||!state.started) return; const p=curPrice(); if(p==null) return;
  if(state.position==='long'){ scheduleOrder('short','close'); return; }
  if(state.position==='short'){ scheduleOrder('long','close'); return; }
  scheduleOrder('long','open');
}
function sell(){ if(state.pending||!state.started) return; const p=curPrice(); if(p==null) return;
  if(state.position==='short'){ scheduleOrder('long','close'); return; }
  if(state.position==='long'){ scheduleOrder('short','close'); return; }
  scheduleOrder('short','open');
}

function toggleSignalAuto(kind){
  if(kind==='tp') state.signalTpAuto=!state.signalTpAuto;
  if(kind==='sl') state.signalSlAuto=!state.signalSlAuto;
  render();
}
function signalLimitPrice(targetPct){
  if(state.position==='flat' || state.entryPrice==null) return null;
  const entry=+state.entryPrice; const dir=state.position==='long'?1:-1;
  const cRate=Math.max(0,+state.commissionPct||0)/100;
  const denom=dir-cRate;
  if(Math.abs(denom)<1e-12) return null;
  return entry*(targetPct/100 + dir + cRate)/denom;
}
function flashTradeBtn(which){
  const btn = document.getElementById(which==='buy'?'buyBtn':'sellBtn');
  if(!btn) return;
  btn.classList.remove('btn-flash-3');
  void btn.offsetWidth;
  btn.classList.add('btn-flash-3');
  setTimeout(()=>btn.classList.remove('btn-flash-3'), 1400);
}
function maybeAutoCloseBySignal(){
  if(state.position==='flat' || state.pending) return;
  const pct = unrealizedPct();
  if(pct==null) return;
  const dt = curDt(); if(dt==null) return;
  const tp=Math.max(0,+state.signalTpPct||0);
  const sl=Math.max(0,+state.signalSlPct||0);
  const tpHit = state.signalTpAuto && tp>0 && pct>=tp;
  const slHit = state.signalSlAuto && sl>0 && pct<=-sl;
  if(!tpHit && !slHit) return;
  const kind = tpHit ? 'tp' : 'sl';
  const targetPct = tpHit ? tp : -sl;
  const limitPrice = signalLimitPrice(targetPct);
  if(limitPrice==null || !Number.isFinite(limitPrice) || limitPrice<=0) return;
  const flashText = kind==='tp' ? 'Сработал тейк-профит' : 'Сработал стоп-лосс';
  const flash = { kind, text: flashText, phase:'blink', until: Date.now()+1800 };
  state.signalCloseFlash = flash;
  setTimeout(()=>{ if(state.signalCloseFlash===flash){ state.signalCloseFlash={...flash, phase:'text'}; render(); } }, 650);
  setTimeout(()=>{ if(state.signalCloseFlash && state.signalCloseFlash.text===flashText && state.signalCloseFlash.phase==='text'){ state.signalCloseFlash=null; render(); } }, 1850);
  flashTradeBtn(state.position==='long'?'buy':'sell');
  executeOrder(state.position==='long'?'short':'long','close',dt,limitPrice);
}

function render(){
  const c=candles();
  const totalMoney=totalPnlMoney();
  const totalPct=totalPnlPct();
  const annual=annualPct();
  const gTotal=document.getElementById('gTotal'); gTotal.textContent=fmtMoney(totalMoney); gTotal.className='val '+pnlClass(totalMoney);
  const gTotalPct=document.getElementById('gTotalPct');
  gTotalPct.innerHTML = (totalPct==null?'':'<span class="'+pnlClass(totalPct)+'">'+fmtPct(totalPct)+'</span>')
    + (annual==null?'':' <span style="color:#64748b">·</span> <span class="'+pnlClass(annual)+'">Годовых: '+fmtPct(annual)+'</span>');

  document.getElementById('curPrice').textContent=fmtPrice(curPrice());

  const showUnreal = state.position!=='flat';
  const lpMoney = showUnreal ? unrealizedMoney() : state.lastPnlMoney;
  const lpPct = showUnreal ? unrealizedPct() : state.lastPnlPct;
  const sigTp = Math.max(0, +state.signalTpPct||0);
  const sigSl = Math.max(0, +state.signalSlPct||0);
  const sigAlert = showUnreal ? ((lpPct!=null && sigTp>0 && lpPct>=sigTp) ? 'signal-tp' : (lpPct!=null && sigSl>0 && lpPct<=-sigSl) ? 'signal-sl' : '') : '';
  const flash = state.signalCloseFlash;
  const headPnlWrap=document.getElementById('headPnlWrap');
  if(headPnlWrap) headPnlWrap.className='head-pnl'+(sigAlert?' '+sigAlert:'')+(flash&&flash.phase==='blink'?' signal-blink-finres':'')+(flash&&flash.phase==='text'?' signal-close-text signal-close-'+flash.kind:'');
  const lastPnl=document.getElementById('lastPnl'); const lastPnlPctEl=document.getElementById('lastPnlPct');
  if(flash && flash.phase==='text'){
    lastPnl.textContent=flash.text; lastPnl.className='val'; lastPnlPctEl.textContent=''; lastPnlPctEl.className='pct';
  } else {
    lastPnl.textContent=fmtMoney(lpMoney); lastPnl.className='val '+pnlClass(lpMoney);
    lastPnlPctEl.textContent = lpPct==null ? '' : fmtPct(lpPct); lastPnlPctEl.className='pct '+pnlClass(lpPct);
  }

  const totEl=document.getElementById('totalPnl'); totEl.textContent=fmtMoney(totalMoney); totEl.className='val '+pnlClass(totalMoney);
  const totPctEl=document.getElementById('totalPnlPct'); totPctEl.textContent = totalPct==null ? '' : fmtPct(totalPct); totPctEl.className='pct '+pnlClass(totalPct);
  const annualRow=document.getElementById('annualRow'); annualRow.textContent = 'Годовых: ' + (annual==null?'—':fmtPct(annual)); annualRow.className='annual '+pnlClass(annual);

  const holdVal=document.getElementById('holdVal');
  const avgHoldEl=document.getElementById('avgHold');
  const lastH = lastTradeHold();
  const curHoldMs = showUnreal ? currentHoldMs() : (lastH ? lastH.holdMs : null);
  const curHoldBars = showUnreal ? currentHoldBars() : (lastH ? lastH.holdBars : null);
  holdVal.textContent = curHoldMs==null ? '—' : fmtHold(curHoldMs, curHoldBars);
  holdVal.className = 'val ' + (showUnreal ? (state.position==='long'?'pos':'neg') : 'flat');
  avgHoldEl.textContent = 'Ср.: ' + (avgHoldMs()==null?'—':fmtHold(avgHoldMs(), avgHoldBars()));

  document.getElementById('cCount').textContent=state.visibleCount+'/'+c.length;
  updateCandleTimeBadge();
  const canTrade = state.started && !state.pending && curPrice()!=null && !state.finished;
  const buyBtn=document.getElementById('buyBtn'); const sellBtn=document.getElementById('sellBtn');
  buyBtn.disabled=!canTrade; sellBtn.disabled=!canTrade;
  buyBtn.className='tca '+(state.position==='long'?'close-btn':'buy');
  sellBtn.className='tca '+(state.position==='short'?'close-btn':'sell');
  buyBtn.querySelector('.main').textContent=state.position==='long'?'ЗАКРЫТЬ':'КУПИТЬ';
  sellBtn.querySelector('.main').textContent=state.position==='short'?'ЗАКРЫТЬ':'ПРОДАТЬ';
  const holdSub = state.position!=='flat' ? fmtHold(currentHoldMs(), currentHoldBars()) : null;
  buyBtn.querySelector('.sub').textContent = holdSub || 'ЛОНГ';
  sellBtn.querySelector('.sub').textContent = holdSub || 'ШОРТ';
  document.getElementById('startMain').textContent=!state.started?'Начать':(state.finished?'Сначала':(state.playing?'Пауза':'Продолжить'));
  const simEl = simElapsedStr();
  const startSub = !state.started ? 'старт' : (state.finished ? 'сначала' : (simEl !== '-' ? simEl : (state.playing ? 'идёт' : 'пауза')));
  document.getElementById('startSub').textContent = startSub;
  document.getElementById('resetBtn').disabled=!state.started;
  const pEl=document.getElementById('pending');
  if(state.pending){ pEl.style.display='block'; pEl.textContent='Отложенное исполнение: '+(state.pending.action==='close'?'закрытие':'открытие')+' '+(state.pending.side==='long'?'лонг':'шорт')+'...'; }
  else { pEl.style.display='none'; pEl.textContent=''; }
  const tpBtn=document.getElementById('signalTpBtn'); const slBtn=document.getElementById('signalSlBtn');
  if(tpBtn){ tpBtn.classList.toggle('active', !!state.signalTpAuto); const c=tpBtn.querySelector('.signal-toggle-check'); if(c) c.textContent=state.signalTpAuto?'☑':'☐'; tpBtn.title=state.signalTpAuto?'Авто тейк-профит: включён (лимит по цене срабатывания)':'Авто тейк-профит: выключен (только сигнал)'; }
  if(slBtn){ slBtn.classList.toggle('active', !!state.signalSlAuto); const c=slBtn.querySelector('.signal-toggle-check'); if(c) c.textContent=state.signalSlAuto?'☑':'☐'; slBtn.title=state.signalSlAuto?'Авто стоп-лосс: включён (лимит по цене срабатывания)':'Авто стоп-лосс: выключен (только сигнал)'; }
  const tpInp=document.getElementById('signalTpPctInp'); if(tpInp && document.activeElement!==tpInp) tpInp.value=String(state.signalTpPct);
  const slInp=document.getElementById('signalSlPctInp'); if(slInp && document.activeElement!==slInp) slInp.value=String(state.signalSlPct);
  drawChart();
}

function drawChart(){
  const canvas=document.getElementById('chart'); if(!canvas) return;
  const wrap=canvas.parentElement; const dpr=Math.max(1,window.devicePixelRatio||1);
  const W=Math.max(300, Math.floor(wrap.clientWidth-2));
  const H=Math.max(260, Math.floor(wrap.clientHeight-2));
  if(canvas.width!==W*dpr||canvas.height!==H*dpr){ canvas.width=W*dpr; canvas.height=H*dpr; canvas.style.width=W+'px'; canvas.style.height=H+'px'; }
  const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  const t=tfData(); const all=t?t.candles:[]; const n=state.visibleCount;
  if(!all.length||n<=0){ ctx.fillStyle='#64748b'; ctx.fillText('Нет данных',20,30); return; }
  const windowSize=140;
  const start=Math.max(0,n-windowSize);
  const slice=all.slice(start,n);
  const axisPad=64, sidePad=10;
  const left = state.reversed ? axisPad : sidePad;
  const right = state.reversed ? sidePad : axisPad;
  const topPad=10, bottomPad=20;
  const cw=W-left-right;
  const xStep=cw/Math.max(1,slice.length);
  const xIdx=i=>state.reversed?(slice.length-1-i):i;
  const xAt=i=>left+xIdx(i)*xStep+xStep/2;

  const onPriceSeries = state.indicatorSeries.filter(s=>s.onPrice);
  const offPriceGroups = [];
  const offByUid = new Map();
  for(const s of state.indicatorSeries){ if(s.onPrice) continue; if(!offByUid.has(s.uid)) offByUid.set(s.uid, []); offByUid.get(s.uid).push(s); }
  for(const [uid, arr] of offByUid) offPriceGroups.push({uid, series:arr});

  const nPanes = offPriceGroups.length;
  const gap = nPanes ? 4 : 0;
  const gapsTotal = gap * nPanes;
  const availH = H - topPad - bottomPad;
  const minPriceH = 110;
  const minPaneH = 32;
  let paneH = 0;
  if (nPanes > 0) {
    const maxForPanes = Math.max(0, availH - minPriceH - gapsTotal);
    const desired = Math.floor(availH * 0.36);
    const panesTotal = Math.min(maxForPanes, Math.max(minPaneH * nPanes, desired));
    paneH = Math.max(minPaneH, Math.floor(panesTotal / nPanes));
    if (paneH * nPanes > maxForPanes) paneH = Math.max(minPaneH, Math.floor(maxForPanes / nPanes));
  }
  const panesTotalH = paneH * nPanes;
  const priceTop = topPad;
  const priceH = Math.max(80, availH - panesTotalH - gapsTotal);
  const priceBottom = priceTop + priceH;

  // price y range
  let minP=Infinity,maxP=-Infinity;
  for(const c of slice){ if(+c[3]<minP) minP=+c[3]; if(+c[2]>maxP) maxP=+c[2]; }
  for(const s of onPriceSeries){ const v=s.values; for(let i=start;i<n;i++){ const val=v[i]; if(val!=null){ if(val<minP) minP=val; if(val>maxP) maxP=val; } } }
  for(const m of state.markers){ if(m.idx>=start && m.idx<n){ if(m.price<minP) minP=m.price; if(m.price>maxP) maxP=m.price; } }
  if(!Number.isFinite(minP)||!Number.isFinite(maxP)||minP===maxP){ minP-=1; maxP+=1; }
  const pad=(maxP-minP)*0.06; minP-=pad; maxP+=pad;
  const yPrice=p=>priceTop+(maxP-p)/(maxP-minP)*priceH;

  // grid
  ctx.strokeStyle='#e2e8f0'; ctx.lineWidth=1;
  for(let g=0;g<=4;g++){ const y=priceTop+priceH*g/4; ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(W-right,y); ctx.stroke(); const pv=maxP-(maxP-minP)*g/4; ctx.fillStyle='#0f172a'; ctx.font='bold 12px Segoe UI,Arial'; if(state.reversed){ ctx.textAlign='right'; ctx.fillText(fmtPrice(pv), left-4, y+4); } else { ctx.textAlign='left'; ctx.fillText(fmtPrice(pv), W-right+4, y+4); } ctx.textAlign='left'; }

  // candles
  const bodyW=Math.max(1, Math.min(12, xStep*0.62));
  for(let i=0;i<slice.length;i++){
    const c=slice[i]; const o=+c[1],h=+c[2],l=+c[3],cl=+c[4]; const x=xAt(i);
    const up=cl>=o; ctx.strokeStyle=up?'#16a34a':'#dc2626'; ctx.fillStyle=up?'#16a34a':'#dc2626';
    ctx.beginPath(); ctx.moveTo(x,yPrice(h)); ctx.lineTo(x,yPrice(l)); ctx.stroke();
    const y1=yPrice(o), y2=yPrice(cl); const tB=Math.min(y1,y2), bh=Math.max(1,Math.abs(y2-y1));
    ctx.fillRect(x-bodyW/2, tB, bodyW, bh);
  }

  // on-price indicators
  for(const s of onPriceSeries){
    ctx.strokeStyle=s.color; ctx.lineWidth=1.5; ctx.beginPath(); let started=false;
    for(let i=start;i<n;i++){ const v=s.values[i]; if(v==null) continue; const x=xAt(i-start), y=yPrice(v); if(!started){ ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y); }
    if(started) ctx.stroke();
  }

  // trade markers
  for(const m of state.markers){
    if(m.idx<start || m.idx>=n) continue;
    const i=m.idx-start; const x=xAt(i); const y=yPrice(m.price);
    const isBuy=m.side==='buy'; const color=isBuy?'#16a34a':'#dc2626';
    ctx.save(); ctx.strokeStyle=isBuy?'rgba(22,163,74,0.35)':'rgba(220,38,38,0.35)'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(x,priceTop); ctx.lineTo(x,priceBottom); ctx.stroke(); ctx.restore();
    ctx.fillStyle=color; ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; const sz=6;
    if(m.kind==='open'){
      ctx.beginPath(); if(isBuy){ ctx.moveTo(x,y-sz); ctx.lineTo(x-sz,y+sz); ctx.lineTo(x+sz,y+sz); } else { ctx.moveTo(x,y+sz); ctx.lineTo(x-sz,y-sz); ctx.lineTo(x+sz,y-sz); } ctx.closePath(); ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(x,y-sz); ctx.lineTo(x+sz,y); ctx.lineTo(x,y+sz); ctx.lineTo(x-sz,y); ctx.closePath(); ctx.fill(); ctx.stroke();
      if(m.pnlPct!=null){ ctx.fillStyle=color; ctx.font='bold 11px Segoe UI,Arial'; ctx.fillText((m.pnlPct>0?'+':'')+m.pnlPct.toFixed(1)+'%', x+8, isBuy?y-2:y+10); }
    }
  }

  // entry line
  if(state.position!=='flat' && state.entryPrice!=null){ ctx.strokeStyle=state.position==='long'?'#16a34a':'#dc2626'; ctx.setLineDash([5,4]); ctx.beginPath(); ctx.moveTo(left,yPrice(state.entryPrice)); ctx.lineTo(W-right,yPrice(state.entryPrice)); ctx.stroke(); ctx.setLineDash([]); }
  // last price
  const last=slice[slice.length-1]; if(last){ const y=yPrice(last[4]); ctx.strokeStyle='#64748b'; ctx.setLineDash([2,3]); ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(W-right,y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle='#111827'; ctx.font='bold 11px Segoe UI,Arial'; if(state.reversed){ ctx.fillRect(0,y-8,left-2,16); ctx.fillStyle='#fff'; ctx.textAlign='right'; ctx.fillText(fmtPrice(last[4]), left-4, y+4); ctx.textAlign='left'; } else { ctx.fillRect(W-right,y-8,64,16); ctx.fillStyle='#fff'; ctx.textAlign='left'; ctx.fillText(fmtPrice(last[4]), W-right+3, y+4); } }

  // on-price indicators: no on-chart labels/watermarks; hint is on the chip toolbar.

  // off-price panes
  let paneTop = priceBottom + gap;
  for(const g of offPriceGroups){
    const pTop=paneTop, pH=paneH, pBottom=pTop+pH;
    ctx.fillStyle='#fafafa'; ctx.fillRect(left,pTop,cw,pH);
    ctx.strokeStyle='#e2e8f0'; ctx.strokeRect(left,pTop,cw,pH);
    // range
    let mn=Infinity,mx=-Infinity;
    for(const s of g.series){ for(let i=start;i<n;i++){ const v=s.values[i]; if(v!=null){ if(v<mn) mn=v; if(v>mx) mx=v; } } }
    if(!Number.isFinite(mn)||!Number.isFinite(mx)){ paneTop += pH+gap; continue; }
    if(mn===mx){ mn-=1; mx+=1; }
    const pp=(mx-mn)*0.08; mn-=pp; mx+=pp;
    const yP=v=>pTop+(mx-v)/(mx-mn)*pH;
    // grid
    ctx.strokeStyle='#eef2f7'; ctx.lineWidth=1;
    for(let k=0;k<=2;k++){ const yy=pTop+pH*k/2; ctx.beginPath(); ctx.moveTo(left,yy); ctx.lineTo(W-right,yy); ctx.stroke(); }
    // zero line if in range
    if(mn<0 && mx>0){ ctx.strokeStyle='#cbd5e1'; ctx.setLineDash([3,3]); ctx.beginPath(); ctx.moveTo(left,yP(0)); ctx.lineTo(W-right,yP(0)); ctx.stroke(); ctx.setLineDash([]); }
    // watermark hint
    const wm = (g.series[0] && (g.series[0].description || g.series[0].indLabel || g.series[0].lineName)) || '';
    if (wm) {
      ctx.save();
      ctx.fillStyle = 'rgba(71,85,105,0.24)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const maxW = Math.max(40, cw - 24);
      let fontSize = Math.max(18, Math.floor(pH * 0.34));
      const lh = 1.25;
      const words = wm.split(/\s+/).filter(Boolean);
      const wrap = (fs) => { ctx.font = 'bold ' + fs + 'px Segoe UI,Arial'; const lines=[]; let line=''; for (const w of words) { const test=line?line+' '+w:w; if (ctx.measureText(test).width<=maxW || !line) line=test; else { lines.push(line); line=w; } } if(line) lines.push(line); return lines; };
      let lines = wrap(fontSize);
      while (lines.length * fontSize * lh > pH * 0.86 && fontSize > 11) { fontSize -= 1; lines = wrap(fontSize); }
      ctx.font = 'bold ' + fontSize + 'px Segoe UI,Arial';
      const totalH = lines.length * fontSize * lh;
      let wy = pTop + pH / 2 - totalH / 2 + (fontSize * lh) / 2;
      const wcx = left + cw / 2;
      for (const ln of lines) { ctx.fillText(ln, wcx, wy, maxW); wy += fontSize * lh; }
      ctx.restore();
    }
    // series
    for(const s of g.series){ ctx.strokeStyle=s.color; ctx.lineWidth=1.4; ctx.beginPath(); let st=false; for(let i=start;i<n;i++){ const v=s.values[i]; if(v==null) continue; const x=xAt(i-start), y=yP(v); if(!st){ ctx.moveTo(x,y); st=true; } else ctx.lineTo(x,y); } if(st) ctx.stroke(); }
    // labels
    ctx.fillStyle='#0f172a'; ctx.font='bold 11px Segoe UI,Arial';
    if(state.reversed){ ctx.textAlign='right'; ctx.fillText(fmtPrice(mx), left-4, pTop+10); ctx.fillText(fmtPrice(mn), left-4, pBottom-3); }
    else { ctx.textAlign='left'; ctx.fillText(fmtPrice(mx), W-right+4, pTop+10); ctx.fillText(fmtPrice(mn), W-right+4, pBottom-3); }
    ctx.textAlign='left';
    let plx=left+4, ply=pTop+11; for(const s of g.series){ ctx.fillStyle=s.color; ctx.fillRect(plx,ply-3,8,3); ctx.fillStyle='#334155'; ctx.font='10px Segoe UI,Arial'; ctx.fillText(s.lineName, plx+11, ply+1); plx += ctx.measureText(s.lineName).width + 22; if(plx>W-right-30){ plx=left+4; ply+=12; } }
    paneTop += pH + gap;
  }
}


init();
<\/script>
</body>
</html>`;
}
