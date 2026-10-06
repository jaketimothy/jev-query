/**
 * Run a psql-style SQL script against PGlite: splits statements (respecting dollar-quoted
 * bodies), loads `COPY … FROM stdin` blocks through PGlite's /dev/blob, and drops psql
 * meta-commands (`\c db`, `\set …`) and CREATE/DROP DATABASE, which have no meaning in PGlite.
 */
import type { PGlite } from "@electric-sql/pglite";

export interface ScriptOptions {
  /** Return false to skip a statement (or a COPY target, passed as "COPY <table>"). */
  keep?: (statement: string) => boolean;
}

export async function execScript(db: PGlite, text: string, opts: ScriptOptions = {}): Promise<void> {
  const keep = opts.keep ?? (() => true);
  const lines = text.split(/\r?\n/);
  let stmt: string[] = [];
  let batch: string[] = [];
  let dollar = false;
  const flushBatch = async () => {
    const sql = batch.join("\n").trim();
    batch = [];
    if (sql) await db.exec(sql);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!dollar) {
      const copy = /^COPY\s+([\w."]+)\s*\(([^)]*)\)\s+FROM\s+stdin;\s*$/i.exec(line);
      if (copy) {
        await flushBatch();
        const rows: string[] = [];
        for (i++; i < lines.length && lines[i] !== "\\."; i++) rows.push(lines[i]);
        if (rows.length && keep(`COPY ${copy[1]}`)) {
          await db.query(`COPY ${copy[1]} (${copy[2]}) FROM '/dev/blob'`, [], { blob: new Blob([rows.join("\n") + "\n"]) });
        }
        continue;
      }
      if (/^\\/.test(line)) continue; // psql meta-command
      if (/^\s*(DROP|CREATE)\s+DATABASE\b/i.test(line)) continue;
    }
    stmt.push(line);
    for (const _ of line.match(/\$[A-Za-z_]*\$/g) ?? []) dollar = !dollar;
    if (!dollar && /;\s*(--.*)?$/.test(line)) {
      const s = stmt.join("\n");
      stmt = [];
      if (keep(s)) batch.push(s);
      if (batch.length >= 500) await flushBatch();
    }
  }
  if (stmt.join("").trim() && keep(stmt.join("\n"))) batch.push(stmt.join("\n"));
  await flushBatch();
}
