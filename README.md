# jev-query

**Plug-and-play natural language → PostgreSQL, composed rather than generated.**

The model never writes SQL. Code enumerates the legal next moves of a typed `QueryPlan`,
a decision model ([Jev](https://openrouter.ai/typesafe/jev-1.13), or any backend behind the
same three-primitive interface) assigns calibrated probabilities to those moves, and code
assembles, validates and compiles the plan to **parameterized** Postgres. Low-confidence
decisions become clarifying questions built from the runner-up options instead of silent
wrong answers.

```ts
import pg from "pg";
import { Composer, JevOracle, fromPg } from "jev-query";

const composer = await Composer.create({
  db: fromPg(new pg.Pool({ connectionString: process.env.DATABASE_URL })),
  oracle: new JevOracle(), // reads JEV_API_KEY / TYPESAFE_API_KEY / OPENROUTER_API_KEY
});

const result = await composer.compose("Top 5 product categories by units sold last quarter");
// result.outcome: "execute" | "clarify" | "decline"
// result.sql / result.params / result.narrative / result.provenance
if (result.outcome === "execute") console.table((await composer.execute(result)).rows);
if (result.outcome === "clarify") {
  // render result.clarification.options, then:
  // const next = await composer.answer(result.clarification.id, chosenKey);
}
```

No catalog, no semantic layer to write first: point it at a database and it works from
introspection plus conventions. A short `composer.yaml` makes it better, and accepted answers
teach it your business definitions ("revenue") as people use it.

---

## Why composed instead of generated

| | Free-generated SQL | jev-query |
|---|---|---|
| Syntax, identifiers, joins | can be invalid or hallucinated | valid by construction; identifiers come only from the schema model |
| Literals | interpolated | always bind parameters (`$1…$n`) |
| Fan-out / chasm traps | silently inflated sums | deterministic graph check: pre-aggregate, `COUNT(DISTINCT pk)`, or ask |
| "Which region?", "last quarter?" | picks one silently | calibrated distribution → clarifying question with concrete consequences |
| Explaining the answer | re-read the SQL | every plan field points to the decision and distribution that set it |
| Business terms | guessed each time | asked once, saved, reused by everyone in scope |

Correctness comes from three places: **by construction** (grammar is code), **calibrated
semantics** (every decision is a distribution), and **gating** (low confidence → clarify).

## How a request flows

```
request ─▶ [code] spans · value linking (enum/CHECK/pg_stats values, trigram/ILIKE search) · schema retrieval
        ─▶ R0  saved-plan match / conversation follow-up           (1 Choice, optional)
        ─▶ R1  speculative fan-out: shape, flags, subject, measure × agg, dimensions,
               period, span roles, operators, filter polarity, text match, nulls, sort, derived
               (~150–230 independent questions, one batched request)
        ─▶ R1b re-ask low-margin choices with reversed options and average (option-order debiasing)
        ─▶ [code] masked joint decoding · Hungarian span assignment · join analysis
        ─▶ R2  dependent decisions: date column, join-path ambiguity, absence/presence, partition
        ─▶ [code] conventions (soft delete, snapshots, hierarchy) · compile · fan-out check
        ─▶ gate on the weakest load-bearing decision ─▶ clarify
        ─▶ R3  verification: plan-narrative agreement + coverage of every content phrase
        ─▶ execute (read-only transaction, statement_timeout) | clarify | decline
```

Typically three or four oracle round trips, each a single batched request.

## Install

```bash
npm install jev-query pg            # node-postgres
# or, for an in-process Postgres (tests, demos, browsers):
npm install jev-query @electric-sql/pglite
```

Node ≥ 20. `pg` and `@electric-sql/pglite` are optional peer dependencies; bring whichever
you use, or implement the two-method `Db` interface yourself.

## Oracles: the only model dependency

```ts
interface Oracle {
  ask(state: unknown, questions: Record<string, Choice | Score | Noul>): Promise<Record<string, Answer>>;
}
```

| Oracle | Use |
|---|---|
| `JevOracle` | TypeSafe Jev (System One). Default endpoint `https://openrouter.ai/api/v1/systemone`; set `JEV_URL` or `{ url }` for TypeSafe's native API or Cloudflare Workers AI. Large rounds are split into parallel batches; 429/5xx are retried. |
| `LogprobOracle` | Self-hosted equivalent (spec §9) for an OpenAI-compatible server with logprobs (vLLM, SGLang, llama.cpp). Choice = renormalized label-token probabilities; per-family temperature hook for calibration. For FedRAMP/air-gapped boundaries. |
| `HeuristicOracle` | **Offline, deterministic, not calibrated.** Lexical rules for development, CI and demos without network access. Not a substitute for Jev. |
| `CachingOracle` | Wraps any oracle; caches per (state, question) on disk for reproducible evals. |
| `RecordingOracle` | Wraps any oracle; keeps every round's state/questions/answers for debugging. |

Write your own by implementing `ask()`; the composer only ever asks Choice, Score and Noul
questions over options it enumerated itself.

**Endpoints.** TypeSafe native: `JEV_URL=https://api.typesafe.ai/v1/systemone`, `JEV_MODEL=jev-latest`
(or a pinned version). OpenRouter (default): `https://openrouter.ai/api/v1/systemone`, `typesafe/jev-1.13`.

**Keeping the key out of files.** With the [1Password CLI](https://developer.1password.com/docs/cli/),
`op run` resolves secret references into the child process's environment only and masks them in output:

```bash
JEV_API_KEY="op://Personal/Typesafe API/password" \
JEV_URL="https://api.typesafe.ai/v1/systemone" JEV_MODEL="jev-latest" \
op run -- npx jev-query eval --oracle jev --cache .jev-cache
```

## The schema model: conventions → `composer.yaml` → saved queries

**Introspection** reads the catalog only (`pg_attribute`, `pg_constraint`, `pg_enum`,
`pg_description`, `pg_stats`, `pg_class`) plus small, bounded reads: distinct values of tiny
lookup tables, and a 500-row ordering check for timestamp pairs. **Convention rules** then infer, with a
rule id and confidence for each:

- relationships from FKs (R1), from names when FKs are missing (`converted_order_id → orders`, R2),
  junction tables (R3), hierarchies (R4), role-playing FKs labelled by prefix (`billing_`/`shipping_`, R5)
- column roles: identifiers, soft-delete markers, audit vs event timestamps (`created_at` is the event
  time only when nothing else is), default time column, duration pairs (`opened_at → first_response_at`),
  enum/CHECK/`pg_stats` categorical values, free text, numeric attributes that are not measures,
  money in cents, additivity (`unit_price` is never summed), snapshot tables (semi-additive),
  display columns, tenant columns, PII
- naming styles: snake_case and Prisma/camelCase (`"customerId"`, `"createdAt"`, singular PascalCase tables)

```bash
npx jev-query introspect --db "$DATABASE_URL" --out composer.lock.json   # reviewable, diffable
npx jev-query doctor     --db "$DATABASE_URL"                            # what to confirm in composer.yaml
```

`composer.yaml` (everything optional):

```yaml
database: { schemas: [shop], exclude_tables: [schema_migrations] }
time: { timezone: America/Los_Angeles, week_start: monday, last_period_means: calendar }
soft_delete: { mode: current_state_only }        # or always | never
tenancy: { column: account_id }                  # or rely on RLS
overrides:
  orders.handling_fee: { role: measure_additive, unit: cents }
  web_sessions.converted_order_id: { references: orders.id }
  customers: { display: [first_name, last_name] }
synonyms: { customers: [members] }
relationships:
  default_paths: { "orders->regions": customers }   # answer an ambiguity once, for everyone
gating: { auto_execute_min_confidence: 0.6, margin_reask: 0.15 }
limits: { default_ranking: 10, max_rows: 5000, statement_timeout_ms: 15000 }
```

Config is for facts about the *schema*. Facts about the *business* ("revenue excludes cancelled
orders") live in the saved query library.

## Saved query library and the host-app interface

```ts
compose(request, { user, team, asOf, conversation }) → Result
answer(clarificationId, optionKey)                   → Result   // only that decision changes; R1 is not re-asked
accept(result, { scope, name, user, team })         → SavedRecord[]
execute(result)                                      → { columns, rows }   // read-only, statement_timeout
```

- **Measure fragments**: when a user accepts a query whose measure came from a clarification
  (or carries row filters) and names it, it becomes a reusable definition offered as
  `saved:<name>` next to schema-derived candidates, scoped to user/team/org.
- **Plans**: accepted plans are matched in R0; their pinned decisions (e.g. which region) are
  reused and only slots (period, filters, limit) are rebound.
- **Follow-ups**: pass the previous `Result` as `conversation` ("same thing but for East").
- **Drift**: every record fingerprints the columns it uses; `refreshSaved()` marks broken ones stale.

Storage is pluggable (`SavedQueryStore`): `MemoryStore`, or `PgStore`, which keeps records in a
`composer.saved_records` table. The host app owns acceptance UI and promotion to canonical.

## Safety

- Read-only: `execute()` runs in a `READ ONLY` transaction with `SET LOCAL statement_timeout`.
  Use a read-only database role too.
- Every literal is a bind parameter; `ILIKE` patterns are escaped.
- Tenancy belongs to Postgres RLS on the executing role, so a composer bug can't leak across tenants.
- Writes and unrelated requests are declined.

## What it composes (v1)

Shapes `lookup`, `single_value`, `breakdown`, `ranking`, `trend` · `=`, `<>` (NULL-safe),
`IN`, `NOT IN`, comparisons, `BETWEEN`, `ILIKE` contains/starts-with, `IS [NOT] NULL`, booleans ·
relative and explicit periods computed in code, timezone-aware, half-open · `EXISTS`/`NOT EXISTS`
with scoping by column ownership · one `HAVING` · `share_of_total`, `running_total`,
`change_vs_previous`, `pct_change_vs_previous`, `rank`, `moving_average` · per-group top-N
(`row_number`) · `DISTINCT ON` latest-per-group · duration measures · `FILTER` period comparisons
("YTD vs same period last year") · fan-out safety (`COUNT(DISTINCT)`, per-grain CTEs for chasm traps,
clarify when ill-posed) · `LEFT JOIN` + zero rows for "including regions with no orders" ·
snapshot tables at the latest date · category hierarchies via recursive CTE.

Deferred (spec §5.17): `UNION`/`INTERSECT`, ad hoc arithmetic (`price - cost`), JSONB paths,
arrays, self-joins, histograms.

## Evaluation on `nlsql-testbed`

`testbed/` is a 17-table Postgres schema built around the traps real databases have (fan and
chasm traps, role-playing FKs, soft deletes, cents, snapshot tables, missing FKs, a junction
table, value collisions) with 61 cases that have verified gold SQL and known-wrong answers.

```bash
npm run testbed:load                     # loads schema + deterministic seed into PGlite (.testbed-db); needs python
npm run eval                             # offline oracle
npx jev-query eval --oracle jev --cache .jev-cache --explain    # real Jev, cached
```

| Oracle | Result | Notes |
|---|---|---|
| `JevOracle` (`jev-latest`, TypeSafe native API) | **58 / 61** | First run scored 41/61; four iterations of general code-side fixes (below) brought it to 58. Two wrong answers, one extra clarification. |
| `HeuristicOracle` | 60 / 61 | Tuned on these same cases: shows the code side reaches gold given sensible decisions, says nothing about language understanding. |

Remaining Jev failures:

- **B05** "Which products cost less than $20?": Jev splits list price 0.59 / unit cost 0.41, so it asks. Arguably the right behavior.
- **D05** "phone tickets … each support agent created": Jev reads "support agent" as also filtering `title = 'Support Agent'`. A defensible reading the gold SQL doesn't take.
- **E02** "amount paid": means captured payments, which nothing in the schema says. Accept it once as a saved measure and it is reused after.

What moved the score from 41 to 58 (all general rules, documented in `docs/ARCHITECTURE.md`): gating only on
decisions that change the plan (runner-ups are re-decoded and pooled when equivalent, dropped when illegal),
unique alternate keys (`regions.code`) not offered as dimensions, the ranked entity always a dimension of a
ranking, no `rank` column on rankings, no two-period comparison inside a trend, no single-bucket time grains,
convention fallback for flat time-column distributions, and asking about business terms only when a word
appears nowhere in the schema vocabulary. These were developed against this testbed, so the next honest
check is an unseen schema (Pagila, Chinook, Northwind) with no `composer.yaml`.

## Building on it

`examples/playground` is a small web app (single HTML file + 80-line server) showing the full
loop: narrative, SQL, results, decision provenance with confidences, clarification buttons,
follow-ups and "save as definition".

```bash
npm run testbed:load && npm run playground   # http://localhost:4747
DATABASE_URL=postgres://… COMPOSER_CONFIG=composer.yaml npm run playground
```

Ideas the interface is shaped for:

- **Chat over your warehouse** (Slack/Teams bot): the clarification options are ready-made buttons.
- **Dashboards that ask back**: a tile is a saved plan; changing its period or filters is slot rebinding, not re-generation.
- **Explainable reports**: show `narrative` and `provenance` next to every number, and the runner-up reading as a banner.
- **Governed metrics from use**: let analysts promote accepted definitions to `canonical`; conflicts surface as options instead of silent picks.
- **Self-hosted/regulated**: swap `JevOracle` for `LogprobOracle`; nothing else changes.

## CLI

```bash
jev-query introspect [--db URL] [--config composer.yaml] [--out composer.lock.json]
jev-query doctor     [--db URL]
jev-query ask "<request>" [--oracle heuristic|jev|logprob] [--execute] [--as-of 2026-10-05T00:00:00Z] [--json]
jev-query eval       [--testbed testbed] [--oracle …] [--only A01,B02] [--explain] [--out results.jsonl]
```

`--db` takes `postgres://…` or `pglite:./dir` (default `$DATABASE_URL`, else `pglite:.testbed-db`).

## Development

```bash
npm install
npm run testbed:load     # once; needs python on PATH
npm test                 # unit, Prisma-style zero-config, oracle client, testbed integration + eval regression
npm run typecheck && npm run build
```

`docs/ARCHITECTURE.md` maps the spec (`testbed/docs/nl-sql-composer-spec.md`) to the code and lists
where the implementation deviates from it.

## License

MIT
