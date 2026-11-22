import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LogicIndicatorSignalRow, LogicRow, LogicStopRow } from '../models/logic.model';
import {
  ChartStopMarker,
  ChartTradeMarker,
  PriceCandle,
} from '../models/market.model';
import { PriceChartComponent } from '../price-chart/price-chart.component';
import { positionEventLabel, positionSideLabel, signalKindLabel } from '../shared/signal-formula';

interface VizEvent {
  barIndex: number;
  dt: string;
  price: number;
  kind: 'open' | 'close' | 'stop';
  side: 'long' | 'short';
  label: string;
  detail: string;
  signalId?: number;
  stopId?: number;
  ruleKind?: 'stop_loss' | 'take_profit' | 'other';
  finRes?: number;
}

interface VizPopup {
  kind: 'open' | 'close' | 'stop';
  side: 'long' | 'short';
  title: string;
  detail: string;
  finRes?: number;
  accumulatedFinRes: number;
}

@Component({
  selector: 'app-logic-visualization',
  standalone: true,
  imports: [CommonModule, FormsModule, PriceChartComponent],
  templateUrl: './logic-visualization.component.html',
  styleUrl: './logic-visualization.component.css',
})
export class LogicVisualizationComponent implements OnChanges {
  @Input() logic: LogicRow | null = null;
  @Input() signals: LogicIndicatorSignalRow[] = [];
  @Input() stops: LogicStopRow[] = [];
  @Output() closed = new EventEmitter<void>();

  allCandles: PriceCandle[] = [];
  visibleCandles: PriceCandle[] = [];
  visibleTradeMarkers: ChartTradeMarker[] = [];
  visibleStopMarkers: ChartStopMarker[] = [];
  events: VizEvent[] = [];
  sliderIndex = 0;
  maxIndex = 0;
  playSpeed = 0;
  focusDt: string | null = null;
  accumulatedFinRes = 0;
  popup: VizPopup | null = null;
  private popupTimer: ReturnType<typeof setTimeout> | null = null;
  private playTimer: ReturnType<typeof setInterval> | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['logic'] || changes['signals'] || changes['stops']) {
      this.rebuild();
    }
  }

  close(): void {
    this.stopPlay();
    this.hidePopup();
    this.closed.emit();
  }

  onSliderChange(value: number): void {
    const prev = this.sliderIndex;
    this.sliderIndex = Number(value);
    this.syncVisible(prev);
  }

  togglePlay(): void {
    if (this.playSpeed > 0) {
      this.stopPlay();
      return;
    }
    this.playSpeed = 1;
    this.playTimer = setInterval(() => {
      if (this.sliderIndex >= this.maxIndex) {
        this.stopPlay();
        return;
      }
      const prev = this.sliderIndex;
      this.sliderIndex += 1;
      this.syncVisible(prev);
    }, 220);
  }

  stopPlay(): void {
    this.playSpeed = 0;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  step(delta: number): void {
    this.stopPlay();
    const prev = this.sliderIndex;
    const next = Math.max(0, Math.min(this.maxIndex, this.sliderIndex + delta));
    this.sliderIndex = next;
    this.syncVisible(prev);
  }

  toStart(): void {
    this.stopPlay();
    const prev = this.sliderIndex;
    this.sliderIndex = 0;
    this.syncVisible(prev);
  }

  toEnd(): void {
    this.stopPlay();
    const prev = this.sliderIndex;
    this.sliderIndex = this.maxIndex;
    this.syncVisible(prev);
  }

  currentDt(): string {
    const c = this.allCandles[this.sliderIndex];
    return c ? this.fmtDt(c.dt) : '—';
  }

  currentPrice(): string {
    const c = this.allCandles[this.sliderIndex];
    return c ? Number(c.close_price).toFixed(2) : '—';
  }

  visibleEvents(): VizEvent[] {
    return this.events.filter((e) => e.barIndex <= this.sliderIndex);
  }

  eventIcon(e: VizEvent): string {
    if (e.kind === 'stop') return e.ruleKind === 'take_profit' ? 'TP' : 'SL';
    if (e.kind === 'open') return e.side === 'long' ? 'L+' : 'S+';
    return e.side === 'long' ? 'L−' : 'S−';
  }

  eventClass(e: VizEvent): string {
    if (e.kind === 'stop') return e.ruleKind === 'take_profit' ? 'ev-tp' : 'ev-sl';
    if (e.kind === 'open') return e.side === 'long' ? 'ev-open-long' : 'ev-open-short';
    return e.side === 'long' ? 'ev-close-long' : 'ev-close-short';
  }

  fmtDt(dt: string): string {
    const d = String(dt || '').replace('T', ' ').slice(0, 16);
    return d;
  }

  formatFinRes(value: number): string {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}`;
  }

  finResClass(value: number): string {
    if (value > 0) return 'finres-pos';
    if (value < 0) return 'finres-neg';
    return 'finres-zero';
  }

  hidePopup(): void {
    this.popup = null;
    if (this.popupTimer) {
      clearTimeout(this.popupTimer);
      this.popupTimer = null;
    }
  }

  private showPopupForIndex(index: number, prevIndex?: number): void {
    const candidates = this.events.filter((e) => e.barIndex === index && e.kind !== 'stop');
    if (candidates.length === 0) return;
    const e = prevIndex != null && index < prevIndex ? candidates[0] : candidates[candidates.length - 1];
    const isOpen = e.kind === 'open';
    const sideText = e.side === 'long' ? 'LONG' : 'SHORT';
    const title = isOpen ? `Бац! Вошли в сделку ${sideText}` : `Бац! Вышли из сделки ${sideText}`;
    const detail = isOpen
      ? `${e.label} · ${this.fmtDt(e.dt)}`
      : `${e.label} · Финрез: ${this.formatFinRes(Number(e.finRes ?? 0))}`;
    this.popup = {
      kind: e.kind,
      side: e.side,
      title,
      detail,
      finRes: e.finRes,
      accumulatedFinRes: this.accumulatedFinRes,
    };
    if (this.popupTimer) clearTimeout(this.popupTimer);
    this.popupTimer = setTimeout(() => {
      this.popup = null;
      this.popupTimer = null;
    }, 2600);
  }

  private rebuild(): void {
    this.stopPlay();
    this.hidePopup();
    this.allCandles = this.generateCandles();
    this.maxIndex = Math.max(0, this.allCandles.length - 1);
    this.events = this.buildScenario(this.allCandles, this.signals ?? [], this.stops ?? []);
    this.sliderIndex = 0;
    this.syncVisible();
  }

  private syncVisible(prevIndex?: number): void {
    const upto = Math.max(0, Math.min(this.maxIndex, this.sliderIndex));
    this.visibleCandles = this.allCandles;
    this.focusDt = this.allCandles[upto]?.dt ?? null;
    this.accumulatedFinRes = this.events
      .filter((e) => e.barIndex <= upto && e.kind === 'close')
      .reduce((sum, e) => sum + Number(e.finRes ?? 0), 0);
    this.visibleTradeMarkers = this.events
      .filter((e) => e.barIndex <= upto && e.kind !== 'stop')
      .map((e) => ({
        dt: e.dt,
        price: e.price,
        kind: e.kind as 'open' | 'close',
        side: e.side,
        isShadow: false,
        label: e.label,
      }));
    this.visibleStopMarkers = this.events
      .filter((e) => e.barIndex <= upto && e.kind === 'stop')
      .map((e) => ({
        dt: e.dt,
        price: e.price,
        ruleKind: (e.ruleKind ?? 'other') as 'stop_loss' | 'take_profit' | 'other',
        label: e.label,
      }));
    if (prevIndex !== undefined && prevIndex !== upto) {
      this.showPopupForIndex(upto, prevIndex);
    } else if (prevIndex === undefined) {
      this.hidePopup();
    }
  }

  /** Генерирует условный однодневный график: рост, пик, падение, боковик, пики, EOD. */
  private generateCandles(): PriceCandle[] {
    const out: PriceCandle[] = [];
    const day = '2026-11-20';
    let t = 10 * 60; // 10:00 in minutes
    const end = 18 * 60 + 50; // 18:50
    const stepMin = 5;
    let price = 100;

    const push = (o: number, h: number, l: number, c: number) => {
      const hh = Math.floor(t / 60);
      const mm = t % 60;
      const dt = `${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
      out.push({
        dt,
        open_price: +o.toFixed(2),
        high_price: +Math.max(o, h, l, c).toFixed(2),
        low_price: +Math.min(o, h, l, c).toFixed(2),
        close_price: +c.toFixed(2),
        volume: 1000 + Math.round(Math.abs(c - o) * 500),
      });
      t += stepMin;
      price = c;
    };

    // Phase 1: gentle uptrend (10:00-11:30)
    for (let i = 0; i < 18; i++) {
      const o = price;
      const c = o + 0.25 + (i % 3) * 0.08;
      push(o, c + 0.15, o - 0.1, c);
    }
    // Phase 2: sharp peak up (11:30-12:10)
    for (let i = 0; i < 8; i++) {
      const o = price;
      const c = o + (i < 4 ? 0.9 : -0.5);
      push(o, Math.max(o, c) + 0.35, Math.min(o, c) - 0.2, c);
    }
    // Phase 3: pullback/downtrend (12:10-13:30)
    for (let i = 0; i < 16; i++) {
      const o = price;
      const c = o - 0.35 - (i % 4 === 0 ? 0.2 : 0);
      push(o, o + 0.12, c - 0.18, c);
    }
    // Phase 4: sideways (13:30-14:40)
    const base = price;
    for (let i = 0; i < 14; i++) {
      const o = price;
      const wave = Math.sin(i / 2) * 0.35;
      const c = base + wave;
      push(o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c);
    }
    // Phase 5: sharp drop & rebound (14:40-15:30)
    for (let i = 0; i < 10; i++) {
      const o = price;
      const c = o + (i < 4 ? -0.8 : 0.65);
      push(o, Math.max(o, c) + 0.25, Math.min(o, c) - 0.3, c);
    }
    // Phase 6: uptrend with small peaks (15:30-17:00)
    for (let i = 0; i < 18; i++) {
      const o = price;
      const bump = i % 5 === 2 ? 0.45 : i % 5 === 3 ? -0.2 : 0.22;
      const c = o + bump;
      push(o, Math.max(o, c) + 0.18, Math.min(o, c) - 0.15, c);
    }
    // Phase 7: late drift down to EOD (17:00-18:50)
    while (t <= end) {
      const o = price;
      const remain = end - t;
      const c = remain < 15 ? o - 0.05 : o - 0.12 + (Math.random() > 0.7 ? 0.08 : 0);
      const last = t + stepMin > end;
      push(o, o + 0.1, c - (last ? 0.05 : 0.12), last ? o - 0.03 : c);
    }
    // Ensure EOD marker bar
    if (out.length > 0) {
      const last = out[out.length - 1];
      last.dt = `${day}T18:50:00`;
    }
    return out;
  }

  /**
   * Строит демонстрационный сценарий: каждый сигнал и каждый стоп логики
   * получает хотя бы одно срабатывание на условном графике. Это визуализация
   * конфигурации, а не реальный расчёт формул индикаторов.
   */
  private buildScenario(
    candles: PriceCandle[],
    signals: LogicIndicatorSignalRow[],
    stops: LogicStopRow[]
  ): VizEvent[] {
    if (candles.length < 10) return [];
    const events: VizEvent[] = [];
    const n = candles.length;
    const at = (idx: number) => Math.max(1, Math.min(n - 2, idx));
    const priceAt = (idx: number) => Number(candles[at(idx)].close_price);
    const dtAt = (idx: number) => candles[at(idx)].dt;

    // Predefined anchor points in chart phases
    const anchors = {
      upEarly: at(Math.floor(n * 0.08)),
      peak1: at(Math.floor(n * 0.22)),
      down: at(Math.floor(n * 0.35)),
      sideways: at(Math.floor(n * 0.48)),
      drop: at(Math.floor(n * 0.58)),
      rebound: at(Math.floor(n * 0.63)),
      upLate: at(Math.floor(n * 0.75)),
      late: at(Math.floor(n * 0.86)),
      eod: n - 1,
    };

    const activeSignals = signals.filter((s) => s.is_active !== false);
    const activeStops = stops.filter((s) => s.is_active !== false);

    // Group signals
    const opensLong = activeSignals.filter((s) => s.position_event === 'open' && s.position_side === 'long');
    const opensShort = activeSignals.filter((s) => s.position_event === 'open' && s.position_side === 'short');
    const closesLong = activeSignals.filter((s) => s.position_event === 'close' && s.position_side === 'long');
    const closesShort = activeSignals.filter((s) => s.position_event === 'close' && s.position_side === 'short');

    const slStops = activeStops.filter((s) => s.rule_kind === 'stop_loss');
    const tpStops = activeStops.filter((s) => s.rule_kind === 'take_profit');

    let cursor = anchors.upEarly;

    let finResCursor = 0;
    const nextFinRes = (kind: VizEvent['kind'], ruleKind?: VizEvent['ruleKind'], explicit?: number) => {
      if (explicit != null) return explicit;
      if (kind !== 'close') return undefined;
      const pattern = [1240.5, -860.25, 1530, -420.75, 980.4, -315.1, 2110.8, -540.6];
      const v = pattern[Math.abs(finResCursor) % pattern.length];
      finResCursor += 1;
      if (ruleKind === 'take_profit') return Math.abs(v);
      if (ruleKind === 'stop_loss') return -Math.abs(v);
      return v;
    };

    const pushEvent = (barIndex: number, kind: VizEvent['kind'], side: 'long' | 'short', label: string, detail: string, extra?: Partial<VizEvent>) => {
      const idx = at(barIndex);
      const finRes = nextFinRes(kind, extra?.ruleKind, extra?.finRes);
      events.push({
        barIndex: idx,
        dt: dtAt(idx),
        price: priceAt(idx),
        kind,
        side,
        label,
        detail,
        ...extra,
        ...(finRes != null ? { finRes } : {}),
      });
    };

    const signalLabel = (s: LogicIndicatorSignalRow) => {
      const ev = s.position_event === 'open' ? 'Вход' : 'Выход';
      const side = s.position_side === 'long' ? 'L' : 'S';
      return `${ev} ${side}: ${s.indicator_code}`;
    };
    const signalDetail = (s: LogicIndicatorSignalRow) =>
      `${positionEventLabel(s.position_event as any)} ${positionSideLabel(s.position_side as any)} · ${signalKindLabel(s.signal_kind as any)} · ${s.formula}`;

    // Scenario 1: Long open -> TP/close or SL
    const longOpen = opensLong[0];
    if (longOpen || slStops.length || tpStops.length || closesLong.length) {
      const openIdx = anchors.upEarly;
      if (longOpen) {
        pushEvent(openIdx, 'open', 'long', signalLabel(longOpen), signalDetail(longOpen), { signalId: longOpen.id });
      } else {
        pushEvent(openIdx, 'open', 'long', 'Вход L (демо)', 'Демонстрационный вход в лонг для показа стопов/выходов');
      }
      cursor = openIdx + 3;

      // TP stop demo
      if (tpStops.length > 0) {
        const tp = tpStops[0];
        pushEvent(anchors.peak1, 'stop', 'long', `TP: ${tp.scope_type}`, `Take Profit ${tp.value}${tp.value_unit === 'percent' ? '%' : ' ATR'} (${tp.scope_type})`, { stopId: tp.id, ruleKind: 'take_profit' });
        pushEvent(anchors.peak1, 'close', 'long', 'Выход L по TP', `Закрытие лонга по тейк-профиту`, { ruleKind: 'take_profit' });
      } else if (closesLong.length > 0) {
        const cs = closesLong[0];
        pushEvent(anchors.peak1, 'close', 'long', signalLabel(cs), signalDetail(cs), { signalId: cs.id });
      } else {
        pushEvent(anchors.peak1, 'close', 'long', 'Выход L (демо)', 'Демонстрационное закрытие лонга');
      }
    }

    // Scenario 2: Short open -> SL demo
    const shortOpen = opensShort[0];
    if (shortOpen || slStops.length || closesShort.length) {
      const openIdx = anchors.down;
      if (shortOpen) {
        pushEvent(openIdx, 'open', 'short', signalLabel(shortOpen), signalDetail(shortOpen), { signalId: shortOpen.id });
      } else if (slStops.length > 0 || closesShort.length > 0) {
        pushEvent(openIdx, 'open', 'short', 'Вход S (демо)', 'Демонстрационный вход в шорт для показа стопов/выходов');
      }
      if (slStops.length > 0) {
        const sl = slStops[0];
        pushEvent(anchors.sideways, 'stop', 'short', `SL: ${sl.scope_type}`, `Stop Loss ${sl.value}${sl.value_unit === 'percent' ? '%' : ' ATR'} (${sl.scope_type})`, { stopId: sl.id, ruleKind: 'stop_loss' });
        pushEvent(anchors.sideways, 'close', 'short', 'Выход S по SL', 'Закрытие шорта по стоп-лоссу', { ruleKind: 'stop_loss' });
      } else if (closesShort.length > 0) {
        const cs = closesShort[0];
        pushEvent(anchors.sideways, 'close', 'short', signalLabel(cs), signalDetail(cs), { signalId: cs.id });
      } else if (shortOpen) {
        pushEvent(anchors.sideways, 'close', 'short', 'Выход S (демо)', 'Демонстрационное закрытие шорта');
      }
    }

    // Scenario 3: another Long with remaining stops/signals
    const remainingLongOpens = opensLong.slice(1);
    const remainingClosesLong = closesLong.slice(tpStops.length > 0 ? 0 : 1);
    const remainingSl = slStops.slice(opensShort[0] || closesShort.length || slStops.length ? 1 : 0);
    const remainingTp = tpStops.slice(1);

    const openIdx2 = anchors.drop;
    const needScenario3 = remainingLongOpens.length > 0 || remainingClosesLong.length > 0 || remainingSl.length > 0 || remainingTp.length > 0 || (opensLong.length > 1);
    if (needScenario3) {
      const lo = remainingLongOpens[0] ?? opensLong[Math.min(1, opensLong.length - 1)] ?? null;
      if (lo && !events.some((e) => e.signalId === lo.id && e.kind === 'open')) {
        pushEvent(openIdx2, 'open', 'long', signalLabel(lo), signalDetail(lo), { signalId: lo.id });
      } else if (remainingSl.length > 0 || remainingTp.length > 0) {
        pushEvent(openIdx2, 'open', 'long', 'Вход L (демо)', 'Демонстрационный вход для показа оставшихся стопов');
      }

      let closeIdx2 = anchors.upLate;
      if (remainingSl.length > 0) {
        const sl = remainingSl[0];
        pushEvent(anchors.rebound, 'stop', 'long', `SL: ${sl.scope_type}`, `Stop Loss ${sl.value}${sl.value_unit === 'percent' ? '%' : ' ATR'} (${sl.scope_type})`, { stopId: sl.id, ruleKind: 'stop_loss' });
        pushEvent(anchors.rebound, 'close', 'long', 'Выход L по SL', 'Закрытие лонга по стоп-лоссу', { ruleKind: 'stop_loss' });
        closeIdx2 = -1;
      }
      if (remainingTp.length > 0) {
        const tp = remainingTp[0];
        const tpIdx = closeIdx2 > 0 ? closeIdx2 : anchors.upLate;
        pushEvent(tpIdx, 'stop', 'long', `TP: ${tp.scope_type}`, `Take Profit ${tp.value}${tp.value_unit === 'percent' ? '%' : ' ATR'} (${tp.scope_type})`, { stopId: tp.id, ruleKind: 'take_profit' });
      }
      if (closeIdx2 > 0) {
        const cl = remainingClosesLong.find((s) => !events.some((e) => e.signalId === s.id));
        if (cl) {
          pushEvent(closeIdx2, 'close', 'long', signalLabel(cl), signalDetail(cl), { signalId: cl.id });
        } else {
          pushEvent(closeIdx2, 'close', 'long', 'Выход L (демо)', 'Демонстрационное закрытие');
        }
      }
    }

    // Ensure all signals get at least one marker
    const usedSignalIds = new Set(events.filter((e) => e.signalId != null).map((e) => e.signalId));
    let extraIdx = at(Math.floor(n * 0.15));
    for (const s of activeSignals) {
      if (usedSignalIds.has(s.id)) continue;
      const kind = s.position_event === 'open' ? 'open' : 'close';
      pushEvent(extraIdx, kind, s.position_side as 'long' | 'short', signalLabel(s), signalDetail(s), { signalId: s.id });
      extraIdx = at(extraIdx + 4);
      usedSignalIds.add(s.id);
    }

    // Ensure all stops get at least one marker
    const usedStopIds = new Set(events.filter((e) => e.stopId != null).map((e) => e.stopId));
    let stopIdx = at(Math.floor(n * 0.55));
    for (const s of activeStops) {
      if (usedStopIds.has(s.id)) continue;
      const rk = s.rule_kind === 'take_profit' ? 'take_profit' : 'stop_loss';
      pushEvent(stopIdx, 'stop', 'long', `${rk === 'take_profit' ? 'TP' : 'SL'}: ${s.scope_type}`, `${s.rule_kind} ${s.value}${s.value_unit === 'percent' ? '%' : ' ATR'} (${s.scope_type})`, { stopId: s.id, ruleKind: rk });
      stopIdx = at(stopIdx + 5);
      usedStopIds.add(s.id);
    }

    // EOD close at end
    const eodIdx = n - 1;
    const hasEod = events.some((e) => e.barIndex === eodIdx && /EOD/i.test(e.label));
    if (!hasEod) {
      const eodFinRes = -180.25;
      events.push({
        barIndex: eodIdx,
        dt: dtAt(eodIdx),
        price: priceAt(eodIdx),
        kind: 'close',
        side: 'long',
        label: 'EOD / конец дня',
        detail: 'Закрытие позиций в конце торгового дня (EOD). Финрез: -180.25',
        ruleKind: 'other',
        finRes: eodFinRes,
      });
    }

    // Sort and dedupe by bar+kind+label
    events.sort((a, b) => a.barIndex - b.barIndex || a.label.localeCompare(b.label));
    const seen = new Set<string>();
    return events.filter((e) => {
      const k = `${e.barIndex}|${e.kind}|${e.side}|${e.label}|${e.signalId ?? ''}|${e.stopId ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}
