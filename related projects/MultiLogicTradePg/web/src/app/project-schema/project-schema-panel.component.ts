import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SchemaService } from '../services/schema.service';
import { SchemaRoutine } from '../models/schema.model';

@Component({
  selector: 'app-project-schema-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './project-schema-panel.component.html',
  styleUrl: './project-schema-panel.component.css',
})
export class ProjectSchemaPanelComponent implements OnChanges {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();

  routines: SchemaRoutine[] | null = null;
  routinesError: string | null = null;
  expandedRoutineOid: number | null = null;
  routineSources = new Map<number, string>();
  routineLoading = false;
  routineError: string | null = null;

  constructor(private readonly schemaService: SchemaService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']?.currentValue === true) {
      if (this.routines === null || this.routinesError) {
        this.loadRoutines();
      }
    }
  }

  loadRoutines(): void {
    this.routinesError = null;
    this.schemaService.getSchema().subscribe({
      next: (data) => {
        this.routines = data.routines;
      },
      error: () => {
        this.routinesError = 'Не удалось загрузить список процедур и функций.';
      },
    });
  }

  get procedures(): SchemaRoutine[] {
    return this.routines?.filter((r) => r.kind === 'procedure') ?? [];
  }

  get functions(): SchemaRoutine[] {
    return this.routines?.filter((r) => r.kind === 'function') ?? [];
  }

  routineLabel(r: SchemaRoutine): string {
    if (r.kind === 'procedure') {
      return `${r.name}(${r.arguments})`;
    }
    const ret = r.result_type ? ` → ${r.result_type}` : '';
    return `${r.name}(${r.arguments})${ret}`;
  }

  toggleSource(r: SchemaRoutine, event: Event): void {
    event.stopPropagation();
    if (this.expandedRoutineOid === r.oid) {
      this.expandedRoutineOid = null;
      this.routineError = null;
      return;
    }
    this.expandedRoutineOid = r.oid;
    this.routineError = null;
    if (this.routineSources.has(r.oid)) {
      return;
    }
    this.routineLoading = true;
    this.schemaService.getRoutineSource(r.oid).subscribe({
      next: (data) => {
        this.routineSources.set(r.oid, data.source);
        this.routineLoading = false;
      },
      error: (err) => {
        this.routineError =
          err?.error?.error || err?.message || 'Не удалось загрузить текст';
        this.routineLoading = false;
      },
    });
  }

  isExpandedRoutine(r: SchemaRoutine): boolean {
    return this.expandedRoutineOid === r.oid;
  }

  routineSource(r: SchemaRoutine): string {
    return this.routineSources.get(r.oid) ?? '';
  }

  close(): void {
    this.closed.emit();
  }
}