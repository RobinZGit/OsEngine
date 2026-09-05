import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { assetUrl } from '../shared/asset-url';

export interface VersionInfo {
  product?: string;
  title?: string;
  version?: string;
  build?: number;
  built?: string;
  git?: string;
}

const FALLBACK: VersionInfo = {
  product: 'MultiLogicTradePg',
  title: 'MultiLogic Trade',
  version: '—',
  build: undefined,
  built: '—',
  git: undefined,
};

@Component({
  selector: 'app-about-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app-about-panel.component.html',
  styleUrl: './app-about-panel.component.css',
})
export class AppAboutPanelComponent implements OnChanges {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();

  info: VersionInfo = { ...FALLBACK };
  raw: string | null = null;
  loading = false;
  error: string | null = null;

  constructor(private readonly http: HttpClient) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open'] && this.open) {
      this.load();
    }
  }

  close(): void {
    this.closed.emit();
  }

  private load(): void {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    this.http.get(assetUrl('assets/version.json'), { responseType: 'json' }).subscribe({
      next: (v) => {
        this.info = { ...FALLBACK, ...(v as VersionInfo) };
        this.raw = JSON.stringify(v);
        this.loading = false;
      },
      error: () => {
        this.info = { ...FALLBACK };
        this.raw = null;
        this.error =
          'Файл версии assets/version.json не найден. Пересоберите установщик или загрузите его в assets/.';
        this.loading = false;
      },
    });
  }
}