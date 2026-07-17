import { Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DbSchemaPanelComponent } from './db-schema/db-schema-panel.component';
import { TechLogService } from './services/tech-log.service';
import { TradeRunnerSessionService } from './services/trade-runner-session.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DbSchemaPanelComponent, FormsModule],
  template: `
    <header class="app-bar">
      <div class="app-bar-left">
        <strong>MultiLogic Trade</strong>
        <span>PostgreSQL + Angular</span>
      </div>
      <div class="app-bar-right">
        <label class="tech-log-toggle" title="Журнал app_tech_log: trade runner, сигналы, параметры">
          <input
            type="checkbox"
            [(ngModel)]="techLoggingEnabled"
            (ngModelChange)="onTechLoggingChange($event)"
          />
          <span>Логирование</span>
        </label>
        <button
          type="button"
          class="gear-btn"
          title="Структура базы данных"
          aria-label="Структура базы данных"
          (click)="openSchema()"
        >
        <svg class="gear-icon" viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
          <path
            fill="#ffffff"
            d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96a7.02 7.02 0 0 0-1.63-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54a7.02 7.02 0 0 0-1.63.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.63.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.6-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
          />
          <circle cx="12" cy="12" r="3.6" fill="#111827" />
        </svg>
      </button>
      </div>
    </header>
    <nav class="app-tabs">
      <a routerLink="/operations" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">
        Торговые операции
      </a>
      <a routerLink="/indicators" routerLinkActive="active">
        Бумаги и индикаторы
      </a>
      <a routerLink="/references" routerLinkActive="active">
        Справочники
      </a>
    </nav>
    <main>
      <router-outlet />
    </main>
    <app-db-schema-panel [open]="schemaOpen" (closed)="schemaOpen = false" />
  `,
  styles: [
    `
      .app-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.75rem 1.5rem;
        background: #111827;
        color: #f9fafb;
      }
      .app-bar-left {
        display: flex;
        align-items: center;
        gap: 1rem;
      }
      .app-bar-right {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .tech-log-toggle {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.88rem;
        color: #e5e7eb;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      .tech-log-toggle input {
        width: 1rem;
        height: 1rem;
        cursor: pointer;
      }
      .app-bar span {
        color: #9ca3af;
        font-size: 0.9rem;
      }
      .gear-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.75rem;
        height: 2.75rem;
        border: none;
        border-radius: 10px;
        background: transparent;
        cursor: pointer;
        padding: 0;
      }
      .gear-btn:hover {
        background: rgba(255, 255, 255, 0.12);
      }
      .gear-btn:hover .gear-icon {
        filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.45));
      }
      .app-tabs {
        display: flex;
        gap: 0;
        padding: 0 1.5rem;
        background: #fff;
        border-bottom: 1px solid #e5e7eb;
      }
      .app-tabs a {
        padding: 0.65rem 1rem;
        color: #6b7280;
        text-decoration: none;
        font-size: 0.92rem;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
      }
      .app-tabs a:hover {
        color: #111827;
      }
      .app-tabs a.active {
        color: #2563eb;
        border-bottom-color: #2563eb;
        font-weight: 600;
      }
      main {
        min-height: calc(100vh - 96px);
        background: #f3f4f6;
      }
    `,
  ],
})
export class AppComponent implements OnInit, OnDestroy {
  schemaOpen = false;
  techLoggingEnabled = false;

  constructor(
    private readonly techLog: TechLogService,
    private readonly tradeRunnerSession: TradeRunnerSessionService
  ) {}

  ngOnInit(): void {
    this.tradeRunnerSession.start();
    this.techLog.loadEnabled().subscribe({
      next: (r) => {
        this.techLoggingEnabled = r.enabled;
      },
    });
  }

  onTechLoggingChange(enabled: boolean): void {
    this.techLog.setEnabled(enabled);
  }

  ngOnDestroy(): void {
    this.tradeRunnerSession.stop();
  }

  openSchema(): void {
    this.schemaOpen = true;
  }
}
