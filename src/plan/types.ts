import type { Answer } from "../oracle/types.js";
import type { Unit } from "../schema/model.js";
import type { Bounds, PeriodSpec } from "../time/periods.js";

/** "table.column" */
export type ColumnRef = string;

export type Shape = "lookup" | "single_value" | "breakdown" | "ranking" | "trend" | "distribution";
export type Agg = "count_rows" | "count_distinct" | "sum" | "avg" | "median" | "min" | "max";
export type TimeGrain = "hour" | "day" | "week" | "month" | "quarter" | "year";
export type Op =
  | "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "between"
  | "contains" | "starts_with" | "is_null" | "is_not_null" | "is_true" | "is_false";
export type DerivedCalc = "share_of_total" | "running_total" | "change_vs_previous" | "pct_change_vs_previous" | "rank" | "moving_average";

export interface Predicate {
  column: ColumnRef;
  op: Op;
  values: (string | number | boolean)[];
  /** Human text for the narrative: "region is West" */
  label: string;
  /** Where it came from: a span id, a value link, a saved fragment, a convention. */
  source: string;
  /** Implied by a saved definition or convention, shown distinctly in the narrative. */
  implied?: boolean;
  /** Match the value and all its descendants via a self-reference (category hierarchy). */
  hierarchy?: { parentColumn: string; keyColumn: string };
}

export interface Measure {
  alias: string;
  /** "number of orders", "total order total", "revenue" */
  label: string;
  kind: "column" | "count" | "duration" | "saved";
  agg: Agg;
  /** grain table of the measure */
  table: string;
  column?: ColumnRef;
  duration?: { start: ColumnRef; end: ColumnRef };
  /** Row filters that belong to the measure (saved fragment filters). */
  filters?: Predicate[];
  saved?: string;
  /** Restrict the aggregate to a period with FILTER (period comparisons, §5.15). */
  period?: { column: ColumnRef; bounds: Bounds };
  /** Only used by HAVING / ordering, not displayed. */
  hidden?: boolean;
  unit?: Unit;
}

export interface Dimension {
  alias: string;
  label: string;
  /** column: group by a column; entity: group by a table's PK + display columns; time: date_trunc */
  kind: "column" | "entity" | "time";
  column?: ColumnRef;
  table: string;
  grain?: TimeGrain;
}

export interface Existence {
  negated: boolean;
  /** related table tested for presence */
  table: string;
  filters: Predicate[];
  timeWindow?: TimeWindow;
  label: string;
}

export interface Having {
  measure: Measure;
  op: Op;
  values: number[];
  label: string;
}

export interface TimeWindow {
  column: ColumnRef;
  period: PeriodSpec;
  bounds: Bounds;
}

export interface OrderTerm {
  /** measure alias, dimension alias, or a column ref for lookups */
  ref: string;
  kind: "measure" | "dimension" | "column";
  dir: "asc" | "desc";
}

export interface QueryPlan {
  shape: Shape;
  /** Listed/counted entity for lookups and count shapes. */
  subject?: string;
  measures: Measure[];
  projections: ColumnRef[];
  dimensions: Dimension[];
  filters: Predicate[];
  existence: Existence[];
  having?: Having;
  timeWindow?: TimeWindow;
  derived?: { kind: DerivedCalc; window?: number };
  /** Two-period comparison: each measure is computed for both periods via FILTER. */
  comparePeriods?: { column: ColumnRef; current: Bounds; previous: Bounds; currentLabel: string; previousLabel: string };
  order: OrderTerm[];
  limit?: number;
  perGroupLimit?: { partition: string; n: number };
  /** DISTINCT ON (dimension) latest/first-per-group lookup. */
  distinctOn?: { partition: string; orderColumn: ColumnRef; dir: "asc" | "desc" };
  distinct: boolean;
  includeEmptyGroups: boolean;
  /** Use the latest snapshot for semi-additive snapshot measures (C12). */
  snapshotLatest?: { table: string; column: string };
  /** Exclude soft-deleted subject rows (current-state question). */
  softDelete?: { table: string; column: string; kind: "timestamp" | "boolean" };
  /** Chosen join paths: "from->to" → relationship ids in order. */
  joinPaths: Record<string, string[]>;
}

export interface Decision {
  /** question id that set this field */
  question: string;
  /** what the decision was about: shape, measure, period, join_path, ... */
  about: string;
  value: unknown;
  confidence: number;
  answer?: Answer;
  /** load-bearing decisions change the SQL; plan confidence = min over these */
  loadBearing: boolean;
  /** "oracle" | "code" | "config" | "saved" | "user" | "default" */
  by: string;
}

export const emptyPlan = (): QueryPlan => ({
  shape: "single_value",
  measures: [],
  projections: [],
  dimensions: [],
  filters: [],
  existence: [],
  order: [],
  distinct: false,
  includeEmptyGroups: false,
  joinPaths: {},
});
