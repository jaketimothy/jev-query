import type { Db } from "../db/types.js";
import { contentTokens, stem } from "../nl/lexicon.js";
import type { SavedQueryStore, SavedRecord, SearchQuery, Status } from "./types.js";

/** Visible to a user: their own, their team's, and org records; never deprecated or stale. */
export function inScope(r: SavedRecord, q: { user?: string; team?: string }): boolean {
  if (r.status === "deprecated" || r.status === "stale") return false;
  if (r.scope === "org") return true;
  if (r.scope === "team") return !!q.team && r.owner === q.team;
  return !!q.user && r.owner === q.user;
}

/** Keyword overlap score over request, narrative, name and phrases (BM25-lite). */
export function scoreRecord(r: SavedRecord, text: string): number {
  const qt = new Set(contentTokens(text).map(stem));
  const doc = r.kind === "measure" ? [r.name, ...r.phrases, r.narrative].join(" ") : [r.request, r.narrative, r.name ?? ""].join(" ");
  const dt = new Set(contentTokens(doc).map(stem));
  let s = 0;
  for (const t of qt) if (dt.has(t)) s += 1;
  if (r.status === "canonical") s += 0.5;
  return s / Math.sqrt(Math.max(1, dt.size));
}

export class MemoryStore implements SavedQueryStore {
  private records = new Map<string, SavedRecord>();
  constructor(initial: SavedRecord[] = []) {
    for (const r of initial) this.records.set(r.id, r);
  }
  async search(q: SearchQuery): Promise<SavedRecord[]> {
    return [...this.records.values()]
      .filter((r) => (!q.kind || r.kind === q.kind) && inScope(r, q))
      .map((r) => ({ r, s: scoreRecord(r, q.text) }))
      .filter((x) => x.s > 0 || q.kind === "measure")
      .sort((a, b) => b.s - a.s)
      .slice(0, q.k ?? 8)
      .map((x) => x.r);
  }
  async get(id: string) {
    return this.records.get(id);
  }
  async put(r: SavedRecord) {
    this.records.set(r.id, r);
  }
  async setStatus(id: string, status: Status) {
    const r = this.records.get(id);
    if (r) r.status = status;
  }
  async all() {
    return [...this.records.values()];
  }
}

/**
 * Default persistent store: a `composer.saved_records` table (spec §2B). Search is done
 * in process over the scoped rows, which is fine for the thousands of records a team accumulates.
 */
export class PgStore implements SavedQueryStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly db: Db, private readonly schema = "composer") {}

  private init() {
    this.ready ??= (async () => {
      await this.db.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.schema}.saved_records (
           id text PRIMARY KEY, kind text NOT NULL, scope text NOT NULL, owner text, status text NOT NULL,
           record jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
      );
    })();
    return this.ready;
  }
  async search(q: SearchQuery): Promise<SavedRecord[]> {
    const all = await this.all();
    return new MemoryStore(all).search(q);
  }
  async get(id: string) {
    await this.init();
    const r = await this.db.query<{ record: SavedRecord }>(`SELECT record FROM ${this.schema}.saved_records WHERE id = $1`, [id]);
    return r.rows[0]?.record;
  }
  async put(rec: SavedRecord) {
    await this.init();
    await this.db.query(
      `INSERT INTO ${this.schema}.saved_records (id, kind, scope, owner, status, record) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, record = EXCLUDED.record, updated_at = now()`,
      [rec.id, rec.kind, rec.scope, rec.owner ?? null, rec.status, JSON.stringify(rec)],
    );
  }
  async setStatus(id: string, status: Status) {
    const r = await this.get(id);
    if (r) await this.put({ ...r, status });
  }
  async all() {
    await this.init();
    const r = await this.db.query<{ record: SavedRecord | string }>(`SELECT record FROM ${this.schema}.saved_records`);
    return r.rows.map((x) => (typeof x.record === "string" ? JSON.parse(x.record) : x.record));
  }
}
