/**
 * Zero-config on a schema the conventions were not designed around: Prisma naming
 * (singular PascalCase tables, camelCase columns), one missing FK, cents, soft delete.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Composer, fromPGlite, HeuristicOracle, compile, resolveSettings } from "../src/index.js";
import type { Db } from "../src/index.js";
import { emptyPlan } from "../src/plan/types.js";

let pg: PGlite;
let db: Db;
let composer: Composer;

beforeAll(async () => {
  pg = new PGlite();
  db = fromPGlite(pg as never);
  await pg.exec(`
    CREATE TYPE "Plan" AS ENUM ('free', 'pro', 'team');
    CREATE TABLE "Workspace" ("id" serial PRIMARY KEY, "name" text NOT NULL UNIQUE, "plan" "Plan" NOT NULL, "createdAt" timestamptz NOT NULL, "deletedAt" timestamptz);
    CREATE TABLE "User" ("id" serial PRIMARY KEY, "email" text NOT NULL UNIQUE, "fullName" text NOT NULL, "workspaceId" int NOT NULL REFERENCES "Workspace"("id"), "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL);
    CREATE TABLE "Invoice" ("id" serial PRIMARY KEY, "invoiceNumber" text NOT NULL UNIQUE, "workspaceId" int NOT NULL, "amountCents" int NOT NULL,
                            "status" text NOT NULL CHECK ("status" IN ('draft','open','paid','void')), "issuedAt" timestamptz NOT NULL, "paidAt" timestamptz);
    INSERT INTO "Workspace" ("name","plan","createdAt","deletedAt") VALUES
      ('Acme','pro','2026-01-05',NULL), ('Globex','team','2026-02-10',NULL), ('Initech','free','2026-03-01','2026-06-01'), ('Umbrella','pro','2026-07-15',NULL);
    INSERT INTO "User" ("email","fullName","workspaceId","createdAt","updatedAt") VALUES
      ('a@acme.io','Ann Lee',1,'2026-01-05','2026-01-05'), ('b@acme.io','Bo Chen',1,'2026-02-01','2026-02-01'), ('c@globex.io','Cy Diaz',2,'2026-02-11','2026-02-11');
    INSERT INTO "Invoice" ("invoiceNumber","workspaceId","amountCents","status","issuedAt","paidAt") VALUES
      ('INV-1',1,120000,'paid','2026-08-03','2026-08-10'), ('INV-2',1,80000,'open','2026-09-02',NULL), ('INV-3',2,250000,'paid','2026-09-15','2026-09-20'),
      ('INV-4',4,40000,'void','2026-09-20',NULL), ('INV-5',2,99000,'paid','2026-09-28','2026-10-01');
    ANALYZE;
  `);
  composer = await Composer.create({ db, oracle: new HeuristicOracle(), config: { time: { as_of: "2026-10-05T00:00:00Z" } } });
});

afterAll(async () => {
  await pg.close();
});

describe("conventions on Prisma-style naming", () => {
  it("infers roles, units, display columns and the missing FK", () => {
    const m = composer.model;
    expect(m.tables.Invoice.columns.amountCents.role).toBe("measure_additive");
    expect(m.tables.Invoice.columns.amountCents.unit).toMatchObject({ kind: "money", divisor: 100 });
    expect(m.tables.Invoice.columns.status.values).toEqual(["draft", "open", "paid", "void"]);
    expect(m.tables.Workspace.softDelete?.column).toBe("deletedAt");
    expect(m.tables.User.display).toEqual(["fullName"]);
    expect(m.tables.Invoice.display).toEqual(["invoiceNumber"]);
    expect(m.tables.User.columns.updatedAt.role).toBe("timestamp_audit");
    expect(m.tables.Invoice.defaultTime).toBe("issuedAt");
    expect(m.tables.Invoice.durations.map((d) => `${d.start}>${d.end}`)).toContain("issuedAt>paidAt");
    const inferred = m.relationships.find((r) => r.from.table === "Invoice" && r.to.table === "Workspace");
    expect(inferred?.source).toBe("inferred");
    expect(m.tables.User.columns.email.pii).toBe(true);
  });

  it("quotes mixed-case identifiers in compiled SQL", async () => {
    const plan = { ...emptyPlan(), measures: [{ alias: "total", label: "total", kind: "column" as const, agg: "sum" as const, table: "Invoice", column: "Invoice.amountCents", unit: { kind: "money" as const, divisor: 100, label: "USD" } }] };
    const c = compile(plan, composer.model, resolveSettings({}));
    expect(c.sql).toContain('"Invoice"');
    expect(c.sql).toContain('"amountCents"');
    const r = await db.query(c.sql, c.params);
    expect(Number(r.rows[0].total)).toBe(5890);
  });
});

describe("end to end with the offline oracle", () => {
  it("counts current workspaces, excluding soft-deleted ones", async () => {
    const { result, data } = await composer.ask("How many workspaces do we have?");
    expect(result.outcome).toBe("execute");
    expect(result.sql).toMatch(/"deletedAt" IS NULL/);
    expect(Number(Object.values(data!.rows[0])[0])).toBe(3);
  });

  it("sums paid invoice amounts last month by workspace plan, through an inferred FK", async () => {
    const { result, data } = await composer.ask("Total invoice amount by workspace plan last month");
    expect(result.outcome).toBe("execute");
    const rows = Object.fromEntries(data!.rows.map((r) => [String(r.plan), Number(Object.values(r)[1])]));
    expect(rows).toEqual({ team: 3490, pro: 1200 });
  });

  it("applies a money threshold in cents and a status filter", async () => {
    const { result, data } = await composer.ask("List paid invoices over $1,000");
    expect(result.outcome).toBe("execute");
    expect(result.params).toContain(100000);
    expect(data!.rows.map((r) => r.invoiceNumber ?? r.invoice_number).sort()).toEqual(["INV-1", "INV-3"]);
  });

  it("declines writes", async () => {
    const r = await composer.compose("Delete all void invoices");
    expect(r.outcome).toBe("decline");
  });
});
