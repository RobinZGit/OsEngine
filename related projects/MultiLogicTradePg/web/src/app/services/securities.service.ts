import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, timeout } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  ChartIndicatorSeries,
  IndicatorValueRow,
  PriceCandle,
  PriceLoadRequest,
  PriceLoadResult,
  SecurityIndicatorSeriesRow,
  SecurityPayload,
  SecurityRow,
  TimeframeRow,
} from '../models/market.model';

@Injectable({ providedIn: 'root' })
export class SecuritiesService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  getTimeframes(): Observable<TimeframeRow[]> {
    return this.http.get<TimeframeRow[]>(`${this.appConfig.apiUrl}/timeframes`);
  }

  getSecurities(
    exchangeId: number,
    kind: 'stock' | 'futures'
  ): Observable<SecurityRow[]> {
    const params = new HttpParams()
      .set('exchange_id', String(exchangeId))
      .set('kind', kind);
    return this.http.get<SecurityRow[]>(`${this.appConfig.apiUrl}/securities`, {
      params,
    });
  }

  createSecurity(payload: SecurityPayload): Observable<SecurityRow> {
    return this.http.post<SecurityRow>(
      `${this.appConfig.apiUrl}/securities`,
      payload
    );
  }

  getPrices(
    securityId: number,
    timeframeId: number,
    limit = 120,
    before?: string
  ): Observable<PriceCandle[]> {
    let params = new HttpParams()
      .set('security_id', String(securityId))
      .set('timeframe_id', String(timeframeId))
      .set('limit', String(limit));
    if (before) {
      params = params.set('before', before);
    }
    return this.http
      .get<PriceCandle[]>(`${this.appConfig.apiUrl}/prices`, { params })
      .pipe(timeout(15_000));
  }

  loadPrices(body: PriceLoadRequest): Observable<PriceLoadResult> {
    return this.http
      .post<PriceLoadResult>(`${this.appConfig.apiUrl}/prices/load`, body)
      .pipe(timeout(190_000));
  }

  getSecurityIndicatorSeries(
    securityId: number
  ): Observable<SecurityIndicatorSeriesRow[]> {
    const params = new HttpParams().set('security_id', String(securityId));
    return this.http
      .get<SecurityIndicatorSeriesRow[]>(
        `${this.appConfig.apiUrl}/security-indicator-series`,
        { params }
      )
      .pipe(timeout(15_000));
  }

  assignIndicatorSeries(
    securityId: number,
    indicatorId: number,
    timeframeId?: number
  ): Observable<SecurityIndicatorSeriesRow[]> {
    const body: Record<string, number> = {
      security_id: securityId,
      indicator_id: indicatorId,
    };
    if (timeframeId) {
      body['timeframe_id'] = timeframeId;
    }
    return this.http
      .post<SecurityIndicatorSeriesRow[]>(
        `${this.appConfig.apiUrl}/security-indicator-series`,
        body
      )
      .pipe(timeout(15_000));
  }

  removeIndicatorSeries(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(
      `${this.appConfig.apiUrl}/security-indicator-series/${id}`
    );
  }

  syncIndicatorSeries(body: {
    security_id: number;
    timeframe_id: number;
    indicator_id?: number;
    end_dt?: string;
    point_count?: number;
    incremental?: boolean;
    /** Всегда true в UI — расчёт только в фоне на сервере. */
    async?: boolean;
  }): Observable<{ ok: boolean; status?: string }> {
    const payload = { ...body, async: true };
    return this.http
      .post<{ ok: boolean; status?: string }>(
        `${this.appConfig.apiUrl}/security-indicator-series/sync`,
        payload
      )
      .pipe(timeout(10_000));
  }

  getIndicatorValues(
    securityId: number,
    timeframeId: number,
    indicatorIds: number[],
    after?: string,
    before?: string,
    limit = 1500
  ): Observable<IndicatorValueRow[]> {
    let params = new HttpParams()
      .set('security_id', String(securityId))
      .set('timeframe_id', String(timeframeId))
      .set('indicator_ids', indicatorIds.join(','))
      .set('limit', String(Math.min(Math.max(1, limit), 4000)));
    if (after) params = params.set('after', after);
    if (before) params = params.set('before', before);
    return this.http.get<IndicatorValueRow[]>(
      `${this.appConfig.apiUrl}/indicator-values`,
      { params }
    ).pipe(timeout(15_000));
  }
}
