import {
  CreateLogicGroupPayload,
  CreateLogicOptionsResponse,
  CreateLogicSignalItem,
  CreateLogicsPayload,
  CreateLogicOptionGroup,
  CreateLogicOptionIndicator,
} from '../models/lookup.model';

/**
 * #1006: чистые помощники формы «Создать логику из лучших рейтингов».
 * Сборка запроса на создание логик и предпросмотр имени (алгоритм имени повторён
 * в API `POST /api/indicators/create-logics`).
 */

export interface BuilderSelection {
  open: boolean;
  close: boolean;
}

export type BuilderSelectionMap = Record<string, BuilderSelection>;

export function selectionKey(timeframeId: number, indicatorId: number): string {
  return `${timeframeId}:${indicatorId}`;
}

/** Маркеры в имени логики: O — открытие, C — закрытие. */
export function logicNameMarkers(open: boolean, close: boolean): string {
  return `${open ? 'O' : ''}${close ? 'C' : ''}`;
}

/** Часть имени логики для одного индикатора: «КОД-O», «КОД-C», «КОД-OC» или «КОД». */
export function logicNamePart(
  code: string,
  open: boolean,
  close: boolean
): string {
  const markers = logicNameMarkers(open, close);
  return markers ? `${code}-${markers}` : code;
}

/** Предпросмотр имени логики по ТФ: «ТФ КОД-OC КОД-C» (<=100 символов). */
export function buildLogicNamePreview(
  tf: string | null | undefined,
  items: { code: string; open: boolean; close: boolean }[]
): string {
  const parts = items
    .filter((it) => it.open || it.close)
    .map((it) => logicNamePart(it.code, it.open, it.close));
  return `${tf ?? ''} ${parts.join(' ')}`.trim().slice(0, 100);
}

/** Сколько индикаторов с хотя бы одной галочкой (по всем ТФ). */
export function countSelectedGroups(
  groups: CreateLogicOptionGroup[],
  selection: BuilderSelectionMap
): { groups: number; indicators: number } {
  let groupCount = 0;
  let indicatorCount = 0;
  for (const g of groups) {
    let inGroup = 0;
    for (const ind of g.indicators) {
      const sel = selection[selectionKey(g.timeframe_id, ind.indicator_id)];
      if (sel && (sel.open || sel.close)) inGroup += 1;
    }
    if (inGroup > 0) {
      groupCount += 1;
      indicatorCount += inGroup;
    }
  }
  return { groups: groupCount, indicators: indicatorCount };
}

function toSignalItem(
  indicator: CreateLogicOptionIndicator,
  sel: BuilderSelection
): CreateLogicSignalItem {
  return {
    indicator_id: indicator.indicator_id,
    code: indicator.code,
    position_side: indicator.position_side === 'short' ? 'short' : 'long',
    signal_kind: indicator.signal_kind === 'counter' ? 'counter' : 'trend',
    open: sel.open,
    close: sel.close,
  };
}

/**
 * Payload для `POST /api/indicators/create-logics`: только ТФ с хотя бы одной
 * галочкой; внутри — только отмеченные индикаторы. Порядок сохраняется.
 */
export function buildCreateLogicsPayload(
  accountId: number,
  groups: CreateLogicOptionGroup[],
  selection: BuilderSelectionMap
): CreateLogicsPayload {
  const payloadGroups: CreateLogicGroupPayload[] = [];
  for (const g of groups) {
    const items: CreateLogicSignalItem[] = [];
    for (const ind of g.indicators) {
      const sel = selection[selectionKey(g.timeframe_id, ind.indicator_id)];
      if (!sel || (!sel.open && !sel.close)) continue;
      items.push(toSignalItem(ind, sel));
    }
    if (items.length) {
      payloadGroups.push({ timeframe_id: g.timeframe_id, items });
    }
  }
  return { account_id: accountId, groups: payloadGroups };
}

/** Пустая карта выбора для набора опций. */
export function emptySelection(options: CreateLogicOptionsResponse | null): BuilderSelectionMap {
  const out: BuilderSelectionMap = {};
  for (const g of options?.groups ?? []) {
    for (const ind of g.indicators) {
      out[selectionKey(g.timeframe_id, ind.indicator_id)] = { open: false, close: false };
    }
  }
  return out;
}
