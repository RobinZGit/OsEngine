import { Routes } from '@angular/router';
import { LogicsComponent } from './logics/logics.component';
import { ReferencesComponent } from './references/references.component';
import { IndicatorsComponent } from './indicators/indicators.component';
import { TerminalComponent } from './terminal/terminal.component';
import { MonitoringComponent } from './monitoring/monitoring.component';
import { TrainerComponent } from './trainer/trainer.component';

export const routes: Routes = [
  { path: '', redirectTo: 'operations', pathMatch: 'full' },
  { path: 'operations', component: LogicsComponent },
  { path: 'references', component: ReferencesComponent },
  { path: 'terminal', component: TerminalComponent },
  { path: 'trainer', component: TrainerComponent },
  { path: 'monitoring', component: MonitoringComponent },
  { path: 'indicators', component: IndicatorsComponent },
  { path: '**', redirectTo: 'operations' },
];
