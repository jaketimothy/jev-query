import type { Db } from "../db/types.js";
import type { ColumnModel, SchemaModel } from "../schema/model.js";
import { contentTokens, singular, stem, STOPWORDS, valueAliases } from "./lexicon.js";
import type { Span } from "./spans.js";

/** A (column, canonical value) candidate found in the request (spec §4.2). */
export interface ValueLink {
  id: string;
  column: string; // table.column
  value: string;
  matchedText: string;
  start: number;
  end: number;
  /** 1 = exact (case-insensitive) match of the full value or an alias; < 1 = fuzzy */
  sim: number;
  via: "value" | "alias" | "stem" | "search";
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Link request text to known column values. In-memory over introspected values
 * (enum labels, CHECK lists, pg_stats / scanned values), then — for proper nouns and
 * quoted strings with no exact hit — a direct query on searchable text columns.
 */
export async function linkValues(request: string, spans: Span[], model: SchemaModel, db?: Db, tables?: string[]): Promise<ValueLink[]> {
  const links: ValueLink[] = [];
  const lower = request.toLowerCase();
  const inScope = (t: string) => !tables || tables.includes(t);

  for (const t of Object.values(model.tables)) {
    if (t.hidden || !inScope(t.key)) continue;
    for (const c of Object.values(t.columns)) {
      if (!c.values?.length || c.hidden || c.role === "free_text") continue;
      for (const v of c.values) {
        const forms: [string, ValueLink["via"]][] = [[v, "value"], ...valueAliases(c.name, v).map((a) => [a, "alias"] as [string, ValueLink["via"]])];
        for (const [form, via] of forms) {
          const f = form.trim();
          if (f.length < 2) continue;
          if (f.length < 3 && via === "value" && !/^[A-Z0-9]{2}$/.test(f)) continue;
          // short codes (UT, NV) only match when written in capitals as a separate token
          const caseSensitive = /^[A-Z0-9]{1,3}$/.test(f);
          const re = new RegExp(`(?<![\\w/-])${escapeRe(caseSensitive ? f : f.toLowerCase())}(?![\\w/-])`, caseSensitive ? "g" : "g");
          for (const m of (caseSensitive ? request : lower).matchAll(re)) {
            if (STOPWORDS.has(f.toLowerCase()) && !caseSensitive) continue;
            links.push({ id: "", column: `${t.key}.${c.name}`, value: v, matchedText: request.slice(m.index!, m.index! + f.length), start: m.index!, end: m.index! + f.length, sim: 1, via });
          }
        }
        // stem match for single-word categorical values ("refunds" ~ refunded, "cancellations" no)
        if (/^[a-z_]+$/i.test(v) && v.length >= 4 && c.role === "dimension_categorical") {
          const vs = stem(v.replace(/_/g, " "));
          for (const m of lower.matchAll(/[a-z]+/g)) {
            if (m[0] === v.toLowerCase() || m[0].length < 4) continue;
            if (stem(m[0]) === vs) links.push({ id: "", column: `${t.key}.${c.name}`, value: v, matchedText: request.slice(m.index!, m.index! + m[0].length), start: m.index!, end: m.index! + m[0].length, sim: 0.85, via: "stem" });
          }
        }
      }
    }
  }

  // Direct search for proper nouns / quoted strings with no exact hit.
  if (db) {
    for (const sp of spans) {
      if (sp.type !== "proper_noun" && sp.type !== "quoted") continue;
      if (links.some((l) => l.sim === 1 && l.start <= sp.start && l.end >= sp.end)) continue;
      for (const t of Object.values(model.tables)) {
        if (t.hidden || !inScope(t.key) || t.kind === "view") continue;
        for (const c of Object.values(t.columns)) {
          if (!c.searchable || c.values?.length) continue;
          try {
            const r = await db.query<{ v: string }>(
              `SELECT DISTINCT ${q(c.name)}::text AS v FROM ${q(t.schema)}.${q(t.name)} WHERE ${q(c.name)}::text ILIKE $1 LIMIT 20`,
              [`%${sp.text.replace(/[\\%_]/g, (x) => `\\${x}`)}%`],
            );
            for (const row of r.rows) {
              const exact = row.v.toLowerCase() === sp.text.toLowerCase();
              links.push({ id: "", column: `${t.key}.${c.name}`, value: row.v, matchedText: sp.text, start: sp.start, end: sp.end, sim: exact ? 1 : sp.text.length / row.v.length, via: "search" });
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  // Drop candidates whose span sits strictly inside a longer exact match ("West" inside
  // "West Ridge Supply Co") or inside a mention of a table's own name ("support" inside
  // "support tickets"), and duplicates.
  const exact = links.filter((l) => l.sim === 1);
  const tableMentions: [number, number][] = [];
  for (const t of Object.values(model.tables)) {
    for (const name of new Set([t.humanName, t.noun, ...t.synonyms].filter((n) => n.includes(" ")))) {
      for (const form of [name, `${name}s`]) {
        for (const m of lower.matchAll(new RegExp(`\\b${escapeRe(form)}\\b`, "g"))) tableMentions.push([m.index!, m.index! + form.length]);
      }
    }
  }
  const kept = links.filter(
    (l) =>
      !exact.some((e) => e !== l && e.start <= l.start && e.end >= l.end && e.end - e.start > l.end - l.start) &&
      !tableMentions.some(([s, e]) => s <= l.start && e >= l.end && e - s > l.end - l.start),
  );
  const seen = new Set<string>();
  const out: ValueLink[] = [];
  for (const l of kept.sort((a, b) => b.sim - a.sim)) {
    const k = `${l.column}=${l.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  out.sort((a, b) => a.start - b.start);
  out.forEach((l, i) => (l.id = `v${i}`));
  return out;
}

/** Partial (non-exact) search hits, grouped per span, for the text-match questions (§5.7d). */
export function partialHits(links: ValueLink[]) {
  return links.filter((l) => l.via === "search" && l.sim < 1);
}

// ---------------------------------------------------------------- retrieval

export interface Retrieved {
  table: string;
  score: number;
}

/**
 * Lightweight BM25-style retrieval over table/column names, descriptions, synonyms and
 * linked values (spec §4.3). Returns tables sorted by score; linked tables are boosted.
 */
export function retrieveTables(request: string, model: SchemaModel, links: ValueLink[], k = 8): Retrieved[] {
  const qTokens = contentTokens(request).map(stem);
  const docs = Object.values(model.tables).filter((t) => !t.hidden).map((t) => {
    const parts = [t.name, t.humanName, t.noun, t.description, ...t.synonyms, ...Object.values(t.columns).filter((c) => !c.hidden).flatMap((c) => [c.humanName, c.name.replace(/_/g, " ")])];
    const toks = parts.join(" ").toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const nameToks = [t.name, t.noun, ...t.synonyms].join(" ").toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return { t, toks: toks.map(stem), nameToks: new Set(nameToks.map(stem).concat(nameToks.map(singular))) };
  });
  const N = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const tok of new Set(d.toks)) df.set(tok, (df.get(tok) ?? 0) + 1);
  const avgLen = docs.reduce((a, d) => a + d.toks.length, 0) / Math.max(1, N);
  const out = docs.map((d) => {
    let score = 0;
    for (const qt of qTokens) {
      const tf = d.toks.filter((x) => x === qt).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - (df.get(qt) ?? 0) + 0.5) / ((df.get(qt) ?? 0) + 0.5));
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.toks.length / avgLen))));
      if (d.nameToks.has(qt)) score += 3;
    }
    if (links.some((l) => l.column.startsWith(d.t.key + ".") && l.sim === 1)) score += 4;
    return { table: d.t.key, score };
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(k, out.filter((x) => x.score > 0).length > k ? k : 0) || k);
}

export function describeColumn(c: ColumnModel): string {
  return c.description;
}
