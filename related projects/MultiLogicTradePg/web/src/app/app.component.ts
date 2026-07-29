import { Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DbSchemaPanelComponent } from './db-schema/db-schema-panel.component';
import { AppHelpPanelComponent } from './app-help/app-help-panel.component';
import { AppSettingsPanelComponent } from './app-settings/app-settings-panel.component';
import { TechLogService } from './services/tech-log.service';
import { TradeRunnerSessionService } from './services/trade-runner-session.service';
import { assetUrl } from './shared/asset-url';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    DbSchemaPanelComponent,
    AppHelpPanelComponent,
    AppSettingsPanelComponent,
    FormsModule,
  ],
  template: `
    <header class="app-bar">
      <div class="app-bar-left">
        <strong>MultiLogic Trade</strong>
        <span>PostgreSQL + Angular</span>
      </div>
      <div class="app-bar-right">
        <a
          class="crypt-link"
          [href]="cryptToolUrl"
          target="_blank"
          rel="noopener noreferrer"
          title="Crypt — parity stego (text/picture)"
        >Crypt</a>
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
          class="bar-icon-btn"
          title="Справка"
          aria-label="Справка"
          (click)="openHelp()"
        >
          <!-- Book icon -->
          <svg class="bar-icon" viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
            <path
              fill="#ffffff"
              d="M18 2H8c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 18H8V4h2v8l2.5-1.5L15 12V4h3v16z"
            />
            <path fill="#111827" d="M10 4h5v8l-2.5-1.5L10 12V4z" />
          </svg>
        </button>
        <button
          type="button"
          class="bar-icon-btn"
          title="Структура базы данных"
          aria-label="Структура базы данных"
          (click)="openSchema()"
        >
          <!-- Database / cylinders icon -->
          <svg class="bar-icon" viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="8" ry="3" fill="#ffffff" />
            <path
              fill="#ffffff"
              d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5c0 1.66-3.58 3-8 3S4 6.66 4 5z"
            />
            <path
              fill="#ffffff"
              d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6c0 1.66-3.58 3-8 3s-8-1.34-8-3z"
            />
          </svg>
        </button>
        <button
          type="button"
          class="bar-icon-btn"
          title="Общие настройки"
          aria-label="Общие настройки"
          (click)="openSettings()"
        >
          <!-- Gear icon -->
          <svg class="bar-icon" viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
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
    <app-help-panel [open]="helpOpen" (closed)="helpOpen = false" />
    <app-db-schema-panel [open]="schemaOpen" (closed)="schemaOpen = false" />
    <app-settings-panel [open]="settingsOpen" (closed)="settingsOpen = false" />
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
        gap: 0.35rem;
      }
      .crypt-link {
        display: inline-flex;
        align-items: center;
        margin-right: 0.55rem;
        padding: 0.35rem 0.7rem;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.28);
        color: #f9fafb;
        text-decoration: none;
        font-size: 0.88rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        white-space: nowrap;
      }
      .crypt-link:hover {
        background: rgba(255, 255, 255, 0.12);
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
        margin-right: 0.4rem;
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
      .bar-icon-btn {
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
      .bar-icon-btn:hover {
        background: rgba(255, 255, 255, 0.12);
      }
      .bar-icon-btn:hover .bar-icon {
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
  helpOpen = false;
  settingsOpen = false;
  techLoggingEnabled = false;
  /** Standalone Crypt tool (GitHub Pages + local assets). */
  readonly cryptToolUrl = assetUrl('assets/tools/parity-stego.html');

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

  openHelp(): void {
    this.helpOpen = true;
  }

  openSchema(): void {
    this.schemaOpen = true;
  }

  openSettings(): void {
    this.settingsOpen = true;
  }
}
