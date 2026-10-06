import type { Db, QueryResult } from "./types.js";

interface PGliteLike {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; fields: { name: string; dataTypeID: number }[] }>;
  transaction<T>(fn: (tx: { query: PGliteLike["query"] }) => Promise<T>): Promise<T>;
}

/**
 * Wrap a PGlite instance (Postgres in WASM; handy for tests, demos and browsers).
 *
 *   import { PGlite } from "@electric-sql/pglite";
 *   const db = fromPGlite(new PGlite("./data"));
 */
export function fromPGlite(pg: PGliteLike): Db {
  return {
    async query<R>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
      const r = await pg.query<R>(sql, params);
      return { rows: r.rows, fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) };
    },
    async readOnly<T>(fn: (db: Db) => Promise<T>, opts: { statementTimeoutMs?: number } = {}): Promise<T> {
      return pg.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        if (opts.statementTimeoutMs) await tx.query(`SET LOCAL statement_timeout = ${Math.floor(opts.statementTimeoutMs)}`);
        return fn({
          async query<R>(sql: string, params: unknown[] = []) {
            const r = await tx.query<R>(sql, params);
            return { rows: r.rows, fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) };
          },
        });
      });
    },
  };
}
