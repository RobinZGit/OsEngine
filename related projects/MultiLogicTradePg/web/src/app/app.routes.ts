import { Routes } from '@angular/router';
import { LogicsComponent } from './logics/logics.component';
import { ReferencesComponent } from './references/references.component';
import { IndicatorsComponent } from './indicators/indicators.component';

export const routes: Routes = [
  { path: '', redirectTo: 'operations', pathMatch: 'full' },
  { path: 'operations', component: LogicsComponent },
  { path: 'references', component: ReferencesComponent },
  { path: 'indicators', component: IndicatorsComponent },
  { path: '**', redirectTo: 'operations' },
];
