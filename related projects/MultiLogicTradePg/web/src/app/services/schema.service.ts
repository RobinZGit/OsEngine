import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, map, of, throwError } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { DatabaseSchema, RoutineSource } from '../models/schema.model';
import { assetUrl } from '../shared/asset-url';

@Injectable({ providedIn: 'root' })
export class SchemaService {
  private offlineSchema: DatabaseSchema | null = null;
  private lastMode: 'live' | 'offline' = 'live';

  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  getSchema(): Observable<DatabaseSchema> {
    return this.http.get<DatabaseSchema>(`${this.appConfig.apiUrl}/schema`).pipe(
      map((data) => {
        this.lastMode = 'live';
        return { ...data, sourceMode: 'live' as const };
      }),
      catchError(() => this.loadOfflineSchema())
    );
  }

  getRoutineSource(oid: number): Observable<RoutineSource> {
    if (this.lastMode === 'offline' && this.offlineSchema) {
      const r = this.offlineSchema.routines.find((x) => x.oid === oid);
      if (r?.source) {
        return of({
          name: r.name,
          kind: r.kind === 'procedure' ? 'p' : 'f',
          arguments: r.arguments,
          source: r.source,
        });
      }
    }
    return this.http.get<RoutineSource>(
      `${this.appConfig.apiUrl}/schema/routine/${oid}/source`
    );
  }

  get lastSourceMode(): 'live' | 'offline' {
    return this.lastMode;
  }

  private loadOfflineSchema(): Observable<DatabaseSchema> {
    if (this.offlineSchema) {
      this.lastMode = 'offline';
      return of(this.offlineSchema);
    }
    return this.http.get<DatabaseSchema>(assetUrl('assets/schema-offline.json')).pipe(
      map((data) => {
        this.offlineSchema = data;
        this.lastMode = 'offline';
        return data;
      }),
      catchError(() =>
        throwError(() => new Error('Offline schema asset not found'))
      )
    );
  }
}
