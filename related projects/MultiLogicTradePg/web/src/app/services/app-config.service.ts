import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface AppConfig {
  apiUrl: string;
}

const DEFAULT_CONFIG: AppConfig = {
  apiUrl: 'http://127.0.0.1:3000/api',
};

@Injectable({ providedIn: 'root' })
export class AppConfigService {
  private config: AppConfig = { ...DEFAULT_CONFIG };

  constructor(private readonly http: HttpClient) {}

  async load(): Promise<void> {
    try {
      const loaded = await firstValueFrom(
        this.http.get<AppConfig>('assets/app-config.json')
      );
      this.config = { ...DEFAULT_CONFIG, ...loaded };
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  get apiUrl(): string {
    return this.config.apiUrl.replace(/\/$/, '');
  }
}

export function apiConnectionErrorMessage(apiUrl: string): string {
  return (
    `Не удалось подключиться к API базы данных (${apiUrl}). ` +
    'На локальном ПК запустите PostgreSQL и web\\MultiLogic_Trade_Progress_Start.bat. ' +
    'На GitHub Pages API недоступен — откройте приложение локально или укажите URL сервера в assets/app-config.json.'
  );
}

export function logicsLoadErrorMessage(apiUrl: string, err: unknown): string {
  return apiErrorMessage(apiUrl, err, apiConnectionErrorMessage(apiUrl));
}

/** Текст ошибки из ответа API для форм редактирования. */
export function apiErrorMessage(
  apiUrl: string,
  err: unknown,
  fallback = 'Не удалось выполнить запрос'
): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return apiConnectionErrorMessage(apiUrl);
    }
    if (typeof err.error === 'object' && err.error && 'error' in err.error) {
      return String((err.error as { error: string }).error);
    }
    if (typeof err.error === 'string' && err.error.trim()) {
      const short = err.error.trim().slice(0, 240);
      if (err.status === 404) {
        return `${short}. Перезапустите web\\MultiLogic_Trade_Progress_Start.bat (устаревший API).`;
      }
      return short;
    }
    if (err.status === 404) {
      return `API не содержит этот маршрут (${err.url}). Перезапустите MultiLogic_Trade_Progress_Start.bat.`;
    }
    return `${fallback} (HTTP ${err.status})`;
  }
  return fallback;
}
