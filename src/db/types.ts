/**
 * Minimal database surface the composer needs. Adapters exist for `pg` (node-postgres
 * Pool/Client) and PGlite; anything that can run a parameterized query fits.
 */
export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  fields: { name: string; dataTypeID?: number }[];
}

export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  /**
   * Run `fn` inside a read-only transaction with a statement timeout (spec §7
   * execution guardrails). Adapters that cannot open a transaction run `fn` directly.
   */
  readOnly?<T>(fn: (db: Db) => Promise<T>, opts?: { statementTimeoutMs?: number }): Promise<T>;
}
