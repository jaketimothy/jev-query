import type { ColumnModel, SchemaModel, TableModel } from "../schema/model.js";
import { isMeasureRole, splitRef } from "../schema/model.js";
import type { SavedMeasure } from "../saved/types.js";
import type { Agg, Measure, Predicate } from "./types.js";

/** A measure candidate offered to the `measure_quantity` question (spec §5.4). */
export interface MeasureCandidate {
  key: string; // saved:<name> | col:<t.c> | dur:<t.a>b> | count:<t>
  kind: Measure["kind"];
  table: string;
  label: string;
  description: string;
  column?: string;
  duration?: { start: string; end: string };
  saved?: SavedMeasure;
}

export const AGGS: Agg[] = ["sum", "avg", "median", "max", "min", "count_rows", "count_distinct"];

export function measureCandidates(model: SchemaModel, tables: string[], saved: SavedMeasure[]): MeasureCandidate[] {
  const out: MeasureCandidate[] = [];
  for (const s of saved) {
    out.push({ key: `saved:${s.name}`, kind: "saved", table: savedTable(s), label: s.name, description: `${capitalize(s.name)} (saved definition): ${s.narrative.replace(/^[^:]*:\s*/, "")}`, saved: s });
  }
  for (const tk of tables) {
    const t = model.tables[tk];
    if (!t || t.hidden) continue;
    for (const c of Object.values(t.columns)) {
      if (c.hidden || !isMeasureRole(c.role)) continue;
      out.push({ key: `col:${tk}.${c.name}`, kind: "column", table: tk, column: `${tk}.${c.name}`, label: `${t.noun} ${c.humanName}`, description: columnDescription(t, c) });
    }
    for (const d of t.durations) {
      out.push({
        key: `dur:${tk}.${d.start}>${d.end}`, kind: "duration", table: tk, duration: { start: `${tk}.${d.start}`, end: `${tk}.${d.end}` },
        label: d.label, description: `For ${t.humanName}: the ${d.label}.`,
      });
    }
    if (!t.junction) out.push({ key: `count:${tk}`, kind: "count", table: tk, label: `number of ${t.humanName}`, description: `The number of ${t.humanName}${t.synonyms.length ? ` (also called ${t.synonyms.filter((x) => x !== t.humanName && x !== t.noun).slice(0, 3).join(", ")})` : ""}.` });
  }
  return out;
}

function savedTable(s: SavedMeasure): string {
  const ref = s.definition.column ?? s.definition.duration?.start ?? s.definition.count;
  return ref ? (s.definition.count ? s.definition.count : splitRef(ref)[0]) : "";
}

export function columnDescription(t: TableModel, c: ColumnModel): string {
  let d = c.description.includes(":") && !c.description.startsWith(t.humanName) ? c.description : c.description;
  if (!/[.]$/.test(d)) d += ".";
  const unit = c.unit?.kind === "money" ? " Money amount." : c.unit?.kind === "percent" ? " A percentage." : "";
  const role = c.role === "measure_nonadditive" ? " A per-record rate/price/score; not meaningful to add up." : c.role === "measure_semiadditive" ? " A level/stock snapshot; add up only within one date." : "";
  return `${capitalize(t.noun)} ${c.humanName}: ${d}${unit}${role}`.replace(/\s+/g, " ");
}

/** Grammar mask (spec §5.4): which aggregates are legal for a candidate. */
export function legalAggs(model: SchemaModel, c: MeasureCandidate): Agg[] {
  if (c.kind === "saved") return [c.saved!.definition.agg];
  if (c.kind === "count") return ["count_rows", "count_distinct"];
  if (c.kind === "duration") return ["avg", "median", "min", "max"];
  const cm = model.tables[c.table].columns[splitRef(c.column!)[1]];
  if (cm.role === "measure_nonadditive") return ["avg", "median", "min", "max"];
  if (cm.role === "measure_semiadditive") return ["sum", "avg", "min", "max"];
  return ["sum", "avg", "median", "min", "max"];
}

const AGG_WORD: Record<Agg, string> = { sum: "total", avg: "average", median: "median", max: "maximum", min: "minimum", count_rows: "number of", count_distinct: "number of distinct" };

export function toMeasure(model: SchemaModel, c: MeasureCandidate, agg: Agg, alias?: string): Measure {
  if (c.kind === "saved") return measureFromSaved(model, c.saved!, alias);
  if (c.kind === "count") {
    const t = model.tables[c.table];
    return { alias: alias ?? `${t.name}_count`, label: `number of ${t.humanName}`, kind: "count", agg: "count_rows", table: c.table };
  }
  if (c.kind === "duration") {
    return { alias: alias ?? `${agg}_${slug(c.label)}`, label: `${AGG_WORD[agg]} ${c.label}`, kind: "duration", agg, table: c.table, duration: c.duration };
  }
  const [t, col] = splitRef(c.column!);
  const cm = model.tables[t].columns[col];
  // "total order total" → "order total"; "total order item quantity" stays readable
  const noun = model.tables[t].noun;
  const subject = cm.humanName.startsWith(noun) ? cm.humanName : `${noun} ${cm.humanName}`;
  const label = cm.humanName.split(" ").includes(AGG_WORD[agg]) ? subject : `${AGG_WORD[agg]} ${subject}`;
  return {
    alias: alias ?? `${agg === "sum" ? "total" : agg}_${slug(cm.humanName)}`,
    label,
    kind: "column",
    agg,
    table: t,
    column: c.column,
    unit: cm.unit,
  };
}

export function measureFromSaved(model: SchemaModel, s: SavedMeasure, alias?: string): Measure {
  const d = s.definition;
  const filters: Predicate[] = d.row_filters.map((f) => ({
    column: f.column,
    op: f.op,
    values: f.values,
    label: `${humanRef(model, f.column)} ${f.op === "not_in" || f.op === "neq" ? "is not" : "is"} ${f.values.join(" or ")}`,
    source: `saved:${s.name}`,
    implied: true,
  }));
  if (d.count) return { alias: alias ?? slug(s.name), label: s.name, kind: "count", agg: "count_rows", table: d.count, filters, saved: s.name };
  if (d.duration) return { alias: alias ?? slug(s.name), label: s.name, kind: "duration", agg: d.agg, table: splitRef(d.duration.start)[0], duration: d.duration, filters, saved: s.name };
  const [t, c] = splitRef(d.column!);
  const cm = model.tables[t]?.columns[c];
  return {
    alias: alias ?? slug(s.name),
    label: s.name,
    kind: "column",
    agg: d.agg,
    table: t,
    column: d.column,
    filters,
    saved: s.name,
    unit: d.unit === "cents" ? { kind: "money", divisor: 100, label: "USD" } : cm?.unit,
  };
}

export function humanRef(model: SchemaModel, ref: string): string {
  const [t, c] = splitRef(ref);
  const tm = model.tables[t];
  const cm = tm?.columns[c];
  return cm ? `${tm.noun} ${cm.humanName}` : ref;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "value";
}

export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
