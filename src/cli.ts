#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Composer } from "./composer.js";
import { parseConfig, type ComposerConfig } from "./config.js";
import { openDb } from "./db/open.js";
import { runEval, verifyGold } from "./eval/runner.js";
import { CachingOracle } from "./oracle/cache.js";
import { HeuristicOracle } from "./oracle/heuristic.js";
import { JevOracle } from "./oracle/jev.js";
import { LogprobOracle } from "./oracle/logprob.js";
import type { Oracle } from "./oracle/types.js";
import { doctor } from "./schema/doctor.js";
import { readLockfile, writeLockfile } from "./schema/lockfile.js";

const HELP = `jev-query — natural language → PostgreSQL, composed not generated

Usage:
  jev-query introspect [--db URL] [--config composer.yaml] [--out composer.lock.json]
  jev-query doctor     [--db URL] [--config composer.yaml]
  jev-query ask "<request>" [--db URL] [--oracle heuristic|jev|logprob] [--execute] [--as-of ISO] [--json]
  jev-query eval       [--testbed DIR | --bench pagila|chinook|northwind] [--db URL] [--oracle heuristic|jev] [--only A01,B02]
                       [--out results.jsonl] [--explain] [--verify-gold]

Database URL:  postgres://user@host/db   (needs the "pg" package)
               pglite:./path/to/datadir   (needs "@electric-sql/pglite")
               default: $DATABASE_URL, else pglite:.testbed-db
Oracle:        heuristic (offline, default) | jev ($JEV_API_KEY / $TYPESAFE_API_KEY / $OPENROUTER_API_KEY)
               | logprob (--oracle-url http://localhost:8000/v1 --oracle-model NAME)
               --cache DIR caches answers on disk for reproducible runs.
`;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function makeOracle(kind: string): Oracle {
  let o: Oracle;
  if (kind === "jev") o = new JevOracle();
  else if (kind === "logprob") o = new LogprobOracle({ baseUrl: arg("oracle-url", "http://localhost:8000/v1")!, model: arg("oracle-model", "default")! });
  else o = new HeuristicOracle();
  const cache = arg("cache");
  return cache ? new CachingOracle(o, cache) : o;
}

function loadConfig(path?: string): ComposerConfig {
  const p = path ?? (existsSync("composer.yaml") ? "composer.yaml" : undefined);
  return p ? parseConfig(readFileSync(p, "utf8")) : {};
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const dbUrl = arg("db", process.env.DATABASE_URL ?? "pglite:.testbed-db")!;

  if (cmd === "eval") {
    const bench = arg("bench");
    const testbed = bench ? join("bench", bench) : arg("testbed", "testbed")!;
    const searchPath = arg("search-path", bench ? "public" : "shop")!;
    const config = loadConfig(arg("config") ?? join(testbed, "composer.yaml"));
    const { db, close } = await openDb(bench && !arg("db") ? `pglite:.unseen-db/${bench}` : dbUrl);
    if (flag("verify-gold")) {
      const rows = await verifyGold(db, testbed, searchPath);
      for (const r of rows) console.log(`${r.ok ? "ok  " : "BAD "} ${r.id.padEnd(8)} ${r.note}`);
      await close();
      process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
      return;
    }
    const oracle = makeOracle(arg("oracle", "heuristic")!);
    const only = arg("only")?.split(",");
    const verbose = flag("verbose");
    const report = await runEval({
      db, oracle, testbedDir: testbed, config, only, searchPath,
      onCase: (o) => {
        console.log(`${o.ok ? "PASS" : "FAIL"} ${o.id.padEnd(4)} ${o.outcome.padEnd(8)}${o.about ? ` (${o.about})` : ""} ${o.why}`);
        if (verbose || (!o.ok && flag("explain"))) {
          if (o.narrative) console.log(`       ${o.narrative}`);
          if (o.sql) console.log(o.sql.split("\n").map((l) => "       | " + l).join("\n"));
        }
      },
    });
    console.log(`\n${report.passed}/${report.total} passed (oracle: ${oracle.name})`);
    if (report.weakBlocks.length) console.log("blocks with failures:", report.weakBlocks.map((b) => `${b.block} ${b.passed}/${b.total}`).join(", "));
    const out = arg("out");
    if (out) writeFileSync(out, report.outcomes.map((o) => JSON.stringify({ id: o.id, outcome: o.outcome, sql: o.sql, about: o.about })).join("\n") + "\n");
    await close();
    process.exitCode = report.passed === report.total ? 0 : 1;
    return;
  }

  const config = loadConfig(arg("config"));
  const { db, close } = await openDb(dbUrl);
  try {
    if (cmd === "introspect") {
      const c = await Composer.create({ db, oracle: new HeuristicOracle(), config });
      const out = arg("out", "composer.lock.json")!;
      writeLockfile(out, c.model);
      console.log(`wrote ${out}: ${Object.keys(c.model.tables).length} tables, ${c.model.relationships.length} relationships, fingerprint ${c.model.fingerprint}`);
    } else if (cmd === "doctor") {
      const lock = arg("lock");
      const model = lock && existsSync(lock) ? readLockfile(lock) : (await Composer.create({ db, oracle: new HeuristicOracle(), config })).model;
      console.log(doctor(model));
    } else if (cmd === "ask") {
      const request = process.argv[3];
      if (!request || request.startsWith("--")) throw new Error('usage: jev-query ask "<request>"');
      const composer = await Composer.create({ db, oracle: makeOracle(arg("oracle", "heuristic")!), config });
      const result = await composer.compose(request, { asOf: arg("as-of") });
      if (flag("json")) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`outcome: ${result.outcome}  confidence: ${result.confidence.toFixed(2)}  rounds: ${result.rounds.map((r) => `${r.round}:${r.questions}q`).join(" ")}`);
        if (result.narrative) console.log(`\n${result.narrative}`);
        if (result.sql) console.log(`\n${result.sql}\n-- params: ${JSON.stringify(result.params)}`);
        if (result.clarification) {
          console.log(`\n${result.clarification.question}`);
          for (const o of result.clarification.options) console.log(`  [${o.key}] ${o.label}${o.consequence ? ` — ${o.consequence}` : ""}`);
        }
        if (result.reason) console.log(`\n${result.reason}`);
      }
      if (flag("execute") && result.outcome === "execute") {
        const data = await composer.execute(result);
        console.table(data.rows.slice(0, 50));
      }
    } else {
      console.log(HELP);
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
