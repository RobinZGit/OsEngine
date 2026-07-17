import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SchemaService } from '../services/schema.service';
import { DatabaseSchema, SchemaRoutine } from '../models/schema.model';
import { SchemaDiagramLayout, buildSchemaDiagram, edgePath } from './schema-fk';

@Component({
  selector: 'app-db-schema-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './db-schema-panel.component.html',
  styleUrl: './db-schema-panel.component.css',
})
export class DbSchemaPanelComponent implements OnChanges {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();

  loading = false;
  error: string | null = null;
  schema: DatabaseSchema | null = null;
  schemaMode: 'live' | 'offline' = 'live';
  expanded = new Set<string>();
  panelWide = false;
  activeTab: 'tree' | 'diagram' = 'tree';
  diagram: SchemaDiagramLayout | null = null;
  hoverTable: string | null = null;

  readonly edgePath = edgePath;

  private readonly rootSections = [
    'root:tables',
    'root:functions',
    'root:procedures',
    'root:ext',
  ];

  constructor(private readonly schemaService: SchemaService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true) {
      this.loadSchema();
    }
  }

  loadSchema(): void {
    this.loading = true;
    this.error = null;
    this.schemaService.getSchema().subscribe({
      next: (data) => {
        this.schema = data;
        this.schemaMode = data.sourceMode ?? this.schemaService.lastSourceMode;
        this.diagram = buildSchemaDiagram(data);
        this.loading = false;
        this.expanded.clear();
        this.panelWide = this.activeTab === 'diagram';
      },
      error: () => {
        this.error =
          'Не удалось загрузить структуру БД ни из PostgreSQL, ни из SQL-скриптов репозитория.';
        this.loading = false;
        this.diagram = null;
      },
    });
  }

  setTab(tab: 'tree' | 'diagram'): void {
    this.activeTab = tab;
    this.panelWide = tab === 'diagram' || this.shouldWidenTree();
  }

  openTableFromDiagram(tableName: string): void {
    this.activeTab = 'tree';
    this.expanded.clear();
    this.expanded.add('root:tables');
    this.expanded.add(`table:${tableName}`);
    this.expanded.add(`table:${tableName}:cols`);
    this.panelWide = true;
    setTimeout(() => {
      const el = document.querySelector(`[data-table="${tableName}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 0);
  }

  close(): void {
    this.closed.emit();
  }

  isExpanded(key: string): boolean {
    return this.expanded.has(key);
  }

  toggleRoot(key: string, event: Event): void {
    event.stopPropagation();
    const opening = !this.expanded.has(key);
    for (const root of this.rootSections) {
      this.expanded.delete(root);
    }
    this.collapseAllTables();
    if (opening) {
      this.expanded.add(key);
    }
    this.syncPanelWide();
  }

  toggleTable(tableName: string, event: Event): void {
    event.stopPropagation();
    const key = `table:${tableName}`;
    const opening = !this.expanded.has(key);
    for (const t of this.schema?.tables ?? []) {
      if (t.name !== tableName) {
        this.collapseTableBranch(t.name);
      }
    }
    if (opening) {
      this.expanded.add(key);
      for (const root of this.rootSections) {
        if (root !== 'root:tables') {
          this.expanded.delete(root);
        }
      }
      this.expanded.add('root:tables');
    } else {
      this.collapseTableBranch(tableName);
    }
    this.syncPanelWide();
  }

  toggleTablePart(tableName: string, part: 'cols' | 'idx' | 'con', event: Event): void {
    event.stopPropagation();
    const key = `table:${tableName}:${part}`;
    const opening = !this.expanded.has(key);
    for (const p of ['cols', 'idx', 'con'] as const) {
      this.expanded.delete(`table:${tableName}:${p}`);
    }
    if (opening) {
      this.expanded.add(key);
      this.expanded.add(`table:${tableName}`);
      this.expanded.add('root:tables');
      for (const root of this.rootSections) {
        if (root !== 'root:tables') {
          this.expanded.delete(root);
        }
      }
    }
    this.syncPanelWide();
  }

  get functions(): SchemaRoutine[] {
    return this.schema?.routines.filter((r) => r.kind === 'function') ?? [];
  }

  get procedures(): SchemaRoutine[] {
    return this.schema?.routines.filter((r) => r.kind === 'procedure') ?? [];
  }

  routineLabel(r: SchemaRoutine): string {
    if (r.kind === 'procedure') {
      return `${r.name}(${r.arguments})`;
    }
    const ret = r.result_type ? ` → ${r.result_type}` : '';
    return `${r.name}(${r.arguments})${ret}`;
  }

  showSource(r: SchemaRoutine, event: Event): void {
    event.stopPropagation();
    this.schemaService.getRoutineSource(r.oid).subscribe({
      next: (data) => {
        const title = `${data.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} ${data.name}(${data.arguments})`;
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${this.escapeHtml(title)}</title>
<style>
body{font-family:Consolas,Monaco,monospace;margin:0;background:#1e1e1e;color:#d4d4d4}
header{padding:12px 16px;background:#111827;color:#f9fafb;font-family:system-ui,sans-serif}
pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.45}
</style></head><body>
<header>${this.escapeHtml(title)}</header>
<pre>${this.escapeHtml(data.source)}</pre>
</body></html>`;
        const w = window.open('', '_blank', 'width=960,height=720');
        if (w) {
          w.document.write(html);
          w.document.close();
        }
      },
      error: (err) => {
        alert(err?.error?.error || err?.message || 'Не удалось загрузить текст');
      },
    });
  }

  private shouldWidenTree(): boolean {
    return [...this.expanded].some(
      (k) =>
        k.startsWith('table:') ||
        k === 'root:functions' ||
        k === 'root:procedures'
    );
  }

  private collapseAllTables(): void {
    for (const t of this.schema?.tables ?? []) {
      this.collapseTableBranch(t.name);
    }
  }

  private collapseTableBranch(name: string): void {
    const prefix = `table:${name}`;
    for (const k of [...this.expanded]) {
      if (k === prefix || k.startsWith(`${prefix}:`)) {
        this.expanded.delete(k);
      }
    }
  }

  private syncPanelWide(): void {
    this.panelWide = this.activeTab === 'diagram' || this.shouldWidenTree();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
