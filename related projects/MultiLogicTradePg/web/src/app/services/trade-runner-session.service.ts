import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from './app-config.service';

const HEARTBEAT_MS = 30000;

@Injectable({ providedIn: 'root' })
export class TradeRunnerSessionService implements OnDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.ping();
    this.timer = setInterval(() => this.ping(), HEARTBEAT_MS);
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.onBeforeUnload);
      window.addEventListener('pagehide', this.onBeforeUnload);
    }
  }

  ngOnDestroy(): void {
    this.stop();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.onBeforeUnload);
      window.removeEventListener('pagehide', this.onBeforeUnload);
    }
    this.endSession();
  }

  private readonly onBeforeUnload = (): void => {
    const url = `${this.appConfig.apiUrl}/logic-trades/heartbeat/end`;
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(url, '');
    }
  };

  private ping(): void {
    this.http
      .post<{ ok: boolean; active: boolean }>(
        `${this.appConfig.apiUrl}/logic-trades/heartbeat`,
        {}
      )
      .subscribe({ error: () => {} });
  }

  private endSession(): void {
    this.http
      .post(`${this.appConfig.apiUrl}/logic-trades/heartbeat/end`, {})
      .subscribe({ error: () => {} });
  }
}
