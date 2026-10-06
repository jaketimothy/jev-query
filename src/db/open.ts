import type { Db } from "./types.js";

/**
 * Open a database from a URL: `postgres://…` (node-postgres) or `pglite:./dir` (PGlite,
 * with pg_trgm). Both drivers are optional peer dependencies loaded on demand.
 */
export async function openDb(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const { fromPGlite } = await import("./pglite.js");
    const pg = new PGlite(url.slice(7) || undefined, { extensions: { pg_trgm } });
    return { db: fromPGlite(pg as never), close: () => pg.close() };
  }
  const pgmod = (await import("pg")) as unknown as { default: { Pool: new (o: object) => unknown } };
  const { fromPg } = await import("./pg.js");
  const pool = new pgmod.default.Pool({ connectionString: url, max: 4 }) as { end(): Promise<void> };
  return { db: fromPg(pool as never), close: () => pool.end() };
}
