import type { Db, QueryResult } from "./types.js";

/** Structural types so `pg` stays an optional peer dependency. */
interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; fields: { name: string; dataTypeID: number }[] }>;
}
interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgClientLike & { release(): void }>;
}

/**
 * Wrap a node-postgres Pool or Client.
 *
 *   import pg from "pg";
 *   const db = fromPg(new pg.Pool({ connectionString }));
 */
export function fromPg(client: PgPoolLike | PgClientLike): Db {
  const db: Db = {
    async query<R>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
      const r = await client.query(sql, params);
      return { rows: r.rows as R[], fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) };
    },
    async readOnly<T>(fn: (db: Db) => Promise<T>, opts: { statementTimeoutMs?: number } = {}): Promise<T> {
      const conn = "connect" in client ? await client.connect() : client;
      try {
        await conn.query("BEGIN READ ONLY");
        if (opts.statementTimeoutMs) await conn.query(`SET LOCAL statement_timeout = ${Math.floor(opts.statementTimeoutMs)}`);
        const inner = fromPg(conn);
        const out = await fn({ query: inner.query });
        await conn.query("COMMIT");
        return out;
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        if ("release" in conn && typeof conn.release === "function") conn.release();
      }
    },
  };
  return db;
}
