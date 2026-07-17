import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { AccountRow, BrokerRow } from '../models/lookup.model';

/** Справочники для выпадающих списков (редактор логик и др.). */
@Injectable({ providedIn: 'root' })
export class LookupService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  getBrokers(): Observable<BrokerRow[]> {
    return this.http.get<BrokerRow[]>(`${this.appConfig.apiUrl}/brokers`);
  }

  getAccounts(brokerId?: number): Observable<AccountRow[]> {
    let params = new HttpParams();
    if (brokerId != null) {
      params = params.set('broker_id', String(brokerId));
    }
    return this.http.get<AccountRow[]>(`${this.appConfig.apiUrl}/accounts`, {
      params,
    });
  }
}
