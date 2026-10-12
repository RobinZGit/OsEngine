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

export interface ErrorTrendPoint {
  t: number;
  count: number;
}

/**
 * Простой график отказов: столбик = одна минута, высота = число ошибок.
 * Без разбиения по типам — только чтобы одним взглядом понять «было сегодня или нет».
 */
@Component({
  selector: 'app-error-trend-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="err-chart-wrap">
      <canvas #canvas class="err-chart-canvas"></canvas>
      <p class="err-chart-legend">
        @if (points.length) {
          <span>Всего за окно: <b class="err-total">{{ total }}</b></span>
          <span>· максимум в минуту: <b>{{ peak }}</b></span>
        } @else {
          <span>Нет данных</span>
        }
      </p>
    </div>
  `,
  styles: [
    `
      .err-chart-wrap {
        width: 100%;
      }
      .err-chart-canvas {
        display: block;
        width: 100%;
        height: 140px;
        background: #fafbfc;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
      }
      .err-chart-legend {
        margin: 4px 0 0;
        font-size: 11px;
        color: #64748b;
      }
      .err-total {
        color: #dc2626;
      }
    `,
  ],
})
export class ErrorTrendChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() points: ErrorTrendPoint[] = [];
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private resizeObs: ResizeObserver | null = null;
  private raf = 0;

  get total(): number {
    return this.points.reduce((acc, p) => acc + Number(p.count || 0), 0);
  }

  get peak(): number {
    return this.points.reduce((acc, p) => Math.max(acc, Number(p.count || 0)), 0);
  }

  ngAfterViewInit(): void {
    this.resizeObs = new ResizeObserver(() => this.scheduleDraw());
    this.resizeObs.observe(this.canvasRef.nativeElement);
    this.draw();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    this.scheduleDraw();
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  private scheduleDraw(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const cssW = Math.max(240, parent?.clientWidth || canvas.clientWidth || 400);
    const cssH = 140;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 30;
    const padR = 8;
    const padT = 8;
    const padB = 16;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;

    const n = this.points.length;
    if (n === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Нет данных за окно', padL, cssH / 2);
      return;
    }

    const max = Math.max(1, this.peak);

    // Сетка + подписи оси Y.
    ctx.strokeStyle = '#e2e8f0';
    ctx.fillStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 2; i++) {
      const y = padT + (plotH * i) / 2;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
      const val = Math.round(max - (max * i) / 2);
      ctx.fillText(String(val), padL - 4, y + 3);
    }
    ctx.textAlign = 'left';

    const barW = plotW / n;
    const gap = Math.min(2, barW * 0.25);
    for (let i = 0; i < n; i++) {
      const count = Number(this.points[i].count || 0);
      const x = padL + i * barW;
      const h = count > 0 ? Math.max(2, (count / max) * plotH) : 0;
      if (count > 0) {
        ctx.fillStyle = count >= max && max > 1 ? '#b91c1c' : '#dc2626';
        ctx.fillRect(x, padT + plotH - h, Math.max(1, barW - gap), h);
      } else {
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(x, padT + plotH - 1, Math.max(1, barW - gap), 1);
      }
    }

    // Подписи времени начала/конца окна.
    const first = this.points[0]?.t;
    const last = this.points[n - 1]?.t;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    if (Number.isFinite(first)) ctx.fillText(this.hhmm(first), padL, cssH - 4);
    if (Number.isFinite(last)) {
      const label = this.hhmm(last);
      ctx.textAlign = 'right';
      ctx.fillText(label, cssW - padR, cssH - 4);
      ctx.textAlign = 'left';
    }
  }

  private hhmm(ms: number): string {
    const d = new Date(ms);
    const p = (v: number) => String(v).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}
