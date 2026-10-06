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

async function respond(result: Result, t0 = Date.now()) {
  results.set(result.id, result);
  const composeMs = Date.now() - t0;
  console.log(`  composed in ${composeMs}ms: ${result.outcome} ${result.rounds.map((r) => `${r.round}:${r.questions}q/${r.ms}ms`).join(" ")}`);
  let data: unknown;
  if (result.outcome === "execute") {
    const t1 = Date.now();
    try {
      data = await composer.execute(result);
      console.log(`  executed in ${Date.now() - t1}ms`);
    } catch (e) {
      console.error(`  execute failed after ${Date.now() - t1}ms: ${(e as Error).message}\n${result.sql}`);
      data = { error: (e as Error).message };
    }
  }
  return { result, data, timing: { composeMs, totalMs: Date.now() - t0 } };
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
    // parse inside the promise so a bad body rejects instead of crashing the process
    const body = await new Promise<Record<string, string>>((ok, fail) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => {
        try {
          ok(s ? JSON.parse(s) : {});
        } catch (e) {
          fail(e);
        }
      });
      req.on("error", fail);
    });
    const t0 = Date.now();
    const label = body.request ?? (body.option ? `answer ${body.option}` : req.url);
    console.log(`→ ${req.url} ${JSON.stringify(label)}`);
    let out: unknown;
    if (req.url === "/api/ask") out = await respond(await composer.compose(body.request, { conversation: body.previous ? results.get(body.previous) : undefined, user: "playground" }), t0);
    else if (req.url === "/api/answer") out = await respond(await composer.answer(body.clarification, body.option), t0);
    else if (req.url === "/api/accept") out = await composer.accept(results.get(body.result)!, { scope: "org", name: body.name || undefined, user: "playground" });
    else {
      res.writeHead(404).end();
      return;
    }
    console.log(`← ${req.url} ${Date.now() - t0}ms`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(json(out));
  } catch (e) {
    console.error(`✗ ${req.url}: ${(e as Error).stack ?? e}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(json({ error: (e as Error).message }));
  }
}).listen(port, () => console.log(`jev-query playground on http://localhost:${port}  (oracle: ${oracle.name}, db: ${url})`));
