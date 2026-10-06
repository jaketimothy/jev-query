import type { Agg, Op, QueryPlan } from "../plan/types.js";

export type Scope = { kind: "user"; id: string } | { kind: "team"; id: string } | { kind: "org" };
export type Status = "accepted" | "canonical" | "deprecated" | "stale";

interface Base {
  id: string;
  scope: "user" | "team" | "org";
  /** user id / team id the record belongs to (for user & team scope) */
  owner?: string;
  status: Status;
  acceptedBy: string;
  acceptedAt: string;
  /** column ref → type at acceptance; used for drift detection (§2B Drift) */
  fingerprint: Record<string, string>;
  narrative: string;
}

/** A reusable business definition, e.g. "revenue" (spec §2B). */
export interface SavedMeasure extends Base {
  kind: "measure";
  name: string;
  phrases: string[];
  definition: {
    agg: Agg;
    column?: string;
    duration?: { start: string; end: string };
    count?: string;
    unit?: string;
    row_filters: { column: string; op: Op; values: (string | number | boolean)[] }[];
  };
}

/** A whole accepted plan with rebindable slots and pinned decisions. */
export interface SavedPlan extends Base {
  kind: "plan";
  name?: string;
  request: string;
  plan: QueryPlan;
  /** plan paths whose values came from the request (period, filters, limit) */
  slots: { path: string; kind: "period" | "filter_list" | "limit" | "value" }[];
  /** decision key → option key (clarification answers reused without re-asking) */
  pinned: Record<string, string>;
}

export type SavedRecord = SavedMeasure | SavedPlan;

export interface SearchQuery {
  text: string;
  user?: string;
  team?: string;
  kind?: SavedRecord["kind"];
  k?: number;
}

/** Storage interface the host app implements (or uses the defaults). */
export interface SavedQueryStore {
  search(q: SearchQuery): Promise<SavedRecord[]>;
  get(id: string): Promise<SavedRecord | undefined>;
  put(record: SavedRecord): Promise<void>;
  setStatus(id: string, status: Status): Promise<void>;
  all(): Promise<SavedRecord[]>;
}
