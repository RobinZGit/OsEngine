import { CreateLogicOptionGroup } from '../models/lookup.model';
import {
  buildCreateLogicsPayload,
  buildLogicNamePreview,
  countSelectedGroups,
  emptySelection,
  logicNamePart,
  selectionKey,
} from './logic-builder.util';

const groups: CreateLogicOptionGroup[] = [
  {
    timeframe_id: 6,
    tf: 'M15',
    full_name: '15 минут',
    indicators: [
      {
        indicator_id: 10,
        code: 'RSI',
        name: 'RSI',
        rating: 120,
        position_side: 'long',
        signal_kind: 'counter',
        time_kind: 'workday_trade',
        samples_count: 12,
        securities_count: 40,
      },
      {
        indicator_id: 20,
        code: 'MACD',
        name: 'MACD',
        rating: 80,
        position_side: 'short',
        signal_kind: 'trend',
        time_kind: 'weekend_trade',
        samples_count: 8,
        securities_count: 40,
      },
    ],
  },
  {
    timeframe_id: 4,
    tf: 'M5',
    full_name: '5 минут',
    indicators: [
      {
        indicator_id: 30,
        code: 'PACC',
        name: 'PACC',
        rating: 60,
        position_side: 'long',
        signal_kind: 'trend',
        time_kind: 'workday_trade',
        samples_count: 5,
        securities_count: 40,
      },
    ],
  },
];

describe('logic-builder.util', () => {
  it('selectionKey combines timeframe and indicator', () => {
    expect(selectionKey(6, 10)).toBe('6:10');
  });

  it('logicNamePart adds O/C markers', () => {
    expect(logicNamePart('RSI', true, true)).toBe('RSI-OC');
    expect(logicNamePart('RSI', true, false)).toBe('RSI-O');
    expect(logicNamePart('RSI', false, true)).toBe('RSI-C');
    expect(logicNamePart('RSI', false, false)).toBe('RSI');
  });

  it('buildLogicNamePreview builds "TF CODE-marker ..."', () => {
    expect(
      buildLogicNamePreview('M15', [
        { code: 'RSI', open: false, close: true },
        { code: 'MACD', open: true, close: false },
      ])
    ).toBe('M15 RSI-C MACD-O');
  });

  it('buildLogicNamePreview trims to 100 chars', () => {
    const items = Array.from({ length: 40 }, () => ({ code: 'AAA', open: true, close: true }));
    expect(buildLogicNamePreview('M15', items).length).toBeLessThanOrEqual(100);
  });

  it('emptySelection creates an entry per indicator', () => {
    const sel = emptySelection({ groups });
    expect(Object.keys(sel).length).toBe(3);
    expect(sel['6:10']).toEqual({ open: false, close: false });
  });

  it('buildCreateLogicsPayload skips unselected and maps kinds/sides', () => {
    const selection = {
      '6:10': { open: false, close: true },
      '6:20': { open: true, close: false },
      '4:30': { open: false, close: false },
    };
    const payload = buildCreateLogicsPayload(1, groups, selection);
    expect(payload.account_id).toBe(1);
    expect(payload.groups.length).toBe(1);
    expect(payload.groups[0].timeframe_id).toBe(6);
    expect(payload.groups[0].items).toEqual([
      {
        indicator_id: 10,
        code: 'RSI',
        position_side: 'long',
        signal_kind: 'counter',
        open: false,
        close: true,
      },
      {
        indicator_id: 20,
        code: 'MACD',
        position_side: 'short',
        signal_kind: 'trend',
        open: true,
        close: false,
      },
    ]);
  });

  it('buildCreateLogicsPayload drops groups with no selection', () => {
    const payload = buildCreateLogicsPayload(1, groups, emptySelection({ groups }));
    expect(payload.groups).toEqual([]);
  });

  it('countSelectedGroups counts groups and indicators with a checkbox', () => {
    const selection = {
      '6:10': { open: true, close: false },
      '6:20': { open: false, close: false },
      '4:30': { open: false, close: true },
    };
    expect(countSelectedGroups(groups, selection)).toEqual({ groups: 2, indicators: 2 });
  });
});
