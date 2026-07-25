import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  APP_HELP_SECTIONS,
  HelpSection,
  PROJECT_CONTEXT_DOCS,
  splitMarkdownChapters,
} from './app-help-content';
import { assetUrl } from '../shared/asset-url';

@Component({
  selector: 'app-help-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app-help-panel.component.html',
  styleUrl: './app-help-panel.component.css',
})
export class AppHelpPanelComponent implements OnChanges {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();

  readonly sections: HelpSection[] = APP_HELP_SECTIONS;
  activeId = this.sections[0]?.id ?? '';

  /** Главы выбранного markdown-контекста (по ##). */
  contextChapters: { id: string; title: string; body: string }[] = [];
  activeChapterId = '';
  contextLoading = false;
  contextError: string | null = null;

  private readonly chapterCache = new Map<string, { id: string; title: string; body: string }[]>();

  constructor(private readonly http: HttpClient) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open'] && this.open) {
      this.ensureContextLoaded();
    }
  }

  select(id: string): void {
    this.activeId = id;
    this.ensureContextLoaded();
  }

  selectChapter(id: string): void {
    this.activeChapterId = id;
  }

  get active(): HelpSection | undefined {
    return this.sections.find((s) => s.id === this.activeId) ?? this.sections[0];
  }

  get isContextSection(): boolean {
    return this.active?.kind === 'project-context';
  }

  get activeChapter(): { id: string; title: string; body: string } | undefined {
    return (
      this.contextChapters.find((c) => c.id === this.activeChapterId) ??
      this.contextChapters[0]
    );
  }

  close(): void {
    this.closed.emit();
  }

  private ensureContextLoaded(): void {
    const sec = this.active;
    if (!sec || sec.kind !== 'project-context') {
      return;
    }
    const doc = PROJECT_CONTEXT_DOCS.find((d) => d.id === sec.id);
    if (!doc) {
      this.contextError = 'Неизвестный файл контекста.';
      this.contextChapters = [];
      return;
    }

    const cached = this.chapterCache.get(doc.asset);
    if (cached) {
      this.contextChapters = cached;
      this.activeChapterId = cached[0]?.id ?? '';
      this.contextError = null;
      this.contextLoading = false;
      return;
    }

    this.contextLoading = true;
    this.contextError = null;
    this.http.get(assetUrl(doc.asset), { responseType: 'text' }).subscribe({
      next: (md) => {
        const chapters = splitMarkdownChapters(md);
        this.chapterCache.set(doc.asset, chapters);
        this.contextChapters = chapters;
        this.activeChapterId = chapters[0]?.id ?? '';
        this.contextLoading = false;
      },
      error: () => {
        this.contextLoading = false;
        this.contextError =
          'Не удалось загрузить файл контекста. Выполните npm run sync:context в web/ и перезапустите UI.';
        this.contextChapters = [];
      },
    });
  }
}
