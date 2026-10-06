import type { ComposerConfig, ResolvedSettings } from "./config.js";
import { resolveSettings } from "./config.js";
import { schemaSlice } from "./compose/state.js";
import type { Db } from "./db/types.js";
import { analyzeJoins, type Ambiguity } from "./joins/analyze.js";
import { JoinGraph, pathOptionText } from "./joins/graph.js";
import { stem, contentTokens, STOPWORDS, US_STATES, COUNTRIES } from "./nl/lexicon.js";
import { linkValues, retrieveTables, type ValueLink } from "./nl/link.js";
import { extractSpans, MONTH_NAMES, type Span } from "./nl/spans.js";
import type { Answer, Answers, ChoiceAnswer, ChoiceQuestion, NoulQuestion, Oracle, Question, Questions, ScoreAnswer } from "./oracle/types.js";
import { averageChoices, choiceMargin, noulConfidence } from "./oracle/types.js";
import { AGGS, capitalize, humanRef, legalAggs, measureCandidates, measureFromSaved, slug, toMeasure, type MeasureCandidate } from "./plan/build.js";
import { assignSpans, jointDecode, top } from "./plan/decode.js";
import type { Agg, Decision, DerivedCalc, Dimension, Existence, Measure, Op, Predicate, QueryPlan, Shape, TimeGrain, TimeWindow } from "./plan/types.js";
import { emptyPlan } from "./plan/types.js";
import { inScope } from "./saved/store.js";
import type { SavedMeasure, SavedPlan, SavedQueryStore, SavedRecord } from "./saved/types.js";
import { buildSchemaModel } from "./schema/conventions.js";
import { introspect } from "./schema/introspect.js";
import type { ColumnModel, SchemaModel } from "./schema/model.js";
import { isMeasureRole, isTimeKind, splitRef } from "./schema/model.js";
import { compile, CompileError, type Compiled, type OutputColumn } from "./sql/compile.js";
import { narrate } from "./sql/narrative.js";
import { PERIOD_CRITERIA, PERIOD_KEYS, periodBounds, shiftYears, type DateParts, type PeriodKey, type PeriodSpec, type TimeSettings } from "./time/periods.js";

// ====================================================================== public types

export interface ComposeContext {
  user?: string;
  team?: string;
  /** Fixed "now" for deterministic runs; defaults to config time.as_of, then the clock. */
  asOf?: Date | string;
  /** The previous result in the conversation, for follow-ups ("same thing but for East"). */
  conversation?: Result;
}

export interface ClarifyOption {
  key: string;
  label: string;
  /** What choosing this option means concretely: dates, columns, join meaning. */
  consequence: string;
}

export interface Clarification {
  id: string;
  /** decision type: period, measure, measure_agg, join_path, time_column, filter, shape, coverage, ... */
  decision: string;
  question: string;
  options: ClarifyOption[];
}

export interface RoundLog {
  round: string;
  questions: number;
  ms: number;
}

export interface Result {
  id: string;
  request: string;
  outcome: "execute" | "clarify" | "decline";
  sql?: string;
  params?: unknown[];
  columns?: OutputColumn[];
  plan?: QueryPlan;
  narrative?: string;
  /** plan confidence: min over load-bearing decisions */
  confidence: number;
  clarification?: Clarification;
  /** decline reason */
  reason?: string;
  /** execute-with-banner: the runner-up reading, when it was close */
  banner?: string;
  provenance: Record<string, Decision>;
  rounds: RoundLog[];
  warnings: string[];
  /** set when the plan reused a saved plan or fragments */
  reused?: { plan?: string; measures: string[] };
}

export interface ComposerOptions {
  db: Db;
  oracle: Oracle;
  config?: ComposerConfig;
  /** Precomputed schema model (e.g. loaded from composer.lock.json). Introspected when absent. */
  model?: SchemaModel;
  store?: SavedQueryStore;
  /** Called with every round's state, questions and answers (debugging / telemetry). */
  onRound?: (e: { round: string; state: unknown; questions: Questions; answers: Answers }) => void;
}

/** Thrown by execute() when the planner's cost estimate exceeds `limits.max_cost`. */
export class QueryTooExpensiveError extends Error {
  constructor(readonly cost: number, readonly maxCost: number) {
    super(`This query is estimated to be too expensive to run (plan cost ${Math.round(cost).toLocaleString("en-US")} > limit ${maxCost.toLocaleString("en-US")}). Narrow it (a time period, a filter) or raise limits.max_cost.`);
    this.name = "QueryTooExpensiveError";
  }
}

// ====================================================================== internals

interface Session {
  id: string;
  request: string;
  ctx: ComposeContext;
  pins: Record<string, string>;
  memo: Map<string, Answer>;
  rounds: RoundLog[];
  /** probing a pinned alternative during gating: stop after compile */
  probe?: boolean;
}

type Dist = Record<string, number>;

const NUM_ROLE_FIXED = ["result_count", "time_amount", "part_of_name", "year_or_date", "none"] as const;

const FLAG_QUESTIONS: Record<string, string> = {
  is_write: "Does `request` ask to create, change, or delete data?",
  has_time_period: "Does `request` restrict results to a period of time?",
  per_group_top_n: "Does `request` ask for the top, bottom, latest or first few items *within each* group (e.g. 'top 3 products in each region', 'most recent order for each customer') rather than overall?",
  include_empty_groups: "Does `request` ask to include groups or records that have nothing to count (e.g. 'including customers with no orders', 'show zero months', 'including regions with no orders')?",
  asks_absence: "Does `request` ask for records that do NOT have some related activity (e.g. 'customers who never ordered', 'products with no sales in March', 'didn't order anything')?",
  asks_presence_only: "Does `request` ask for records that have at least one related record, without needing any detail of those related records (e.g. 'customers who bought product X', 'customers who placed orders')?",
  vs_overall_aggregate: "Does `request` compare individual values against an overall average, median, or total (e.g. 'orders above the average order value')?",
  asks_share: "Does `request` ask what fraction or percentage of a total each item represents?",
  asks_change: "Does `request` ask how a quantity changed from one period to the previous one?",
  asks_running_total: "Does `request` ask for a cumulative or running total over time?",
  asks_unique: "Does `request` ask for unique or different values only (e.g. 'which distinct cities')?",
  single_best: "Does `request` ask for exactly one top, bottom, latest or first item overall or per group (e.g. 'which customer spent the most', 'most recent order for each customer')?",
  compare_periods: "Does `request` ask to compare the same quantity across two separate time periods (e.g. 'this year vs last year', 'compared with the same period last year', 'Q3 compared to Q2')?",
};

const SHAPE_CRITERIA: Record<string, string> = {
  lookup: "A list of individual records and their details, with no totals or counts (e.g. 'show orders from Acme', 'list customers in Ohio', 'which products have never been reviewed', 'customers who placed more than 10 orders').",
  single_value: "One combined number for the whole set (e.g. 'how many orders last month', 'total revenue this year', 'how much inventory do we have').",
  breakdown: "Combined numbers shown separately for each category or group, with no restriction to the top or bottom few (e.g. 'revenue by region').",
  ranking: "Items ordered by a quantity, usually restricted to the top or bottom few (e.g. 'top 5 customers by spend', 'which product sold the least').",
  trend: "Combined numbers for each successive time period (e.g. 'monthly signups this year', 'orders per week').",
  distribution: "How values are spread across ranges or buckets (e.g. 'histogram of order sizes').",
  unsupported: "Not a request to read data: a request to create, change, or delete data, or a general question unrelated to the data.",
};

const AGG_CRITERIA: Record<Agg, string> = {
  sum: "A total or combined amount ('total revenue', 'how much was spent', 'total list price').",
  avg: "A typical or average value per record ('average order value', 'mean').",
  median: "The middle value ('median').",
  max: "The single largest or latest value ('biggest order', 'highest price').",
  min: "The single smallest or earliest value ('smallest order', 'lowest price').",
  count_rows: "How many records ('how many orders', 'number of').",
  count_distinct: "How many different things ('how many customers placed orders', 'unique').",
};

const DERIVED_CRITERIA: Record<"none" | DerivedCalc, string> = {
  none: "No extra calculation.",
  share_of_total: "Each item's fraction or percentage of the overall total ('share', '% of total', 'proportion').",
  running_total: "A cumulative total that adds up over time ('running total', 'cumulative').",
  change_vs_previous: "The difference from the previous period ('change from last month', 'increase').",
  pct_change_vs_previous: "The percentage difference from the previous period ('growth rate', '% change', 'month over month', 'growth').",
  rank: "Each item's position in an ordering ('rank', 'ranking position').",
  moving_average: "An average over a sliding window of recent periods ('rolling average', '7-day average').",
};

const GRAIN_CRITERIA: Record<"none" | TimeGrain, string> = {
  none: "Results are not split by time period.",
  hour: "Each hour ('hourly').",
  day: "Each day ('daily', 'per day').",
  week: "Each week ('weekly', 'per week').",
  month: "Each month ('monthly', 'by month', 'per month', 'each month').",
  quarter: "Each quarter ('quarterly').",
  year: "Each year ('yearly', 'annual', 'by year').",
};

const SORT_CRITERIA = {
  high_first: "Largest or most first ('top', 'most', 'highest', 'best', 'biggest').",
  low_first: "Smallest or least first ('bottom', 'least', 'lowest', 'worst', 'fewest').",
  newest_first: "Most recent first ('latest', 'most recent', 'newest').",
  oldest_first: "Earliest first ('earliest', 'oldest', 'first').",
  alphabetical: "Alphabetical order.",
  unspecified: "No direction is stated.",
};

const OP_CRITERIA = {
  gt: "Strictly greater ('more than', 'over', 'above', 'exceeding').",
  gte: "Greater or equal ('at least', 'or more', 'minimum of').",
  lt: "Strictly less ('less than', 'under', 'below', 'fewer than', 'cost less than').",
  lte: "Less or equal ('at most', 'or less', 'up to', 'no more than').",
  eq: "Exactly equal ('exactly', 'equal to', 'of').",
  between_low: "The lower end of a range ('between 100 and 500': 100).",
  between_high: "The upper end of a range ('between 100 and 500': 500).",
};

const NULL_TRIGGER = /\b(missing|empty|blank|null|without|no\s+\w+|unknown|un[a-z]+ed|not set|lacking|none|not (yet )?(been )?[a-z]+(ed|en)|yet to|still open|outstanding)\b/i;

const choice = (instructions: ChoiceQuestion["instructions"], criteria: Record<string, string>): ChoiceQuestion => ({ type: "choice", instructions, criteria });
const noul = (instructions: NoulQuestion["instructions"], criteria?: NoulQuestion["criteria"]): NoulQuestion => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });
const qkey = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 120);

function dist(a: Answer | undefined): Dist {
  if (!a) return {};
  if (a.type === "noul") return { true: a.noul, false: 1 - a.noul };
  return a.probabilities;
}
function argmax(d: Dist, exclude: string[] = []): string | undefined {
  let best: string | undefined;
  for (const [k, v] of Object.entries(d)) if (!exclude.includes(k) && (best === undefined || v > d[best])) best = k;
  return best;
}
function yes(a: Answer | undefined, t = 0.5): boolean {
  return !!a && a.type === "noul" && a.noul > t;
}
function pYes(a: Answer | undefined): number {
  return a && a.type === "noul" ? a.noul : 0;
}

let counter = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}`;

// ====================================================================== Composer

export class Composer {
  readonly settings: ResolvedSettings;
  readonly graph: JoinGraph;
  private sessions = new Map<string, Session>();
  private readonly vocab: Set<string>;

  private constructor(
    readonly db: Db,
    readonly oracle: Oracle,
    readonly model: SchemaModel,
    readonly config: ComposerConfig,
    readonly store: SavedQueryStore | undefined,
    private readonly onRound?: ComposerOptions["onRound"],
  ) {
    this.settings = resolveSettings(config);
    this.graph = new JoinGraph(model);
    this.vocab = schemaVocabulary(model);
  }

  /** Introspect the database (unless a model is given) and build a composer. */
  static async create(opts: ComposerOptions): Promise<Composer> {
    const cfg = opts.config ?? {};
    const model =
      opts.model ??
      buildSchemaModel(
        await introspect(opts.db, {
          schemas: cfg.database?.schemas,
          excludeTables: cfg.database?.exclude_tables,
          sampleWhenNoStats: cfg.introspection?.sample_when_no_stats,
          checkDurationOrder: cfg.introspection?.check_duration_order,
        }),
        cfg,
      );
    return new Composer(opts.db, opts.oracle, model, cfg, opts.store, opts.onRound);
  }

  /** Compose a request into SQL, a clarifying question, or a decline (spec §2B interface). */
  async compose(request: string, ctx: ComposeContext = {}): Promise<Result> {
    const s: Session = { id: newId("s"), request: request.trim(), ctx, pins: {}, memo: new Map(), rounds: [] };
    return this.run(s);
  }

  /** Answer a clarification; only that decision changes, the rest of the plan is reused. */
  async answer(clarificationId: string, optionKey: string): Promise<Result> {
    const s = this.sessions.get(clarificationId);
    if (!s) throw new Error(`unknown clarification ${clarificationId}`);
    const decision = s.pins.__pending;
    if (!decision) throw new Error("clarification already answered");
    delete s.pins.__pending;
    s.pins[decision] = optionKey;
    s.rounds = [];
    return this.run(s);
  }

  /** Accept a result: store it as a saved plan, plus a measure fragment when the measure was clarified or carries row filters. */
  async accept(result: Result, opts: { scope?: "user" | "team" | "org"; user?: string; team?: string; name?: string; status?: "accepted" | "canonical" } = {}): Promise<SavedRecord[]> {
    if (result.outcome !== "execute" || !result.plan) throw new Error("only executed results can be accepted");
    const scope = opts.scope ?? "user";
    const owner = scope === "user" ? opts.user : scope === "team" ? opts.team : undefined;
    const base = { scope, owner, status: opts.status ?? ("accepted" as const), acceptedBy: opts.user ?? "unknown", acceptedAt: new Date().toISOString(), narrative: result.narrative ?? "" };
    const fingerprint = this.fingerprintPlan(result.plan);
    const out: SavedRecord[] = [];
    const clarifiedMeasure = Object.values(result.provenance).some((d) => d.about === "measure" && d.by === "user");
    for (const m of result.plan.measures) {
      if (m.saved || !(clarifiedMeasure || m.filters?.length) || !opts.name) continue;
      const rec: SavedMeasure = {
        ...base,
        id: newId("m"),
        kind: "measure",
        name: opts.name,
        phrases: [opts.name],
        definition: { agg: m.agg, column: m.column, duration: m.duration, count: m.kind === "count" ? m.table : undefined, unit: m.unit?.divisor === 100 ? "cents" : undefined, row_filters: (m.filters ?? []).map((f) => ({ column: f.column, op: f.op, values: f.values })) },
        narrative: `${capitalize(opts.name)}: ${m.label}`,
        fingerprint,
      };
      out.push(rec);
    }
    const pinned: Record<string, string> = {};
    for (const [k, d] of Object.entries(result.provenance)) if (d.by === "user") pinned[k] = String(d.value);
    const plan: SavedPlan = {
      ...base,
      id: newId("p"),
      kind: "plan",
      name: opts.name,
      request: result.request,
      plan: result.plan,
      slots: [
        ...(result.plan.timeWindow ? [{ path: "timeWindow.period", kind: "period" as const }] : []),
        { path: "filters", kind: "filter_list" as const },
        ...(result.plan.limit !== undefined ? [{ path: "limit", kind: "limit" as const }] : []),
      ],
      pinned,
      fingerprint,
    };
    out.push(plan);
    for (const r of out) await this.store?.put(r);
    return out;
  }

  /** Run a result's SQL read-only with a statement timeout (spec §7 guardrails). */
  async execute(result: Result): Promise<{ columns: OutputColumn[]; rows: Record<string, unknown>[] }> {
    if (result.outcome !== "execute" || !result.sql) throw new Error(`cannot execute a ${result.outcome} result`);
    // Cost ceiling (spec §7). statement_timeout alone is not enough: PGlite (in-process WASM)
    // does not enforce it, and a runaway query there blocks the whole process.
    if (this.settings.maxCost > 0) {
      const cost = await this.planCost(result.sql, result.params ?? []);
      if (cost !== undefined && cost > this.settings.maxCost) throw new QueryTooExpensiveError(cost, this.settings.maxCost);
    }
    const run = async (db: Db) => (await db.query<Record<string, unknown>>(result.sql!, result.params)).rows;
    const rows = this.db.readOnly ? await this.db.readOnly(run, { statementTimeoutMs: this.settings.statementTimeoutMs }) : await run(this.db);
    return { columns: result.columns ?? [], rows };
  }

  /** EXPLAIN total cost of a statement, or undefined when EXPLAIN is unavailable. */
  async planCost(sql: string, params: unknown[]): Promise<number | undefined> {
    try {
      const r = await this.db.query<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      let plan = Object.values(r.rows[0] ?? {})[0] as unknown;
      if (typeof plan === "string") plan = JSON.parse(plan);
      const cost = (plan as { Plan?: { "Total Cost"?: number } }[])?.[0]?.Plan?.["Total Cost"];
      return typeof cost === "number" ? cost : undefined;
    } catch {
      return undefined;
    }
  }

  /** compose() then execute() when the outcome is execute. */
  async ask(request: string, ctx?: ComposeContext) {
    const result = await this.compose(request, ctx);
    const data = result.outcome === "execute" ? await this.execute(result) : undefined;
    return { result, data };
  }

  /** Mark saved plans whose fingerprinted columns changed as stale (spec §2B drift). */
  async refreshSaved(): Promise<{ stale: string[] }> {
    const stale: string[] = [];
    for (const r of (await this.store?.all()) ?? []) {
      if (r.status === "stale" || r.status === "deprecated") continue;
      if (!this.fingerprintValid(r)) {
        await this.store!.setStatus(r.id, "stale");
        stale.push(r.id);
      }
    }
    return { stale };
  }

  // ==================================================================== pipeline

  private timeSettings(ctx: ComposeContext): TimeSettings {
    const asOf = ctx.asOf ? new Date(ctx.asOf) : this.config.time?.as_of ? new Date(this.config.time.as_of) : new Date();
    return { asOf, timezone: this.settings.timezone, weekStart: this.settings.weekStart };
  }

  private async ask_(s: Session, round: string, state: unknown, qs: Questions): Promise<Answers> {
    const out: Answers = {};
    const missing: Questions = {};
    const keyOf = (id: string, q: Question) => `${JSON.stringify(state)}|${id}|${JSON.stringify(q)}`;
    for (const [id, q] of Object.entries(qs)) {
      const hit = s.memo.get(keyOf(id, q));
      if (hit) out[id] = hit;
      else missing[id] = q;
    }
    const n = Object.keys(missing).length;
    if (n) {
      const t0 = Date.now();
      const a = await this.oracle.ask(state, missing, { round });
      for (const [id, ans] of Object.entries(a)) {
        out[id] = ans;
        s.memo.set(keyOf(id, missing[id]), ans);
      }
      s.rounds.push({ round, questions: n, ms: Date.now() - t0 });
      this.onRound?.({ round, state, questions: missing, answers: a });
    }
    return out;
  }

  private async run(s: Session): Promise<Result> {
    const model = this.model;
    const ts = this.timeSettings(s.ctx);
    const request = s.request;
    const provenance: Record<string, Decision> = {};
    const warnings: string[] = [];
    const decide = (key: string, d: Omit<Decision, "question"> & { question?: string }) => (provenance[key] = { question: d.question ?? key, ...d });
    const pin = (k: string) => s.pins[k];

    // ---------------------------------------------------------------- pre-Jev candidate generation (code)
    const spans = extractSpans(request);
    const allTables = Object.keys(model.tables).filter((t) => !model.tables[t].hidden);
    const prelim = await linkValues(request, spans, model, undefined, allTables);
    const retrieved = retrieveTables(request, model, prelim, 8);
    const relevant = allTables.length <= 25 ? allTables : [...new Set([...retrieved.map((r) => r.table), ...prelim.map((l) => splitRef(l.column)[0])])];
    const links = await linkValues(request, spans, model, this.db, relevant);
    const savedMeasures = ((await this.store?.search({ text: request, kind: "measure", user: s.ctx.user, team: s.ctx.team, k: 6 })) ?? []).filter((r): r is SavedMeasure => r.kind === "measure" && this.fingerprintValid(r));
    const state = { request, schema: schemaSlice(model, relevant, links) };

    // ---------------------------------------------------------------- R0: follow-up and saved-plan match
    let base: QueryPlan | undefined;
    let reusedPlan: string | undefined;
    const r0: Questions = {};
    const prev = s.ctx.conversation;
    if (prev?.plan && prev.outcome === "execute") {
      r0.follow_up = noul({ previous_request: prev.request, previous_answer: prev.narrative, question: "Does `request` continue or modify `previous_request` (e.g. 'same thing but …', 'now for …', 'what about …') rather than ask something new?" });
    }
    const savedPlans = ((await this.store?.search({ text: request, kind: "plan", user: s.ctx.user, team: s.ctx.team, k: 5 })) ?? []).filter((r): r is SavedPlan => r.kind === "plan" && this.fingerprintValid(r));
    if (savedPlans.length) {
      const crit: Record<string, string> = {};
      savedPlans.forEach((p, i) => (crit[`plan_${i}`] = p.narrative || p.request));
      crit.none = "None of these asks for the same thing.";
      r0.saved_plan = choice("Which saved question asks for the same thing as `request`, ignoring differences in dates, names, numbers, and added filters?", crit);
    }
    const a0 = Object.keys(r0).length ? await this.ask_(s, "R0", { request }, r0) : {};
    if (yes(a0.follow_up, 0.5)) {
      base = structuredClone(prev!.plan!);
      reusedPlan = prev!.reused?.plan;
      decide("follow_up", { about: "follow_up", value: true, confidence: noulConfidence(pYes(a0.follow_up)), answer: a0.follow_up, loadBearing: true, by: "oracle" });
    } else if (a0.saved_plan?.type === "choice" && a0.saved_plan.choice !== "none" && a0.saved_plan.confidence >= 0.5) {
      const sp = savedPlans[Number(a0.saved_plan.choice.split("_")[1])];
      base = structuredClone(sp.plan);
      reusedPlan = sp.id;
      for (const [k, v] of Object.entries(sp.pinned)) s.pins[k] ??= v;
      decide("saved_plan", { about: "saved_plan", value: sp.id, confidence: a0.saved_plan.confidence, answer: a0.saved_plan, loadBearing: true, by: "oracle" });
    }

    // ---------------------------------------------------------------- R1: broad speculative fan-out
    const R: Questions = {};
    const meta = this.buildR1(R, { request, spans, links, relevant, savedMeasures, base });
    const a1 = await this.ask_(s, "R1", state, R);

    // R1b: option-order debiasing (§8.3) — re-ask low-margin load-bearing choices with
    // reversed options and average the two distributions.
    const rotate: Questions = {};
    for (const [id, q] of Object.entries(R)) {
      const a = a1[id];
      if (q.type !== "choice" || a?.type !== "choice" || !/^(shape|measure_quantity|measure_agg|period|subject|filter_|role_|textcol_|time_grain|derived)/.test(id)) continue;
      if (choiceMargin(a) >= this.settings.marginReask || Object.keys(q.criteria).length < 2) continue;
      rotate[`${id}__rev`] = { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).reverse()) };
    }
    if (Object.keys(rotate).length) {
      const ar = await this.ask_(s, "R1b", state, rotate);
      for (const [rid, a] of Object.entries(ar)) {
        const id = rid.replace(/__rev$/, "");
        if (a.type === "choice" && a1[id]?.type === "choice") a1[id] = averageChoices(a1[id] as ChoiceAnswer, a);
      }
    }

    // ---------------------------------------------------------------- decode R1
    const d = this.decodeR1({ s, a1, meta, spans, links, ts, base, decide, warnings });
    if ("outcome" in d) return this.finish(s, d, provenance, warnings);
    const { plan } = d;

    // ---------------------------------------------------------------- R2: dependent decisions
    const r2 = await this.round2(s, state, plan, d, meta, a1, ts, decide);
    if (r2) return this.finish(s, r2, provenance, warnings);

    // conventions that depend on final shape
    this.applyConventions(plan);
    await this.applyHierarchy(plan);

    // forced clarification: status value vs related rows (F06 pattern; "conflicts are shown")
    const conflict = this.statusConflict(plan, s.pins);
    if (conflict) return this.finish(s, conflict, provenance, warnings);

    // ---------------------------------------------------------------- compile
    let compiled: Compiled;
    try {
      compiled = compile(plan, model, this.settings, this.graph);
    } catch (e) {
      if (e instanceof CompileError && s.probe) return this.finish(s, { outcome: "decline", reason: `illegal: ${e.message}` }, provenance, warnings);
      if (e instanceof CompileError) return this.finish(s, this.clarifyFromCompile(s, e, plan), provenance, warnings);
      throw e;
    }
    const narrative = narrate(plan, model);

    // ---------------------------------------------------------------- gating on load-bearing decisions
    // (before R3: a specific "which X?" beats a generic coverage question, and saves a round)
    if (s.probe) return this.finish(s, { outcome: "execute", plan, sql: compiled.sql }, provenance, warnings);
    const gate = await this.gate(s, provenance, plan, narrative);
    if (gate) return this.finish(s, gate, provenance, warnings);
    if (Object.entries(s.pins).some(([k, v]) => k.startsWith("coverage:") && v === "rephrase")) {
      return this.finish(s, { outcome: "decline", reason: "The request uses terms the composer cannot map to the data yet; please rephrase." }, provenance, warnings);
    }

    // ---------------------------------------------------------------- R3: verification
    // only phrases no other span already accounts for (time, numbers, linked values, names)
    const usedSources = new Set([...plan.filters, ...plan.existence.flatMap((e) => e.filters)].map((f) => f.source));
    const usedLinks = links.filter((l) => usedSources.has(l.id));
    const handled = [
      ...spans.filter((x) => x.type === "relative_time" || x.type === "explicit_date" || (x.type === "number" && provenance[`role_${x.id}`]?.value !== "none")),
      ...spans.filter((x) => (x.type === "proper_noun" || x.type === "quoted") && (usedSources.has(x.id) || usedLinks.some((l) => l.start < x.end && l.end > x.start))),
      ...usedLinks.map((l) => ({ start: l.start, end: l.end })),
    ];
    const phrases = spans
      .filter((x) => x.type === "content_phrase")
      .map((x) => {
        const words = [...x.text.matchAll(/[A-Za-z][A-Za-z'-]*/g)].filter(
          (m) => !TIME_WORDS.has(m[0].toLowerCase()) && !handled.some((h) => x.start + m.index! < h.end && x.start + m.index! + m[0].length > h.start),
        );
        return { ...x, text: words.map((m) => m[0]).join(" ") };
      })
      .filter((x) => x.text && contentTokens(x.text).some((t) => !TIME_WORDS.has(t)));
    const r3: Questions = {
      agreement: { type: "score", instructions: "How well does `plan_summary` answer `request`?", criteria: ["It answers a different question.", "It answers part of the request, or adds conditions the request did not ask for.", "It answers the request with a minor difference in interpretation.", "It answers exactly what the request asks."] },
      extra_condition: noul("Does `plan_summary` contain a restriction or calculation that `request` did not ask for? Ignore conditions marked as coming from a saved definition or a convention (in parentheses)."),
    };
    phrases.forEach((p, i) => (r3[`covered_${i}`] = noul({ phrase: p.text, question: "Is `phrase` from `request` reflected in `plan_summary` (directly, as a synonym, or as the thing being listed/counted)?" })));
    const a3 = await this.ask_(s, "R3", { request, plan_summary: narrative }, r3);
    const agreement = a3.agreement as ScoreAnswer | undefined;
    if (agreement) decide("agreement", { about: "verification", value: agreement.score, confidence: agreement.confidence, answer: agreement, loadBearing: false, by: "oracle" });
    const uncovered = phrases.map((p, i) => ({ p, a: a3[`covered_${i}`] })).filter((x) => x.a && x.a.type === "noul" && x.a.noul < 0.3 && !pin(`coverage:${x.p.text.toLowerCase()}`));
    // once the user has defined the measure in a clarification, the business term they used
    // ("revenue") is covered by that definition: report it, don't ask again
    const userDefinedMeasure = provenance.measure?.by === "user";
    if (uncovered.length && userDefinedMeasure) warnings.push(`not reflected in the description: ${uncovered.map((u) => u.p.text).join(", ")}`);
    if (uncovered.length && !userDefinedMeasure) {
      const u = uncovered[0];
      const id = newId("c");
      s.pins.__pending = `coverage:${u.p.text.toLowerCase()}`;
      this.sessions.set(id, s);
      return this.finish(s, {
        outcome: "clarify",
        plan,
        narrative,
        clarification: {
          id,
          decision: "coverage",
          question: `I couldn't connect "${u.p.text}" to anything in the data. Here is what I can answer: ${narrative} Is that what you want?`,
          options: [
            { key: "ignore", label: "Yes, run it", consequence: narrative },
            { key: "rephrase", label: "No, I'll rephrase", consequence: `"${u.p.text}" needs a column or saved definition the composer does not know yet.` },
          ],
        },
      }, provenance, warnings);
    }
    const confidence = planConfidence(provenance);
    return this.finish(s, {
      outcome: "execute",
      sql: compiled.sql,
      params: compiled.params,
      columns: compiled.columns,
      plan,
      narrative,
      confidence,
      banner: agreement && agreement.score < 2 ? "This answer may differ slightly from what you asked; check the description." : undefined,
      reused: { plan: reusedPlan, measures: plan.measures.filter((m) => m.saved).map((m) => m.saved!) },
    }, provenance, warnings);
  }

  private finish(s: Session, r: Partial<Result> & { outcome: Result["outcome"] }, provenance: Record<string, Decision>, warnings: string[]): Result {
    return {
      id: newId("r"),
      request: s.request,
      confidence: r.confidence ?? planConfidence(provenance),
      provenance,
      rounds: s.rounds.slice(),
      warnings,
      ...r,
    } as Result;
  }

  // ==================================================================== R1 builder

  private buildR1(R: Questions, x: { request: string; spans: Span[]; links: ValueLink[]; relevant: string[]; savedMeasures: SavedMeasure[]; base?: QueryPlan }) {
    const model = this.model;
    const { spans, links, relevant, savedMeasures, base } = x;
    const slotOnly = !!base; // after a plan match or follow-up only slot questions are asked

    if (!slotOnly) {
      R.shape = choice("What kind of answer does `request` ask for?", SHAPE_CRITERIA);
      R.specificity = { type: "score", instructions: "How completely does `request` say what should be computed and about what?", criteria: ["It is unclear what quantity or records are wanted.", "The general topic is clear but a key part is missing (what to measure, or what to measure it about).", "What to compute and what to compute it about are both clear."] };
    }
    for (const [k, ins] of Object.entries(FLAG_QUESTIONS)) if (!slotOnly || k === "has_time_period" || k === "is_write") R[`flag_${k}`] = noul(ins);

    // subject
    const entityTables = relevant.filter((t) => !model.tables[t].junction);
    if (!slotOnly) {
      const crit: Record<string, string> = {};
      for (const t of entityTables) crit[t] = `${capitalize(model.tables[t].humanName)}${model.tables[t].synonyms.length ? ` (also called ${model.tables[t].synonyms.filter((y) => y !== model.tables[t].humanName).slice(0, 4).join(", ")})` : ""}: ${model.tables[t].description}`;
      crit.none = "The request does not list or count records; it asks for a total or average of an amount.";
      R.subject = choice("Which kind of record does `request` list or count?", crit);
    }

    // measures
    const cands = measureCandidates(model, relevant, savedMeasures);
    const candByKey = new Map(cands.map((c) => [c.key, c]));
    const alsoQ: Record<string, string> = {};
    if (!slotOnly) {
      const crit: Record<string, string> = {};
      for (const c of cands) crit[c.key] = c.description;
      crit.none = "No quantity is computed; the request only lists records.";
      R.measure_quantity = choice("Which quantity does `request` ask to compute?", crit);
      R.measure_agg = choice("How does `request` ask for the quantity to be combined across records?", AGG_CRITERIA);
      cands.forEach((c, i) => {
        if (c.kind === "count" && !/how many|number|count|\bmost\b|fewest|least/i.test(x.request)) return;
        const id = `also_${i}`;
        alsoQ[id] = c.key;
        R[id] = noul({ quantity: c.description, question: "Besides its main quantity, does `request` also ask for `quantity`?" });
      });
    }

    // projections for lookups (non-default columns of relevant tables)
    const showQ: Record<string, string> = {};
    if (!slotOnly) {
      let i = 0;
      for (const t of entityTables) {
        for (const c of Object.values(model.tables[t].columns)) {
          if (c.hidden || c.role === "identifier" || c.role === "foreign_key" || c.role === "timestamp_audit" || c.role === "json" || c.role === "soft_delete" || c.role === "free_text") continue;
          const id = `show_${i++}`;
          showQ[id] = `${t}.${c.name}`;
          R[id] = noul(
            { column: { table: t, name: c.name, description: c.description }, question: "Does `request` ask to see `column` in the results?" },
            { true: "The request names this attribute as something to display or include.", false: "The attribute is not mentioned, or is only used to narrow down which records are shown." },
          );
        }
      }
    }

    // dimensions
    const dimQ: Record<string, Dimension> = {};
    if (!slotOnly) {
      let i = 0;
      for (const t of entityTables) {
        const tm = model.tables[t];
        dimQ[`group_${i}`] = { alias: slug(tm.noun), label: tm.noun, kind: "entity", table: t };
        R[`group_${i++}`] = noul(
          { attribute: { entity: tm.noun, also_called: tm.synonyms.filter((y) => y !== tm.noun && y !== tm.humanName), description: tm.description }, question: "Does `request` ask for results shown separately for each `attribute` (each individual one)?" },
          { true: `Phrases like 'by ${tm.noun}', 'per ${tm.noun}', 'for each ${tm.noun}', 'top ${tm.humanName}', 'which ${tm.noun}'.`, false: "The entity only narrows results, is the thing being counted, or is not mentioned." },
        );
        for (const c of Object.values(tm.columns)) {
          if (c.hidden || tm.display.includes(c.name)) continue;
          const altKey = c.isUnique && tm.display.length > 0 && !tm.display.includes(c.name);
          const ok = !altKey && (c.role === "dimension_categorical" || c.role === "boolean_flag" || (c.role === "dimension_text" && !c.pii && (c.nDistinct ?? 1e9) <= 5000) || (c.role === "attribute" && c.kind === "number" && /year/.test(c.name)));
          if (!ok) continue;
          const id = `group_${i++}`;
          dimQ[id] = { alias: slug(c.name), label: `${tm.noun} ${c.humanName}`, kind: "column", column: `${t}.${c.name}`, table: t };
          R[id] = noul(
            { attribute: { table: t, name: c.name, description: c.description, ...(c.values && c.values.length <= 12 ? { values: c.values } : {}) }, question: "Does `request` ask for results shown separately for each value of `attribute`?" },
            { true: `Phrases like 'by ${c.humanName}', 'per ${c.humanName}', 'for each ${c.humanName}', 'broken down by', 'top ${c.humanName}s'.`, false: "The attribute only narrows results to particular values (e.g. 'in the X category'), or is not mentioned." },
          );
        }
      }
      R.time_grain = choice("Does `request` ask for results for each time period, and if so how long is each period?", GRAIN_CRITERIA);
    }

    R.period = choice("Which time period does `request` restrict results to?", PERIOD_CRITERIA);
    const dateSpans = spans.filter((sp) => sp.type === "explicit_date");
    for (const sp of dateSpans) {
      R[`date_role_${sp.id}`] = choice({ span: sp.text, question: "In `request`, what part does the date `span` play?" }, {
        start: "The start of a date range, or the single period asked about ('in March', 'since March', 'from March').",
        end: "The end of a date range ('to April', 'until April').",
        before: "A cutoff: results before this date.",
        not_a_period: "It is not a time restriction (e.g. part of a name).",
      });
    }

    // number spans: role + operator
    const numSpans = spans.filter((sp) => sp.type === "number");
    const roleTargets: Record<string, Record<string, string>> = {};
    const thresholdCrit: Record<string, string> = {};
    for (const c of cands) {
      if (c.kind === "column") {
        const cm = model.tables[c.table].columns[splitRef(c.column!)[1]];
        thresholdCrit[`threshold:col:${c.column}`] = `A limit on each individual ${model.tables[c.table].noun}'s ${cm.humanName}${cm.unit?.kind === "money" ? " (money)" : cm.unit?.kind === "duration" ? " (how long it lasts, e.g. 'longer than 10 minutes')" : ""}.`;
        if (cm.role === "measure_additive") thresholdCrit[`threshold:sum:${c.column}`] = `A limit on the total ${cm.humanName} summed over many ${model.tables[c.table].humanName} for each group ('sold more than 50 units', 'over $100,000 in sales').`;
      } else if (c.kind === "count") thresholdCrit[`threshold:count:${c.table}`] = `A limit on how many ${model.tables[c.table].humanName} something has ('more than 5 ${model.tables[c.table].humanName}', 'at least 3 different ${model.tables[c.table].humanName}').`;
      else if (c.kind === "saved") thresholdCrit[`threshold:saved:${c.saved!.name}`] = `A limit on ${c.saved!.name}.`;
    }
    for (const sp of numSpans) {
      const crit: Record<string, string> = {
        result_count: "How many results to show ('top 5', 'first 10', 'the 20 most recent').",
        time_amount: "The length of a time window ending now ('last 5 days', 'past 8 weeks') — not a limit on how long something lasts.",
        ...thresholdCrit,
        part_of_name: "Part of a name, code, or identifier ('Store 5', 'SKU 5512').",
        year_or_date: "Part of a date or a year ('2025', 'March 5').",
        none: "None of the above.",
      };
      roleTargets[sp.id] = crit;
      R[`role_${sp.id}`] = choice({ span: sp.text, question: "In `request`, what does the number `span` refer to?" }, crit);
      R[`op_${sp.id}`] = choice({ span: sp.text, question: "In `request`, how are values compared to `span`?" }, OP_CRITERIA);
    }

    // value-linked filters
    for (const l of links) {
      const [t, c] = splitRef(l.column);
      const cm = model.tables[t].columns[c];
      R[`filter_${l.id}`] = choice(
        { candidate: { attribute: `${model.tables[t].noun} ${cm.humanName}`, value: l.value, matched_text: l.matchedText }, question: "How does `request` use `candidate.attribute` being `candidate.value`?" },
        {
          keep_only: "Results are limited to records where the attribute has this value (e.g. 'refunded orders', 'only refunded', 'in the West region').",
          exclude: "Records with this value are removed (e.g. 'excluding refunded', 'not refunded', 'other than refunded').",
          not_a_condition: "The words do not restrict results by this attribute (they mean something else, are part of a longer name, or the match is coincidental).",
        },
      );
    }

    // unlinked text spans (quoted / proper nouns without an exact value hit)
    const textQ: Record<string, { span: Span; cols: string[] }> = {};
    for (const sp of spans.filter((y) => y.type === "quoted" || y.type === "proper_noun")) {
      if (links.some((l) => l.sim === 1 && l.start <= sp.start && l.end >= sp.end)) continue;
      const cols = links.filter((l) => l.via === "search" && l.start === sp.start).map((l) => l.column);
      const searchable = [...new Set([...cols, ...relevant.flatMap((t) => Object.values(model.tables[t].columns).filter((c) => c.searchable && !c.pii && c.kind === "text").map((c) => `${t}.${c.name}`))])];
      if (!searchable.length) continue;
      const crit: Record<string, string> = {};
      for (const ref of searchable) crit[ref] = capitalize(humanRef(model, ref)) + ".";
      crit.none = "It is not a value of any listed attribute.";
      textQ[sp.id] = { span: sp, cols: searchable };
      R[`textcol_${sp.id}`] = choice({ span: sp.text, question: "In `request`, `span` is a value of which attribute?" }, crit);
      R[`textmode_${sp.id}`] = choice({ span: sp.text, question: "Does `request` ask for an exact match of `span`, or for values that contain or start with it?" }, {
        exact: "The value is exactly this (a full name or code).",
        contains: "The value includes this text somewhere ('containing', 'with Acme in the name', or a partial name).",
        starts_with: "The value begins with this text ('starting with', 'beginning with').",
      });
    }

    // null checks and boolean flags
    const nullQ: Record<string, string> = {};
    const boolQ: Record<string, string> = {};
    let ni = 0, bi = 0;
    for (const t of entityTables) {
      for (const c of Object.values(model.tables[t].columns)) {
        if (c.hidden) continue;
        if (c.nullable && NULL_TRIGGER.test(x.request) && c.role !== "soft_delete" && c.role !== "free_text" && !(c.role === "foreign_key" && !model.relationships.some((r) => r.from.table === t && r.from.columns[0] === c.name && r.role))) {
          const id = `null_${ni++}`;
          nullQ[id] = `${t}.${c.name}`;
          R[id] = noul({ attribute: `${model.tables[t].noun} ${c.humanName}`, column: c.humanName, question: "Does `request` ask for records where `attribute` is missing or empty (e.g. 'unassigned' for 'assigned to', 'no coupon' for 'coupon code')?" });
        }
        if (c.role === "boolean_flag") {
          const id = `bool_${bi++}`;
          boolQ[id] = `${t}.${c.name}`;
          R[id] = choice({ attribute: `${model.tables[t].noun} ${c.humanName}`, question: "Does `request` restrict results by whether `attribute` is true?" }, {
            keep_true: "Only records where it is true (e.g. 'active products', 'customers who opted in').",
            keep_false: "Only records where it is false (e.g. 'inactive products', 'not opted in').",
            not_a_condition: "It does not restrict results.",
          });
        }
      }
    }

    if (!slotOnly) {
      R.sort_dir = choice("In which direction does `request` ask the results to be ordered?", SORT_CRITERIA);
      R.derived = choice("Besides the quantity itself, what extra calculation does `request` ask for?", DERIVED_CRITERIA);
    }

    return { cands, candByKey, alsoQ, showQ, dimQ, roleTargets, textQ, nullQ, boolQ, dateSpans, numSpans };
  }

  // ==================================================================== decode R1

  private decodeR1(x: {
    s: Session; a1: Answers; meta: ReturnType<Composer["buildR1"]>; spans: Span[]; links: ValueLink[]; ts: TimeSettings; base?: QueryPlan;
    decide: (k: string, d: Omit<Decision, "question"> & { question?: string }) => void; warnings: string[];
  }): { plan: QueryPlan; timeCandidates: string[]; existenceWanted: { absent: number; present: number }; perGroup: boolean; singleBest: boolean; sortDir: string; grain?: TimeGrain; periodSpec?: PeriodSpec; overall: boolean } | (Partial<Result> & { outcome: Result["outcome"] }) {
    const { s, a1, meta, spans, links, ts, base, decide } = x;
    const model = this.model;
    const pins = s.pins;
    const flag = (k: string) => pYes(a1[`flag_${k}`]);

    // decline: writes / unsupported
    if (flag("is_write") > 0.5) {
      decide("is_write", { about: "shape", value: true, confidence: noulConfidence(flag("is_write")), answer: a1.flag_is_write, loadBearing: true, by: "oracle" });
      return { outcome: "decline", reason: "The request asks to change data; only read-only questions are supported." };
    }

    // ------------------------------------------------ shape
    let shape: Shape;
    if (base) shape = base.shape;
    else {
      const sd = dist(a1.shape);
      const pinned = pins.shape as Shape | undefined;
      const choiceKey = pinned ?? argmax(sd);
      if (choiceKey === "unsupported" && !pinned) {
        return { outcome: "decline", reason: "The request is not a question about this data." };
      }
      shape = (choiceKey as Shape) ?? "single_value";
      // "the 20 most recent orders": ordering by time is a lookup, not a ranking by a quantity
      const sortTop = argmax(dist(a1.sort_dir));
      let byCode = false;
      if (!pinned && shape === "ranking" && (sortTop === "newest_first" || sortTop === "oldest_first") && (sd.lookup ?? 0) >= 0.25) {
        shape = "lookup";
        byCode = true;
        decide("shape", { about: "shape", value: shape, confidence: (sd.lookup ?? 0) + (sd.ranking ?? 0), answer: a1.shape, loadBearing: true, by: "code" });
      }
      if (shape === "distribution") {
        return { outcome: "decline", reason: "Distributions (histograms) are not supported in v1." };
      }
      if (!byCode) decide("shape", { about: "shape", value: shape, confidence: pinned ? 1 : (a1.shape as ChoiceAnswer).confidence, answer: a1.shape, loadBearing: true, by: pinned ? "user" : "oracle" });
    }

    const plan: QueryPlan = base ? { ...structuredClone(base) } : emptyPlan();
    plan.shape = shape;

    // ------------------------------------------------ number spans → roles (Hungarian)
    const probs: Record<string, Dist> = {};
    for (const sp of meta.numSpans) probs[sp.id] = { ...dist(a1[`role_${sp.id}`]) };
    // year-like numbers next to no other role are dates; code knows this deterministically
    for (const sp of meta.numSpans) if (sp.yearLike) probs[sp.id] = { year_or_date: 0.95, none: 0.05 };
    for (const sp of meta.numSpans) if (pins[`role:${sp.id}`]) probs[sp.id] = { [pins[`role:${sp.id}`]]: 1, none: 1e-6 };
    const assign = assignSpans(meta.numSpans.map((sp) => sp.id), probs, (r) => r.startsWith("threshold:") || r === "year_or_date" || r === "part_of_name");
    const roleOf = (sp: Span) => assign[sp.id]?.role ?? "none";
    for (const sp of meta.numSpans) decide(`role_${sp.id}`, { about: "span_role", value: roleOf(sp), confidence: assign[sp.id]?.p ?? 0, answer: a1[`role_${sp.id}`], loadBearing: roleOf(sp) !== "none", by: "oracle" });

    // ------------------------------------------------ period
    let periodSpec: PeriodSpec | undefined;
    {
      const pd = dist(a1.period);
      const pinned = pins.period as PeriodKey | undefined;
      let key = (pinned ?? argmax(pd) ?? "none") as PeriodKey;
      const timeAmount = meta.numSpans.find((sp) => roleOf(sp) === "time_amount");
      const years = meta.numSpans.filter((sp) => roleOf(sp) === "year_or_date" && sp.yearLike).map((sp) => sp.value!);
      const dateStarts = meta.dateSpans.filter((sp) => (argmax(dist(a1[`date_role_${sp.id}`])) ?? "start") === "start");
      const dateEnds = meta.dateSpans.filter((sp) => argmax(dist(a1[`date_role_${sp.id}`])) === "end");
      const dateBefore = meta.dateSpans.filter((sp) => argmax(dist(a1[`date_role_${sp.id}`])) === "before");
      const startParts: DateParts | undefined = dateStarts[0]?.date ? { ...dateStarts[0].date } : years.length ? { year: years[0] } : undefined;
      if (startParts && years.length && !startParts.year) startParts.year = years[0];
      // repair keys whose parts are present in a different form
      if (key === "specific_year" && !startParts?.year) key = "none";
      if ((key === "specific_month" || key === "specific_quarter" || key === "specific_day") && startParts) {
        if (startParts.quarter) key = "specific_quarter";
        else if (startParts.month && startParts.day) key = "specific_day";
        else if (startParts.month) key = "specific_month";
        else if (startParts.year) key = "specific_year";
      }
      if (base && !pinned && pYes(a1.flag_has_time_period) < 0.5 && base.timeWindow) key = base.timeWindow.period.key;
      if (key !== "none") {
        periodSpec = { key, n: timeAmount?.value, start: startParts, end: dateEnds[0]?.date ?? dateBefore[0]?.date };
        if (key === "before_date") periodSpec.start = dateBefore[0]?.date ?? startParts;
        const b = periodBounds(periodSpec, ts);
        if (!b) {
          return this.clarifyChoice(s, "period", "Which time period do you mean?", a1.period as ChoiceAnswer, (k) => PERIOD_CRITERIA[k as PeriodKey] ?? k, (k) => periodBounds({ ...periodSpec!, key: k as PeriodKey }, ts)?.label ?? "needs a date");
        }
      }
      decide("period", { about: "period", value: periodSpec?.key ?? "none", confidence: pinned ? 1 : (a1.period as ChoiceAnswer | undefined)?.confidence ?? 1, answer: a1.period, loadBearing: !!periodSpec || (pd.none ?? 1) < 0.5, by: pinned ? "user" : "oracle" });
    }

    // ------------------------------------------------ measures
    const thresholdRoles = meta.numSpans.filter((sp) => roleOf(sp).startsWith("threshold:"));
    const groupThreshold = thresholdRoles.find((sp) => /^threshold:(count|sum|saved):/.test(roleOf(sp)));
    let subject: string | undefined;
    if (!base) {
      const sd = dist(a1.subject);
      subject = pins.subject ?? argmax(sd, ["none"]);
      if (subject) decide("subject", { about: "subject", value: subject, confidence: (a1.subject as ChoiceAnswer | undefined)?.confidence ?? 0, answer: a1.subject, loadBearing: shape === "lookup", by: pins.subject ? "user" : "oracle" });
    } else subject = base.subject;

    if (!base && shape !== "lookup") {
      const qd = { ...dist(a1.measure_quantity) };
      delete qd.none;
      const ad = dist(a1.measure_agg) as Record<Agg, number>;
      const pinnedQ = pins.measure;
      const pinnedAgg = pins.measure_agg as Agg | undefined;
      const qDist: Dist = pinnedQ ? { [pinnedQ]: 1 } : qd;
      const aDist = (pinnedAgg ? { [pinnedAgg]: 1 } : ad) as Record<Agg, number>;
      if (!Object.keys(qDist).length) return { outcome: "decline", reason: "No measurable quantity in the schema matches the request." };
      const jd = jointDecode(qDist, aDist, (q, agg) => {
        const c = meta.candByKey.get(q);
        return !!c && legalAggs(model, c).includes(agg);
      }, (q) => (meta.candByKey.get(q)?.kind === "saved" ? meta.candByKey.get(q)!.saved!.definition.agg : undefined));
      const noneP = dist(a1.measure_quantity).none ?? 0;
      // E07: the request asks for an aggregate the grammar forbids (sum of a price)
      if (!pinnedAgg && jd.illegalBest && jd.illegalBest.p > jd.p * 1.5 && (meta.candByKey.get(jd.illegalBest.a)?.kind === "column")) {
        const c = meta.candByKey.get(jd.illegalBest.a)!;
        const legal = legalAggs(model, c);
        s.pins.measure = c.key;
        return this.clarify(s, "measure_agg", `Adding up "${c.label}" across records isn't meaningful (it is a per-record price, rate or score). What would you like instead?`,
          legal.map((a) => ({ key: a, label: `${capitalize(AGG_WORD[a])} ${c.label}`, consequence: AGG_CRITERIA[a] })));
      }
      const [qk, agg] = jd.best;
      const cand = meta.candByKey.get(qk)!;
      const qConf = pinnedQ ? 1 : (qd[qk] ?? 0) / Math.max(1e-9, Object.values(qd).reduce((a, b) => a + b, 0) + noneP);
      if (!pinnedQ && noneP > 0.6 && (dist(a1.measure_quantity).none ?? 0) > (qd[qk] ?? 0)) {
        return this.clarify(s, "measure", "Which quantity should I compute?", top(a1.measure_quantity as ChoiceAnswer, 5).filter((t) => t.key !== "none").map((t) => ({ key: t.key, label: meta.candByKey.get(t.key)?.label ?? t.key, consequence: meta.candByKey.get(t.key)?.description ?? "" })));
      }
      decide("measure", { about: "measure", value: qk, confidence: qConf, answer: a1.measure_quantity, loadBearing: true, by: pinnedQ ? "user" : "oracle" });
      decide("measure_agg", { about: "measure_agg", value: agg, confidence: cand.kind === "saved" || cand.kind === "count" ? 1 : pinnedAgg ? 1 : (ad[agg] ?? 0), answer: a1.measure_agg, loadBearing: cand.kind === "column" || cand.kind === "duration", by: pinnedAgg ? "user" : "oracle" });
      plan.measures = [toMeasure(model, cand, agg)];
      // secondary measures
      for (const [qid, key] of Object.entries(meta.alsoQ)) {
        if (key === qk || !yes(a1[qid], 0.6)) continue;
        const c2 = meta.candByKey.get(key)!;
        const legal = legalAggs(model, c2);
        const agg2 = legal.includes(agg) ? agg : legal[0];
        const m2 = toMeasure(model, c2, agg2);
        if (!plan.measures.some((m) => m.alias === m2.alias)) plan.measures.push(m2);
        decide(qid, { about: "measure", value: key, confidence: noulConfidence(pYes(a1[qid])), answer: a1[qid], loadBearing: true, by: "oracle" });
      }
    }

    // ------------------------------------------------ dimensions
    const timeGrainD = dist(a1.time_grain);
    let grain = (base ? base.dimensions.find((dd) => dd.kind === "time")?.grain : undefined) as TimeGrain | undefined;
    if (!base) {
      const g = argmax(timeGrainD, shape === "trend" ? ["none"] : []);
      if (g && g !== "none" && (shape === "trend" || (timeGrainD[g] ?? 0) > 0.5)) grain = g as TimeGrain;
      // "revenue in Q2 2026" is one number, not a one-row quarterly series
      const SINGLE: Record<string, TimeGrain> = { specific_quarter: "quarter", last_quarter: "quarter", this_quarter: "quarter", specific_month: "month", last_month: "month", this_month: "month", specific_year: "year", last_year: "year", this_year: "year", specific_day: "day", today: "day", yesterday: "day" };
      if (grain && shape !== "trend" && periodSpec && SINGLE[periodSpec.key] === grain) grain = undefined;
      const dims: Dimension[] = [];
      const pDim = new Map<Dimension, number>();
      // independent questions disagree: a confident "for each X" outranks a single-value shape
      if (shape === "single_value" && Object.keys(meta.dimQ).some((qid) => pYes(a1[qid]) > 0.85)) {
        shape = plan.shape = "breakdown";
        decide("shape", { about: "shape", value: shape, confidence: Math.max(...Object.keys(meta.dimQ).map((qid) => pYes(a1[qid]))), loadBearing: true, by: "code" });
      }
      for (const [qid, dim] of Object.entries(meta.dimQ)) {
        if (!yes(a1[qid], 0.5)) continue;
        if (shape === "single_value") continue;
        dims.push(dim);
        pDim.set(dim, pYes(a1[qid]));
        decide(qid, { about: "dimension", value: dim.column ?? dim.table, confidence: noulConfidence(pYes(a1[qid])), answer: a1[qid], loadBearing: true, by: "oracle" });
      }
      // a ranking ranks its subject: the ranked entity is a dimension even when the request
      // doesn't say "for each" ("top 3 products … in each category")
      if (shape === "ranking" && subject && !model.tables[subject]?.junction && !dims.some((dd) => dd.table === subject) && plan.measures[0]?.table !== subject) {
        const tm = model.tables[subject];
        const ent: Dimension = { alias: slug(tm.noun), label: tm.noun, kind: "entity", table: subject };
        dims.push(ent);
        pDim.set(ent, 0.5);
      }
      // an entity and one of its own columns: keep whichever the request supports more (entity on ties)
      let kept = dims.filter((dd) => {
        const rival = dims.find((o) => o !== dd && o.table === dd.table && o.kind !== dd.kind && o.kind !== "time" && dd.kind !== "time");
        if (!rival) return true;
        const mine = pDim.get(dd) ?? 0, theirs = pDim.get(rival) ?? 0;
        return dd.kind === "entity" ? mine >= theirs : mine > theirs;
      });
      // dimensions must be reachable from the measure without fan-out; among same-named
      // candidates (orders.channel vs support_tickets.channel) keep the reachable one
      const mt = plan.measures[0]?.table;
      if (mt) {
        const up = (dd: Dimension) => this.graph.isUp(mt, dd.table);
        const reach = (dd: Dimension) => up(dd) || this.graph.findRoot([mt, dd.table], [mt]) !== undefined;
        kept = kept.filter((dd) => {
          const name = dd.column ? splitRef(dd.column)[1] : dd.table;
          const rivals = kept.filter((o) => o !== dd && (o.column ? splitRef(o.column)[1] : o.table) === name);
          return up(dd) || !rivals.some(up);
        });
        kept = kept.filter((dd) => reach(dd));
      }
      const head = (dd: Dimension) => (dd.kind === "column" ? dd.label.split(" ").pop() : undefined);
      kept = kept.filter((dd) => {
        const h = head(dd);
        if (!h) return true;
        const rival = kept.find((o) => o !== dd && head(o) === h);
        return !rival || (pDim.get(dd) ?? 0) > (pDim.get(rival) ?? 0) || ((pDim.get(dd) ?? 0) === (pDim.get(rival) ?? 0) && kept.indexOf(dd) < kept.indexOf(rival));
      });
      // unique output aliases
      const seenAlias = new Set<string>();
      for (const dd of kept) {
        if (seenAlias.has(dd.alias)) dd.alias = `${slug(model.tables[dd.table].noun)}_${dd.alias}`;
        seenAlias.add(dd.alias);
      }
      plan.dimensions = kept;
      if ((shape === "breakdown" || shape === "ranking") && !plan.dimensions.length) {
        // a ranking/breakdown with no dimension: fall back to the strongest candidate
        const best = Object.entries(meta.dimQ).sort((p, q) => pYes(a1[q[0]]) - pYes(a1[p[0]]))[0];
        if (best && pYes(a1[best[0]]) > 0.2) plan.dimensions = [best[1]];
        else if (!grain) plan.shape = "single_value";
      }
    }

    // ------------------------------------------------ filters: value links
    const filters: Predicate[] = base ? [...base.filters] : [];
    for (const l of links) {
      const a = a1[`filter_${l.id}`] as ChoiceAnswer | undefined;
      const k = pins[`filter:${l.id}`] ?? (a ? argmax(dist(a)) : undefined);
      if (!k || k === "not_a_condition") continue;
      const [t, c] = splitRef(l.column);
      const cm = model.tables[t].columns[c];
      // keep wins over exclude on the same column (§5.7a)
      const existing = filters.find((f) => f.column === l.column && !f.implied);
      const op: Op = k === "exclude" ? "neq" : "eq";
      if (existing) {
        if (existing.op === "eq" && op === "eq") {
          existing.op = "in";
          existing.values.push(l.value);
          existing.label = `${model.tables[t].noun} ${cm.humanName} is ${existing.values.join(" or ")}`;
        } else if (existing.op === "neq" && op === "neq") {
          existing.op = "not_in";
          existing.values.push(l.value);
          existing.label = `${model.tables[t].noun} ${cm.humanName} is not ${existing.values.join(" or ")}`;
        } else if (op === "eq") {
          Object.assign(existing, { op, values: [l.value], label: `${model.tables[t].noun} ${cm.humanName} is ${l.value}` });
          x.warnings.push(`mixed keep/exclude on ${l.column}; keep wins`);
        }
        continue;
      }
      // base plan (follow-up): a new value on a column already filtered replaces it
      const replaced = base ? filters.findIndex((f) => f.column === l.column) : -1;
      const pred: Predicate = { column: l.column, op, values: [l.value], label: `${model.tables[t].noun} ${cm.humanName} ${op === "neq" ? "is not" : "is"} ${l.value}`, source: l.id };
      if (replaced >= 0) filters[replaced] = pred;
      else filters.push(pred);
      decide(`filter_${l.id}`, { about: "filter", value: `${k}:${l.column}=${l.value}`, confidence: a?.confidence ?? 1, answer: a, loadBearing: true, by: pins[`filter:${l.id}`] ? "user" : "oracle" });
    }
    // text matches
    for (const [sid, tq] of Object.entries(meta.textQ)) {
      const ca = a1[`textcol_${sid}`] as ChoiceAnswer | undefined;
      const col = ca ? argmax(dist(ca)) : undefined;
      if (!col || col === "none" || (ca?.probabilities[col] ?? 0) < 0.4) continue;
      const mode = argmax(dist(a1[`textmode_${sid}`])) ?? "exact";
      const op: Op = mode === "contains" ? "contains" : mode === "starts_with" ? "starts_with" : "eq";
      filters.push({ column: col, op, values: [tq.span.text], label: `${humanRef(model, col)} ${op === "eq" ? "is" : op === "contains" ? "contains" : "starts with"} "${tq.span.text}"`, source: sid });
      decide(`textcol_${sid}`, { about: "filter", value: `${col} ${op} ${tq.span.text}`, confidence: ca!.confidence, answer: ca, loadBearing: true, by: "oracle" });
    }
    for (const [qid, ref] of Object.entries(meta.nullQ)) {
      if (!yes(a1[qid], 0.6)) continue;
      filters.push({ column: ref, op: "is_null", values: [], label: `${humanRef(model, ref)} is missing`, source: qid });
      decide(qid, { about: "filter", value: `${ref} is null`, confidence: noulConfidence(pYes(a1[qid])), answer: a1[qid], loadBearing: true, by: "oracle" });
    }
    const boolPicks = Object.entries(meta.boolQ)
      .map(([qid, ref]) => ({ qid, ref, k: argmax(dist(a1[qid])), p: (a1[qid] as ChoiceAnswer | undefined)?.confidence ?? 0 }))
      .filter((b) => b.k && b.k !== "not_a_condition");
    const boolWord = (ref: string) => stem(splitRef(ref)[1].replace(/^(is|has)_|bool$|_flag$/g, "").split("_")[0]);
    for (const [qid, ref] of Object.entries(meta.boolQ)) {
      const k = argmax(dist(a1[qid]));
      if (!k || k === "not_a_condition") continue;
      const me = boolPicks.find((b) => b.qid === qid)!;
      if (boolPicks.some((b) => b !== me && splitRef(b.ref)[0] === splitRef(ref)[0] && boolWord(b.ref) === boolWord(ref) && (b.p > me.p || (b.p === me.p && boolPicks.indexOf(b) < boolPicks.indexOf(me))))) continue;
      filters.push({ column: ref, op: k === "keep_true" ? "is_true" : "is_false", values: [], label: `${humanRef(model, ref)} is ${k === "keep_true" ? "true" : "false"}`, source: qid });
      decide(qid, { about: "filter", value: `${ref} ${k}`, confidence: (a1[qid] as ChoiceAnswer).confidence, answer: a1[qid], loadBearing: true, by: "oracle" });
    }

    // numeric thresholds (row level) and group thresholds (HAVING)
    const rowThresh = new Map<string, { sp: Span; op: string }[]>();
    for (const sp of thresholdRoles) {
      const role = roleOf(sp);
      const op = argmax(dist(a1[`op_${sp.id}`])) ?? "gt";
      const list = rowThresh.get(role) ?? [];
      list.push({ sp, op });
      rowThresh.set(role, list);
    }
    for (const [role, items] of rowThresh) {
      const [, kind, target] = /^threshold:(col|sum|count|saved):(.+)$/.exec(role) ?? [];
      const lo = items.find((i) => i.op === "between_low"), hi = items.find((i) => i.op === "between_high");
      const unitWord = (sp: Span) => /^\s*(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|units?|items?|percent)\b/i.exec(s.request.slice(sp.end))?.[0] ?? "";
      for (const it of items) it.sp = { ...it.sp, text: it.sp.text + unitWord(it.sp) };
      let op: Op;
      let values: number[];
      let text: string;
      const conv = (sp: Span) => this.toBaseUnits(kind === "count" ? undefined : target, sp, s.request);
      if (lo && hi) {
        op = "between";
        values = [conv(lo.sp), conv(hi.sp)];
        text = `between ${lo.sp.text} and ${hi.sp.text}`;
      } else {
        const it = items[0];
        op = (["gt", "gte", "lt", "lte", "eq"].includes(it.op) ? it.op : "gt") as Op;
        values = [conv(it.sp)];
        text = `${{ gt: "more than", gte: "at least", lt: "less than", lte: "at most", eq: "exactly" }[op as "gt"]} ${it.sp.text}`;
      }
      if (kind === "col") {
        filters.push({ column: target, op, values, label: `${humanRef(model, target)} is ${text}`, source: items[0].sp.id });
      } else {
        let m: Measure;
        if (kind === "count") m = { alias: `${model.tables[target].name}_count`, label: `number of ${model.tables[target].humanName}`, kind: "count", agg: "count_rows", table: target };
        else if (kind === "saved") m = measureFromSaved(model, meta.cands.find((c) => c.saved?.name === target)!.saved!);
        else {
          const c = meta.candByKey.get(`col:${target}`)!;
          m = toMeasure(model, c, "sum");
        }
        plan.having = { measure: m, op, values, label: `${m.label} is ${text}` };
      }
    }
    // one phrase linked to several columns ("phone" → orders.channel and support_tickets.channel):
    // keep the column on the subject / measure table, else one reachable N:1 from it
    const anchor = (shape === "lookup" ? subject : plan.measures[0]?.table) ?? subject;
    if (anchor) {
      const bySpan = new Map<string, Predicate[]>();
      for (const f of filters) {
        const l = links.find((x) => x.id === f.source);
        if (l) bySpan.set(`${l.start}:${l.end}`, [...(bySpan.get(`${l.start}:${l.end}`) ?? []), f]);
      }
      const rank = (f: Predicate) => {
        const t = splitRef(f.column)[0];
        return t === anchor ? 0 : this.graph.isUp(anchor, t) ? 1 : 2;
      };
      for (const group of bySpan.values()) {
        if (group.length < 2) continue;
        const best = group.slice().sort((p, q) => rank(p) - rank(q))[0];
        for (const f of group) if (f !== best) filters.splice(filters.indexOf(f), 1);
      }
    }
    plan.filters = filters;

    // ------------------------------------------------ lookup subject / having → entity grouping
    const perGroup = flag("per_group_top_n") > 0.5;
    const singleBest = flag("single_best") > 0.5;
    const sortDir = base ? "unspecified" : argmax(dist(a1.sort_dir)) ?? "unspecified";
    if (!base) {
      if (shape === "lookup") {
        plan.subject = subject;
        if (!plan.subject) return this.clarifyChoice(s, "subject", "Which records should I list?", a1.subject as ChoiceAnswer, (k) => this.model.tables[k]?.humanName ?? k, (k) => this.model.tables[k]?.description ?? "");
        // projections: defaults + requested columns of the subject or N:1-reachable tables
        const reqCols = Object.entries(meta.showQ).filter(([qid, ref]) => yes(a1[qid], 0.6) && this.graph.isUp(plan.subject!, splitRef(ref)[0])).map(([, ref]) => ref);
        plan.projections = reqCols.length ? [...new Set([...defaultLookupColumns(model, plan.subject), ...reqCols])] : [];
        if (plan.having) {
          plan.measures = [plan.having.measure];
          plan.dimensions = [{ alias: slug(model.tables[plan.subject].noun), label: model.tables[plan.subject].noun, kind: "entity", table: plan.subject }];
        } else {
          // keep only partition entities for DISTINCT ON
          plan.dimensions = plan.dimensions.filter((dd) => dd.kind === "entity" && dd.table !== plan.subject);
        }
      } else {
        plan.subject = plan.measures[0]?.kind === "count" ? plan.measures[0].table : subject;
      }
    }

    return {
      plan,
      timeCandidates: [],
      existenceWanted: { absent: flag("asks_absence"), present: flag("asks_presence_only") },
      perGroup,
      singleBest,
      sortDir,
      grain,
      periodSpec,
      overall: flag("vs_overall_aggregate") > 0.5,
    };
  }

  private toBaseUnits(target: string | undefined, sp: Span, request = ""): number {
    let v = sp.value ?? 0;
    if (!target || target.includes(":")) return v;
    const ref = target.startsWith("col:") ? target.slice(4) : target;
    const [t, c] = splitRef(ref);
    const cm = this.model.tables[t]?.columns[c];
    if (cm?.unit?.kind === "money" && cm.unit.divisor) v = v * cm.unit.divisor;
    if (cm?.unit?.kind === "duration") {
      // "10 minutes" against a milliseconds column → 600000
      const word = /^\s*(ms|milliseconds?|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|days?)\b/i.exec(request.slice(sp.end))?.[1]?.toLowerCase() ?? "";
      const secs = /^ms|^milli/.test(word) ? v / 1000 : /^s/.test(word) ? v : /^m/.test(word) ? v * 60 : /^h/.test(word) ? v * 3600 : /^d/.test(word) ? v * 86400 : undefined;
      v = secs === undefined ? v * (cm.unit.divisor ?? 1) : secs * (cm.unit.divisor ?? 1);
    }
    if (cm?.unit?.kind === "percent" && cm.unit.fraction && sp.percent) v = v / 100;
    return Math.round(v * 1e6) / 1e6;
  }

  // ==================================================================== R2

  private async round2(
    s: Session, state: unknown, plan: QueryPlan, d: Exclude<ReturnType<Composer["decodeR1"]>, { outcome: unknown }>, meta: ReturnType<Composer["buildR1"]>, a1: Answers, ts: TimeSettings,
    decide: (k: string, d: Omit<Decision, "question"> & { question?: string }) => void,
  ): Promise<(Partial<Result> & { outcome: Result["outcome"] }) | undefined> {
    const model = this.model;
    const R: Questions = {};

    // time column candidates (only when the plan needs time)
    const needTime = !!d.periodSpec || !!d.grain;
    const timeCands = needTime ? this.timeColumnCandidates(plan) : [];
    if (timeCands.length > 1 && !s.pins.time_column) {
      const crit: Record<string, string> = {};
      for (const ref of timeCands) {
        const cm = model.tables[splitRef(ref)[0]].columns[splitRef(ref)[1]];
        crit[ref] = `${capitalize(model.tables[cm.table].noun)} ${cm.humanName}: ${cm.description}${cm.isDefaultTime ? " (the usual time for this record)" : ""}`;
      }
      R.time_column = choice("Which moment does the time period or time grouping in `request` refer to?", crit);
    }

    // existence (absence) questions
    const subj = plan.subject ?? plan.measures[0]?.table;
    const existQ: Record<string, { table: string; negated: boolean }> = {};
    if (subj && (d.existenceWanted.absent > 0.35 || d.existenceWanted.present > 0.5)) {
      let i = 0;
      const targets = Object.keys(model.tables)
        .filter((t) => t !== subj && !model.tables[t].hidden && !model.tables[t].junction && model.tables[t].kind === "table" && !this.graph.isUp(subj, t))
        .map((t) => ({ t, path: this.graph.bestPaths(subj, t)[0] }))
        .filter((x) => x.path && x.path.downs >= 1 && x.path.steps.length <= 3)
        .sort((a, b) => a.path.steps.length - b.path.steps.length)
        .slice(0, 16)
        .map((x) => x.t);
      {
        for (const t of targets) {
          if (Object.values(existQ).some((e) => e.table === t)) continue;
          if (d.existenceWanted.absent > 0.35) {
            existQ[`absent_${i}`] = { table: t, negated: true };
            R[`absent_${i}`] = noul({ subject: model.tables[subj].humanName, related: model.tables[t].humanName, question: "Does `request` ask for `subject` that have no matching `related` (never, none, didn't)?" });
          }
          if (d.existenceWanted.present > 0.5) {
            existQ[`present_${i}`] = { table: t, negated: false };
            R[`present_${i}`] = noul({ subject: model.tables[subj].humanName, related: model.tables[t].humanName, question: "Does `request` ask only for `subject` that have at least one matching `related`?" });
          }
          i++;
        }
      }
    }

    // an undefined business term ("revenue") mapped confidently to one column still has several
    // reasonable definitions: ask once (spec J01); the accepted answer becomes a saved definition
    const m0 = plan.measures[0];
    // only words the schema vocabulary does not cover are candidates ("revenue"; not "order total")
    const unknownTerms = m0 && (m0.kind === "column" || m0.kind === "duration") && !m0.saved && !s.pins.measure ? this.ungroundedTerms(s.request) : [];
    if (unknownTerms.length) {
      R.measure_business_term = noul({
        term: unknownTerms.join(", "),
        quantity: m0!.label,
        question: "In `request`, is `term` the name of the quantity being computed (a business metric such as revenue or bookings), rather than an ordinary word, an attribute, or a filter?",
      });
    }

    // partition dimension for per-group top-N
    if (d.perGroup && plan.dimensions.length >= 2 && plan.shape !== "lookup") {
      const crit: Record<string, string> = {};
      for (const dd of plan.dimensions) crit[dd.alias] = `Within each ${dd.label}.`;
      R.partition_dim = choice("In `request`, the top results are picked separately within each what?", crit);
    }

    // join-path ambiguities, with the provisional time column
    const provisional = this.withTime(plan, timeCands[0] ?? this.defaultTimeColumn(plan), d, ts);
    const amb = analyzeJoins(provisional, model, this.graph).ambiguities;
    const pathQ = this.pathQuestions(R, amb, s);

    const a2 = Object.keys(R).length ? await this.ask_(s, "R2", state, R) : {};

    // ---- business term → clarify the definition once
    if (yes(a2.measure_business_term, 0.6) && m0?.column) {
      const unit = m0.unit?.kind;
      const opts = meta.cands
        .filter((c) => c.kind === "column" && c.column && this.model.tables[c.table].columns[splitRef(c.column)[1]].unit?.kind === unit && legalAggs(this.model, c).includes(m0.agg))
        .map((c) => ({ c, p: dist(a1.measure_quantity)[c.key] ?? 0 }))
        .sort((x, y) => y.p - x.p)
        .slice(0, 4);
      if (opts.length >= 2) {
        decide("measure_business_term", { about: "measure", value: true, confidence: noulConfidence(pYes(a2.measure_business_term)), answer: a2.measure_business_term, loadBearing: true, by: "oracle" });
        return this.clarify(s, "measure", "That term can be computed more than one way here. Which definition should I use? (You can save the answer as a definition for everyone.)",
          opts.map(({ c }) => ({ key: c.key, label: capitalize(humanRef(this.model, c.column!)), consequence: c.description })), "measure");
      }
    }

    // ---- time column
    let timeCol: string | undefined;
    if (needTime) {
      if (s.pins.time_column) timeCol = s.pins.time_column;
      else if (a2.time_column?.type === "choice") {
        const tc = a2.time_column;
        timeCol = tc.choice;
        // flat distribution → convention default (C4)
        // a flat distribution falls back to the convention default (C4, spec §5.8)
        const [first, second] = top(tc, 2);
        const def = this.defaultTimeColumn(plan);
        if (def && (first?.p ?? 0) - (second?.p ?? 0) < 0.25 && [first?.key, second?.key].includes(def)) {
          timeCol = def;
          decide("time_column", { about: "time_column", value: def, confidence: (first?.p ?? 0) + (second?.p ?? 0), answer: tc, loadBearing: true, by: "default" });
        } else decide("time_column", { about: "time_column", value: tc.choice, confidence: tc.confidence, answer: tc, loadBearing: true, by: "oracle" });
      } else timeCol = timeCands[0] ?? this.defaultTimeColumn(plan);
      if (!timeCol) return { outcome: "clarify", reason: "no time column", clarification: undefined };
    }
    Object.assign(plan, this.withTime(plan, timeCol, d, ts));
    // "delivered in August": the lifecycle timestamp carries the verb, so a status filter on the
    // same word (status = 'delivered') is redundant and would drop later-refunded orders
    if (timeCol) {
      const [tt, tc] = splitRef(timeCol);
      const verb = stem(tc.replace(/_(at|on|date)$/, "").split("_")[0]);
      plan.filters = plan.filters.filter((f) => {
        if (f.op !== "eq" || splitRef(f.column)[0] !== tt || f.implied) return true;
        const cm = model.tables[tt].columns[splitRef(f.column)[1]];
        return !(cm.role === "dimension_categorical" && stem(String(f.values[0])) === verb);
      });
    }

    // ---- existence
    const subjT = plan.subject ?? plan.measures[0]?.table;
    const insideOf = (rel: string) => (ref: string) => {
      const t = splitRef(ref)[0];
      return t === rel || (this.graph.isUp(rel, t) && !(subjT && this.graph.isUp(subjT, t)));
    };
    const yesNeg = Object.entries(existQ)
      .filter(([qid, e]) => e.negated && yes(a2[qid], 0.5))
      .sort((a, b) => plan.filters.filter((f) => insideOf(b[1].table)(f.column)).length - plan.filters.filter((f) => insideOf(a[1].table)(f.column)).length || pYes(a2[b[0]]) - pYes(a2[a[0]]));
    const chosenNeg = yesNeg[0]?.[0];
    for (const [qid, e] of Object.entries(existQ)) {
      if (!yes(a2[qid], 0.5)) continue;
      if (e.negated && qid !== chosenNeg) continue;
      const ex: Existence = { negated: e.negated, table: e.table, filters: [], label: `${e.negated ? "that have no" : "that have at least one"} ${model.tables[e.table].noun}` };
      decide(qid, { about: "existence", value: `${e.negated ? "absent" : "present"}:${e.table}`, confidence: noulConfidence(pYes(a2[qid])), answer: a2[qid], loadBearing: true, by: "oracle" });
      // scoping by column ownership (§5.9): related-table filters move inside
      const subjTable = plan.subject ?? plan.measures[0]?.table;
      const inside = (ref: string) => {
        const t = splitRef(ref)[0];
        return t === e.table || (this.graph.isUp(e.table, t) && !(subjTable && this.graph.isUp(subjTable, t)));
      };
      ex.filters = plan.filters.filter((f) => inside(f.column));
      if (e.negated) {
        for (const f of ex.filters) {
          if (f.op === "neq") Object.assign(f, { op: "eq", label: f.label.replace(" is not ", " is ") });
          if (f.op === "not_in") Object.assign(f, { op: "in", label: f.label.replace(" is not ", " is ") });
        }
      }
      plan.filters = plan.filters.filter((f) => !inside(f.column));
      if (plan.timeWindow && inside(plan.timeWindow.column)) {
        if (e.negated) {
          ex.timeWindow = plan.timeWindow;
          ex.label += ` in ${plan.timeWindow.bounds.label}`;
          plan.timeWindow = undefined;
        }
      }
      if (e.negated || (!ex.filters.length && !plan.timeWindow)) plan.existence.push(ex);
      else plan.filters.push(...ex.filters);
    }

    // ---- partition / per-group
    if (d.perGroup && plan.dimensions.length >= 2 && plan.shape !== "lookup") {
      const part = s.pins.partition_dim ?? argmax(dist(a2.partition_dim)) ?? plan.dimensions.find((x) => x.kind !== "entity")?.alias ?? plan.dimensions[0].alias;
      const n = plan.limit ?? meta.numSpans.map((sp) => sp).find(() => false)?.value;
      plan.perGroupLimit = { partition: part, n: d.singleBest ? 1 : (plan.limit ?? this.resultCount(meta, a1) ?? 3) };
      plan.limit = undefined;
      void n;
    }

    // ---- join paths
    const pathR = this.resolvePaths(s, plan, amb, pathQ, a2, decide);
    if (pathR) return pathR;
    // a second pass: new tables (time column, existence) can introduce new ambiguities
    const amb2 = analyzeJoins(plan, model, this.graph).ambiguities;
    if (amb2.length) {
      const R2b: Questions = {};
      const pq2 = this.pathQuestions(R2b, amb2, s);
      const a2b = Object.keys(R2b).length ? await this.ask_(s, "R2b", state, R2b) : {};
      const r = this.resolvePaths(s, plan, amb2, pq2, a2b, decide);
      if (r) return r;
    }

    // ---- order / limit / distinct / derived / flags
    this.finishShape(plan, d, meta, a1, ts, decide, s);
    return undefined;
  }

  private resultCount(meta: ReturnType<Composer["buildR1"]>, a1: Answers): number | undefined {
    const sp = meta.numSpans.find((x) => argmax(dist(a1[`role_${x.id}`])) === "result_count");
    return sp?.value;
  }

  private pathQuestions(R: Questions, amb: Ambiguity[], s: Session): Record<string, Ambiguity> {
    const out: Record<string, Ambiguity> = {};
    amb.forEach((a, i) => {
      if (s.pins[`path:${a.key}`]) return;
      const def = this.config.relationships?.default_paths?.[a.key];
      if (def && Object.keys(a.options).some((k) => k === `via:${def}` || k === `role:${def}`)) return;
      const id = `path_${qkey(a.key)}_${i}`;
      out[id] = a;
      const crit: Record<string, string> = {};
      for (const [k, p] of Object.entries(a.options)) crit[k] = pathOptionText(p, a.attribute);
      crit.unclear = `The request does not say whose ${a.attribute} it is.`;
      R[id] = choice({ attribute: a.attribute, question: "In `request`, whose `attribute` is meant? Choose the record the request ties it to (e.g. in 'visits by patients from the Boston clinic', the clinic is the patient's clinic)." }, crit);
    });
    return out;
  }

  private resolvePaths(s: Session, plan: QueryPlan, amb: Ambiguity[], pathQ: Record<string, Ambiguity>, a2: Answers, decide: (k: string, d: Omit<Decision, "question"> & { question?: string }) => void) {
    for (const a of amb) {
      let key: string | undefined = s.pins[`path:${a.key}`];
      let by = "user";
      const def = this.config.relationships?.default_paths?.[a.key];
      if (!key && def) {
        key = Object.keys(a.options).find((k) => k === `via:${def}` || k === `role:${def}`);
        by = "config";
      }
      if (!key) {
        const qid = Object.keys(pathQ).find((q) => pathQ[q].key === a.key);
        const ans = qid ? (a2[qid] as ChoiceAnswer | undefined) : undefined;
        if (!ans) continue;
        const best = argmax(dist(ans), []);
        const realBest = argmax(dist(ans), ["unclear"]);
        const pUnclear = ans.probabilities.unclear ?? 0;
        if (best === "unclear" || !realBest || (ans.probabilities[realBest] ?? 0) < 0.5 || pUnclear > 0.35) {
          return this.clarify(s, `path:${a.key}`, `Which ${a.attribute} do you mean?`, Object.entries(a.options).map(([k, p]) => ({ key: k, label: pathOptionText(p, a.attribute).replace(/\.$/, ""), consequence: `Joins ${p.steps.map((st) => st.rel.id).join(" → ")}` })), "join_path");
        }
        key = realBest;
        by = "oracle";
        decide(`path:${a.key}`, { about: "join_path", value: key, confidence: ans.probabilities[realBest], answer: ans, loadBearing: true, by });
      } else decide(`path:${a.key}`, { about: "join_path", value: key, confidence: 1, loadBearing: true, by });
      const opt = a.options[key];
      if (opt) {
        plan.joinPaths[a.key] = opt.steps.map((st) => st.rel.id);
        // name the chosen route in labels so the narrative says *whose* region / which address
        // "shipping address state code", "customer region name", "fulfilled from warehouse region"
        const first = opt.steps[0];
        const firstNoun = this.model.tables[first.to].noun;
        const via = first.to === a.to ? first.rel.role : first.rel.role ? `${first.rel.role} ${firstNoun}` : firstNoun;
        if (via) {
          for (const f of plan.filters) if (splitRef(f.column)[0] === a.to && !f.label.startsWith(via)) f.label = `${via} ${f.label}`;
          for (const dd of plan.dimensions) if (dd.table === a.to && !dd.label.startsWith(via)) dd.label = `${via} ${dd.label}`;
        }
      }
    }
    return undefined;
  }

  private finishShape(plan: QueryPlan, d: Exclude<ReturnType<Composer["decodeR1"]>, { outcome: unknown }>, meta: ReturnType<Composer["buildR1"]>, a1: Answers, ts: TimeSettings, decide: (k: string, d: Omit<Decision, "question"> & { question?: string }) => void, s: Session) {
    const model = this.model;
    const base = !!s.ctx.conversation?.plan && plan.order.length > 0;
    const count = this.resultCount(meta, a1);
    const flag = (k: string) => pYes(a1[`flag_${k}`]);
    if (base && !meta.numSpans.length) return; // follow-up keeps the previous ordering/limit
    plan.includeEmptyGroups = flag("include_empty_groups") > 0.5 && plan.shape !== "lookup" && plan.dimensions.some((x) => x.kind !== "time");
    plan.distinct = plan.shape === "lookup" && flag("asks_unique") > 0.5 && plan.projections.length > 0;

    const hasTimeDim = plan.dimensions.some((x) => x.kind === "time");
    // a two-period comparison only exists without a time grain; inside a trend, "growth" is a derived change
    const comparing = flag("compare_periods") > 0.5 && !!plan.timeWindow && plan.measures.length > 0 && !hasTimeDim;

    // derived calculations
    const pinnedDv = s.pins.derived;
    const dv = pinnedDv ?? argmax(dist(a1.derived));
    if (dv && dv !== "none" && (pinnedDv || (dist(a1.derived)[dv] ?? 0) > 0.5)) {
      const kind = dv as DerivedCalc;
      const needsTime = kind === "running_total" || kind === "change_vs_previous" || kind === "pct_change_vs_previous" || kind === "moving_average";
      // implied by the ranking itself / by the period comparison
      const redundant = (kind === "rank" && plan.shape === "ranking") || (comparing && (kind === "change_vs_previous" || kind === "pct_change_vs_previous"));
      if (!redundant && (!needsTime || hasTimeDim)) {
        plan.derived = { kind, window: kind === "moving_average" ? count : undefined };
        decide("derived", { about: "derived", value: kind, confidence: pinnedDv ? 1 : (a1.derived as ChoiceAnswer).confidence, answer: a1.derived, loadBearing: true, by: pinnedDv ? "user" : "oracle" });
      }
    }

    // period comparison (§5.15): "YTD compared with the same period last year"
    if (comparing && plan.timeWindow) {
      const cur = plan.timeWindow.bounds;
      const prev = shiftYears(cur, -1, ts.timezone);
      const col = plan.timeWindow.column;
      const ms: Measure[] = [];
      for (const m of plan.measures) {
        ms.push({ ...m, alias: `${m.alias}_current`, label: `${m.label} (${cur.label})`, period: { column: col, bounds: cur } });
        ms.push({ ...m, alias: `${m.alias}_previous`, label: `${m.label} (${prev.label})`, period: { column: col, bounds: prev } });
      }
      plan.measures = ms;
      plan.comparePeriods = { column: col, current: cur, previous: prev, currentLabel: cur.label, previousLabel: prev.label };
      plan.timeWindow = undefined;
      decide("compare_periods", { about: "derived", value: true, confidence: noulConfidence(flag("compare_periods")), answer: a1.flag_compare_periods, loadBearing: true, by: "oracle" });
    }

    // order & limit (§5.11, §5.12)
    const mAlias = plan.measures.find((m) => !m.hidden)?.alias;
    plan.order = [];
    if (plan.shape === "lookup") {
      const t = plan.subject ? model.tables[plan.subject] : undefined;
      if (plan.dimensions.some((x) => x.kind === "entity") && !plan.having && (d.singleBest || d.perGroup) && t?.defaultTime) {
        const part = plan.dimensions.find((x) => x.kind === "entity")!;
        plan.distinctOn = { partition: part.alias, orderColumn: `${t.key}.${t.defaultTime}`, dir: d.sortDir === "oldest_first" ? "asc" : "desc" };
      } else if (plan.having && mAlias) {
        plan.order = [{ ref: mAlias, kind: "measure", dir: "desc" }];
      } else if (t?.defaultTime && (d.sortDir === "newest_first" || d.sortDir === "oldest_first")) {
        plan.order = [{ ref: `${t.key}.${t.defaultTime}`, kind: "column", dir: d.sortDir === "newest_first" ? "desc" : "asc" }];
      }
      if (!plan.having) plan.dimensions = plan.dimensions.filter((x) => plan.distinctOn?.partition === x.alias);
      plan.limit = count ?? (d.singleBest && !plan.distinctOn ? 1 : undefined);
    } else if (plan.shape === "ranking" || plan.shape === "breakdown") {
      if (mAlias) plan.order = [{ ref: mAlias, kind: "measure", dir: d.sortDir === "low_first" ? "asc" : "desc" }];
      if (!plan.perGroupLimit) {
        if (plan.shape === "ranking") plan.limit = count ?? (d.singleBest ? 1 : this.settings.defaultRanking);
        else plan.limit = count ?? (d.singleBest ? 1 : undefined);
      }
    } else if (plan.shape === "trend") {
      plan.limit = undefined;
    }
  }

  // ==================================================================== time

  /** Event-time columns relevant to the plan (§5.8 date column). */
  private timeColumnCandidates(plan: QueryPlan): string[] {
    const model = this.model;
    const tables = new Set<string>();
    for (const m of plan.measures) tables.add(m.table);
    if (plan.having) tables.add(plan.having.measure.table);
    if (plan.subject) tables.add(plan.subject);
    for (const dd of plan.dimensions) if (dd.kind !== "time") tables.add(dd.table);
    const out: string[] = [];
    const add = (t: string) => {
      const tm = model.tables[t];
      if (!tm) return;
      for (const c of Object.values(tm.columns)) if (c.role === "timestamp_event" && !c.hidden) out.push(`${t}.${c.name}`);
    };
    const first = this.defaultTimeColumn(plan);
    if (first) out.push(first);
    for (const t of tables) {
      add(t);
      // nearest parent's default when the table has no own event time (order_items → orders)
      if (!model.tables[t].defaultTime) {
        for (const [pt] of this.graph.upReachable(t, 1)) if (pt !== t && model.tables[pt].defaultTime) out.push(`${pt}.${model.tables[pt].defaultTime}`);
      }
    }
    // the subject's children (customers → orders.placed_at: "customers who ordered last month")
    const subj = plan.subject ?? plan.measures[0]?.table;
    if (subj && (plan.shape === "lookup" || plan.measures[0]?.kind === "count")) {
      for (const r of model.relationships) {
        if (r.to.table !== subj || r.selfReference) continue;
        const ct = model.tables[r.from.table];
        if (ct.defaultTime && !ct.junction && !ct.snapshot) out.push(`${ct.key}.${ct.defaultTime}`);
      }
    }
    return [...new Set(out)];
  }

  private defaultTimeColumn(plan: QueryPlan): string | undefined {
    const model = this.model;
    // a duration measure is anchored at its start ("time to first response … last month": tickets opened last month)
    const dur = plan.measures.find((m) => m.duration)?.duration;
    if (dur) return dur.start;
    const measureTables = [...plan.measures.map((m) => m.table), ...(plan.having ? [plan.having.measure.table] : [])];
    const order = plan.shape === "lookup" && plan.subject ? [plan.subject, ...measureTables] : [...measureTables, ...(plan.subject ? [plan.subject] : [])];
    for (const t of order) {
      const tm = model.tables[t];
      if (tm?.defaultTime) return `${t}.${tm.defaultTime}`;
      for (const [pt, paths] of this.graph.upReachable(t, 2)) {
        if (pt !== t && model.tables[pt].defaultTime && paths[0].steps.length === 1) return `${pt}.${model.tables[pt].defaultTime}`;
      }
    }
    return undefined;
  }

  private withTime(plan: QueryPlan, col: string | undefined, d: { periodSpec?: PeriodSpec; grain?: TimeGrain }, ts: TimeSettings): QueryPlan {
    const p = structuredClone(plan);
    if (!col) return p;
    if (d.periodSpec && d.periodSpec.key !== "none") {
      const bounds = periodBounds(d.periodSpec, ts);
      if (bounds) p.timeWindow = { column: col, period: d.periodSpec, bounds } as TimeWindow;
    } else if (p.timeWindow) {
      p.timeWindow = { ...p.timeWindow, column: col };
    }
    if (d.grain) {
      const existing = p.dimensions.find((x) => x.kind === "time");
      if (existing) Object.assign(existing, { column: col, table: splitRef(col)[0], grain: d.grain });
      else p.dimensions.unshift({ alias: d.grain, label: d.grain, kind: "time", column: col, table: splitRef(col)[0], grain: d.grain });
      if (p.shape === "single_value" || p.shape === "breakdown") p.shape = "trend";
    }
    return p;
  }

  // ==================================================================== conventions

  private applyConventions(plan: QueryPlan) {
    const model = this.model;
    // soft delete (§2.2 behavioral conventions): current-state questions exclude soft-deleted subject rows
    const subj = plan.subject ?? (plan.measures.length === 1 && plan.measures[0].kind === "count" ? plan.measures[0].table : undefined);
    const tm = subj ? model.tables[subj] : undefined;
    const mode = this.settings.softDeleteMode;
    plan.softDelete = undefined;
    if (tm?.softDelete && mode !== "never") {
      const historical = !!plan.timeWindow || plan.dimensions.some((x) => x.kind === "time") || !!plan.comparePeriods;
      const subjectIsRoot = plan.shape === "lookup" ? true : plan.measures.some((m) => m.table === subj);
      if (mode === "always" || (!historical && subjectIsRoot)) {
        plan.softDelete = { table: tm.key, column: tm.softDelete.column, kind: tm.softDelete.kind };
      }
    }
    // snapshot tables (C12): semi-additive measures default to the latest date
    for (const m of plan.measures) {
      const t = model.tables[m.table];
      if (!t.snapshot || m.kind === "count") continue;
      const groupedByDate = plan.dimensions.some((x) => x.kind === "time" && x.column === `${t.key}.${t.snapshot!.dateColumn}`) || plan.dimensions.some((x) => x.column === `${t.key}.${t.snapshot!.dateColumn}`);
      if (!groupedByDate) plan.snapshotLatest = { table: t.key, column: t.snapshot.dateColumn };
    }
  }

  /** Filters on a self-referencing table whose value has children match the whole subtree. */
  private async applyHierarchy(plan: QueryPlan) {
    for (const f of plan.filters) {
      if (f.op !== "eq" && f.op !== "in") continue;
      const [t, c] = splitRef(f.column);
      // containment hierarchies only (parent_id); manager/referrer self-references are not subtrees of a value
      const rel = this.model.relationships.find((r) => r.selfReference && r.from.table === t && /^parent/.test(r.from.columns[0]));
      if (!rel) continue;
      const tm = this.model.tables[t];
      const key = rel.to.columns[0], parent = rel.from.columns[0];
      const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
      try {
        const r = await this.db.query<{ has: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${q(tm.schema)}.${q(tm.name)} ch JOIN ${q(tm.schema)}.${q(tm.name)} p ON ch.${q(parent)} = p.${q(key)} WHERE p.${q(c)}::text = ANY($1::text[])) AS has`,
          [f.values.map(String)],
        );
        if (r.rows[0]?.has) {
          f.hierarchy = { parentColumn: parent, keyColumn: key };
          f.label += " (including its subcategories)";
        }
      } catch {
        /* ignore */
      }
    }
  }

  /** Status value vs related rows (e.g. status = 'refunded' vs has a refund row): always ask. */
  private statusConflict(plan: QueryPlan, pins: Record<string, string>): (Partial<Result> & { outcome: "clarify" }) | undefined {
    for (const f of plan.filters) {
      if ((f.op !== "eq" && f.op !== "in") || f.implied || f.values.length !== 1) continue;
      const [t, c] = splitRef(f.column);
      const cm = this.model.tables[t].columns[c];
      if (cm.role !== "dimension_categorical") continue;
      const v = String(f.values[0]);
      const child = this.model.relationships.find((r) => r.to.table === t && !r.selfReference && stem(this.model.tables[r.from.table].noun) === stem(v));
      if (!child) continue;
      const key = `reading:${f.column}=${v}`;
      const pinned = pins[key];
      if (pinned === "status") return undefined;
      if (pinned === "related") {
        plan.filters = plan.filters.filter((x) => x !== f);
        plan.existence.push({ negated: false, table: child.from.table, filters: [], label: `that have at least one ${this.model.tables[child.from.table].noun}` });
        return undefined;
      }
      const tn = this.model.tables[t].noun, cn = this.model.tables[child.from.table].noun;
      const s = { pins } as Session;
      return this.clarify(s as Session, key, `"${v}" can mean two things here. Which do you mean?`, [
        { key: "status", label: `${capitalize(tn)}s whose ${cm.humanName} is ${v}`, consequence: `${tn} ${cm.humanName} = '${v}'` },
        { key: "related", label: `${capitalize(tn)}s with at least one ${cn} record (including partial)`, consequence: `EXISTS (a row in ${child.from.table})` },
      ], "filter") as Partial<Result> & { outcome: "clarify" };
    }
    return undefined;
  }

  // ==================================================================== gating & clarification

  /**
   * Gating (spec §8.3): plan confidence is the minimum over *load-bearing* decisions — those
   * that change the SQL. For each low-confidence choice, re-run decoding with every runner-up
   * pinned (answers are memoized, so this costs no oracle calls); runner-ups that produce an
   * equivalent plan pool their probability. Only genuinely different readings are asked about.
   */
  private async gate(s: Session, provenance: Record<string, Decision>, plan: QueryPlan, narrative: string): Promise<(Partial<Result> & { outcome: Result["outcome"] }) | undefined> {
    if (s.probe) return undefined;
    const threshold = this.settings.autoExecuteMinConfidence;
    const lb = Object.entries(provenance).filter(([, d]) => d.loadBearing && d.by === "oracle" && d.answer?.type === "choice" && d.confidence < threshold);
    lb.sort((a, b) => a[1].confidence - b[1].confidence);
    const sig0 = planSignature(plan);
    for (const [key, dcs] of lb) {
      const ans = dcs.answer as ChoiceAnswer;
      const pinKey = pinKeyFor(key, dcs);
      if (!pinKey) continue;
      const chosen = String(dcs.value);
      const alts = top(ans, 5).filter((o) => o.key !== chosen && o.key !== "none" && o.key !== "unclear" && o.p >= 0.05);
      // masked decoding (§1): readings that cannot compile (fan-out, unreachable) are illegal and
      // drop out of the distribution; readings that compile to the same plan pool their mass
      let pooled = dcs.confidence;
      let illegal = 0;
      const distinct: { key: string; p: number }[] = [{ key: chosen, p: dcs.confidence }];
      for (const o of alts) {
        const sig = await this.probe(s, pinKey, o.key);
        if (sig === "illegal") illegal += o.p;
        else if (sig !== undefined && sig === sig0) pooled += o.p;
        else distinct.push(o);
      }
      pooled = pooled / Math.max(1e-9, 1 - illegal);
      if (pooled >= threshold || distinct.length < 2) {
        dcs.confidence = Math.max(dcs.confidence, Math.min(1, pooled));
        continue;
      }
      return this.clarify(s, pinKey, `I'm not sure about the ${dcs.about.replace(/_/g, " ")}. Did you mean:`, distinct.slice(0, 4).map((o) => ({ key: o.key, ...this.renderOption(s, dcs.about, o.key, plan) })), dcs.about);
    }
    void narrative;
    return undefined;
  }

  /** Content words of the request that appear nowhere in the schema vocabulary. */
  private ungroundedTerms(request: string): string[] {
    return [...new Set(contentTokens(request))].filter((t) => t.length > 2 && !TIME_WORDS.has(t) && !GENERIC_QUANTITY.has(t) && !this.vocab.has(stem(t)) && !this.vocab.has(t));
  }

  /** Decode again with one decision pinned; returns the resulting plan's signature. */
  private async probe(s: Session, pinKey: string, value: string): Promise<string | undefined> {
    const pins = { ...s.pins, [pinKey]: value };
    delete pins.__pending;
    const ps: Session = { ...s, id: newId("p"), pins, rounds: [], probe: true };
    try {
      const r = await this.run(ps);
      if (r.outcome === "decline" && r.reason?.startsWith("illegal")) return "illegal";
      return r.outcome === "execute" && r.plan ? planSignature(r.plan) : undefined;
    } catch {
      return undefined;
    }
  }

  private renderOption(s: Session, about: string, k: string, plan: QueryPlan): { label: string; consequence: string } {
    const ts = this.timeSettings(s.ctx);
    if (about === "period") return { label: PERIOD_CRITERIA[k as PeriodKey] ?? k, consequence: periodBounds({ key: k as PeriodKey, n: plan.timeWindow?.period.n, start: plan.timeWindow?.period.start }, ts)?.label ?? "" };
    if (about === "time_column") return { label: capitalize(humanRef(this.model, k)), consequence: `filter on ${k}` };
    if (about === "shape") return { label: capitalize(k.replace(/_/g, " ")), consequence: SHAPE_CRITERIA[k] ?? "" };
    if (about === "derived") return { label: k === "none" ? "No extra calculation" : capitalize(k.replace(/_/g, " ")), consequence: (DERIVED_CRITERIA as Record<string, string>)[k] ?? "" };
    if (about === "span_role") {
      const m = /^threshold:(col|sum|count|saved):(.+)$/.exec(k);
      if (m?.[1] === "col" || m?.[1] === "sum") return { label: `${m[1] === "sum" ? "Total " : ""}${humanRef(this.model, m[2])}`, consequence: this.model.tables[splitRef(m[2])[0]]?.columns[splitRef(m[2])[1]]?.description ?? m[2] };
      if (m?.[1] === "count") return { label: `Number of ${this.model.tables[m[2]]?.humanName ?? m[2]}`, consequence: "" };
      return { label: k.replace(/_/g, " "), consequence: "" };
    }
    if (about === "measure") {
      const [, kind, ref] = /^(col|count|dur|saved):(.+)$/.exec(k) ?? [];
      if (kind === "col") return { label: capitalize(humanRef(this.model, ref)), consequence: this.model.tables[splitRef(ref)[0]]?.columns[splitRef(ref)[1]]?.description ?? ref };
      if (kind === "count") return { label: `Number of ${this.model.tables[ref]?.humanName ?? ref}`, consequence: `Counts ${this.model.tables[ref]?.humanName ?? ref} rows` };
      if (kind === "dur") return { label: `Time ${ref.replace(/^[^.]+\./, "").replace(">", " → ")}`, consequence: "Average/median of the difference between two timestamps" };
      if (kind === "saved") return { label: `${capitalize(ref)} (saved definition)`, consequence: "Uses the accepted definition" };
    }
    return { label: k, consequence: "" };
  }

  private clarify(s: Session, pinKey: string, question: string, options: ClarifyOption[], decision?: string): Partial<Result> & { outcome: "clarify" } {
    const id = newId("c");
    s.pins.__pending = pinKey;
    this.sessions.set(id, s);
    return { outcome: "clarify", clarification: { id, decision: decision ?? pinKey.split(":")[0], question, options } };
  }

  private clarifyChoice(s: Session, pinKey: string, question: string, a: ChoiceAnswer | undefined, label: (k: string) => string, consequence: (k: string) => string) {
    const opts = top(a, 4).filter((o) => o.key !== "none").map((o) => ({ key: o.key, label: label(o.key), consequence: consequence(o.key) }));
    return this.clarify(s, pinKey, question, opts);
  }

  private clarifyFromCompile(s: Session, e: CompileError, plan: QueryPlan): Partial<Result> & { outcome: Result["outcome"] } {
    if (e.about === "measure") {
      const issues = e.detail as { measure: Measure; root: string; alternatives: { ref: string; label: string }[] }[];
      const iss = issues[0];
      const dims = plan.dimensions.map((x) => x.label).join(", ");
      const opts: ClarifyOption[] = iss.alternatives.map((a) => ({ key: `col:${a.ref}`, label: capitalize(a.label), consequence: `Adds up ${a.ref} for each ${dims}; each line counts once.` }));
      if (!opts.length) return { outcome: "decline", reason: `${iss.measure.label} can't be split by ${dims} without double counting.` };
      const r = this.clarify(s, "measure", `"${iss.measure.label}" is recorded once per ${this.model.tables[iss.measure.table].noun}, so it can't be split by ${dims} without counting the same amount several times. Use this instead?`, opts, "measure");
      return r;
    }
    if (e.about === "join_path") {
      const amb = (e.detail as Ambiguity[] | undefined)?.[0];
      if (amb) return this.clarify(s, `path:${amb.key}`, `Which ${amb.attribute} do you mean?`, Object.entries(amb.options).map(([k, p]) => ({ key: k, label: pathOptionText(p, amb.attribute), consequence: p.key })), "join_path");
    }
    return { outcome: "decline", reason: e.message };
  }

  // ==================================================================== saved-record helpers

  private fingerprintPlan(plan: QueryPlan): Record<string, string> {
    const refs = new Set<string>();
    for (const m of plan.measures) {
      if (m.column) refs.add(m.column);
      if (m.duration) [m.duration.start, m.duration.end].forEach((r) => refs.add(r));
      for (const f of m.filters ?? []) refs.add(f.column);
    }
    for (const f of plan.filters) refs.add(f.column);
    for (const dd of plan.dimensions) if (dd.column) refs.add(dd.column);
    if (plan.timeWindow) refs.add(plan.timeWindow.column);
    const out: Record<string, string> = {};
    for (const r of refs) {
      const [t, c] = splitRef(r);
      const cm = this.model.tables[t]?.columns[c];
      if (cm) out[r] = cm.type;
    }
    return out;
  }

  private fingerprintValid(r: SavedRecord): boolean {
    for (const [ref, type] of Object.entries(r.fingerprint ?? {})) {
      const [t, c] = splitRef(ref);
      const cm = this.model.tables[t]?.columns[c];
      if (!cm) return false;
      if (type && cm.type !== type && !cm.type.endsWith(`.${type}`) && !type.endsWith(`.${cm.type}`)) return false;
    }
    return true;
  }
}

/** Words the coverage check ignores: time words (handled by the period) and polarity words (handled by filters). */
const TIME_WORDS = new Set(
  ("last this past previous prior current next today yesterday day days week weeks month months quarter quarters year years ytd mtd date dates period time so far now right currently start end beginning " +
    "excluding exclude except without not no never didn't don't doesn't haven't hasn't wasn't weren't including include only other anything something")
    .split(" "),
);

const AGG_WORD: Record<Agg, string> = { sum: "total", avg: "average", median: "median", max: "maximum", min: "minimum", count_rows: "number of", count_distinct: "number of distinct" };

/**
 * What a plan returns, ignoring presentation (shape name, projections, aliases, labels,
 * ordering): two decisions that give the same signature are not load-bearing.
 */
export function planSignature(p: QueryPlan): string {
  const pred = (f: Predicate) => `${f.column}|${f.op}|${JSON.stringify(f.values)}`;
  const meas = (m: Measure) => [m.kind, m.agg, m.table, m.column ?? "", m.duration ? `${m.duration.start}>${m.duration.end}` : "", (m.filters ?? []).map(pred).sort().join("&"), m.period ? `${m.period.bounds.start?.toISOString()}..${m.period.bounds.end?.toISOString()}` : ""].join("/");
  const sig = {
    m: p.measures.filter((m) => !m.hidden).map(meas).sort(),
    d: p.dimensions.map((d) => `${d.kind}|${d.column ?? d.table}|${d.grain ?? ""}`).sort(),
    f: p.filters.map(pred).sort(),
    e: p.existence.map((e) => `${e.negated}|${e.table}|${e.filters.map(pred).sort().join("&")}|${e.timeWindow?.bounds.start?.toISOString()}`).sort(),
    h: p.having ? `${meas(p.having.measure)}|${p.having.op}|${p.having.values.join(",")}` : "",
    w: p.timeWindow ? `${p.timeWindow.column}|${p.timeWindow.bounds.start?.toISOString()}|${p.timeWindow.bounds.end?.toISOString()}` : "",
    j: Object.entries(p.joinPaths).map(([k, v]) => `${k}=${v.join(">")}`).sort(),
    g: p.perGroupLimit?.n ?? "",
    o: p.distinctOn ? `${p.distinctOn.orderColumn}|${p.distinctOn.dir}` : "",
    l: p.limit ?? "",
    x: p.derived?.kind ?? "",
    c: p.comparePeriods ? `${p.comparePeriods.column}|${p.comparePeriods.current.start?.toISOString()}` : "",
    i: p.includeEmptyGroups,
    s: p.softDelete?.table ?? "",
    n: p.snapshotLatest?.table ?? "",
  };
  return JSON.stringify(sig);
}

/** The pin that overrides a decision when the user (or a probe) picks an option. */
function pinKeyFor(key: string, d: Decision): string | undefined {
  if (["shape", "measure_agg", "period", "subject", "time_column", "derived", "measure"].includes(key)) return key;
  if (key.startsWith("path:")) return key;
  if (key.startsWith("filter_")) return `filter:${key.slice(7)}`;
  if (key.startsWith("role_")) return `role:${key.slice(5)}`;
  void d;
  return undefined;
}

/** Words a request may use for a quantity without naming a business term. */
const GENERIC_QUANTITY = new Set(
  ("value values amount amounts total totals sum spent spend spending cost costs price prices count counts number numbers units unit quantity " +
    "average mean median growth change share rate size sold sell bought buy placed made led get got did come came have had many much most least " +
    "fewest top bottom highest lowest best worst biggest smallest new recent latest first last each per show list give find which what").split(" "),
);

/** Stems of every name, description word, synonym and known value in the schema. */
function schemaVocabulary(model: SchemaModel): Set<string> {
  const v = new Set<string>([...Object.keys(MONTH_NAMES), ...Object.values(US_STATES).flatMap((x) => x.toLowerCase().split(" ")), ...Object.values(COUNTRIES).flatMap((x) => x.toLowerCase().split(" "))]);
  const add = (text: string) => {
    for (const t of contentTokens(text)) {
      v.add(t);
      v.add(stem(t));
    }
  };
  for (const t of Object.values(model.tables)) {
    add(`${t.name} ${t.humanName} ${t.noun} ${t.description} ${t.synonyms.join(" ")}`);
    for (const c of Object.values(t.columns)) {
      add(`${c.name.replace(/_/g, " ")} ${c.humanName} ${c.description} ${c.synonyms.join(" ")}`);
      for (const val of c.values ?? []) if (val.length <= 40) add(val.replace(/_/g, " "));
    }
  }
  return v;
}

function planConfidence(p: Record<string, Decision>): number {
  const lb = Object.values(p).filter((d) => d.loadBearing);
  return lb.length ? Math.min(...lb.map((d) => d.confidence)) : 1;
}

function defaultLookupColumns(model: SchemaModel, table: string): string[] {
  const t = model.tables[table];
  const out = [...t.primaryKey, ...Object.values(t.columns).filter((c) => c.isUnique && c.kind === "text" && !c.pii && c.searchable).map((c) => c.name), ...t.display];
  if (t.defaultTime) out.push(t.defaultTime);
  return [...new Set(out)].map((c) => `${table}.${c}`);
}

export { AGGS, contentTokens, STOPWORDS, isMeasureRole, isTimeKind };
export type { ColumnModel, MeasureCandidate };
