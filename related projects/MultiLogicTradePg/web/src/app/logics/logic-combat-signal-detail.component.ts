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
import { LogicSecurityRow } from '../models/logic.model';

export interface CombatPaperRatingPoint {
  dt: string;
  value: number;
  delta?: number;
}

const MAX_CHART_POINTS = 400;

@Component({
  selector: 'app-logic-combat-signal-detail',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './logic-combat-signal-detail.component.html',
  styleUrl: './logic-combat-signal-detail.component.css',
})
export class LogicCombatSignalDetailComponent
  implements OnChanges, OnDestroy, AfterViewChecked
{
  @Input({ required: true }) logicId!: number;
  @Input({ required: true }) signalId!: number;
  @Input() securities: LogicSecurityRow[] = [];
  @Input() reloadToken: string | number | null = null;

  @ViewChildren('ratingChart') chartCanvases?: QueryList<ElementRef<HTMLCanvasElement>>;

  expandedPaperId: number | null = null;
  loadingPaperId: number | null = null;
  error: string | null = null;
  pointsByPaper = new Map<number, CombatPaperRatingPoint[]>();
  paperRating = new Map<number, number>();

  private sub: Subscription | null = null;
  private chartDirty = false;
  private lastDrawnKey = '';

  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['logicId'] || changes['signalId'] || changes['reloadToken']) {
      this.pointsByPaper.clear();
      this.paperRating.clear();
      this.error = null;
      this.lastDrawnKey = '';
      if (this.expandedPaperId != null) {
        this.loadPaper(this.expandedPaperId, true);
      }
    }
  }

  ngAfterViewChecked(): void {
    if (!this.chartDirty || this.expandedPaperId == null) return;
    this.chartDirty = false;
    this.drawChartFor(this.expandedPaperId);
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  activePapers(): LogicSecurityRow[] {
    return (this.securities ?? []).filter((s) => s.is_active !== false);
  }

  paperLabel(sec: LogicSecurityRow): string {
    return sec.security_name || `id=${sec.security_id}`;
  }

  ratingOf(securityId: number): number {
    if (this.paperRating.has(securityId)) {
      return Number(this.paperRating.get(securityId));
    }
    const pts = this.pointsByPaper.get(securityId);
    if (pts?.length) return Number(pts[pts.length - 1].value);
    return 0;
  }

  togglePaper(securityId: number, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.expandedPaperId =
      this.expandedPaperId === securityId ? null : securityId;
    if (this.expandedPaperId != null) {
      this.loadPaper(this.expandedPaperId, false);
      this.chartDirty = true;
      this.lastDrawnKey = '';
    }
  }

  isPaperExpanded(securityId: number): boolean {
    return this.expandedPaperId === securityId;
  }

  private loadPaper(securityId: number, force: boolean): void {
    if (!this.logicId || !this.signalId || !securityId) return;
    if (!force && this.pointsByPaper.has(securityId)) {
      this.chartDirty = true;
      this.lastDrawnKey = '';
      return;
    }
    this.loadingPaperId = securityId;
    this.error = null;
    this.sub?.unsubscribe();
    const params = new URLSearchParams({
      logic_id: String(this.logicId),
      signal_id: String(this.signalId),
      security_id: String(securityId),
      is_test: '0',
    });
    const url = `${this.appConfig.apiUrl}/logic-signal-ratings/history?${params}`;
    this.sub = this.http
      .get<{
        signals: Array<{
          signal_id: number;
          paper_rating?: number;
          points: CombatPaperRatingPoint[];
        }>;
      }>(url)
      .subscribe({
        next: (resp) => {
          const series = (resp.signals ?? []).find(
            (s) => s.signal_id === this.signalId
          );
          const points = series?.points ?? [];
          this.pointsByPaper.set(securityId, points);
          this.paperRating.set(
            securityId,
            series?.paper_rating != null
              ? Number(series.paper_rating)
              : points.length
                ? Number(points[points.length - 1].value)
                : 0
          );
          this.loadingPaperId = null;
          if (this.expandedPaperId === securityId) {
            this.chartDirty = true;
            this.lastDrawnKey = '';
          }
        },
        error: (err) => {
          this.loadingPaperId = null;
          this.error =
            err?.error?.error ?? 'Не удалось загрузить рейтинг по бумаге';
        },
      });
  }

  private downsample(
    points: CombatPaperRatingPoint[]
  ): CombatPaperRatingPoint[] {
    if (!points.length) return [];
    const byDt = new Map<string, CombatPaperRatingPoint>();
    for (const p of points) {
      const key = String(p.dt);
      byDt.set(key, { dt: key, value: Number(p.value), delta: p.delta });
    }
    const uniq = [...byDt.values()];
    if (uniq.length <= MAX_CHART_POINTS) return uniq;
    const out: CombatPaperRatingPoint[] = [];
    const last = uniq.length - 1;
    for (let i = 0; i < MAX_CHART_POINTS; i++) {
      const idx = Math.round((i * last) / (MAX_CHART_POINTS - 1));
      out.push(uniq[idx]);
    }
    return out;
  }

  private drawChartFor(securityId: number): void {
    const pointsRaw = this.pointsByPaper.get(securityId) ?? [];
    const canvas = this.chartCanvases?.find((ref) => {
      return Number(ref.nativeElement.getAttribute('data-security')) === securityId;
    })?.nativeElement;
    if (!canvas) {
      this.chartDirty = true;
      return;
    }
    const points = this.downsample(pointsRaw);
    const drawKey = `${this.signalId}:${securityId}:${points.length}:${points[points.length - 1]?.value ?? ''}`;
    if (drawKey === this.lastDrawnKey) return;
    this.lastDrawnKey = drawKey;

    const w = Math.max(canvas.clientWidth || 640, 280);
    const h = 150;
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
      ctx.fillText('Нет проверок за окно боевого рейтинга', 12, 28);
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

    ctx.strokeStyle = '#0d9488';
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
