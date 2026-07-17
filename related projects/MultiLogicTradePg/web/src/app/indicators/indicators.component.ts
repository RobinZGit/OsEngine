import { Component } from '@angular/core';
import { IndicatorsPanelComponent } from '../indicators-panel/indicators-panel.component';
import { SecuritiesPanelComponent } from '../securities-panel/securities-panel.component';

@Component({
  selector: 'app-indicators',
  standalone: true,
  imports: [IndicatorsPanelComponent, SecuritiesPanelComponent],
  templateUrl: './indicators.component.html',
  styleUrl: './indicators.component.css',
})
export class IndicatorsComponent {}
