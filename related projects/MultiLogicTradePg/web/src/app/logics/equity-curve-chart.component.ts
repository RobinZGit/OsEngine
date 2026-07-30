import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
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
} as const;

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
      <canvas #canvas class="equity-curve-canvas"></canvas>
      <p class="equity-curve-legend">
        <span class="leg-total">━━</span> общая ·
        <span class="leg-long">──</span> лонги ·
        <span class="leg-short">──</span> шорты
        @if (shadowTotal.length > 1 || (shadowTotal.length === 1 && shadowTotal[0].value !== 0)) {
          · <span class="leg-shadow-line">- - -</span> shadow
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
      </p>
    </div>
  `,
  styles: [
    `
      .equity-curve-wrap {
        width: 100%;
        min-height: 180px;
      }
      .equity-curve-canvas {
        display: block;
        width: 100%;
        height: 200px;
        background: #fafbfc;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
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
    `,
  ],
})
export class EquityCurveChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  @Input() total: ChartEquityPoint[] = [];
  @Input() longs: ChartEquityPoint[] = [];
  @Input() shorts: ChartEquityPoint[] = [];
  /** Теневая эквити (пунктир). */
  @Input() shadowTotal: ChartEquityPoint[] = [];
  /** Портфельные SL/TP (вертикали на баре срабатывания). */
  @Input() stopMarkers: ChartStopMarker[] = [];
  /** Зоны обычная / shadow / инверсия (график эквити бумаги / портфеля). */
  @Input() shadedRanges: ChartShadedRange[] = [];
  /** Показать подписи цветов зон в легенде (для бумаг). */
  @Input() showModeLegend = false;

  private resizeObs: ResizeObserver | null = null;

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
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Нет данных для эквити', 12, cssH / 2);
      return;
    }

    const all = series.flatMap((s) => s.pts);
    const times = all.map((p) => Date.parse(p.dt)).filter((t) => Number.isFinite(t));
    const values = all.map((p) => p.value);
    let t0 = Math.min(...times);
    let t1 = Math.max(...times);
    // Если только одна точка (ноль без закрытий) — растянуть ось на сутки вперёд.
    if (t1 <= t0) t1 = t0 + 24 * 60 * 60 * 1000;
    let vMin = Math.min(0, ...values);
    let vMax = Math.max(0, ...values);
    if (vMax === vMin) {
      vMax += 1;
      vMin -= 1;
    }
    const padL = 48;
    const padR = 10;
    const padT = 10;
    const padB = 22;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    const xOf = (t: number) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const yOf = (v: number) => padT + ((vMax - v) / (vMax - vMin)) * plotH;

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
  }

  private fmt(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toFixed(0);
    if (abs >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }
}
