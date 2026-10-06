import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Composer, type Result } from "../composer.js";
import type { ComposerConfig } from "../config.js";
import type { Db } from "../db/types.js";
import type { Oracle } from "../oracle/types.js";
import { measureFromSaved } from "../plan/build.js";
import { emptyPlan, type QueryPlan } from "../plan/types.js";
import { MemoryStore } from "../saved/store.js";
import type { SavedMeasure, SavedPlan, SavedRecord } from "../saved/types.js";
import type { SchemaModel } from "../schema/model.js";
import { splitRef } from "../schema/model.js";
import { JoinGraph } from "../joins/graph.js";
import { periodBounds, type PeriodKey } from "../time/periods.js";
import { checkCase, runSql, setSearchPath, type CaseResult, type CheckOutcome, type EvalCase } from "./harness.js";

export interface EvalReport {
  passed: number;
  total: number;
  outcomes: (CheckOutcome & { outcome: string; about?: string; ms: number; questions: number; narrative?: string; sql?: string })[];
  weakBlocks: { block: string; passed: number; total: number }[];
}

/** Cases from <dir>/cases.yaml (benchmarks) or <dir>/eval/cases.yaml (testbed). */
export function loadCases(testbedDir: string): EvalCase[] {
  const p = existsSync(join(testbedDir, "cases.yaml")) ? join(testbedDir, "cases.yaml") : join(testbedDir, "eval", "cases.yaml");
  return (parse(readFileSync(p, "utf8")) as { cases: EvalCase[] }).cases;
}

/** Convert eval/saved_fixtures.yaml into SavedRecords for a model. */
export function loadFixtures(testbedDir: string, model: SchemaModel): Record<string, SavedRecord[]> {
  const fx = join(testbedDir, "eval", "saved_fixtures.yaml");
  if (!existsSync(fx)) return {};
  const raw = (parse(readFileSync(fx, "utf8")) as { fixtures: Record<string, Record<string, unknown>[]> }).fixtures;
  const out: Record<string, SavedRecord[]> = {};
  const resolve = (name: string): SavedRecord[] => {
    if (out[name]) return out[name];
    const recs: SavedRecord[] = [];
    for (const item of raw[name] ?? []) {
      if (item.include) {
        recs.push(...resolve(String(item.include)));
        continue;
      }
      const common = {
        scope: item.scope as "org",
        status: item.status as "canonical",
        acceptedBy: String(item.accepted_by),
        acceptedAt: String(item.accepted_at),
        narrative: String(item.narrative ?? ""),
        fingerprint: (item.schema_fingerprint as Record<string, string>) ?? {},
      };
      if (item.kind === "measure") {
        const def = item.definition as Record<string, unknown>;
        recs.push({
          ...common,
          id: `${name}:${item.name}`,
          kind: "measure",
          name: String(item.name),
          phrases: (item.phrases as string[]) ?? [],
          definition: { agg: def.agg as "sum", column: def.column as string, unit: def.unit as string, row_filters: (def.row_filters as SavedMeasure["definition"]["row_filters"]) ?? [] },
        });
      } else if (item.kind === "plan") {
        const measures = recs.filter((r): r is SavedMeasure => r.kind === "measure");
        recs.push({
          ...common,
          id: `${name}:plan`,
          kind: "plan",
          request: String(item.request),
          plan: fixturePlan(item.plan as Record<string, unknown>, model, measures),
          slots: (item.slots as SavedPlan["slots"]) ?? [],
          pinned: {},
        });
      }
    }
    out[name] = recs;
    return recs;
  };
  for (const name of Object.keys(raw)) resolve(name);
  return out;
}

function fixturePlan(p: Record<string, unknown>, model: SchemaModel, measures: SavedMeasure[]): QueryPlan {
  const plan = emptyPlan();
  plan.shape = p.shape as QueryPlan["shape"];
  plan.measures = ((p.measures as Record<string, string>[]) ?? []).map((m) => {
    const s = measures.find((x) => x.name === m.saved_measure)!;
    return measureFromSaved(model, s, m.alias);
  });
  plan.dimensions = ((p.dimensions as { column: string }[]) ?? []).map((d) => {
    const [t, c] = splitRef(d.column);
    const tm = model.tables[t];
    return tm.display.includes(c) ? { alias: tm.name, label: tm.noun, kind: "entity" as const, table: t } : { alias: c, label: `${tm.noun} ${c}`, kind: "column" as const, column: d.column, table: t };
  });
  // joins → pinned relationship chain (from the measure's table to the dimension table)
  const joins = (p.joins as { from: string; to: string }[]) ?? [];
  const relIds = joins
    .map((j) => model.relationships.find((r) => `${r.from.table}.${r.from.columns[0]}` === j.from && `${r.to.table}.${r.to.columns[0]}` === j.to)?.id)
    .filter((x): x is string => !!x);
  const graph = new JoinGraph(model);
  for (const d of plan.dimensions) {
    const root = plan.measures[0]?.table;
    if (!root) continue;
    const path = graph.bestPaths(root, d.table).find((pp) => pp.steps.every((st) => relIds.includes(st.rel.id)));
    if (path && path.steps.length > 1) {
      // pin the divergent tail as "<from>-><to>" exactly like a clarification answer would
      const tail = path.steps.slice(1);
      plan.joinPaths[`${tail[0].from}->${d.table}`] = tail.map((st) => st.rel.id);
    }
  }
  const tw = p.timeWindow as { column: string; period: PeriodKey } | undefined;
  if (tw) {
    const ts = { asOf: new Date(), timezone: "UTC", weekStart: "monday" as const };
    plan.timeWindow = { column: tw.column, period: { key: tw.period }, bounds: periodBounds({ key: tw.period }, ts)! };
  }
  plan.order = ((p.order as { measure: string; dir: "asc" | "desc" }[]) ?? []).map((o) => ({ ref: o.measure, kind: "measure", dir: o.dir }));
  return plan;
}

export interface RunEvalOptions {
  db: Db;
  oracle: Oracle;
  testbedDir: string;
  config?: ComposerConfig;
  model?: SchemaModel;
  only?: string[];
  /** search_path for unqualified gold SQL (default "shop" for the testbed) */
  searchPath?: string;
  onCase?: (o: EvalReport["outcomes"][number]) => void;
}

/** Run every gold query; report row counts and ties at a LIMIT boundary (which make keys/ordered compares flaky). */
export async function verifyGold(db: Db, testbedDir: string, searchPath = "shop"): Promise<{ id: string; ok: boolean; note: string }[]> {
  process.env.TZ = "UTC";
  setSearchPath(searchPath);
  const out: { id: string; ok: boolean; note: string }[] = [];
  for (const c of loadCases(testbedDir)) {
    if (c.outcomes.includes("execute") && !c.gold?.length) {
      out.push({ id: c.id, ok: false, note: "execute allowed but no gold" });
      continue;
    }
    for (const [i, g] of (c.gold ?? []).entries()) {
      try {
        const r = await runSql(db, g);
        let note = `${r.rows.length} rows${r.rows.length === 1 ? ` e.g. ${JSON.stringify(r.rows[0])}` : ""}`;
        let ok = r.rows.length > 0 && !r.rows.every((row) => row.every((v) => v === null));
        const lim = /LIMIT (\d+)\s*$/i.exec(g);
        if (lim) {
          const unlimited = await runSql(db, g.replace(/LIMIT \d+\s*$/i, `LIMIT ${Number(lim[1]) + 1}`));
          const last = r.rows[r.rows.length - 1], next = unlimited.rows[r.rows.length];
          if (last && next && JSON.stringify(last.slice(-1)) === JSON.stringify(next.slice(-1))) {
            ok = false;
            note += " — TIE at the LIMIT boundary";
          }
        }
        out.push({ id: `${c.id}${c.gold!.length > 1 ? `[${i}]` : ""}`, ok, note });
      } catch (e) {
        out.push({ id: c.id, ok: false, note: `ERROR ${(e as Error).message}` });
      }
    }
  }
  return out;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  // PGlite parses "timestamp without time zone" in the process timezone; compare in UTC
  process.env.TZ = "UTC";
  setSearchPath(opts.searchPath ?? "shop");
  const cases = loadCases(opts.testbedDir).filter((c) => !opts.only?.length || opts.only.includes(c.id));
  const base = await Composer.create({ db: opts.db, oracle: opts.oracle, config: opts.config, model: opts.model });
  const fixtures = loadFixtures(opts.testbedDir, base.model);
  const results = new Map<string, Result>();
  const outcomes: EvalReport["outcomes"] = [];
  const goldCache = new Map();
  for (const c of cases) {
    const store = new MemoryStore(c.saved ? structuredClone(fixtures[c.saved] ?? []) : []);
    const composer = await Composer.create({ db: opts.db, oracle: opts.oracle, config: opts.config, model: base.model, store });
    const t0 = Date.now();
    let res: Result;
    let cr: CaseResult;
    try {
      res = await composer.compose(c.request, { conversation: c.context ? results.get(c.context) : undefined });
      results.set(c.id, res);
      cr = { id: c.id, outcome: res.outcome, sql: res.sql, params: res.params, about: res.clarification?.decision };
    } catch (e) {
      cr = { id: c.id, outcome: "decline", about: `error: ${(e as Error).message}` };
      res = { outcome: "decline", reason: (e as Error).stack } as Result;
    }
    const chk = await checkCase(opts.db, c, cr, goldCache);
    const o = { ...chk, outcome: cr.outcome, about: cr.about, ms: Date.now() - t0, questions: (res.rounds ?? []).reduce((a, r) => a + r.questions, 0), narrative: res.narrative ?? res.reason ?? res.clarification?.question, sql: res.sql };
    outcomes.push(o);
    opts.onCase?.(o);
  }
  const byBlock = new Map<string, [number, number]>();
  for (const o of outcomes) for (const b of o.blocks) {
    const t = byBlock.get(b) ?? [0, 0];
    t[0] += o.ok ? 1 : 0;
    t[1] += 1;
    byBlock.set(b, t);
  }
  const weakBlocks = [...byBlock].filter(([, [p, t]]) => p < t).map(([block, [passed, total]]) => ({ block, passed, total })).sort((a, b) => a.passed / a.total - b.passed / b.total);
  return { passed: outcomes.filter((o) => o.ok).length, total: outcomes.length, outcomes, weakBlocks };
}
