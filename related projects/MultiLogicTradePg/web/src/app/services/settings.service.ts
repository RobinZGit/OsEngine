import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';

export interface TbankTokenStatus {
  has_token: boolean;
  valid?: boolean;
  error_message?: string | null;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  getTbankTokenStatus(validate = false): Observable<TbankTokenStatus> {
    const params: Record<string, string> = {};
    if (validate) {
      params['validate'] = '1';
    }
    return this.http.get<TbankTokenStatus>(
      `${this.appConfig.apiUrl}/settings/tbank-token`,
      { params }
    );
  }

  saveTbankToken(token: string): Observable<TbankTokenStatus & { ok: boolean }> {
    return this.http.put<TbankTokenStatus & { ok: boolean }>(
      `${this.appConfig.apiUrl}/settings/tbank-token`,
      { token }
    );
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
