/**
 * The schema model (spec §2): what exists, with an inferred role, unit and the rule +
 * confidence behind every inference. Serialized as `composer.lock.json`.
 */

export type ColumnRole =
  | "identifier"
  | "foreign_key"
  | "timestamp_event"
  | "timestamp_audit"
  | "soft_delete"
  | "boolean_flag"
  | "dimension_categorical"
  | "dimension_text"
  | "free_text"
  | "attribute"
  | "measure_additive"
  | "measure_nonadditive"
  | "measure_semiadditive"
  | "json"
  | "tenant"
  | "other";

export type UnitKind = "money" | "percent" | "duration" | "weight" | "count";

export interface Unit {
  kind: UnitKind;
  /** Stored value ÷ divisor = display value (e.g. cents → dollars: 100). */
  divisor?: number;
  /** Display label: "USD", "%", "s", "g", ... */
  label: string;
  /** For percent: whether the stored value is a fraction (0.1) rather than a percent (10). */
  fraction?: boolean;
}

export interface Inference {
  rule: string;
  confidence: number;
}

export interface ColumnModel {
  table: string;
  name: string;
  /** format_type() output, e.g. "integer", "timestamp with time zone", "order_status" */
  type: string;
  /** base category: number | text | timestamp | date | boolean | enum | json | interval | other */
  kind: "number" | "text" | "timestamp" | "date" | "boolean" | "enum" | "json" | "interval" | "array" | "other";
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  role: ColumnRole;
  inference: Inference;
  unit?: Unit;
  description: string;
  /** "placed at", "list price" */
  humanName: string;
  synonyms: string[];
  /** Known values (enum labels, CHECK list, or pg_stats most_common_vals). */
  values?: string[];
  valuesSource?: "enum" | "check" | "pg_stats" | "sample" | "config";
  /** Inclusive numeric range from a CHECK BETWEEN / >= constraint. */
  range?: { min?: number; max?: number };
  nDistinct?: number;
  nullFrac?: number;
  avgWidth?: number;
  pii: boolean;
  /** High-cardinality, name-like text that value linking queries directly (pg_trgm / ILIKE). */
  searchable: boolean;
  hidden: boolean;
  /** Set for the time column used by default for this table (C4). */
  isDefaultTime?: boolean;
  /** Column comment marks it as the business time ("When ..."). */
  commentMarked?: boolean;
}

export interface DurationPair {
  start: string;
  end: string;
  label: string;
  inference: Inference;
}

export interface TableModel {
  key: string;
  schema: string;
  name: string;
  kind: "table" | "view" | "matview";
  description: string;
  humanName: string;
  /** singular human noun: "order", "support ticket" */
  noun: string;
  synonyms: string[];
  primaryKey: string[];
  rowEstimate: number;
  columns: Record<string, ColumnModel>;
  columnOrder: string[];
  softDelete?: { column: string; kind: "timestamp" | "boolean"; inference: Inference };
  defaultTime?: string;
  /** Display columns (C13). Empty → the identifier is shown. */
  display: string[];
  junction?: { left: string; right: string; inference: Inference };
  snapshot?: { dateColumn: string; entityColumns: string[]; inference: Inference };
  durations: DurationPair[];
  rls: boolean;
  hidden: boolean;
}

export interface Relationship {
  id: string;
  /** child (many) side */
  from: { table: string; columns: string[] };
  /** parent (one) side */
  to: { table: string; columns: string[] };
  /** from → to cardinality */
  cardinality: "N:1" | "1:1";
  source: "fk" | "inferred" | "config";
  inference: Inference;
  /** Role prefix when several relationships reach the same target (R5): "billing", "assigned to". */
  role?: string;
  /** "the address the order was billed to" style phrase */
  label: string;
  nullable: boolean;
  selfReference: boolean;
}

export interface SchemaModel {
  version: 1;
  fingerprint: string;
  generatedAt: string;
  schemas: string[];
  tables: Record<string, TableModel>;
  relationships: Relationship[];
  /** Low-confidence inferences for `doctor` to list. */
  warnings: { target: string; message: string; confidence: number }[];
  extensions: string[];
}

export function col(model: SchemaModel, ref: string): ColumnModel | undefined {
  const i = ref.lastIndexOf(".");
  return model.tables[ref.slice(0, i)]?.columns[ref.slice(i + 1)];
}

export function splitRef(ref: string): [string, string] {
  const i = ref.lastIndexOf(".");
  return [ref.slice(0, i), ref.slice(i + 1)];
}

export const isTimeKind = (c: ColumnModel) => c.kind === "timestamp" || c.kind === "date";
export const isMeasureRole = (r: ColumnRole) => r === "measure_additive" || r === "measure_nonadditive" || r === "measure_semiadditive";
