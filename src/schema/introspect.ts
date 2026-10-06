import type { Db } from "../db/types.js";
import { snake } from "../nl/lexicon.js";

/** Raw, uninterpreted catalog facts (spec §2.1). Conventions turn this into a SchemaModel. */
export interface RawCatalog {
  schemas: string[];
  tables: RawTable[];
  constraints: RawConstraint[];
  enums: Record<string, string[]>;
  stats: RawStat[];
  extensions: string[];
  trigramIndexed: string[];
  /** "schema.table.start>end" → fraction of sampled rows where end >= start */
  durationOrder?: Record<string, number>;
  /** "schema.table.column" → complete distinct values for small / low-cardinality text columns */
  distinctValues?: Record<string, string[]>;
}

export interface RawTable {
  schema: string;
  name: string;
  kind: "table" | "view" | "matview";
  comment: string | null;
  rowEstimate: number;
  rls: boolean;
  columns: RawColumn[];
}

export interface RawColumn {
  name: string;
  type: string;
  typeName: string;
  typeCategory: string;
  isEnum: boolean;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  comment: string | null;
  position: number;
}

export interface RawConstraint {
  schema: string;
  table: string;
  name: string;
  type: "p" | "f" | "u" | "c";
  columns: string[];
  refSchema?: string;
  refTable?: string;
  refColumns?: string[];
  definition: string;
}

export interface RawStat {
  schema: string;
  table: string;
  column: string;
  nullFrac: number;
  avgWidth: number;
  nDistinct: number;
  mostCommonVals: string[] | null;
  mostCommonFreqs: number[] | null;
}

export interface IntrospectOptions {
  schemas?: string[];
  excludeTables?: string[];
  /** Sample with TABLESAMPLE when pg_stats is empty (opt-in, §2.1). */
  sampleWhenNoStats?: boolean;
  /** Check lifecycle ordering of timestamp pairs on a small sample (C5). */
  checkDurationOrder?: boolean;
  /**
   * Read complete distinct values of text columns when the table has at most this many
   * rows and pg_stats shows ≤ 200 distinct values (or the table is tiny). 0 disables.
   */
  valueScanMaxRows?: number;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export async function introspect(db: Db, opts: IntrospectOptions = {}): Promise<RawCatalog> {
  let schemas = opts.schemas;
  if (!schemas?.length) {
    const r = await db.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
        WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast','composer')
          AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%'
          AND EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = pg_namespace.oid AND c.relkind IN ('r','p','v','m'))`,
    );
    schemas = r.rows.map((x) => x.nspname);
  }
  const exclude = new Set(opts.excludeTables ?? []);

  const tablesR = await db.query<{
    schema: string; name: string; relkind: string; comment: string | null; reltuples: number; rls: boolean;
  }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
            obj_description(c.oid, 'pg_class') AS comment, c.reltuples::float8 AS reltuples, c.relrowsecurity AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p','v','m') AND NOT c.relispartition
      ORDER BY n.nspname, c.relname`,
    [schemas],
  );

  const colsR = await db.query<{
    schema: string; table: string; name: string; type: string; typname: string; typcategory: string; typtype: string;
    notnull: boolean; hasdefault: boolean; generated: string; comment: string | null; attnum: number;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type, t.typname, t.typcategory::text AS typcategory, t.typtype::text AS typtype,
            a.attnotnull AS notnull, a.atthasdef AS hasdefault, a.attgenerated::text AS generated,
            col_description(c.oid, a.attnum) AS comment, a.attnum::int AS attnum
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p','v','m') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY n.nspname, c.relname, a.attnum`,
    [schemas],
  );

  const consR = await db.query<{
    schema: string; table: string; name: string; contype: string; cols: string[]; refschema: string | null;
    reftable: string | null; refcols: string[] | null; def: string;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype::text AS contype,
            ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS cols,
            rn.nspname AS refschema, rc.relname AS reftable,
            CASE WHEN con.confrelid <> 0 THEN ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) END AS refcols,
            pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class rc ON rc.oid = con.confrelid
       LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND con.contype IN ('p','f','u','c')`,
    [schemas],
  );

  // Unique indexes also make columns unique (not only constraints).
  const uidxR = await db.query<{ schema: string; table: string; name: string; cols: string[] }>(
    `SELECT n.nspname AS schema, c.relname AS table, ic.relname AS name,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n, o)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o) AS cols
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL AND i.indexprs IS NULL`,
    [schemas],
  );

  const enumR = await db.query<{ typname: string; label: string }>(
    `SELECT t.typname, e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY t.typname, e.enumsortorder`,
  );

  const statsR = await db.query<{
    schema: string; table: string; column: string; null_frac: number; avg_width: number; n_distinct: number;
    mcv: string | null; mcf: number[] | null;
  }>(
    `SELECT schemaname AS schema, tablename AS table, attname AS column, null_frac::float8 AS null_frac,
            avg_width::int AS avg_width, n_distinct::float8 AS n_distinct,
            most_common_vals::text AS mcv, most_common_freqs::float8[] AS mcf
       FROM pg_stats WHERE schemaname = ANY($1::text[])`,
    [schemas],
  );

  const extR = await db.query<{ extname: string }>(`SELECT extname FROM pg_extension`);

  let trigramIndexed: string[] = [];
  if (extR.rows.some((e) => e.extname === "pg_trgm")) {
    const t = await db.query<{ ref: string }>(
      `SELECT n.nspname || '.' || c.relname || '.' || a.attname AS ref
         FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
         JOIN pg_opclass oc ON oc.oid = ANY(i.indclass)
        WHERE oc.opcname IN ('gin_trgm_ops','gist_trgm_ops') AND n.nspname = ANY($1::text[])`,
      [schemas],
    );
    trigramIndexed = t.rows.map((r) => r.ref);
  }

  const enums: Record<string, string[]> = {};
  for (const e of enumR.rows) (enums[e.typname] ??= []).push(e.label);

  const tables: RawTable[] = tablesR.rows
    .filter((t) => !exclude.has(t.name) && !exclude.has(`${t.schema}.${t.name}`))
    .map((t) => ({
      schema: t.schema,
      name: t.name,
      kind: t.relkind === "v" ? "view" : t.relkind === "m" ? "matview" : "table",
      comment: t.comment,
      rowEstimate: Math.max(0, Number(t.reltuples)),
      rls: t.rls,
      columns: colsR.rows
        .filter((c) => c.schema === t.schema && c.table === t.name)
        .map((c) => ({
          name: c.name,
          type: c.type,
          typeName: c.typname,
          typeCategory: c.typcategory,
          isEnum: c.typtype === "e",
          notNull: c.notnull,
          hasDefault: c.hasdefault,
          generated: !!c.generated,
          comment: c.comment,
          position: c.attnum,
        })),
    }));

  const constraints: RawConstraint[] = [
    ...consR.rows.map((c) => ({
      schema: c.schema,
      table: c.table,
      name: c.name,
      type: c.contype as RawConstraint["type"],
      columns: c.cols,
      refSchema: c.refschema ?? undefined,
      refTable: c.reftable ?? undefined,
      refColumns: c.refcols ?? undefined,
      definition: c.def,
    })),
    ...uidxR.rows.map((u) => ({ schema: u.schema, table: u.table, name: u.name, type: "u" as const, columns: u.cols, definition: "UNIQUE INDEX" })),
  ];

  const stats: RawStat[] = statsR.rows.map((s) => ({
    schema: s.schema,
    table: s.table,
    column: s.column,
    nullFrac: Number(s.null_frac),
    avgWidth: Number(s.avg_width),
    nDistinct: Number(s.n_distinct),
    mostCommonVals: s.mcv ? parsePgArray(s.mcv) : null,
    mostCommonFreqs: s.mcf,
  }));

  const raw: RawCatalog = { schemas, tables, constraints, enums, stats, extensions: extR.rows.map((e) => e.extname), trigramIndexed };

  if (opts.sampleWhenNoStats) await sampleMissingStats(db, raw);
  if (opts.checkDurationOrder !== false) raw.durationOrder = await checkDurationOrder(db, raw);
  if ((opts.valueScanMaxRows ?? 200_000) > 0) raw.distinctValues = await scanDistinctValues(db, raw, opts.valueScanMaxRows ?? 200_000);
  return raw;
}

/** Opt-in fallback: approximate pg_stats for text columns from TABLESAMPLE SYSTEM (1). */
async function sampleMissingStats(db: Db, raw: RawCatalog) {
  for (const t of raw.tables) {
    if (t.kind !== "table") continue;
    for (const c of t.columns) {
      if (c.typeCategory !== "S") continue;
      if (raw.stats.some((s) => s.schema === t.schema && s.table === t.name && s.column === c.name)) continue;
      const r = await db.query<{ v: string | null; n: number; total: number }>(
        `WITH s AS (SELECT ${q(c.name)}::text AS v FROM ${q(t.schema)}.${q(t.name)} TABLESAMPLE SYSTEM (1) LIMIT 5000)
         SELECT v, count(*)::int AS n, (SELECT count(*)::int FROM s) AS total FROM s GROUP BY v ORDER BY n DESC LIMIT 60`,
      );
      if (!r.rows.length) continue;
      const total = r.rows[0].total || 1;
      const nonNull = r.rows.filter((x) => x.v !== null);
      raw.stats.push({
        schema: t.schema,
        table: t.name,
        column: c.name,
        nullFrac: (r.rows.find((x) => x.v === null)?.n ?? 0) / total,
        avgWidth: nonNull.reduce((a, x) => a + (x.v?.length ?? 0), 0) / Math.max(1, nonNull.length),
        nDistinct: nonNull.length < 60 ? nonNull.length : -nonNull.length / total,
        mostCommonVals: nonNull.map((x) => x.v as string),
        mostCommonFreqs: nonNull.map((x) => x.n / total),
      });
    }
  }
}

async function scanDistinctValues(db: Db, raw: RawCatalog, maxRows: number): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of raw.tables) {
    if (t.kind === "view" || t.rowEstimate > maxRows) continue;
    for (const c of t.columns) {
      if (c.typeCategory !== "S" && !c.isEnum) continue;
      if (c.isEnum) continue;
      const st = raw.stats.find((s) => s.schema === t.schema && s.table === t.name && s.column === c.name);
      const nd = st ? (st.nDistinct >= 0 ? st.nDistinct : -st.nDistinct * t.rowEstimate) : t.rowEstimate;
      const tiny = t.rowEstimate <= 500;
      if (!tiny && (nd > 200 || (st?.mostCommonVals && st.mostCommonVals.length >= nd))) continue;
      if (st && st.avgWidth > 80) continue;
      try {
        const r = await db.query<{ v: string }>(
          `SELECT DISTINCT ${q(c.name)}::text AS v FROM ${q(t.schema)}.${q(t.name)} WHERE ${q(c.name)} IS NOT NULL LIMIT 501`,
        );
        if (r.rows.length <= 500) out[`${t.schema}.${t.name}.${c.name}`] = r.rows.map((x) => x.v).sort();
      } catch {
        /* no access */
      }
    }
  }
  return out;
}

const LIFECYCLE: string[][] = [
  ["placed", "ordered", "submitted", "paid", "shipped", "delivered", "returned"],
  ["opened", "first_response", "responded", "acknowledged", "resolved", "closed"],
  ["started", "ended", "finished", "completed"],
  ["created", "started", "completed"],
  ["requested", "approved", "fulfilled"],
  ["hired", "terminated"],
  ["launched", "discontinued"],
  ["issued", "sent", "viewed", "due", "paid"],
  ["submitted", "reviewed", "approved", "rejected"],
  ["scheduled", "started", "completed"],
  ["signed_up", "activated", "churned", "cancelled"],
  ["trial_started", "trial_ended", "converted"],
  ["applied", "interviewed", "offered", "hired"],
];

const NOT_EVENT = /^(updated|modified|changed|deleted|archived|discarded|removed)_(at|on)$|_(synced|loaded|imported|refreshed)_at$/;

/** Other ordered pairs worth confirming by sampling (any two event timestamps, both directions). */
export function samplePairs(cols: string[]): [string, string][] {
  const ev = cols.filter((c) => !NOT_EVENT.test(snake(c)));
  if (ev.length > 5) return [];
  const known = new Set(lifecyclePairs(ev).map(([a, b]) => `${a}>${b}`));
  const out: [string, string][] = [];
  for (const a of ev) for (const b of ev) if (a !== b && !known.has(`${a}>${b}`) && !known.has(`${b}>${a}`)) out.push([a, b]);
  return out;
}

function stage(col: string): { seq: number; pos: number } | undefined {
  const base = snake(col).replace(/_(at|on|date|time|ts)$/, "");
  for (let s = 0; s < LIFECYCLE.length; s++) {
    const pos = LIFECYCLE[s].indexOf(base);
    if (pos >= 0) return { seq: s, pos };
  }
  return undefined;
}

/** Candidate (start, end) lifecycle pairs on the same row (C5). */
export function lifecyclePairs(cols: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const a of cols) {
    for (const b of cols) {
      if (a === b) continue;
      const sa = stage(a), sb = stage(b);
      if (sa && sb && sa.seq === sb.seq && sb.pos > sa.pos) out.push([a, b]);
    }
  }
  return out;
}

async function checkDurationOrder(db: Db, raw: RawCatalog): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of raw.tables) {
    const timeCols = t.columns.filter((c) => c.typeCategory === "D").map((c) => c.name);
    for (const [a, b] of [...lifecyclePairs(timeCols), ...samplePairs(timeCols)]) {
      try {
        const r = await db.query<{ ok: number | null }>(
          `SELECT avg(CASE WHEN ${q(b)} >= ${q(a)} THEN 1 ELSE 0 END)::float8 AS ok
             FROM (SELECT ${q(a)}, ${q(b)} FROM ${q(t.schema)}.${q(t.name)}
                    WHERE ${q(a)} IS NOT NULL AND ${q(b)} IS NOT NULL LIMIT 500) s`,
        );
        if (r.rows[0]?.ok != null) out[`${t.schema}.${t.name}.${a}>${b}`] = Number(r.rows[0].ok);
      } catch {
        /* view without access etc. */
      }
    }
  }
  return out;
}

/** Parse a Postgres array literal like {a,"b c",NULL} into strings. */
export function parsePgArray(s: string): string[] {
  const out: string[] = [];
  if (!s.startsWith("{") || !s.endsWith("}")) return out;
  const body = s.slice(1, -1);
  let i = 0;
  while (i < body.length) {
    let v = "";
    if (body[i] === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        v += body[i++];
      }
      i++;
      out.push(v);
    } else {
      while (i < body.length && body[i] !== ",") v += body[i++];
      if (v !== "NULL") out.push(v);
    }
    if (body[i] === ",") i++;
  }
  return out;
}
