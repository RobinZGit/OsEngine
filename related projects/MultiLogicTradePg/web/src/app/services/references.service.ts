import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  AccountBondsInfo,
  AccountConnectionPreview,
  AccountPayload,
  AccountRow,
  BondFundInfo,
  BrokerPayload,
  BrokerRow,
  BuyBondsResult,
  ExchangePayload,
  ExchangeRow,
  IndicatorCreatePayload,
  IndicatorPayload,
  IndicatorRow,
} from '../models/lookup.model';

@Injectable({ providedIn: 'root' })
export class ReferencesService {
  constructor(
    private readonly http: HttpClient,
    private readonly appConfig: AppConfigService
  ) {}

  getBrokers(): Observable<BrokerRow[]> {
    return this.http.get<BrokerRow[]>(`${this.appConfig.apiUrl}/brokers`);
  }

  createBroker(payload: BrokerPayload): Observable<BrokerRow> {
    return this.http.post<BrokerRow>(`${this.appConfig.apiUrl}/brokers`, payload);
  }

  updateBroker(id: number, payload: BrokerPayload): Observable<BrokerRow> {
    return this.http.put<BrokerRow>(
      `${this.appConfig.apiUrl}/brokers/${id}`,
      payload
    );
  }

  deleteBroker(id: number): Observable<{ ok: boolean; id: number }> {
    return this.http.delete<{ ok: boolean; id: number }>(
      `${this.appConfig.apiUrl}/brokers/${id}`
    );
  }

  getExchanges(): Observable<ExchangeRow[]> {
    return this.http.get<ExchangeRow[]>(`${this.appConfig.apiUrl}/exchanges`);
  }

  createExchange(payload: ExchangePayload): Observable<ExchangeRow> {
    return this.http.post<ExchangeRow>(
      `${this.appConfig.apiUrl}/exchanges`,
      payload
    );
  }

  updateExchange(id: number, payload: ExchangePayload): Observable<ExchangeRow> {
    return this.http.put<ExchangeRow>(
      `${this.appConfig.apiUrl}/exchanges/${id}`,
      payload
    );
  }

  deleteExchange(id: number): Observable<{ ok: boolean; id: number }> {
    return this.http.delete<{ ok: boolean; id: number }>(
      `${this.appConfig.apiUrl}/exchanges/${id}`
    );
  }

  getAccounts(brokerId?: number, withBalance = false): Observable<AccountRow[]> {
    let params = new HttpParams();
    if (brokerId != null) {
      params = params.set('broker_id', String(brokerId));
    }
    if (withBalance) {
      params = params.set('with_balance', '1');
    }
    return this.http.get<AccountRow[]>(`${this.appConfig.apiUrl}/accounts`, {
      params,
    });
  }

  createAccount(payload: AccountPayload): Observable<AccountRow> {
    return this.http.post<AccountRow>(
      `${this.appConfig.apiUrl}/accounts`,
      payload
    );
  }

  updateAccount(id: number, payload: AccountPayload): Observable<AccountRow> {
    return this.http.put<AccountRow>(
      `${this.appConfig.apiUrl}/accounts/${id}`,
      payload
    );
  }

  deleteAccount(id: number): Observable<{ ok: boolean; id: number }> {
    return this.http.delete<{ ok: boolean; id: number }>(
      `${this.appConfig.apiUrl}/accounts/${id}`
    );
  }

  previewAccountConnection(body: {
    broker_id: number;
    account_code?: string;
    api_token?: string;
    account_id?: number;
  }): Observable<AccountConnectionPreview> {
    return this.http.post<AccountConnectionPreview>(
      `${this.appConfig.apiUrl}/accounts/preview-connection`,
      body
    );
  }

  /** Только real T-Bank: продать все невалютные позиции портфеля. */
  sellAllOnAccount(accountId: number): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(
      `${this.appConfig.apiUrl}/accounts/${accountId}/sell-all`,
      {}
    );
  }

  getBondFunds(): Observable<BondFundInfo[]> {
    return this.http.get<BondFundInfo[]>(
      `${this.appConfig.apiUrl}/accounts/bond-funds`
    );
  }

  /** Реальные счета T-Bank, у которых в портфеле есть облигации. */
  getAccountsWithBonds(): Observable<AccountBondsInfo[]> {
    return this.http.get<AccountBondsInfo[]>(
      `${this.appConfig.apiUrl}/accounts/with-bonds`
    );
  }

  planBuyBonds(
    accountId: number,
    body: {
      fund_code?: string;
      amount_rub?: number;
      target_account_id?: number;
    }
  ): Observable<BuyBondsResult> {
    return this.http.post<BuyBondsResult>(
      `${this.appConfig.apiUrl}/accounts/${accountId}/buy-bonds`,
      { ...body, execute: false }
    );
  }

  executeBuyBonds(
    accountId: number,
    body: {
      fund_code?: string;
      amount_rub?: number;
      target_account_id?: number;
    }
  ): Observable<BuyBondsResult> {
    return this.http.post<BuyBondsResult>(
      `${this.appConfig.apiUrl}/accounts/${accountId}/buy-bonds`,
      { ...body, execute: true }
    );
  }

  getIndicators(withCalc = false): Observable<IndicatorRow[]> {
    let params = new HttpParams();
    if (withCalc) {
      params = params.set('with_calc', '1');
    }
    return this.http.get<IndicatorRow[]>(`${this.appConfig.apiUrl}/indicators`, {
      params,
    });
  }

  updateIndicator(id: number, payload: IndicatorPayload): Observable<IndicatorRow> {
    return this.http.put<IndicatorRow>(
      `${this.appConfig.apiUrl}/indicators/${id}`,
      payload
    );
  }

  createIndicator(payload: IndicatorCreatePayload): Observable<IndicatorRow> {
    return this.http.post<IndicatorRow>(
      `${this.appConfig.apiUrl}/indicators`,
      payload
    );
  }
}
