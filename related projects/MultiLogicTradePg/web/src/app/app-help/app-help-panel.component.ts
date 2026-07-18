import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { APP_HELP_SECTIONS, HelpSection } from './app-help-content';

@Component({
  selector: 'app-help-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app-help-panel.component.html',
  styleUrl: './app-help-panel.component.css',
})
export class AppHelpPanelComponent {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();

  readonly sections: HelpSection[] = APP_HELP_SECTIONS;
  activeId = this.sections[0]?.id ?? '';

  select(id: string): void {
    this.activeId = id;
  }

  get active(): HelpSection | undefined {
    return this.sections.find((s) => s.id === this.activeId) ?? this.sections[0];
  }

  close(): void {
    this.closed.emit();
  }
}
