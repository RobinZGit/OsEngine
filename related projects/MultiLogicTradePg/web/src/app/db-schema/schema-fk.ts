import { DatabaseSchema, SchemaTable } from '../models/schema.model';

export interface SchemaFkLink {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  name?: string;
}

export interface DiagramTableBox {
  name: string;
  comment: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Колонки, показанные в боксе (PK + FK + остальные кратко). */
  columns: { name: string; kind: 'pk' | 'fk' | 'col'; type: string }[];
}

export interface DiagramEdge {
  link: SchemaFkLink;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SchemaDiagramLayout {
  width: number;
  height: number;
  boxes: DiagramTableBox[];
  edges: DiagramEdge[];
  links: SchemaFkLink[];
}

const BOX_W = 200;
const ROW_H = 16;
const HEADER_H = 28;
const PAD = 8;
const COL_GAP = 56;
const ROW_GAP = 28;

/** Группы слева → направо (справочники → ядро → logics). */
const TABLE_GROUPS: string[][] = [
  ['security_types', 'exchanges', 'timeframes', 'sides', 'actions', 'brokers'],
  ['securities', 'security_prefixes', 'futures_expirations', 'accounts'],
  ['prices', 'price_load_log', 'parameter_types', 'parameter_sets', 'parameter_values'],
  ['indicators', 'indicator_value_types', 'security_indicator_series', 'indicator_values'],
  [
    'logics',
    'logic_param_defs',
    'logic_params',
    'logic_indicator_signals',
    'logic_stops',
    'logic_securities',
  ],
  [
    'logic_trades',
    'logic_trade_lots',
    'logic_backtest_runs',
    'logic_backtest_security_state',
    'app_tech_log',
  ],
];

export function extractFkLinks(schema: DatabaseSchema): SchemaFkLink[] {
  const links: SchemaFkLink[] = [];
  const seen = new Set<string>();

  const add = (link: SchemaFkLink) => {
    const key = `${link.fromTable}.${link.fromColumn}->${link.toTable}.${link.toColumn}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  for (const t of schema.tables) {
    for (const c of t.constraints ?? []) {
      const def = c.definition || '';
      const isFk =
        c.type === 'FOREIGN KEY' ||
        c.type === 'f' ||
        /\bFOREIGN KEY\b/i.test(def);
      if (!isFk) continue;
      const m = def.match(
        /FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\w+)\s*\(([^)]+)\)/i
      );
      if (!m) continue;
      const fromCols = m[1].split(',').map((s) => s.trim().replace(/"/g, ''));
      const toCols = m[3].split(',').map((s) => s.trim().replace(/"/g, ''));
      for (let i = 0; i < fromCols.length; i++) {
        add({
          fromTable: t.name,
          fromColumn: fromCols[i],
          toTable: m[2],
          toColumn: toCols[i] || toCols[0],
          name: c.name,
        });
      }
    }

    for (const col of t.columns) {
      const m = col.type.match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
      if (!m) continue;
      add({
        fromTable: t.name,
        fromColumn: col.name,
        toTable: m[1],
        toColumn: m[2],
      });
    }
  }

  return links.sort((a, b) =>
    `${a.fromTable}.${a.fromColumn}`.localeCompare(`${b.fromTable}.${b.fromColumn}`)
  );
}

function isPkColumn(table: SchemaTable, colName: string): boolean {
  for (const c of table.constraints ?? []) {
    if (c.type !== 'PRIMARY KEY' && c.type !== 'p' && !/PRIMARY KEY/i.test(c.definition || '')) {
      continue;
    }
    if (new RegExp(`\\b${colName}\\b`).test(c.definition || '')) return true;
  }
  const col = table.columns.find((x) => x.name === colName);
  if (col && /\bPRIMARY KEY\b/i.test(col.type)) return true;
  return colName === 'id';
}

function columnsForBox(
  table: SchemaTable,
  fkCols: Set<string>
): DiagramTableBox['columns'] {
  const out: DiagramTableBox['columns'] = [];
  for (const col of table.columns) {
    const pk = isPkColumn(table, col.name);
    const fk = fkCols.has(col.name);
    if (pk || fk) {
      out.push({
        name: col.name,
        kind: pk ? 'pk' : 'fk',
        type: shortType(col.type),
      });
    }
  }
  // Если FK/PK мало — добавить ещё пару полей для контекста
  if (out.length < 3) {
    for (const col of table.columns) {
      if (out.some((c) => c.name === col.name)) continue;
      out.push({ name: col.name, kind: 'col', type: shortType(col.type) });
      if (out.length >= 5) break;
    }
  }
  return out;
}

function shortType(type: string): string {
  return type
    .replace(/\s+REFERENCES[\s\S]*/i, '')
    .replace(/\s+PRIMARY KEY/i, '')
    .replace(/\s+UNIQUE/i, '')
    .replace(/\s+NOT NULL/i, '')
    .replace(/\s+DEFAULT[\s\S]*/i, '')
    .trim()
    .slice(0, 18);
}

export function buildSchemaDiagram(schema: DatabaseSchema): SchemaDiagramLayout {
  const links = extractFkLinks(schema);
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  const fkByTable = new Map<string, Set<string>>();
  for (const l of links) {
    if (!fkByTable.has(l.fromTable)) fkByTable.set(l.fromTable, new Set());
    fkByTable.get(l.fromTable)!.add(l.fromColumn);
  }

  const placed = new Set<string>();
  const columns: string[][] = TABLE_GROUPS.map((g) =>
    g.filter((name) => {
      if (!byName.has(name)) return false;
      placed.add(name);
      return true;
    })
  );
  const rest = schema.tables.map((t) => t.name).filter((n) => !placed.has(n)).sort();
  if (rest.length) columns.push(rest);

  const boxes: DiagramTableBox[] = [];
  let maxBottom = 0;
  let x = PAD;
  for (const group of columns) {
    let y = PAD;
    for (const name of group) {
      const table = byName.get(name)!;
      const cols = columnsForBox(table, fkByTable.get(name) ?? new Set());
      const height = HEADER_H + cols.length * ROW_H + PAD;
      boxes.push({
        name,
        comment: table.comment,
        x,
        y,
        width: BOX_W,
        height,
        columns: cols,
      });
      y += height + ROW_GAP;
      maxBottom = Math.max(maxBottom, y);
    }
    x += BOX_W + COL_GAP;
  }

  const boxMap = new Map(boxes.map((b) => [b.name, b]));

  const fieldY = (box: DiagramTableBox, colName: string): number => {
    const idx = box.columns.findIndex((c) => c.name === colName);
    const row = idx >= 0 ? idx : 0;
    return box.y + HEADER_H + row * ROW_H + ROW_H / 2;
  };

  const edges: DiagramEdge[] = [];
  for (const link of links) {
    const from = boxMap.get(link.fromTable);
    const to = boxMap.get(link.toTable);
    if (!from || !to) continue;
    const y1 = fieldY(from, link.fromColumn);
    const y2 = fieldY(to, link.toColumn);
    // Стрелка от правого края from к левому краю to (или наоборот, если to правее)
    let x1: number;
    let x2: number;
    if (from.x + from.width <= to.x) {
      x1 = from.x + from.width;
      x2 = to.x;
    } else if (to.x + to.width <= from.x) {
      x1 = from.x;
      x2 = to.x + to.width;
    } else {
      x1 = from.x + from.width;
      x2 = to.x + to.width;
    }
    edges.push({ link, x1, y1, x2, y2 });
  }

  return {
    width: Math.max(x + PAD, BOX_W + PAD * 2),
    height: Math.max(maxBottom + PAD, 400),
    boxes,
    edges,
    links,
  };
}

export function edgePath(e: DiagramEdge): string {
  const mx = (e.x1 + e.x2) / 2;
  return `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
}
