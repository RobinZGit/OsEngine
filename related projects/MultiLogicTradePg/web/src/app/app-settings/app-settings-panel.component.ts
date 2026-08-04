import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { SettingsService } from '../services/settings.service';

@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app-settings-panel.component.html',
  styleUrl: './app-settings-panel.component.css',
})
export class AppSettingsPanelComponent implements OnChanges {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();

  cleanupEnabled = false;
  orderChannel: 'postgres' | 'node' = 'node';
  orderNodeUrl: string | null = null;
  uiActive: boolean | null = null;
  loading = false;
  saving = false;
  savingChannel = false;
  cleaning = false;
  error: string | null = null;
  lastResult: Record<string, number> | null = null;

  constructor(private readonly settings: SettingsService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true) {
      this.load();
    }
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.lastResult = null;
    forkJoin({
      cleanup: this.settings.getCleanupSetting(),
      channel: this.settings.getOrderChannel(),
    }).subscribe({
      next: ({ cleanup, channel }) => {
        this.cleanupEnabled = !!cleanup.enabled;
        this.orderChannel = channel.channel === 'node' ? 'node' : 'postgres';
        this.orderNodeUrl = channel.node_url ?? null;
        this.uiActive = typeof channel.ui_active === 'boolean' ? channel.ui_active : null;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.error || err?.message || 'Не удалось загрузить настройки';
        this.loading = false;
      },
    });
  }

  onOrderChannelChange(channel: 'postgres' | 'node'): void {
    if (channel !== 'postgres' && channel !== 'node') return;
    if (channel === this.orderChannel) return;
    this.orderChannel = channel;
    this.savingChannel = true;
    this.error = null;
    this.settings.saveOrderChannel(channel).subscribe({
      next: (r) => {
        this.orderChannel = r.channel === 'node' ? 'node' : 'postgres';
        this.orderNodeUrl = r.node_url ?? this.orderNodeUrl;
        this.uiActive = typeof r.ui_active === 'boolean' ? r.ui_active : this.uiActive;
        this.savingChannel = false;
      },
      error: (err) => {
        this.error = err?.error?.error || err?.message || 'Не удалось сохранить канал заявок';
        this.savingChannel = false;
        this.load();
      },
    });
  }

  onCleanupToggle(enabled: boolean): void {
    this.cleanupEnabled = enabled;
    this.saving = true;
    this.error = null;
    this.settings.saveCleanupSetting(enabled).subscribe({
      next: (r) => {
        this.cleanupEnabled = !!r.enabled;
        this.saving = false;
      },
      error: (err) => {
        this.error = err?.error?.error || err?.message || 'Не удалось сохранить настройку';
        this.saving = false;
        this.load();
      },
    });
  }

  runCleanupNow(): void {
    this.cleaning = true;
    this.error = null;
    this.lastResult = null;
    this.settings.runMaintenanceCleanup().subscribe({
      next: (r) => {
        this.lastResult = (r.result as Record<string, number>) ?? {};
        this.cleaning = false;
      },
      error: (err) => {
        this.error = err?.error?.error || err?.message || 'Ошибка очистки';
        this.cleaning = false;
      },
    });
  }

  close(): void {
    this.closed.emit();
  }
}
