/**
 * TypeScript port of nlsql-testbed/eval/harness.py: same normalization and comparison
 * rules, but runs through any `Db` (PGlite or node-postgres), so no psql is needed.
 */
import type { Db } from "../db/types.js";

export interface EvalCase {
  id: string;
  request: string;
  blocks: string[];
  outcomes: ("execute" | "clarify" | "decline")[];
  clarify_on?: string;
  compare?: "unordered" | "ordered" | "keys";
  key?: string;
  gold?: string[];
  must_not?: string[];
  saved?: string;
  context?: string;
  notes?: string;
}

export interface CaseResult {
  id: string;
  outcome: "execute" | "clarify" | "decline";
  sql?: string;
  params?: unknown[];
  about?: string;
}

export type Row = (string | number | null)[];

export const PRELUDE = ["SET search_path = shop", "SET TIME ZONE 'UTC'", "SET IntervalStyle = 'postgres'"];

export async function runSql(db: Db, sql: string, params: unknown[] = []): Promise<{ columns: string[]; rows: Row[] }> {
  for (const s of PRELUDE) await db.query(s);
  const r = await db.query<Record<string, unknown>>(sql, params);
  const columns = r.fields.map((f) => f.name);
  const rows = r.rows.map((row) => {
    const vals = Object.values(row);
    return (vals.length === columns.length ? vals : columns.map((c) => row[c])).map(norm);
  });
  return { columns, rows };
}

const INTERVAL = /^(?:(-?\d+) years? ?)?(?:(-?\d+) mons? ?)?(?:(-?\d+) days? ?)?(?:(-?)(\d+):(\d\d):(\d\d(?:\.\d+)?))?$/;

export function norm(v: unknown): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? "t" : "f";
  if (v instanceof Date) {
    const iso = v.toISOString();
    if (iso.endsWith("T00:00:00.000Z")) return iso.slice(0, 10);
    return iso.replace("T", " ").replace(/\.000Z$/, "+00").replace(/Z$/, "+00");
  }
  if (typeof v === "object") {
    // PGlite interval objects
    const o = v as Record<string, number>;
    if ("days" in o || "hours" in o || "minutes" in o || "seconds" in o || "months" in o) {
      const secs = ((o.years ?? 0) * 365 + (o.months ?? 0) * 30 + (o.days ?? 0)) * 86400 + (o.hours ?? 0) * 3600 + (o.minutes ?? 0) * 60 + (o.seconds ?? 0) + (o.milliseconds ?? 0) / 1000;
      return Math.round(secs);
    }
    return JSON.stringify(v);
  }
  const s = String(v);
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return Math.round(Number(s) * 100) / 100;
  const ts = /^(\d{4}-\d\d-\d\d)(?: 00:00:00(?:\+00)?)?$/.exec(s);
  if (ts) return ts[1];
  const m = INTERVAL.exec(s);
  if (m && m.slice(1).some(Boolean)) {
    const [, y, mo, d, neg, hh, mm, ss] = m;
    let secs = ((+(y ?? 0)) * 365 + (+(mo ?? 0)) * 30 + (+(d ?? 0))) * 86400;
    if (hh) {
      const t = +hh * 3600 + +mm * 60 + parseFloat(ss);
      secs += neg ? -t : t;
    }
    return Math.round(secs);
  }
  return s;
}

const repr = (r: Row) => JSON.stringify(r);

export function match(c: EvalCase, gold: { columns: string[]; rows: Row[] }, got: { columns: string[]; rows: Row[] }): boolean {
  const mode = c.compare ?? "unordered";
  if (mode === "keys") {
    const ki = gold.columns.indexOf(c.key!);
    const want = gold.rows.map((r) => String(r[ki])).sort();
    for (let j = 0; j < got.columns.length; j++) {
      const have = got.rows.map((r) => String(r[j])).sort();
      if (have.length === want.length && have.every((x, i) => x === want[i])) return true;
    }
    return false;
  }
  if (mode === "ordered") return got.rows.length === gold.rows.length && got.rows.every((r, i) => repr(r) === repr(gold.rows[i]));
  const a = gold.rows.map(repr).sort();
  const b = got.rows.map(repr).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface CheckOutcome {
  id: string;
  ok: boolean;
  why: string;
  blocks: string[];
}

/** Score one result against a case (gold answers computed live on `db`). */
export async function checkCase(db: Db, c: EvalCase, r: CaseResult, goldCache = new Map<string, { columns: string[]; rows: Row[] }[]>()): Promise<CheckOutcome> {
  let ok = false;
  let why = "";
  if (!c.outcomes.includes(r.outcome)) why = `outcome ${r.outcome} not in [${c.outcomes.join(", ")}]`;
  else if (r.outcome === "clarify") {
    ok = c.clarify_on === undefined || c.clarify_on === r.about || c.outcomes.includes("execute");
    why = ok ? "" : `clarified about ${r.about}, expected ${c.clarify_on}`;
  } else if (r.outcome === "decline") ok = true;
  else {
    try {
      const got = await runSql(db, r.sql!, r.params);
      let golds = goldCache.get(c.id);
      if (!golds) {
        golds = [];
        for (const g of c.gold ?? []) golds.push(await runSql(db, g));
        goldCache.set(c.id, golds);
      }
      let bad = false;
      for (const b of c.must_not ?? []) if (match(c, await runSql(db, b), got)) bad = true;
      const good = golds.some((g) => match(c, g, got));
      ok = good && !bad;
      why = bad ? "matches a known-wrong answer" : good ? "" : "result differs from gold";
    } catch (e) {
      why = `SQL error: ${(e as Error).message}`;
    }
  }
  return { id: c.id, ok, why, blocks: c.blocks };
}
