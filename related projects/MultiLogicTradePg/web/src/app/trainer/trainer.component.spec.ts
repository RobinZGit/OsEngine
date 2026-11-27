import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TrainerComponent } from './trainer.component';
import { SecuritiesService } from '../services/securities.service';
import { ReferencesService } from '../services/references.service';
import { TrainerService } from '../services/trainer.service';
import { MonitoringService } from '../services/monitoring.service';
import { TerminalStateService } from '../services/terminal-state.service';
import { LogicsService } from '../services/logics.service';

describe('TrainerComponent', () => {
  let fixture: ComponentFixture<TrainerComponent>;
  let component: TrainerComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrainerComponent],
      providers: [
        { provide: SecuritiesService, useValue: { getExchanges: () => of([]), getSecurities: () => of([]), getTimeframes: () => of([]), getPrices: () => of([]), loadPrices: () => of({ ok: true }) } },
        { provide: ReferencesService, useValue: { getLookups: () => of([]) } },
        { provide: TrainerService, useValue: { saveSession: () => of({ ok: true }), saveTrades: () => of({ ok: true }), getSessionHistory: () => of([]), getSessionTrades: () => of([]), getStats: () => of({}) } },
        { provide: MonitoringService, useValue: { reportClientEvent: () => of({ ok: true }) } },
        { provide: TerminalStateService, useValue: { getAccounts: () => of([]) } },
        { provide: LogicsService, useValue: { getLogics: () => of([]), getLogicIndicatorSignals: () => of([]), getLogicStops: () => of([]) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TrainerComponent);
    component = fixture.componentInstance;
    spyOn(component, 'ngOnInit').and.stub();
  });

  it('reloads started blocks when timeframe changes', async () => {
    const startSpy = spyOn(component, 'startBlock').and.returnValue(Promise.resolve());
    component.timeframeId = 1;
    component.blocks = [
      { id: 'b1', securityId: 10, securityName: 'SBER', started: true } as any,
      { id: 'b2', securityId: 20, securityName: 'GAZP', started: true } as any,
    ];

    component.onTimeframeChange(2);

    expect(component.timeframeId).toBe(2);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(startSpy.calls.argsFor(0)[0].id).toBe('b1');
    expect(startSpy.calls.argsFor(1)[0].id).toBe('b2');
  });

  it('does nothing when timeframe is unchanged', () => {
    const startSpy = spyOn(component, 'startBlock').and.returnValue(Promise.resolve());
    component.timeframeId = 5;
    component.blocks = [{ id: 'b1' } as any];

    component.onTimeframeChange(5);

    expect(startSpy).not.toHaveBeenCalled();
  });
});
