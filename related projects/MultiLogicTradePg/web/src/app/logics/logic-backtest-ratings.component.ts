import {
  AfterViewChecked,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  QueryList,
  SimpleChanges,
  ViewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { AppConfigService } from '../services/app-config.service';
import {
  positionEventLabel,
  positionSideLabel,
  signalKindLabel,
} from '../shared/signal-formula';

export interface SignalRatingPoint {
  dt: string;
  value: number;
  delta?: number;
}

export interface SignalRatingSeries {
  signal_id: number;
  indicator_code: string;
  indicator_name: string;
  position_event: 'open' | 'close';
  position_side: 'long' | 'short';
  signal_kind: 'trend' | 'counter';
  formula: string;
  rating: number;
  rating_test: number;
  paper_rating?: number;
  points: SignalRatingPoint[];
}

const MAX_CHART_POINTS = 400;

@Component({
  selector: 'app-logic-backtest-ratings',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './logic-backtest-ratings.component.html',
  styleUrl: './logic-backtest-ratings.component.css',
})
export class LogicBacktestRatingsComponent
  implements OnChanges, OnDestroy, AfterViewChecked
{
  @Input({ required: true }) logicId!: number;
  @Input({ required: true }) securityId!: number;
  @Input() runId: number | null = null;
  @Input() reloadToken: string | number | null = null;

  @ViewChildren('ratingChart') chartCanvases?: QueryList<ElementRef<HTMLCanvasElement>>;

  expanded = false;
  loading = false;
  error: string | null = null;
  signals: SignalRatingSeries[] = [];
  expandedSignalId: number | null = null;

  private sub: Subscription | null = null;
  private chartDirty = false;
  private lastDrawnKey = '';
  private lastLoadAt = 0;
  private lastLoadToken = '';

  signalKindLabel = signalKindLabel;
  positionSideLabel = positionSideLabel;
  positionEventLabel = positionEventLabel;

  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.expanded) return;
    if (changes['logicId'] || changes['runId'] || changes['securityId']) {
      this.load(true);
      return;
    }
    if (changes['reloadToken']) {
      this.load(false);
    }
  }

  ngAfterViewChecked(): void {
    if (!this.chartDirty || this.expandedSignalId == null) return;
    this.chartDirty = false;
    this.drawChartFor(this.expandedSignalId);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  paperRating(sig: SignalRatingSeries): number {
    if (sig.paper_rating != null) return Number(sig.paper_rating);
    if (sig.points?.length) return Number(sig.points[sig.points.length - 1].value);
    return Number(sig.rating_test ?? 0);
  }

  toggleBlock(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.expanded = !this.expanded;
    if (this.expanded) {
      this.load(true);
    }
  }

  toggleSignal(signalId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.expandedSignalId =
      this.expandedSignalId === signalId ? null : signalId;
    if (this.expandedSignalId != null) {
      this.chartDirty = true;
      this.lastDrawnKey = '';
    }
  }

  isSignalExpanded(signalId: number): boolean {
    return this.expandedSignalId === signalId;
  }

  chartPointCount(sig: SignalRatingSeries): number {
    return this.downsample(sig.points ?? []).length;
  }

  private load(force: boolean): void {
    if (!this.logicId || !this.securityId) return;
    const token = `${this.logicId}:${this.securityId}:${this.runId ?? ''}`;
    const now = Date.now();
    if (!force && now - this.lastLoadAt < 8000 && token === this.lastLoadToken) {
      return;
    }
    this.lastLoadAt = now;
    this.lastLoadToken = token;
    this.loading = true;
    this.error = null;
    this.sub?.unsubscribe();
    const params = new URLSearchParams({
      logic_id: String(this.logicId),
      security_id: String(this.securityId),
      is_test: '1',
    });
    if (this.runId != null) {
      params.set('run_id', String(this.runId));
    }
    const url = `${this.appConfig.apiUrl}/logic-signal-ratings/history?${params}`;
    this.sub = this.http.get<{ signals: SignalRatingSeries[] }>(url).subscribe({
      next: (resp) => {
        this.signals = resp.signals ?? [];
        this.loading = false;
        if (
          this.expandedSignalId != null &&
          !this.signals.some((s) => s.signal_id === this.expandedSignalId)
        ) {
          this.expandedSignalId = null;
        }
        if (this.expandedSignalId != null) {
          this.chartDirty = true;
          this.lastDrawnKey = '';
        }
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.error ?? 'Не удалось загрузить рейтинги сигналов';
      },
    });
  }

  private downsample(points: SignalRatingPoint[]): SignalRatingPoint[] {
    if (!points.length) return [];
    const byDt = new Map<string, SignalRatingPoint>();
    for (const p of points) {
      const key = String(p.dt);
      byDt.set(key, { dt: key, value: Number(p.value), delta: p.delta });
    }
    const uniq = [...byDt.values()];
    if (uniq.length <= MAX_CHART_POINTS) return uniq;
    const out: SignalRatingPoint[] = [];
    const last = uniq.length - 1;
    for (let i = 0; i < MAX_CHART_POINTS; i++) {
      const idx = Math.round((i * last) / (MAX_CHART_POINTS - 1));
      out.push(uniq[idx]);
    }
    return out;
  }

  private drawChartFor(signalId: number): void {
    const series = this.signals.find((s) => s.signal_id === signalId);
    const canvas = this.chartCanvases?.find((ref) => {
      return Number(ref.nativeElement.getAttribute('data-signal')) === signalId;
    })?.nativeElement;
    if (!series || !canvas) {
      this.chartDirty = true;
      return;
    }
    const points = this.downsample(series.points ?? []);
    const drawKey = `${this.securityId}:${signalId}:${points.length}:${points[points.length - 1]?.value ?? ''}`;
    if (drawKey === this.lastDrawnKey) return;
    this.lastDrawnKey = drawKey;

    const w = Math.max(canvas.clientWidth || 640, 280);
    const h = 160;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#e2e8f0';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    if (points.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.fillText('Нет проверок на следующей свече за этот прогон', 12, 28);
      return;
    }

    const padL = 36;
    const padR = 12;
    const padT = 14;
    const padB = 22;
    const vals = points.map((p) => p.value);
    let vmin = Math.min(...vals, 0);
    let vmax = Math.max(...vals, 0);
    if (vmin === vmax) {
      vmax = vmin + 1;
      vmin = vmin - 1;
    }
    const n = points.length;
    const xAt = (i: number) =>
      padL + (n <= 1 ? 0 : (i / (n - 1)) * (w - padL - padR));
    const yAt = (v: number) =>
      padT + ((vmax - v) / (vmax - vmin)) * (h - padT - padB);

    ctx.strokeStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(padL, yAt(0));
    ctx.lineTo(w - padR, yAt(0));
    ctx.stroke();

    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xAt(i);
      const y = yAt(points[i].value);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevY = yAt(points[i - 1].value);
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.fillText(String(Math.round(vmax)), 4, padT + 8);
    ctx.fillText(String(Math.round(vmin)), 4, h - padB);
    const last = points[n - 1];
    ctx.fillStyle = '#0f172a';
    ctx.font = '11px sans-serif';
    ctx.fillText(`рейтинг ${last.value}`, w - 96, 16);
  }
}
