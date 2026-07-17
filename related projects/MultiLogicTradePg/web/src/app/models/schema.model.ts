export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

export interface SchemaIndex {
  name: string;
  definition: string;
}

export interface SchemaConstraint {
  name: string;
  type: string;
  definition: string;
}

export interface SchemaTable {
  name: string;
  comment: string | null;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  constraints: SchemaConstraint[];
}

export interface SchemaRoutine {
  oid: number;
  name: string;
  kind: 'function' | 'procedure';
  arguments: string;
  result_type: string | null;
  description: string | null;
  source?: string;
}

export interface SchemaExtension {
  name: string;
  version: string;
}

export interface DatabaseSchema {
  schema: string;
  database: string;
  tables: SchemaTable[];
  routines: SchemaRoutine[];
  extensions: SchemaExtension[];
  sourceMode?: 'live' | 'offline';
  sourceNote?: string;
  generatedFrom?: string[];
}

export interface RoutineSource {
  name: string;
  kind: string;
  arguments: string;
  source: string;
}
