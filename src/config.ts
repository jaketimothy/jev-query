import { parse } from "yaml";
import type { ColumnRole, UnitKind } from "./schema/model.js";

/** `composer.yaml` (spec §2.4). Everything is optional. */
export interface ComposerConfig {
  database?: { schemas?: string[]; exclude_tables?: string[]; include_tables?: string[] };
  time?: {
    timezone?: string;
    week_start?: "monday" | "sunday";
    fiscal_year_start_month?: number;
    last_period_means?: "calendar" | "trailing";
    /** Fixed "now" (ISO string) for deterministic runs. */
    as_of?: string;
  };
  soft_delete?: { mode?: "current_state_only" | "always" | "never" };
  tenancy?: { column?: string; columns?: string[] };
  overrides?: Record<string, ColumnOverride & TableOverride>;
  synonyms?: Record<string, string[]>;
  relationships?: {
    default_paths?: Record<string, string>;
    add?: { from: string; to: string; role?: string }[];
  };
  gating?: { auto_execute_min_confidence?: number; margin_reask?: number; clarify_below?: number };
  limits?: { default_ranking?: number; max_rows?: number; statement_timeout_ms?: number; lookup_default?: number };
  introspection?: { sample_when_no_stats?: boolean; check_duration_order?: boolean; max_values?: number };
  pii?: { columns?: string[] };
}

export interface ColumnOverride {
  role?: ColumnRole;
  unit?: UnitKind | "cents" | "dollars";
  description?: string;
  references?: string;
  values?: string[];
  hidden?: boolean;
  pii?: boolean;
  synonyms?: string[];
  soft_delete?: boolean;
  default_time?: boolean;
}

export interface TableOverride {
  display?: string[];
  description?: string;
  hidden?: boolean;
  synonyms?: string[];
}

export function parseConfig(text: string): ComposerConfig {
  return (parse(text) as ComposerConfig) ?? {};
}

export interface ResolvedSettings {
  timezone: string;
  weekStart: "monday" | "sunday";
  lastPeriodMeans: "calendar" | "trailing";
  softDeleteMode: "current_state_only" | "always" | "never";
  autoExecuteMinConfidence: number;
  marginReask: number;
  defaultRanking: number;
  maxRows: number;
  lookupDefault: number;
  statementTimeoutMs: number;
}

export function resolveSettings(cfg: ComposerConfig = {}): ResolvedSettings {
  return {
    timezone: cfg.time?.timezone ?? "UTC",
    weekStart: cfg.time?.week_start ?? "monday",
    lastPeriodMeans: cfg.time?.last_period_means ?? "calendar",
    softDeleteMode: cfg.soft_delete?.mode ?? "current_state_only",
    autoExecuteMinConfidence: cfg.gating?.auto_execute_min_confidence ?? 0.6,
    marginReask: cfg.gating?.margin_reask ?? 0.15,
    defaultRanking: cfg.limits?.default_ranking ?? 10,
    maxRows: cfg.limits?.max_rows ?? 5000,
    lookupDefault: cfg.limits?.lookup_default ?? 1000,
    statementTimeoutMs: cfg.limits?.statement_timeout_ms ?? 15000,
  };
}
