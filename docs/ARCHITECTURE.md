# Architecture

This maps the composer spec (`testbed/docs/nl-sql-composer-spec.md`, revision 2) to the code,
and records where the implementation deviates from it or is incomplete.

## Layers

| Layer | Owns | Code |
|---|---|---|
| Grammar | what is legal: clauses, aggregate × type masks, operators, join validity, fan-out | `src/plan/build.ts` (`legalAggs`), `src/joins/*`, `src/sql/compile.ts` |
| Schema model | what exists: roles, units, values, relationships, display, durations | `src/schema/introspect.ts` → `src/schema/conventions.ts` → `composer.lock.json` |
| Intent | which legal, existing option the request means | `Oracle` (`src/oracle/*`), asked by `src/composer.ts` |

## Module map

```
src/
  composer.ts          Composer: compose / answer / accept / execute; R0–R3 rounds, decoding, gating
  config.ts            composer.yaml types + resolved settings
  compose/state.ts     pruned schema slice used as shared round state
  db/                  Db interface; adapters for node-postgres and PGlite; openDb(url)
  oracle/
    types.ts           Choice / Score / Noul questions and answers; helpers
    jev.ts             TypeSafe Jev client (batching, retries, usage callback)
    logprob.ts         self-hosted logprob oracle (spec §9)
    heuristic.ts       offline lexical oracle for tests and demos
    cache.ts           CachingOracle (disk), RecordingOracle
  schema/
    introspect.ts      catalog reads → RawCatalog (+ bounded value scans, duration ordering samples)
    conventions.ts     rules R1–R5, C1–C15 → SchemaModel; composer.yaml overrides
    model.ts           SchemaModel types
    lockfile.ts        composer.lock.json read/write (stable key order)
    doctor.ts          low-confidence inferences and the override that pins each
  nl/
    spans.ts           numbers, quoted, proper nouns, relative time, explicit dates, content phrases (§4.1)
    link.ts            value linking (§4.2) and BM25 table retrieval (§4.3)
    lexicon.ts         inflection, stems, synonyms, US states/countries, snake-case normalization
  time/periods.ts      closed period library; tz-aware half-open bounds (§4.4, §5.8)
  plan/
    types.ts           QueryPlan IR (§3)
    build.ts           measure candidates, legality mask, saved-fragment → Measure
    decode.ts          Hungarian assignment, masked joint decoding
  joins/
    graph.ts           FK graph with up (N:1) / down (1:N) steps; path enumeration; root choice
    analyze.ts         measure roots, fan-out detection, join-path ambiguities and pins
  sql/
    compile.ts         plan → parameterized SQL (single root, LEFT-flip, multi-root CTEs, windows, EXISTS)
    narrative.ts       plan → English (§8.1)
  saved/               SavedQueryStore interface, MemoryStore, PgStore
  eval/                harness port (normalization identical to harness.py) and the testbed runner
  cli.ts               introspect | doctor | ask | eval
```

## Rounds as implemented

| Round | Contents | Notes |
|---|---|---|
| R0 | `follow_up` Noul (when a previous result is passed), `saved_plan` Choice over retrieved plans | A match reuses the plan and its pins; R1 shrinks to slot questions. |
| R1 | shape, specificity, 13 flags, subject, measure_quantity, measure_agg, `also_*`, `show_*`, `group_*`, time_grain, period, `date_role_*`, `role_*`, `op_*`, `filter_*`, `textcol_*`/`textmode_*`, `null_*`, `bool_*`, sort_dir, derived | ~150–230 questions on the testbed. |
| R1b | reversed-option re-asks of low-margin load-bearing choices, averaged | spec puts these in R2; done before decoding so every downstream step sees the debiased distribution. |
| R2 | time_column, `absent_*`/`present_*`, partition_dim, `path_*` | a second, smaller R2b runs if the chosen time column or existence introduces a new path ambiguity. |
| R3 | agreement Score, extra_condition Noul, `covered_*` per unhandled content phrase | runs after gating, only for plans that would execute. |

Decisions are recorded in `Result.provenance` with the question id, value, confidence, the raw
answer, whether they are load-bearing, and who decided (`oracle`, `code`, `config`, `saved`, `user`).

## Compile strategy

1. **Roots.** For each measure, the root is the measure's own table when every dimension is reachable
   by N:1 steps from it; otherwise the most direct bridge table (fewest hops) from which all are
   reachable. Counts and `min`/`max` above the root are fan-out safe (`COUNT(DISTINCT pk)`);
   `sum`/`avg` above the root are ill-posed → clarify with grain-switch alternatives.
2. **Groups.** Measures with different roots (chasm trap) compile to one CTE per root grouped by the
   same dimensions, joined with `FULL JOIN … USING (dims)`.
3. **Joins.** Paths come from `JoinGraph.bestPaths` (fewest 1:N steps, then shortest), filtered by pins
   (`plan.joinPaths`, from R2 answers, clarifications, saved plans or `default_paths`).
4. **Filters.** A predicate whose table is reachable N:1 from the root becomes a `WHERE` condition;
   otherwise a correlated `EXISTS` built from the 1:N part of the path (junctions included).
5. **Include empty groups.** With one dimension table above the root, the query is flipped to
   `FROM dimension LEFT JOIN …` with the measure-side filters moved into `ON`.
6. **Wrappers.** per-group top-N (`row_number` in a subquery), `DISTINCT ON` for latest-per-group,
   derived calculations as an outer `SELECT` with window functions.

## Deviations from the spec, and gaps

Deliberate deviations:

- **Explicit dates.** Dates are parsed in code from spans (ISO, "March 5", "Q2 2026", "August 2026");
  the oracle is asked only which role each date plays (start / end / before / not a period), not one
  Choice per date part. Bare years are recognized in code.
- **Row vs group level (§5.10).** Folded into the span-role options: `threshold:col:<ref>` (row),
  `threshold:sum:<ref>` / `threshold:count:<table>` / `threshold:saved:<name>` (group). No separate
  `level_span` question.
- **Presence vs absence (§5.9).** Absence is asked explicitly (R2 Nouls → `NOT EXISTS`, with scoping by
  column ownership). Presence needs no question: a filter or time window on a 1:N table compiles to
  `EXISTS` automatically.
- **Status vs related rows.** When a status value's stem equals a child table's name
  (`status = 'refunded'` vs a row in `refunds`) the composer always clarifies, unless pinned.
- **Lifecycle verbs.** If the chosen time column carries the same verb as a linked status value
  ("delivered in August"), the status filter is dropped as redundant.
- **Hierarchies.** Filters on a `parent_*` self-referencing table expand to the value's subtree via a
  recursive CTE (listed as v2 in the spec).
- **Gating.** Default `auto_execute_min_confidence` is 0.6 (the spec's example uses 0.85), pending
  tuning against a real Jev run.
- **Coverage after a user-defined measure.** If the user already chose the measure in a clarification,
  an uncovered business term ("revenue") is reported as a warning, not a second clarification.

Not implemented yet (spec v1 items):

- §5.16 comparison against an overall aggregate (the `vs_overall_aggregate` flag is asked; the CTE
  compile is not wired).
- §5.7f OR across two columns (detect and clarify).
- §5.15 pivot columns (`FILTER` per category value). Period comparisons with `FILTER` are implemented.
- §5.6 gap-filling trends with `generate_series`.
- §2.3 optional setup pass that asks the oracle about low-confidence columns (`doctor` lists them instead).
- §7 `EXPLAIN` cost ceiling before execution; the SQL is built from a structured builder with quoted
  identifiers rather than an AST library round-trip.
- Config-injected tenancy predicate (tenant columns are hidden; RLS is expected to enforce tenancy).
- R0 table-relevance Nouls for very large schemas (retrieval is BM25 only; schemas ≤ 25 tables use all tables).
- Calibration: temperature scaling is only a hook on `LogprobOracle`; the gating thresholds assume a
  calibrated oracle and should be tuned on a labelled set.
