import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import {
  ChartEquityPoint,
  ChartShadedRange,
  ChartStopMarker,
} from '../models/market.model';

/** Цвета зон режима бумаги (как на ценовом графике). */
export const EQUITY_SHADE_COLORS = {
  normal: { fill: 'rgba(187, 247, 208, 0.4)', stroke: 'rgba(74, 222, 128, 0.35)' },
  shadow: { fill: 'rgba(203, 213, 225, 0.55)', stroke: 'rgba(148, 163, 184, 0.55)' },
  inverted: { fill: 'rgba(251, 207, 232, 0.45)', stroke: 'rgba(244, 114, 182, 0.4)' },
  long: { fill: 'rgba(134, 239, 172, 0.28)', stroke: 'rgba(74, 222, 128, 0.3)' },
  short: { fill: 'rgba(252, 165, 165, 0.28)', stroke: 'rgba(248, 113, 113, 0.3)' },
} as const;

/** Значения хинта, вычисленные для наведённой точки кривой (#1077). */
export interface EquityHoverValues {
  returnPct: number | null;
  annualPct: number | null;
  days: number | null;
}

/** Календарные дни включительно между датами точки отсчёта и точкой кривой. */
export function equityHoverDays(fromDt: string, pointDt: string): number | null {
  const from = String(fromDt || '').slice(0, 10);
  const to = String(pointDt || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

/**
 * Доходность и годовая доходность на точке графика.
 * return% = PnL / стартовый баланс × 100; годовых = return% × 365 / дни.
 */
export function equityHoverValues(
  pnl: number,
  initialBalance: number,
  fromDt: string,
  pointDt: string
): EquityHoverValues {
  const base = Number(initialBalance);
  const returnPct =
    Number.isFinite(base) && base > 0 && Number.isFinite(Number(pnl))
      ? (Number(pnl) / base) * 100
      : null;
  const days = equityHoverDays(fromDt, pointDt);
  const annualPct =
    returnPct != null && days != null && days > 0 ? returnPct * (365 / days) : null;
  return { returnPct, annualPct, days };
}

/** Индекс ближайшей по X точки кривой (хинт не требует перерисовки canvas). */
export function nearestEquityPointIndex(
  points: Array<{ x: number }>,
  targetX: number
): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const dist = Math.abs(points[i].x - targetX);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Состояние хинта в шаблоне (позиции уже в CSS-пикселях относительно canvas). */
export interface EquityHoverView {
  crossX: number;
  crossY: number;
  plotTop: number;
  plotHeight: number;
  tipLeft: number;
  tipTop: number;
  dateLabel: string;
  pnl: number;
  pnlLabel: string;
  commission: number;
  commissionLabel: string;
  returnPct: number | null;
  returnLabel: string;
  annualPct: number | null;
  annualLabel: string;
}

/**
 * Отдельный график эквити: общая (синяя), long/short, shadow (пунктир).
 * Вертикали — срабатывания портфельного SL/TP.
 * Зоны — обычная (зелёный) / shadow (серый) / инверсия (розовый).
 */
@Component({
  selector: 'app-equity-curve-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="equity-curve-wrap">
      <canvas
        #canvas
        class="equity-curve-canvas"
        (mousemove)="onChartMouseMove($event)"
        (mouseleave)="onChartMouseLeave()"
      ></canvas>
      @if (activeSecurities.length > 1) {
        <canvas #secCanvas class="active-sec-canvas"></canvas>
      }
      @if (hover; as h) {
        <div
          class="equity-crosshair"
          [style.left.px]="h.crossX"
          [style.top.px]="h.plotTop"
          [style.height.px]="h.plotHeight"
        ></div>
        <div
          class="equity-hover-dot"
          [style.left.px]="h.crossX"
          [style.top.px]="h.crossY"
        ></div>
        <div class="equity-tooltip" [style.left.px]="h.tipLeft" [style.top.px]="h.tipTop">
          <div class="eq-tip-date">{{ h.dateLabel }}</div>
          <div class="eq-tip-row">
            <span>Фин. результат</span>
            <b [class.up]="h.pnl > 0" [class.down]="h.pnl < 0">{{ h.pnlLabel }}</b>
          </div>
          <div class="eq-tip-row">
            <span>Комиссия</span>
            <b class="fee">{{ h.commissionLabel }}</b>
          </div>
          <div class="eq-tip-row">
            <span>Доходность</span>
            <b [class.up]="h.returnPct != null && h.returnPct > 0" [class.down]="h.returnPct != null && h.returnPct < 0">{{ h.returnLabel }}</b>
          </div>
          <div class="eq-tip-row">
            <span>Годовых</span>
            <b [class.up]="h.annualPct != null && h.annualPct > 0" [class.down]="h.annualPct != null && h.annualPct < 0">{{ h.annualLabel }}</b>
          </div>
        </div>
      }
      <p class="equity-curve-legend">
        <span class="leg-total">━━</span> общая ·
        <span class="leg-long">──</span> лонги ·
        <span class="leg-short">──</span> шорты
        @if (shadowTotal.length > 1 || (shadowTotal.length === 1 && shadowTotal[0].value !== 0)) {
          · <span class="leg-shadow-line">- - -</span> shadow
        }
        @if (resumeTarget != null) {
          · <span class="leg-resume">—</span> цель возобновления (нужный shadow PnL)
        }
        @if (stopMarkers.length) {
          · <span class="leg-sl">|</span> SL портфель ·
          <span class="leg-tp">|</span> TP портфель
        }
        @if (showModeLegend || shadedRanges.length) {
          · <span class="leg-normal">▮</span> обычная ·
          <span class="leg-shadow">▮</span> shadow ·
          <span class="leg-inverted">▮</span> инверсия
        }
        @if (hasSideRanges) {
          · <span class="leg-zone-long">▮</span> лонги открыты ·
          <span class="leg-zone-short">▮</span> шорты открыты
        }
      </p>
    </div>
  `,
  styles: [
    `
      .equity-curve-wrap {
        width: 100%;
        min-height: 180px;
        position: relative;
      }
      .equity-crosshair {
        position: absolute;
        width: 1px;
        background: rgba(29, 78, 216, 0.5);
        pointer-events: none;
      }
      .equity-hover-dot {
        position: absolute;
        width: 9px;
        height: 9px;
        margin: -4.5px 0 0 -4.5px;
        border-radius: 50%;
        background: #1d4ed8;
        border: 2px solid #fff;
        box-shadow: 0 0 0 1px #1d4ed8;
        pointer-events: none;
      }
      .equity-tooltip {
        position: absolute;
        z-index: 5;
        min-width: 174px;
        padding: 7px 9px;
        background: rgba(15, 23, 42, 0.94);
        color: #e2e8f0;
        border-radius: 5px;
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.25);
        font-size: 11px;
        line-height: 1.55;
        pointer-events: none;
      }
      .eq-tip-date {
        font-weight: 600;
        color: #fff;
        margin-bottom: 3px;
      }
      .eq-tip-row {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        white-space: nowrap;
      }
      .eq-tip-row span {
        color: #94a3b8;
      }
      .eq-tip-row b {
        font-variant-numeric: tabular-nums;
      }
      .eq-tip-row b.up {
        color: #4ade80;
      }
      .eq-tip-row b.down {
        color: #fca5a5;
      }
      .eq-tip-row b.fee {
        color: #fbbf24;
      }
      .equity-curve-canvas {
        display: block;
        width: 100%;
        height: 200px;
        background: #fafbfc;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
      }
      .active-sec-canvas {
        display: block;
        width: 100%;
        height: 72px;
        background: #fafbfc;
        border: 1px solid #e2e8f0;
        border-top: none;
        border-radius: 0 0 4px 4px;
      }
      .equity-curve-legend {
        margin: 4px 0 0;
        font-size: 11px;
        color: #64748b;
      }
      .leg-total {
        color: #1d4ed8;
        font-weight: 700;
      }
      .leg-long {
        color: #16a34a;
        opacity: 0.65;
      }
      .leg-short {
        color: #dc2626;
        opacity: 0.65;
      }
      .leg-shadow-line {
        color: #64748b;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
      .leg-resume {
        color: #d97706;
        font-weight: 700;
      }
      .leg-sl {
        color: #dc2626;
        font-weight: 700;
      }
      .leg-tp {
        color: #059669;
        font-weight: 700;
      }
      .leg-normal {
        color: #4ade80;
        opacity: 0.9;
      }
      .leg-shadow {
        color: #94a3b8;
        opacity: 0.95;
      }
      .leg-inverted {
        color: #f9a8d4;
        opacity: 0.95;
      }
      .leg-zone-long {
        color: #86efac;
        opacity: 0.95;
      }
      .leg-zone-short {
        color: #fca5a5;
        opacity: 0.95;
      }
    `,
  ],
})
export class EquityCurveChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('secCanvas', { static: false }) secCanvasRef?: ElementRef<HTMLCanvasElement>;

  @Input() total: ChartEquityPoint[] = [];
  /** #1077: накопленная комиссия по точкам total (выровнена по индексу). */
  @Input() commission: ChartEquityPoint[] = [];
  /** #1077: стартовый баланс для расчёта % и годовых в хинте. */
  @Input() initialBalance = 1_000_000;
  @Input() longs: ChartEquityPoint[] = [];
  @Input() shorts: ChartEquityPoint[] = [];
  /** Теневая эквити (пунктир). */
  @Input() shadowTotal: ChartEquityPoint[] = [];
  /** Количество активных бумаг (тонкая коричневая линия, правая ось). */
  @Input() activeSecurities: ChartEquityPoint[] = [];
  /**
   * Горизонталь: сколько shadow-PnL нужно набрать до возобновления реала
   * (portfolio_stop_resume_equity − baseline). Только пока портфель в тени.
   */
  @Input() resumeTarget: number | null = null;
  /** Портфельные SL/TP (вертикали на баре срабатывания). */
  @Input() stopMarkers: ChartStopMarker[] = [];
  /** Зоны обычная / shadow / инверсия (график эквити бумаги / портфеля). */
  @Input() shadedRanges: ChartShadedRange[] = [];
  /** Показать подписи цветов зон в легенде (для бумаг). */
  @Input() showModeLegend = false;

  get hasSideRanges(): boolean {
    return this.shadedRanges.some((r) => r.kind === 'long' || r.kind === 'short');
  }

  private readonly cdr = inject(ChangeDetectorRef);
  private resizeObs: ResizeObserver | null = null;
  private sharedTimeRange: { t0: number; t1: number } | null = null;
  private plotGeometry: {
    padL: number;
    padR: number;
    padT: number;
    padB: number;
    cssW: number;
    cssH: number;
    firstDt: string | null;
    points: Array<{ t: number; v: number; dt: string; x: number; y: number }>;
  } | null = null;
  private lastMouse: { x: number; y: number } | null = null;

  /** #1077: состояние хинта; null — мышь вне области графика. */
  hover: EquityHoverView | null = null;

  onChartMouseMove(event: MouseEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    this.lastMouse = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.updateHover();
  }

  onChartMouseLeave(): void {
    this.lastMouse = null;
    this.hover = null;
  }

  private updateHover(): void {
    const g = this.plotGeometry;
    const m = this.lastMouse;
    if (!g || !m || g.points.length === 0) {
      this.hover = null;
      return;
    }
    if (
      m.x < g.padL - 4 ||
      m.x > g.cssW - g.padR + 4 ||
      m.y < g.padT - 4 ||
      m.y > g.cssH - g.padB + 4
    ) {
      this.hover = null;
      return;
    }

    const idx = nearestEquityPointIndex(g.points, m.x);
    const nearest = g.points[idx];
    const commission = Number(this.commission[idx]?.value) || 0;
    const vals = equityHoverValues(
      nearest.v,
      this.initialBalance,
      g.firstDt ?? nearest.dt,
      nearest.dt
    );
    const tipW = 174;
    const tipH = 96;
    const maxTop = Math.max(g.padT, g.cssH - g.padB - tipH);
    this.hover = {
      crossX: nearest.x,
      crossY: nearest.y,
      plotTop: g.padT,
      plotHeight: g.cssH - g.padT - g.padB,
      tipLeft:
        m.x > g.cssW / 2
          ? Math.max(0, m.x - tipW - 14)
          : Math.min(Math.max(0, g.cssW - tipW), m.x + 14),
      tipTop: Math.max(g.padT, Math.min(maxTop, m.y - tipH / 2)),
      dateLabel: this.dateLabel(nearest.dt),
      pnl: nearest.v,
      pnlLabel: this.fmtSigned(nearest.v),
      commission,
      commissionLabel: commission.toFixed(2),
      returnPct: vals.returnPct,
      returnLabel: this.fmtPct(vals.returnPct),
      annualPct: vals.annualPct,
      annualLabel: this.fmtPct(vals.annualPct),
    };
    this.cdr.markForCheck();
  }

  private dateLabel(dt: string): string {
    const s = String(dt || '');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ru-RU');
  }

  private fmtSigned(n: number): string {
    if (!Number.isFinite(n)) return '—';
    return `${n > 0 ? '+' : ''}${this.fmt(n)}`;
  }

  private fmtPct(v: number | null): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
  }

  ngAfterViewInit(): void {
    this.resizeObs = new ResizeObserver(() => this.draw());
    this.resizeObs.observe(this.canvasRef.nativeElement);
    this.draw();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    this.draw();
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const cssW = Math.max(200, parent?.clientWidth || canvas.clientWidth || 400);
    const cssH = 200;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const series: Array<{
      pts: ChartEquityPoint[];
      color: string;
      width: number;
      dash: number[];
    }> = [
      { pts: this.longs, color: 'rgba(22, 163, 74, 0.45)', width: 1.25, dash: [] },
      { pts: this.shorts, color: 'rgba(220, 38, 38, 0.45)', width: 1.25, dash: [] },
      { pts: this.total, color: '#1d4ed8', width: 2.5, dash: [] },
      {
        pts: this.shadowTotal,
        color: '#64748b',
        width: 2,
        dash: [7, 5],
      },
    ].filter((s) => s.pts.length > 0);

    if (series.length === 0) {
      this.plotGeometry = null;
      this.hover = null;
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Нет данных для эквити', 12, cssH / 2);
      return;
    }

    const all = series.flatMap((s) => s.pts);
    const times = all.map((p) => Date.parse(p.dt)).filter((t) => Number.isFinite(t));
    for (const range of this.shadedRanges) {
      const a = Date.parse(range.startDt);
      const b = Date.parse(range.endDt);
      if (Number.isFinite(a)) times.push(a);
      if (Number.isFinite(b)) times.push(b);
    }
    const values = all.map((p) => p.value);
    const resumeY =
      this.resumeTarget != null && Number.isFinite(Number(this.resumeTarget))
        ? Number(this.resumeTarget)
        : null;
    const seriesMax = values.length ? Math.max(0, ...values) : 0;
    const seriesMin = values.length ? Math.min(0, ...values) : 0;
    const span = Math.max(seriesMax - seriesMin, 1);
    // Не раздувать шкалу далёкой целью — иначе кривая прилипает к низу.
    // Но всегда оставляем запас сверху, чтобы пик серии не совпадал с «целью ↑» на кромке.
    let resumeOutOfScale = false;
    let vMin = seriesMin;
    let vMax = seriesMax;
    if (resumeY != null) {
      const softHi = seriesMax + Math.max(span * 0.35, 50);
      const softLo = seriesMin - Math.max(span * 0.35, 50);
      if (resumeY <= softHi && resumeY >= softLo) {
        vMax = Math.max(vMax, resumeY);
        vMin = Math.min(vMin, resumeY);
      } else {
        resumeOutOfScale = true;
      }
    }
    let t0 = Math.min(...times);
    let t1 = Math.max(...times);
    // Если только одна точка (ноль без закрытий) — растянуть ось на сутки вперёд.
    if (t1 <= t0) t1 = t0 + 24 * 60 * 60 * 1000;
    if (vMax === vMin) {
      vMax += 1;
      vMin -= 1;
    }
    const padSpan = Math.max(vMax - vMin, 1);
    vMax += Math.max(padSpan * 0.12, 8);
    vMin -= Math.max(padSpan * 0.06, 4);
    const padL = 48;
    const padR = 10;
    const padT = 10;
    const padB = 22;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    const xOf = (t: number) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const yOf = (v: number) => padT + ((vMax - v) / (vMax - vMin)) * plotH;

    // #1077: геометрию для хинта сохраняем до отрисовки — мышь не перерисовывает canvas.
    const hoverPoints = this.total
      .map((p) => ({ t: Date.parse(p.dt), v: Number(p.value), dt: p.dt }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t)
      .map((p) => ({ ...p, x: xOf(p.t), y: yOf(p.v) }));
    this.plotGeometry = {
      padL,
      padR,
      padT,
      padB,
      cssW,
      cssH,
      firstDt: hoverPoints.length > 0 ? hoverPoints[0].dt : null,
      points: hoverPoints,
    };

    // Zones behind series (normal / shadow / inverted).
    for (const range of this.shadedRanges) {
      const a = Date.parse(range.startDt);
      const b = Date.parse(range.endDt);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi < t0 || lo > t1) continue;
      const x0 = xOf(Math.max(lo, t0));
      const x1 = xOf(Math.min(hi, t1));
      const kind = range.kind ?? 'normal';
      const colors =
        kind === 'inverted'
          ? EQUITY_SHADE_COLORS.inverted
          : kind === 'long'
            ? EQUITY_SHADE_COLORS.long
            : kind === 'short'
              ? EQUITY_SHADE_COLORS.short
              : kind === 'shadow' || kind === 'paused'
                ? EQUITY_SHADE_COLORS.shadow
                : EQUITY_SHADE_COLORS.normal;
      ctx.fillStyle = colors.fill;
      ctx.fillRect(x0, padT, Math.max(2, x1 - x0), plotH);
    }

    // zero line
    ctx.setLineDash([]);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, yOf(0));
    ctx.lineTo(cssW - padR, yOf(0));
    ctx.stroke();

    // Горизонталь цели возобновления реала (shadow PnL → target−baseline).
    if (resumeY != null) {
      const shadowNow =
        this.shadowTotal.length > 0
          ? Number(this.shadowTotal[this.shadowTotal.length - 1].value)
          : 0;
      // Вне шкалы — у верхней кромки, но с зазором (не вплотную к padT).
      const yDraw = resumeOutOfScale ? padT + Math.max(14, plotH * 0.08) : yOf(resumeY);
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 1.75;
      ctx.setLineDash([10, 5]);
      ctx.beginPath();
      ctx.moveTo(padL, yDraw);
      ctx.lineTo(cssW - padR, yDraw);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#b45309';
      ctx.font = '600 10px system-ui, sans-serif';
      const pct =
        resumeY > 0 && Number.isFinite(shadowNow)
          ? Math.max(0, Math.min(999, Math.round((shadowNow / resumeY) * 100)))
          : 0;
      const label = resumeOutOfScale
        ? `цель ${this.fmt(resumeY)} ↑ · сейчас ${this.fmt(shadowNow)} (${pct}%)`
        : `цель ${this.fmt(resumeY)} · сейчас ${this.fmt(shadowNow)} (${pct}%)`;
      ctx.fillText(label, Math.max(padL + 4, cssW - padR - Math.min(220, label.length * 6)), Math.max(padT + 10, yDraw - 4));
    }

    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(this.fmt(vMax), 4, padT + 8);
    ctx.fillText(this.fmt(vMin), 4, cssH - padB);
    ctx.fillText('0', 4, yOf(0) + 3);

    for (const s of series) {
      const pts = s.pts
        .map((p) => ({ t: Date.parse(p.dt), v: p.value }))
        .filter((p) => Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t);
      if (pts.length === 0) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.setLineDash(s.dash);
      ctx.beginPath();
      if (pts.length === 1) {
        // Одна точка — короткая горизонталь, чтобы ноль был виден без закрытий.
        const x = xOf(pts[0].t);
        const y = yOf(pts[0].v);
        ctx.moveTo(Math.max(padL, x - 8), y);
        ctx.lineTo(Math.min(cssW - padR, x + plotW * 0.15), y);
      } else {
        pts.forEach((p, i) => {
          const x = xOf(p.t);
          const y = yOf(p.v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Вертикали портфельного SL/TP (как на ценовом графике).
    for (const m of this.stopMarkers) {
      const t = Date.parse(m.dt);
      if (!Number.isFinite(t)) continue;
      if (t < t0 || t > t1) continue;
      const x = xOf(t);
      const color = m.ruleKind === 'take_profit' ? '#059669' : '#dc2626';
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.font = '600 10px system-ui, sans-serif';
      const tag = m.ruleKind === 'take_profit' ? 'TP' : 'SL';
      const text = `${tag} ${m.label || ''}`.trim();
      ctx.fillText(text, Math.min(x + 4, cssW - padR - 72), padT + 12);
    }

    this.sharedTimeRange = { t0, t1 };
    // При polling/OpenChanges обновляем хинт под той же мышью, без «зависания» старых цифр.
    this.updateHover();
    this.drawSecurities();
  }

  private drawSecurities(): void {
    const canvas = this.secCanvasRef?.nativeElement;
    if (!canvas || this.activeSecurities.length < 2) return;
    const tr = this.sharedTimeRange;
    if (!tr) return;
    const { t0, t1 } = tr;
    const parent = canvas.parentElement;
    const cssW = Math.max(200, parent?.clientWidth || canvas.clientWidth || 400);
    const cssH = 72;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const secPts = this.activeSecurities
      .map((p) => ({ t: Date.parse(p.dt), v: p.value }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    if (secPts.length < 2) return;

    const secMin = Math.min(...secPts.map((p) => p.v));
    const secMax = Math.max(...secPts.map((p) => p.v));
    const secSpan = Math.max(secMax - secMin, 1);
    const padL = 48;
    const padR = 10;
    const padT = 6;
    const padB = 14;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    const xOf = (t: number) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const yOf = (v: number) => padT + (1 - (v - secMin) / secSpan) * plotH;

    // Grid lines
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 0.5;
    const gridSteps = Math.min(4, secMax - secMin);
    for (let i = 0; i <= gridSteps; i++) {
      const v = secMin + (secSpan * i) / gridSteps;
      const y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
    }

    // Line
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    secPts.forEach((p, i) => {
      const x = xOf(p.t);
      const y = yOf(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = '#92400e';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(secMax), padL - 4, padT + 8);
    ctx.fillText(String(secMin), padL - 4, cssH - padB + 2);
  }

  private fmt(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toFixed(0);
    if (abs >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }
}
