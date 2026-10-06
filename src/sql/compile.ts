import type { ResolvedSettings } from "../config.js";
import { analyzeJoins, applyPins, type JoinAnalysis } from "../joins/analyze.js";
import { JoinGraph, type JoinPath, type Step } from "../joins/graph.js";
import type { Dimension, Existence, Measure, Predicate, QueryPlan, TimeWindow } from "../plan/types.js";
import type { ColumnModel, SchemaModel } from "../schema/model.js";
import { splitRef } from "../schema/model.js";
import { wallParts } from "../time/periods.js";

export interface OutputColumn {
  name: string;
  label: string;
  role: "dimension" | "measure" | "projection" | "derived";
  /** money columns are displayed in major units already */
  unit?: string;
}

export interface Compiled {
  sql: string;
  params: unknown[];
  columns: OutputColumn[];
  analysis: JoinAnalysis;
}

export class CompileError extends Error {
  constructor(message: string, readonly about: string, readonly detail?: unknown) {
    super(message);
  }
}

export const qi = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s) ? s : `"${s.replace(/"/g, '""')}"`);
const RESERVED = new Set(["is", "at", "by", "if", "no", "of", "user", "order", "group", "select", "from", "where", "table", "limit", "offset", "to", "end", "desc", "asc", "default", "check", "column", "primary", "references", "window", "all", "analyse", "analyze", "and", "any", "as", "both", "case", "cast", "collate", "constraint", "create", "current_date", "current_time", "current_user", "distinct", "do", "else", "except", "false", "for", "foreign", "grant", "having", "in", "initially", "intersect", "into", "leading", "not", "null", "on", "only", "or", "placing", "returning", "some", "symmetric", "then", "trailing", "true", "union", "unique", "using", "variadic", "when", "with"]);

class Params {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** One joined table instance, keyed by the relationship chain from the root. */
interface Inst {
  key: string;
  table: string;
  alias: string;
  joinSql?: string;
  /** relationship-id chain from root */
  chain: string[];
  /** set when reached only through a 1:N step (not joined; becomes EXISTS) */
}

interface Scope {
  root: string;
  rootAlias: string;
  insts: Map<string, Inst>;
  order: Inst[];
  aliases: Set<string>;
  /** table → instance key for the chosen path */
  byTable: Map<string, string>;
  /** predicates that must go in the ON clause of a given instance (LEFT JOIN mode) */
  leftMode: boolean;
}

export function compile(plan: QueryPlan, model: SchemaModel, settings: ResolvedSettings, graph = new JoinGraph(model)): Compiled {
  const analysis = analyzeJoins(plan, model, graph);
  if (analysis.ambiguities.length) throw new CompileError(`ambiguous join path ${analysis.ambiguities[0].key}`, "join_path", analysis.ambiguities);
  if (analysis.fanout.length) throw new CompileError(`measure ${analysis.fanout[0].measure.label} would be inflated by fan-out`, "measure", analysis.fanout);
  const p = new Params();
  const ctx = new Ctx(plan, model, settings, graph, p);
  let sql: string;
  let columns: OutputColumn[];
  if (analysis.groups.length <= 1) {
    ({ sql, columns } = ctx.single(analysis.groups[0]?.root ?? analysis.root, analysis.groups[0]?.measures ?? []));
  } else {
    ({ sql, columns } = ctx.multi(analysis.groups.map((g) => ({ root: g.root, measures: g.measures }))));
  }
  return { sql, params: p.values, columns, analysis };
}

class Ctx {
  constructor(
    readonly plan: QueryPlan,
    readonly model: SchemaModel,
    readonly settings: ResolvedSettings,
    readonly graph: JoinGraph,
    readonly p: Params,
  ) {}

  col(ref: string): ColumnModel {
    const [t, c] = splitRef(ref);
    const m = this.model.tables[t]?.columns[c];
    if (!m) throw new CompileError(`unknown column ${ref}`, "schema");
    return m;
  }

  tableSql(t: string) {
    const tm = this.model.tables[t];
    return `${qi(tm.schema)}.${qi(tm.name)}`;
  }

  // ------------------------------------------------------------------ scopes & joins
  newScope(root: string, leftMode = false): Scope {
    const alias = this.aliasFor(root, new Set());
    const inst: Inst = { key: "", table: root, alias, chain: [] };
    const s: Scope = { root, rootAlias: alias, insts: new Map([["", inst]]), order: [], aliases: new Set([alias]), byTable: new Map([[root, ""]]), leftMode };
    return s;
  }

  aliasFor(table: string, used: Set<string>): string {
    const parts = this.model.tables[table].name.split("_").filter(Boolean);
    let base = parts.map((x) => x[0]).join("").toLowerCase() || "t";
    if (RESERVED.has(base) || /^\d/.test(base)) base = `${base}_`;
    let a = base;
    for (let i = 2; used.has(a) || RESERVED.has(a); i++) a = `${base}${i}`;
    used.add(a);
    return a;
  }

  pathTo(root: string, table: string): JoinPath {
    if (root === table) return { from: root, to: table, steps: [], downs: 0, label: "", key: "self" };
    const best = applyPins(this.graph.bestPaths(root, table), this.plan.joinPaths);
    if (!best.length) throw new CompileError(`no join path from ${root} to ${table}`, "join_path");
    return best[0];
  }

  /**
   * Ensure `table` is joined in scope (up steps only). Returns the alias, or undefined when
   * the path crosses a 1:N step (caller uses EXISTS instead).
   */
  join(s: Scope, table: string, opts: { allowDown?: boolean } = {}): string | undefined {
    if (s.byTable.has(table)) return s.insts.get(s.byTable.get(table)!)!.alias;
    const path = this.pathTo(s.root, table);
    if (path.downs > 0 && !opts.allowDown) return undefined;
    let cur = s.insts.get("")!;
    for (const step of path.steps) {
      const key = [...cur.chain, step.rel.id + ":" + step.dir].join("|");
      let inst = s.insts.get(key);
      if (!inst) {
        const alias = this.aliasFor(step.to, s.aliases);
        inst = { key, table: step.to, alias, chain: [...cur.chain, step.rel.id + ":" + step.dir] };
        inst.joinSql = this.joinClause(step, cur.alias, alias, s.leftMode);
        s.insts.set(key, inst);
        s.order.push(inst);
      }
      cur = inst;
    }
    s.byTable.set(table, cur.key);
    return cur.alias;
  }

  joinClause(step: Step, fromAlias: string, toAlias: string, left: boolean): string {
    const r = step.rel;
    const conds =
      step.dir === "up"
        ? r.from.columns.map((c, i) => `${toAlias}.${qi(r.to.columns[i])} = ${fromAlias}.${qi(c)}`)
        : r.from.columns.map((c, i) => `${toAlias}.${qi(c)} = ${fromAlias}.${qi(r.to.columns[i])}`);
    return `${left ? "LEFT JOIN" : "JOIN"} ${this.tableSql(step.to)} ${toAlias} ON ${conds.join(" AND ")}`;
  }

  /** Column expression in scope, joining as needed. Undefined if only reachable via 1:N. */
  colExpr(s: Scope, ref: string, allowDown = false): string | undefined {
    const [t, c] = splitRef(ref);
    const a = this.join(s, t, { allowDown });
    return a ? `${a}.${qi(c)}` : undefined;
  }

  // ------------------------------------------------------------------ predicates
  predicate(expr: string, pr: Predicate, cm: ColumnModel, s?: Scope): string {
    const v = (x: unknown) => this.p.add(x);
    const nullableNeg = cm.nullable;
    if (pr.hierarchy && (pr.op === "eq" || pr.op === "in") && s) {
      const [t] = splitRef(pr.column);
      const alias = expr.split(".")[0];
      const tbl = this.tableSql(t);
      const { parentColumn, keyColumn } = pr.hierarchy;
      const list = pr.values.map(v).join(", ");
      return `${alias}.${qi(keyColumn)} IN (WITH RECURSIVE h AS (SELECT ${qi(keyColumn)} FROM ${tbl} WHERE ${qi(cm.name)} IN (${list}) UNION SELECT c.${qi(keyColumn)} FROM ${tbl} c JOIN h ON c.${qi(parentColumn)} = h.${qi(keyColumn)}) SELECT ${qi(keyColumn)} FROM h)`;
    }
    switch (pr.op) {
      case "eq": return `${expr} = ${v(pr.values[0])}`;
      case "neq": return nullableNeg ? `(${expr} <> ${v(pr.values[0])} OR ${expr} IS NULL)` : `${expr} <> ${v(pr.values[0])}`;
      case "in": return pr.values.length === 1 ? `${expr} = ${v(pr.values[0])}` : `${expr} IN (${pr.values.map(v).join(", ")})`;
      case "not_in": {
        const inner = pr.values.length === 1 ? `${expr} <> ${v(pr.values[0])}` : `${expr} NOT IN (${pr.values.map(v).join(", ")})`;
        return nullableNeg ? `(${inner} OR ${expr} IS NULL)` : inner;
      }
      case "gt": return `${expr} > ${v(pr.values[0])}`;
      case "gte": return `${expr} >= ${v(pr.values[0])}`;
      case "lt": return `${expr} < ${v(pr.values[0])}`;
      case "lte": return `${expr} <= ${v(pr.values[0])}`;
      case "between": return `${expr} BETWEEN ${v(pr.values[0])} AND ${v(pr.values[1])}`;
      case "contains": return `${expr} ILIKE '%' || ${v(escapeLike(String(pr.values[0])))} || '%'`;
      case "starts_with": return `${expr} ILIKE ${v(escapeLike(String(pr.values[0])))} || '%'`;
      case "is_null": return `${expr} IS NULL`;
      case "is_not_null": return `${expr} IS NOT NULL`;
      case "is_true": return `${expr} IS TRUE`;
      case "is_false": return nullableNeg ? `${expr} IS NOT TRUE` : `${expr} IS FALSE`;
    }
  }

  timeConds(expr: string, w: { column: string; bounds: { start?: Date; end?: Date } }): string[] {
    const cm = this.col(w.column);
    const lit = (d: Date) => (cm.kind === "date" ? dateOnly(d, this.settings.timezone) : d.toISOString());
    const out: string[] = [];
    if (w.bounds.start) out.push(`${expr} >= ${this.p.add(lit(w.bounds.start))}`);
    if (w.bounds.end) out.push(`${expr} < ${this.p.add(lit(w.bounds.end))}`);
    return out;
  }

  /**
   * WHERE conditions for filters/time window/soft delete/snapshot/existence in a scope.
   * Conditions on tables reachable only through 1:N become correlated EXISTS (§5.9 scoping).
   */
  whereConds(s: Scope, measures: Measure[], opts: { skipWindow?: boolean; onClause?: Map<string, string[]> } = {}): string[] {
    const conds: string[] = [];
    const add = (table: string, cond: string) => {
      if (opts.onClause && table !== s.root && s.byTable.has(table)) {
        const k = s.byTable.get(table)!;
        opts.onClause.set(k, [...(opts.onClause.get(k) ?? []), cond]);
      } else if (opts.onClause && table === s.root) {
        opts.onClause.set("", [...(opts.onClause.get("") ?? []), cond]);
      } else conds.push(cond);
    };
    const filters = [...this.plan.filters];
    // saved-fragment row filters apply query-wide when there is a single measure
    if (measures.length === 1 && measures[0].filters?.length) filters.push(...measures[0].filters);
    else if (measures.length > 1) {
      // shared filters (present on every measure) go to WHERE; the rest become FILTER clauses
      const shared = sharedFilters(measures);
      filters.push(...shared);
    }
    const exists: { table: string; preds: Predicate[]; window?: TimeWindow; negated: boolean; label: string }[] = [];
    for (const f of dedupePredicates(filters)) {
      const [t] = splitRef(f.column);
      const e = this.colExpr(s, f.column);
      if (e) add(t, this.predicate(e, f, this.col(f.column), s));
      else exists.push({ table: t, preds: [f], negated: false, label: f.label });
    }
    if (this.plan.timeWindow && !opts.skipWindow) {
      const w = this.plan.timeWindow;
      const [t] = splitRef(w.column);
      const e = this.colExpr(s, w.column);
      if (e) for (const c of this.timeConds(e, w)) add(t, c);
      else exists.push({ table: t, preds: [], window: w, negated: false, label: "time window" });
    }
    if (this.plan.comparePeriods) {
      const cp = this.plan.comparePeriods;
      const e = this.colExpr(s, cp.column);
      if (e) {
        const start = [cp.current.start, cp.previous.start].filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0];
        const end = [cp.current.end, cp.previous.end].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
        conds.push(...this.timeConds(e, { column: cp.column, bounds: { start, end } }));
      }
    }
    const sd = this.plan.softDelete;
    if (sd && s.byTable.has(sd.table) && s.byTable.get(sd.table) === "") {
      const a = s.rootAlias;
      add(sd.table, sd.kind === "boolean" ? `${a}.${qi(sd.column)} IS NOT TRUE` : `${a}.${qi(sd.column)} IS NULL`);
    }
    const snap = this.plan.snapshotLatest;
    if (snap && measures.some((m) => m.table === snap.table)) {
      const a = this.join(s, snap.table);
      if (a) {
        const w = this.plan.timeWindow && splitRef(this.plan.timeWindow.column)[0] === snap.table ? this.plan.timeWindow : undefined;
        const inner = w ? ` WHERE ${this.timeConds(qi(snap.column), w).join(" AND ")}` : "";
        add(snap.table, `${a}.${qi(snap.column)} = (SELECT max(${qi(snap.column)}) FROM ${this.tableSql(snap.table)}${inner})`);
      }
    }
    for (const ex of this.plan.existence) exists.push({ table: ex.table, preds: ex.filters, window: ex.timeWindow, negated: ex.negated, label: ex.label });
    // merge positive exists on the same table
    const merged: typeof exists = [];
    for (const e of exists) {
      const m = merged.find((x) => x.table === e.table && !x.negated && !e.negated);
      if (m) {
        m.preds.push(...e.preds);
        m.window ??= e.window;
      } else merged.push({ ...e, preds: [...e.preds] });
    }
    for (const e of merged) conds.push(this.existsSql(s, e));
    return conds;
  }

  existsSql(s: Scope, e: { table: string; preds: Predicate[]; window?: TimeWindow; negated: boolean }): string {
    const path = this.pathTo(s.root, e.table);
    // split at the first 1:N step: the prefix is joined in the outer query
    const firstDown = path.steps.findIndex((x) => x.dir === "down");
    const prefix = firstDown < 0 ? path.steps : path.steps.slice(0, firstDown);
    const suffix = firstDown < 0 ? [] : path.steps.slice(firstDown);
    let anchorAlias = s.rootAlias;
    if (prefix.length) anchorAlias = this.join(s, prefix[prefix.length - 1].to) ?? s.rootAlias;
    if (!suffix.length) {
      // reachable by N:1 (presence of a parent) — express as a plain condition
      const conds = e.preds.map((pr) => this.predicate(this.colExpr(s, pr.column)!, pr, this.col(pr.column), s));
      if (e.window) conds.push(...this.timeConds(this.colExpr(s, e.window.column)!, e.window));
      const body = conds.join(" AND ") || "TRUE";
      return e.negated ? `NOT (${body})` : body;
    }
    // inner scope rooted at the first child table
    const used = new Set([...s.aliases]);
    const first = suffix[0];
    const innerRootAlias = this.aliasFor(first.to, used);
    const inner: Scope = { root: first.to, rootAlias: innerRootAlias, insts: new Map(), order: [], aliases: used, byTable: new Map([[first.to, ""]]), leftMode: false };
    inner.insts.set("", { key: "", table: first.to, alias: innerRootAlias, chain: [] });
    const r = first.rel;
    const corr = r.from.columns.map((c, i) => `${innerRootAlias}.${qi(c)} = ${anchorAlias}.${qi(r.to.columns[i])}`);
    // join the rest of the suffix (must be up steps from the child: junction → far side)
    let cur = inner.insts.get("")!;
    for (const st of suffix.slice(1)) {
      const alias = this.aliasFor(st.to, used);
      const inst: Inst = { key: cur.key + "|" + st.rel.id, table: st.to, alias, chain: [], joinSql: this.joinClause(st, cur.alias, alias, false) };
      inner.insts.set(inst.key, inst);
      inner.order.push(inst);
      inner.byTable.set(st.to, inst.key);
      cur = inst;
    }
    const conds = [...corr];
    for (const pr of e.preds) {
      const ex = this.colExpr(inner, pr.column);
      if (!ex) throw new CompileError(`cannot scope filter ${pr.column} inside EXISTS`, "filter");
      conds.push(this.predicate(ex, pr, this.col(pr.column), inner));
    }
    if (e.window) {
      const ex = this.colExpr(inner, e.window.column);
      if (ex) conds.push(...this.timeConds(ex, e.window));
    }
    for (const a of inner.aliases) s.aliases.add(a);
    const from = `FROM ${this.tableSql(first.to)} ${innerRootAlias}${inner.order.map((i) => " " + i.joinSql).join("")}`;
    return `${e.negated ? "NOT " : ""}EXISTS (SELECT 1 ${from} WHERE ${conds.join(" AND ")})`;
  }

  // ------------------------------------------------------------------ measures
  measureExpr(s: Scope, m: Measure, opts: { root: string; left?: boolean; extraFilter?: string[] }): string {
    let filterConds: string[] = [...(opts.extraFilter ?? [])];
    if (m.period) {
      const e = this.colExpr(s, m.period.column);
      if (e) filterConds.push(...this.timeConds(e, m.period));
    }
    const filterSql = () => (filterConds.length ? ` FILTER (WHERE ${filterConds.join(" AND ")})` : "");
    const money = m.unit?.kind === "money" && m.unit.divisor ? m.unit.divisor : undefined;
    const wrapMoney = (x: string, agg: string) => (money ? `round(${x} / ${money}.0, 2)` : agg === "avg" || agg === "median" ? `round(${x}::numeric, 2)` : x);
    if (m.kind === "count") {
      const tm = this.model.tables[m.table];
      const alias = this.join(s, m.table, { allowDown: true })!;
      const pk = tm.primaryKey.length === 1 ? `${alias}.${qi(tm.primaryKey[0])}` : undefined;
      if (m.table === opts.root && !opts.left) return `count(*)${filterSql()}`;
      if (m.table === opts.root && opts.left && pk) return `count(${pk})${filterSql()}`;
      if (pk) return `count(DISTINCT ${pk})${filterSql()}`;
      return `count(*)${filterSql()}`;
    }
    if (m.kind === "duration" && m.duration) {
      const a = this.colExpr(s, m.duration.start, true)!;
      const b = this.colExpr(s, m.duration.end, true)!;
      const diff = `(${b} - ${a})`;
      const fn = m.agg === "median" ? `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${diff})` : `${m.agg === "sum" ? "sum" : m.agg}(${diff})`;
      return m.agg === "median" ? `percentile_disc(0.5) WITHIN GROUP (ORDER BY ${diff})${filterSql()}` : `${fn}${filterSql()}`;
    }
    const e = this.colExpr(s, m.column!, true)!;
    switch (m.agg) {
      case "sum": {
        const x = `sum(${e})${filterSql()}`;
        return opts.left ? `COALESCE(${wrapMoney(x, "sum")}, 0)` : wrapMoney(x, "sum");
      }
      case "avg": return wrapMoney(`avg(${e})${filterSql()}`, "avg");
      case "median": return wrapMoney(`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${e})${filterSql()}`, "median");
      case "min": return wrapMoney(`min(${e})${filterSql()}`, "min");
      case "max": return wrapMoney(`max(${e})${filterSql()}`, "max");
      case "count_distinct": return `count(DISTINCT ${e})${filterSql()}`;
      case "count_rows": return `count(${e})${filterSql()}`;
    }
  }

  /** Raw (unrounded, base-unit) aggregate for HAVING comparisons. */
  havingExpr(s: Scope, m: Measure, root: string): string {
    if (m.kind === "count" || m.kind === "duration" || m.agg === "count_distinct") return this.measureExpr(s, m, { root });
    const e = this.colExpr(s, m.column!, true)!;
    const fn = m.agg === "median" ? `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${e})` : `${m.agg}(${e})`;
    return fn;
  }

  // ------------------------------------------------------------------ dimensions
  dimSelect(s: Scope, d: Dimension): { select: string[]; group: string[]; order: string; names: string[] } {
    if (d.kind === "time") {
      const e = this.colExpr(s, d.column!);
      if (!e) throw new CompileError(`${d.label} is not reachable from ${s.root}`, "dimension");
      const cm = this.col(d.column!);
      const expr = cm.kind === "date" ? `date_trunc('${d.grain}', ${e})` : `date_trunc('${d.grain}', ${e}, ${this.p.add(this.settings.timezone)})`;
      return { select: [`${expr} AS ${qi(d.alias)}`], group: [expr], order: qi(d.alias), names: [d.alias] };
    }
    if (d.kind === "entity") {
      const tm = this.model.tables[d.table];
      const a = this.join(s, d.table)!;
      const pk = tm.primaryKey.map((k) => `${a}.${qi(k)}`);
      const asLookup = this.plan.shape === "lookup" && this.plan.subject === d.table;
      const shown = asLookup
        ? (this.plan.projections.length ? this.plan.projections : defaultProjections(this.model, d.table)).filter((r) => splitRef(r)[0] === d.table && tm.columns[splitRef(r)[1]]?.kind !== "number" || tm.primaryKey.includes(splitRef(r)[1])).map((r) => splitRef(r)[1])
        : tm.display.length ? tm.display : tm.primaryKey;
      const names = shown.map((c) => (shown.length === 1 ? d.alias : `${d.alias}_${c}`));
      const select = shown.map((c, i) => `${a}.${qi(c)} AS ${qi(names[i])}`);
      return { select, group: [...new Set([...pk, ...shown.map((c) => `${a}.${qi(c)}`)])], order: shown.map((_, i) => qi(names[i])).join(", "), names };
    }
    const e = this.colExpr(s, d.column!);
    if (!e) throw new CompileError(`${d.label} is not reachable from ${s.root} without double counting`, "dimension");
    return { select: [`${e} AS ${qi(d.alias)}`], group: [e], order: qi(d.alias), names: [d.alias] };
  }

  // ------------------------------------------------------------------ single-root query
  single(root: string, measures: Measure[]): { sql: string; columns: OutputColumn[] } {
    const plan = this.plan;
    if (plan.shape === "lookup" && !measures.length) return this.lookup(root);
    const left = plan.includeEmptyGroups && this.canFlip(root, measures);
    if (left) return this.flipped(root, measures);
    const s = this.newScope(root);
    const dims = orderDims(plan.dimensions);
    const dsel = dims.map((d) => ({ d, ...this.dimSelect(s, d) }));
    const shown = measures.filter((m) => !m.hidden);
    const shared = measures.length > 1 ? sharedFilters(measures) : [];
    const msel = shown.map((m) => {
      const own = measures.length > 1 ? (m.filters ?? []).filter((f) => !shared.includes(f)) : [];
      const extra = own.map((f) => this.predicate(this.colExpr(s, f.column, true)!, f, this.col(f.column), s));
      return `${this.measureExpr(s, m, { root, extraFilter: extra })} AS ${qi(m.alias)}`;
    });
    const where = this.whereConds(s, measures);
    const having = plan.having ? this.havingSql(s, root) : undefined;
    const columns: OutputColumn[] = [
      ...dsel.flatMap((x) => x.names.map((n) => ({ name: n, label: x.d.label, role: "dimension" as const }))),
      ...shown.map((m) => ({ name: m.alias, label: m.label, role: "measure" as const, unit: unitLabel(m) })),
    ];
    const group = dsel.flatMap((x) => x.group);
    const from = `FROM ${this.tableSql(root)} ${s.rootAlias}${s.order.map((i) => "\n" + i.joinSql).join("")}`;
    const selectList = [...dsel.flatMap((x) => x.select), ...msel];
    if (!selectList.length) selectList.push("count(*) AS count");
    let sql = `SELECT ${selectList.join(",\n       ")}\n${from}`;
    if (where.length) sql += `\nWHERE ${where.join("\n  AND ")}`;
    if (group.length && measures.length) sql += `\nGROUP BY ${group.join(", ")}`;
    if (having) sql += `\nHAVING ${having}`;

    // per-group top-N
    if (plan.perGroupLimit && dims.length >= 2) {
      const part = dsel.find((x) => x.d.alias === plan.perGroupLimit!.partition) ?? dsel[0];
      const others = dsel.filter((x) => x !== part);
      const m = measures.find((x) => !x.hidden) ?? measures[0];
      const dir = plan.order.find((o) => o.kind === "measure")?.dir ?? "desc";
      const rowOrder = `${this.measureExpr(s, m, { root })} ${dir.toUpperCase()}${dir === "desc" ? " NULLS LAST" : ""}, ${others.flatMap((x) => x.group).join(", ")}`;
      const inner = sql.replace(/^SELECT /, `SELECT row_number() OVER (PARTITION BY ${part.group.join(", ")} ORDER BY ${rowOrder}) AS rn, `);
      const outCols = columns.map((c) => qi(c.name)).join(", ");
      const n = this.p.add(plan.perGroupLimit.n);
      sql = `SELECT ${outCols}\nFROM (\n${indent(inner)}\n) ranked\nWHERE rn <= ${n}\nORDER BY ${part.names.map(qi).join(", ")}, rn`;
      return { sql, columns };
    }

    sql += this.orderLimit(dsel, measures, columns);
    return this.wrapDerived(sql, columns, dsel.map((x) => x.d));
  }

  havingSql(s: Scope, root: string): string {
    const h = this.plan.having!;
    const e = this.havingExpr(s, h.measure, root);
    const pr: Predicate = { column: "", op: h.op, values: h.values, label: h.label, source: "having" };
    const v = (x: unknown) => this.p.add(x);
    switch (pr.op) {
      case "between": return `${e} BETWEEN ${v(h.values[0])} AND ${v(h.values[1])}`;
      case "gt": return `${e} > ${v(h.values[0])}`;
      case "gte": return `${e} >= ${v(h.values[0])}`;
      case "lt": return `${e} < ${v(h.values[0])}`;
      case "lte": return `${e} <= ${v(h.values[0])}`;
      case "eq": return `${e} = ${v(h.values[0])}`;
      default: return `${e} > ${v(h.values[0])}`;
    }
  }

  orderLimit(dsel: { d: Dimension; names: string[]; order: string }[], measures: Measure[], columns: OutputColumn[]): string {
    const plan = this.plan;
    const terms: string[] = [];
    const timeDim = dsel.find((x) => x.d.kind === "time");
    if (plan.shape === "trend" && timeDim && !plan.order.some((o) => o.kind === "measure")) {
      terms.push(`${timeDim.order} ASC`);
    }
    for (const o of plan.order) {
      if (o.kind === "measure") {
        const m = measures.find((x) => x.alias === o.ref);
        if (!m) continue;
        terms.push(`${m.hidden ? "" : qi(m.alias)}${m.hidden ? "" : ""} ${o.dir.toUpperCase()}${o.dir === "desc" ? " NULLS LAST" : ""}`.trim());
      } else if (o.kind === "dimension") {
        const d = dsel.find((x) => x.d.alias === o.ref);
        if (d) terms.push(`${d.order} ${o.dir.toUpperCase()}`);
      }
    }
    // deterministic tiebreakers on dimensions
    for (const d of dsel) if (!terms.some((t) => t.startsWith(d.order))) terms.push(`${d.order} ASC`);
    const cleaned = terms.filter((t) => !/^ (ASC|DESC)/.test(t) && !/^(ASC|DESC)/.test(t));
    let sql = cleaned.length && columns.length ? `\nORDER BY ${cleaned.join(", ")}` : "";
    const limit = plan.limit ?? (dsel.length ? this.settings.maxRows : undefined);
    if (limit !== undefined && dsel.length) sql += `\nLIMIT ${this.p.add(limit)}`;
    return sql;
  }

  wrapDerived(sql: string, columns: OutputColumn[], dims: Dimension[]): { sql: string; columns: OutputColumn[] } {
    const dv = this.plan.derived;
    if (!dv) return { sql, columns };
    const m = columns.find((c) => c.role === "measure");
    if (!m) return { sql, columns };
    const time = dims.find((d) => d.kind === "time");
    const ord = time ? qi(time.alias) : `${qi(m.name)} DESC`;
    const mv = qi(m.name);
    let expr: string;
    let name: string;
    let label: string;
    switch (dv.kind) {
      case "share_of_total": expr = `round(${mv} * 100.0 / NULLIF(sum(${mv}) OVER (), 0), 2)`; name = "share_pct"; label = "share of total (%)"; break;
      case "running_total": expr = `sum(${mv}) OVER (ORDER BY ${ord})`; name = "running_total"; label = `running total of ${m.label}`; break;
      case "change_vs_previous": expr = `${mv} - lag(${mv}) OVER (ORDER BY ${ord})`; name = "change"; label = "change vs previous period"; break;
      case "pct_change_vs_previous": expr = `round((${mv} / NULLIF(lag(${mv}) OVER (ORDER BY ${ord}), 0) - 1) * 100, 2)`; name = "pct_change"; label = "% change vs previous period"; break;
      case "rank": expr = `rank() OVER (ORDER BY ${mv} DESC NULLS LAST)`; name = "rank"; label = "rank"; break;
      case "moving_average": {
        const n = Math.max(2, dv.window ?? 3);
        expr = `round(avg(${mv}) OVER (ORDER BY ${ord} ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW), 2)`;
        name = `moving_avg_${n}`;
        label = `${n}-period moving average`;
        break;
      }
    }
    const outer = `SELECT t.*, ${expr} AS ${qi(name)}\nFROM (\n${indent(sql)}\n) t${time ? `\nORDER BY ${qi(time.alias)}` : ""}`;
    return { sql: outer, columns: [...columns, { name, label, role: "derived" }] };
  }

  // ------------------------------------------------------------------ lookup
  lookup(root: string): { sql: string; columns: OutputColumn[] } {
    const plan = this.plan;
    const s = this.newScope(root);
    const projections = plan.projections.length ? plan.projections : defaultProjections(this.model, root);
    const sel: string[] = [];
    const columns: OutputColumn[] = [];
    const used = new Set<string>();
    for (const ref of projections) {
      const e = this.colExpr(s, ref);
      if (!e) continue;
      const cm = this.col(ref);
      let name = cm.name;
      if (used.has(name)) name = `${splitRef(ref)[0]}_${name}`;
      used.add(name);
      const money = cm.unit?.kind === "money" && cm.unit.divisor;
      sel.push(money ? `round(${e} / ${cm.unit!.divisor}.0, 2) AS ${qi(name)}` : `${e} AS ${qi(name)}`);
      columns.push({ name, label: cm.humanName, role: "projection", unit: cm.unit?.label });
    }
    let distinctOn = "";
    const orderTerms: string[] = [];
    if (plan.distinctOn) {
      const d = plan.dimensions.find((x) => x.alias === plan.distinctOn!.partition);
      if (d) {
        const tm = this.model.tables[d.table];
        const a = this.join(s, d.table)!;
        const keys = d.kind === "entity" ? tm.primaryKey.map((k) => `${a}.${qi(k)}`) : [this.colExpr(s, d.column!)!];
        distinctOn = `DISTINCT ON (${keys.join(", ")}) `;
        // show the partition key first
        const shown = d.kind === "entity" ? (tm.display.length ? tm.display : tm.primaryKey) : [];
        shown.forEach((c, i) => {
          const nm = `${tm.noun.replace(/\s+/g, "_")}_${c}`;
          sel.unshift(`${a}.${qi(c)} AS ${qi(nm)}`);
          columns.splice(i, 0, { name: nm, label: `${tm.noun} ${c}`, role: "dimension" });
        });
        const oc = this.colExpr(s, plan.distinctOn.orderColumn)!;
        orderTerms.push(...keys, `${oc} ${plan.distinctOn.dir.toUpperCase()}`);
      }
    }
    const where = this.whereConds(s, []);
    const from = `FROM ${this.tableSql(root)} ${s.rootAlias}${s.order.map((i) => "\n" + i.joinSql).join("")}`;
    let sql = `SELECT ${plan.distinct && !distinctOn ? "DISTINCT " : ""}${distinctOn}${sel.join(",\n       ")}\n${from}`;
    if (where.length) sql += `\nWHERE ${where.join("\n  AND ")}`;
    if (!distinctOn) {
      for (const o of plan.order) {
        const e = o.kind === "column" ? this.colExpr(s, o.ref) : undefined;
        if (e) orderTerms.push(`${e} ${o.dir.toUpperCase()}${o.dir === "desc" ? " NULLS LAST" : ""}`);
      }
      const tm = this.model.tables[root];
      if (!plan.distinct) for (const k of tm.primaryKey) orderTerms.push(`${s.rootAlias}.${qi(k)}`);
      else if (columns.length) orderTerms.push(...columns.map((c) => qi(c.name)));
    }
    if (orderTerms.length) sql += `\nORDER BY ${orderTerms.join(", ")}`;
    sql += `\nLIMIT ${this.p.add(Math.min(plan.limit ?? this.settings.lookupDefault, this.settings.maxRows))}`;
    return { sql, columns };
  }

  // ------------------------------------------------------------------ include empty groups (LEFT JOIN from the dimension side)
  canFlip(root: string, measures: Measure[]): boolean {
    const dimTables = [...new Set(this.plan.dimensions.map((d) => d.table))];
    if (dimTables.length !== 1 || dimTables[0] === root) return false;
    if (measures.some((m) => m.table !== root && m.kind !== "count")) return false;
    const path = this.pathTo(root, dimTables[0]);
    return path.downs === 0 && path.steps.length > 0;
  }

  flipped(root: string, measures: Measure[]): { sql: string; columns: OutputColumn[] } {
    const dimTable = this.plan.dimensions[0].table;
    const path = this.pathTo(root, dimTable);
    // Scope rooted at the dimension table; walk the path backwards with LEFT JOINs.
    const s = this.newScope(dimTable, true);
    let cur = s.insts.get("")!;
    for (const step of path.steps.slice().reverse()) {
      const rev: Step = { rel: step.rel, dir: step.dir === "up" ? "down" : "up", from: step.to, to: step.from };
      const key = [...cur.chain, rev.rel.id + ":" + rev.dir].join("|");
      const alias = this.aliasFor(rev.to, s.aliases);
      const inst: Inst = { key, table: rev.to, alias, chain: [...cur.chain, rev.rel.id + ":" + rev.dir] };
      inst.joinSql = this.joinClause(rev, cur.alias, alias, true);
      s.insts.set(key, inst);
      s.order.push(inst);
      s.byTable.set(rev.to, key);
      cur = inst;
    }
    const dsel = this.plan.dimensions.map((d) => ({ d, ...this.dimSelect(s, d) }));
    const on = new Map<string, string[]>();
    const where = this.whereConds(s, measures, { onClause: on });
    // conditions on the dimension table itself stay in WHERE
    const rootConds = on.get("") ?? [];
    for (const inst of s.order) {
      const extra = on.get(inst.key);
      if (extra?.length) inst.joinSql += ` AND ${extra.join(" AND ")}`;
    }
    const shown = measures.filter((m) => !m.hidden);
    const msel = shown.map((m) => `${this.measureExpr(s, m, { root, left: true })} AS ${qi(m.alias)}`);
    const columns: OutputColumn[] = [
      ...dsel.flatMap((x) => x.names.map((n) => ({ name: n, label: x.d.label, role: "dimension" as const }))),
      ...shown.map((m) => ({ name: m.alias, label: m.label, role: "measure" as const, unit: unitLabel(m) })),
    ];
    const from = `FROM ${this.tableSql(dimTable)} ${s.rootAlias}${s.order.map((i) => "\n" + i.joinSql).join("")}`;
    let sql = `SELECT ${[...dsel.flatMap((x) => x.select), ...msel].join(",\n       ")}\n${from}`;
    const allWhere = [...rootConds, ...where];
    if (allWhere.length) sql += `\nWHERE ${allWhere.join("\n  AND ")}`;
    sql += `\nGROUP BY ${dsel.flatMap((x) => x.group).join(", ")}`;
    sql += this.orderLimit(dsel, measures, columns);
    return { sql, columns };
  }

  // ------------------------------------------------------------------ multiple roots (chasm trap): pre-aggregate each, then join on dimensions
  multi(groups: { root: string; measures: Measure[] }[]): { sql: string; columns: OutputColumn[] } {
    const dims = orderDims(this.plan.dimensions);
    const ctes: string[] = [];
    const names: string[] = [];
    let dimNames: string[] = [];
    let dimLabels: string[] = [];
    groups.forEach((g, gi) => {
      const s = this.newScope(g.root);
      const dsel = dims.map((d) => ({ d, ...this.dimSelect(s, d) }));
      dimNames = dsel.flatMap((x) => x.names);
      dimLabels = dsel.flatMap((x) => x.names.map(() => x.d.label));
      const msel = g.measures.filter((m) => !m.hidden).map((m) => `${this.measureExpr(s, m, { root: g.root })} AS ${qi(m.alias)}`);
      const where = this.whereConds(s, g.measures);
      const from = `FROM ${this.tableSql(g.root)} ${s.rootAlias}${s.order.map((i) => "\n" + i.joinSql).join("")}`;
      let q = `SELECT ${[...dsel.flatMap((x) => x.select), ...msel].join(", ")}\n${from}`;
      if (where.length) q += `\nWHERE ${where.join(" AND ")}`;
      if (dsel.length) q += `\nGROUP BY ${dsel.flatMap((x) => x.group).join(", ")}`;
      const name = `g${gi + 1}`;
      names.push(name);
      ctes.push(`${name} AS (\n${indent(q)}\n)`);
    });
    const measures = groups.flatMap((g) => g.measures.filter((m) => !m.hidden));
    const sel = [
      ...dimNames.map((n) => qi(n)),
      ...groups.flatMap((g, gi) => g.measures.filter((m) => !m.hidden).map((m) => `${names[gi]}.${qi(m.alias)}`)),
    ];
    let from = `FROM ${names[0]}`;
    for (let i = 1; i < names.length; i++) {
      from += dimNames.length
        ? `\nFULL JOIN ${names[i]} USING (${dimNames.map(qi).join(", ")})`
        : `\nCROSS JOIN ${names[i]}`;
    }
    const columns: OutputColumn[] = [
      ...dimNames.map((n, i) => ({ name: n, label: dimLabels[i], role: "dimension" as const })),
      ...measures.map((m) => ({ name: m.alias, label: m.label, role: "measure" as const, unit: unitLabel(m) })),
    ];
    let sql = `WITH ${ctes.join(",\n")}\nSELECT ${sel.join(", ")}\n${from}`;
    const order: string[] = [];
    const time = dims.find((d) => d.kind === "time");
    if (time) order.push(`${qi(time.alias)} ASC`);
    for (const o of this.plan.order) if (o.kind === "measure" && measures.some((m) => m.alias === o.ref)) order.push(`${qi(o.ref)} ${o.dir.toUpperCase()} NULLS LAST`);
    for (const n of dimNames) if (!order.some((x) => x.startsWith(qi(n)))) order.push(`${qi(n)} ASC`);
    if (order.length && dimNames.length) sql += `\nORDER BY ${order.join(", ")}`;
    if (this.plan.limit && dimNames.length) sql += `\nLIMIT ${this.p.add(this.plan.limit)}`;
    return this.wrapDerived(sql, columns, dims);
  }
}

export function defaultProjections(model: SchemaModel, table: string): string[] {
  const t = model.tables[table];
  const out: string[] = [];
  for (const k of t.primaryKey) out.push(`${table}.${k}`);
  // natural keys: unique, non-PII text identifiers (sku, order_number, ...)
  for (const c of t.columnOrder.map((x) => t.columns[x])) if (c.isUnique && c.kind === "text" && !c.pii && c.searchable) out.push(`${table}.${c.name}`);
  for (const d of t.display) out.push(`${table}.${d}`);
  if (t.defaultTime) out.push(`${table}.${t.defaultTime}`);
  const firstMeasure = t.columnOrder.map((c) => t.columns[c]).find((c) => c.role === "measure_additive" || (c.role === "measure_nonadditive" && c.unit?.kind === "money"));
  if (firstMeasure) out.push(`${table}.${firstMeasure.name}`);
  return [...new Set(out)].filter((r) => !t.columns[splitRef(r)[1]]?.pii);
}

function orderDims(dims: Dimension[]): Dimension[] {
  return [...dims.filter((d) => d.kind === "time"), ...dims.filter((d) => d.kind !== "time")];
}

function sharedFilters(ms: Measure[]): Predicate[] {
  const first = ms[0].filters ?? [];
  return first.filter((f) => ms.every((m) => (m.filters ?? []).some((g) => samePred(f, g))));
}

function samePred(a: Predicate, b: Predicate) {
  return a.column === b.column && a.op === b.op && JSON.stringify(a.values) === JSON.stringify(b.values);
}

function dedupePredicates(ps: Predicate[]): Predicate[] {
  const out: Predicate[] = [];
  for (const p of ps) if (!out.some((q) => samePred(p, q))) out.push(p);
  return out;
}

function unitLabel(m: Measure): string | undefined {
  if (m.kind === "count" || m.agg === "count_distinct" || m.agg === "count_rows") return undefined;
  return m.unit?.label;
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function indent(s: string) {
  return s.split("\n").map((l) => "  " + l).join("\n");
}

export function dateOnly(d: Date, tz: string): string {
  const w = wallParts(d, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}
