import { buildExportTfData, buildTrainerExportHtml, TrainerExportData } from './trainer-export';
import { PriceCandle } from '../models/market.model';

function mkCandles(n: number, startMs: number, stepMs: number): PriceCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const dt = new Date(startMs + i * stepMs).toISOString().slice(0, 19).replace('T', ' ');
    const base = 100 + i * 0.1;
    return {
      dt,
      open_price: base,
      high_price: base + 1,
      low_price: base - 1,
      close_price: base + 0.5,
      volume: 1000 + i,
    };
  });
}

describe('trainer-export', () => {
  it('buildExportTfData compacts candles', () => {
    const candles = mkCandles(3, Date.UTC(2026, 0, 1), 300000);
    const tf = buildExportTfData(10, '5m', 300, candles);
    expect(tf.tfId).toBe(10);
    expect(tf.candles.length).toBe(3);
    expect(tf.candles[0].length).toBe(6);
    expect(tf.candles[0][0]).toBe(candles[0].dt);
  });

  it('buildTrainerExportHtml embeds data for 2 securities and all their TF candles', () => {
    const sec1Candles5m = mkCandles(300, Date.UTC(2026, 0, 1), 300000);
    const sec1Candles1h = mkCandles(300, Date.UTC(2026, 0, 1), 3600000);
    const sec2Candles5m = mkCandles(250, Date.UTC(2026, 1, 1), 300000);
    const sec2Candles1h = mkCandles(250, Date.UTC(2026, 1, 1), 3600000);

    const data: TrainerExportData = {
      version: 3,
      exportedAt: '2026-11-25T12:00:00.000Z',
      defaultSecurityId: 1,
      defaultIndicators: [
        { uid: 'i1', type: 'SMA', period: 9, color: '#2563eb' },
      ],
      defaults: { commissionPct: 0.03, executionDelaySec: 0, speedMs: 1000, signalTpPct: 0.4, signalSlPct: 0.2 },
      securities: [
        {
          id: 1, name: 'SEC1', exchangeName: 'MOEX',
          defaultTfId: 10,
          timeframes: [{ id: 10, tf: '5m', sec: 300 }, { id: 20, tf: '1H', sec: 3600 }],
          byTf: {
            '10': buildExportTfData(10, '5m', 300, sec1Candles5m),
            '20': buildExportTfData(20, '1H', 3600, sec1Candles1h),
          },
        },
        {
          id: 2, name: 'SEC2', exchangeName: 'MOEX',
          defaultTfId: 10,
          timeframes: [{ id: 10, tf: '5m', sec: 300 }, { id: 20, tf: '1H', sec: 3600 }],
          byTf: {
            '10': buildExportTfData(10, '5m', 300, sec2Candles5m),
            '20': buildExportTfData(20, '1H', 3600, sec2Candles1h),
          },
        },
      ],
    };

    const html = buildTrainerExportHtml(data);
    expect(html).toContain('SEC1');
    expect(html).toContain('SEC2');

    const m = html.match(/const DATA = (\{.*\});\n/);
    expect(m).toBeTruthy();
    const embedded = JSON.parse(m![1]) as TrainerExportData;
    expect(embedded.securities.length).toBe(2);
    for (const sec of embedded.securities) {
      for (const tf of sec.timeframes) {
        const tfData = sec.byTf[String(tf.id)];
        expect(tfData).toBeTruthy();
        expect(tfData.candles.length).toBeGreaterThan(0);
        expect(tfData.candles[0].length).toBe(6);
      }
    }
  });

  it('embedded runtime initializes second security with visible candles', () => {
    const mk = (id: number, name: string) => ({
      id, name, exchangeName: 'MOEX', defaultTfId: 10,
      timeframes: [{ id: 10, tf: '5m', sec: 300 }],
      byTf: { '10': buildExportTfData(10, '5m', 300, mkCandles(300, Date.UTC(2026, 0, 1) + id * 86400000, 300000)) },
    });
    const data: TrainerExportData = {
      version: 3, exportedAt: '2026-11-25T12:00:00.000Z',
      defaultSecurityId: 1,
      defaultIndicators: [],
      defaults: { commissionPct: 0.03, executionDelaySec: 0, speedMs: 1000, signalTpPct: 0.4, signalSlPct: 0.2 },
      securities: [mk(1, 'SEC1'), mk(2, 'SEC2')],
    };
    const html = buildTrainerExportHtml(data);
    const m = html.match(/const DATA = (\{.*\});\n/);
    expect(m).toBeTruthy();
    const embedded = JSON.parse(m![1]) as TrainerExportData;
    // simulate the export runtime logic for second security
    const sec = embedded.securities.find(s => s.id === 2)!;
    expect(sec).toBeTruthy();
    const tf = sec.byTf[String(sec.defaultTfId)];
    expect(tf.candles.length).toBe(300);
  });
});
