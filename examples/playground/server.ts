/**
 * jev-query playground: a tiny HTTP server + single-page UI over any Postgres database.
 *
 *   npm run testbed:load                       # once, for the demo database
 *   npx tsx examples/playground/server.ts      # http://localhost:4747
 *
 * Env: DATABASE_URL (postgres://… or pglite:./dir, default pglite:.testbed-db),
 *      COMPOSER_CONFIG (default testbed/composer.yaml), JEV_API_KEY (uses Jev; else offline oracle).
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Composer, HeuristicOracle, JevOracle, MemoryStore, parseConfig, type Result } from "../../src/index.js";
import { openDb } from "../../src/db/open.js";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4747);
const url = process.env.DATABASE_URL ?? "pglite:.testbed-db";
const cfgPath = process.env.COMPOSER_CONFIG ?? "testbed/composer.yaml";
const config = existsSync(cfgPath) ? parseConfig(readFileSync(cfgPath, "utf8")) : {};
const hasKey = !!(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? process.env.OPENROUTER_API_KEY);
const oracle = hasKey ? new JevOracle() : new HeuristicOracle();

const { db } = await openDb(url);
const store = new MemoryStore();
const composer = await Composer.create({ db, oracle, config, store });
const results = new Map<string, Result>();

async function respond(result: Result) {
  results.set(result.id, result);
  let data: unknown;
  if (result.outcome === "execute") {
    try {
      data = await composer.execute(result);
    } catch (e) {
      data = { error: (e as Error).message };
    }
  }
  return { result, data };
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(here, "index.html")));
      return;
    }
    if (req.method === "GET" && req.url === "/api/info") {
      const tables = Object.values(composer.model.tables).filter((t) => !t.hidden).map((t) => ({ name: t.key, description: t.description, rows: t.rowEstimate }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(json({ oracle: oracle.name, tables, saved: (await store.all()).map((r) => ({ id: r.id, kind: r.kind, name: r.kind === "measure" ? r.name : r.name ?? r.request })) }));
      return;
    }
    const body = await new Promise<Record<string, string>>((ok) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => ok(s ? JSON.parse(s) : {}));
    });
    let out: unknown;
    if (req.url === "/api/ask") out = await respond(await composer.compose(body.request, { conversation: body.previous ? results.get(body.previous) : undefined, user: "playground" }));
    else if (req.url === "/api/answer") out = await respond(await composer.answer(body.clarification, body.option));
    else if (req.url === "/api/accept") out = await composer.accept(results.get(body.result)!, { scope: "org", name: body.name || undefined, user: "playground" });
    else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(json(out));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(json({ error: (e as Error).message }));
  }
}).listen(port, () => console.log(`jev-query playground on http://localhost:${port}  (oracle: ${oracle.name}, db: ${url})`));
