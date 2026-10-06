/**
 * Load the nlsql-testbed (schema.sql + seed.py output) into a persistent PGlite
 * database at .testbed-db/. Needs python on PATH to run seed.py once; the output
 * is cached at testbed/seed.sql.
 *
 *   npx tsx scripts/load-testbed.ts [--dir .testbed-db] [--force]
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const args = process.argv.slice(2);
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : ".testbed-db";
const force = args.includes("--force");
const testbed = "testbed";

export async function loadTestbed(db: PGlite, root = testbed): Promise<void> {
  const seedPath = join(root, "seed.sql");
  if (!existsSync(seedPath)) {
    const py = process.platform === "win32" ? "python" : "python3";
    const out = execFileSync(py, [join(root, "seed.py")], { maxBuffer: 64 << 20 });
    writeFileSync(seedPath, out);
  }
  await db.exec(readFileSync(join(root, "schema.sql"), "utf8"));
  await db.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  const seed = readFileSync(seedPath, "utf8").split(/\r?\n/);
  let pending: string[] = [];
  const flush = async () => {
    const stmt = pending.join("\n").trim();
    pending = [];
    if (stmt && !/^(BEGIN|COMMIT);?$/i.test(stmt)) await db.exec(stmt);
  };
  for (let i = 0; i < seed.length; i++) {
    const line = seed[i];
    const m = /^COPY (\w+) \(([^)]*)\) FROM stdin;$/.exec(line);
    if (!m) {
      if (/^(BEGIN|COMMIT);$/.test(line)) continue;
      pending.push(line);
      if (line.trim().endsWith(";")) await flush();
      continue;
    }
    await flush();
    const rows: string[] = [];
    for (i++; seed[i] !== "\\." && i < seed.length; i++) rows.push(seed[i]);
    await db.query(`COPY shop.${m[1]} (${m[2]}) FROM '/dev/blob'`, [], {
      blob: new Blob([rows.join("\n") + "\n"]),
    });
  }
  await flush();
  await db.exec("ANALYZE");
}

if (process.argv[1]?.endsWith("load-testbed.ts")) {
  if (force) rmSync(dir, { recursive: true, force: true });
  if (existsSync(dir) && !force) {
    console.log(`${dir} already exists (use --force to rebuild)`);
  } else {
    const t0 = Date.now();
    const db = new PGlite(dir, { extensions: { pg_trgm } });
    await loadTestbed(db);
    const r = await db.query<{ n: number }>("SELECT count(*)::int n FROM shop.orders");
    const s = await db.query<{ n: number }>("SELECT count(*)::int n FROM pg_stats WHERE schemaname = 'shop'");
    console.log(`loaded ${r.rows[0].n} orders, ${s.rows[0].n} pg_stats rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await db.close();
  }
}
