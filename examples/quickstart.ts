/**
 * Minimal embedding: point the composer at a database and ask.
 *
 *   DATABASE_URL=postgres://… JEV_API_KEY=… npx tsx examples/quickstart.ts "orders by channel this year"
 *   (without DATABASE_URL it uses the PGlite testbed; without a key, the offline oracle)
 */
import { Composer, HeuristicOracle, JevOracle, openDb } from "../src/index.js";

const { db, close } = await openDb(process.env.DATABASE_URL ?? "pglite:.testbed-db");
const oracle = process.env.JEV_API_KEY || process.env.OPENROUTER_API_KEY ? new JevOracle() : new HeuristicOracle();
const composer = await Composer.create({ db, oracle, config: { database: { schemas: ["shop"] }, time: { as_of: "2026-10-05T00:00:00Z" } } });

const { result, data } = await composer.ask(process.argv[2] ?? "Order count by channel this year");
console.log(result.outcome, "—", result.narrative ?? result.clarification?.question ?? result.reason);
if (result.clarification) for (const o of result.clarification.options) console.log(`  [${o.key}] ${o.label}`);
if (data) console.table(data.rows);
await close();
