import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReferencesService } from '../services/references.service';
import { IndicatorRow } from '../models/lookup.model';
import {
  AppConfigService,
  logicsLoadErrorMessage,
} from '../services/app-config.service';
import { IndicatorEditorComponent } from '../indicator-editor/indicator-editor.component';

@Component({
  selector: 'app-indicators-panel',
  standalone: true,
  imports: [CommonModule, IndicatorEditorComponent],
  templateUrl: './indicators-panel.component.html',
  styleUrl: './indicators-panel.component.css',
})
export class IndicatorsPanelComponent implements OnInit {
  indicators: IndicatorRow[] = [];
  loading = true;
  error: string | null = null;

  editorOpen = false;
  editTarget: IndicatorRow | null = null;
  createMode = false;

  constructor(
    private readonly refs: ReferencesService,
    private readonly appConfig: AppConfigService
  ) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.refs.getIndicators(true).subscribe({
      next: (rows) => {
        this.indicators = rows;
        this.loading = false;
        this.error = null;
      },
      error: (err) => {
        this.loading = false;
        this.error = logicsLoadErrorMessage(this.appConfig.apiUrl, err);
      },
    });
  }

  openEdit(row: IndicatorRow): void {
    this.createMode = false;
    this.editTarget = row;
    this.editorOpen = true;
  }

  openCreate(): void {
    this.createMode = true;
    this.editTarget = null;
    this.editorOpen = true;
  }

  onEditorClosed(): void {
    this.editorOpen = false;
    this.createMode = false;
    this.editTarget = null;
  }

  descriptionPreview(description: string | null): string {
    if (!description) return '—';
    const oneLine = description.replace(/\s+/g, ' ').trim();
    return oneLine.length > 100 ? oneLine.slice(0, 97) + '…' : oneLine;
  }

  onDragStart(event: DragEvent, row: IndicatorRow): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData('application/x-indicator-id', String(row.id));
    event.dataTransfer.setData('text/plain', row.code);
    event.dataTransfer.effectAllowed = 'copy';
    (event.target as HTMLElement)?.closest('tr')?.classList.add('dragging');
  }

  onDragEnd(): void {
    document.querySelectorAll('.indicator-draggable.dragging').forEach((el) => {
      el.classList.remove('dragging');
    });
  }
}
