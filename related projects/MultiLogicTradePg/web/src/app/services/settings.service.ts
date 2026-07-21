import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AppConfigService } from './app-config.service';

export interface TbankTokenStatus {
  has_token: boolean;
  valid?: boolean;
  error_message?: string | null;
}

/** Сессионный кэш: один глобальный TBANK_API_TOKEN на все логики (в т.ч. копии). */
const TOKEN_CACHE_TTL_MS = 10 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private cachedStatus: TbankTokenStatus | null = null;
  private cachedAt = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  /**
   * Статус токена T-Bank (глобальный parameter_values, не per-logic).
   * @param validate HTTP-проверка у брокера; для теста достаточно has_token без validate.
   * @param forceIgnoreCache не брать сессионный кэш
   */
  getTbankTokenStatus(
    validate = false,
    forceIgnoreCache = false
  ): Observable<TbankTokenStatus> {
    if (
      !forceIgnoreCache &&
      !validate &&
      this.cachedStatus?.has_token &&
      Date.now() - this.cachedAt < TOKEN_CACHE_TTL_MS
    ) {
      return of({ ...this.cachedStatus });
    }
    const params: Record<string, string> = {};
    if (validate) {
      params['validate'] = '1';
    }
    return this.http
      .get<TbankTokenStatus>(`${this.appConfig.apiUrl}/settings/tbank-token`, {
        params,
      })
      .pipe(
        tap((status) => {
          if (status?.has_token) {
            this.cachedStatus = { ...status };
            this.cachedAt = Date.now();
          } else {
            this.clearTbankTokenCache();
          }
        })
      );
  }

  /** Есть ли сохранённый глобальный токен (без HTTP к брокеру) — для Start теста / всех логик. */
  getTbankTokenConfigured(forceIgnoreCache = false): Observable<TbankTokenStatus> {
    return this.getTbankTokenStatus(false, forceIgnoreCache);
  }

  saveTbankToken(token: string): Observable<TbankTokenStatus & { ok: boolean }> {
    return this.http
      .put<TbankTokenStatus & { ok: boolean }>(
        `${this.appConfig.apiUrl}/settings/tbank-token`,
        { token }
      )
      .pipe(
        tap((status) => {
          if (status?.ok || status?.has_token) {
            this.cachedStatus = {
              has_token: true,
              valid: status.valid !== false,
              error_message: status.error_message ?? null,
            };
            this.cachedAt = Date.now();
          }
        })
      );
  }

  clearTbankTokenCache(): void {
    this.cachedStatus = null;
    this.cachedAt = 0;
  }

  getTechLogging(): Observable<{ enabled: boolean }> {
    return this.http.get<{ enabled: boolean }>(
      `${this.appConfig.apiUrl}/settings/tech-logging`
    );
  }

  saveTechLogging(enabled: boolean): Observable<{ ok: boolean; enabled: boolean }> {
    return this.http.put<{ ok: boolean; enabled: boolean }>(
      `${this.appConfig.apiUrl}/settings/tech-logging`,
      { enabled }
    );
  }

  getCleanupSetting(): Observable<{ enabled: boolean }> {
    return this.http.get<{ enabled: boolean }>(
      `${this.appConfig.apiUrl}/settings/cleanup`
    );
  }

  saveCleanupSetting(enabled: boolean): Observable<{ ok: boolean; enabled: boolean }> {
    return this.http.put<{ ok: boolean; enabled: boolean }>(
      `${this.appConfig.apiUrl}/settings/cleanup`,
      { enabled }
    );
  }

  runMaintenanceCleanup(): Observable<{
    ok: boolean;
    result: Record<string, number>;
  }> {
    return this.http.post<{ ok: boolean; result: Record<string, number> }>(
      `${this.appConfig.apiUrl}/maintenance/cleanup`,
      {}
    );
  }
}
