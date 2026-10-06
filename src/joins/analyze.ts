import type { QueryPlan, Measure } from "../plan/types.js";
import type { SchemaModel } from "../schema/model.js";
import { splitRef } from "../schema/model.js";
import { JoinGraph, type JoinPath } from "./graph.js";

export interface Ambiguity {
  /** divergence point → target, e.g. "orders->regions" */
  key: string;
  from: string;
  to: string;
  /** option key → path suffix starting at the divergence point */
  options: Record<string, JoinPath>;
  /** the attribute the user mentioned that needs this path ("region name") */
  attribute: string;
}

export interface FanoutIssue {
  measure: Measure;
  root: string;
  /** additive measures at the root grain that could replace it (grain switch, §7 step 3) */
  alternatives: { ref: string; label: string }[];
}

export interface MeasureGroup {
  root: string;
  measures: Measure[];
}

export interface JoinAnalysis {
  /** main root for lookups / single group */
  root: string;
  groups: MeasureGroup[];
  ambiguities: Ambiguity[];
  fanout: FanoutIssue[];
  /** tables the query references but cannot reach */
  unreachable: string[];
}

/** Tables a plan's measures/dimensions/filters reference (existence tables excluded, §5.3). */
export function anchorTables(plan: QueryPlan): { dims: string[]; filters: string[] } {
  const dims = new Set<string>();
  for (const d of plan.dimensions) dims.add(d.table);
  const filters = new Set<string>();
  for (const f of plan.filters) filters.add(splitRef(f.column)[0]);
  if (plan.timeWindow) filters.add(splitRef(plan.timeWindow.column)[0]);
  if (plan.comparePeriods) filters.add(splitRef(plan.comparePeriods.column)[0]);
  for (const p of plan.projections) dims.add(splitRef(p)[0]);
  return { dims: [...dims], filters: [...filters] };
}

/**
 * Decide FROM roots, detect fan-out and join-path ambiguities. Shared by the composer
 * (to ask R2 path questions) and the compiler (to emit joins).
 */
export function analyzeJoins(plan: QueryPlan, model: SchemaModel, graph = new JoinGraph(model)): JoinAnalysis {
  const { dims, filters } = anchorTables(plan);
  const measures = [...plan.measures, ...(plan.having && !plan.measures.some((m) => m.alias === plan.having!.measure.alias) ? [plan.having.measure] : [])];
  const groups: MeasureGroup[] = [];
  const fanout: FanoutIssue[] = [];
  const unreachable: string[] = [];

  if (!measures.length) {
    const root = plan.subject ?? dims[0] ?? filters[0] ?? Object.keys(model.tables)[0];
    groups.push({ root, measures: [] });
  }
  for (const m of measures) {
    const anchors = [...new Set([m.table, ...dims])];
    let root = graph.findRoot(anchors, [m.table]);
    if (!root) {
      unreachable.push(...dims.filter((d) => !graph.paths(m.table, d).length));
      root = m.table;
    }
    if (root !== m.table && !(m.kind === "count" || m.agg === "count_distinct" || m.agg === "min" || m.agg === "max")) {
      fanout.push({ measure: m, root, alternatives: grainAlternatives(model, root, m) });
    }
    const g = groups.find((x) => x.root === root);
    if (g) g.measures.push(m);
    else groups.push({ root, measures: [m] });
  }
  // Merge groups whose roots are up-reachable from another group's root only when no fan-out
  // would result; otherwise keep them separate (pre-aggregation, chasm trap §7).
  const root = groups[0]?.root ?? plan.subject!;
  const ambiguities: Ambiguity[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const targets = new Set<string>([...dims, ...filters, ...g.measures.map((m) => m.table), ...g.measures.flatMap((m) => (m.filters ?? []).map((f) => splitRef(f.column)[0]))]);
    for (const t of targets) {
      if (t === g.root) continue;
      const best = graph.bestPaths(g.root, t);
      if (!best.length) {
        unreachable.push(t);
        continue;
      }
      const amb = ambiguityOf(best, plan.joinPaths);
      if (amb && !seen.has(amb.key)) {
        seen.add(amb.key);
        const attr = attributeFor(plan, t, model);
        ambiguities.push({ ...amb, attribute: attr });
      }
    }
  }
  return { root, groups, ambiguities, fanout, unreachable: [...new Set(unreachable)] };
}

function attributeFor(plan: QueryPlan, table: string, model: SchemaModel): string {
  const d = plan.dimensions.find((x) => x.table === table);
  if (d) return d.label;
  const f = plan.filters.find((x) => splitRef(x.column)[0] === table);
  if (f) {
    const tm = model.tables[table];
    const c = splitRef(f.column)[1];
    // the display column of a table *is* the entity ("West" is a region, not a "name")
    if (!tm) return table;
    return tm.display.includes(c) ? tm.noun : `${tm.noun} ${tm.columns[c]?.humanName ?? c}`;
  }
  return model.tables[table]?.noun ?? table;
}

/**
 * Given several equally good paths root→t, find the divergence point and the distinct
 * suffixes. Returns undefined when the pins in `joinPaths` already pick one.
 */
export function ambiguityOf(best: JoinPath[], pins: Record<string, string[]>): Omit<Ambiguity, "attribute"> | undefined {
  const filtered = applyPins(best, pins);
  if (filtered.length <= 1) return undefined;
  let k = 0;
  while (filtered.every((p) => p.steps[k] && p.steps[k].rel.id === filtered[0].steps[k].rel.id)) k++;
  const from = k === 0 ? filtered[0].from : filtered[0].steps[k - 1].to;
  const to = filtered[0].to;
  const options: Record<string, JoinPath> = {};
  for (const p of filtered) {
    const suffix = p.steps.slice(k);
    const first = suffix[0];
    const key = first.rel.role ? `role:${first.rel.role.replace(/\s+/g, "_")}` : `via:${first.to}`;
    options[options[key] ? `${key}_${Object.keys(options).length}` : key] = { ...p, from, steps: suffix, key: suffix.map((s) => s.rel.id).join("|") };
  }
  return { key: `${from}->${to}`, from, to, options };
}

/** Keep only paths consistent with pinned segments. */
export function applyPins(paths: JoinPath[], pins: Record<string, string[]>): JoinPath[] {
  let out = paths;
  for (const [key, relIds] of Object.entries(pins)) {
    const [, to] = key.split("->");
    if (!out.length || out[0].to !== to) continue;
    const match = out.filter((p) => containsSeq(p.steps.map((s) => s.rel.id), relIds));
    if (match.length) out = match;
  }
  return out;
}

function containsSeq(xs: string[], seq: string[]): boolean {
  outer: for (let i = 0; i + seq.length <= xs.length; i++) {
    for (let j = 0; j < seq.length; j++) if (xs[i + j] !== seq[j]) continue outer;
    return true;
  }
  return false;
}

function grainAlternatives(model: SchemaModel, root: string, m: Measure): { ref: string; label: string }[] {
  const t = model.tables[root];
  if (!t || !m.column) return [];
  const src = model.tables[m.table]?.columns[splitRef(m.column)[1]];
  return Object.values(t.columns)
    .filter((c) => c.role === "measure_additive" && (!src?.unit || c.unit?.kind === src.unit.kind))
    .map((c) => ({ ref: `${root}.${c.name}`, label: `${c.humanName} of each ${t.noun}` }));
}
