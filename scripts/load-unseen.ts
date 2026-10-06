/**
 * Download and load the unseen-schema benchmarks into PGlite (.unseen-db/<name>).
 * The composer was never designed around these schemas; the benchmark measures zero-config
 * accuracy (spec §10 "Unseen schemas").
 *
 *   npx tsx scripts/load-unseen.ts [pagila|chinook|northwind ...] [--force]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { execScript } from "./sqlscript.js";

export const DATASETS: Record<string, { files: { url: string; name: string }[]; source: string; license: string; keep?: (stmt: string) => boolean }> = {
  pagila: {
    source: "https://github.com/devrimgunduz/pagila",
    license: "PostgreSQL License",
    // recent Pagila adds a pgvector film_embedding table; skip it (not part of classic Pagila)
    keep: (stmt) => !/(?<![a-z])vector(?![a-z_])|film_embedding/i.test(stmt),
    files: [
      { name: "pagila-schema.sql", url: "https://raw.githubusercontent.com/devrimgunduz/pagila/master/pagila-schema.sql" },
      { name: "pagila-data.sql", url: "https://raw.githubusercontent.com/devrimgunduz/pagila/master/pagila-data.sql" },
    ],
  },
  chinook: {
    source: "https://github.com/lerocha/chinook-database",
    license: "MIT",
    files: [{ name: "chinook.sql", url: "https://raw.githubusercontent.com/lerocha/chinook-database/master/ChinookDatabase/DataSources/Chinook_PostgreSql.sql" }],
  },
  northwind: {
    source: "https://github.com/pthom/northwind_psql",
    license: "MIT (Microsoft sample data)",
    files: [{ name: "northwind.sql", url: "https://raw.githubusercontent.com/pthom/northwind_psql/master/northwind.sql" }],
  },
};

const DL = ".datasets";
const DBDIR = ".unseen-db";

export async function loadDataset(name: string, force = false): Promise<string> {
  const ds = DATASETS[name];
  if (!ds) throw new Error(`unknown dataset ${name}`);
  const dir = join(DBDIR, name);
  if (existsSync(dir) && !force) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(DL, { recursive: true });
  for (const f of ds.files) {
    const p = join(DL, f.name);
    if (!existsSync(p)) {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`download ${f.url}: HTTP ${res.status}`);
      writeFileSync(p, Buffer.from(await res.arrayBuffer()));
    }
  }
  mkdirSync(DBDIR, { recursive: true });
  const db = new PGlite(dir, { extensions: { pg_trgm } });
  for (const f of ds.files) await execScript(db, readFileSync(join(DL, f.name), "utf8"), { keep: ds.keep });
  await db.exec("ANALYZE");
  await db.close();
  return dir;
}

if (process.argv[1]?.endsWith("load-unseen.ts")) {
  const force = process.argv.includes("--force");
  const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const n of names.length ? names : Object.keys(DATASETS)) {
    const t0 = Date.now();
    try {
      const dir = await loadDataset(n, force);
      console.log(`${n}: ${dir} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.error(`${n}: FAILED ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}
