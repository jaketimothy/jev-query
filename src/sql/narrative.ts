import type { QueryPlan, Predicate, Measure } from "../plan/types.js";
import type { SchemaModel } from "../schema/model.js";
import { splitRef } from "../schema/model.js";
import { capitalize, humanRef } from "../plan/build.js";

const OP_TEXT: Record<string, string> = {
  eq: "is", neq: "is not", in: "is one of", not_in: "is not one of", gt: "is more than", gte: "is at least", lt: "is less than",
  lte: "is at most", between: "is between", contains: "contains", starts_with: "starts with", is_null: "is missing", is_not_null: "is present",
  is_true: "is true", is_false: "is false",
};

export function predicateText(model: SchemaModel, p: Predicate): string {
  if (p.label) return p.label;
  const name = humanRef(model, p.column);
  if (p.op === "is_null" || p.op === "is_not_null" || p.op === "is_true" || p.op === "is_false") return `${name} ${OP_TEXT[p.op]}`;
  if (p.op === "between") return `${name} is between ${p.values[0]} and ${p.values[1]} (inclusive)`;
  return `${name} ${OP_TEXT[p.op]} ${p.values.join(", ")}`;
}

function measureText(m: Measure): string {
  return m.saved ? `${m.label} (per your saved definition)` : m.label;
}

/**
 * Deterministic English rendering of a plan (spec §8.1). Conditions implied by saved
 * definitions or conventions are marked so the R3 coverage check can ignore them.
 */
export function narrate(plan: QueryPlan, model: SchemaModel): string {
  const parts: string[] = [];
  const shown = plan.measures.filter((m) => !m.hidden);
  const tm = plan.subject ? model.tables[plan.subject] : undefined;
  if (plan.shape === "lookup") {
    parts.push(`${capitalize(plan.distinct ? "distinct " : "")}${tm?.humanName ?? "records"}`);
    if (plan.projections.length) parts.push(`showing ${plan.projections.map((p) => humanRef(model, p)).join(", ")}`);
    if (plan.distinctOn) parts.push(`the ${plan.distinctOn.dir === "desc" ? "most recent" : "earliest"} one for each ${plan.dimensions.find((d) => d.alias === plan.distinctOn!.partition)?.label ?? "group"}`);
  } else if (plan.comparePeriods) {
    parts.push(`${capitalize(shown.map(measureText).join(" and "))} for ${plan.comparePeriods.currentLabel} compared with ${plan.comparePeriods.previousLabel}`);
  } else {
    parts.push(capitalize(shown.map(measureText).join(" and ") || "count"));
  }
  const dims = plan.dimensions.filter((d) => !(plan.distinctOn && d.alias === plan.distinctOn.partition) && !(plan.shape === "lookup" && d.table === plan.subject));
  if (dims.length) {
    parts.push(dims.map((d) => (d.kind === "time" ? `per ${d.grain}` : `for each ${d.label}`)).join(", "));
  }
  if (plan.includeEmptyGroups) parts.push("including groups with nothing to count");
  if (plan.timeWindow) {
    const w = plan.timeWindow;
    parts.push(`where ${humanRef(model, w.column)} is in ${w.bounds.label}`);
  }
  const userFilters = plan.filters.filter((f) => !f.implied);
  if (userFilters.length) parts.push(`where ${userFilters.map((f) => predicateText(model, f)).join(" and ")}`);
  for (const e of plan.existence) {
    const inner = e.filters.map((f) => predicateText(model, f));
    parts.push(inner.length ? `${e.label} where ${inner.join(" and ")}` : e.label);
  }
  if (plan.having) parts.push(`keeping only those where ${plan.having.label}`);
  const implied = [...plan.filters.filter((f) => f.implied), ...shown.flatMap((m) => m.filters ?? [])];
  if (implied.length && shown.some((m) => m.saved)) parts.push(`(the saved definition excludes ${[...new Set(implied.filter((f) => f.op === "not_in" || f.op === "neq").flatMap((f) => f.values))].join(" and ")} records)`);
  if (plan.softDelete) parts.push(`(excluding ${model.tables[plan.softDelete.table].humanName} that are deleted or closed)`);
  if (plan.snapshotLatest) parts.push(`(using the latest ${humanRef(model, `${plan.snapshotLatest.table}.${plan.snapshotLatest.column}`)})`);
  if (plan.derived) {
    const d = { share_of_total: "with each item's share of the total", running_total: "with a running total", change_vs_previous: "with the change from the previous period", pct_change_vs_previous: "with the % change from the previous period", rank: "with each item's rank", moving_average: `with a ${plan.derived.window ?? 3}-period moving average` }[plan.derived.kind];
    parts.push(d);
  }
  const ord = plan.order[0];
  if (ord) {
    const what = ord.kind === "measure" ? shown.find((m) => m.alias === ord.ref)?.label ?? ord.ref : ord.kind === "column" ? humanRef(model, ord.ref) : ord.ref;
    if (ord.kind === "column" && model.tables[splitRef(ord.ref)[0]]?.columns[splitRef(ord.ref)[1]]?.kind.match(/timestamp|date/)) parts.push(ord.dir === "desc" ? "most recent first" : "oldest first");
    else parts.push(`ordered by ${what}, ${ord.dir === "desc" ? "highest first" : "lowest first"}`);
  }
  if (plan.perGroupLimit) parts.push(`top ${plan.perGroupLimit.n} within each ${plan.dimensions.find((d) => d.alias === plan.perGroupLimit!.partition)?.label ?? "group"}`);
  else if (plan.limit !== undefined && plan.shape !== "single_value") parts.push(plan.limit === 1 ? "only the top one" : `top ${plan.limit}`);
  return parts.join(", ").replace(/, \(/g, " (") + ".";
}
