/**
 * Integration tests against the nlsql-testbed (spec §10). Requires the testbed loaded
 * into PGlite once:   npm run testbed:load
 */
import { existsSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Composer, compile, fromPGlite, HeuristicOracle, MemoryStore, parseConfig, resolveSettings, type Db } from "../src/index.js";
import { checkCase, runSql, type EvalCase } from "../src/eval/harness.js";
import { loadCases, runEval } from "../src/eval/runner.js";
import { emptyPlan, type QueryPlan } from "../src/plan/types.js";
import { periodBounds } from "../src/time/periods.js";

const DIR = ".testbed-db";
const have = existsSync(DIR);
const config = parseConfig(readFileSync("testbed/composer.yaml", "utf8"));
let pg: PGlite;
let db: Db;
let composer: Composer;

beforeAll(async () => {
  if (!have) return;
  pg = new PGlite(DIR, { extensions: { pg_trgm } });
  db = fromPGlite(pg as never);
  composer = await Composer.create({ db, oracle: new HeuristicOracle(), config });
});
afterAll(async () => {
  await pg?.close();
});

describe.skipIf(!have)("compiler against gold (hand-built plans)", () => {
  const ts = { asOf: new Date("2026-10-05T00:00:00Z"), timezone: "UTC", weekStart: "monday" as const };
  const win = (column: string, key: never | string, extra: object = {}) => ({ column, period: { key, ...extra } as never, bounds: periodBounds({ key, ...extra } as never, ts)! });
  const P = (o: Partial<QueryPlan>): QueryPlan => ({ ...emptyPlan(), ...o });
  const cnt = (t: string) => ({ alias: "n", label: t, kind: "count" as const, agg: "count_rows" as const, table: t });
  const sum = (ref: string, alias = "total") => {
    const [t, c] = ref.split(".");
    return { alias, label: ref, kind: "column" as const, agg: "sum" as const, table: t, column: ref, unit: composer.model.tables[t].columns[c].unit };
  };
  const plans: Record<string, () => QueryPlan> = {
    // fan-out-safe count through a bridge (G04)
    G04: () => P({ shape: "ranking", measures: [cnt("orders")], dimensions: [{ alias: "brand", label: "", kind: "column", column: "products.brand", table: "products" }], order: [{ ref: "n", kind: "measure", dir: "asc" }], limit: 1, timeWindow: win("orders.placed_at", "this_year") }),
    // chasm trap: pre-aggregate each child, join on the period (E02)
    E02: () => P({ shape: "trend", measures: [sum("order_items.quantity", "units"), { ...sum("payments.amount_cents", "paid"), filters: [{ column: "payments.status", op: "eq", values: ["captured"], label: "", source: "" }] }], dimensions: [{ alias: "month", label: "", kind: "time", column: "orders.placed_at", table: "orders", grain: "month" }], timeWindow: win("orders.placed_at", "this_year") }),
    // snapshot table: latest date only (E05)
    E05: () => P({ measures: [sum("inventory_snapshots.on_hand_units")], snapshotLatest: { table: "inventory_snapshots", column: "snapshot_date" } }),
    // LEFT JOIN from the dimension side with COALESCE-able count (D03)
    D03: () => P({ shape: "breakdown", measures: [cnt("orders")], dimensions: [{ alias: "region", label: "", kind: "column", column: "regions.name", table: "regions" }], includeEmptyGroups: true, timeWindow: win("orders.placed_at", "last_quarter"), joinPaths: { "orders->regions": ["orders.fulfilled_from_warehouse_id->warehouses", "warehouses.region_id->regions"] } }),
    // NOT EXISTS with scoping by column ownership (F05)
    F05: () => P({ measures: [cnt("customers")], filters: [{ column: "regions.name", op: "eq", values: ["West"], label: "", source: "" }], softDelete: { table: "customers", column: "deleted_at", kind: "timestamp" }, existence: [{ negated: true, table: "orders", filters: [], timeWindow: win("orders.placed_at", "specific_month", { start: { month: 9 } }), label: "" }] }),
    // per-group top-N with a deterministic tiebreak (G02)
    G02: () => P({ shape: "ranking", measures: [sum("order_items.quantity", "units")], dimensions: [{ alias: "category", label: "", kind: "column", column: "categories.name", table: "categories" }, { alias: "product", label: "", kind: "entity", table: "products" }], perGroupLimit: { partition: "category", n: 3 }, order: [{ ref: "units", kind: "measure", dir: "desc" }], timeWindow: win("orders.placed_at", "this_year") }),
    // recursive hierarchy expansion (I02, v2 behavior)
    I02: () => P({ measures: [sum("order_items.line_total_cents")], filters: [{ column: "categories.name", op: "eq", values: ["Camping"], label: "", source: "", hierarchy: { parentColumn: "parent_id", keyColumn: "id" } }], timeWindow: win("orders.placed_at", "last_month") }),
    // window over an aggregate (H01)
    H01: () => P({ shape: "trend", measures: [sum("orders.total_cents")], dimensions: [{ alias: "month", label: "", kind: "time", column: "orders.placed_at", table: "orders", grain: "month" }], derived: { kind: "pct_change_vs_previous" }, timeWindow: win("orders.placed_at", "this_year") }),
  };
  for (const [id, make] of Object.entries(plans)) {
    it(id, async () => {
      const c = loadCases("testbed").find((x) => x.id === id) as EvalCase;
      const out = compile(make(), composer.model, resolveSettings(config));
      const r = await checkCase(db, c, { id, outcome: "execute", sql: out.sql, params: out.params });
      expect(r.why).toBe("");
      expect(r.ok).toBe(true);
    });
  }

  it("refuses to emit an inflated sum (fan-out trap, E01)", () => {
    const plan = P({ shape: "breakdown", measures: [sum("orders.total_cents")], dimensions: [{ alias: "category", label: "", kind: "column", column: "categories.name", table: "categories" }] });
    expect(() => compile(plan, composer.model, resolveSettings(config))).toThrow(/fan-out/);
  });
});

describe.skipIf(!have)("composer flows", () => {
  it("clarifies an undefined business term, then reuses the accepted definition (J01 → J02)", async () => {
    const store = new MemoryStore();
    const c = await Composer.create({ db, oracle: new HeuristicOracle(), config, model: composer.model, store });
    const first = await c.compose("Revenue by customer region last month");
    expect(first.outcome).toBe("clarify");
    expect(first.clarification!.decision).toBe("measure");
    const opt = first.clarification!.options.find((o) => o.key === "col:order_items.line_total_cents")!;
    expect(opt).toBeTruthy();
    const second = await c.answer(first.clarification!.id, opt.key);
    expect(second.outcome).toBe("execute");
    expect(second.provenance.measure.by).toBe("user");
    // only the measure decision changed; R1 was not re-asked
    expect(second.rounds.find((r) => r.round === "R1")).toBeUndefined();
    const saved = await c.accept(second, { scope: "org", name: "revenue", user: "dana" });
    expect(saved.map((r) => r.kind).sort()).toEqual(["measure", "plan"]);
    const third = await c.compose("What was our revenue in Q2 2026?");
    expect(third.outcome).toBe("execute");
    expect(third.reused?.measures).toContain("revenue");
  });

  it("asks which region when the join path is ambiguous (D02)", async () => {
    const r = await composer.compose("Number of orders by region last month");
    expect(r.outcome).toBe("clarify");
    expect(r.clarification!.decision).toBe("join_path");
    const via = r.clarification!.options.map((o) => o.key).sort();
    expect(via).toEqual(["role:fulfilled_from", "via:customers"]);
    const answered = await composer.answer(r.clarification!.id, "via:customers");
    expect(answered.outcome).toBe("execute");
    expect(answered.sql).toMatch(/JOIN shop\.customers/);
  });

  it("follows up on the previous turn (J06)", async () => {
    const prev = await composer.compose("Order total by customer region last month");
    const next = await composer.compose("Same thing but for the East region only, last quarter", { conversation: prev });
    expect(next.outcome).toBe("execute");
    expect(next.provenance.follow_up).toBeTruthy();
    expect(next.params).toContain("East");
  });

  it("executes read-only", async () => {
    const r = await composer.compose("How many customers do we have?");
    const data = await composer.execute(r);
    expect(Number(Object.values(data.rows[0])[0])).toBe(3102);
    await expect(db.readOnly!((d) => d.query("CREATE TABLE shop.nope (x int)"))).rejects.toThrow(/read-only/);
  });

  it("refuses plans above the cost ceiling instead of hanging (PGlite ignores statement_timeout)", async () => {
    const ok = await composer.compose("How many orders were placed last month?");
    const runaway = { ...ok, sql: "SELECT count(*) FROM shop.orders o, shop.order_items i", params: [] };
    await expect(composer.execute(runaway)).rejects.toThrow(/too expensive/);
    await expect(composer.execute(ok)).resolves.toBeTruthy();
  });

  it("refuses to run gold SQL with a different prelude (harness sanity)", async () => {
    const r = await runSql(db, "SELECT count(*) FROM orders");
    expect(r.rows[0][0]).toBe(12240);
  });
});

describe.skipIf(!have)("testbed eval with the offline oracle (regression guard)", () => {
  it("passes at least 60 of 61 cases", async () => {
    const report = await runEval({ db, oracle: new HeuristicOracle(), testbedDir: "testbed", config, model: composer.model });
    const failed = report.outcomes.filter((o) => !o.ok).map((o) => `${o.id}: ${o.why}`);
    expect(failed.length, failed.join("\n")).toBeLessThanOrEqual(1);
  });
});
